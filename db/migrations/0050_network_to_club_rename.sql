begin;

-- ============================================================================
-- PHASE 1: DROP DEPENDENT OBJECTS
-- Policies must be dropped BEFORE views, because policies depend on views.
-- ============================================================================

-- Drop policies on app.networks
drop policy if exists networks_select_scope on app.networks;
drop policy if exists networks_insert_superadmin on app.networks;
drop policy if exists networks_update_superadmin on app.networks;
drop policy if exists networks_select_security_definer_owner on app.networks;
drop policy if exists networks_select_public_cold_application_owner on app.networks;

-- Drop policies on app.network_memberships
drop policy if exists network_memberships_select_actor_scope on app.network_memberships;
drop policy if exists network_memberships_insert_owner_scope on app.network_memberships;
drop policy if exists network_memberships_update_state_sync on app.network_memberships;
drop policy if exists network_memberships_delete_none on app.network_memberships;
drop policy if exists network_memberships_select_security_definer_owner on app.network_memberships;

-- Drop policies on app.network_membership_state_versions
drop policy if exists network_membership_state_versions_select_actor_scope on app.network_membership_state_versions;
drop policy if exists network_membership_state_versions_insert_owner_scope on app.network_membership_state_versions;
drop policy if exists network_membership_state_versions_select_security_definer_owner on app.network_membership_state_versions;

-- Drop policies on app.network_owner_versions
drop policy if exists network_owner_versions_select_actor_scope on app.network_owner_versions;
drop policy if exists network_owner_versions_insert_superadmin on app.network_owner_versions;

-- Drop policies on app.network_quota_policies
drop policy if exists member_select_quota_policies on app.network_quota_policies;
drop policy if exists superadmin_select_quota_policies on app.network_quota_policies;

-- Drop policies on app.edges
drop policy if exists edges_select_accessible on app.edges;
drop policy if exists edges_insert_author_scope on app.edges;

-- Drop policies on app.entities
drop policy if exists entities_select_accessible on app.entities;
drop policy if exists entities_insert_author_scope on app.entities;

-- Drop policies on app.entity_versions
drop policy if exists entity_versions_select_accessible on app.entity_versions;
drop policy if exists entity_versions_insert_author_scope on app.entity_versions;
drop policy if exists entity_versions_select_security_definer_owner on app.entity_versions;

-- Drop policies on app.transcript_threads
drop policy if exists transcript_threads_select_participant_scope on app.transcript_threads;
drop policy if exists transcript_threads_insert_participant_scope on app.transcript_threads;

-- Drop policies on app.event_rsvps
drop policy if exists event_rsvps_select_accessible on app.event_rsvps;
drop policy if exists event_rsvps_insert_owned_membership on app.event_rsvps;

-- Drop policies on app.deliveries
do $$ begin
  if exists (select 1 from pg_tables where schemaname = 'app' and tablename = 'deliveries') then
    drop policy if exists deliveries_select_recipient_scope on app.deliveries;
    drop policy if exists deliveries_insert_shared_surface on app.deliveries;
  end if;
end $$;

-- Drop policies on app.delivery_endpoints
do $$ begin
  if exists (select 1 from pg_tables where schemaname = 'app' and tablename = 'delivery_endpoints') then
    drop policy if exists delivery_endpoints_select_actor_scope on app.delivery_endpoints;
    drop policy if exists delivery_endpoints_update_actor_scope on app.delivery_endpoints;
  end if;
end $$;

-- Drop policies on app.delivery_attempts
do $$ begin
  if exists (select 1 from pg_tables where schemaname = 'app' and tablename = 'delivery_attempts') then
    drop policy if exists delivery_attempts_select_actor_scope on app.delivery_attempts;
    drop policy if exists delivery_attempts_insert_actor_scope on app.delivery_attempts;
    drop policy if exists delivery_attempts_update_actor_scope on app.delivery_attempts;
  end if;
end $$;

-- Drop policies on app.member_updates
drop policy if exists member_updates_insert_actor_scope on app.member_updates;

-- Drop policies on app.member_update_receipts
drop policy if exists member_update_receipts_insert_recipient_scope on app.member_update_receipts;

-- Drop policies on app.embeddings
drop policy if exists embeddings_select_entity_scope on app.embeddings;

-- Drop policies on app.applications
drop policy if exists applications_select_actor_scope on app.applications;
drop policy if exists applications_insert_owner_scope on app.applications;
drop policy if exists applications_update_owner_scope on app.applications;

-- Drop policies on app.application_versions
drop policy if exists application_versions_select_actor_scope on app.application_versions;
drop policy if exists application_versions_insert_owner_scope on app.application_versions;

-- Drop policies on app.sponsorships
drop policy if exists sponsorships_insert_member on app.sponsorships;
drop policy if exists sponsorships_select_own on app.sponsorships;
drop policy if exists sponsorships_select_owner on app.sponsorships;

-- Drop policies on app.transcript_messages (depend on actor_can_access_thread)
drop policy if exists transcript_messages_select_thread_scope on app.transcript_messages;
drop policy if exists transcript_messages_insert_thread_scope on app.transcript_messages;

-- Drop policies on app.members (depend on actor_can_access_member)
drop policy if exists members_select_actor_scope on app.members;

-- Drop policies on app.member_profile_versions (depend on actor_can_access_member)
drop policy if exists member_profile_versions_select_actor_scope on app.member_profile_versions;

-- Drop policies on app.embeddings (depend on actor_can_access_member)
drop policy if exists embeddings_select_profile_scope on app.embeddings;

