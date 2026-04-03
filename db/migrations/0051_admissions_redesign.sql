-- 0051_admissions_redesign.sql
--
-- Redesigns the admissions system:
--   - Renames applications → admissions, application_versions → admission_versions,
--     cold_application_challenges → admission_challenges
--   - Renames path → origin with new values (self_applied, member_sponsored, owner_nominated)
--   - Migrates sponsorships into admissions with origin='member_sponsored', then drops sponsorships
--   - Adds member_private_contacts table for storing email outside of admissions
--   - Adds create_member_from_admission security definer function
--   - Recreates all views, RLS policies, and grants

begin;

-- ============================================================================
-- PHASE 1: Drop dependent objects
-- ============================================================================

-- Drop ALL policies on applications
drop policy if exists applications_select_actor_scope on app.applications;
drop policy if exists applications_insert_owner_scope on app.applications;
drop policy if exists applications_update_owner_scope on app.applications;
drop policy if exists applications_select_security_definer_owner on app.applications;
drop policy if exists applications_select_cold_owner on app.applications;
drop policy if exists applications_insert_cold_owner on app.applications;
drop policy if exists applications_select_superadmin on app.applications;

-- Drop ALL policies on application_versions
drop policy if exists application_versions_select_actor_scope on app.application_versions;
drop policy if exists application_versions_insert_owner_scope on app.application_versions;
drop policy if exists application_versions_insert_cold_owner on app.application_versions;
drop policy if exists application_versions_select_superadmin on app.application_versions;

-- Drop ALL policies on sponsorships
drop policy if exists sponsorships_insert_member on app.sponsorships;
drop policy if exists sponsorships_select_own on app.sponsorships;
drop policy if exists sponsorships_select_owner on app.sponsorships;
drop policy if exists sponsorships_select_superadmin on app.sponsorships;

-- Drop stale "application" policy on clubs table (rename it)
drop policy if exists clubs_select_cold_application_owner on app.clubs;

-- Drop policies on cold_application_challenges (stale names after rename)
drop policy if exists cold_application_challenges_select_cold_owner on app.cold_application_challenges;
drop policy if exists cold_application_challenges_insert_cold_owner on app.cold_application_challenges;
drop policy if exists cold_application_challenges_delete_cold_owner on app.cold_application_challenges;
drop policy if exists cold_application_challenges_update_cold_owner on app.cold_application_challenges;

-- Drop policies that depend on actor_can_access_member (which references app.applications)
drop policy if exists members_select_actor_scope on app.members;
drop policy if exists member_profile_versions_select_actor_scope on app.member_profile_versions;
drop policy if exists embeddings_select_profile_scope on app.embeddings;

-- Drop actor_can_access_member (SQL function referencing app.applications by name)
drop function if exists app.actor_can_access_member(app.short_id);

-- Drop views
drop view if exists app.current_applications;
drop view if exists app.current_application_versions;

-- Drop security definer functions that reference old table names by name
drop function if exists app.consume_cold_application_challenge(app.short_id, text, text, text, jsonb);
drop function if exists app.create_cold_application_challenge(integer, integer);

-- ============================================================================
-- PHASE 2: Rename tables
-- ============================================================================

alter table app.applications rename to admissions;
alter table app.application_versions rename to admission_versions;
alter table app.cold_application_challenges rename to admission_challenges;

-- ============================================================================
-- PHASE 3: Rename columns
-- ============================================================================

alter table app.admission_versions rename column application_id to admission_id;
alter table app.admissions rename column path to origin;
alter table app.admissions rename column application_details to admission_details;

-- ============================================================================
-- PHASE 4: Update constraints and backfill origin values
-- ============================================================================

-- Drop old constraints
alter table app.admissions drop constraint if exists applications_path_check;
alter table app.admissions drop constraint if exists applications_cold_identity_check;
alter table app.admissions drop constraint if exists applications_member_applicant_check;

-- Backfill origin values
update app.admissions set origin = 'self_applied' where origin = 'cold';
update app.admissions set origin = 'owner_nominated' where origin in ('sponsored', 'outside');

-- Add new constraints
alter table app.admissions add constraint admissions_origin_check
  check (origin in ('self_applied', 'member_sponsored', 'owner_nominated'));

