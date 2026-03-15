begin;

create or replace function app.current_actor_is_superadmin()
returns boolean
language sql
stable
security definer
set search_path = app, pg_temp
as $$
  select exists (
    select 1
    from app.member_global_role_versions mgrv
    where mgrv.member_id = app.current_actor_member_id()
      and mgrv.role = 'superadmin'
      and mgrv.status = 'active'
      and not exists (
        select 1
        from app.member_global_role_versions newer
        where newer.member_id = mgrv.member_id
          and newer.role = mgrv.role
          and (
            newer.version_no > mgrv.version_no
            or (newer.version_no = mgrv.version_no and newer.created_at > mgrv.created_at)
          )
      )
  )
$$;

create or replace function app.actor_has_network_access(target_network_id app.short_id)
returns boolean
language sql
stable
security definer
set search_path = app, pg_temp
as $$
  select exists (
    select 1
    from app.network_memberships nm
    join lateral (
      select nms.status
      from app.network_membership_state_versions nms
      where nms.membership_id = nm.id
      order by nms.version_no desc, nms.created_at desc
      limit 1
    ) current_state on true
    where nm.member_id = app.current_actor_member_id()
      and nm.network_id = target_network_id
      and current_state.status = 'active'
      and (
        nm.role = 'owner'
        or app.membership_has_live_subscription(nm.id)
      )
  )
$$;

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
      select 1
      from app.network_memberships nm
      join lateral (
        select nms.status
        from app.network_membership_state_versions nms
        where nms.membership_id = nm.id
        order by nms.version_no desc, nms.created_at desc
        limit 1
      ) current_state on true
      where nm.member_id = target_member_id
        and current_state.status = 'active'
        and (
          nm.role = 'owner'
          or app.membership_has_live_subscription(nm.id)
        )
        and app.actor_has_network_access(nm.network_id)
    )
    or exists (
      select 1
      from app.network_memberships nm
      join lateral (
        select nms.status
        from app.network_membership_state_versions nms
        where nms.membership_id = nm.id
        order by nms.version_no desc, nms.created_at desc
        limit 1
      ) current_state on true
      where nm.member_id = target_member_id
        and app.actor_is_network_owner(nm.network_id)
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

drop policy if exists entities_select_accessible on app.entities;
create policy entities_select_accessible on app.entities
  for select
  using (
    deleted_at is null
    and app.actor_has_network_access(network_id)
    and exists (
      select 1
      from app.entity_versions current_ev
      where current_ev.entity_id = entities.id
        and current_ev.version_no = (
          select max(version_no)
          from app.entity_versions latest_ev
          where latest_ev.entity_id = entities.id
        )
        and current_ev.state = 'published'
    )
  );

drop policy if exists entity_versions_select_accessible on app.entity_versions;
create policy entity_versions_select_accessible on app.entity_versions
  for select
  using (
    exists (
      select 1
      from app.entities e
      join app.entity_versions current_ev on current_ev.entity_id = e.id
      where e.id = entity_versions.entity_id
        and e.deleted_at is null
        and current_ev.version_no = (
          select max(version_no)
          from app.entity_versions latest_ev
          where latest_ev.entity_id = e.id
        )
        and current_ev.state = 'published'
        and app.actor_has_network_access(e.network_id)
    )
  );

commit;