-- Drop policies on app.delivery_acknowledgements (if table exists)
do $$ begin
  if exists (select 1 from pg_tables where schemaname = 'app' and tablename = 'delivery_acknowledgements') then
    drop policy if exists delivery_acknowledgements_select_recipient_scope on app.delivery_acknowledgements;
    drop policy if exists delivery_acknowledgements_insert_recipient_scope on app.delivery_acknowledgements;
  end if;
end $$;

-- Drop views (AFTER policies, since policies depend on views)
drop view if exists app.current_dm_inbox_threads;
drop view if exists app.pending_member_updates;
drop view if exists app.current_member_update_receipts;
drop view if exists app.current_applications;
drop view if exists app.live_entities;
drop view if exists app.accessible_network_memberships;
drop view if exists app.active_network_memberships;
drop view if exists app.current_network_memberships;
drop view if exists app.current_network_membership_states;
drop view if exists app.current_network_owners;
drop view if exists app.current_delivery_attempts;

-- Drop triggers
drop trigger if exists network_memberships_identity_guard on app.network_memberships;
drop trigger if exists network_membership_state_versions_sync on app.network_membership_state_versions;
drop trigger if exists networks_owner_member_lock on app.networks;
drop trigger if exists network_owner_versions_sync on app.network_owner_versions;

-- Drop functions
drop function if exists app.actor_has_network_access(app.short_id);
drop function if exists app.actor_is_network_owner(app.short_id);
drop function if exists app.lock_network_membership_mutation();
drop function if exists app.sync_network_membership_compatibility_state();
drop function if exists app.lock_network_owner_mutation();
drop function if exists app.sync_network_owner_compatibility_state();
drop function if exists app.list_publicly_listed_networks();
drop function if exists app.actor_can_access_thread(app.short_id);
drop function if exists app.actor_can_access_member(app.short_id);
drop function if exists app.current_actor_network_ids();

-- ============================================================================
-- PHASE 2: RENAME TABLES
-- ============================================================================

alter table app.networks rename to clubs;
alter table app.network_memberships rename to club_memberships;
alter table app.network_membership_state_versions rename to club_membership_state_versions;
alter table app.network_owner_versions rename to club_owner_versions;
alter table app.network_quota_policies rename to club_quota_policies;

-- ============================================================================
-- PHASE 3: RENAME COLUMNS (network_id -> club_id)
-- ============================================================================

alter table app.club_memberships rename column network_id to club_id;
alter table app.club_owner_versions rename column network_id to club_id;
alter table app.club_quota_policies rename column network_id to club_id;
alter table app.entities rename column network_id to club_id;
alter table app.transcript_threads rename column network_id to club_id;
alter table app.edges rename column network_id to club_id;
alter table app.member_updates rename column network_id to club_id;
alter table app.member_update_receipts rename column network_id to club_id;
alter table app.applications rename column network_id to club_id;
alter table app.sponsorships rename column network_id to club_id;

-- Conditional renames for tables that may or may not exist
do $$ begin
  if exists (select 1 from pg_tables where schemaname = 'app' and tablename = 'delivery_attempts') then
    alter table app.delivery_attempts rename column network_id to club_id;
  end if;
end $$;

do $$ begin
  if exists (select 1 from pg_tables where schemaname = 'app' and tablename = 'delivery_worker_tokens') then
    alter table app.delivery_worker_tokens rename column allowed_network_ids to allowed_club_ids;
  end if;
end $$;

do $$ begin
  if exists (select 1 from pg_tables where schemaname = 'app' and tablename = 'deliveries') then
    alter table app.deliveries rename column network_id to club_id;
  end if;
end $$;

do $$ begin
  if exists (select 1 from pg_tables where schemaname = 'app' and tablename = 'delivery_acknowledgements') then
    if exists (select 1 from information_schema.columns where table_schema = 'app' and table_name = 'delivery_acknowledgements' and column_name = 'network_id') then
      alter table app.delivery_acknowledgements rename column network_id to club_id;
    end if;
  end if;
end $$;

-- ============================================================================
-- PHASE 4: RENAME INDEXES
-- ============================================================================

alter index if exists app.network_memberships_member_status_idx rename to club_memberships_member_status_idx;
alter index if exists app.network_memberships_network_status_idx rename to club_memberships_club_status_idx;
alter index if exists app.network_memberships_sponsor_idx rename to club_memberships_sponsor_idx;
alter index if exists app.entities_network_kind_idx rename to entities_club_kind_idx;
alter index if exists app.transcript_threads_network_kind_idx rename to transcript_threads_club_kind_idx;
alter index if exists app.edges_network_kind_idx rename to edges_club_kind_idx;
alter index if exists app.network_membership_state_versions_membership_version_idx rename to club_membership_state_versions_membership_version_idx;
alter index if exists app.network_owner_versions_network_idx rename to club_owner_versions_club_idx;
alter index if exists app.sponsorships_network_idx rename to sponsorships_club_idx;

do $$ begin
  if exists (select 1 from pg_indexes where schemaname = 'app' and indexname = 'delivery_attempts_network_started_idx') then
    alter index app.delivery_attempts_network_started_idx rename to delivery_attempts_club_started_idx;
  end if;
end $$;

-- ============================================================================
-- PHASE 5: RECREATE VIEWS
-- ============================================================================

-- 1. current_club_membership_states
create view app.current_club_membership_states as
select distinct on (membership_id)
  id, membership_id, status, reason, version_no,
  supersedes_state_version_id, source_transcript_thread_id,
  source_transcript_message_id, created_at, created_by_member_id
from app.club_membership_state_versions
order by membership_id, version_no desc, created_at desc;

