#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must be set}"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
begin;

insert into app.members (public_name, handle)
values ('Smoke Owner', 'smoke-owner')
returning id as owner_id \gset

insert into app.members (public_name, handle)
values ('Smoke Member', 'smoke-member')
returning id as member_id \gset

insert into app.clubs (slug, name, owner_member_id, summary)
values ('smoke-club', 'Smoke Club', :'owner_id', 'Schema smoke test')
returning id as club_id \gset

insert into app.club_versions (club_id, owner_member_id, name, summary, admission_policy, version_no, created_by_member_id)
values (:'club_id', :'owner_id', 'Smoke Club', 'Schema smoke test', null, 1, :'owner_id');

insert into app.club_memberships (club_id, member_id, role, sponsor_member_id, accepted_covenant_at)
values (:'club_id', :'owner_id', 'clubadmin', null, now())
returning id as owner_membership_id \gset

insert into app.club_memberships (club_id, member_id, sponsor_member_id, accepted_covenant_at)
values (:'club_id', :'member_id', :'owner_id', now())
returning id as member_membership_id \gset

insert into app.club_membership_state_versions (membership_id, status, version_no, created_by_member_id)
values
  (:'owner_membership_id', 'active', 1, :'owner_id'),
  (:'member_membership_id', 'active', 1, :'owner_id');

insert into app.club_subscriptions (membership_id, payer_member_id, amount)
values (:'member_membership_id', :'owner_id', 25);

insert into app.member_profile_versions (member_id, version_no, display_name, what_i_do, known_for)
values (:'owner_id', 1, 'Smoke Owner', 'Builds the club', 'Stewardship');

insert into app.member_profile_versions (member_id, version_no, display_name, what_i_do, services_summary, website_url)
values (:'member_id', 1, 'Smoke Member', 'Facilitates circles', 'Mentoring and retreats', 'https://example.test')
returning id as profile_version_id \gset

insert into app.dm_threads (club_id, kind, created_by_member_id)
values (:'club_id', 'conversation', :'member_id')
returning id as thread_id \gset

insert into app.dm_messages (thread_id, sender_member_id, role, message_text)
values (:'thread_id', :'member_id', 'member', 'Please post that I am in Lisbon this week.')
returning id as message_id \gset

insert into app.entities (club_id, kind, author_member_id)
values (:'club_id', 'post', :'member_id')
returning id as post_entity_id \gset

insert into app.entity_versions (entity_id, version_no, title, body, expires_at, source_dm_thread_id, source_dm_message_id, created_by_member_id)
values (:'post_entity_id', 1, 'In Lisbon this week', 'Around for coffee, music, and mutual aid.', now() + interval '7 days', :'thread_id', :'message_id', :'member_id')
returning id as post_version_id \gset

insert into app.entities (club_id, kind, author_member_id, parent_entity_id)
values (:'club_id', 'comment', :'owner_id', :'post_entity_id')
returning id as comment_entity_id \gset

insert into app.entity_versions (entity_id, version_no, body, created_by_member_id)
values (:'comment_entity_id', 1, 'Welcome to Lisbon.', :'owner_id');

insert into app.entities (club_id, kind, author_member_id)
values (:'club_id', 'event', :'member_id')
returning id as event_entity_id \gset

insert into app.entity_versions (entity_id, version_no, title, body, starts_at, ends_at, timezone, recurrence_rule, capacity, created_by_member_id)
values (:'event_entity_id', 1, 'Friday dinner', 'Small dinner for nearby members', now() + interval '2 days', now() + interval '2 days 3 hours', 'Europe/Lisbon', 'FREQ=WEEKLY;COUNT=4', 8, :'member_id')
returning id as event_version_id \gset

insert into app.entities (club_id, kind, author_member_id)
values (:'club_id', 'complaint', :'owner_id')
returning id as complaint_entity_id \gset

insert into app.entity_versions (entity_id, version_no, title, body, created_by_member_id)
values (:'complaint_entity_id', 1, 'Noise concern', 'Complaint logged for review', :'owner_id');

insert into app.club_edges (club_id, kind, from_entity_id, to_entity_id, created_by_member_id, reason)
values (:'club_id', 'about', :'complaint_entity_id', :'post_entity_id', :'owner_id', 'Complaint refers to the Lisbon post');

insert into app.club_edges (club_id, kind, from_member_id, to_member_id, created_by_member_id, reason)
values (:'club_id', 'vouched_for', :'owner_id', :'member_id', :'owner_id', 'Trusts follow-through');

insert into app.event_rsvps (event_entity_id, membership_id, response, note)
values (:'event_entity_id', :'member_membership_id', 'yes', 'Looking forward to it');

insert into app.member_updates (
  recipient_member_id,
  club_id,
  topic,
  payload,
  entity_id,
  entity_version_id,
  created_by_member_id
)
values (
  :'member_id',
  :'club_id',
  'entity.version.published',
  jsonb_build_object('entityId', :'event_entity_id'),
  :'event_entity_id',
  :'event_version_id',
  :'owner_id'
);

select
  (select count(*) from app.current_member_profiles) as current_profiles,
  (select count(*) from app.current_entity_versions) as current_entity_versions,
  (select count(*) from app.current_published_entity_versions) as current_published_entity_versions,
  (select count(*) from app.live_entities) as live_entities,
  (select count(*) from app.active_club_memberships) as active_memberships,
  (select count(*) from app.pending_member_updates) as pending_member_updates;

rollback;
SQL
