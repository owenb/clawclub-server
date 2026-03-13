begin;

create or replace view app.accessible_network_memberships as
select
  nm.id,
  nm.network_id,
  nm.member_id,
  nm.sponsor_member_id,
  nm.role,
  nm.status,
  nm.joined_at,
  nm.left_at,
  nm.accepted_covenant_at,
  nm.metadata
from app.network_memberships nm
where nm.status = 'active'
  and nm.left_at is null
  and (
    nm.role = 'owner'
    or exists (
      select 1
      from app.live_subscriptions ls
      where ls.membership_id = nm.id
    )
  );

create or replace function app.actor_is_network_owner(target_network_id app.short_id)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from app.network_memberships nm
    where nm.member_id = app.current_actor_member_id()
      and nm.network_id = target_network_id
      and nm.role = 'owner'
      and nm.status = 'active'
      and nm.left_at is null
  )
$$;

create or replace function app.authenticate_member_bearer_token(target_token_id app.short_id, target_token_hash text)
returns table(member_id app.short_id)
language plpgsql
security definer
set search_path = app, pg_temp
as $$
begin
  perform set_config('app.allow_member_bearer_token_auth', '1', true);

  return query
    update app.member_bearer_tokens mbt
       set last_used_at = now()
     where mbt.id = target_token_id
       and mbt.token_hash = target_token_hash
       and mbt.revoked_at is null
    returning mbt.member_id;

  perform set_config('app.allow_member_bearer_token_auth', '', true);
exception
  when others then
    perform set_config('app.allow_member_bearer_token_auth', '', true);
    raise;
end;
$$;

create or replace function app.authenticate_delivery_worker_token(target_token_id app.short_id, target_token_hash text)
returns table(
  token_id app.short_id,
  actor_member_id app.short_id,
  label text,
  allowed_network_ids app.short_id[],
  metadata jsonb
)
language plpgsql
security definer
set search_path = app, pg_temp
as $$
begin
  perform set_config('app.allow_delivery_worker_token_auth', '1', true);

  return query
    update app.delivery_worker_tokens dwt
       set last_used_at = now()
     where dwt.id = target_token_id
       and dwt.token_hash = target_token_hash
       and dwt.revoked_at is null
    returning
      dwt.id,
      dwt.actor_member_id,
      dwt.label,
      dwt.allowed_network_ids,
      dwt.metadata;

  perform set_config('app.allow_delivery_worker_token_auth', '', true);
exception
  when others then
    perform set_config('app.allow_delivery_worker_token_auth', '', true);
    raise;
end;
$$;

alter table app.delivery_endpoints enable row level security;
alter table app.delivery_endpoints force row level security;

drop policy if exists delivery_endpoints_select_actor_scope on app.delivery_endpoints;
create policy delivery_endpoints_select_actor_scope on app.delivery_endpoints
  for select
  using (
    member_id = app.current_actor_member_id()
    or exists (
      select 1
      from app.deliveries d
      where d.endpoint_id = delivery_endpoints.id
        and app.actor_has_network_access(d.network_id)
    )
  );

drop policy if exists delivery_endpoints_insert_self on app.delivery_endpoints;
create policy delivery_endpoints_insert_self on app.delivery_endpoints
  for insert
  with check (member_id = app.current_actor_member_id());

drop policy if exists delivery_endpoints_update_actor_scope on app.delivery_endpoints;
create policy delivery_endpoints_update_actor_scope on app.delivery_endpoints
  for update
  using (
    member_id = app.current_actor_member_id()
    or exists (
      select 1
      from app.deliveries d
      where d.endpoint_id = delivery_endpoints.id
        and app.actor_has_network_access(d.network_id)
    )
  )
  with check (
    member_id = app.current_actor_member_id()
    or exists (
      select 1
      from app.deliveries d
      where d.endpoint_id = delivery_endpoints.id
        and app.actor_has_network_access(d.network_id)
    )
  );

alter table app.delivery_attempts enable row level security;
alter table app.delivery_attempts force row level security;

drop policy if exists delivery_attempts_select_actor_scope on app.delivery_attempts;
create policy delivery_attempts_select_actor_scope on app.delivery_attempts
  for select
  using (
    created_by_member_id = app.current_actor_member_id()
    or app.current_actor_is_superadmin()
    or app.actor_is_network_owner(network_id)
  );

drop policy if exists delivery_attempts_insert_actor_scope on app.delivery_attempts;
create policy delivery_attempts_insert_actor_scope on app.delivery_attempts
  for insert
  with check (
    created_by_member_id = app.current_actor_member_id()
    and app.actor_has_network_access(network_id)
    and exists (
      select 1
      from app.deliveries d
      where d.id = delivery_attempts.delivery_id
        and d.network_id = delivery_attempts.network_id
        and d.endpoint_id = delivery_attempts.endpoint_id
    )
  );

