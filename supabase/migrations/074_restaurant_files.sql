-- Run once, after 073. Restaurant files (mockup "Archivos del restaurante"): PDFs, Word, Excel and
-- photos in folders, one set per restaurant. By default only managers see them (the owner and anyone
-- with manager access, as in the chat, 064). A folder can be shared with Bar, Kitchen, Front of house
-- or the whole team, and what's inside follows it; a single file can be shared on its own instead.
-- Managers upload, rename, move, share and delete; the team only reads what is shared with them.
-- HEAT keeps each file's text (read on upload, app/api/files/text) so search finds words inside it.
-- New tables, functions and a private bucket only; nothing existing changes.
begin;

create table public.file_folders (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 60),
  share text[] not null default '{}' check (share <@ array['bar', 'boh', 'foh', 'all']::text[]),
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now()
);
create unique index file_folders_one_name on public.file_folders (restaurant_id, lower(btrim(name)));

create table public.restaurant_files (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  folder_id uuid not null references public.file_folders(id) on delete restrict,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  path text not null check (split_part(path, '/', 1) = restaurant_id::text and char_length(path) <= 300),
  mime text not null check (char_length(mime) <= 120),
  size_bytes bigint not null check (size_bytes between 1 and 26214400),
  -- null: as the folder. A list: this file on its own (managers always see it).
  share text[] check (share is null or share <@ array['bar', 'boh', 'foh', 'all']::text[]),
  content text not null default '' check (char_length(content) <= 400000),
  pages integer check (pages is null or pages between 0 and 10000),
  search tsvector generated always as (to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(content, ''))) stored,
  uploaded_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index restaurant_files_by_folder on public.restaurant_files (restaurant_id, folder_id, updated_at desc);
create index restaurant_files_search on public.restaurant_files using gin (search);

create table public.file_stars (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  file_id uuid not null references public.restaurant_files(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, file_id)
);

-- Who a share list reaches. Managers always; otherwise the same sides as the chats (064).
create or replace function public.files_reach(rid uuid, share text[])
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare me uuid := (select auth.uid());
begin
  if me is null or not public.chat_is_member(rid, me) then return false; end if;
  if public.chat_is_manager(rid, me) then return true; end if;
  return ('all' = any(coalesce(share, '{}')))
      or ('bar' = any(coalesce(share, '{}')) and public.chat_can_read(rid, 'bar', me))
      or ('boh' = any(coalesce(share, '{}')) and public.chat_can_read(rid, 'boh', me))
      or ('foh' = any(coalesce(share, '{}')) and public.chat_can_read(rid, 'foh', me));
