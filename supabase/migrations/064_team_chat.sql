-- Run once, after 063. Team chat: HEAT's own chats, so the team stops running the restaurant on WhatsApp.
--   * Chats (chat_messages.channel): foh (front of house), boh (kitchen), servers, sa (S.A.s and runners), bar,
--     managers, and direct messages between two people ('dm:<uuid>:<uuid>', the two ids in order). Who is in each
--     comes from their position in HEAT (member_profiles.role, the kitchen list of 048 and the server / S.A. lists
--     of 060), so nobody adds anyone: join the team and you are in your chats; leave it and you are out. Managers
--     (the owner, or anyone with a manager access) are in every chat; only they are in Managers.
--   * Messages are text, a photo or a voice note (files in the private chat-media bucket, under
--     <restaurant>/<channel>/...). A manager can mark a message as a notice (it notifies everyone in that chat) and
--     pin messages. After 30 days a message is no longer shown, unless it is pinned; /api/chat-cleanup deletes them
--     and their files every day.
--   * chat_reads: when each person last read each chat, for the unread counts.
--   * push_audience learns 'chat_message': direct messages and notices reach phones. The rest of it is 062's.
begin;

-- ── Who is in which chat ──
create or replace function public.chat_is_manager(rid uuid, uid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.restaurants r where r.id = rid and r.owner_id = uid)
      or exists (select 1 from public.restaurant_members m where m.restaurant_id = rid and m.user_id = uid and cardinality(m.access) > 0);
$$;

create or replace function public.chat_is_member(rid uuid, uid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.restaurants r where r.id = rid and r.owner_id = uid)
      or exists (select 1 from public.restaurant_members m where m.restaurant_id = rid and m.user_id = uid);
$$;

-- Server or S.A., the way Side work decides it (060): the restaurant's own lists, else the usual names.
create or replace function public.chat_side_role(rid uuid, job text)
returns text language sql stable security definer set search_path = '' as $$
  with s as (select server_positions, sa_positions from public.schedule_settings where restaurant_id = rid),
       j as (select lower(btrim(coalesce(job, ''))) as v)
  select case
    when (select server_positions from s) is not null and exists (select 1 from unnest((select server_positions from s)) p, j where lower(btrim(p)) = j.v) then 'server'
    when (select server_positions from s) is null and (select v from j) ~ '^server$' then 'server'
    when (select sa_positions from s) is not null and exists (select 1 from unnest((select sa_positions from s)) p, j where lower(btrim(p)) = j.v) then 'sa'
    when (select sa_positions from s) is null and (select v from j) ~ '(assistant|^s\.?\s*a\.?$|runner|busser)' then 'sa'
    else null end;
$$;

create or replace function public.chat_can_read(rid uuid, channel text, uid uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare job text; kitchen boolean;
begin
  if uid is null or rid is null or not public.chat_is_member(rid, uid) then return false; end if;
  if channel ~ '^dm:[0-9a-f-]{36}:[0-9a-f-]{36}$' then
    return (split_part(channel, ':', 2)::uuid = uid or split_part(channel, ':', 3)::uuid = uid)
      and public.chat_is_member(rid, split_part(channel, ':', 2)::uuid) and public.chat_is_member(rid, split_part(channel, ':', 3)::uuid);
  end if;
  if channel not in ('foh', 'boh', 'servers', 'sa', 'bar', 'managers') then return false; end if;
  if public.chat_is_manager(rid, uid) then return true; end if;
  job := public.person_area(rid, uid);
  kitchen := public.is_kitchen_position(rid, job);
  return case channel
    when 'foh' then not kitchen
    when 'boh' then kitchen
    when 'servers' then not kitchen and public.chat_side_role(rid, job) = 'server'
    when 'sa' then not kitchen and public.chat_side_role(rid, job) = 'sa'
    when 'bar' then not kitchen and lower(job) ~ 'bar'
    else false end;
end $$;

-- ── Messages ──
create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  channel text not null check (channel ~ '^(foh|boh|servers|sa|bar|managers|dm:[0-9a-f-]{36}:[0-9a-f-]{36})$'),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind text not null default 'text' check (kind in ('text', 'photo', 'voice')),
  body text not null default '' check (char_length(body) <= 2000),
  media_path text check (media_path is null or char_length(media_path) <= 300),
  duration_s integer check (duration_s is null or duration_s between 0 and 600),
  is_notice boolean not null default false,
  pinned boolean not null default false,
  created_at timestamptz not null default now(),
  check ((kind = 'text' and char_length(btrim(body)) > 0 and media_path is null) or (kind <> 'text' and media_path is not null))
);
create index chat_messages_by_channel on public.chat_messages (restaurant_id, channel, created_at desc);
alter table public.chat_messages enable row level security;

