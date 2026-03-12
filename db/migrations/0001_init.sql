begin;

create schema if not exists app;

create domain app.short_id as text
  check (value ~ '^[23456789abcdefghjkmnpqrstuvwxyz]{12}$');

create type app.member_state as enum ('pending', 'active', 'suspended', 'deleted');
create type app.membership_role as enum ('owner', 'admin', 'member');
create type app.membership_state as enum ('invited', 'active', 'paused', 'left', 'removed');
create type app.subscription_status as enum ('trialing', 'active', 'past_due', 'paused', 'canceled', 'ended');
create type app.billing_interval as enum ('month', 'year', 'manual');
create type app.entity_kind as enum ('post', 'opportunity', 'service', 'ask', 'event', 'comment', 'complaint');
create type app.entity_state as enum ('draft', 'published', 'archived');
create type app.work_mode as enum ('unspecified', 'remote', 'in_person', 'hybrid');
create type app.compensation_kind as enum ('unspecified', 'paid', 'unpaid', 'mixed', 'exchange');
create type app.edge_kind as enum ('vouched_for', 'about', 'related_to', 'mentions');
create type app.rsvp_state as enum ('yes', 'maybe', 'no', 'waitlist');
create type app.delivery_channel as enum ('openclaw_webhook');
create type app.delivery_endpoint_state as enum ('active', 'disabled', 'failing');
create type app.delivery_status as enum ('pending', 'processing', 'sent', 'failed', 'canceled');
create type app.transcript_thread_kind as enum ('agent', 'dm', 'complaint', 'system');
create type app.transcript_role as enum ('member', 'agent', 'system');
create type app.member_location_kind as enum ('home_base', 'current_city', 'travel');

create or replace function app.new_id()
returns app.short_id
language plpgsql
as $$
declare
  alphabet constant text := '23456789abcdefghjkmnpqrstuvwxyz';
  output text := '';
  idx integer;
begin
  for idx in 1..12 loop
    output := output || substr(alphabet, 1 + floor(random() * length(alphabet))::integer, 1);
  end loop;

  return output::app.short_id;
end;
$$;

create table app.members (
  id app.short_id primary key default app.new_id(),
  auth_subject text unique,
  handle text unique,
  public_name text not null check (length(btrim(public_name)) > 0),
  state app.member_state not null default 'active',
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  erasure_requested_at timestamptz,
  erasure_completed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb
);

