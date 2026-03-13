begin;

drop policy if exists deliveries_select_recipient_scope on app.deliveries;
create policy deliveries_select_recipient_scope on app.deliveries
  for select
  using (
    (
      recipient_member_id = app.current_actor_member_id()
      and app.actor_has_network_access(network_id)
    )
    or app.current_actor_is_superadmin()
    or app.actor_is_network_owner(network_id)
    or (
      coalesce(current_setting('app.delivery_worker_scope', true), '') = '1'
      and app.actor_has_network_access(network_id)
    )
  );

drop policy if exists deliveries_update_worker_scope on app.deliveries;
create policy deliveries_update_worker_scope on app.deliveries
  for update
  using (
    coalesce(current_setting('app.delivery_worker_scope', true), '') = '1'
    and app.actor_has_network_access(network_id)
  )
  with check (
    coalesce(current_setting('app.delivery_worker_scope', true), '') = '1'
    and app.actor_has_network_access(network_id)
  );

drop policy if exists delivery_acknowledgements_select_recipient_scope on app.delivery_acknowledgements;
create policy delivery_acknowledgements_select_recipient_scope on app.delivery_acknowledgements
  for select
  using (
    (
      recipient_member_id = app.current_actor_member_id()
      and app.actor_has_network_access(network_id)
    )
    or app.current_actor_is_superadmin()
    or app.actor_is_network_owner(network_id)
  );

commit;