create policy "Chat members read their chats" on public.chat_messages for select to authenticated
using (public.chat_can_read(restaurant_id, channel, (select auth.uid())) and (pinned or created_at > now() - interval '30 days'));
create policy "Chat members write in their chats" on public.chat_messages for insert to authenticated
with check (
  user_id = (select auth.uid()) and not pinned
  and public.chat_can_read(restaurant_id, channel, (select auth.uid()))
  and (not is_notice or public.chat_is_manager(restaurant_id, (select auth.uid())))
  and (channel not like 'dm:%' or split_part(channel, ':', 2) < split_part(channel, ':', 3))
  and (media_path is null or media_path like restaurant_id::text || '/' || channel || '/%')
);
create policy "People delete their own messages, managers any" on public.chat_messages for delete to authenticated
using (user_id = (select auth.uid()) or (channel not like 'dm:%' and public.chat_is_manager(restaurant_id, (select auth.uid()))));

revoke all on public.chat_messages from public, anon, authenticated;
grant select, insert, delete on public.chat_messages to authenticated;

-- Pinning: managers, in a chat they're in (a pinned message stays past 30 days).
create or replace function public.chat_set_pinned(message_id uuid, on_off boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare m public.chat_messages;
begin
  select * into m from public.chat_messages where id = message_id;
  if m.id is null or not public.chat_is_manager(m.restaurant_id, (select auth.uid()))
     or not public.chat_can_read(m.restaurant_id, m.channel, (select auth.uid())) then
    raise exception 'Only a manager can pin messages.' using errcode = '42501';
  end if;
  update public.chat_messages set pinned = on_off where id = message_id;
end $$;

-- ── What each person has read ──
create table public.chat_reads (
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  channel text not null,
  last_read_at timestamptz not null default now(),
  primary key (restaurant_id, user_id, channel)
);
alter table public.chat_reads enable row level security;
create policy "People keep their own read marks" on public.chat_reads for all to authenticated
using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()) and public.chat_can_read(restaurant_id, channel, (select auth.uid())));
revoke all on public.chat_reads from public, anon, authenticated;
grant select, insert, update on public.chat_reads to authenticated;

-- The chats someone is in, with the last message and how many they haven't read (direct messages too).
create or replace function public.chat_overview(rid uuid)
returns table(channel text, last_at timestamptz, last_user uuid, last_kind text, last_body text, unread integer)
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := (select auth.uid());
begin
  if not public.chat_is_member(rid, me) then raise exception 'You do not have access to this restaurant.' using errcode = '42501'; end if;
  return query
  with chats as (
    select k as ch from unnest(array['foh', 'boh', 'servers', 'sa', 'bar', 'managers']) k where public.chat_can_read(rid, k, me)
    union
    select distinct c.channel from public.chat_messages c
    where c.restaurant_id = rid and c.channel like 'dm:%' and c.channel like '%' || me::text || '%'
      and c.created_at > now() - interval '30 days' and public.chat_can_read(rid, c.channel, me)
  )
  select ch.ch,
    l.created_at, l.user_id, l.kind, left(l.body, 140),
    (select count(*)::integer from public.chat_messages u
      where u.restaurant_id = rid and u.channel = ch.ch and u.user_id <> me and u.created_at > now() - interval '30 days'
        and u.created_at > coalesce((select r.last_read_at from public.chat_reads r where r.restaurant_id = rid and r.user_id = me and r.channel = ch.ch), '-infinity'))
  from chats ch
  left join lateral (select * from public.chat_messages m where m.restaurant_id = rid and m.channel = ch.ch
    and (m.pinned or m.created_at > now() - interval '30 days') order by m.created_at desc limit 1) l on true;
