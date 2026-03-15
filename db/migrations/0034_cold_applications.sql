begin;

alter table app.applications
  drop constraint if exists applications_path_check;

alter table app.applications
  alter column applicant_member_id drop not null;

alter table app.applications
  add column if not exists applicant_email text,
  add column if not exists applicant_name text;

alter table app.applications
  add constraint applications_path_check
  check (path in ('sponsored', 'outside', 'cold'));

alter table app.applications
  drop constraint if exists applications_cold_identity_check;

alter table app.applications
  add constraint applications_cold_identity_check
  check (
    path <> 'cold'
    or (
      applicant_email is not null
      and applicant_name is not null
      and length(btrim(applicant_email)) > 0
      and length(btrim(applicant_name)) > 0
    )
  );

alter table app.applications
  drop constraint if exists applications_member_applicant_check;

alter table app.applications
  add constraint applications_member_applicant_check
  check (
    path = 'cold'
    or applicant_member_id is not null
  );

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
  cav.created_by_member_id as version_created_by_member_id,
  a.applicant_email,
  a.applicant_name
from app.applications a
join app.current_application_versions cav on cav.application_id = a.id;

drop policy if exists applications_select_cold on app.applications;
create policy applications_select_cold on app.applications
  for select
  using (
    path = 'cold'
    and coalesce(current_setting('app.allow_cold_application', true), '') = '1'
  );

drop policy if exists applications_insert_cold on app.applications;
create policy applications_insert_cold on app.applications
  for insert
  with check (
    path = 'cold'
    and coalesce(current_setting('app.allow_cold_application', true), '') = '1'
  );

drop policy if exists applications_update_cold on app.applications;
create policy applications_update_cold on app.applications
  for update
  using (
    path = 'cold'
    and coalesce(current_setting('app.allow_cold_application', true), '') = '1'
  )
  with check (
    path = 'cold'
    and coalesce(current_setting('app.allow_cold_application', true), '') = '1'
  );

drop policy if exists application_versions_select_cold on app.application_versions;
create policy application_versions_select_cold on app.application_versions
  for select
  using (
    coalesce(current_setting('app.allow_cold_application', true), '') = '1'
    and exists (
      select 1
      from app.applications a
      where a.id = application_id
        and a.path = 'cold'
    )
  );

drop policy if exists application_versions_insert_cold on app.application_versions;
create policy application_versions_insert_cold on app.application_versions
  for insert
  with check (
    coalesce(current_setting('app.allow_cold_application', true), '') = '1'
    and exists (
      select 1
      from app.applications a
      where a.id = application_id
        and a.path = 'cold'
    )
  );

commit;
