-- Run once, after 069. Who explains the dish in its video ("Chef Kenji"), shown on the video.
-- Optional, up to 60 characters. Cleared with the video.
-- Also: adding, replacing or removing a video is not a change to the dish. The card's updated_at
-- is what quizzes and progress are measured against (006), so a new video must not send everyone's
-- quiz back to "needs review". The updated_at trigger (002) now leaves the time alone when only the
-- video changed; anything else, or an explicit new time (quiz edits), still moves it.
begin;

alter table public.menu_items
  add column if not exists video_by text check (video_by is null or char_length(video_by) <= 60);
grant update (video_by) on public.menu_items to authenticated;

-- The 069 trigger also clears the name when the video goes.
create or replace function public.menu_items_video_folder()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.video_path is not null and split_part(new.video_path, '/', 1) <> new.restaurant_id::text then
    if tg_op = 'INSERT' then
      new.video_path := null;
    else
      raise exception 'That video belongs to another restaurant.' using errcode = '42501';
    end if;
  end if;
  if new.video_path is null then
    new.video_seconds := null;
    new.video_by := null;
  end if;
  return new;
end $$;
drop trigger if exists menu_items_video_folder on public.menu_items;

create or replace function public.set_menu_item_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.updated_at is distinct from old.updated_at then
    new.updated_at := clock_timestamp();
  elsif (to_jsonb(new) - 'video_path' - 'video_seconds' - 'video_by' - 'updated_at')
      = (to_jsonb(old) - 'video_path' - 'video_seconds' - 'video_by' - 'updated_at') then
    new.updated_at := old.updated_at;
  else
    new.updated_at := clock_timestamp();
  end if;
  return new;
end $$;
create trigger menu_items_video_folder before insert or update of video_path, video_seconds, video_by, restaurant_id on public.menu_items
for each row execute function public.menu_items_video_folder();

commit;