end $$;

-- What the cleanup deletes: messages older than 30 days that aren't pinned (their files go with them).
create or replace function public.chat_expired(max_rows integer default 500)
returns table(id uuid, media_path text)
language sql stable security definer set search_path = '' as $$
  select m.id, m.media_path from public.chat_messages m
  where not m.pinned and m.created_at < now() - interval '30 days' order by m.created_at limit greatest(1, least(max_rows, 2000));
$$;

revoke all on function public.chat_is_manager(uuid, uuid), public.chat_is_member(uuid, uuid), public.chat_side_role(uuid, text),
  public.chat_can_read(uuid, text, uuid), public.chat_set_pinned(uuid, boolean), public.chat_overview(uuid), public.chat_expired(integer) from public, anon;
-- The policies call these as the signed-in person, so they need to run them.
grant execute on function public.chat_is_manager(uuid, uuid), public.chat_is_member(uuid, uuid), public.chat_side_role(uuid, text),
  public.chat_can_read(uuid, text, uuid), public.chat_set_pinned(uuid, boolean), public.chat_overview(uuid) to authenticated;
-- chat_expired is for the cleanup job only (service role).
revoke all on function public.chat_expired(integer) from authenticated;

-- New messages arrive live on open chats (Realtime still applies the select policy above).
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.chat_messages;
  end if;
end $$;

