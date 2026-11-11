import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

// Employee of the month (067): managers nominate, only employees vote, once per area, anonymously.
test("employee of the month: nominate, vote once per area, results after closing, winners for everyone", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated;
      create schema auth; create schema storage;
      create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}',is_anonymous boolean not null default false,created_at timestamptz not null default now());
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
      create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text);
      create function storage.foldername(text) returns text[] language sql as $$ select string_to_array($1,'/') $$;
      alter table storage.objects enable row level security;
      grant usage on schema public,auth,storage to authenticated,anon;
    `);
    const uid = (id: number) => `00000000-0000-0000-0000-${String(id).padStart(12, "0")}`;
    // 1 owner · 2 manager with Team · 3,4,5 FOH employees · 6,7 kitchen · 8 outsider
    for (let id = 1; id <= 8; id++) await db.query("insert into auth.users(id,email) values($1,$2)", [uid(id), `p${id}@test.test`]);
    const dir = new URL("../supabase/migrations/", import.meta.url);
    for (const file of (await readdir(dir)).filter(name => name.endsWith(".sql")).sort()) await db.exec(await readFile(new URL(file, dir), "utf8"));
    const rid = (await db.query<{id: string}>("insert into public.restaurants(owner_id,name) values($1,'Osaka') returning id", [uid(1)])).rows[0].id;
    await db.query("insert into public.restaurant_members(restaurant_id,user_id,access) values($1,$2,'{team}'),($1,$3,'{}'),($1,$4,'{}'),($1,$5,'{}'),($1,$6,'{}'),($1,$7,'{}')", [rid, uid(2), uid(3), uid(4), uid(5), uid(6), uid(7)]);
    const asUser = (id: number) => db.exec(`reset role; set role authenticated; select set_config('request.jwt.claim.sub','${uid(id)}',false);`);
    const ids = (...n: number[]) => `{${n.map(uid).join(",")}}`;
    const open = (foh: string, boh: string, closes = "now() + interval '7 days'") =>
      db.query<{id: string}>(`select public.open_recognition($1, current_date, $2::uuid[], $3::uuid[], ${closes}) id`, [rid, foh, boh]);
    const vote = (round: string, area: string, who: number, why = "") => db.query("select public.cast_recognition_vote($1,$2,$3,$4)", [round, area, uid(who), why]);

    // Only Team access opens it; the lists are checked.
    await asUser(3);
    await assert.rejects(open(ids(3, 4), ids(6, 7)), /Team access/);
    await asUser(2);
    await assert.rejects(open(ids(3), ids(6, 7)), /2 to 4/);
    await assert.rejects(open(ids(3, 6), ids(6, 7)), /one area only/);
    await assert.rejects(open(ids(3, 8), ids(6, 7)), /on the team/);
    const round = (await open(ids(3, 4, 5), ids(6, 7))).rows[0].id;
    await assert.rejects(open(ids(3, 4), ids(6, 7)), /already a vote/);

    // Employees vote once per area, not for themselves; managers and outsiders don't vote.
    await asUser(4);
    await vote(round, "foh", 3, "Always helps close");
    await vote(round, "boh", 6, "Teaches the new cooks");
    await assert.rejects(vote(round, "foh", 5), /already voted/);
    await asUser(3);
    await assert.rejects(vote(round, "foh", 3), /yourself/);
    await vote(round, "foh", 4);
    await assert.rejects(vote(round, "boh", 3), /nominees/, "a FOH nominee isn't on the kitchen list");
    await asUser(6);
    await vote(round, "foh", 3, "Covered my shift");
    await asUser(2);
    await assert.rejects(vote(round, "foh", 3), /Only employees/);
    await asUser(1);
    await assert.rejects(vote(round, "foh", 3), /Only employees/, "the owner doesn't vote either");
    await asUser(8);
    await assert.rejects(vote(round, "foh", 3), /not available/);

    // My own votes only; nobody reads the votes table.
    await asUser(4);
    assert.deepEqual((await db.query<{area: string}>("select area from public.my_recognition_votes($1) order by area", [round])).rows.map(r => r.area), ["boh", "foh"]);
    await assert.rejects(db.query("select * from public.recognition_votes"), /permission denied/);

    // While open: managers see turnout, nobody sees results.
    await asUser(2);
    assert.deepEqual((await db.query("select * from public.recognition_turnout($1)", [round])).rows[0], {voted: 3, eligible: 5});
    await assert.rejects(db.query("select * from public.recognition_results($1)", [round]), /not available yet/);
    await asUser(3);
    await assert.rejects(db.query("select * from public.recognition_turnout($1)", [round]), /Team access/);

    // Closed: managers see results and reasons, employees still don't, and nobody can vote.
    await asUser(2);
    await assert.rejects(db.query("select public.set_recognition_status($1,'announced')", [round]), /not possible/);
    await db.query("select public.set_recognition_status($1,'closed')", [round]);
    const results = (await db.query<{area: string; nominee_id: string; votes: number; reasons: string[]}>("select * from public.recognition_results($1) order by area, votes desc", [round])).rows;
    assert.deepEqual(results.find(r => r.area === "foh")!, {area: "foh", nominee_id: uid(3), votes: 2, reasons: ["Always helps close", "Covered my shift"]});
    assert.equal(results.length, 5, "every nominee is listed, even with no votes");
    await asUser(5);
    await assert.rejects(vote(round, "foh", 3), /closed/);
    await assert.rejects(db.query("select * from public.recognition_results($1)", [round]), /not available yet/);

    // Announced: the whole team sees the results; another restaurant sees nothing.
    await asUser(2);
    await db.query("select public.set_recognition_status($1,'announced')", [round]);
    await asUser(7);
    assert.equal((await db.query("select * from public.recognition_results($1)", [round])).rows.length, 5);
    assert.equal((await db.query("select * from public.recognition_rounds")).rows.length, 1);
    await asUser(8);
    assert.equal((await db.query("select * from public.recognition_rounds")).rows.length, 0);
    await assert.rejects(db.query("select * from public.recognition_results($1)", [round]), /not available/);
  } finally {
    await db.close();
  }
});
