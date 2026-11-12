import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { validateVideo, videoPath } from "../lib/menu.ts";

// Dish videos (069): Library managers add a video to a card; the team watches; other restaurants
// can't; copies to other locations don't carry a path that isn't theirs.
test("dish videos: who uploads, who watches, and copies leave the video behind", async () => {
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
    // 1 owner · 2 manager with Library · 3 server · 4 owner of another restaurant
    for (let id = 1; id <= 4; id++) await db.query("insert into auth.users(id,email) values($1,$2)", [uid(id), `p${id}@test.test`]);
    const dir = new URL("../supabase/migrations/", import.meta.url);
    for (const file of (await readdir(dir)).filter(name => name.endsWith(".sql")).sort()) await db.exec(await readFile(new URL(file, dir), "utf8"));
    const rid = (await db.query<{id: string}>("insert into public.restaurants(owner_id,name) values($1,'Osaka') returning id", [uid(1)])).rows[0].id;
    const other = (await db.query<{id: string}>("insert into public.restaurants(owner_id,name) values($1,'Other') returning id", [uid(4)])).rows[0].id;
    await db.query("insert into public.restaurant_members(restaurant_id,user_id,access) values($1,$2,'{library}'),($1,$3,'{}')", [rid, uid(2), uid(3)]);
    const item = (await db.query<{id: string}>("insert into public.menu_items(restaurant_id,name,description,ingredients,category,content_type) values($1,'Tiradito','Fish','{fish}','Raw','food') returning id", [rid])).rows[0].id;
    const asUser = (id: number) => db.exec(`reset role; set role authenticated; select set_config('request.jwt.claim.sub','${uid(id)}',false);`);
    assert.deepEqual((await db.query("select file_size_limit, allowed_mime_types from storage.buckets where id = 'menu-videos'")).rows[0], {file_size_limit: 104857600, allowed_mime_types: ["video/mp4", "video/quicktime", "video/webm"]});

    // The Library manager uploads and sets it on the card.
    const path = videoPath(rid, item, "video/mp4", 1);
    await asUser(2);
    await db.query("insert into storage.objects(bucket_id,name) values('menu-videos',$1)", [path]);
    await db.query("update public.menu_items set video_path = $1, video_seconds = 75 where id = $2", [path, item]);
    // A server can't upload or change it; another restaurant can't upload into this folder.
    await asUser(3);
    await assert.rejects(db.query("insert into storage.objects(bucket_id,name) values('menu-videos',$1)", [`${rid}/${item}/2.mp4`]), /row-level security/);
    assert.equal((await db.query("update public.menu_items set video_path = null where id = $1", [item])).affectedRows, 0);
    // The server watches it; another restaurant doesn't see it.
    assert.equal((await db.query("select * from storage.objects where bucket_id = 'menu-videos'")).rows.length, 1);
    assert.deepEqual((await db.query("select video_path, video_seconds from public.menu_items where id = $1", [item])).rows[0], {video_path: path, video_seconds: 75});
    await asUser(4);
    assert.equal((await db.query("select * from storage.objects where bucket_id = 'menu-videos'")).rows.length, 0);
    await assert.rejects(db.query("insert into storage.objects(bucket_id,name) values('menu-videos',$1)", [`${rid}/x/evil.mp4`]), /row-level security/);

    // A path from another restaurant is refused on edit and dropped on copy.
    await asUser(2);
    await assert.rejects(db.query("update public.menu_items set video_path = $1 where id = $2", [`${other}/x/1.mp4`, item]), /another restaurant/);
    await db.exec("reset role");
    const copy = (await db.query<{video_path: string | null; video_seconds: number | null}>(
      "insert into public.menu_items(restaurant_id,name,description,ingredients,category,content_type,video_path,video_seconds) values($1,'Tiradito','Fish','{fish}','Raw','food',$2,75) returning video_path, video_seconds", [other, path])).rows[0];
    assert.deepEqual(copy, {video_path: null, video_seconds: null});
    // Removing the video clears its length too.
    await db.query("update public.menu_items set video_path = null where id = $1", [item]);
    assert.equal((await db.query<{video_seconds: number | null}>("select video_seconds from public.menu_items where id = $1", [item])).rows[0].video_seconds, null);
  } finally {
    await db.close();
  }
});

test("dish videos: the file check and where it's stored", () => {
  assert.equal(validateVideo({type: "video/mp4", size: 30_000_000}), null);
  assert.equal(validateVideo({type: "video/quicktime", size: 1}, 90), null);
  assert.match(validateVideo({type: "image/jpeg", size: 10})!, /MP4, MOV or WebM/);
  assert.match(validateVideo({type: "video/mp4", size: 0})!, /empty/);
  assert.match(validateVideo({type: "video/mp4", size: 200 * 1024 * 1024})!, /100 MB/);
  assert.match(validateVideo({type: "video/mp4", size: 10}, 900)!, /10 minutes/);
  assert.equal(videoPath("r1", "i1", "video/quicktime", 5), "r1/i1/5.mov");
});
