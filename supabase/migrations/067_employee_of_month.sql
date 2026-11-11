-- Run once, after 066. Employee of the month (docs/mockups/empleado-del-mes.html).
-- A manager with Team access opens a vote for a month with 2 to 4 nominees in front of house and
-- 2 to 4 in the kitchen. Only employees vote (not managers, not the owner): one vote per area,
-- never for themselves, and nobody sees who voted for whom. While it's open, managers see only how
-- many voted; once it's closed they see the count and the reasons people wrote; when they announce
-- it, the whole team sees the winners. New tables and functions only; nothing existing changes.
begin;

create table public.recognition_rounds (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  month date not null check (extract(day from month) = 1),
  foh uuid[] not null check (cardinality(foh) between 2 and 4),
  boh uuid[] not null check (cardinality(boh) between 2 and 4),
  closes_at timestamptz not null,
  status text not null default 'open' check (status in ('open', 'closed', 'announced')),
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  announced_at timestamptz,
  unique (restaurant_id, month)
);
alter table public.recognition_rounds enable row level security;
create policy "Team reads its votes" on public.recognition_rounds for select to authenticated
using (public.can_read_restaurant(restaurant_id));
revoke all on public.recognition_rounds from public, anon, authenticated;
grant select on public.recognition_rounds to authenticated;

create table public.recognition_votes (
  round_id uuid not null references public.recognition_rounds(id) on delete cascade,
  voter_id uuid not null references auth.users(id) on delete cascade,
  area text not null check (area in ('foh', 'boh')),
  nominee_id uuid not null references auth.users(id) on delete cascade,
  why text not null default '' check (char_length(why) <= 200),
  created_at timestamptz not null default now(),
  primary key (round_id, voter_id, area)
);
alter table public.recognition_votes enable row level security;
-- No policies: votes are only written and read through the functions below, so they stay anonymous.
revoke all on public.recognition_votes from public, anon, authenticated;

-- Opens this month's vote. The nominees must be on the team, and none can be in both lists.
create or replace function public.open_recognition(rid uuid, for_month date, foh_ids uuid[], boh_ids uuid[], closes timestamptz)
returns uuid language plpgsql security definer set search_path = '' as $$
declare made uuid; who uuid;
begin
  if not public.can_manage(rid, 'team') then
    raise exception 'You need Team access to open the vote.' using errcode = '42501';
  end if;
  if cardinality(foh_ids) not between 2 and 4 or cardinality(boh_ids) not between 2 and 4 then
    raise exception 'Choose 2 to 4 nominees in each area.' using errcode = '23514';
  end if;
  if exists (select 1 from unnest(foh_ids) f where f = any(boh_ids)) then
    raise exception 'A person can be nominated in one area only.' using errcode = '23514';
  end if;
  foreach who in array foh_ids || boh_ids loop
    if not public.is_on_team(rid, who) then
      raise exception 'Every nominee must be on the team.' using errcode = '23514';
    end if;
  end loop;
  if closes <= now() then
    raise exception 'The closing date must be in the future.' using errcode = '23514';
  end if;
  insert into public.recognition_rounds(restaurant_id, month, foh, boh, closes_at)
  values (rid, date_trunc('month', for_month)::date, foh_ids, boh_ids, closes)
  returning id into made;
  return made;
exception when unique_violation then
  raise exception 'There is already a vote for that month.' using errcode = '23505';
end $$;

-- One vote per area. Employees only, while it's open, never for yourself.
create or replace function public.cast_recognition_vote(round uuid, vote_area text, nominee uuid, reason text default '')
returns void language plpgsql security definer set search_path = '' as $$
declare r public.recognition_rounds%rowtype; me uuid := (select auth.uid());
begin
  select * into r from public.recognition_rounds where id = round;
  if r.id is null or not public.is_on_team(r.restaurant_id, me) then
    raise exception 'This vote is not available to you.' using errcode = '42501';
  end if;
  if public.chat_is_manager(r.restaurant_id, me) then
    raise exception 'Only employees vote. Managers open, close and announce it.' using errcode = '42501';
  end if;
  if r.status <> 'open' or r.closes_at <= now() then
    raise exception 'Voting is closed.' using errcode = '23514';
  end if;
  if vote_area not in ('foh', 'boh') or not nominee = any(case when vote_area = 'foh' then r.foh else r.boh end) then
    raise exception 'Choose one of the nominees.' using errcode = '23514';
  end if;
  if nominee = me then
    raise exception 'You can''t vote for yourself.' using errcode = '23514';
  end if;
  insert into public.recognition_votes(round_id, voter_id, area, nominee_id, why)
  values (round, me, vote_area, nominee, left(btrim(coalesce(reason, '')), 200));
