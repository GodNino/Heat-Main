-- Run once, after 071. What an invite link is for, so the sign-in screen can say it before anyone
-- signs in: "Lucía, you're invited to join Osaka Miami as Bartender", with the email already filled in.
-- Answers only for a link that still works; the link itself is the secret (a random token), and the
-- email shown is the one the invitation was sent to. Readable signed out. Nothing existing changes.
begin;

create or replace function public.invite_preview(invite_token uuid)
returns table(restaurant text, role text, name text, email text)
language sql stable security definer set search_path = '' as $$
  select r.name, null::text, null::text, null::text
  from public.restaurant_invites i join public.restaurants r on r.id = i.restaurant_id
  where i.token = invite_token and i.expires_at > now()
  union all
  select r.name, p.role, null, null
  from public.position_invites p join public.restaurants r on r.id = p.restaurant_id
  where p.token = invite_token and p.expires_at > now()
  union all
  select r.name, e.role, nullif(e.name, ''), e.email
  from public.email_invites e join public.restaurants r on r.id = e.restaurant_id
  where e.token = invite_token and e.expires_at > now() and e.cancelled_at is null and e.accepted_at is null
  limit 1;
$$;
revoke all on function public.invite_preview(uuid) from public;
grant execute on function public.invite_preview(uuid) to anon, authenticated;

commit;
