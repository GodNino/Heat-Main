-- Run once, after 070. Invite someone by email (mockup "Invitaciones por correo"). A manager with
-- Team access writes the person's email, an optional name, their position and the email's language;
-- HEAT keeps one invitation per email per restaurant and emails them a join link
-- (app/api/invite-email). The same link joins them with that position and name. Resending gives a
-- new link and turns off the old one; cancelling turns it off. The Team screen lists each one as
-- pending, joined, expired or cancelled.
-- Also: the request limits (066) learn the invite email, and join_restaurant (042) accepts these
-- links. Both are rewritten whole, with the earlier behaviour kept. Nothing is dropped.
begin;

create table public.email_invites (
  token uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  email text not null check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(email) <= 254),
  name text not null default '' check (char_length(name) <= 60),
  role text not null check (char_length(btrim(role)) between 1 and 40),
  lang text not null default 'en' check (lang in ('en', 'es')),
  created_by uuid not null default auth.uid() references auth.users(id),
  sent_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  accepted_by uuid references auth.users(id) on delete set null,
  accepted_at timestamptz,
  cancelled_at timestamptz
);
create unique index email_invites_one_per_email on public.email_invites (restaurant_id, lower(email));
alter table public.email_invites enable row level security;
create policy "Team managers read email invites" on public.email_invites for select to authenticated
using (public.can_manage(restaurant_id, 'team'));
revoke all on public.email_invites from public, anon, authenticated;
grant select on public.email_invites to authenticated;

-- Creates the invitation, or renews it (new link, 7 more days) when this email was invited before
-- and hasn't joined. Returns the token; the route then sends the email.
create or replace function public.save_email_invite(rid uuid, invite_email text, invite_name text, invite_role text, invite_lang text default 'en')
returns uuid language plpgsql security definer set search_path = '' as $$
declare clean text := lower(btrim(coalesce(invite_email, ''))); made uuid;
begin
  if not public.can_manage(rid, 'team') or public.is_anonymous() then
    raise exception 'You need Team access to invite people.' using errcode = '42501';
  end if;
  if clean !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(clean) > 254 then
    raise exception 'Write a full email address, like name@gmail.com.' using errcode = '23514';
  end if;
  if char_length(btrim(coalesce(invite_role, ''))) not between 1 and 40 then
    raise exception 'Choose a position for this person.' using errcode = '23514';
  end if;
  if exists (select 1 from public.email_invites where restaurant_id = rid and lower(email) = clean and accepted_at is not null) then
    raise exception 'This person already joined with this email.' using errcode = '23505';
  end if;
  insert into public.email_invites(restaurant_id, email, name, role, lang)
  values (rid, clean, left(btrim(coalesce(invite_name, '')), 60), btrim(invite_role), case when invite_lang = 'es' then 'es' else 'en' end)
  on conflict (restaurant_id, lower(email)) do update
    set token = gen_random_uuid(), name = excluded.name, role = excluded.role, lang = excluded.lang,
        created_by = auth.uid(), sent_at = now(), expires_at = now() + interval '7 days', cancelled_at = null
  returning token into made;
  return made;
end $$;

create or replace function public.cancel_email_invite(invite_token uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare rid uuid;
begin
  select restaurant_id into rid from public.email_invites where token = invite_token;
  if rid is null or not public.can_manage(rid, 'team') then
    raise exception 'You need Team access to change invitations.' using errcode = '42501';
  end if;
  update public.email_invites set cancelled_at = now() where token = invite_token and accepted_at is null;
end $$;

-- 042, plus email invitations: the person joins with the position and name the manager wrote.
create or replace function public.join_restaurant(invite_token uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare rid uuid; job text; who text := '';
begin
  if auth.uid() is null then raise exception 'Please sign in first.'; end if;
  select restaurant_id into rid from public.restaurant_invites where token = invite_token and expires_at > now();
  if rid is null then
    select restaurant_id, role into rid, job from public.position_invites where token = invite_token and expires_at > now();
  end if;
  if rid is null then
    update public.email_invites set accepted_by = auth.uid(), accepted_at = coalesce(accepted_at, now())
    where token = invite_token and expires_at > now() and cancelled_at is null
      and (accepted_by is null or accepted_by = auth.uid())
    returning restaurant_id, role, name into rid, job, who;
  end if;
  if rid is null then raise exception 'This invite is invalid or expired. Ask your manager for a new link.'; end if;
  insert into public.restaurant_members(restaurant_id, user_id) values (rid, auth.uid()) on conflict do nothing;
  if job is not null and not exists (select 1 from public.restaurants r where r.id = rid and r.owner_id = auth.uid()) then
    insert into public.member_profiles(restaurant_id, user_id, display_name, role) values (rid, auth.uid(), coalesce(who, ''), job)
    on conflict (restaurant_id, user_id) do nothing;
  end if;
  return rid;
end $$;

-- 066, plus the invite email: never from the demo, 40 a day, the same invitation not again within 2 minutes.
alter table public.request_log drop constraint if exists request_log_kind_check;
alter table public.request_log add constraint request_log_kind_check check (kind in ('tutor', 'assistant', 'report_email', 'notify', 'invite_email'));
create or replace function public.claim_request(kind text, ref text default null)
returns boolean
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  me uuid := (select auth.uid());
  visitor boolean := public.is_anonymous();
  per_day integer;
  used integer;
begin
  if me is null then
    raise exception 'Please sign in again.' using errcode = '42501';
  end if;
  per_day := case kind
    when 'tutor' then case when visitor then 40 else 400 end
    when 'assistant' then case when visitor then 15 else 150 end
    when 'report_email' then case when visitor then 0 else 20 end
    when 'notify' then case when visitor then 30 else 300 end
    when 'invite_email' then case when visitor then 0 else 40 end
  end;
  if per_day is null then
    raise exception 'Unknown request.' using errcode = '22023';
  end if;
  if per_day = 0 then
    return false;
  end if;
  delete from public.request_log l where l.user_id = me and l.created_at < now() - interval '2 days';
  select count(*) into used from public.request_log l
  where l.user_id = me and l.kind = claim_request.kind and l.created_at > now() - interval '24 hours';
  if used >= per_day then
    return false;
  end if;
  if ref is not null and exists (
    select 1 from public.request_log l
    where l.user_id = me and l.kind = claim_request.kind and l.ref = claim_request.ref
      and l.created_at > now() - case kind when 'report_email' then interval '10 minutes' when 'invite_email' then interval '2 minutes' else interval '1 minute' end
  ) then
    return false;
  end if;
  insert into public.request_log(user_id, kind, ref) values (me, kind, left(ref, 200));
  return true;
end $$;

revoke all on function public.save_email_invite(uuid, text, text, text, text), public.cancel_email_invite(uuid) from public, anon;
grant execute on function public.save_email_invite(uuid, text, text, text, text), public.cancel_email_invite(uuid) to authenticated;

commit;
