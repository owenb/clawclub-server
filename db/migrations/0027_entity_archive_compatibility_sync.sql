begin;

drop policy if exists entities_update_author_scope on app.entities;

create or replace function app.lock_entity_archive_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op <> 'UPDATE' then
    return new;
  end if;

  if new.archived_at is distinct from old.archived_at
     and coalesce(current_setting('app.allow_entity_archive_sync', true), '') <> '1' then
    raise exception 'entities.archived_at must change via entity_versions';
  end if;

  return new;
end;
$$;

drop trigger if exists entities_archive_lock on app.entities;
create trigger entities_archive_lock
before update of archived_at on app.entities
for each row execute function app.lock_entity_archive_mutation();

create or replace function app.sync_entity_archive_compatibility_state()
returns trigger
language plpgsql
as $$
declare
  mirrored_archived_at timestamptz;
begin
  if new.state <> 'archived' then
    return new;
  end if;

  mirrored_archived_at := coalesce(new.effective_at, new.created_at);

  perform set_config('app.allow_entity_archive_sync', '1', true);

  update app.entities e
     set archived_at = coalesce(e.archived_at, mirrored_archived_at)
   where e.id = new.entity_id
     and e.archived_at is distinct from coalesce(e.archived_at, mirrored_archived_at);

  perform set_config('app.allow_entity_archive_sync', '', true);
  return new;
exception
  when others then
    perform set_config('app.allow_entity_archive_sync', '', true);
    raise;
end;
$$;

select set_config('app.allow_entity_archive_sync', '1', true);

update app.entities e
   set archived_at = coalesce(e.archived_at, cev.effective_at)
  from app.current_entity_versions cev
 where cev.entity_id = e.id
   and cev.state = 'archived'
   and e.archived_at is distinct from coalesce(e.archived_at, cev.effective_at);

select set_config('app.allow_entity_archive_sync', '', true);

drop trigger if exists entity_versions_archive_sync on app.entity_versions;
create trigger entity_versions_archive_sync
after insert on app.entity_versions
for each row execute function app.sync_entity_archive_compatibility_state();

comment on column app.entities.archived_at is
  'Compatibility mirror of the latest archived entity version timestamp. Write through entity_versions only.';

commit;
