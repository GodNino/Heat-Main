import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

// Request limits (066): demo visitors can't email outside addresses, and the AI routes, report
// emails and notifications have a daily limit per person and can't repeat back to back.
test("demo visitors can't add report recipients, and requests are limited per person", async () => {
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
    // 1 real owner; 2 demo visitor (anonymous), owner of their demo copy
    await db.query("insert into auth.users(id,email) values($1,'owner@test.test')", [uid(1)]);
    await db.query("insert into auth.users(id,is_anonymous) values($1,true)", [uid(2)]);
    const dir = new URL("../supabase/migrations/", import.meta.url);
    for (const file of (await readdir(dir)).filter(name => name.endsWith(".sql")).sort()) await db.exec(await readFile(new URL(file, dir), "utf8"));
    const real = (await db.query<{id: string}>("insert into public.restaurants(owner_id,name) values($1,'Real') returning id", [uid(1)])).rows[0].id;
    const demo = (await db.query<{id: string}>("insert into public.restaurants(owner_id,name,demo_expires_at) values($1,'Demo',now()+interval '7 days') returning id", [uid(2)])).rows[0].id;
    const asUser = (id: number, anonymous = false) => db.exec(`reset role; set role authenticated;
      select set_config('request.jwt.claim.sub','${uid(id)}',false), set_config('request.jwt.claims','${JSON.stringify({sub: uid(id), is_anonymous: anonymous})}',false);`);
    const claim = async (kind: string, ref: string | null = null) => (await db.query<{ok: boolean}>("select public.claim_request($1,$2) ok", [kind, ref])).rows[0].ok;

    // A real owner adds a recipient; a demo visitor can't, even in their own copy.
    await asUser(1);
    await db.query("insert into public.shift_report_recipients(restaurant_id,email) values($1,'gm@real.test')", [real]);
    await asUser(2, true);
    await assert.rejects(db.query("insert into public.shift_report_recipients(restaurant_id,email) values($1,'victim@elsewhere.test')", [demo]), /row-level security/);
    assert.equal(await claim("report_email", "r1"), false, "a demo visitor never sends email");

    // Report email: once, then not again for the same report within 10 minutes.
    await asUser(1);
    assert.equal(await claim("report_email", "r1"), true);
    assert.equal(await claim("report_email", "r1"), false);
    assert.equal(await claim("report_email", "r2"), true, "a different report still goes out");

    // Notifications: the same event can't be repeated within a minute.
    assert.equal(await claim("notify", "time_off_requested:abc"), true);
    assert.equal(await claim("notify", "time_off_requested:abc"), false);
    assert.equal(await claim("notify", "time_off_requested:def"), true);

    // Daily limit: a demo visitor gets 15 assistant answers, then no.
    await asUser(2, true);
    for (let i = 0; i < 15; i++) assert.equal(await claim("assistant"), true);
    assert.equal(await claim("assistant"), false);
    assert.equal(await claim("tutor"), true, "each kind has its own count");

    // The log is private, and old rows don't count.
    await assert.rejects(db.query("select * from public.request_log"), /permission denied/);
    await db.exec("reset role");
    await db.query("update public.request_log set created_at = now() - interval '25 hours' where user_id = $1", [uid(2)]);
    await asUser(2, true);
    assert.equal(await claim("assistant"), true, "a new day starts the count again");
    await assert.rejects(db.query("select public.claim_request('anything')"), /Unknown request/);

    // Signed out: no.
    await db.exec("reset role; set role authenticated; select set_config('request.jwt.claim.sub','',false)");
    await assert.rejects(db.query("select public.claim_request('tutor')"), /sign in/);
  } finally {
    await db.close();
  }
});

// The routes ask through lib/request-limit: until 066 is applied nothing is blocked; after, the answer decides.
test("routes are not blocked before 066 is applied, and follow the database after", async () => {
  const { claimRequest } = await import("../lib/request-limit.ts");
  const answer = (data: unknown, error: {code?: string} | null = null) => ({rpc: async () => ({data, error})});
  assert.equal(await claimRequest(answer(true), "tutor"), true);
  assert.equal(await claimRequest(answer(false), "tutor"), false);
  assert.equal(await claimRequest(answer(null, {code: "PGRST202"}), "tutor"), true, "function not there yet");
  assert.equal(await claimRequest(answer(null, {code: "42501"}), "tutor"), false, "signed out");
});
