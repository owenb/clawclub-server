begin;

drop policy if exists entities_update_archive_sync on app.entities;
create policy entities_update_archive_sync on app.entities
  for update
  using (
    coalesce(current_setting('app.allow_entity_archive_sync', true), '') = '1'
    and pg_trigger_depth() > 0
  )
  with check (
    deleted_at is null
    and coalesce(current_setting('app.allow_entity_archive_sync', true), '') = '1'
    and pg_trigger_depth() > 0
  );

commit;
