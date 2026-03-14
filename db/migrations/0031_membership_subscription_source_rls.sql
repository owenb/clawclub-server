begin;

create or replace function app.membership_has_live_subscription(target_membership_id app.short_id)
returns boolean
language sql
stable
security definer
set search_path = app, pg_temp
as $$
  select exists (
    select 1
    from app.subscriptions s
    where s.membership_id = target_membership_id
      and s.status in ('trialing', 'active')
      and coalesce(s.ended_at, 'infinity'::timestamptz) > now()
      and coalesce(s.current_period_end, 'infinity'::timestamptz) > now()
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
    join app.current_network_membership_states cnms on cnms.membership_id = nm.id
    where nm.member_id = app.current_actor_member_id()
      and nm.network_id = target_network_id
      and cnms.status = 'active'
      and (
        nm.role = 'owner'
        or app.membership_has_live_subscription(nm.id)
      )
  )
$$;

create or replace function app.actor_is_network_owner(target_network_id app.short_id)
returns boolean
language sql
stable
security definer
set search_path = app, pg_temp
as $$
  select exists (
    select 1
    from app.networks n
    where n.id = target_network_id
      and n.owner_member_id = app.current_actor_member_id()
      and n.archived_at is null
  )
$$;

create or replace view app.accessible_network_memberships as
select
  cnm.id,
  cnm.network_id,
  cnm.member_id,
  cnm.sponsor_member_id,
  cnm.role,
  cnm.status,
  cnm.joined_at,
  cnm.left_at,
  cnm.accepted_covenant_at,
  cnm.metadata
from app.current_network_memberships cnm
where cnm.status = 'active'
  and cnm.left_at is null
  and (
    cnm.role = 'owner'
    or app.membership_has_live_subscription(cnm.id)
  );

alter table app.network_memberships enable row level security;
alter table app.network_memberships force row level security;

drop policy if exists network_memberships_select_actor_scope on app.network_memberships;
create policy network_memberships_select_actor_scope on app.network_memberships
  for select
  using (
    member_id = app.current_actor_member_id()
    or app.current_actor_is_superadmin()
    or app.actor_is_network_owner(network_id)
    or app.actor_has_network_access(network_id)
  );

drop policy if exists network_memberships_insert_owner_scope on app.network_memberships;
create policy network_memberships_insert_owner_scope on app.network_memberships
  for insert
  with check (
    app.current_actor_is_superadmin()
    or app.actor_is_network_owner(network_id)
  );

drop policy if exists network_memberships_update_state_sync on app.network_memberships;
create policy network_memberships_update_state_sync on app.network_memberships
  for update
  using (
    coalesce(current_setting('app.allow_network_membership_state_sync', true), '') = '1'
    and pg_trigger_depth() > 0
  )
  with check (
    coalesce(current_setting('app.allow_network_membership_state_sync', true), '') = '1'
    and pg_trigger_depth() > 0
  );

drop policy if exists network_memberships_delete_none on app.network_memberships;
create policy network_memberships_delete_none on app.network_memberships
  for delete
  using (false);

alter table app.subscriptions enable row level security;
alter table app.subscriptions force row level security;

drop policy if exists subscriptions_select_actor_scope on app.subscriptions;
create policy subscriptions_select_actor_scope on app.subscriptions
  for select
  using (
    payer_member_id = app.current_actor_member_id()
    or app.current_actor_is_superadmin()
    or exists (
      select 1
      from app.network_memberships nm
      where nm.id = subscriptions.membership_id
        and nm.member_id = app.current_actor_member_id()
    )
  );

drop policy if exists subscriptions_insert_superadmin on app.subscriptions;
create policy subscriptions_insert_superadmin on app.subscriptions
  for insert
  with check (app.current_actor_is_superadmin());

drop policy if exists subscriptions_update_superadmin on app.subscriptions;
create policy subscriptions_update_superadmin on app.subscriptions
  for update
  using (app.current_actor_is_superadmin())
  with check (app.current_actor_is_superadmin());

drop policy if exists subscriptions_delete_none on app.subscriptions;
create policy subscriptions_delete_none on app.subscriptions
  for delete
  using (false);

comment on table app.network_memberships is
  'Protected source of membership identity and role. Read/write access is constrained by RLS; mutable state flows through network_membership_state_versions.';

comment on table app.subscriptions is
  'Protected source of paid-access facts. Runtime visibility is constrained by RLS; membership access helpers only consume live-subscription booleans.';

commit;
