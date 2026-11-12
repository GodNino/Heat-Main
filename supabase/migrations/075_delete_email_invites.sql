-- Run once, after 074. Managers with Team access can delete email invitations from the list: one at a
-- time (any state; a pending link stops working) or every finished one at once (joined, cancelled,
-- expired). Deleting a joined invitation only clears the list: the person stays on the team.
-- Two new functions only; nothing existing changes.
begin;

create or replace function public.delete_email_invite(invite_token uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare rid uuid;
begin
  select restaurant_id into rid from public.email_invites where token = invite_token;
  if rid is null or not public.can_manage(rid, 'team') or public.is_anonymous() then
    raise exception 'You need Team access to change invitations.' using errcode = '42501';
  end if;
  delete from public.email_invites where token = invite_token;
end $$;

-- Every invitation that is no longer waiting: joined, cancelled or expired. Returns how many went.
create or replace function public.clear_email_invites(rid uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare gone integer;
begin
  if not public.can_manage(rid, 'team') or public.is_anonymous() then
    raise exception 'You need Team access to change invitations.' using errcode = '42501';
  end if;
  delete from public.email_invites
  where restaurant_id = rid and (accepted_at is not null or cancelled_at is not null or expires_at <= now());
  get diagnostics gone = row_count;
  return gone;
end $$;

revoke all on function public.delete_email_invite(uuid), public.clear_email_invites(uuid) from public, anon;
grant execute on function public.delete_email_invite(uuid), public.clear_email_invites(uuid) to authenticated;

commit;