-- 2. current_club_memberships
create view app.current_club_memberships as
select
  cm.id, cm.club_id, cm.member_id, cm.sponsor_member_id, cm.role,
  ccms.status,
  cm.joined_at,
  case when ccms.status in ('revoked', 'rejected') then ccms.created_at else null end as left_at,
  cm.accepted_covenant_at, cm.metadata,
  ccms.id as state_version_id,
  ccms.reason as state_reason,
  ccms.version_no as state_version_no,
  ccms.supersedes_state_version_id,
  ccms.source_transcript_thread_id,
  ccms.source_transcript_message_id,
  ccms.created_at as state_created_at,
  ccms.created_by_member_id as state_created_by_member_id
from app.club_memberships cm
join app.current_club_membership_states ccms on ccms.membership_id = cm.id;

-- 3. active_club_memberships
create view app.active_club_memberships as
select * from app.current_club_memberships where status = 'active' and left_at is null;

-- 4. accessible_club_memberships
create view app.accessible_club_memberships as
select
  ccm.id, ccm.club_id, ccm.member_id, ccm.sponsor_member_id,
  ccm.role, ccm.status, ccm.joined_at, ccm.left_at,
  ccm.accepted_covenant_at, ccm.metadata
from app.current_club_memberships ccm
where ccm.status = 'active'
  and ccm.left_at is null
  and (ccm.role = 'owner' or app.membership_has_live_subscription(ccm.id));

-- 5. current_club_owners
create view app.current_club_owners as
select distinct on (club_id)
  id, club_id, owner_member_id, version_no,
  supersedes_owner_version_id, created_at, created_by_member_id
from app.club_owner_versions
order by club_id, version_no desc, created_at desc;

-- 6. current_applications
create view app.current_applications as
select
  a.id, a.club_id, a.applicant_member_id, a.sponsor_member_id,
  a.membership_id, a.path, a.application_details, a.metadata, a.created_at,
  cav.id as version_id, cav.status, cav.notes,
  cav.intake_kind, cav.intake_price_amount, cav.intake_price_currency,
  cav.intake_booking_url, cav.intake_booked_at, cav.intake_completed_at,
  cav.version_no, cav.supersedes_version_id,
  cav.source_transcript_thread_id, cav.source_transcript_message_id,
  cav.created_at as version_created_at,
  cav.created_by_member_id as version_created_by_member_id,
  a.applicant_email, a.applicant_name
from app.applications a
join app.current_application_versions cav on cav.application_id = a.id;

-- 7. current_member_update_receipts
create view app.current_member_update_receipts as
select distinct on (member_update_id, recipient_member_id)
  id, member_update_id, recipient_member_id, club_id, state,
  suppression_reason, version_no, supersedes_receipt_id,
  created_at, created_by_member_id
from app.member_update_receipts
order by member_update_id, recipient_member_id, version_no desc, created_at desc;

-- 8. pending_member_updates
create view app.pending_member_updates as
select
  mu.id as update_id, mu.stream_seq, mu.recipient_member_id,
  mu.club_id, mu.topic, mu.payload, mu.entity_id,
  mu.entity_version_id, mu.transcript_message_id,
  mu.created_by_member_id, mu.created_at
from app.member_updates mu
left join app.current_member_update_receipts cmur
  on cmur.member_update_id = mu.id and cmur.recipient_member_id = mu.recipient_member_id
where cmur.id is null;

-- 9. live_entities
create view app.live_entities as
select
  e.id as entity_id, e.club_id, e.kind, e.author_member_id, e.parent_entity_id,
  e.created_at as entity_created_at,
  cev.id as entity_version_id, cev.version_no, cev.state, cev.title, cev.summary,
  cev.body, cev.work_mode, cev.compensation, cev.starts_at, cev.ends_at,
  cev.timezone, cev.recurrence_rule, cev.capacity, cev.effective_at, cev.expires_at,
  cev.content, cev.created_at as version_created_at, cev.created_by_member_id
from app.entities e
join app.current_published_entity_versions cev on cev.entity_id = e.id
where e.archived_at is null and e.deleted_at is null
  and (cev.expires_at is null or cev.expires_at > now());

-- 10. current_dm_inbox_threads
create view app.current_dm_inbox_threads as
with thread_messages as (
  select
    tt.id as thread_id, tt.club_id,
    participant.recipient_member_id,
    case when tt.created_by_member_id = participant.recipient_member_id then tt.counterpart_member_id else tt.created_by_member_id end as counterpart_member_id,
    tm.id as message_id, tm.sender_member_id, tm.role, tm.message_text, tm.created_at,
    row_number() over (partition by participant.recipient_member_id, tt.id order by tm.created_at desc, tm.id desc) as latest_row_no
  from app.transcript_threads tt
  join (
    select tt_inner.id as thread_id, tt_inner.created_by_member_id as recipient_member_id
    from app.transcript_threads tt_inner where tt_inner.kind = 'dm' and tt_inner.archived_at is null and tt_inner.created_by_member_id is not null
    union
    select tt_inner.id as thread_id, tt_inner.counterpart_member_id as recipient_member_id
    from app.transcript_threads tt_inner where tt_inner.kind = 'dm' and tt_inner.archived_at is null and tt_inner.counterpart_member_id is not null
  ) participant on participant.thread_id = tt.id
  join app.transcript_messages tm on tm.thread_id = tt.id
  where tt.kind = 'dm' and tt.archived_at is null
),
unread_messages as (
  select
    pmu.recipient_member_id, tm.thread_id,
    count(distinct pmu.transcript_message_id)::int as unread_message_count,
    count(*)::int as unread_update_count,
    max(tm.created_at) as latest_unread_message_created_at
  from app.pending_member_updates pmu
  join app.transcript_messages tm on tm.id = pmu.transcript_message_id
  join app.transcript_threads tt on tt.id = tm.thread_id
  where pmu.topic = 'transcript.message.created'
    and pmu.transcript_message_id is not null
    and tt.kind = 'dm' and tt.archived_at is null
  group by pmu.recipient_member_id, tm.thread_id
)
select
  tm.recipient_member_id, tm.club_id, tm.thread_id, tm.counterpart_member_id,
  tm.message_id as latest_message_id, tm.sender_member_id as latest_sender_member_id,
  tm.role as latest_role, tm.message_text as latest_message_text,
  tm.created_at as latest_created_at,
  coalesce(um.unread_message_count, 0) as unread_message_count,
  coalesce(um.unread_update_count, 0) as unread_update_count,
  um.latest_unread_message_created_at::timestamptz as latest_unread_message_created_at,
  (coalesce(um.unread_message_count, 0) > 0) as has_unread
