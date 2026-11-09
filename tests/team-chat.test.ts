import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

// Team chat (064): who is in which chat comes from their position; managers are in all of them;
// direct messages are between two people; messages go after 30 days unless pinned.
test("each person sees the chats of their position, managers see all, and direct messages stay private", async () => {
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
      grant select,insert,delete on storage.objects to authenticated;
    `);
    const uid = (id: number) => `00000000-0000-0000-0000-${String(id).padStart(12, "0")}`;
    // 1 owner; 2 floor manager (preshift); 3 server; 4 S.A.; 5 bartender; 6 line cook; 7 outsider
    for (let id = 1; id <= 7; id++) await db.query("insert into auth.users(id,email) values($1,$2)", [uid(id), `p${id}@osaka.test`]);
    const dir = new URL("../supabase/migrations/", import.meta.url);
    for (const file of (await readdir(dir)).filter(name => name.endsWith(".sql")).sort()) await db.exec(await readFile(new URL(file, dir), "utf8"));
    const asUser = (id: number) => db.exec(`reset role; set role authenticated; select set_config('request.jwt.claim.sub','${uid(id)}',false);`);
    await db.exec("reset role");
    const rid = (await db.query<{id: string}>("insert into public.restaurants(owner_id,name) values($1,'Osaka Miami') returning id", [uid(1)])).rows[0].id;
    await db.query("insert into public.restaurant_members(restaurant_id,user_id,access) values($1,$2,'{preshift}'),($1,$3,'{}'),($1,$4,'{}'),($1,$5,'{}'),($1,$6,'{}')", [rid, uid(2), uid(3), uid(4), uid(5), uid(6)]);
    await db.query("insert into public.member_profiles(restaurant_id,user_id,display_name,role) values($1,$2,'Ana','Server'),($1,$3,'Jack','Server assistant'),($1,$4,'Sofia','Bartender'),($1,$5,'Toño','Line Cook')", [rid, uid(3), uid(4), uid(5), uid(6)]);

    const chats = async (id: number) => { await asUser(id); return (await db.query<{channel: string}>("select channel from public.chat_overview($1) where channel not like 'dm:%' order by channel", [rid])).rows.map(r => r.channel); };
    assert.deepEqual(await chats(2), ["bar", "boh", "foh", "managers", "sa", "servers"], "a manager is in every chat");
    assert.deepEqual(await chats(3), ["foh", "servers"]);
    assert.deepEqual(await chats(4), ["foh", "sa"]);
    assert.deepEqual(await chats(5), ["bar", "foh"]);
    assert.deepEqual(await chats(6), ["boh"]);
    await asUser(7);
    await assert.rejects(db.query("select * from public.chat_overview($1)", [rid]), /access/);

    // A server writes in FOH; the cook can't read it; the server can't write in Managers or post a notice.
    await asUser(3);
    await db.query("insert into public.chat_messages(restaurant_id,channel,body) values($1,'foh','Mesa 21 cumpleaños')", [rid]);
    await assert.rejects(db.query("insert into public.chat_messages(restaurant_id,channel,body) values($1,'managers','hola')", [rid]), /row-level security/);
    await assert.rejects(db.query("insert into public.chat_messages(restaurant_id,channel,body,is_notice) values($1,'foh','aviso',true)", [rid]), /row-level security/);
    await asUser(6);
    assert.equal((await db.query("select * from public.chat_messages where channel = 'foh'")).rows.length, 0);
    await asUser(5);
    assert.equal((await db.query("select * from public.chat_messages where channel = 'foh'")).rows.length, 1, "the bartender is front of house");

    // Direct message between the server and the cook: only they read it.
    const dm = `dm:${uid(3)}:${uid(6)}`;
    await asUser(3);
    await db.query("insert into public.chat_messages(restaurant_id,channel,body) values($1,$2,'¿Sale el ceviche de la 21?')", [rid, dm]);
    await assert.rejects(db.query("insert into public.chat_messages(restaurant_id,channel,body) values($1,$2,'x')", [rid, `dm:${uid(6)}:${uid(3)}`]), /row-level security/, "ids in order only");
    await asUser(6);
    assert.equal((await db.query("select * from public.chat_messages where channel = $1", [dm])).rows.length, 1);
    assert.ok((await db.query<{channel: string}>("select channel from public.chat_overview($1)", [rid])).rows.some(r => r.channel === dm));
    await asUser(2);
    assert.equal((await db.query("select * from public.chat_messages where channel = $1", [dm])).rows.length, 0, "not even a manager reads a direct message");

    // Managers post notices and pin; after 30 days only the pinned one remains.
    const notice = (await db.query<{id: string}>("insert into public.chat_messages(restaurant_id,channel,body,is_notice) values($1,'foh','86: uni',true) returning id", [rid])).rows[0].id;
    await db.query("select public.chat_set_pinned($1, true)", [notice]);
    await asUser(3);
    await assert.rejects(db.query("select public.chat_set_pinned($1, false)", [notice]), /Only a manager/);
    await db.exec("reset role");
    await db.query("update public.chat_messages set created_at = now() - interval '31 days' where channel = 'foh'");
    await asUser(3);
    assert.deepEqual((await db.query<{body: string}>("select body from public.chat_messages where channel = 'foh'")).rows.map(r => r.body), ["86: uni"]);
    await db.exec("reset role");
    assert.deepEqual((await db.query<{id: string}>("select id from public.chat_expired()")).rows.length, 1, "the old unpinned message is up for cleanup");

    // Unread counts: the cook has one unread direct message until they read it.
    await asUser(6);
    const unread = async () => (await db.query<{unread: number}>("select unread from public.chat_overview($1) where channel = $2", [rid, dm])).rows[0].unread;
    assert.equal(await unread(), 1);
    await db.query("insert into public.chat_reads(restaurant_id,channel,last_read_at) values($1,$2,now())", [rid, dm]);
    assert.equal(await unread(), 0);
  } finally {
    await db.close();
  }
});
