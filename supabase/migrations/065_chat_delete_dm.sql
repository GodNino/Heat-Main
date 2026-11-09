-- Run once, after 064. Direct messages can be deleted by either of the two people in them: any message, or the
-- whole conversation at once (Chat > the direct message > Delete conversation). Group chats are unchanged: your
-- own messages, or any message if you're a manager. Files of deleted messages go in the daily cleanup.
begin;

drop policy "People delete their own messages, managers any" on public.chat_messages;
create policy "People delete their own messages, managers any, either person in a direct message" on public.chat_messages for delete to authenticated
using (
  user_id = (select auth.uid())
  or (channel like 'dm:%' and public.chat_can_read(restaurant_id, channel, (select auth.uid())))
  or (channel not like 'dm:%' and public.chat_is_manager(restaurant_id, (select auth.uid())))
);

commit;
