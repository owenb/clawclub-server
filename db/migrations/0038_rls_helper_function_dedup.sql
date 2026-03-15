begin;

create or replace function app.membership_belongs_to_current_actor(target_membership_id app.short_id)
returns boolean
language sql
stable
security definer
set search_path = app, pg_temp
as $$
  select exists (
    select 1
    from app.network_memberships nm
    where nm.id = target_membership_id
      and nm.member_id = app.current_actor_member_id()
  )
$$;

create or replace function app.entity_is_currently_published(target_entity_id app.short_id)
returns boolean
language sql
stable
security definer
set search_path = app, pg_temp
as $$
  select exists (
    select 1
    from app.entity_versions current_ev
    where current_ev.entity_id = target_entity_id
      and current_ev.version_no = (
        select max(latest_ev.version_no)
        from app.entity_versions latest_ev
        where latest_ev.entity_id = target_entity_id
      )
      and current_ev.state = 'published'
  )
$$;

drop policy if exists subscriptions_select_actor_scope on app.subscriptions;
create policy subscriptions_select_actor_scope on app.subscriptions
  for select
  using (
    payer_member_id = app.current_actor_member_id()
    or app.current_actor_is_superadmin()
    or app.membership_belongs_to_current_actor(membership_id)
  );

drop policy if exists entities_select_accessible on app.entities;
create policy entities_select_accessible on app.entities
  for select
  using (
    deleted_at is null
    and app.actor_has_network_access(network_id)
    and app.entity_is_currently_published(id)
  );

drop policy if exists entity_versions_select_accessible on app.entity_versions;
create policy entity_versions_select_accessible on app.entity_versions
  for select
  using (
    exists (
      select 1
      from app.entities e
      where e.id = entity_versions.entity_id
        and e.deleted_at is null
        and app.entity_is_currently_published(e.id)
        and app.actor_has_network_access(e.network_id)
    )
  );

commit;