from thread_messages tm
left join unread_messages um on um.recipient_member_id = tm.recipient_member_id and um.thread_id = tm.thread_id
where tm.latest_row_no = 1;

-- 11. current_delivery_attempts (only if delivery_attempts table exists)
do $$ begin
  if exists (select 1 from pg_tables where schemaname = 'app' and tablename = 'delivery_attempts') then
    execute $view$
      create view app.current_delivery_attempts as
      select distinct on (delivery_id)
        id, delivery_id, club_id, endpoint_id, worker_key, status, attempt_no,
        response_status_code, response_body, error_message,
        started_at, finished_at, created_by_member_id
      from app.delivery_attempts
      order by delivery_id, attempt_no desc, started_at desc, id desc
    $view$;
  end if;
end $$;

-- ============================================================================
-- PHASE 6: RECREATE FUNCTIONS
-- ============================================================================

-- 1. actor_has_club_access
create function app.actor_has_club_access(target_club_id app.short_id)
returns boolean
language sql
stable
security definer
set search_path = app, pg_temp
as $$
  select exists (
    select 1 from app.club_memberships cm
    join app.current_club_membership_states ccms on ccms.membership_id = cm.id
    where cm.member_id = app.current_actor_member_id()
      and cm.club_id = target_club_id
      and ccms.status = 'active'
      and (cm.role = 'owner' or app.membership_has_live_subscription(cm.id))
  )
$$;

-- 2. actor_is_club_owner
create function app.actor_is_club_owner(target_club_id app.short_id)
returns boolean
language sql
stable
security definer
set search_path = app, pg_temp
as $$
  select exists (
    select 1 from app.clubs c
    where c.id = target_club_id
      and c.owner_member_id = app.current_actor_member_id()
      and c.archived_at is null
  )
$$;

-- 3. actor_can_access_thread
create function app.actor_can_access_thread(target_thread_id app.short_id)
returns boolean
language sql
stable
security definer
set search_path = app, pg_temp
as $$
  select exists (
    select 1 from app.transcript_threads tt
    where tt.id = target_thread_id
      and tt.archived_at is null
      and app.actor_has_club_access(tt.club_id)
      and app.current_actor_member_id() in (tt.created_by_member_id, tt.counterpart_member_id)
  )
$$;

-- 4. actor_can_access_member
create function app.actor_can_access_member(target_member_id app.short_id)
returns boolean
language sql
stable
security definer
set search_path = app, pg_temp
as $$
  select
    target_member_id = app.current_actor_member_id()
    or app.current_actor_is_superadmin()
    or exists (
      select 1 from app.accessible_club_memberships acm
      where acm.member_id = target_member_id
        and app.actor_has_club_access(acm.club_id)
    )
    or exists (
      select 1 from app.current_club_memberships ccm
      where ccm.member_id = target_member_id
        and app.actor_is_club_owner(ccm.club_id)
    )
    or exists (
      select 1 from app.applications a
      where (a.applicant_member_id = target_member_id or a.sponsor_member_id = target_member_id)
        and (
          app.actor_is_club_owner(a.club_id)
          or a.applicant_member_id = app.current_actor_member_id()
          or a.sponsor_member_id = app.current_actor_member_id()
        )
    )
$$;

-- 5. lock_club_membership_mutation
create function app.lock_club_membership_mutation()
returns trigger
language plpgsql
as $$
begin
  if current_setting('app.allow_club_membership_state_sync', true) = '1' then return new; end if;
  if new.club_id is distinct from old.club_id then raise exception 'club_memberships.club_id is immutable'; end if;
  if new.member_id is distinct from old.member_id then raise exception 'club_memberships.member_id is immutable'; end if;
  if new.sponsor_member_id is distinct from old.sponsor_member_id then raise exception 'club_memberships.sponsor_member_id is immutable'; end if;
  if new.joined_at is distinct from old.joined_at then raise exception 'club_memberships.joined_at is immutable'; end if;
  if new.status is distinct from old.status then raise exception 'club_memberships.status must change via club_membership_state_versions'; end if;
  if new.left_at is distinct from old.left_at then raise exception 'club_memberships.left_at must change via club_membership_state_versions'; end if;
  return new;
end;
$$;

-- 6. sync_club_membership_compatibility_state
create function app.sync_club_membership_compatibility_state()
returns trigger
language plpgsql
as $$
declare mirrored_left_at timestamptz;
begin
  mirrored_left_at := case when new.status in ('revoked', 'rejected') then new.created_at else null end;
  perform set_config('app.allow_club_membership_state_sync', '1', true);
  update app.club_memberships cm set status = new.status, left_at = mirrored_left_at where cm.id = new.membership_id;
  perform set_config('app.allow_club_membership_state_sync', '', true);
  return new;
exception when others then
  perform set_config('app.allow_club_membership_state_sync', '', true);
  raise;
end;
$$;