alter table app.admissions add constraint admissions_outsider_identity_check
  check (
    (origin = 'owner_nominated' and applicant_member_id is not null)
    or (origin in ('self_applied', 'member_sponsored') and applicant_email is not null and applicant_name is not null and length(btrim(applicant_email)) > 0 and length(btrim(applicant_name)) > 0)
  );

-- ============================================================================
-- PHASE 5: Rename indexes
-- ============================================================================

alter index if exists app.applications_network_created_idx rename to admissions_club_created_idx;
alter index if exists app.application_versions_application_version_idx rename to admission_versions_admission_version_idx;
alter index if exists app.cold_application_challenges_expires_idx rename to admission_challenges_expires_idx;

-- ============================================================================
-- PHASE 6: Migrate sponsorships into admissions
-- ============================================================================

-- Insert sponsorships as admissions with origin='member_sponsored'
insert into app.admissions (club_id, sponsor_member_id, origin, applicant_email, applicant_name, admission_details, metadata, created_at)
select
  s.club_id,
  s.sponsor_member_id,
  'member_sponsored',
  s.candidate_email,
  s.candidate_name,
  jsonb_build_object('socials', coalesce(s.candidate_details->>'socials', ''), 'reason', s.reason),
  '{}'::jsonb,
  s.created_at
from app.sponsorships s;

-- Create synthetic admission_versions for each migrated sponsorship
insert into app.admission_versions (admission_id, status, notes, version_no, created_at, created_by_member_id)
select
  a.id,
  'submitted',
  'Migrated from sponsorship recommendation',
  1,
  a.created_at,
  a.sponsor_member_id
from app.admissions a
where a.origin = 'member_sponsored'
  and not exists (
    select 1 from app.admission_versions av where av.admission_id = a.id
  );

-- Drop sponsorships table (policies already dropped)
drop table app.sponsorships;

-- ============================================================================
-- PHASE 7: Create member_private_contacts table
-- ============================================================================

