#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must be set}"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
begin;

insert into members (public_name, display_name)
values ('Smoke Owner', 'Smoke Owner')
returning id as owner_id \gset

insert into members (public_name, display_name)
values ('Smoke Member', 'Smoke Member')
returning id as member_id \gset

insert into clubs (slug, name, owner_member_id, summary)
values ('smoke-club', 'Smoke Club', :'owner_id', 'Schema smoke test')
returning id as club_id \gset

insert into club_versions (club_id, owner_member_id, name, summary, admission_policy, version_no, created_by_member_id)
values (:'club_id', :'owner_id', 'Smoke Club', 'Schema smoke test', null, 1, :'owner_id');

insert into club_memberships (club_id, member_id, role, sponsor_member_id, status, joined_at, accepted_covenant_at)
values (:'club_id', :'owner_id', 'clubadmin', null, 'active', now(), now())
returning id as owner_membership_id \gset

insert into club_memberships (club_id, member_id, sponsor_member_id, status, joined_at, accepted_covenant_at)
values (:'club_id', :'member_id', :'owner_id', 'active', now(), now())
returning id as member_membership_id \gset

insert into club_membership_state_versions (membership_id, status, version_no, created_by_member_id)
values
  (:'owner_membership_id', 'active', 1, :'owner_id'),
  (:'member_membership_id', 'active', 1, :'owner_id');

insert into club_subscriptions (membership_id, payer_member_id, amount)
values (:'member_membership_id', :'owner_id', 25);

insert into member_club_profile_versions (membership_id, member_id, club_id, version_no, what_i_do, known_for, created_by_member_id, generation_source)
values (:'owner_membership_id', :'owner_id', :'club_id', 1, 'Builds the club', 'Stewardship', :'owner_id', 'membership_seed');

insert into member_club_profile_versions (membership_id, member_id, club_id, version_no, what_i_do, services_summary, website_url, created_by_member_id, generation_source)
values (:'member_membership_id', :'member_id', :'club_id', 1, 'Facilitates circles', 'Mentoring and retreats', 'https://example.test', :'member_id', 'membership_seed')
returning id as profile_version_id \gset

insert into content_threads (club_id, created_by_member_id)
values (:'club_id', :'member_id')
returning id as post_thread_id \gset

insert into contents (club_id, kind, author_member_id, thread_id)
values (:'club_id', 'post', :'member_id', :'post_thread_id')
returning id as post_content_id \gset

insert into content_versions (content_id, version_no, title, body, expires_at, created_by_member_id)
values (:'post_content_id', 1, 'In Lisbon this week', 'Around for coffee, music, and mutual aid.', now() + interval '7 days', :'member_id')
returning id as post_version_id \gset

insert into content_threads (club_id, created_by_member_id)
values (:'club_id', :'member_id')
returning id as event_thread_id \gset

insert into contents (club_id, kind, author_member_id, thread_id)
values (:'club_id', 'event', :'member_id', :'event_thread_id')
returning id as event_content_id \gset

insert into content_versions (content_id, version_no, title, body, created_by_member_id)
values (:'event_content_id', 1, 'Friday dinner', 'Small dinner for nearby members', :'member_id')
returning id as event_content_version_id \gset

insert into event_version_details (content_version_id, location, starts_at, ends_at, timezone, recurrence_rule, capacity)
values (:'event_content_version_id', 'Downtown', now() + interval '2 days', now() + interval '2 days 3 hours', 'Europe/Lisbon', 'FREQ=WEEKLY;COUNT=4', 8);

insert into content_threads (club_id, created_by_member_id)
values (:'club_id', :'owner_id')
returning id as report_thread_id \gset

insert into contents (club_id, kind, author_member_id, thread_id)
values (:'club_id', 'post', :'owner_id', :'report_thread_id')
returning id as report_content_id \gset

insert into content_versions (content_id, version_no, title, body, created_by_member_id)
values (:'report_content_id', 1, 'Noise concern', 'Follow-up note linked to the Lisbon post', :'owner_id');

insert into club_edges (club_id, kind, from_content_id, to_content_id, created_by_member_id, reason)
values (:'club_id', 'about', :'report_content_id', :'post_content_id', :'owner_id', 'Follow-up refers to the Lisbon post');

insert into club_edges (club_id, kind, from_member_id, to_member_id, created_by_member_id, reason)
values (:'club_id', 'vouched_for', :'owner_id', :'member_id', :'owner_id', 'Trusts follow-through');

insert into event_rsvps (event_content_id, membership_id, response, note)
values (:'event_content_id', :'member_membership_id', 'yes', 'Looking forward to it');

insert into member_notifications (
  recipient_member_id,
  club_id,
  topic,
  payload,
  content_id
)
values (
  :'member_id',
  :'club_id',
  'content.version.published',
  jsonb_build_object('contentId', :'event_content_id'),
  :'event_content_id'
);

select
  (select count(*) from current_member_club_profiles) as current_profiles,
  (select count(*) from current_content_versions) as current_content_versions,
  (select count(*) from published_content_versions) as published_content_versions,
  (select count(*) from live_content) as live_content,
  (select count(*) from active_club_memberships) as active_memberships,
  (select count(*) from member_notifications where acknowledged_state is null) as pending_notifications;

rollback;
SQL
