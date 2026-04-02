begin;

-- Sponsorships: an existing member recommends an outsider for admission.
-- Separate from applications (which track formal admissions workflow)
-- and from vouches (which are peer endorsements between existing members).
-- Multiple members can sponsor the same outsider — that is itself a signal.
create table app.sponsorships (
  id app.short_id primary key default app.new_id(),
  network_id app.short_id not null references app.networks(id),
  sponsor_member_id app.short_id not null references app.members(id),
  candidate_name text not null check (length(btrim(candidate_name)) > 0),
  candidate_email text not null check (candidate_email like '%@%'),
  candidate_details jsonb not null default '{}'::jsonb,
  reason text not null check (length(btrim(reason)) > 0),
  created_at timestamptz not null default now()
);

create index sponsorships_network_idx
  on app.sponsorships (network_id, created_at desc);

create index sponsorships_sponsor_idx
  on app.sponsorships (sponsor_member_id, created_at desc);

alter table app.sponsorships enable row level security;
alter table app.sponsorships force row level security;

-- Members can insert sponsorships in networks they belong to.
create policy sponsorships_insert_member on app.sponsorships
  for insert
  with check (
    sponsor_member_id = current_setting('app.actor_member_id', true)::app.short_id
    and exists (
      select 1 from app.accessible_network_memberships anm
      where anm.member_id = sponsor_member_id
        and anm.network_id = sponsorships.network_id
    )
  );

-- Members can read their own sponsorships in networks they still belong to.
create policy sponsorships_select_own on app.sponsorships
  for select
  using (
    sponsor_member_id = current_setting('app.actor_member_id', true)::app.short_id
    and exists (
      select 1 from app.accessible_network_memberships anm
      where anm.member_id = sponsor_member_id
        and anm.network_id = sponsorships.network_id
    )
  );

-- Network owners can read all sponsorships in their networks.
create policy sponsorships_select_owner on app.sponsorships
  for select
  using (
    exists (
      select 1 from app.accessible_network_memberships anm
      where anm.member_id = current_setting('app.actor_member_id', true)::app.short_id
        and anm.network_id = sponsorships.network_id
        and anm.role = 'owner'
    )
  );

-- Superadmin can read all sponsorships.
create policy sponsorships_select_superadmin on app.sponsorships
  for select
  using (
    exists (
      select 1 from app.current_member_global_roles cmgr
      where cmgr.member_id = current_setting('app.actor_member_id', true)::app.short_id
        and cmgr.role = 'superadmin'
    )
  );

commit;
