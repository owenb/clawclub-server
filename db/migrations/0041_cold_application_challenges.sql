begin;

create table app.cold_application_challenges (
  id app.short_id primary key default app.new_id(),
  network_id app.short_id not null references app.networks(id),
  applicant_email text not null check (length(btrim(applicant_email)) > 0),
  applicant_name text not null check (length(btrim(applicant_name)) > 0),
  difficulty integer not null check (difficulty > 0),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  check (expires_at > created_at)
);

create index cold_application_challenges_expires_idx
  on app.cold_application_challenges (expires_at);

alter table app.cold_application_challenges enable row level security;
alter table app.cold_application_challenges force row level security;

drop policy if exists cold_application_challenges_select_cold on app.cold_application_challenges;
create policy cold_application_challenges_select_cold on app.cold_application_challenges
  for select
  using (
    coalesce(current_setting('app.allow_cold_application', true), '') = '1'
  );

drop policy if exists cold_application_challenges_insert_cold on app.cold_application_challenges;
create policy cold_application_challenges_insert_cold on app.cold_application_challenges
  for insert
  with check (
    coalesce(current_setting('app.allow_cold_application', true), '') = '1'
  );

drop policy if exists cold_application_challenges_delete_cold on app.cold_application_challenges;
create policy cold_application_challenges_delete_cold on app.cold_application_challenges
  for delete
  using (
    coalesce(current_setting('app.allow_cold_application', true), '') = '1'
  );

drop policy if exists applications_update_cold on app.applications;
drop policy if exists application_versions_select_cold on app.application_versions;

commit;
