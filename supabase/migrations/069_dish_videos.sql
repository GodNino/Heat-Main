-- Run once, after 068. A short video on each card (a dish, cocktail or wine explained by someone
-- who knows it), for studying. Stored like the photos: a private bucket, one folder per restaurant,
-- read by the team through short-lived signed links, uploaded and removed by managers with Library
-- access. The card keeps the file's path and its length in seconds.
-- When a dish is copied to another location or into a demo kitchen, its video stays behind (like the
-- photo does today): a trigger clears a path that belongs to another restaurant on insert, so the
-- copy functions (035, 037) need no change. Nothing existing is dropped or rewritten.
begin;

alter table public.menu_items
  add column if not exists video_path text check (video_path is null or char_length(video_path) <= 300),
  add column if not exists video_seconds integer check (video_seconds is null or video_seconds between 1 and 600);
grant update (video_path, video_seconds) on public.menu_items to authenticated;

-- A video always lives in its own restaurant's folder.
create or replace function public.menu_items_video_folder()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.video_path is not null and split_part(new.video_path, '/', 1) <> new.restaurant_id::text then
    if tg_op = 'INSERT' then
      new.video_path := null;
      new.video_seconds := null;
    else
      raise exception 'That video belongs to another restaurant.' using errcode = '42501';
    end if;
  end if;
  if new.video_path is null then
    new.video_seconds := null;
  end if;
  return new;
end $$;
create trigger menu_items_video_folder before insert or update of video_path, video_seconds, restaurant_id on public.menu_items
for each row execute function public.menu_items_video_folder();
revoke all on function public.menu_items_video_folder() from public, anon, authenticated;

-- Up to 100 MB per file: a phone video of about a minute at 720p.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('menu-videos', 'menu-videos', false, 104857600, array['video/mp4', 'video/quicktime', 'video/webm'])
on conflict (id) do nothing;

create policy "Team watches restaurant videos" on storage.objects for select to authenticated
using (bucket_id = 'menu-videos' and exists (
  select 1 from public.restaurants r where r.id::text = (storage.foldername(storage.objects.name))[1] and public.can_read_restaurant(r.id)
));
create policy "Library managers upload videos" on storage.objects for insert to authenticated
with check (bucket_id = 'menu-videos' and exists (
  select 1 from public.restaurants r where r.id::text = (storage.foldername(storage.objects.name))[1] and public.can_manage(r.id, 'library')
));
create policy "Library managers remove videos" on storage.objects for delete to authenticated
using (bucket_id = 'menu-videos' and exists (
  select 1 from public.restaurants r where r.id::text = (storage.foldername(storage.objects.name))[1] and public.can_manage(r.id, 'library')
));

commit;
