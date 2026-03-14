begin;

drop policy if exists entities_update_author_scope on app.entities;
create policy entities_update_author_scope on app.entities
  for update
  using (
    archived_at is null
    and deleted_at is null
    and author_member_id = app.current_actor_member_id()
    and app.actor_has_network_access(network_id)
  )
  with check (
    deleted_at is null
    and author_member_id = app.current_actor_member_id()
    and app.actor_has_network_access(network_id)
  );

commit;
