#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must be set}"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
begin;

insert into app.members (public_name, handle)
values
  ('Pressure Owner', 'pressure-owner'),
  ('Pressure Sponsor', 'pressure-sponsor'),
  ('Pressure Member', 'pressure-member'),
  ('Pressure Lapsed', 'pressure-lapsed')
returning id, handle;

select id from app.members where handle = 'pressure-owner' \gset
\set owner_id :id
select id from app.members where handle = 'pressure-sponsor' \gset
\set sponsor_id :id
select id from app.members where handle = 'pressure-member' \gset
\set member_id :id
select id from app.members where handle = 'pressure-lapsed' \gset
\set lapsed_id :id

insert into app.clubs (slug, name, owner_member_id, summary)
values ('pressure-club', 'Pressure Club', :'owner_id', 'Schema pressure test')
returning id as club_id \gset

insert into app.club_memberships (club_id, member_id, role, sponsor_member_id, accepted_covenant_at)
values
  (:'club_id', :'owner_id', 'owner', null, now()),
  (:'club_id', :'sponsor_id', 'member', :'owner_id', now()),
  (:'club_id', :'member_id', 'member', :'sponsor_id', now()),
  (:'club_id', :'lapsed_id', 'member', :'owner_id', now())
returning id, member_id;

select id from app.club_memberships where club_id = :'club_id' and member_id = :'member_id' \gset
\set member_membership_id :id
select id from app.club_memberships where club_id = :'club_id' and member_id = :'lapsed_id' \gset
\set lapsed_membership_id :id

insert into app.club_membership_state_versions (membership_id, status, version_no, created_by_member_id)
select id, 'active', 1, member_id
from app.club_memberships
where club_id = :'club_id';

insert into app.subscriptions (membership_id, payer_member_id, status, amount, current_period_end)
values
  (:'member_membership_id', :'sponsor_id', 'active', 0, now() + interval '14 days'),
  (:'lapsed_membership_id', :'owner_id', 'active', 0, now() - interval '1 day');

insert into app.entities (club_id, kind, author_member_id)
values (:'club_id', 'event', :'member_id')
returning id as event_entity_id \gset

insert into app.entity_versions (entity_id, version_no, title, starts_at, ends_at, timezone, created_by_member_id)
values (:'event_entity_id', 1, 'Pressure Dinner', now() + interval '2 days', now() + interval '2 days 2 hours', 'UTC', :'member_id');

insert into app.event_rsvps (event_entity_id, membership_id, version_no, response, note, created_by_member_id)
values (:'event_entity_id', :'member_membership_id', 1, 'maybe', 'Need to confirm', :'member_id')
returning id as rsvp_v1_id \gset

insert into app.event_rsvps (event_entity_id, membership_id, version_no, response, note, supersedes_rsvp_id, created_by_member_id)
values (:'event_entity_id', :'member_membership_id', 2, 'yes', 'Confirmed', :'rsvp_v1_id', :'member_id');

create or replace function pg_temp.assert_club_hardening(
  p_club_id app.short_id,
  p_event_entity_id app.short_id,
  p_membership_id app.short_id,
  p_owner_id app.short_id
)
returns void
language plpgsql
as $$
declare
  accessible_count integer;
  latest_rsvp app.rsvp_state;
begin
  select count(*)
  into accessible_count
  from app.accessible_club_memberships
  where club_id = p_club_id;

  if accessible_count <> 2 then
    raise exception 'expected 2 accessible memberships, got %', accessible_count;
  end if;

  select response
  into latest_rsvp
  from app.current_event_rsvps
  where event_entity_id = p_event_entity_id
    and membership_id = p_membership_id;

  if latest_rsvp <> 'yes' then
    raise exception 'expected latest RSVP to be yes, got %', latest_rsvp;
  end if;

  begin
    update app.club_memberships
    set sponsor_member_id = p_owner_id
    where id = p_membership_id;

    raise exception 'expected sponsor immutability update to fail';
  exception
    when others then
      if position('sponsor_member_id is immutable' in sqlerrm) = 0 then
        raise;
      end if;
  end;
end
$$;

select pg_temp.assert_club_hardening(:'club_id', :'event_entity_id', :'member_membership_id', :'owner_id');

select
  (select count(*) from app.accessible_club_memberships where club_id = :'club_id') as accessible_memberships,
  (select response from app.current_event_rsvps where event_entity_id = :'event_entity_id' and membership_id = :'member_membership_id') as latest_rsvp;

rollback;
SQL