-- 7. lock_club_owner_mutation
create function app.lock_club_owner_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op <> 'UPDATE' then return new; end if;
  if new.owner_member_id is distinct from old.owner_member_id
     and coalesce(current_setting('app.allow_club_owner_sync', true), '') <> '1' then
    raise exception 'clubs.owner_member_id must change via club_owner_versions';
  end if;
  return new;
end;
$$;

-- 8. sync_club_owner_compatibility_state
create function app.sync_club_owner_compatibility_state()
returns trigger
language plpgsql
as $$
begin
  perform set_config('app.allow_club_owner_sync', '1', true);
  update app.clubs c set owner_member_id = new.owner_member_id
   where c.id = new.club_id and c.owner_member_id is distinct from new.owner_member_id;
  perform set_config('app.allow_club_owner_sync', '', true);
  return new;
exception
  when others then
    perform set_config('app.allow_club_owner_sync', '', true);
    raise;
end;
$$;

-- 9. list_publicly_listed_clubs
create function app.list_publicly_listed_clubs()
returns table(slug text, name text, summary text)
language sql
stable
security definer
set search_path = app, pg_temp
as $$
  select c.slug, c.name, c.summary from app.clubs c
  where c.publicly_listed = true and c.archived_at is null order by c.name asc;
$$;

-- 10. membership_belongs_to_current_actor (update via CREATE OR REPLACE)
create or replace function app.membership_belongs_to_current_actor(target_membership_id app.short_id)
returns boolean
language sql
stable
security definer
set search_path = app, pg_temp
as $$
  select exists (
    select 1 from app.club_memberships cm
    where cm.id = target_membership_id and cm.member_id = app.current_actor_member_id()
  )
$$;

-- 11. count_member_writes_today (drop old, create new with renamed param)
drop function if exists app.count_member_writes_today(app.short_id, app.short_id, text);
create function app.count_member_writes_today(target_member_id app.short_id, target_club_id app.short_id, target_action text)
returns integer
language sql
stable
security definer
set search_path = app, pg_temp
as $$
  select case target_action
    when 'entities.create' then (select count(*)::int from app.entities e where e.author_member_id = target_member_id and e.club_id = target_club_id and e.kind != 'event' and e.created_at >= current_date)
    when 'events.create' then (select count(*)::int from app.entities e where e.author_member_id = target_member_id and e.club_id = target_club_id and e.kind = 'event' and e.created_at >= current_date)
    when 'messages.send' then (select count(*)::int from app.transcript_messages tm join app.transcript_threads tt on tt.id = tm.thread_id where tm.sender_member_id = target_member_id and tt.club_id = target_club_id and tm.created_at >= current_date)
    else 0
  end
$$;

-- 12. consume_cold_application_challenge (drop old, create new)
drop function if exists app.consume_cold_application_challenge(app.short_id, text, text, text, jsonb);
create function app.consume_cold_application_challenge(target_challenge_id app.short_id, target_club_slug text, target_name text, target_email text, target_application_details jsonb)
returns table(application_id app.short_id)
language sql
security definer
set search_path = app, pg_temp
as $$
  with challenge as (
    delete from app.cold_application_challenges c where c.id = target_challenge_id returning 1
  ), target_club as (
    select c.id as club_id from app.clubs c where c.slug = target_club_slug and c.archived_at is null limit 1
  ), inserted as (
    insert into app.applications (club_id, path, applicant_email, applicant_name, application_details)
    select target_club.club_id, 'cold', target_email, target_name, target_application_details
    from target_club where exists (select 1 from challenge)
    returning id as application_id
  ), version_insert as (
    insert into app.application_versions (application_id, status, notes, version_no)
    select inserted.application_id, 'submitted', 'Cold application submitted after proof verification', 1
    from inserted
  )
  select inserted.application_id from inserted;
$$;

-- 13. authenticate_delivery_worker_token (drop old, create new)
do $$ begin
  if exists (select 1 from pg_tables where schemaname = 'app' and tablename = 'delivery_worker_tokens') then
    drop function if exists app.authenticate_delivery_worker_token(app.short_id, text);
    execute $func$
      create function app.authenticate_delivery_worker_token(target_token_id app.short_id, target_token_hash text)
      returns table(token_id app.short_id, actor_member_id app.short_id, label text, allowed_club_ids app.short_id[], metadata jsonb)
      language plpgsql
      security definer
      set search_path = app, pg_temp
      as $inner$
      begin
        perform set_config('app.allow_delivery_worker_token_auth', '1', true);
        return query update app.delivery_worker_tokens dwt set last_used_at = now()
          where dwt.id = target_token_id and dwt.token_hash = target_token_hash and dwt.revoked_at is null
          returning dwt.id, dwt.actor_member_id, dwt.label, dwt.allowed_club_ids, dwt.metadata;
        perform set_config('app.allow_delivery_worker_token_auth', '', true);
      exception when others then
        perform set_config('app.allow_delivery_worker_token_auth', '', true);
        raise;
      end;
      $inner$
    $func$;
  end if;
end $$;

-- ============================================================================
-- PHASE 7: RECREATE POLICIES
-- ============================================================================

-- Policies on app.clubs
create policy clubs_select_scope on app.clubs for select
  using (app.current_actor_is_superadmin() or app.actor_has_club_access(id));
create policy clubs_insert_superadmin on app.clubs for insert
  with check (app.current_actor_is_superadmin() and archived_at is null);
create policy clubs_update_superadmin on app.clubs for update
  using (app.current_actor_is_superadmin()) with check (app.current_actor_is_superadmin());
create policy clubs_select_security_definer_owner on app.clubs for select
  using (current_user = 'clawclub_security_definer_owner');
create policy clubs_select_cold_application_owner on app.clubs for select
  using (current_user = 'clawclub_cold_application_owner' and archived_at is null);

