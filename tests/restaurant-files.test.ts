import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

// Restaurant files (074): managers only by default; a folder or a single file can be shared with Bar,
// Kitchen, Front of house or everyone; search finds words inside the files you can see.
test("restaurant files: managers by default, sharing by folder or file, search inside", async () => {
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
    // 1 owner · 2 floor manager (any access) · 3 bartender · 4 server · 5 line cook · 6 owner of another restaurant
    for (let id = 1; id <= 6; id++) await db.query("insert into auth.users(id,email) values($1,$2)", [uid(id), `p${id}@test.test`]);
    const dir = new URL("../supabase/migrations/", import.meta.url);
    for (const file of (await readdir(dir)).filter(name => name.endsWith(".sql")).sort()) await db.exec(await readFile(new URL(file, dir), "utf8"));
    const rid = (await db.query<{id: string}>("insert into public.restaurants(owner_id,name) values($1,'Osaka') returning id", [uid(1)])).rows[0].id;
    await db.query("insert into public.restaurants(owner_id,name) values($1,'Other')", [uid(6)]);
    await db.query("insert into public.restaurant_members(restaurant_id,user_id,access) values($1,$2,'{preshift}'),($1,$3,'{}'),($1,$4,'{}'),($1,$5,'{}')", [rid, uid(2), uid(3), uid(4), uid(5)]);
    await db.query("insert into public.member_profiles(restaurant_id,user_id,display_name,role) values($1,$2,'Carlos','Bartender'),($1,$3,'Ana','Server'),($1,$4,'Toño','Line Cook')", [rid, uid(3), uid(4), uid(5)]);
    const asUser = (id: number) => db.exec(`reset role; set role authenticated; select set_config('request.jwt.claim.sub','${uid(id)}',false);`);
    const names = async (sql: string, params: unknown[] = []) => (await db.query<{name: string}>(sql, params)).rows.map(r => r.name).sort();

    // A floor manager (any access) makes folders and files; employees and other restaurants can't.
    await asUser(3);
    await assert.rejects(db.query("insert into public.file_folders(restaurant_id,name) values($1,'Mine')", [rid]), /row-level security/);
    await asUser(2);
    const folder = async (name: string) => (await db.query<{id: string}>("insert into public.file_folders(restaurant_id,name) values($1,$2) returning id", [rid, name])).rows[0].id;
    const bar = await folder("Recetas de bar"), vendors = await folder("Proveedores"), events = await folder("Eventos");
    const file = async (folderId: string, name: string, content: string) => (await db.query<{id: string}>(
      "insert into public.restaurant_files(restaurant_id,folder_id,name,path,mime,size_bytes,content) values($1,$2,$3,$4,'application/pdf',1000,$5) returning id",
      [rid, folderId, name, `${rid}/${crypto.randomUUID()}.pdf`, content])).rows[0].id;
    await file(bar, "Especiales de Navidad.pdf", "Yuzu Spritz: 45 ml gin, 20 ml yuzu, prosecco");
    const prices = await file(vendors, "Precios Sysco.pdf", "yuzu juice 1 L 28.50");
    const beo = await file(events, "BEO Altamar.docx", "45 guests, private room");
    await asUser(6);
    await assert.rejects(db.query("insert into public.file_folders(restaurant_id,name) values($1,'Evil')", [rid]), /row-level security/);
    assert.equal((await db.query("select * from public.restaurant_files")).rows.length, 0);

    // By default nobody but managers sees anything.
    await asUser(3);
    assert.deepEqual(await names("select name from public.restaurant_files"), []);
    assert.deepEqual(await names("select name from public.file_folders"), []);

    // Share the bar folder with Bar: the bartender sees it and its files; the server and the cook don't.
    await asUser(1);
    await db.query("update public.file_folders set share = '{bar}' where id = $1", [bar]);
    await asUser(3);
    assert.deepEqual(await names("select name from public.restaurant_files"), ["Especiales de Navidad.pdf"]);
    assert.deepEqual(await names("select name from public.file_folders"), ["Recetas de bar"]);
    await asUser(4);
    assert.deepEqual(await names("select name from public.restaurant_files"), []);
    await asUser(5);
    assert.deepEqual(await names("select name from public.restaurant_files"), []);

    // Share one file on its own (the BEO with front of house): the server sees that file and its folder.
    await asUser(2);
    await db.query("update public.restaurant_files set share = '{foh}' where id = $1", [beo]);
    await asUser(4);
    assert.deepEqual(await names("select name from public.restaurant_files"), ["BEO Altamar.docx"]);
    assert.deepEqual(await names("select name from public.file_folders"), ["Eventos"]);
    await asUser(5);
    assert.deepEqual(await names("select name from public.restaurant_files"), [], "the kitchen isn't front of house");
    // Employees can't change or delete what they can see.
    await asUser(4);
    assert.equal((await db.query("update public.restaurant_files set name = 'x' where id = $1", [beo])).affectedRows, 0);
    assert.equal((await db.query("delete from public.restaurant_files where id = $1", [beo])).affectedRows, 0);

    // Search inside the text, only among what you can see; word starts count.
    await asUser(2);
    assert.deepEqual(await names("select name from public.search_files($1, 'yuz')", [rid]), ["Especiales de Navidad.pdf", "Precios Sysco.pdf"]);
    const snippet = (await db.query<{snippet: string}>("select snippet from public.search_files($1, 'yuzu spritz')", [rid])).rows[0].snippet;
    assert.match(snippet, /\[\[Yuzu\]\]/);
    await asUser(3);
    assert.deepEqual(await names("select name from public.search_files($1, 'yuzu')", [rid]), ["Especiales de Navidad.pdf"], "the bartender doesn't find vendor prices");

    // Stars are personal; storage follows the row.
    await asUser(3);
    const shared = (await db.query<{id: string; path: string}>("select id, path from public.restaurant_files where name like 'Especiales%'")).rows[0];
    await db.query("insert into public.file_stars(file_id) values($1)", [shared.id]);
    await assert.rejects(db.query("insert into public.file_stars(file_id) values($1)", [prices]), /row-level security/, "no star on what you can't see");
    await db.exec("reset role");
    await db.query("insert into storage.objects(bucket_id,name) select 'restaurant-files', path from public.restaurant_files");
    await asUser(3);
    assert.equal((await db.query("select * from storage.objects where bucket_id = 'restaurant-files'")).rows.length, 2, "the bartender opens the bar recipes and the BEO (front of house), not the prices");
    await assert.rejects(db.query("insert into storage.objects(bucket_id,name) values('restaurant-files',$1)", [`${rid}/x.pdf`]), /row-level security/);
    await asUser(6);
    assert.equal((await db.query("select * from storage.objects where bucket_id = 'restaurant-files'")).rows.length, 0);
    // A folder with files can't be deleted until it's empty.
    await asUser(2);
    await assert.rejects(db.query("delete from public.file_folders where id = $1", [bar]), /foreign key/);
  } finally {
    await db.close();
  }
});

