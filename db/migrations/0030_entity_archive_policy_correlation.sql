begin;

drop policy if exists entities_select_accessible on app.entities;
create policy entities_select_accessible on app.entities
  for select
  using (
    deleted_at is null
    and app.actor_has_network_access(network_id)
    and exists (
      select 1
      from app.current_entity_versions cev
      where cev.entity_id = entities.id
        and cev.state = 'published'
    )
  );

drop policy if exists entity_versions_select_accessible on app.entity_versions;
create policy entity_versions_select_accessible on app.entity_versions
  for select
  using (
    exists (
      select 1
      from app.entities e
      join app.current_entity_versions cev on cev.entity_id = e.id
      where e.id = entity_versions.entity_id
        and e.deleted_at is null
        and cev.state = 'published'
        and app.actor_has_network_access(e.network_id)
    )
  );

commit;
