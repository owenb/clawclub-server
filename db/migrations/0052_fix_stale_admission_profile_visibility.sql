-- 0052_fix_stale_admission_profile_visibility.sql
--
-- Fix: historical admission relationships no longer grant profile visibility
-- after club access is lost. The admissions fallback in actor_can_access_member
-- now requires current club access for non-owner actors.

begin;

-- Drop policies that depend on actor_can_access_member
drop policy if exists members_select_actor_scope on app.members;
drop policy if exists member_profile_versions_select_actor_scope on app.member_profile_versions;
drop policy if exists embeddings_select_profile_scope on app.embeddings;

-- Recreate with tightened admissions fallback
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
          or (
            (a.applicant_member_id = app.current_actor_member_id() or a.sponsor_member_id = app.current_actor_member_id())
            and app.actor_has_club_access(a.club_id)
          )
        )
    )
$$;

alter function app.actor_can_access_member(app.short_id) owner to clawclub_security_definer_owner;

-- Recreate policies
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

commit;
