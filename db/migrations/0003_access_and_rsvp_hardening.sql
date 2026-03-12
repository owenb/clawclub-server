begin;

create or replace function app.lock_network_membership_identity()
returns trigger
language plpgsql
as $$
begin
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

  return new;
end;
$$;

drop trigger if exists network_memberships_identity_guard on app.network_memberships;
create trigger network_memberships_identity_guard
before update on app.network_memberships
for each row
execute function app.lock_network_membership_identity();

alter table app.event_rsvps
  add column if not exists version_no integer,
  add column if not exists supersedes_rsvp_id app.short_id references app.event_rsvps(id),
  add column if not exists created_by_member_id app.short_id references app.members(id);

update app.event_rsvps
set version_no = 1
where version_no is null;

alter table app.event_rsvps
  alter column version_no set default 1,
  alter column version_no set not null;

alter table app.event_rsvps
  drop constraint if exists event_rsvps_event_entity_id_membership_id_key;

alter table app.event_rsvps
  add constraint event_rsvps_event_membership_version_key
  unique (event_entity_id, membership_id, version_no);

create index if not exists event_rsvps_event_membership_version_idx
  on app.event_rsvps (event_entity_id, membership_id, version_no desc, created_at desc);

create or replace view app.current_event_rsvps as
select distinct on (event_entity_id, membership_id)
  id,
  event_entity_id,
  membership_id,
  version_no,
  response,
  note,
  supersedes_rsvp_id,
  source_transcript_message_id,
  created_at,
  created_by_member_id
from app.event_rsvps
order by event_entity_id, membership_id, version_no desc, created_at desc;

create or replace view app.live_subscriptions as
select *
from app.subscriptions
where status in ('trialing', 'active')
  and coalesce(ended_at, 'infinity'::timestamptz) > now()
  and coalesce(current_period_end, 'infinity'::timestamptz) > now();

create or replace view app.accessible_network_memberships as
select nm.*
from app.active_network_memberships nm
where nm.role = 'owner'
   or exists (
     select 1
     from app.live_subscriptions ls
     where ls.membership_id = nm.id
   );

commit;
