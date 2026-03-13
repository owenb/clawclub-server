begin;

drop policy if exists delivery_endpoints_select_actor_scope on app.delivery_endpoints;
create policy delivery_endpoints_select_actor_scope on app.delivery_endpoints
  for select
  using (
    member_id = app.current_actor_member_id()
    or (
      coalesce(current_setting('app.delivery_worker_scope', true), '') = '1'
      and exists (
        select 1
        from app.deliveries d
        where d.endpoint_id = delivery_endpoints.id
          and app.actor_has_network_access(d.network_id)
      )
    )
  );

drop policy if exists delivery_endpoints_update_actor_scope on app.delivery_endpoints;
create policy delivery_endpoints_update_actor_scope on app.delivery_endpoints
  for update
  using (
    member_id = app.current_actor_member_id()
    or (
      coalesce(current_setting('app.delivery_worker_scope', true), '') = '1'
      and exists (
        select 1
        from app.deliveries d
        where d.endpoint_id = delivery_endpoints.id
          and app.actor_has_network_access(d.network_id)
      )
    )
  )
  with check (
    member_id = app.current_actor_member_id()
    or (
      coalesce(current_setting('app.delivery_worker_scope', true), '') = '1'
      and exists (
        select 1
        from app.deliveries d
        where d.endpoint_id = delivery_endpoints.id
          and app.actor_has_network_access(d.network_id)
      )
    )
  );

drop policy if exists delivery_attempts_select_actor_scope on app.delivery_attempts;
create policy delivery_attempts_select_actor_scope on app.delivery_attempts
  for select
  using (
    app.current_actor_is_superadmin()
    or app.actor_is_network_owner(network_id)
    or (
      coalesce(current_setting('app.delivery_worker_scope', true), '') = '1'
      and created_by_member_id = app.current_actor_member_id()
    )
  );

drop policy if exists delivery_attempts_insert_actor_scope on app.delivery_attempts;
create policy delivery_attempts_insert_actor_scope on app.delivery_attempts
  for insert
  with check (
    coalesce(current_setting('app.delivery_worker_scope', true), '') = '1'
    and created_by_member_id = app.current_actor_member_id()
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
    coalesce(current_setting('app.delivery_worker_scope', true), '') = '1'
    and created_by_member_id = app.current_actor_member_id()
    and app.actor_has_network_access(network_id)
  )
  with check (
    coalesce(current_setting('app.delivery_worker_scope', true), '') = '1'
    and created_by_member_id = app.current_actor_member_id()
    and app.actor_has_network_access(network_id)
  );

commit;
