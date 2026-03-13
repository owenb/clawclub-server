begin;

create or replace function app.lock_network_owner_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op <> 'UPDATE' then
    return new;
  end if;

  if new.owner_member_id is distinct from old.owner_member_id
     and coalesce(current_setting('app.allow_network_owner_sync', true), '') <> '1' then
    raise exception 'networks.owner_member_id must change via network_owner_versions';
  end if;

  return new;
end;
$$;

drop trigger if exists networks_owner_member_lock on app.networks;
create trigger networks_owner_member_lock
before update of owner_member_id on app.networks
for each row execute function app.lock_network_owner_mutation();

create or replace function app.sync_network_owner_compatibility_state()
returns trigger
language plpgsql
as $$
begin
  perform set_config('app.allow_network_owner_sync', '1', true);

  update app.networks n
     set owner_member_id = new.owner_member_id
   where n.id = new.network_id
     and n.owner_member_id is distinct from new.owner_member_id;

  return new;
end;
$$;

select set_config('app.allow_network_owner_sync', '1', true);

update app.networks n
   set owner_member_id = cno.owner_member_id
  from app.current_network_owners cno
 where cno.network_id = n.id
   and n.owner_member_id is distinct from cno.owner_member_id;

select set_config('app.allow_network_owner_sync', '', true);

drop trigger if exists network_owner_versions_sync on app.network_owner_versions;
create trigger network_owner_versions_sync
after insert on app.network_owner_versions
for each row execute function app.sync_network_owner_compatibility_state();

comment on column app.networks.owner_member_id is
  'Compatibility mirror of the latest app.network_owner_versions.owner_member_id. Write through the owner history table only.';

commit;
