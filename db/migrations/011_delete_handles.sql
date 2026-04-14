-- Delete handles entirely.
--
-- Handles were internal routing identifiers that duplicated members.id. Content
-- and DMs now reference members via [Display Name|memberId] bracket syntax,
-- resolved at render time using the id as the lookup key.
--
-- Rename authored_handle → authored_label on both mention tables. The column
-- still holds the display text the author typed at mention time (historical
-- integrity); it is simply no longer handle-shaped.
--
-- Order of operations:
--   1. Drop resolve_active_member_id_by_handle function (depends on members.handle)
--   2. Rename authored_handle → authored_label on both mention tables
--   3. Drop members_handle_unique constraint
--   4. Drop members.handle column
--
-- There are no triggers on members, entity_version_mentions, or dm_message_mentions,
-- so the DDL sequence has no pending-trigger-event pitfall. There is no data
-- rewrite — only column renames and a column drop. RENAME preserves all data in
-- place. The migration is safe against empty and populated databases alike.

drop function if exists public.resolve_active_member_id_by_handle(text);

alter table public.entity_version_mentions
  rename column authored_handle to authored_label;

alter table public.dm_message_mentions
  rename column authored_handle to authored_label;

alter table public.members
  drop constraint members_handle_unique;

alter table public.members
  drop column handle;
