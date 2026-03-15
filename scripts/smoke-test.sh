#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must be set}"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
begin;

insert into app.members (public_name, auth_subject, handle)
values ('Smoke Owner', 'auth|smoke-owner', 'smoke-owner')
returning id as owner_id \gset

insert into app.members (public_name, auth_subject, handle)
values ('Smoke Member', 'auth|smoke-member', 'smoke-member')
returning id as member_id \gset

insert into app.networks (slug, name, owner_member_id, summary)
values ('smoke-network', 'Smoke Network', :'owner_id', 'Schema smoke test')
returning id as network_id \gset

insert into app.network_memberships (network_id, member_id, role, sponsor_member_id, accepted_covenant_at)
values (:'network_id', :'owner_id', 'owner', null, now())
returning id as owner_membership_id \gset

insert into app.network_memberships (network_id, member_id, sponsor_member_id, accepted_covenant_at)
values (:'network_id', :'member_id', :'owner_id', now())
returning id as member_membership_id \gset

insert into app.network_membership_state_versions (membership_id, status, version_no, created_by_member_id)
values
  (:'owner_membership_id', 'active', 1, :'owner_id'),
  (:'member_membership_id', 'active', 1, :'owner_id');

insert into app.subscriptions (membership_id, payer_member_id, amount, currency)
values (:'member_membership_id', :'owner_id', 25, 'GBP');

insert into app.locations (city, region, country_code, country_name, timezone)
values ('Lisbon', 'Lisbon', 'PT', 'Portugal', 'Europe/Lisbon')
returning id as location_id \gset

insert into app.member_profile_versions (member_id, version_no, display_name, what_i_do, known_for)
values (:'owner_id', 1, 'Smoke Owner', 'Builds the network', 'Stewardship');

insert into app.member_profile_versions (member_id, version_no, display_name, what_i_do, services_summary, website_url)
values (:'member_id', 1, 'Smoke Member', 'Facilitates circles', 'Mentoring and retreats', 'https://example.test')
returning id as profile_version_id \gset

insert into app.member_locations (member_id, location_id, kind, is_primary)
values (:'member_id', :'location_id', 'current_city', true);

insert into app.transcript_threads (network_id, kind, created_by_member_id)
values (:'network_id', 'agent', :'member_id')
returning id as thread_id \gset

insert into app.transcript_messages (thread_id, sender_member_id, role, message_text)
values (:'thread_id', :'member_id', 'member', 'Please post that I am in Lisbon this week.')
returning id as message_id \gset

insert into app.entities (network_id, kind, author_member_id)
values (:'network_id', 'post', :'member_id')
returning id as post_entity_id \gset

insert into app.entity_versions (entity_id, version_no, title, body, expires_at, source_transcript_thread_id, source_transcript_message_id, created_by_member_id)
values (:'post_entity_id', 1, 'In Lisbon this week', 'Around for coffee, music, and mutual aid.', now() + interval '7 days', :'thread_id', :'message_id', :'member_id')
returning id as post_version_id \gset

insert into app.entities (network_id, kind, author_member_id, parent_entity_id)
values (:'network_id', 'comment', :'owner_id', :'post_entity_id')
returning id as comment_entity_id \gset

insert into app.entity_versions (entity_id, version_no, body, created_by_member_id)
values (:'comment_entity_id', 1, 'Welcome to Lisbon.', :'owner_id');

insert into app.entities (network_id, kind, author_member_id)
values (:'network_id', 'event', :'member_id')
returning id as event_entity_id \gset

insert into app.entity_versions (entity_id, version_no, title, body, starts_at, ends_at, timezone, recurrence_rule, capacity, created_by_member_id)
values (:'event_entity_id', 1, 'Friday dinner', 'Small dinner for nearby members', now() + interval '2 days', now() + interval '2 days 3 hours', 'Europe/Lisbon', 'FREQ=WEEKLY;COUNT=4', 8, :'member_id')
returning id as event_version_id \gset

insert into app.entity_locations (entity_version_id, location_id, location_role, label)
values (:'event_version_id', :'location_id', 'venue_city', 'Lisbon');

insert into app.entities (network_id, kind, author_member_id)
values (:'network_id', 'complaint', :'owner_id')
returning id as complaint_entity_id \gset

insert into app.entity_versions (entity_id, version_no, title, body, created_by_member_id)
values (:'complaint_entity_id', 1, 'Noise concern', 'Complaint logged for review', :'owner_id');

insert into app.edges (network_id, kind, from_entity_id, to_entity_id, created_by_member_id, reason)
values (:'network_id', 'about', :'complaint_entity_id', :'post_entity_id', :'owner_id', 'Complaint refers to the Lisbon post');

insert into app.edges (network_id, kind, from_member_id, to_member_id, created_by_member_id, reason)
values (:'network_id', 'vouched_for', :'owner_id', :'member_id', :'owner_id', 'Trusts follow-through');

insert into app.event_rsvps (event_entity_id, membership_id, response, note)
values (:'event_entity_id', :'member_membership_id', 'yes', 'Looking forward to it');

insert into app.media_links (owner_member_id, media_kind, storage_url, mime_type)
values (:'member_id', 'image', 's3://private-bucket/smoke/member.jpg', 'image/jpeg')
returning id as media_id \gset

insert into app.entity_media_links (entity_version_id, media_link_id, is_primary)
values (:'post_version_id', :'media_id', true);

insert into app.member_updates (
  recipient_member_id,
  network_id,
  topic,
  payload,
  entity_id,
  entity_version_id,
  created_by_member_id
)
values (
  :'member_id',
  :'network_id',
  'entity.version.published',
  jsonb_build_object('entityId', :'event_entity_id'),
  :'event_entity_id',
  :'event_version_id',
  :'owner_id'
);

insert into app.embeddings (member_profile_version_id, model, dimensions, embedding, source_text)
values (:'profile_version_id', 'smoke-model', 3, array[0.1, 0.2, 0.3]::double precision[], 'Smoke member profile');

insert into app.embeddings (entity_version_id, model, dimensions, embedding, source_text)
values (:'post_version_id', 'smoke-model', 3, array[0.4, 0.5, 0.6]::double precision[], 'Smoke post');

select
  (select count(*) from app.current_member_profiles) as current_profiles,
  (select count(*) from app.current_entity_versions) as current_entity_versions,
  (select count(*) from app.current_published_entity_versions) as current_published_entity_versions,
  (select count(*) from app.live_entities) as live_entities,
  (select count(*) from app.active_network_memberships) as active_memberships,
  (select count(*) from app.pending_member_updates) as pending_member_updates;

rollback;
SQL
