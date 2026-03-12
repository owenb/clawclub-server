#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must be set}"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
begin;

insert into app.members (public_name, auth_subject, handle, metadata)
values (
  'Owen Barnes',
  'auth|owen-barnes',
  'owen-barnes',
  jsonb_build_object('seed', 'consciousclaw')
)
on conflict (handle) do update
set
  public_name = excluded.public_name,
  auth_subject = excluded.auth_subject,
  metadata = app.members.metadata || excluded.metadata;

select id from app.members where handle = 'owen-barnes' \gset

insert into app.networks (slug, name, owner_member_id, summary, manifesto_markdown, config)
values (
  'consciousclaw',
  'ConsciousClaw',
  :'id',
  'Private relational network for spiritually aligned builders, friends, collaborators, and real-world connection.',
  'ConsciousClaw is a private members network for aligned people who want real relationship, collaboration, service, and grounded shared reality. It is not public social media and not a dating app. It is a trust-based field for meaningful connection.',
  jsonb_build_object('seed', 'consciousclaw')
)
on conflict (slug) do update
set
  name = excluded.name,
  owner_member_id = excluded.owner_member_id,
  summary = excluded.summary,
  manifesto_markdown = excluded.manifesto_markdown,
  config = app.networks.config || excluded.config;

select id as network_id from app.networks where slug = 'consciousclaw' \gset
select id as owner_member_id from app.members where handle = 'owen-barnes' \gset

insert into app.network_memberships (network_id, member_id, role, sponsor_member_id, accepted_covenant_at, metadata)
values (
  :'network_id',
  :'owner_member_id',
  'owner',
  null,
  now(),
  jsonb_build_object('seed', 'consciousclaw')
)
on conflict (network_id, member_id) do update
set
  role = excluded.role,
  status = 'active',
  accepted_covenant_at = coalesce(app.network_memberships.accepted_covenant_at, excluded.accepted_covenant_at),
  metadata = app.network_memberships.metadata || excluded.metadata;

with current_version as (
  select coalesce(max(version_no), 0) as version_no
  from app.member_profile_versions
  where member_id = :'owner_member_id'
), latest as (
  select *
  from app.current_member_profiles
  where member_id = :'owner_member_id'
)
insert into app.member_profile_versions (
  member_id,
  version_no,
  display_name,
  tagline,
  summary,
  what_i_do,
  known_for,
  services_summary,
  website_url,
  links,
  profile,
  created_by_member_id
)
select
  :'owner_member_id',
  current_version.version_no + 1,
  'Owen',
  'Conscious engineer building a private members network for aligned humans.',
  'Builder, steward, and spiritually grounded technologist focused on helping aligned people find each other for friendship, collaboration, service, gatherings, and real-world connection.',
  'Designs and builds software systems, relational infrastructure, and agent-native tools that support trust, resonance, and practical coordination.',
  'Clear thinking, system design, spiritual framing, and bringing the right people into meaningful relationship.',
  'Product and backend architecture, systems thinking, and strategic collaboration for mission-aligned projects.',
  'https://conscious.engineer',
  jsonb_build_array(
    jsonb_build_object('label', 'Website', 'url', 'https://conscious.engineer')
  ),
  jsonb_build_object(
    'seed', 'consciousclaw',
    'homeBase', 'United Kingdom',
    'identity', 'master of limitation',
    'interests', jsonb_build_array('conscious technology', 'friendship', 'collaboration', 'service', 'real-world meetups')
  ),
  :'owner_member_id'
from current_version
where not exists (
  select 1
  from latest
  where latest.display_name = 'Owen'
    and latest.tagline = 'Conscious engineer building a private members network for aligned humans.'
    and latest.summary = 'Builder, steward, and spiritually grounded technologist focused on helping aligned people find each other for friendship, collaboration, service, gatherings, and real-world connection.'
    and latest.what_i_do = 'Designs and builds software systems, relational infrastructure, and agent-native tools that support trust, resonance, and practical coordination.'
    and latest.known_for = 'Clear thinking, system design, spiritual framing, and bringing the right people into meaningful relationship.'
    and latest.services_summary = 'Product and backend architecture, systems thinking, and strategic collaboration for mission-aligned projects.'
    and latest.website_url = 'https://conscious.engineer'
);

commit;
SQL

echo "Seeded ConsciousClaw and Owen Barnes."