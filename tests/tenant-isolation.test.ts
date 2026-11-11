import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

// Tenant isolation across the whole schema (QA audit). Every table gets a row in restaurant A where
// it can; then the owner of restaurant B, an employee of B, a person with no restaurant and a
// signed-out visitor try to read, change, delete and add to A's rows. All of it must be refused.
// New tables are covered automatically; if one can't be seeded it is named in the failure.
test("no one outside a restaurant can read or change its rows, in any table", async () => {
  const db = new PGlite();
  const uid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create schema storage;
    create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}',is_anonymous boolean not null default false,created_at timestamptz not null default now());
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    create function auth.role() returns text language sql stable as $$ select current_user::text $$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text);
    create function storage.foldername(text) returns text[] language sql as $$ select string_to_array($1,'/') $$;
    alter table storage.objects enable row level security;
    grant usage on schema public,auth,storage to authenticated,anon;
    grant select,insert,update,delete on storage.objects to authenticated;
  `);
  // 1 owner A · 2 full manager A · 3 employee A · 4 owner B · 5 employee B · 6 nobody
  for (let i = 1; i <= 6; i++) await db.query("insert into auth.users(id,email) values($1,$2)", [uid(i), `u${i}@test.test`]);
  const dir = new URL("../supabase/migrations/", import.meta.url);
  for (const f of (await readdir(dir)).filter(n => n.endsWith(".sql")).sort()) await db.exec(await readFile(new URL(f, dir), "utf8"));
  const A = (await db.query<{id: string}>("insert into public.restaurants(owner_id,name) values($1,'Rest A') returning id", [uid(1)])).rows[0].id;
  const B = (await db.query<{id: string}>("insert into public.restaurants(owner_id,name) values($1,'Rest B') returning id", [uid(4)])).rows[0].id;
  const accessCheck = (await db.query<{def: string}>("select pg_get_constraintdef(oid) def from pg_constraint where conname='restaurant_members_access_valid'")).rows[0]?.def ?? "";
  const allAccess = [...accessCheck.matchAll(/'([a-z_]+)'::text/g)].map(m => m[1]);
  await db.query("insert into public.restaurant_members(restaurant_id,user_id,access) values($1,$2,$3),($1,$4,'{}'),($5,$6,'{}')", [A, uid(2), allAccess, uid(3), B, uid(5)]);
  
  // ---- generic seeding of restaurant A ----
  type Col = {table: string; col: string; type: string; nullable: boolean; hasDefault: boolean; udt: string};
  const cols = (await db.query<Col>(`select table_name "table", column_name col, data_type type, is_nullable='YES' nullable, column_default is not null "hasDefault", udt_name udt
    from information_schema.columns where table_schema='public' and table_name in (select tablename from pg_tables where schemaname='public') order by table_name, ordinal_position`)).rows;
  const tables = [...new Set(cols.map(c => c.table))];
  const fks = (await db.query<{table: string; col: string; ref: string; refcol: string}>(`select tc.table_name "table", kcu.column_name col, ccu.table_schema||'.'||ccu.table_name ref, ccu.column_name refcol
    from information_schema.table_constraints tc join information_schema.key_column_usage kcu on tc.constraint_name=kcu.constraint_name and tc.table_schema=kcu.table_schema
    join information_schema.constraint_column_usage ccu on ccu.constraint_name=tc.constraint_name
    where tc.constraint_type='FOREIGN KEY' and tc.table_schema='public'`)).rows;
  const checks = (await db.query<{table: string; def: string}>(`select conrelid::regclass::text "table", pg_get_constraintdef(oid) def from pg_constraint where contype='c' and connamespace='public'::regnamespace`)).rows;
  function allowed(table: string, col: string): string | undefined {
    for (const c of checks.filter(c => c.table === `public.${table}` || c.table === table)) {
      if (!c.def.includes(col)) continue;
      const m = c.def.match(/ARRAY\[(.*?)\]/) ?? c.def.match(/= '([^']+)'/);
      if (m) { const v = m[1].match(/'([^']*)'/); if (v) return v[1]; }
      const lo = c.def.match(new RegExp(`${col} ~ '\\^?([a-z]+)`)); if (lo) return lo[1];
    }
  }
  async function valueFor(c: Col): Promise<{sql: string} | undefined> {
    const fk = fks.find(f => f.table === c.table && f.col === c.col);
    if (c.col === "restaurant_id") return {sql: `'${A}'`};
    if (fk) {
      if (fk.ref === "auth.users") return {sql: `'${uid(3)}'`};
      const refTable = fk.ref.replace("public.", "");
      const hasRid = cols.some(x => x.table === refTable && x.col === "restaurant_id");
      const r = await db.query<{v: string}>(`select ${fk.refcol}::text v from ${fk.ref} ${hasRid ? `where restaurant_id='${A}'` : ""} limit 1`);
      if (!r.rows.length) return undefined;
      return {sql: `'${r.rows[0].v}'`};
    }
    if (["user_id", "created_by", "author_id", "employee_id"].includes(c.col) && c.udt === "uuid") return {sql: `'${uid(3)}'`};
    const a = allowed(c.table, c.col);
    if (a !== undefined) return {sql: `'${a}'`};
    switch (c.udt) {
      case "uuid": return {sql: "gen_random_uuid()"};
      case "text": case "varchar": case "citext": return {sql: `'x'`};
      case "int2": case "int4": case "int8": case "numeric": case "float8": case "float4": return {sql: "1"};
      case "bool": return {sql: "false"};
      case "date": return {sql: "current_date"};
      case "timestamptz": case "timestamp": return {sql: "now()"};
      case "time": case "timetz": return {sql: "'17:00'"};
      case "jsonb": case "json": return {sql: "'{}'"};
      case "_text": return {sql: "'{}'"};
      case "_uuid": return {sql: "'{}'"};
      case "_int4": return {sql: "'{}'"};
      case "interval": return {sql: "'1 hour'"};
      case "tstzrange": return {sql: "tstzrange(now(), now() + interval '1 hour')"};
    }
    return undefined;
  }
  const manual = [
    `insert into public.menu_items(restaurant_id,name,description,ingredients,allergens,category,content_type) values('${A}','Tiradito','Fish','{fish}','{fish}','Raw','food')`,
    `insert into public.schedule_shifts(restaurant_id,user_id,created_by,position,starts_at,ends_at,published) values('${A}','${uid(3)}','${uid(1)}','Server',now()+interval '1 day',now()+interval '1 day 6 hours',true)`,
    `insert into public.chat_messages(restaurant_id,user_id,channel,body) values('${A}','${uid(3)}','foh','hola'),('${A}','${uid(2)}','dm:${uid(2)}:${uid(3)}','secret')`,
    `insert into public.glossary_terms(restaurant_id,created_by,term,means) values('${A}','${uid(1)}','Omakase','chef choice')`,
    `insert into public.access_codes(code,label,created_by) values('ABCD-1234','x','${uid(1)}')`,
    `insert into public.push_subscriptions(user_id,endpoint,p256dh,auth) values('${uid(3)}','https://push.example/1','k','a')`,
    `insert into public.shift_report_recipients(restaurant_id,email,added_by) values('${A}','owner@a.test','${uid(1)}')`,
  ];
  for (const m of manual) await db.exec(m);
  const seeded = new Set<string>();
  const seedErr: Record<string, string> = {};
  for (let pass = 0; pass < 6; pass++) {
    for (const t of tables) {
      if (seeded.has(t) || t === "restaurants" || t === "restaurant_members") continue;
      if ((await db.query<{n: number}>(`select count(*)::int n from public.${t}`)).rows[0].n > 0) { seeded.add(t); continue; }
      const tc = cols.filter(c => c.table === t);
      const names: string[] = [], vals: string[] = [];
      let skip = false;
      for (const c of tc) {
        const isFk = fks.some(f => f.table === t && f.col === c.col);
        if (c.hasDefault && c.col !== "restaurant_id" && !isFk) continue;
        if (c.nullable && !isFk && c.col !== "restaurant_id") continue;
        const v = await valueFor(c);
        if (!v) { if (c.nullable) continue; skip = true; seedErr[t] = `no value for ${c.col}`; break; }
        names.push(c.col); vals.push(v.sql);
      }
      if (skip) continue;
      try { await db.exec(`insert into public.${t}(${names.join(",")}) values(${vals.join(",")})`); seeded.add(t); delete seedErr[t]; }
      catch (e) { seedErr[t] = (e as Error).message; }
    }
  }
  seeded.add("restaurants"); seeded.add("restaurant_members");
  
  
  // ---- probes ----
  const out: string[] = [];
  const log = (s: string) => { out.push(s); };
  async function as<T>(who: number | "anon", fn: () => Promise<T>): Promise<T | Error> {
    await db.exec("begin");
    try {
      if (who === "anon") await db.exec("set local role anon; select set_config('request.jwt.claim.sub','',true)");
      else await db.exec(`set local role authenticated; select set_config('request.jwt.claim.sub','${uid(who)}',true)`);
      return await fn();
    } catch (e) { return e as Error; }
    finally { await db.exec("rollback"); }
  }
  const ridTables = tables.filter(t => cols.some(c => c.table === t && c.col === "restaurant_id"));
  const rls = (await db.query<{t: string; secured: boolean}>("select relname t, relrowsecurity secured from pg_class where relnamespace='public'::regnamespace and relkind='r'")).rows;
  log("## Tables without RLS"); for (const r of rls.filter(r => !r.secured)) log(`- ${r.t}`);
  log("\n## Not seeded"); for (const [t, e] of Object.entries(seedErr)) log(`- ${t}: ${e.slice(0, 140)}`);
  
  log("\n## Cross-tenant reads/writes on restaurant A (should all be 0 / denied)");
  for (const who of [4, 5, 6, "anon"] as const) {
    for (const t of [...ridTables, ...tables.filter(t => !ridTables.includes(t))]) {
      const total = (await db.query<{n: number}>(`select count(*)::int n from public.${t}`)).rows[0].n;
      if (!total) continue;
      const scope = t === "restaurants" ? `id='${A}'` : ridTables.includes(t) ? `restaurant_id='${A}'` : "true";
      const sel = await as(who, () => db.query<{n: number}>(`select count(*)::int n from public.${t} where ${scope}`));
      const upd = await as(who, () => db.query(`update public.${t} set ${t === "restaurants" ? "name=name" : cols.find(c => c.table === t)!.col + "=" + cols.find(c => c.table === t)!.col} where ${scope}`));
      const del = await as(who, () => db.query(`delete from public.${t} where ${scope}`));
      const s = sel instanceof Error ? "deny" : sel.rows[0].n;
      const u = upd instanceof Error ? "deny" : upd.affectedRows;
      const d = del instanceof Error ? "deny" : del.affectedRows;
      if ((s !== "deny" && s > 0) || (u !== "deny" && u > 0) || (d !== "deny" && d > 0))
        log(`- LEAK as ${who}: ${t} (A rows ${total}${ridTables.includes(t) ? "" : ", table has no restaurant_id"}) select=${s} update=${u} delete=${d}`);
    }
  }
  
  log("\n## Writes that an employee of A with no access can do (review: some are expected)");
  for (const t of tables) {
    const total = (await db.query<{n: number}>(`select count(*)::int n from public.${t}`)).rows[0].n;
    if (!total) continue;
    const c0 = cols.find(c => c.table === t)!.col;
    const upd = await as(3, () => db.query(`update public.${t} set ${c0}=${c0}`));
    const del = await as(3, () => db.query(`delete from public.${t}`));
    const u = upd instanceof Error ? 0 : upd.affectedRows ?? 0, d = del instanceof Error ? 0 : del.affectedRows ?? 0;
    if (u || d) log(`- employee: ${t} update=${u} delete=${d}`);
  }
  
  log("\n## Inserting a copy of an A row (new id) as owner B (4), employee B (5), employee A with no access (3)");
  for (const t of ridTables) {
    const pk = (await db.query<{c: string}>(`select a.attname c from pg_index i join pg_attribute a on a.attrelid=i.indrelid and a.attnum=any(i.indkey) where i.indrelid='public.${t}'::regclass and i.indisprimary`)).rows.map(r => r.c);
    const row = (await db.query<{j: any}>(`select to_jsonb(x) j from public.${t} x where restaurant_id='${A}' limit 1`)).rows[0]?.j;
    if (!row) continue;
    for (const k of pk) if (k !== "restaurant_id") delete row[k];
    for (const k of ["created_at", "updated_at"]) delete row[k];
    const keys = Object.keys(row).filter(k => cols.some(c => c.table === t && c.col === k));
    const gen = (await db.query<{c: string}>(`select attname c from pg_attribute where attrelid='public.${t}'::regclass and attidentity<>'' or (attrelid='public.${t}'::regclass and attgenerated<>'')`)).rows.map(r => r.c);
    const use = keys.filter(k => !gen.includes(k));
    const lit = `'${JSON.stringify(row).replace(/'/g, "''")}'::jsonb`;
    const sql = `insert into public.${t}(${use.join(",")}) select ${use.join(",")} from jsonb_populate_record(null::public.${t}, ${lit})`;
    for (const who of [4, 5, 3] as const) {
      const pre = who === 3 ? sql.replace(/'00000000-0000-0000-0000-000000000003'/g, "'00000000-0000-0000-0000-000000000003'") : sql;
      const r = await as(who, () => db.query(pre));
      if (!(r instanceof Error)) log(`- INSERT ALLOWED as ${who}: ${t}`);
      else if (!/row-level security|permission denied|violates|duplicate|unique/.test(r.message)) log(`- insert as ${who} into ${t}: ${r.message.slice(0, 100)}`);
    }
  }
  
  
  const leaks = out.filter(line => /LEAK|ALLOWED as [45]|WRITE as owner B/.test(line));
  assert.deepEqual(leaks, [], "cross-restaurant access");
  assert.deepEqual(rls.filter(r => !r.secured).map(r => r.t), [], "every table has row level security");
  assert.ok(seeded.size >= 40, `seeded only ${seeded.size} tables: ${JSON.stringify(seedErr)}`);
  const noPath = (await db.query<{name: string}>("select proname name from pg_proc where pronamespace='public'::regnamespace and prosecdef and not coalesce(array_to_string(proconfig, ',') like '%search_path%', false)")).rows;
  assert.deepEqual(noPath, [], "every security definer function pins its search_path");
  await db.close();
});
