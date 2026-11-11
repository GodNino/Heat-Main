import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

// Private events (068): managers with Pre-shift access write the BEO, the team reads it, money is
// for managers only, and changes that matter bump the version and ask for a new confirmation.
test("events: managers write, the team reads, payments stay with managers, changes need a new confirmation", async () => {
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
    // 1 owner · 2 manager with Pre-shift · 3 server · 4 cook · 5 owner of another restaurant
    for (let id = 1; id <= 5; id++) await db.query("insert into auth.users(id,email) values($1,$2)", [uid(id), `p${id}@test.test`]);
    const dir = new URL("../supabase/migrations/", import.meta.url);
    for (const file of (await readdir(dir)).filter(name => name.endsWith(".sql")).sort()) await db.exec(await readFile(new URL(file, dir), "utf8"));
    const rid = (await db.query<{id: string}>("insert into public.restaurants(owner_id,name) values($1,'Osaka') returning id", [uid(1)])).rows[0].id;
    const other = (await db.query<{id: string}>("insert into public.restaurants(owner_id,name) values($1,'Other') returning id", [uid(5)])).rows[0].id;
    await db.query("insert into public.restaurant_members(restaurant_id,user_id,access) values($1,$2,'{preshift}'),($1,$3,'{}'),($1,$4,'{}')", [rid, uid(2), uid(3), uid(4)]);
    const asUser = (id: number) => db.exec(`reset role; set role authenticated; select set_config('request.jwt.claim.sub','${uid(id)}',false);`);
    const add = (r: string) => db.query<{id: string}>(`insert into public.events(restaurant_id,name,starts_at,ends_at,guests,menu,allergies,staff)
      values($1,'Company dinner',now()+interval '7 days',now()+interval '7 days 4 hours',40,'[{"course":"First","time":"7:15 PM","items":[{"name":"Tiradito","qty":40}]}]','[{"who":"Table 2 seat 4","what":"Shellfish","plan":"Swap the starter"}]',$2) returning id`, [r, `{${uid(3)},${uid(4)}}`]);

    // Only Pre-shift managers write; employees and other restaurants can't.
    await asUser(3);
    await assert.rejects(add(rid), /row-level security/);
    await asUser(5);
    await assert.rejects(add(rid), /row-level security/);
    await asUser(2);
    const ev = (await add(rid)).rows[0].id;
    await db.query("insert into public.event_payments(event_id,restaurant_id,minimum_spend,deposit) values($1,$2,6500,1500)", [ev, rid]);
    await assert.rejects(db.query("insert into public.event_payments(event_id,restaurant_id,minimum_spend) values($1,$2,1)", [ev, other]), /row-level security/);

    // The team reads the event but not the money; another restaurant reads nothing.
    await asUser(3);
    assert.equal((await db.query("select * from public.events")).rows.length, 1);
    assert.equal((await db.query("select * from public.event_payments")).rows.length, 0);
    assert.equal((await db.query("update public.events set guests = 1")).affectedRows, 0);
    await asUser(5);
    assert.equal((await db.query("select * from public.events")).rows.length, 0);
    await assert.rejects(db.query("select public.confirm_event($1)", [ev]), /not available/);

    // Confirm version 1; a guest-count and menu change makes version 2, logged, and asks again.
    await asUser(4);
    assert.equal((await db.query<{v: number}>("select public.confirm_event($1) v", [ev])).rows[0].v, 1);
    await asUser(2);
    await db.query(`update public.events set guests = 45, menu = '[{"course":"First","time":"7:15 PM","items":[{"name":"Tiradito","qty":45}]}]' where id = $1`, [ev]);
    await db.query("update public.events set notes = 'Bring the cake at 9' where id = $1", [ev]);
    const row = (await db.query<{version: number}>("select version from public.events where id = $1", [ev])).rows[0];
    assert.equal(row.version, 2, "a note alone doesn't make a new version");
    const change = (await db.query<{fields: string[]; guests_before: number; guests_after: number}>("select fields, guests_before, guests_after from public.event_changes where event_id = $1", [ev])).rows[0];
    assert.deepEqual(change, {fields: ["guests", "menu"], guests_before: 40, guests_after: 45});
    await asUser(4);
    assert.equal((await db.query<{version: number}>("select version from public.event_confirmations where event_id = $1 and user_id = $2", [ev, uid(4)])).rows[0].version, 1, "the cook still has to confirm version 2");
    assert.equal((await db.query<{v: number}>("select public.confirm_event($1) v", [ev])).rows[0].v, 2);

    // The restaurant and the author can't be moved by an edit.
    await asUser(2);
    await db.query("update public.events set restaurant_id = $2 where id = $1", [ev, other]).catch(() => null);
    await db.exec("reset role");
    assert.equal((await db.query<{restaurant_id: string}>("select restaurant_id from public.events where id = $1", [ev])).rows[0].restaurant_id, rid);
  } finally {
    await db.close();
  }
});
