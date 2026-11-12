-- Run once, after 072. Fix: saving an edited dish failed with "permission denied for table
-- menu_items". The dish editor saves every field, including details (the card's extra fields and the
-- allergen review), but menu_items only grants UPDATE column by column (002, 003, 004, 007, 010, 069,
-- 070) and details was never in that list. Row security still decides whose dishes can be changed.
-- The column itself came from the first setup script; it is added here too, so the migrations alone
-- build the same table.
begin;

alter table public.menu_items add column if not exists details jsonb;
grant update (details) on public.menu_items to authenticated;

commit;
