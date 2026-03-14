begin;

drop trigger if exists entity_versions_archive_sync on app.entity_versions;
drop trigger if exists entities_archive_lock on app.entities;
drop function if exists app.sync_entity_archive_compatibility_state();
drop function if exists app.lock_entity_archive_mutation();
drop policy if exists entities_update_archive_sync on app.entities;

create or replace view app.current_published_entity_versions as
select
  id,
  entity_id,
  version_no,
  state,
  title,
  summary,
  body,
  work_mode,
  compensation,
  starts_at,
  ends_at,
  timezone,
  recurrence_rule,
  capacity,
  effective_at,
  expires_at,
  content,
  source_transcript_thread_id,
  source_transcript_message_id,
  supersedes_version_id,
  created_at,
  created_by_member_id
from app.current_entity_versions
where state = 'published';

create or replace view app.live_entities as
select
  e.id as entity_id,
  e.network_id,
  e.kind,
  e.author_member_id,
  e.parent_entity_id,
  e.created_at as entity_created_at,
  cev.id as entity_version_id,
  cev.version_no,
  cev.state,
  cev.title,
  cev.summary,
  cev.body,
  cev.work_mode,
  cev.compensation,
  cev.starts_at,
  cev.ends_at,
  cev.timezone,
  cev.recurrence_rule,
  cev.capacity,
  cev.effective_at,
  cev.expires_at,
  cev.content,
  cev.created_at as version_created_at,
  cev.created_by_member_id
from app.entities e
join app.current_published_entity_versions cev on cev.entity_id = e.id
where e.deleted_at is null
  and (cev.expires_at is null or cev.expires_at > now());

drop policy if exists entities_select_accessible on app.entities;
create policy entities_select_accessible on app.entities
  for select
  using (
    deleted_at is null
    and app.actor_has_network_access(network_id)
    and exists (
      select 1
      from app.current_entity_versions cev
      where cev.entity_id = id
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
      where e.id = entity_id
        and e.deleted_at is null
        and cev.state = 'published'
        and app.actor_has_network_access(e.network_id)
    )
  );

comment on column app.entities.archived_at is
  'Legacy compatibility column. Runtime archive visibility now derives from the latest entity_versions.state.';

commit;