create table app.networks (
  id app.short_id primary key default app.new_id(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  name text not null check (length(btrim(name)) > 0),
  summary text,
  owner_member_id app.short_id not null references app.members(id),
  manifesto_markdown text,
  membership_visibility text not null default 'private',
  default_paid_membership boolean not null default true,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  archived_at timestamptz
);

create table app.network_memberships (
  id app.short_id primary key default app.new_id(),
  network_id app.short_id not null references app.networks(id),
  member_id app.short_id not null references app.members(id),
  sponsor_member_id app.short_id references app.members(id),
  role app.membership_role not null default 'member',
  status app.membership_state not null default 'active',
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  accepted_covenant_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  unique (network_id, member_id),
  check (
    (role = 'owner' and sponsor_member_id is null)
    or (role <> 'owner' and sponsor_member_id is not null)
  )
);

create table app.subscriptions (
  id app.short_id primary key default app.new_id(),
  membership_id app.short_id not null references app.network_memberships(id),
  payer_member_id app.short_id not null references app.members(id),
  status app.subscription_status not null default 'active',
  billing_interval app.billing_interval not null default 'month',
  amount numeric(12,2) not null check (amount >= 0),
  currency text not null default 'GBP' check (currency ~ '^[A-Z]{3}$'),
  provider text,
  provider_reference text,
  started_at timestamptz not null default now(),
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at timestamptz,
  ended_at timestamptz,
  metadata jsonb not null default '{}'::jsonb
);

create table app.locations (
  id app.short_id primary key default app.new_id(),
  city text not null,
  region text,
  country_code text not null check (country_code ~ '^[A-Z]{2}$'),
  country_name text not null,
  timezone text,
  latitude double precision,
  longitude double precision,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table app.member_profile_versions (
  id app.short_id primary key default app.new_id(),
  member_id app.short_id not null references app.members(id),
  version_no integer not null check (version_no > 0),
  display_name text not null check (length(btrim(display_name)) > 0),
  tagline text,
  summary text,
  what_i_do text,
  known_for text,
  services_summary text,
  website_url text,
  links jsonb not null default '[]'::jsonb,
  profile jsonb not null default '{}'::jsonb,
  source_transcript_thread_id app.short_id,
  source_transcript_message_id app.short_id,
  created_at timestamptz not null default now(),
  created_by_member_id app.short_id references app.members(id),
  unique (member_id, version_no)
);

create table app.entities (
  id app.short_id primary key default app.new_id(),
  network_id app.short_id not null references app.networks(id),
  kind app.entity_kind not null,
  author_member_id app.short_id not null references app.members(id),
  parent_entity_id app.short_id references app.entities(id),
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  deleted_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  check ((kind = 'comment' and parent_entity_id is not null) or kind <> 'comment')
);

create table app.transcript_threads (
  id app.short_id primary key default app.new_id(),
  network_id app.short_id references app.networks(id),
  kind app.transcript_thread_kind not null,
  created_by_member_id app.short_id references app.members(id),
  counterpart_member_id app.short_id references app.members(id),
  subject_entity_id app.short_id references app.entities(id),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  archived_at timestamptz
);

create table app.transcript_messages (
  id app.short_id primary key default app.new_id(),
  thread_id app.short_id not null references app.transcript_threads(id),
  sender_member_id app.short_id references app.members(id),
  role app.transcript_role not null,
  message_text text,
  payload jsonb not null default '{}'::jsonb,
  in_reply_to_message_id app.short_id references app.transcript_messages(id),
  created_at timestamptz not null default now(),
  check (message_text is not null or payload <> '{}'::jsonb)
);

alter table app.member_profile_versions
  add constraint member_profile_versions_source_thread_fk
  foreign key (source_transcript_thread_id) references app.transcript_threads(id);

alter table app.member_profile_versions
  add constraint member_profile_versions_source_message_fk
  foreign key (source_transcript_message_id) references app.transcript_messages(id);

create table app.entity_versions (
  id app.short_id primary key default app.new_id(),
  entity_id app.short_id not null references app.entities(id),
  version_no integer not null check (version_no > 0),
  state app.entity_state not null default 'published',
  title text,
  summary text,
  body text,
  work_mode app.work_mode not null default 'unspecified',
  compensation app.compensation_kind not null default 'unspecified',
  starts_at timestamptz,
  ends_at timestamptz,
  timezone text,
  recurrence_rule text,
  capacity integer check (capacity is null or capacity > 0),
  effective_at timestamptz not null default now(),
  expires_at timestamptz,
  content jsonb not null default '{}'::jsonb,
  source_transcript_thread_id app.short_id references app.transcript_threads(id),
  source_transcript_message_id app.short_id references app.transcript_messages(id),
  supersedes_version_id app.short_id references app.entity_versions(id),
  created_at timestamptz not null default now(),
  created_by_member_id app.short_id references app.members(id),
  unique (entity_id, version_no),
  check (ends_at is null or starts_at is null or ends_at >= starts_at),
  check (expires_at is null or expires_at >= effective_at)
);

create table app.member_locations (
  id app.short_id primary key default app.new_id(),
  member_id app.short_id not null references app.members(id),
  location_id app.short_id not null references app.locations(id),
  kind app.member_location_kind not null,
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  is_primary boolean not null default false,
  source_transcript_message_id app.short_id references app.transcript_messages(id),
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  check (ends_at is null or ends_at >= starts_at)
);

create table app.entity_locations (
  id app.short_id primary key default app.new_id(),
  entity_version_id app.short_id not null references app.entity_versions(id),
  location_id app.short_id not null references app.locations(id),
  location_role text not null,
  label text,
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create table app.media_links (
  id app.short_id primary key default app.new_id(),
  owner_member_id app.short_id references app.members(id),
  media_kind text not null,
  storage_url text not null,
  preview_url text,
  mime_type text,
  bytes bigint,
  width integer,
  height integer,
  duration_seconds integer,
  checksum text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  archived_at timestamptz
);

create table app.entity_media_links (
  id app.short_id primary key default app.new_id(),
  entity_version_id app.short_id not null references app.entity_versions(id),
  media_link_id app.short_id not null references app.media_links(id),
  position integer not null default 0,
  is_primary boolean not null default false,
  caption text,
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  unique (entity_version_id, media_link_id)
);

create table app.edges (
  id app.short_id primary key default app.new_id(),
  network_id app.short_id references app.networks(id),
  kind app.edge_kind not null,
  from_member_id app.short_id references app.members(id),
  from_entity_id app.short_id references app.entities(id),
  from_entity_version_id app.short_id references app.entity_versions(id),
  to_member_id app.short_id references app.members(id),
  to_entity_id app.short_id references app.entities(id),
  to_entity_version_id app.short_id references app.entity_versions(id),
  to_location_id app.short_id references app.locations(id),
  reason text,
  metadata jsonb not null default '{}'::jsonb,
  source_transcript_message_id app.short_id references app.transcript_messages(id),
  created_by_member_id app.short_id references app.members(id),
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  check (
    ((from_member_id is not null)::integer + (from_entity_id is not null)::integer + (from_entity_version_id is not null)::integer) = 1
  ),
  check (
    ((to_member_id is not null)::integer + (to_entity_id is not null)::integer + (to_entity_version_id is not null)::integer + (to_location_id is not null)::integer) = 1
  ),
  check (
    kind <> 'vouched_for'
    or (from_member_id is not null and to_member_id is not null and reason is not null)
  )
);

create table app.event_rsvps (
  id app.short_id primary key default app.new_id(),
  event_entity_id app.short_id not null references app.entities(id),
  membership_id app.short_id not null references app.network_memberships(id),
  response app.rsvp_state not null,
  note text,
  source_transcript_message_id app.short_id references app.transcript_messages(id),
  created_at timestamptz not null default now(),
  unique (event_entity_id, membership_id)
);

create table app.delivery_endpoints (
  id app.short_id primary key default app.new_id(),
  member_id app.short_id not null references app.members(id),
  channel app.delivery_channel not null default 'openclaw_webhook',
  label text,
  endpoint_url text not null,
  shared_secret_ref text,
  state app.delivery_endpoint_state not null default 'active',
  last_success_at timestamptz,
  last_failure_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  disabled_at timestamptz
);

create table app.deliveries (
  id app.short_id primary key default app.new_id(),
  network_id app.short_id references app.networks(id),
  recipient_member_id app.short_id not null references app.members(id),
  endpoint_id app.short_id not null references app.delivery_endpoints(id),
  entity_id app.short_id references app.entities(id),
  entity_version_id app.short_id references app.entity_versions(id),
  transcript_message_id app.short_id references app.transcript_messages(id),
  topic text not null,
  payload jsonb not null default '{}'::jsonb,
  dedupe_key text,
  status app.delivery_status not null default 'pending',
  attempt_count integer not null default 0 check (attempt_count >= 0),
  scheduled_at timestamptz not null default now(),
  sent_at timestamptz,
  failed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);

create table app.embeddings (
  id app.short_id primary key default app.new_id(),
  member_profile_version_id app.short_id references app.member_profile_versions(id),
  entity_version_id app.short_id references app.entity_versions(id),
  transcript_message_id app.short_id references app.transcript_messages(id),
  model text not null,
  dimensions integer not null check (dimensions > 0),
  embedding double precision[] not null,
  source_text text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (
    ((member_profile_version_id is not null)::integer + (entity_version_id is not null)::integer + (transcript_message_id is not null)::integer) = 1
  ),
  check (array_length(embedding, 1) = dimensions)
);

create index members_state_idx on app.members (state);
create index members_handle_idx on app.members (handle);

create index network_memberships_member_status_idx on app.network_memberships (member_id, status);
create index network_memberships_network_status_idx on app.network_memberships (network_id, status);
create index network_memberships_sponsor_idx on app.network_memberships (sponsor_member_id, joined_at);

create index subscriptions_membership_status_idx on app.subscriptions (membership_id, status);
create index subscriptions_payer_idx on app.subscriptions (payer_member_id, status);

create index locations_lookup_idx on app.locations (country_code, city);

create index member_profile_versions_member_version_idx on app.member_profile_versions (member_id, version_no desc);
create index member_profile_versions_created_at_idx on app.member_profile_versions (created_at desc);

create index entities_network_kind_idx on app.entities (network_id, kind, created_at desc);
create index entities_author_idx on app.entities (author_member_id, created_at desc);
create index entities_parent_idx on app.entities (parent_entity_id);
create index entities_live_idx on app.entities (network_id, kind) where archived_at is null and deleted_at is null;

create index transcript_threads_network_kind_idx on app.transcript_threads (network_id, kind, created_at desc);
create index transcript_threads_subject_idx on app.transcript_threads (subject_entity_id);
create index transcript_messages_thread_created_idx on app.transcript_messages (thread_id, created_at);
create index transcript_messages_sender_idx on app.transcript_messages (sender_member_id, created_at desc);

create index entity_versions_entity_version_idx on app.entity_versions (entity_id, version_no desc);
create index entity_versions_effective_idx on app.entity_versions (effective_at desc);
create index entity_versions_expires_idx on app.entity_versions (expires_at);
create index entity_versions_starts_idx on app.entity_versions (starts_at);

create index member_locations_member_kind_idx on app.member_locations (member_id, kind, starts_at desc);
create index member_locations_location_idx on app.member_locations (location_id, kind, starts_at desc);
create unique index member_locations_primary_active_idx
  on app.member_locations (member_id, kind)
  where is_primary and archived_at is null and ends_at is null;
create index entity_locations_entity_idx on app.entity_locations (entity_version_id);
create index entity_locations_location_idx on app.entity_locations (location_id);

create index entity_media_links_entity_idx on app.entity_media_links (entity_version_id, position);
create unique index entity_media_links_primary_idx
  on app.entity_media_links (entity_version_id)
  where is_primary;

create index edges_network_kind_idx on app.edges (network_id, kind, created_at desc);
create index edges_from_member_idx on app.edges (from_member_id, kind, created_at desc);
create index edges_to_member_idx on app.edges (to_member_id, kind, created_at desc);
create index edges_to_entity_idx on app.edges (to_entity_id, kind, created_at desc);

create index event_rsvps_event_idx on app.event_rsvps (event_entity_id, response);
create index event_rsvps_membership_idx on app.event_rsvps (membership_id, created_at desc);

create index delivery_endpoints_member_state_idx on app.delivery_endpoints (member_id, state);
create unique index deliveries_endpoint_dedupe_idx on app.deliveries (endpoint_id, dedupe_key) where dedupe_key is not null;
create index deliveries_pending_idx on app.deliveries (status, scheduled_at) where status in ('pending', 'processing');
create index deliveries_recipient_idx on app.deliveries (recipient_member_id, created_at desc);

create index embeddings_profile_idx on app.embeddings (member_profile_version_id, created_at desc);
create index embeddings_entity_idx on app.embeddings (entity_version_id, created_at desc);
create index embeddings_message_idx on app.embeddings (transcript_message_id, created_at desc);
create index embeddings_model_idx on app.embeddings (model, created_at desc);

create view app.current_member_profiles as
select distinct on (member_id)
  id,
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
  source_transcript_thread_id,
  source_transcript_message_id,
  created_at,
  created_by_member_id
from app.member_profile_versions
order by member_id, version_no desc, created_at desc;

create view app.current_entity_versions as
select distinct on (entity_id)
  id,
  entity_id,
  version_no,
  state,
  title,
  summary,
  body,
  work_mode,
  compensation,
  starts_at,
  ends_at,
  timezone,
  recurrence_rule,
  capacity,
  effective_at,
  expires_at,
  content,
  source_transcript_thread_id,
  source_transcript_message_id,
  supersedes_version_id,
  created_at,
  created_by_member_id
from app.entity_versions
order by entity_id, version_no desc, created_at desc;

create view app.current_published_entity_versions as
select distinct on (entity_id)
  id,
  entity_id,
  version_no,
  state,
  title,
  summary,
  body,
  work_mode,
  compensation,
  starts_at,
  ends_at,
  timezone,
  recurrence_rule,
  capacity,
  effective_at,
  expires_at,
  content,
  source_transcript_thread_id,
  source_transcript_message_id,
  supersedes_version_id,
  created_at,
  created_by_member_id
from app.entity_versions
where state = 'published'
order by entity_id, version_no desc, created_at desc;

create view app.active_network_memberships as
select *
from app.network_memberships
where status = 'active' and left_at is null;

create view app.live_entities as
select
  e.id as entity_id,
  e.network_id,
  e.kind,
  e.author_member_id,
  e.parent_entity_id,
  e.created_at as entity_created_at,
  cev.id as entity_version_id,
  cev.version_no,
  cev.state,
  cev.title,
  cev.summary,
  cev.body,
  cev.work_mode,
  cev.compensation,
  cev.starts_at,
  cev.ends_at,
  cev.timezone,
  cev.recurrence_rule,
  cev.capacity,
  cev.effective_at,
  cev.expires_at,
  cev.content,
  cev.created_at as version_created_at,
  cev.created_by_member_id
from app.entities e
join app.current_published_entity_versions cev on cev.entity_id = e.id
where e.archived_at is null
  and e.deleted_at is null
  and (cev.expires_at is null or cev.expires_at > now());

commit;