// Text from Word and Excel files, read without any library (lib/file-text.ts).
test("file text: Word paragraphs and Excel rows come out as searchable lines", async () => {
  const { docxText, xlsxText } = await import("../lib/file-text.ts");
  const { checkFile, snippetParts } = await import("../lib/file-types.ts");
  const { deflateRawSync } = await import("node:zlib");
  // A tiny zip writer for the test: deflated entries, central directory, end record.
  const zip = (entries: Record<string, string>) => {
    const locals: Buffer[] = [], centrals: Buffer[] = [];
    let offset = 0;
    for (const [name, text] of Object.entries(entries)) {
      const data = deflateRawSync(Buffer.from(text)), nameBuf = Buffer.from(name);
      const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(text.length, 22); local.writeUInt16LE(nameBuf.length, 26);
      const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(text.length, 24); central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
      locals.push(local, nameBuf, data); centrals.push(central, nameBuf);
      offset += 30 + nameBuf.length + data.length;
    }
    const dir = Buffer.concat(centrals), end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, dir, end]);
  };
  const docx = zip({"word/document.xml": `<w:document><w:body><w:p><w:r><w:t>Yuzu Spritz</w:t></w:r></w:p><w:p><w:r><w:t>45 ml gin &amp; 20 ml yuzu</w:t></w:r></w:p></w:body></w:document>`});
  assert.equal(docxText(docx), "Yuzu Spritz\n45 ml gin & 20 ml yuzu");
  const xlsx = zip({
    "xl/sharedStrings.xml": `<sst><si><t>Cocktail</t></si><si><t>Yuzu Margarita</t></si><si><t>Tequila</t></si></sst>`,
    "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" t="s"><v>2</v></c><c r="C2"><v>60</v></c></row></sheetData></worksheet>`,
  });
  assert.equal(xlsxText(xlsx), "Cocktail\nYuzu Margarita · Tequila · 60");
  assert.equal(checkFile({type: "application/pdf", size: 10}), null);
  assert.match(checkFile({type: "text/plain", size: 10})!, /PDF, Word, Excel or photo/);
  assert.match(checkFile({type: "application/pdf", size: 30 * 1024 * 1024})!, /25 MB/);
  assert.deepEqual(snippetParts("the [[Yuzu]] Spritz"), [{hit: false, text: "the "}, {hit: true, text: "Yuzu"}, {hit: false, text: " Spritz"}]);
});
