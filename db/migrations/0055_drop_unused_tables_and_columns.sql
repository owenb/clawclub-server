-- 0055_drop_unused_tables_and_columns.sql
--
-- Remove tables and columns with no runtime consumers:
--   - location/media subsystem (5 tables, 1 FK column, 2 enum types)
--   - weak member columns (auth_subject, deleted_at, erasure_*, metadata)
--   - weak club columns (membership_visibility, default_paid_membership, config)
--   - weak subscription columns (provider, provider_reference, current_period_start,
--     cancel_at, billing_interval, metadata)
--   - orphaned live_subscriptions view (uses SELECT *, superseded by function)

begin;

-- ============================================================
-- PHASE 1: Drop location/media subsystem
-- ============================================================

-- Drop join tables first (FK dependants)
drop table if exists app.entity_media_links;
drop table if exists app.entity_locations;
drop table if exists app.member_locations;
drop table if exists app.media_links;

-- Drop edges.to_location_id BEFORE locations (FK dependency).
-- The CHECK constraint referencing this column is auto-dropped.
alter table app.edges drop column if exists to_location_id;

-- Re-add the CHECK constraint without to_location_id
alter table app.edges add constraint edges_target_check check (
  ((to_member_id is not null)::integer
 + (to_entity_id is not null)::integer
 + (to_entity_version_id is not null)::integer) = 1
);

-- Now safe to drop locations
drop table if exists app.locations;

-- Drop orphaned enum types
drop type if exists app.member_location_kind;

-- ============================================================
-- PHASE 2: Drop unused member columns
-- ============================================================

-- Update functions that reference members.deleted_at BEFORE dropping the column
create or replace function app.member_is_active(target_member_id app.short_id)
returns boolean
language sql
stable
security definer
set search_path = app, pg_temp
as $$
  select exists (
    select 1
    from app.members m
    where m.id = target_member_id
      and m.state = 'active'
  )
$$;

create or replace function app.resolve_active_member_id_by_handle(target_handle text)
returns app.short_id
language sql
stable
security definer
set search_path = app, pg_temp
as $$
  select m.id
  from app.members m
  where m.handle = target_handle
    and m.state = 'active'
  limit 1
$$;

alter table app.members drop column if exists auth_subject;
alter table app.members drop column if exists deleted_at;
alter table app.members drop column if exists erasure_requested_at;
alter table app.members drop column if exists erasure_completed_at;
alter table app.members drop column if exists metadata;

-- ============================================================
-- PHASE 3: Drop unused club columns
-- ============================================================

alter table app.clubs drop column if exists membership_visibility;
alter table app.clubs drop column if exists default_paid_membership;
alter table app.clubs drop column if exists config;

-- ============================================================
-- PHASE 4: Drop unused subscription columns + orphaned view
-- ============================================================

-- live_subscriptions view uses SELECT * from subscriptions; must go first
drop view if exists app.live_subscriptions;

alter table app.subscriptions drop column if exists provider;
alter table app.subscriptions drop column if exists provider_reference;
alter table app.subscriptions drop column if exists current_period_start;
alter table app.subscriptions drop column if exists cancel_at;
alter table app.subscriptions drop column if exists billing_interval;
alter table app.subscriptions drop column if exists metadata;

-- Drop orphaned enum type
drop type if exists app.billing_interval_type;

commit;
