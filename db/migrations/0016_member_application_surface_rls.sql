begin;

create or replace function app.actor_has_network_access(target_network_id app.short_id)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from app.accessible_network_memberships anm
    where anm.member_id = app.current_actor_member_id()
      and anm.network_id = target_network_id
  )
$$;

create or replace function app.actor_is_network_owner(target_network_id app.short_id)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from app.current_network_memberships cnm
    where cnm.member_id = app.current_actor_member_id()
      and cnm.network_id = target_network_id
      and cnm.role = 'owner'
      and cnm.status = 'active'
  )
$$;

create or replace function app.actor_can_access_member(target_member_id app.short_id)
returns boolean
language sql
stable
as $$
  select
    target_member_id = app.current_actor_member_id()
    or app.current_actor_is_superadmin()
    or exists (
      select 1
      from app.accessible_network_memberships anm
      where anm.member_id = target_member_id
        and app.actor_has_network_access(anm.network_id)
    )
    or exists (
      select 1
      from app.current_network_memberships cnm
      where cnm.member_id = target_member_id
        and app.actor_is_network_owner(cnm.network_id)
    )
    or exists (
      select 1
      from app.applications a
      where (a.applicant_member_id = target_member_id or a.sponsor_member_id = target_member_id)
        and (
          app.actor_is_network_owner(a.network_id)
          or a.applicant_member_id = app.current_actor_member_id()
          or a.sponsor_member_id = app.current_actor_member_id()
        )
    )
$$;

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
      and m.deleted_at is null
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
    and m.deleted_at is null
  limit 1
$$;

create or replace view app.current_network_memberships as
select
  nm.id,
  nm.network_id,
  nm.member_id,
  nm.sponsor_member_id,
  nm.role,
  cnms.status,
  nm.joined_at,
  case when cnms.status in ('revoked', 'rejected') then cnms.created_at else null end as left_at,
  nm.accepted_covenant_at,
  nm.metadata,
  cnms.id as state_version_id,
  cnms.reason as state_reason,
  cnms.version_no as state_version_no,
  cnms.supersedes_state_version_id,
  cnms.source_transcript_thread_id,
  cnms.source_transcript_message_id,
  cnms.created_at as state_created_at,
  cnms.created_by_member_id as state_created_by_member_id
from app.network_memberships nm
join app.current_network_membership_states cnms on cnms.membership_id = nm.id;

alter table app.members enable row level security;
alter table app.members force row level security;

drop policy if exists members_select_actor_scope on app.members;
create policy members_select_actor_scope on app.members
  for select
  using (app.actor_can_access_member(id));

drop policy if exists members_update_self on app.members;
create policy members_update_self on app.members
  for update
  using (id = app.current_actor_member_id() or app.current_actor_is_superadmin())
  with check (id = app.current_actor_member_id() or app.current_actor_is_superadmin());

alter table app.member_profile_versions enable row level security;
alter table app.member_profile_versions force row level security;

drop policy if exists member_profile_versions_select_actor_scope on app.member_profile_versions;
create policy member_profile_versions_select_actor_scope on app.member_profile_versions
  for select
  using (app.actor_can_access_member(member_id));

drop policy if exists member_profile_versions_insert_self on app.member_profile_versions;
create policy member_profile_versions_insert_self on app.member_profile_versions
  for insert
  with check (
    member_id = app.current_actor_member_id()
    and created_by_member_id = app.current_actor_member_id()
  );

alter table app.applications enable row level security;
alter table app.applications force row level security;

drop policy if exists applications_select_actor_scope on app.applications;
create policy applications_select_actor_scope on app.applications
  for select
  using (
    app.current_actor_is_superadmin()
    or app.actor_is_network_owner(network_id)
    or applicant_member_id = app.current_actor_member_id()
    or sponsor_member_id = app.current_actor_member_id()
  );

drop policy if exists applications_insert_owner_scope on app.applications;
create policy applications_insert_owner_scope on app.applications
  for insert
  with check (
    app.current_actor_is_superadmin()
    or app.actor_is_network_owner(network_id)
  );

drop policy if exists applications_update_owner_scope on app.applications;
create policy applications_update_owner_scope on app.applications
  for update
  using (
    app.current_actor_is_superadmin()
    or app.actor_is_network_owner(network_id)
  )
  with check (
    app.current_actor_is_superadmin()
    or app.actor_is_network_owner(network_id)
  );

alter table app.application_versions enable row level security;
alter table app.application_versions force row level security;

drop policy if exists application_versions_select_actor_scope on app.application_versions;
create policy application_versions_select_actor_scope on app.application_versions
  for select
  using (
    exists (
      select 1
      from app.applications a
      where a.id = application_id
        and (
          app.current_actor_is_superadmin()
          or app.actor_is_network_owner(a.network_id)
          or a.applicant_member_id = app.current_actor_member_id()
          or a.sponsor_member_id = app.current_actor_member_id()
        )
    )
  );

drop policy if exists application_versions_insert_owner_scope on app.application_versions;
create policy application_versions_insert_owner_scope on app.application_versions
  for insert
  with check (
    created_by_member_id = app.current_actor_member_id()
    and exists (
      select 1
      from app.applications a
      where a.id = application_id
        and (
          app.current_actor_is_superadmin()
          or app.actor_is_network_owner(a.network_id)
        )
    )
  );

commit;
