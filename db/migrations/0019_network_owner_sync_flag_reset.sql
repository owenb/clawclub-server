begin;

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

  perform set_config('app.allow_network_owner_sync', '', true);
  return new;
exception
  when others then
    perform set_config('app.allow_network_owner_sync', '', true);
    raise;
end;
$$;

commit;