create table app.member_private_contacts (
  member_id app.short_id primary key references app.members(id),
  email text check (email is null or email like '%@%'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table app.member_private_contacts enable row level security;
alter table app.member_private_contacts force row level security;

-- Member can read own contacts
create policy member_private_contacts_select_self on app.member_private_contacts
  for select using (member_id = app.current_actor_member_id());

-- Club owners can read contacts of members in their clubs
create policy member_private_contacts_select_owner on app.member_private_contacts
  for select using (
    exists (
      select 1 from app.accessible_club_memberships owner_acm
      join app.accessible_club_memberships target_acm
        on target_acm.club_id = owner_acm.club_id
       and target_acm.member_id = member_private_contacts.member_id
      where owner_acm.member_id = app.current_actor_member_id()
        and owner_acm.role = 'owner'
    )
  );

-- Superadmin reads all
create policy member_private_contacts_select_superadmin on app.member_private_contacts
  for select using (app.current_actor_is_superadmin());

-- Security definer can insert (for member creation from admission)
create policy member_private_contacts_insert_definer on app.member_private_contacts
  for insert with check (current_user = 'clawclub_security_definer_owner');

-- Security definer can read (for member creation flow)
create policy member_private_contacts_select_definer on app.member_private_contacts
  for select using (current_user = 'clawclub_security_definer_owner');

-- Allow security definer to insert members (for create_member_from_admission)
create policy members_insert_definer on app.members
  for insert with check (current_user = 'clawclub_security_definer_owner');

-- Allow security definer to insert profile versions (for create_member_from_admission)
create policy member_profile_versions_insert_definer on app.member_profile_versions
  for insert with check (current_user = 'clawclub_security_definer_owner');

-- Allow security definer to insert bearer tokens (for issue_admission_access)
create policy member_bearer_tokens_insert_definer on app.member_bearer_tokens
  for insert with check (current_user = 'clawclub_security_definer_owner');

-- ============================================================================
-- PHASE 8: Create security definer function for member creation from admission
-- ============================================================================

create or replace function app.create_member_from_admission(
  target_public_name text,
  target_email text,
  target_display_name text,
  target_admission_details jsonb
)
returns table(member_id app.short_id)
language plpgsql
security definer
set search_path = app, pg_temp
as $$
declare
  new_member_id app.short_id;
begin
  -- Create the member
  insert into app.members (public_name, state)
  values (target_public_name, 'active')
  returning id into new_member_id;

  -- Create private contacts
  if target_email is not null and length(btrim(target_email)) > 0 then
    insert into app.member_private_contacts (member_id, email)
    values (new_member_id, target_email);
  end if;

  -- Create initial profile version
  insert into app.member_profile_versions (
    member_id,
    version_no,
    display_name,
    profile,
    created_by_member_id
  )
  values (
    new_member_id,
    1,
    target_display_name,
    case when target_admission_details ? 'socials' then jsonb_build_object('socials', target_admission_details->'socials') else '{}'::jsonb end,
    new_member_id
  );

  return query select new_member_id;
end;
$$;

alter function app.create_member_from_admission(text, text, text, jsonb)
  owner to clawclub_security_definer_owner;

-- Issue a bearer token for an accepted admission's member (bypasses self-insert RLS)
create or replace function app.issue_admission_access(
  target_token_id app.short_id,
  target_member_id app.short_id,
  target_label text,
  target_token_hash text,
  target_metadata jsonb
)
returns void
language sql
security definer
set search_path = app, pg_temp
as $$
  insert into app.member_bearer_tokens (id, member_id, label, token_hash, metadata)
  values (target_token_id, target_member_id, target_label, target_token_hash, target_metadata);
$$;

alter function app.issue_admission_access(app.short_id, app.short_id, text, text, jsonb)
  owner to clawclub_security_definer_owner;

-- ============================================================================
-- PHASE 9: Recreate PL/pgSQL functions that reference renamed tables by name
-- ============================================================================

-- Recreate create_cold_application_challenge (PL/pgSQL — stores body as text)
create or replace function app.create_cold_application_challenge(
  target_difficulty integer,
  target_ttl_ms integer
)
returns table(challenge_id app.short_id, expires_at text)
language plpgsql
security definer
set search_path = app, pg_temp
as $$
begin
  delete from app.admission_challenges c
  where c.expires_at <= now();

  return query
    insert into app.admission_challenges (difficulty, expires_at)
    values (
      target_difficulty,
      now() + (target_ttl_ms * interval '1 millisecond')
    )
    returning
      id as challenge_id,
      admission_challenges.expires_at::text as expires_at;
end;
$$;

alter function app.create_cold_application_challenge(integer, integer)
  owner to clawclub_cold_application_owner;

-- Recreate consume function with new table names
create or replace function app.consume_admission_challenge(
  target_challenge_id app.short_id,
  target_club_slug text,
  target_name text,
  target_email text,
  target_admission_details jsonb
)
returns table(admission_id app.short_id)
language sql
security definer
set search_path = app, pg_temp
as $$
  with challenge as (
    delete from app.admission_challenges c
    where c.id = target_challenge_id
    returning 1
  ), target_club as (
    select c.id as club_id
    from app.clubs c
    where c.slug = target_club_slug
      and c.archived_at is null
    limit 1
  ), inserted as (
    insert into app.admissions (
      club_id, origin, applicant_email, applicant_name, admission_details
    )
    select
      target_club.club_id,
      'self_applied',
      target_email,
      target_name,
      target_admission_details
    from target_club
    where exists (select 1 from challenge)
    returning id as admission_id
  ), version_insert as (
    insert into app.admission_versions (
      admission_id, status, notes, version_no
    )
    select
      inserted.admission_id,
      'submitted',
      'Self-applied admission submitted after proof verification',
      1
    from inserted
  )
  select inserted.admission_id
  from inserted;
$$;

alter function app.consume_admission_challenge(app.short_id, text, text, text, jsonb)
  owner to clawclub_cold_application_owner;

-- Recreate get/delete challenge functions (SQL functions with FOR UPDATE break after table rename)
drop function if exists app.get_cold_application_challenge(app.short_id);
create or replace function app.get_cold_application_challenge(
  target_challenge_id app.short_id
)
returns table(challenge_id app.short_id, difficulty integer, expires_at text)
language sql
security definer
set search_path = app, pg_temp
as $$
  select
    c.id as challenge_id,
    c.difficulty,
    c.expires_at::text as expires_at
  from app.admission_challenges c
  where c.id = target_challenge_id
  limit 1
  for update;
$$;

alter function app.get_cold_application_challenge(app.short_id)
  owner to clawclub_cold_application_owner;

drop function if exists app.delete_cold_application_challenge(app.short_id);
create or replace function app.delete_cold_application_challenge(
  target_challenge_id app.short_id
)
returns boolean
language sql
security definer
set search_path = app, pg_temp
as $$
  with deleted as (
    delete from app.admission_challenges c
    where c.id = target_challenge_id
    returning 1
  )
  select exists (select 1 from deleted);
$$;

alter function app.delete_cold_application_challenge(app.short_id)
  owner to clawclub_cold_application_owner;

-- ============================================================================
-- Recreate actor_can_access_member with updated table references
create or replace function app.actor_can_access_member(target_member_id app.short_id)
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
      select 1 from app.admissions a
      where (a.applicant_member_id = target_member_id or a.sponsor_member_id = target_member_id)
        and (
          app.actor_is_club_owner(a.club_id)
          or a.applicant_member_id = app.current_actor_member_id()
          or a.sponsor_member_id = app.current_actor_member_id()
        )
    )
$$;

alter function app.actor_can_access_member(app.short_id) owner to clawclub_security_definer_owner;

-- Recreate policies that depended on actor_can_access_member
create policy members_select_actor_scope on app.members
  for select using (app.actor_can_access_member(id));

create policy member_profile_versions_select_actor_scope on app.member_profile_versions
  for select using (app.actor_can_access_member(member_id));

create policy embeddings_select_profile_scope on app.embeddings
  for select using (
    member_profile_version_id is not null
    and exists (
      select 1 from app.member_profile_versions mpv
      where mpv.id = embeddings.member_profile_version_id
        and app.actor_can_access_member(mpv.member_id)
    )
  );

-- PHASE 10: Recreate views
-- ============================================================================

create view app.current_admission_versions as
select distinct on (admission_id)
  id,
  admission_id,
  status,
  notes,
  intake_kind,
  intake_price_amount,
  intake_price_currency,
  intake_booking_url,
  intake_booked_at,
  intake_completed_at,
  version_no,
  supersedes_version_id,
  source_transcript_thread_id,
  source_transcript_message_id,
  created_at,
  created_by_member_id
from app.admission_versions
order by admission_id, version_no desc, created_at desc;

create view app.current_admissions as
select
  a.id,
  a.club_id,
  a.applicant_member_id,
  a.sponsor_member_id,
  a.membership_id,
  a.origin,
  a.admission_details,
  a.metadata,
  a.created_at,
  cav.id as version_id,
  cav.status,
  cav.notes,
  cav.intake_kind,
  cav.intake_price_amount,
  cav.intake_price_currency,
  cav.intake_booking_url,
  cav.intake_booked_at,
  cav.intake_completed_at,
  cav.version_no,
  cav.supersedes_version_id,
  cav.source_transcript_thread_id,
  cav.source_transcript_message_id,
  cav.created_at as version_created_at,
  cav.created_by_member_id as version_created_by_member_id,
  a.applicant_email,
  a.applicant_name
from app.admissions a
join app.current_admission_versions cav on cav.admission_id = a.id;

-- ============================================================================
-- PHASE 11: Recreate RLS policies on admissions
-- ============================================================================

-- Select: superadmin, club owner, applicant, or sponsor can read
create policy admissions_select_actor_scope on app.admissions
  for select using (
    app.current_actor_is_superadmin()
    or app.actor_is_club_owner(club_id)
    or applicant_member_id = app.current_actor_member_id()
    or sponsor_member_id = app.current_actor_member_id()
  );

-- Insert: superadmin or club owner (for owner_nominated)
create policy admissions_insert_owner_scope on app.admissions
  for insert with check (
    app.current_actor_is_superadmin()
    or app.actor_is_club_owner(club_id)
  );

-- Insert: member can sponsor (for member_sponsored origin)
create policy admissions_insert_sponsor on app.admissions
  for insert with check (
    origin = 'member_sponsored'
    and sponsor_member_id = app.current_actor_member_id()
    and app.actor_has_club_access(club_id)
  );

-- Update: superadmin or club owner
create policy admissions_update_owner_scope on app.admissions
  for update using (
    app.current_actor_is_superadmin()
    or app.actor_is_club_owner(club_id)
  ) with check (
    app.current_actor_is_superadmin()
    or app.actor_is_club_owner(club_id)
  );

-- Security definer owner can read
create policy admissions_select_security_definer_owner on app.admissions
  for select using (current_user = 'clawclub_security_definer_owner');

-- Cold application owner can read self_applied
create policy admissions_select_cold_owner on app.admissions
  for select using (
    origin = 'self_applied'
    and current_user = 'clawclub_cold_application_owner'
  );

-- Cold application owner can insert self_applied
create policy admissions_insert_cold_owner on app.admissions
  for insert with check (
    origin = 'self_applied'
    and current_user = 'clawclub_cold_application_owner'
  );

-- ============================================================================
-- PHASE 12: Recreate RLS policies on admission_versions
-- ============================================================================

create policy admission_versions_select_actor_scope on app.admission_versions
  for select using (
    exists (
      select 1 from app.admissions a
      where a.id = admission_versions.admission_id
        and (
          app.current_actor_is_superadmin()
          or app.actor_is_club_owner(a.club_id)
          or a.applicant_member_id = app.current_actor_member_id()
          or a.sponsor_member_id = app.current_actor_member_id()
        )
    )
  );

create policy admission_versions_insert_owner_scope on app.admission_versions
  for insert with check (
    created_by_member_id = app.current_actor_member_id()
    and exists (
      select 1 from app.admissions a
      where a.id = admission_versions.admission_id
        and (
          app.current_actor_is_superadmin()
          or app.actor_is_club_owner(a.club_id)
        )
    )
  );

create policy admission_versions_insert_cold_owner on app.admission_versions
  for insert with check (current_user = 'clawclub_cold_application_owner');

-- Recreate policies on admission_challenges (was cold_application_challenges)
-- Recreate clubs policy with updated name
create policy clubs_select_admission_definer_owner on app.clubs
  for select using (current_user = 'clawclub_cold_application_owner' and archived_at is null);

create policy admission_challenges_select_cold_owner on app.admission_challenges
  for select using (current_user = 'clawclub_cold_application_owner');
create policy admission_challenges_insert_cold_owner on app.admission_challenges
  for insert with check (current_user = 'clawclub_cold_application_owner');
create policy admission_challenges_delete_cold_owner on app.admission_challenges
  for delete using (current_user = 'clawclub_cold_application_owner');
create policy admission_challenges_update_cold_owner on app.admission_challenges
  for update
  using (current_user = 'clawclub_cold_application_owner')
  with check (current_user = 'clawclub_cold_application_owner');

-- ============================================================================
-- PHASE 13: Update grants
-- ============================================================================

-- Cold application owner needs access to renamed tables
grant select, insert on table app.admissions to clawclub_cold_application_owner;
grant insert on table app.admission_versions to clawclub_cold_application_owner;
grant select, insert, update, delete on table app.admission_challenges to clawclub_cold_application_owner;

-- Security definer owner needs insert on members (for create_member_from_admission)
grant insert on table app.members to clawclub_security_definer_owner;
grant select, insert on table app.member_private_contacts to clawclub_security_definer_owner;
grant insert on table app.member_profile_versions to clawclub_security_definer_owner;

-- Security definer owner needs insert on club_memberships and state versions (for acceptance finalization)
grant insert on table app.club_memberships to clawclub_security_definer_owner;
grant insert on table app.club_membership_state_versions to clawclub_security_definer_owner;

-- Security definer owner needs insert on member_bearer_tokens (for issue_admission_access)
grant insert on table app.member_bearer_tokens to clawclub_security_definer_owner;

-- ============================================================================
-- PHASE 14: Set view ownership
-- ============================================================================

do $$
declare
  view_name text;
begin
  if exists (select 1 from pg_roles where rolname = 'clawclub_view_owner') then
    for view_name in
      select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'app'
        and c.relkind = 'v'
    loop
      execute format('alter view app.%I owner to clawclub_view_owner', view_name);
    end loop;
  end if;
end
$$;

commit;
