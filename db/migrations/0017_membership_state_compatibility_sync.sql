begin;

create or replace function app.lock_network_membership_mutation()
returns trigger
language plpgsql
as $$
begin
  if current_setting('app.allow_network_membership_state_sync', true) = '1' then
    return new;
  end if;

  if new.network_id is distinct from old.network_id then
    raise exception 'network_memberships.network_id is immutable';
  end if;

  if new.member_id is distinct from old.member_id then
    raise exception 'network_memberships.member_id is immutable';
  end if;

  if new.sponsor_member_id is distinct from old.sponsor_member_id then
    raise exception 'network_memberships.sponsor_member_id is immutable';
  end if;

  if new.joined_at is distinct from old.joined_at then
    raise exception 'network_memberships.joined_at is immutable';
  end if;

  if new.status is distinct from old.status then
    raise exception 'network_memberships.status must change via network_membership_state_versions';
  end if;

  if new.left_at is distinct from old.left_at then
    raise exception 'network_memberships.left_at must change via network_membership_state_versions';
  end if;

  return new;
end;
$$;

create or replace function app.sync_network_membership_compatibility_state()
returns trigger
language plpgsql
as $$
declare
  mirrored_left_at timestamptz;
begin
  mirrored_left_at := case
    when new.status in ('revoked', 'rejected') then new.created_at
    else null
  end;

  perform set_config('app.allow_network_membership_state_sync', '1', true);

  update app.network_memberships nm
  set status = new.status,
      left_at = mirrored_left_at
  where nm.id = new.membership_id;

  perform set_config('app.allow_network_membership_state_sync', '', true);
  return new;
exception
  when others then
    perform set_config('app.allow_network_membership_state_sync', '', true);
    raise;
end;
$$;

update app.network_memberships nm
set status = cnms.status,
    left_at = case
      when cnms.status in ('revoked', 'rejected') then cnms.created_at
      else null
    end
from app.current_network_membership_states cnms
where cnms.membership_id = nm.id
  and (
    nm.status is distinct from cnms.status
    or nm.left_at is distinct from case
      when cnms.status in ('revoked', 'rejected') then cnms.created_at
      else null
    end
  );

drop trigger if exists network_membership_state_versions_sync on app.network_membership_state_versions;
create trigger network_membership_state_versions_sync
after insert on app.network_membership_state_versions
for each row
execute function app.sync_network_membership_compatibility_state();

comment on column app.network_memberships.status is
  'Compatibility mirror of the latest app.network_membership_state_versions.status. Write through the state history table only.';

comment on column app.network_memberships.left_at is
  'Compatibility mirror of the latest terminal membership state timestamp. Write through the state history table only.';

commit;