-- ── Photos and voice notes: a private bucket, readable by the people in that chat ──
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('chat-media', 'chat-media', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/ogg', 'audio/aac'])
on conflict (id) do nothing;

create or replace function public.chat_media_ok(object_name text, uid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select object_name ~ '^[0-9a-f-]{36}/(foh|boh|servers|sa|bar|managers|dm:[0-9a-f-]{36}:[0-9a-f-]{36})/[^/]+$'
     and public.chat_can_read(split_part(object_name, '/', 1)::uuid, split_part(object_name, '/', 2), uid);
$$;
revoke all on function public.chat_media_ok(text, uuid) from public, anon;
grant execute on function public.chat_media_ok(text, uuid) to authenticated;

create policy "Chat members see chat media" on storage.objects for select to authenticated
using (bucket_id = 'chat-media' and public.chat_media_ok(name, (select auth.uid())));
create policy "Chat members add chat media" on storage.objects for insert to authenticated
with check (bucket_id = 'chat-media' and public.chat_media_ok(name, (select auth.uid())));
-- Files are never deleted from the app: the daily cleanup removes those of expired or deleted messages.

-- Files whose message is gone (deleted, or expired and cleaned), for the cleanup job only.
create or replace function public.chat_orphan_media(max_rows integer default 500)
returns table(name text) language sql stable security definer set search_path = '' as $$
  select o.name from storage.objects o
  where o.bucket_id = 'chat-media' and not exists (select 1 from public.chat_messages m where m.media_path = o.name)
  limit greatest(1, least(max_rows, 2000));
$$;
revoke all on function public.chat_orphan_media(integer) from public, anon, authenticated;

-- ── Phone notifications for direct messages and notices ──
create or replace function public.push_audience(event text, ref uuid, target uuid default null)
returns table(restaurant_name text, user_ids uuid[])
language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid := (select auth.uid());
  rid uuid;
  people uuid[];
  c public.shift_changes;
  msg public.chat_messages;
begin
  if me is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  if event = 'preshift_posted' then
    select n.restaurant_id into rid from public.shift_notes n where n.id = ref;
    if rid is null or not public.can_manage(rid, 'preshift') then raise exception 'Not your board' using errcode = '42501'; end if;
    select coalesce(array_agg(r.user_id), '{}') into people from public.shift_note_recipients r where r.shift_note_id = ref;
    if cardinality(people) = 0 then
      select coalesce(array_agg(m.user_id), '{}') into people from public.restaurant_members m where m.restaurant_id = rid;
    end if;
  elsif event = 'study_assigned' then
    rid := ref;
    if not public.can_manage(rid, 'team') then raise exception 'Not your team' using errcode = '42501'; end if;
    if not exists (select 1 from public.restaurant_members m where m.restaurant_id = rid and m.user_id = target) then
      raise exception 'Team member unavailable' using errcode = '42501';
    end if;
    people := array[target];
  elsif event = 'urgent_report' then
    select s.restaurant_id into rid from public.shift_reports s where s.id = ref and s.urgent and (s.submitted_by = me or s.updated_by = me);
    if rid is null then raise exception 'Not an urgent report of yours' using errcode = '42501'; end if;
    select array_agg(distinct who) into people from (
      select r.owner_id as who from public.restaurants r where r.id = rid
      union all select o.owner_id from public.restaurants r join public.organizations o on o.id = r.organization_id where r.id = rid
      union all select m.user_id from public.restaurant_members m where m.restaurant_id = rid and m.access && array['preshift', 'team']::text[]
    ) found;
  elsif event = 'retake_requested' then
    select m.restaurant_id into rid from public.quiz_permissions p join public.menu_items m on m.id = p.menu_item_id
    where p.menu_item_id = ref and p.user_id = me and p.requested;
    if rid is null then raise exception 'No request to announce' using errcode = '42501'; end if;
    select array_agg(distinct who) into people from (
      select r.owner_id as who from public.restaurants r where r.id = rid
      union all select o.owner_id from public.restaurants r join public.organizations o on o.id = r.organization_id where r.id = rid
    ) found;
  elsif event = 'schedule_published' then
    select p.restaurant_id, p.user_ids into rid, people from public.schedule_publications p where p.id = ref and p.published_by = me;
    if rid is null then raise exception 'Not a schedule you published' using errcode = '42501'; end if;
  elsif event = 'time_off_requested' then
    select t.restaurant_id into rid from public.time_off_requests t where t.id = ref and t.user_id = me and t.status = 'pending';
    if rid is null then raise exception 'No request to announce' using errcode = '42501'; end if;
    -- The owner, Team access, and whoever schedules this person's side.
    select array_agg(distinct who) into people from (
      select r.owner_id as who from public.restaurants r where r.id = rid
      union all select m.user_id from public.restaurant_members m where m.restaurant_id = rid
        and ('team' = any(m.access)
             or (case when public.is_kitchen_position(rid, public.person_area(rid, me)) then 'schedule_boh' else 'schedule_foh' end) = any(m.access))
    ) found;
  elsif event = 'time_off_decided' then
    select t.restaurant_id, array[t.user_id] into rid, people from public.time_off_requests t where t.id = ref and t.decided_by = me;
    if rid is null then raise exception 'Not a request you decided' using errcode = '42501'; end if;
  elsif event in ('shift_released', 'shift_offered', 'shift_change_pending', 'shift_change_declined', 'shift_change_decided') then
    select * into c from public.shift_changes where id = ref;
    if c.id is null then raise exception 'No shift change to announce' using errcode = '42501'; end if;
    rid := c.restaurant_id;
    if event = 'shift_released' and c.requested_by = me and c.status = 'open' then
      -- Everyone in the shift's position who'd stay under overtime with it.
      select coalesce(array_agg(t.user_id), '{}') into people from public.schedule_team(rid) t
      join public.schedule_shifts s on s.id = c.shift_id
      where public.same_area(t.role, s.position) and t.user_id <> c.requested_by
        and not public.would_overtime(rid, t.user_id, s.starts_at, s.ends_at, '{}');
    elsif event = 'shift_offered' and c.requested_by = me and c.status = 'asked' then
      people := array[c.taker_id];
    elsif event = 'shift_change_pending' and c.taker_id = me and c.status = 'pending' then
      -- The owner, Team access, whoever schedules the shift's side, and the person who asked.
      select array_agg(distinct who) into people from (
        select r.owner_id as who from public.restaurants r where r.id = rid
        union all select m.user_id from public.restaurant_members m where m.restaurant_id = rid
          and ('team' = any(m.access)
               or (case when public.is_kitchen_position(rid, (select s.position from public.schedule_shifts s where s.id = c.shift_id)) then 'schedule_boh' else 'schedule_foh' end) = any(m.access))
        union all select c.requested_by
      ) found;
    elsif event = 'shift_change_declined' and c.taker_id = me and c.status = 'declined' then
      people := array[c.requested_by];
    elsif event = 'shift_change_decided' and c.decided_by = me and c.status in ('approved', 'denied') then
      people := array_remove(array[c.requested_by, c.taker_id], null);
    else
      raise exception 'Not a shift change you can announce' using errcode = '42501';
    end if;
  elsif event = 'sections_posted' then
    -- Tonight's sections were sent from Side work > Tonight > Sections: everyone named in them hears it.
    select f.restaurant_id into rid from public.floor_plans f where f.id = ref and f.posted_at is not null;
    if rid is null or not public.can_manage(rid, 'preshift') then raise exception 'Not your sections' using errcode = '42501'; end if;
    select coalesce(array_agg(distinct u), '{}') into people from (
      select (r->>'server_id')::uuid as u from public.floor_plans f, jsonb_array_elements(f.rows) r
      where f.id = ref and coalesce(r->>'server_id', '') ~ '^[0-9a-f-]{36}$'
      union all
      select (h->>'id')::uuid from public.floor_plans f, jsonb_array_elements(f.rows) r, jsonb_array_elements(coalesce(r->'sa', '[]'::jsonb)) h
      where f.id = ref and coalesce(h->>'id', '') ~ '^[0-9a-f-]{36}$'
    ) named
    where u in (select m.user_id from public.restaurant_members m where m.restaurant_id = rid);
  elsif event = 'sidework_posted' then
    -- Tonight's side work was sent from Side work > Tonight: everyone given a job hears it.
    select s.restaurant_id into rid from public.checklist_shifts s where s.id = ref and s.status <> 'draft';
    if rid is null or not public.can_manage(rid, 'preshift') then raise exception 'Not your side work' using errcode = '42501'; end if;
    select coalesce(array_agg(distinct a.user_id), '{}') into people from public.checklist_assignments a
    where a.shift_id = ref and a.user_id is not null
      and a.user_id in (select m.user_id from public.restaurant_members m where m.restaurant_id = rid);
  elsif event = 'chat_message' then
    -- Team chat (064): a direct message reaches the other person; a notice reaches everyone in that chat.
    -- Ordinary chat messages don't notify (they show as unread).
    select * into msg from public.chat_messages where id = ref and user_id = me;
    if msg.id is null then raise exception 'Not a message of yours' using errcode = '42501'; end if;
    rid := msg.restaurant_id;
    if msg.channel like 'dm:%' then
      people := array_remove(array[split_part(msg.channel, ':', 2)::uuid, split_part(msg.channel, ':', 3)::uuid], me);
    elsif msg.is_notice then
      select coalesce(array_agg(distinct t.uid), '{}') into people from (
        select r.owner_id as uid from public.restaurants r where r.id = rid
        union select m.user_id from public.restaurant_members m where m.restaurant_id = rid
      ) t where public.chat_can_read(rid, msg.channel, t.uid);
    else
      raise exception 'Only notices and direct messages notify' using errcode = '22023';
    end if;
  else
    raise exception 'Unknown event' using errcode = '22023';
  end if;
  return query select (select r.name from public.restaurants r where r.id = rid), coalesce(array_remove(people, me), '{}');
end $$;

commit;