drop policy if exists delivery_attempts_update_actor_scope on app.delivery_attempts;
create policy delivery_attempts_update_actor_scope on app.delivery_attempts
  for update
  using (
    created_by_member_id = app.current_actor_member_id()
    and app.actor_has_network_access(network_id)
  )
  with check (
    created_by_member_id = app.current_actor_member_id()
    and app.actor_has_network_access(network_id)
  );

alter table app.member_bearer_tokens enable row level security;
alter table app.member_bearer_tokens force row level security;

drop policy if exists member_bearer_tokens_select_self on app.member_bearer_tokens;
create policy member_bearer_tokens_select_self on app.member_bearer_tokens
  for select
  using (member_id = app.current_actor_member_id());

drop policy if exists member_bearer_tokens_insert_self on app.member_bearer_tokens;
create policy member_bearer_tokens_insert_self on app.member_bearer_tokens
  for insert
  with check (member_id = app.current_actor_member_id());

drop policy if exists member_bearer_tokens_update_actor_scope on app.member_bearer_tokens;
create policy member_bearer_tokens_update_actor_scope on app.member_bearer_tokens
  for update
  using (
    member_id = app.current_actor_member_id()
    or coalesce(current_setting('app.allow_member_bearer_token_auth', true), '') = '1'
  )
  with check (
    member_id = app.current_actor_member_id()
    or coalesce(current_setting('app.allow_member_bearer_token_auth', true), '') = '1'
  );

alter table app.delivery_worker_tokens enable row level security;
alter table app.delivery_worker_tokens force row level security;

drop policy if exists delivery_worker_tokens_select_self on app.delivery_worker_tokens;
create policy delivery_worker_tokens_select_self on app.delivery_worker_tokens
  for select
  using (actor_member_id = app.current_actor_member_id());

drop policy if exists delivery_worker_tokens_update_actor_scope on app.delivery_worker_tokens;
create policy delivery_worker_tokens_update_actor_scope on app.delivery_worker_tokens
  for update
  using (
    actor_member_id = app.current_actor_member_id()
    or coalesce(current_setting('app.allow_delivery_worker_token_auth', true), '') = '1'
  )
  with check (
    actor_member_id = app.current_actor_member_id()
    or coalesce(current_setting('app.allow_delivery_worker_token_auth', true), '') = '1'
  );

alter table app.member_global_role_versions enable row level security;
alter table app.member_global_role_versions force row level security;

drop policy if exists member_global_role_versions_select_self on app.member_global_role_versions;
create policy member_global_role_versions_select_self on app.member_global_role_versions
  for select
  using (member_id = app.current_actor_member_id());

alter table app.network_owner_versions enable row level security;
alter table app.network_owner_versions force row level security;

drop policy if exists network_owner_versions_select_actor_scope on app.network_owner_versions;
create policy network_owner_versions_select_actor_scope on app.network_owner_versions
  for select
  using (
    app.current_actor_is_superadmin()
    or app.actor_has_network_access(network_id)
  );

drop policy if exists network_owner_versions_insert_superadmin on app.network_owner_versions;
create policy network_owner_versions_insert_superadmin on app.network_owner_versions
  for insert
  with check (
    app.current_actor_is_superadmin()
    and created_by_member_id = app.current_actor_member_id()
    and app.member_is_active(owner_member_id)
  );

alter table app.network_membership_state_versions enable row level security;
alter table app.network_membership_state_versions force row level security;

drop policy if exists network_membership_state_versions_select_actor_scope on app.network_membership_state_versions;
create policy network_membership_state_versions_select_actor_scope on app.network_membership_state_versions
  for select
  using (
    exists (
      select 1
      from app.network_memberships nm
      where nm.id = network_membership_state_versions.membership_id
        and (
          nm.member_id = app.current_actor_member_id()
          or app.current_actor_is_superadmin()
          or app.actor_has_network_access(nm.network_id)
        )
    )
  );

drop policy if exists network_membership_state_versions_insert_owner_scope on app.network_membership_state_versions;
create policy network_membership_state_versions_insert_owner_scope on app.network_membership_state_versions
  for insert
  with check (
    created_by_member_id = app.current_actor_member_id()
    and exists (
      select 1
      from app.network_memberships nm
      where nm.id = network_membership_state_versions.membership_id
        and (
          app.current_actor_is_superadmin()
          or app.actor_is_network_owner(nm.network_id)
        )
    )
  );

alter table app.edges enable row level security;
alter table app.edges force row level security;

drop policy if exists edges_select_accessible on app.edges;
create policy edges_select_accessible on app.edges
  for select
  using (
    archived_at is null
    and app.actor_has_network_access(network_id)
  );

drop policy if exists edges_insert_author_scope on app.edges;
create policy edges_insert_author_scope on app.edges
  for insert
  with check (
    archived_at is null
    and from_member_id = app.current_actor_member_id()
    and created_by_member_id = app.current_actor_member_id()
    and app.actor_has_network_access(network_id)
  );

commit;