-- Policies on app.club_memberships
create policy club_memberships_select_actor_scope on app.club_memberships for select
  using (member_id = app.current_actor_member_id() or app.current_actor_is_superadmin() or app.actor_is_club_owner(club_id) or app.actor_has_club_access(club_id));
create policy club_memberships_insert_owner_scope on app.club_memberships for insert
  with check (app.current_actor_is_superadmin() or app.actor_is_club_owner(club_id));
create policy club_memberships_update_state_sync on app.club_memberships for update
  using (coalesce(current_setting('app.allow_club_membership_state_sync', true), '') = '1' and pg_trigger_depth() > 0)
  with check (coalesce(current_setting('app.allow_club_membership_state_sync', true), '') = '1' and pg_trigger_depth() > 0);
create policy club_memberships_delete_none on app.club_memberships for delete using (false);
create policy club_memberships_select_security_definer_owner on app.club_memberships for select
  using (current_user = 'clawclub_security_definer_owner');

-- Policies on app.club_membership_state_versions
create policy club_membership_state_versions_select_actor_scope on app.club_membership_state_versions for select
  using (exists (select 1 from app.club_memberships cm where cm.id = club_membership_state_versions.membership_id and (cm.member_id = app.current_actor_member_id() or app.current_actor_is_superadmin() or app.actor_has_club_access(cm.club_id))));
create policy club_membership_state_versions_insert_owner_scope on app.club_membership_state_versions for insert
  with check (created_by_member_id = app.current_actor_member_id() and exists (select 1 from app.club_memberships cm where cm.id = club_membership_state_versions.membership_id and (app.current_actor_is_superadmin() or app.actor_is_club_owner(cm.club_id))));
create policy club_membership_state_versions_select_security_definer_owner on app.club_membership_state_versions for select
  using (current_user = 'clawclub_security_definer_owner');

-- Policies on app.club_owner_versions
create policy club_owner_versions_select_actor_scope on app.club_owner_versions for select
  using (app.current_actor_is_superadmin() or app.actor_has_club_access(club_id));
create policy club_owner_versions_insert_superadmin on app.club_owner_versions for insert
  with check (app.current_actor_is_superadmin() and created_by_member_id = app.current_actor_member_id() and app.member_is_active(owner_member_id));

-- Policies on app.club_quota_policies
create policy member_select_club_quota_policies on app.club_quota_policies for select
  using (current_setting('app.actor_member_id', true) is not null and exists (select 1 from app.accessible_club_memberships acm where acm.member_id = current_setting('app.actor_member_id', true)::app.short_id and acm.club_id = club_quota_policies.club_id));
create policy superadmin_select_club_quota_policies on app.club_quota_policies for select
  using (current_setting('app.actor_member_id', true) is not null and exists (select 1 from app.current_member_global_roles cmgr where cmgr.member_id = current_setting('app.actor_member_id', true)::app.short_id and cmgr.role = 'superadmin'));

-- Policies on app.edges
create policy edges_select_accessible on app.edges for select
  using (archived_at is null and app.actor_has_club_access(club_id));
create policy edges_insert_author_scope on app.edges for insert
  with check (archived_at is null and from_member_id = app.current_actor_member_id() and created_by_member_id = app.current_actor_member_id() and app.actor_has_club_access(club_id));

-- Policies on app.entities
create policy entities_select_accessible on app.entities for select
  using (deleted_at is null and app.actor_has_club_access(club_id) and app.entity_is_currently_published(id));
create policy entities_insert_author_scope on app.entities for insert
  with check (archived_at is null and deleted_at is null and author_member_id = app.current_actor_member_id() and app.actor_has_club_access(club_id));

-- Policies on app.entity_versions
create policy entity_versions_select_accessible on app.entity_versions for select
  using (exists (select 1 from app.entities e where e.id = entity_versions.entity_id and e.deleted_at is null and app.entity_is_currently_published(e.id) and app.actor_has_club_access(e.club_id)));
create policy entity_versions_insert_author_scope on app.entity_versions for insert
  with check (created_by_member_id = app.current_actor_member_id() and exists (select 1 from app.entities e where e.id = entity_versions.entity_id and e.archived_at is null and e.deleted_at is null and e.author_member_id = app.current_actor_member_id() and app.actor_has_club_access(e.club_id)));
create policy entity_versions_select_security_definer_owner on app.entity_versions for select
  using (current_user = 'clawclub_security_definer_owner');

-- Policies on app.event_rsvps
create policy event_rsvps_select_accessible on app.event_rsvps for select
  using (exists (select 1 from app.entities e where e.id = event_entity_id and e.kind = 'event' and e.archived_at is null and e.deleted_at is null and app.actor_has_club_access(e.club_id)));
create policy event_rsvps_insert_owned_membership on app.event_rsvps for insert
  with check (created_by_member_id = app.current_actor_member_id() and exists (select 1 from app.club_memberships cm join app.entities e on e.id = event_entity_id where cm.id = membership_id and cm.member_id = app.current_actor_member_id() and e.kind = 'event' and e.club_id = cm.club_id and e.archived_at is null and e.deleted_at is null and app.actor_has_club_access(e.club_id)));

-- Policies on app.transcript_threads
create policy transcript_threads_select_participant_scope on app.transcript_threads for select
  using (archived_at is null and app.actor_has_club_access(club_id) and app.current_actor_member_id() in (created_by_member_id, counterpart_member_id));
create policy transcript_threads_insert_participant_scope on app.transcript_threads for insert
  with check (archived_at is null and kind = 'dm' and created_by_member_id = app.current_actor_member_id() and counterpart_member_id is not null and app.actor_has_club_access(club_id));