end $$;
create or replace function public.files_manager(rid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.chat_is_manager(rid, (select auth.uid())) and not public.is_anonymous();
$$;
-- A file's own list, else its folder's.
create or replace function public.file_share(f public.restaurant_files)
returns text[] language sql stable security definer set search_path = '' as $$
  select coalesce(f.share, (select d.share from public.file_folders d where d.id = f.folder_id), '{}');
$$;

alter table public.file_folders enable row level security;
-- A folder shows if it's shared with you, or holds a file that is.
create policy "Folders people can reach" on public.file_folders for select to authenticated
using (public.files_reach(restaurant_id, share) or exists (
  select 1 from public.restaurant_files f where f.folder_id = file_folders.id and public.files_reach(f.restaurant_id, f.share)));
create policy "Managers add folders" on public.file_folders for insert to authenticated with check (public.files_manager(restaurant_id));
create policy "Managers change folders" on public.file_folders for update to authenticated using (public.files_manager(restaurant_id)) with check (public.files_manager(restaurant_id));
create policy "Managers delete folders" on public.file_folders for delete to authenticated using (public.files_manager(restaurant_id));
revoke all on public.file_folders from public, anon, authenticated;
grant select, insert, update, delete on public.file_folders to authenticated;

alter table public.restaurant_files enable row level security;
create policy "Files people can reach" on public.restaurant_files for select to authenticated
using (public.files_reach(restaurant_id, public.file_share(restaurant_files)));
create policy "Managers add files" on public.restaurant_files for insert to authenticated
with check (public.files_manager(restaurant_id) and exists (select 1 from public.file_folders d where d.id = folder_id and d.restaurant_id = restaurant_files.restaurant_id));
create policy "Managers change files" on public.restaurant_files for update to authenticated
using (public.files_manager(restaurant_id))
with check (public.files_manager(restaurant_id) and exists (select 1 from public.file_folders d where d.id = folder_id and d.restaurant_id = restaurant_files.restaurant_id));
create policy "Managers delete files" on public.restaurant_files for delete to authenticated using (public.files_manager(restaurant_id));
revoke all on public.restaurant_files from public, anon, authenticated;
grant select, insert, update, delete on public.restaurant_files to authenticated;

-- A file keeps its restaurant and its uploader; any change stamps the time.
create or replace function public.restaurant_files_keep()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.restaurant_id := old.restaurant_id;
  new.uploaded_by := old.uploaded_by;
  new.created_at := old.created_at;
  new.updated_at := now();
  return new;
end $$;
create trigger restaurant_files_keep before update on public.restaurant_files
for each row execute function public.restaurant_files_keep();
revoke all on function public.restaurant_files_keep() from public, anon, authenticated;

alter table public.file_stars enable row level security;
create policy "My stars" on public.file_stars for select to authenticated using (user_id = (select auth.uid()));
create policy "Star what I can see" on public.file_stars for insert to authenticated
with check (user_id = (select auth.uid()) and exists (select 1 from public.restaurant_files f where f.id = file_id));
create policy "Unstar" on public.file_stars for delete to authenticated using (user_id = (select auth.uid()));
revoke all on public.file_stars from public, anon, authenticated;
grant select, insert, delete on public.file_stars to authenticated;

-- Search names and the text inside files, among what you can see. Word starts count ("yuz" finds
-- "yuzu"). Returns a short piece of the text around the match.
create or replace function public.search_files(rid uuid, q text)
returns table(id uuid, name text, folder_id uuid, snippet text, rank real)
language plpgsql stable set search_path = '' as $$
declare words text[]; query tsquery;
begin
  select array_agg(w) into words from (
    select regexp_replace(lower(w), '[^[:alnum:]]', '', 'g') w from regexp_split_to_table(coalesce(q, ''), '\s+') w
  ) x where w <> '' limit 8;
  if words is null then return; end if;
  query := to_tsquery('simple', array_to_string(array(select quote_literal(w) || ':*' from unnest(words) w), ' & '));
  return query
    select f.id, f.name, f.folder_id,
      ts_headline('simple', f.content, query, 'StartSel=[[, StopSel=]], MaxWords=18, MinWords=6, MaxFragments=1') as snippet,
      ts_rank(f.search, query) as rank
    from public.restaurant_files f
    where f.restaurant_id = rid and f.search @@ query
    order by rank desc, f.updated_at desc
    limit 30;
end $$;
revoke all on function public.files_reach(uuid, text[]), public.files_manager(uuid), public.file_share(public.restaurant_files), public.search_files(uuid, text) from public, anon;
grant execute on function public.files_reach(uuid, text[]), public.files_manager(uuid), public.file_share(public.restaurant_files), public.search_files(uuid, text) to authenticated;

-- The files themselves: a private bucket, one folder per restaurant, 25 MB each.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('restaurant-files', 'restaurant-files', false, 26214400, array[
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel',
  'image/jpeg', 'image/png', 'image/webp', 'image/heic'])
on conflict (id) do nothing;

-- Reading a file in storage follows the file's row: if you can see the row, you can open the file.
create or replace function public.files_can_open(object_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.restaurant_files f where f.path = object_name
    and public.files_reach(f.restaurant_id, public.file_share(f)));
$$;
revoke all on function public.files_can_open(text) from public, anon;
grant execute on function public.files_can_open(text) to authenticated;

create policy "Open restaurant files people can reach" on storage.objects for select to authenticated
using (bucket_id = 'restaurant-files' and public.files_can_open(name));
create policy "Managers upload restaurant files" on storage.objects for insert to authenticated
with check (bucket_id = 'restaurant-files' and exists (
  select 1 from public.restaurants r where r.id::text = (storage.foldername(storage.objects.name))[1] and public.files_manager(r.id)));
create policy "Managers remove restaurant files" on storage.objects for delete to authenticated
using (bucket_id = 'restaurant-files' and exists (
  select 1 from public.restaurants r where r.id::text = (storage.foldername(storage.objects.name))[1] and public.files_manager(r.id)));

commit;
