-- Allow entity authors to see their own entities and versions.
-- Without this, INSERT ... RETURNING fails because the SELECT policies require
-- entity_is_currently_published(), which is false until the version row is created.

create policy entities_select_author
  on app.entities
  for select
  using (
    deleted_at is null
    and author_member_id = app.current_actor_member_id()
  );

create policy entity_versions_select_author
  on app.entity_versions
  for select
  using (
    exists (
      select 1 from app.entities e
      where e.id = entity_versions.entity_id
        and e.deleted_at is null
        and e.author_member_id = app.current_actor_member_id()
    )
  );
