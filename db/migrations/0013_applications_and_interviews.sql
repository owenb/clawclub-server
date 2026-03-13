begin;

create type app.application_status as enum (
  'draft',
  'submitted',
  'interview_scheduled',
  'interview_completed',
  'accepted',
  'declined',
  'withdrawn'
);

create table app.applications (
  id app.short_id primary key default app.new_id(),
  network_id app.short_id not null references app.networks(id),
  applicant_member_id app.short_id not null references app.members(id),
  sponsor_member_id app.short_id references app.members(id),
  membership_id app.short_id references app.network_memberships(id),
  path text not null check (path in ('sponsored', 'outside')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (network_id, applicant_member_id, created_at)
);

create table app.application_versions (
  id app.short_id primary key default app.new_id(),
  application_id app.short_id not null references app.applications(id),
  status app.application_status not null,
  notes text,
  intake_kind text not null default 'other' check (intake_kind in ('fit_check', 'advice_call', 'other')),
  intake_price_amount numeric(12,2) check (intake_price_amount is null or intake_price_amount >= 0),
  intake_price_currency text check (intake_price_currency is null or intake_price_currency ~ '^[A-Z]{3}$'),
  intake_booking_url text,
  intake_booked_at timestamptz,
  intake_completed_at timestamptz,
  version_no integer not null check (version_no > 0),
  supersedes_version_id app.short_id references app.application_versions(id),
  source_transcript_thread_id app.short_id references app.transcript_threads(id),
  source_transcript_message_id app.short_id references app.transcript_messages(id),
  created_at timestamptz not null default now(),
  created_by_member_id app.short_id references app.members(id),
  unique (application_id, version_no),
  check (intake_completed_at is null or intake_booked_at is null or intake_completed_at >= intake_booked_at)
);

create index application_versions_application_version_idx
  on app.application_versions (application_id, version_no desc, created_at desc);
create index applications_network_created_idx
  on app.applications (network_id, created_at desc);

create or replace view app.current_application_versions as
select distinct on (application_id)
  id,
  application_id,
  status,
  notes,
  intake_kind,
  intake_price_amount,
  intake_price_currency,
  intake_booking_url,
  intake_booked_at,
  intake_completed_at,
  version_no,
  supersedes_version_id,
  source_transcript_thread_id,
  source_transcript_message_id,
  created_at,
  created_by_member_id
from app.application_versions
order by application_id, version_no desc, created_at desc;

create or replace view app.current_applications as
select
  a.id,
  a.network_id,
  a.applicant_member_id,
  a.sponsor_member_id,
  a.membership_id,
  a.path,
  a.metadata,
  a.created_at,
  cav.id as version_id,
  cav.status,
  cav.notes,
  cav.intake_kind,
  cav.intake_price_amount,
  cav.intake_price_currency,
  cav.intake_booking_url,
  cav.intake_booked_at,
  cav.intake_completed_at,
  cav.version_no,
  cav.supersedes_version_id,
  cav.source_transcript_thread_id,
  cav.source_transcript_message_id,
  cav.created_at as version_created_at,
  cav.created_by_member_id as version_created_by_member_id
from app.applications a
join app.current_application_versions cav on cav.application_id = a.id;

commit;