-- Policies on app.member_updates
create policy member_updates_insert_actor_scope on app.member_updates for insert
  with check (
    created_by_member_id = app.current_actor_member_id()
    and app.actor_has_club_access(club_id)
    and exists (select 1 from app.accessible_club_memberships acm where acm.club_id = member_updates.club_id and acm.member_id = member_updates.recipient_member_id)
    and (transcript_message_id is null or exists (select 1 from app.transcript_messages tm join app.transcript_threads tt on tt.id = tm.thread_id where tm.id = member_updates.transcript_message_id and tt.club_id = member_updates.club_id))
    and (entity_id is null or exists (select 1 from app.entities e where e.id = member_updates.entity_id and e.club_id = member_updates.club_id))
    and (entity_version_id is null or exists (select 1 from app.entity_versions ev join app.entities e on e.id = ev.entity_id where ev.id = member_updates.entity_version_id and e.club_id = member_updates.club_id))
  );

-- Policies on app.member_update_receipts
create policy member_update_receipts_insert_recipient_scope on app.member_update_receipts for insert
  with check (
    recipient_member_id = app.current_actor_member_id()
    and created_by_member_id = app.current_actor_member_id()
    and exists (select 1 from app.member_updates mu where mu.id = member_update_receipts.member_update_id and mu.recipient_member_id = member_update_receipts.recipient_member_id and mu.club_id = member_update_receipts.club_id)
  );

-- Policies on app.embeddings
create policy embeddings_select_entity_scope on app.embeddings for select
  using (entity_version_id is not null and exists (select 1 from app.entity_versions ev join app.entities e on e.id = ev.entity_id where ev.id = embeddings.entity_version_id and e.deleted_at is null and app.entity_is_currently_published(e.id) and app.actor_has_club_access(e.club_id)));

-- Policies on app.applications
create policy applications_select_actor_scope on app.applications for select
  using (app.current_actor_is_superadmin() or app.actor_is_club_owner(club_id) or applicant_member_id = app.current_actor_member_id() or sponsor_member_id = app.current_actor_member_id());
create policy applications_insert_owner_scope on app.applications for insert
  with check (app.current_actor_is_superadmin() or app.actor_is_club_owner(club_id));
create policy applications_update_owner_scope on app.applications for update
  using (app.current_actor_is_superadmin() or app.actor_is_club_owner(club_id))
  with check (app.current_actor_is_superadmin() or app.actor_is_club_owner(club_id));

-- Policies on app.application_versions
create policy application_versions_select_actor_scope on app.application_versions for select
  using (exists (select 1 from app.applications a where a.id = application_versions.application_id and (app.current_actor_is_superadmin() or app.actor_is_club_owner(a.club_id) or a.applicant_member_id = app.current_actor_member_id() or a.sponsor_member_id = app.current_actor_member_id())));
create policy application_versions_insert_owner_scope on app.application_versions for insert
  with check (created_by_member_id = app.current_actor_member_id() and exists (select 1 from app.applications a where a.id = application_versions.application_id and (app.current_actor_is_superadmin() or app.actor_is_club_owner(a.club_id))));

-- Policies on app.sponsorships
create policy sponsorships_insert_member on app.sponsorships for insert
  with check (sponsor_member_id = current_setting('app.actor_member_id', true)::app.short_id and exists (select 1 from app.accessible_club_memberships acm where acm.member_id = sponsor_member_id and acm.club_id = sponsorships.club_id));
create policy sponsorships_select_own on app.sponsorships for select
  using (sponsor_member_id = current_setting('app.actor_member_id', true)::app.short_id and exists (select 1 from app.accessible_club_memberships acm where acm.member_id = sponsor_member_id and acm.club_id = sponsorships.club_id));
create policy sponsorships_select_owner on app.sponsorships for select
  using (exists (select 1 from app.accessible_club_memberships acm where acm.member_id = current_setting('app.actor_member_id', true)::app.short_id and acm.club_id = sponsorships.club_id and acm.role = 'owner'));

-- Policies on app.delivery_acknowledgements (if table exists)
do $$ begin
  if exists (select 1 from pg_tables where schemaname = 'app' and tablename = 'delivery_acknowledgements') then
    execute $pol$
      create policy delivery_acknowledgements_select_recipient_scope on app.delivery_acknowledgements for select
        using (recipient_member_id = app.current_actor_member_id() and app.actor_has_club_access(club_id))
    $pol$;
    execute $pol$
      create policy delivery_acknowledgements_insert_recipient_scope on app.delivery_acknowledgements for insert
        with check (recipient_member_id = app.current_actor_member_id() and created_by_member_id = app.current_actor_member_id() and app.actor_has_club_access(club_id) and exists (select 1 from app.deliveries d where d.id = delivery_acknowledgements.delivery_id and d.recipient_member_id = app.current_actor_member_id() and d.club_id = delivery_acknowledgements.club_id))
    $pol$;
  end if;
end $$;

-- Recreate policies on app.transcript_messages
create policy transcript_messages_select_thread_scope on app.transcript_messages
  for select using (app.actor_can_access_thread(thread_id));
create policy transcript_messages_insert_thread_scope on app.transcript_messages
  for insert with check (
    role = 'member'
    and sender_member_id = app.current_actor_member_id()
    and app.actor_can_access_thread(thread_id)
  );

-- Recreate policies on app.members
create policy members_select_actor_scope on app.members
  for select using (app.actor_can_access_member(id));

-- Recreate policies on app.member_profile_versions
create policy member_profile_versions_select_actor_scope on app.member_profile_versions
  for select using (app.actor_can_access_member(member_id));

-- Recreate policies on app.embeddings (profile scope)
create policy embeddings_select_profile_scope on app.embeddings
  for select using (
    member_profile_version_id is not null
    and exists (
      select 1 from app.member_profile_versions mpv
      where mpv.id = embeddings.member_profile_version_id
        and app.actor_can_access_member(mpv.member_id)
    )
  );

