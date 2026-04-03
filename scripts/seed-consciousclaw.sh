#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/database-urls.sh"

DATABASE_URL="$(require_migrator_database_url)"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
begin;

insert into app.members (public_name, handle)
values (
  'Owen Barnes',
  'owen-barnes'
)
on conflict (handle) do update
set
  public_name = excluded.public_name;

select id from app.members where handle = 'owen-barnes' \gset

insert into app.clubs (slug, name, owner_member_id, summary)
values (
  'consciousclaw',
  'ConsciousClaw',
  :'id',
  'Private relational club for spiritually aligned builders, friends, collaborators, and real-world connection.'
)
on conflict (slug) do update
set
  name = excluded.name,
  owner_member_id = excluded.owner_member_id,
  summary = excluded.summary;

select id as club_id from app.clubs where slug = 'consciousclaw' \gset
select id as owner_member_id from app.members where handle = 'owen-barnes' \gset

insert into app.club_memberships (club_id, member_id, role, sponsor_member_id, accepted_covenant_at, metadata)
values (
  :'club_id',
  :'owner_member_id',
  'owner',
  null,
  now(),
  jsonb_build_object('seed', 'consciousclaw')
)
on conflict (club_id, member_id) do update
set
  role = excluded.role,
  accepted_covenant_at = coalesce(app.club_memberships.accepted_covenant_at, excluded.accepted_covenant_at),
  metadata = app.club_memberships.metadata || excluded.metadata;

select id as owner_membership_id
from app.club_memberships
where club_id = :'club_id'
  and member_id = :'owner_member_id' \gset

with latest_state as (
  select id, status
  from app.current_club_membership_states
  where membership_id = :'owner_membership_id'
), next_version as (
  select coalesce(max(version_no), 0) + 1 as version_no
  from app.club_membership_state_versions
  where membership_id = :'owner_membership_id'
)
insert into app.club_membership_state_versions (
  membership_id,
  status,
  reason,
  version_no,
  supersedes_state_version_id,
  created_by_member_id
)
select
  :'owner_membership_id',
  'active',
  'Seeded ConsciousClaw owner membership',
  next_version.version_no,
  latest_state.id,
  :'owner_member_id'
from next_version
left join latest_state on true
where latest_state.status is distinct from 'active'::app.membership_state;

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
  'Conscious engineer building a private members club for aligned humans.',
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
    and latest.tagline = 'Conscious engineer building a private members club for aligned humans.'
    and latest.summary = 'Builder, steward, and spiritually grounded technologist focused on helping aligned people find each other for friendship, collaboration, service, gatherings, and real-world connection.'
    and latest.what_i_do = 'Designs and builds software systems, relational infrastructure, and agent-native tools that support trust, resonance, and practical coordination.'
    and latest.known_for = 'Clear thinking, system design, spiritual framing, and bringing the right people into meaningful relationship.'
    and latest.services_summary = 'Product and backend architecture, systems thinking, and strategic collaboration for mission-aligned projects.'
    and latest.website_url = 'https://conscious.engineer'
);

commit;
SQL

echo "Seeded ConsciousClaw and Owen Barnes."
