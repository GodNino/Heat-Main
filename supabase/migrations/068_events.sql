-- Run once, after 067. Private events and their BEO (docs/mockups/eventos-beo.html).
-- One row per event with everything the team needs: times, guests, room, the menu by course with
-- quantities, the guests' allergies, bar, setup, the run of show and who works it. Money lives in a
-- separate table that only managers read. Any change to guests, menu, allergies or times bumps the
-- version, logs what changed, and asks everyone to confirm again.
-- Managers with Pre-shift access create and edit events; the whole team reads them.
-- New tables and functions only; nothing existing changes.
begin;

create table public.events (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  guests integer not null default 0 check (guests between 0 and 5000),
  room text not null default '' check (char_length(room) <= 120),
  contact text not null default '' check (char_length(contact) <= 200),
  service_style text not null default '' check (char_length(service_style) <= 120),
  status text not null default 'draft' check (status in ('draft', 'confirmed', 'cancelled')),
  -- [{course, time, items: [{name, qty, menu_item_id?}]}]
  menu jsonb not null default '[]' check (jsonb_typeof(menu) = 'array'),
  -- [{who, what, plan}]
  allergies jsonb not null default '[]' check (jsonb_typeof(allergies) = 'array'),
  -- [{time, what}]
  timeline jsonb not null default '[]' check (jsonb_typeof(timeline) = 'array'),
  bar text[] not null default '{}' check (cardinality(bar) <= 40),
  setup text[] not null default '{}' check (cardinality(setup) <= 40),
  staff uuid[] not null default '{}' check (cardinality(staff) <= 200),
  notes text not null default '' check (char_length(notes) <= 2000),
  version integer not null default 1,
  created_by uuid not null default auth.uid() references auth.users(id),
  updated_by uuid default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at and ends_at <= starts_at + interval '24 hours'),
  check (pg_column_size(menu) + pg_column_size(allergies) + pg_column_size(timeline) < 100000)
);
create index events_by_day on public.events (restaurant_id, starts_at);
alter table public.events enable row level security;
create policy "Team reads events" on public.events for select to authenticated
using (public.can_read_restaurant(restaurant_id));
create policy "Managers add events" on public.events for insert to authenticated
with check (public.can_manage(restaurant_id, 'preshift'));
create policy "Managers edit events" on public.events for update to authenticated
using (public.can_manage(restaurant_id, 'preshift')) with check (public.can_manage(restaurant_id, 'preshift'));
create policy "Managers delete events" on public.events for delete to authenticated
using (public.can_manage(restaurant_id, 'preshift'));
revoke all on public.events from public, anon, authenticated;
grant select, insert, update, delete on public.events to authenticated;

-- Money: managers only.
create table public.event_payments (
  event_id uuid primary key references public.events(id) on delete cascade,
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  minimum_spend numeric(10,2) check (minimum_spend between 0 and 9999999),
  deposit numeric(10,2) check (deposit between 0 and 9999999),
  deposit_paid boolean not null default false,
  gratuity text not null default '' check (char_length(gratuity) <= 120),
  notes text not null default '' check (char_length(notes) <= 1000)
);
alter table public.event_payments enable row level security;
create policy "Managers read event payments" on public.event_payments for select to authenticated
using (public.can_manage(restaurant_id, 'preshift'));
create policy "Managers add event payments" on public.event_payments for insert to authenticated
with check (public.can_manage(restaurant_id, 'preshift') and exists (select 1 from public.events e where e.id = event_id and e.restaurant_id = event_payments.restaurant_id));
create policy "Managers edit event payments" on public.event_payments for update to authenticated
using (public.can_manage(restaurant_id, 'preshift')) with check (public.can_manage(restaurant_id, 'preshift') and exists (select 1 from public.events e where e.id = event_id and e.restaurant_id = event_payments.restaurant_id));
revoke all on public.event_payments from public, anon, authenticated;
grant select, insert, update on public.event_payments to authenticated;

-- What changed in each version, and who read which version.
create table public.event_changes (
  event_id uuid not null references public.events(id) on delete cascade,
  version integer not null,
  fields text[] not null,
  guests_before integer,
  guests_after integer,
  changed_by uuid references auth.users(id),
  changed_at timestamptz not null default now(),
  primary key (event_id, version)
);
alter table public.event_changes enable row level security;
create policy "Team reads event changes" on public.event_changes for select to authenticated
using (exists (select 1 from public.events e where e.id = event_id and public.can_read_restaurant(e.restaurant_id)));
revoke all on public.event_changes from public, anon, authenticated;
grant select on public.event_changes to authenticated;

create table public.event_confirmations (
  event_id uuid not null references public.events(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  version integer not null,
  confirmed_at timestamptz not null default now(),
  primary key (event_id, user_id)
);
alter table public.event_confirmations enable row level security;
create policy "Team reads event confirmations" on public.event_confirmations for select to authenticated
using (exists (select 1 from public.events e where e.id = event_id and public.can_read_restaurant(e.restaurant_id)));
revoke all on public.event_confirmations from public, anon, authenticated;
grant select on public.event_confirmations to authenticated;

-- A change that matters to the floor or the kitchen is a new version.
create or replace function public.events_track_version()
returns trigger language plpgsql security definer set search_path = '' as $$
declare changed text[] := '{}';
begin
  new.restaurant_id := old.restaurant_id;
  new.created_by := old.created_by;
  new.updated_at := now();
  new.updated_by := (select auth.uid());
  if new.guests is distinct from old.guests then changed := array_append(changed, 'guests'); end if;
  if new.menu is distinct from old.menu then changed := array_append(changed, 'menu'); end if;
  if new.allergies is distinct from old.allergies then changed := array_append(changed, 'allergies'); end if;
  if new.starts_at is distinct from old.starts_at or new.ends_at is distinct from old.ends_at or new.timeline is distinct from old.timeline then changed := array_append(changed, 'times'); end if;
  if new.room is distinct from old.room or new.setup is distinct from old.setup then changed := array_append(changed, 'setup'); end if;
  if new.bar is distinct from old.bar then changed := array_append(changed, 'bar'); end if;
  if new.staff is distinct from old.staff then changed := array_append(changed, 'staff'); end if;
  if cardinality(changed) > 0 then
    new.version := old.version + 1;
    insert into public.event_changes(event_id, version, fields, guests_before, guests_after, changed_by)
    values (new.id, new.version, changed, old.guests, new.guests, (select auth.uid()));
  else
    new.version := old.version;
  end if;
  return new;
end $$;
create trigger events_track_version before update on public.events
for each row execute function public.events_track_version();
revoke all on function public.events_track_version() from public, anon, authenticated;

-- "I read this version." Anyone on the team.
create or replace function public.confirm_event(event uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare e public.events%rowtype;
begin
  select * into e from public.events where id = event;
  if e.id is null or not public.can_read_restaurant(e.restaurant_id) then
    raise exception 'This event is not available to you.' using errcode = '42501';
  end if;
  insert into public.event_confirmations(event_id, user_id, version) values (event, (select auth.uid()), e.version)
  on conflict (event_id, user_id) do update set version = excluded.version, confirmed_at = now();
  return e.version;
end $$;
revoke all on function public.confirm_event(uuid) from public, anon;
grant execute on function public.confirm_event(uuid) to authenticated;

commit;