exception when unique_violation then
  raise exception 'You already voted in this area.' using errcode = '23505';
end $$;

-- Which areas I already voted in, and for whom (only my own votes).
create or replace function public.my_recognition_votes(round uuid)
returns table(area text, nominee_id uuid) language sql stable security definer set search_path = '' as $$
  select v.area, v.nominee_id from public.recognition_votes v where v.round_id = round and v.voter_id = (select auth.uid());
$$;

-- For managers while it's open: how many employees voted, out of how many can.
create or replace function public.recognition_turnout(round uuid)
returns table(voted integer, eligible integer) language plpgsql stable security definer set search_path = '' as $$
declare r public.recognition_rounds%rowtype;
begin
  select * into r from public.recognition_rounds where id = round;
  if r.id is null or not public.can_manage(r.restaurant_id, 'team') then
    raise exception 'You need Team access to see the vote.' using errcode = '42501';
  end if;
  return query
    select (select count(distinct v.voter_id)::integer from public.recognition_votes v where v.round_id = round),
           (select count(*)::integer from public.restaurant_members m
             where m.restaurant_id = r.restaurant_id and cardinality(m.access) = 0
               and m.user_id <> (select owner_id from public.restaurants where id = r.restaurant_id));
end $$;

-- Votes per nominee and the reasons written, with no names of who wrote them. Managers see this
-- once the vote is closed; everyone sees it once it's announced.
create or replace function public.recognition_results(round uuid)
returns table(area text, nominee_id uuid, votes integer, reasons text[]) language plpgsql stable security definer set search_path = '' as $$
declare r public.recognition_rounds%rowtype;
begin
  select * into r from public.recognition_rounds where id = round;
  if r.id is null or not public.can_read_restaurant(r.restaurant_id)
     or (r.status = 'open')
     or (r.status = 'closed' and not public.can_manage(r.restaurant_id, 'team')) then
    raise exception 'Results are not available yet.' using errcode = '42501';
  end if;
  return query
    select n.area, n.nominee_id,
      (select count(*)::integer from public.recognition_votes v where v.round_id = round and v.area = n.area and v.nominee_id = n.nominee_id),
      coalesce((select array_agg(v.why order by v.created_at) from public.recognition_votes v
        where v.round_id = round and v.area = n.area and v.nominee_id = n.nominee_id and v.why <> ''), '{}')
    from (select 'foh'::text area, unnest(r.foh) nominee_id union all select 'boh', unnest(r.boh)) n;
end $$;

-- Close (stop voting) and announce (show everyone). Team access.
create or replace function public.set_recognition_status(round uuid, next_status text)
returns void language plpgsql security definer set search_path = '' as $$
declare r public.recognition_rounds%rowtype;
begin
  select * into r from public.recognition_rounds where id = round;
  if r.id is null or not public.can_manage(r.restaurant_id, 'team') then
    raise exception 'You need Team access to change the vote.' using errcode = '42501';
  end if;
  if not ((r.status = 'open' and next_status = 'closed') or (r.status = 'closed' and next_status = 'announced')) then
    raise exception 'That step is not possible now.' using errcode = '23514';
  end if;
  update public.recognition_rounds
  set status = next_status, announced_at = case when next_status = 'announced' then now() else announced_at end
  where id = round;
end $$;

revoke all on function public.open_recognition(uuid, date, uuid[], uuid[], timestamptz), public.cast_recognition_vote(uuid, text, uuid, text),
  public.my_recognition_votes(uuid), public.recognition_turnout(uuid), public.recognition_results(uuid), public.set_recognition_status(uuid, text) from public, anon;
grant execute on function public.open_recognition(uuid, date, uuid[], uuid[], timestamptz), public.cast_recognition_vote(uuid, text, uuid, text),
  public.my_recognition_votes(uuid), public.recognition_turnout(uuid), public.recognition_results(uuid), public.set_recognition_status(uuid, text) to authenticated;

commit;
