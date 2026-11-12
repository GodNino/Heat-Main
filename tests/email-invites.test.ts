import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { inviteEmail, inviteSender } from "../lib/invite-email.ts";

// Email invitations (071): Team managers invite by email; the link joins with that position and name;
// resend renews it and turns off the old link; cancel turns it off; the demo never sends.
test("email invites: who sends, renew, cancel, and joining with the position", async () => {
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
    // 1 owner · 2 manager with Team · 3 server · 4 new person · 5 another new person · 6 demo visitor
    for (let id = 1; id <= 6; id++) await db.query("insert into auth.users(id,email,is_anonymous) values($1,$2,$3)", [uid(id), `p${id}@test.test`, id === 6]);
    const dir = new URL("../supabase/migrations/", import.meta.url);
    for (const file of (await readdir(dir)).filter(name => name.endsWith(".sql")).sort()) await db.exec(await readFile(new URL(file, dir), "utf8"));
    const rid = (await db.query<{id: string}>("insert into public.restaurants(owner_id,name) values($1,'Osaka') returning id", [uid(1)])).rows[0].id;
    const demo = (await db.query<{id: string}>("insert into public.restaurants(owner_id,name) values($1,'Demo') returning id", [uid(6)])).rows[0].id;
    await db.query("insert into public.restaurant_members(restaurant_id,user_id,access) values($1,$2,'{team}'),($1,$3,'{}')", [rid, uid(2), uid(3)]);
    const asUser = (id: number) => db.exec(`reset role; set role authenticated; select set_config('request.jwt.claim.sub','${uid(id)}',false), set_config('request.jwt.claims','${JSON.stringify({is_anonymous: id === 6})}',false);`);
    const invite_preview = async (t: string) => (await db.query<{restaurant: string; role: string | null; name: string | null; email: string | null}>("select * from public.invite_preview($1)", [t])).rows[0];
    const invite = (r: string, email: string, role = "Server", name = "Lucía", lang = "es") =>
      db.query<{t: string}>("select public.save_email_invite($1,$2,$3,$4,$5) t", [r, email, name, role, lang]).then(x => x.rows[0].t);

    await asUser(3);
    await assert.rejects(invite(rid, "lucia@gmail.com"), /Team access/);
    await asUser(6);
    await assert.rejects(invite(demo, "victim@gmail.com"), /Team access/, "the demo owner can't invite by email");
    await asUser(2);
    await assert.rejects(invite(rid, "not-an-email"), /full email/);
    await assert.rejects(invite(rid, "lucia@gmail.com", " "), /position/);
    const first = await invite(rid, "Lucia@Gmail.com ");
    assert.equal((await db.query<{email: string}>("select email from public.email_invites")).rows[0].email, "lucia@gmail.com");
    // Resend: same row, new link; the old link no longer works.
    const second = await invite(rid, "lucia@gmail.com", "Bartender");
    assert.notEqual(second, first);
    assert.equal((await db.query("select * from public.email_invites")).rows.length, 1);
    await asUser(3);
    assert.equal((await db.query("select * from public.email_invites")).rows.length, 0, "only Team managers see invitations");

    await asUser(4);
    await assert.rejects(db.query("select public.join_restaurant($1)", [first]), /invalid or expired/);
    assert.equal((await db.query<{r: string}>("select public.join_restaurant($1) r", [second])).rows[0].r, rid);
    await db.exec("reset role");
    assert.deepEqual((await db.query("select display_name, role from public.member_profiles where user_id = $1", [uid(4)])).rows[0], {display_name: "Lucía", role: "Bartender"});
    assert.ok((await db.query<{accepted_by: string}>("select accepted_by from public.email_invites")).rows[0].accepted_by === uid(4));
    // A used link can't bring a second person in; inviting the same email again says they joined.
    await asUser(5);
    await assert.rejects(db.query("select public.join_restaurant($1)", [second]), /invalid or expired/);
    await asUser(2);
    await assert.rejects(invite(rid, "lucia@gmail.com"), /already joined/);

    // The sign-in screen can say what the link is for, signed out (072); not once it's used.
    await db.exec("reset role; set role anon; select set_config('request.jwt.claim.sub','',false)");
    const pre = await invite_preview(first);
    assert.equal(pre, undefined, "a replaced link shows nothing");
    await db.exec("reset role");
    const freshToken = (await db.query<{t: string}>("insert into public.email_invites(restaurant_id,email,name,role,created_by) values($1,'nuevo@gmail.com','Pedro','Host',$2) returning token t", [rid, uid(2)])).rows[0].t;
    await db.exec("set role anon");
    assert.deepEqual(await invite_preview(freshToken), {restaurant: "Osaka", role: "Host", name: "Pedro", email: "nuevo@gmail.com"});
    assert.equal(await invite_preview(second), undefined, "an accepted link shows nothing");
    await asUser(2);

    // Cancel turns a pending link off.
    const pending = await invite(rid, "carlos@gmail.com", "Host", "");
    await db.query("select public.cancel_email_invite($1)", [pending]);
    await asUser(5);
    await assert.rejects(db.query("select public.join_restaurant($1)", [pending]), /invalid or expired/);
    await asUser(3);
    await assert.rejects(db.query("select public.cancel_email_invite($1)", [pending]), /Team access/);

    // Limits: never from the demo, and the same invitation not twice within two minutes.
    await asUser(2);
    assert.equal((await db.query<{ok: boolean}>("select public.claim_request('invite_email', 'x') ok")).rows[0].ok, true);
    assert.equal((await db.query<{ok: boolean}>("select public.claim_request('invite_email', 'x') ok")).rows[0].ok, false);
    await asUser(6);
    assert.equal((await db.query<{ok: boolean}>("select public.claim_request('invite_email', 'y') ok")).rows[0].ok, false);
  } finally {
    await db.close();
  }
});

test("invite email: sender per restaurant, both languages, and typed text is escaped", () => {
  assert.equal(inviteSender("Osaka Miami", "es"), "Osaka Miami vía HEAT <invites@heatplatform.io>");
  assert.equal(inviteSender('Bad "Name" <x@y>', "en"), "Bad Name x@y via HEAT <invites@heatplatform.io>");
  const es = inviteEmail({restaurant: "Osaka Miami", inviter: "Diego", name: "Lucía", role: "Server", lang: "es", link: "https://heatplatform.io/app?invite=abc"});
  assert.equal(es.subject, "Diego te invitó a Osaka Miami en HEAT");
  assert.match(es.html, /Unirme a Osaka Miami/);
  assert.match(es.text, /https:\/\/heatplatform\.io\/app\?invite=abc/);
  const en = inviteEmail({restaurant: "Tom & Jerry's", inviter: "<b>Eve</b>", name: "<script>", role: "Server", lang: "en", link: "https://x/app?invite=1"});
  assert.ok(!/[<>]/.test(en.subject), "no angle brackets in the subject line");
  assert.match(en.subject, /invited you to Tom & Jerry's on HEAT$/);
  assert.ok(!en.html.includes("<script>") && !en.html.includes("<b>Eve"));
  assert.match(en.html, /Tom &amp; Jerry&#39;s/);
});
