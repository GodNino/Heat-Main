import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

// Saving an edited dish sends every field the editor has, details included (073). Before, details had
// no UPDATE grant and the whole save failed with "permission denied for table menu_items".
test("a Library manager saves every field the dish editor sends; an employee still can't", async () => {
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
    for (let id = 1; id <= 3; id++) await db.query("insert into auth.users(id,email) values($1,$2)", [uid(id), `p${id}@test.test`]);
    const dir = new URL("../supabase/migrations/", import.meta.url);
    for (const file of (await readdir(dir)).filter(name => name.endsWith(".sql")).sort()) await db.exec(await readFile(new URL(file, dir), "utf8"));
    const rid = (await db.query<{id: string}>("insert into public.restaurants(owner_id,name) values($1,'Osaka') returning id", [uid(1)])).rows[0].id;
    await db.query("insert into public.restaurant_members(restaurant_id,user_id,access) values($1,$2,'{library}'),($1,$3,'{}')", [rid, uid(2), uid(3)]);
    const item = (await db.query<{id: string; updated_at: string}>("insert into public.menu_items(restaurant_id,name,description,ingredients,category,content_type) values($1,'OSK Ceviche','Tuna','{tuna}','Ceviches','food') returning id, updated_at::text", [rid])).rows[0];
    const asUser = (id: number) => db.exec(`reset role; set role authenticated; select set_config('request.jwt.claim.sub','${uid(id)}',false);`);
    // Exactly the columns the editor's save sends (app/workspace.tsx, AddDish submit).
    const save = () => db.query(`update public.menu_items set price = 32, price_label = null, fire_minutes = 10, table_setting = 'Sharing spoon', observations = '',
      name = 'OSK Ceviche', description = 'Tuna, crispy quinoa', ingredients = '{tuna,quinoa}', allergens = '{fish,soy}', photo_path = null,
      category = 'Ceviches', content_type = 'food', details = '{"reviewed_by":"Diego"}' where id = $1 and updated_at = $2`, [item.id, item.updated_at]);

    await asUser(2);
    assert.equal((await save()).affectedRows, 1);
    assert.equal((await db.query<{d: {reviewed_by: string}}>("select details d from public.menu_items where id = $1", [item.id])).rows[0].d.reviewed_by, "Diego");
    await asUser(3);
    assert.equal((await db.query("update public.menu_items set details = '{}' where id = $1", [item.id])).affectedRows, 0, "row security still keeps employees out");
  } finally {
    await db.close();
  }
});
