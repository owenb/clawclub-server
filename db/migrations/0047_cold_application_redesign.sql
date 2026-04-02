begin;

-- Networks can be publicly listed or private.
-- Private clubs don't appear in the challenge response but still accept applications by slug.
alter table app.networks add column publicly_listed boolean not null default false;

-- Store additional application details (socials, reason, etc.) as JSONB.
alter table app.applications add column application_details jsonb not null default '{}'::jsonb;

-- Rebuild current_applications view to include the new column.
-- Must drop first because CREATE OR REPLACE cannot reorder columns.
drop view if exists app.current_applications;
create view app.current_applications as
select
  a.id,
  a.network_id,
  a.applicant_member_id,
  a.sponsor_member_id,
  a.membership_id,
  a.path,
  a.application_details,
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
  cav.created_by_member_id as version_created_by_member_id,
  a.applicant_email,
  a.applicant_name
from app.applications a
join app.current_application_versions cav on cav.application_id = a.id;

alter view app.current_applications owner to clawclub_view_owner;

-- Challenges are now network-agnostic — purely PoW tickets.
alter table app.cold_application_challenges drop column if exists network_id;
alter table app.cold_application_challenges drop column if exists applicant_email;
alter table app.cold_application_challenges drop column if exists applicant_name;

-- Drop old security definer functions (old signatures).
drop function if exists app.create_cold_application_challenge(text, text, text, integer, integer);
drop function if exists app.get_cold_application_challenge(app.short_id);
drop function if exists app.consume_cold_application_challenge(app.short_id);
drop function if exists app.delete_cold_application_challenge(app.short_id);

-- New: create a network-agnostic PoW challenge.
create or replace function app.create_cold_application_challenge(
  target_difficulty integer,
  target_ttl_ms integer
)
returns table(challenge_id app.short_id, expires_at text)
language plpgsql
security definer
set search_path = app, pg_temp
as $$
begin
  delete from app.cold_application_challenges c
  where c.expires_at <= now();

  return query
    insert into app.cold_application_challenges (difficulty, expires_at)
    values (
      target_difficulty,
      now() + (target_ttl_ms * interval '1 millisecond')
    )
    returning
      id as challenge_id,
      cold_application_challenges.expires_at::text as expires_at;
end;
$$;

-- New: list publicly listed networks for unauthenticated callers.
create or replace function app.list_publicly_listed_networks()
returns table(slug text, name text, summary text)
language sql
stable
security definer
set search_path = app, pg_temp
as $$
  select n.slug, n.name, n.summary
  from app.networks n
  where n.publicly_listed = true
    and n.archived_at is null
  order by n.name asc;
$$;

-- New: get a challenge for PoW verification (locks the row).
create or replace function app.get_cold_application_challenge(
  target_challenge_id app.short_id
)
returns table(challenge_id app.short_id, difficulty integer, expires_at text)
language sql
security definer
set search_path = app, pg_temp
as $$
  select
    c.id as challenge_id,
    c.difficulty,
    c.expires_at::text as expires_at
  from app.cold_application_challenges c
  where c.id = target_challenge_id
  limit 1
  for update;
$$;

-- New: delete a challenge (for expiry cleanup).
create or replace function app.delete_cold_application_challenge(
  target_challenge_id app.short_id
)
returns boolean
language sql
security definer
set search_path = app, pg_temp
as $$
  with deleted as (
    delete from app.cold_application_challenges c
    where c.id = target_challenge_id
    returning 1
  )
  select exists (select 1 from deleted);
$$;

-- New: consume a challenge and create an application with all details.
-- Uses a CTE chain to guarantee correct application→version linkage via RETURNING.
create or replace function app.consume_cold_application_challenge(
  target_challenge_id app.short_id,
  target_network_slug text,
  target_name text,
  target_email text,
  target_application_details jsonb
)
returns table(application_id app.short_id)
language sql
security definer
set search_path = app, pg_temp
as $$
  with challenge as (
    delete from app.cold_application_challenges c
    where c.id = target_challenge_id
    returning 1
  ), target_network as (
    select n.id as network_id
    from app.networks n
    where n.slug = target_network_slug
      and n.archived_at is null
    limit 1
  ), inserted as (
    insert into app.applications (
      network_id,
      path,
      applicant_email,
      applicant_name,
      application_details
    )
    select
      target_network.network_id,
      'cold',
      target_email,
      target_name,
      target_application_details
    from target_network
    where exists (select 1 from challenge)
    returning id as application_id
  ), version_insert as (
    insert into app.application_versions (
      application_id,
      status,
      notes,
      version_no
    )
    select
      inserted.application_id,
      'submitted',
      'Cold application submitted after proof verification',
      1
    from inserted
  )
  select inserted.application_id
  from inserted;
$$;

-- Set ownership on all new functions.
alter function app.create_cold_application_challenge(integer, integer)
  owner to clawclub_cold_application_owner;
alter function app.list_publicly_listed_networks()
  owner to clawclub_cold_application_owner;
alter function app.get_cold_application_challenge(app.short_id)
  owner to clawclub_cold_application_owner;
alter function app.delete_cold_application_challenge(app.short_id)
  owner to clawclub_cold_application_owner;
alter function app.consume_cold_application_challenge(app.short_id, text, text, text, jsonb)
  owner to clawclub_cold_application_owner;

commit;
