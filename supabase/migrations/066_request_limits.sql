-- Run once, after 065. Limits on the routes that cost money or reach people outside the app,
-- found in the QA audit (QA_AUDIT_REPORT.md):
--   * A demo visitor (an anonymous account, owner of their own demo copy) could add any email
--     address as a shift-report recipient and have HEAT email it again and again.
--   * Nobody had a limit on the AI tutor, the assistant or phone notifications, so a script could
--     run up the Anthropic bill or ping a manager's phone in a loop.
-- One small log, read and written only by claim_request(). The routes ask it before doing the
-- expensive or outward thing; it says yes or no. Nothing existing is dropped or rewritten except
-- the one insert policy on shift_report_recipients, which is recreated with the extra check.
begin;

create table public.request_log (
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('tutor', 'assistant', 'report_email', 'notify')),
  ref text check (char_length(ref) <= 200),
  created_at timestamptz not null default now()
);
create index request_log_by_user on public.request_log (user_id, kind, created_at);
alter table public.request_log enable row level security;
revoke all on public.request_log from public, anon, authenticated;

-- Yes or no, and if yes it is counted. Limits per person per 24 hours; demo visitors get less,
-- and never send email. The same notification or report email can't go out twice in a row.
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
  end;
  if per_day is null then
    raise exception 'Unknown request.' using errcode = '22023';
  end if;
  if per_day = 0 then
    return false;
  end if;
  -- Old rows are only counters; each person tidies their own as they go.
  delete from public.request_log l where l.user_id = me and l.created_at < now() - interval '2 days';
  select count(*) into used from public.request_log l
  where l.user_id = me and l.kind = claim_request.kind and l.created_at > now() - interval '24 hours';
  if used >= per_day then
    return false;
  end if;
  if ref is not null and exists (
    select 1 from public.request_log l
    where l.user_id = me and l.kind = claim_request.kind and l.ref = claim_request.ref
      and l.created_at > now() - case when kind = 'report_email' then interval '10 minutes' else interval '1 minute' end
  ) then
    return false;
  end if;
  insert into public.request_log(user_id, kind, ref) values (me, kind, left(ref, 200));
  return true;
end $$;
revoke all on function public.claim_request(text, text) from public, anon;
grant execute on function public.claim_request(text, text) to authenticated;

-- Demo visitors can't add outside email addresses to a report.
drop policy if exists "Team managers add report recipients" on public.shift_report_recipients;
create policy "Team managers add report recipients" on public.shift_report_recipients for insert to authenticated
with check (public.can_manage(restaurant_id, 'team') and added_by = (select auth.uid()) and not public.is_anonymous());

commit;