-- Recreate delivery policies
do $$ begin
  if exists (select 1 from pg_tables where schemaname = 'app' and tablename = 'deliveries') then
    create policy deliveries_select_recipient_scope on app.deliveries for select
      using (recipient_member_id = app.current_actor_member_id() and app.actor_has_club_access(club_id));
    create policy deliveries_insert_shared_surface on app.deliveries for insert
      with check (
        app.actor_has_club_access(club_id) and (
          (entity_id is not null and exists (select 1 from app.entities e where e.id = entity_id and e.club_id = deliveries.club_id and e.archived_at is null and e.deleted_at is null))
          or (transcript_message_id is not null and exists (select 1 from app.transcript_messages tm join app.transcript_threads tt on tt.id = tm.thread_id where tm.id = transcript_message_id and tt.club_id = deliveries.club_id and tt.archived_at is null and app.current_actor_member_id() in (tt.created_by_member_id, tt.counterpart_member_id)))
        )
      );
  end if;
end $$;

do $$ begin
  if exists (select 1 from pg_tables where schemaname = 'app' and tablename = 'delivery_endpoints') then
    create policy delivery_endpoints_select_actor_scope on app.delivery_endpoints for select
      using (member_id = app.current_actor_member_id() or exists (select 1 from app.deliveries d where d.endpoint_id = delivery_endpoints.id and app.actor_has_club_access(d.club_id)));
    create policy delivery_endpoints_update_actor_scope on app.delivery_endpoints for update
      using (member_id = app.current_actor_member_id() or exists (select 1 from app.deliveries d where d.endpoint_id = delivery_endpoints.id and app.actor_has_club_access(d.club_id)))
      with check (member_id = app.current_actor_member_id() or exists (select 1 from app.deliveries d where d.endpoint_id = delivery_endpoints.id and app.actor_has_club_access(d.club_id)));
  end if;
end $$;

do $$ begin
  if exists (select 1 from pg_tables where schemaname = 'app' and tablename = 'delivery_attempts') then
    create policy delivery_attempts_select_actor_scope on app.delivery_attempts for select
      using (created_by_member_id = app.current_actor_member_id() or app.current_actor_is_superadmin() or app.actor_is_club_owner(club_id));
    create policy delivery_attempts_insert_actor_scope on app.delivery_attempts for insert
      with check (created_by_member_id = app.current_actor_member_id() and app.actor_has_club_access(club_id) and exists (select 1 from app.deliveries d where d.id = delivery_attempts.delivery_id and d.club_id = delivery_attempts.club_id and d.endpoint_id = delivery_attempts.endpoint_id));
    create policy delivery_attempts_update_actor_scope on app.delivery_attempts for update
      using (created_by_member_id = app.current_actor_member_id() and app.actor_has_club_access(club_id))
      with check (created_by_member_id = app.current_actor_member_id() and app.actor_has_club_access(club_id));
  end if;
end $$;

-- ============================================================================
-- PHASE 8: RECREATE TRIGGERS
-- ============================================================================

create trigger club_memberships_identity_guard
  before update on app.club_memberships
  for each row execute function app.lock_club_membership_mutation();

create trigger club_membership_state_versions_sync
  after insert on app.club_membership_state_versions
  for each row execute function app.sync_club_membership_compatibility_state();

create trigger clubs_owner_member_lock
  before update of owner_member_id on app.clubs
  for each row execute function app.lock_club_owner_mutation();

create trigger club_owner_versions_sync
  after insert on app.club_owner_versions
  for each row execute function app.sync_club_owner_compatibility_state();

-- ============================================================================
-- PHASE 9: FIX OWNERSHIP
-- ============================================================================

alter function app.actor_has_club_access(app.short_id) owner to clawclub_security_definer_owner;
alter function app.actor_is_club_owner(app.short_id) owner to clawclub_security_definer_owner;
alter function app.actor_can_access_member(app.short_id) owner to clawclub_security_definer_owner;
alter function app.actor_can_access_thread(app.short_id) owner to clawclub_security_definer_owner;
alter function app.membership_belongs_to_current_actor(app.short_id) owner to clawclub_security_definer_owner;
alter function app.count_member_writes_today(app.short_id, app.short_id, text) owner to clawclub_security_definer_owner;
alter function app.list_publicly_listed_clubs() owner to clawclub_cold_application_owner;
alter function app.consume_cold_application_challenge(app.short_id, text, text, text, jsonb) owner to clawclub_cold_application_owner;

-- Reassign all views to clawclub_view_owner
do $$
declare view_name text;
begin
  if exists (select 1 from pg_roles where rolname = 'clawclub_view_owner') then
    for view_name in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'app' and c.relkind = 'v'
    loop execute format('alter view app.%I owner to clawclub_view_owner', view_name); end loop;
  end if;
end $$;

-- ============================================================================
-- PHASE 10: UPDATE COMMENTS
-- ============================================================================

comment on table app.club_memberships is
  'Protected source of membership identity and role. Read/write access is constrained by RLS; mutable state flows through club_membership_state_versions.';
comment on column app.club_memberships.status is
  'Compatibility mirror of the latest app.club_membership_state_versions.status. Write through the state history table only.';
comment on column app.club_memberships.left_at is
  'Compatibility mirror of the latest terminal membership state timestamp. Write through the state history table only.';
comment on column app.clubs.owner_member_id is
  'Compatibility mirror of the latest app.club_owner_versions.owner_member_id. Write through the owner history table only.';
comment on table app.subscriptions is
  'Protected source of paid-access facts. Runtime visibility is constrained by RLS; membership access helpers only consume live-subscription booleans.';

commit;
