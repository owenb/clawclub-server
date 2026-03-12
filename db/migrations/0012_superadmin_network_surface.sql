begin;

create type app.global_role as enum ('superadmin');
create type app.assignment_state as enum ('active', 'revoked');

create table app.member_global_role_versions (
  id app.short_id primary key default app.new_id(),
  member_id app.short_id not null references app.members(id),
  role app.global_role not null,
  status app.assignment_state not null default 'active',
  version_no integer not null check (version_no > 0),
  supersedes_role_version_id app.short_id references app.member_global_role_versions(id),
  created_at timestamptz not null default now(),
  created_by_member_id app.short_id references app.members(id),
  unique (member_id, role, version_no)
);

create index member_global_role_versions_member_role_idx
  on app.member_global_role_versions (member_id, role, version_no desc, created_at desc);

create or replace view app.current_member_global_role_versions as
select distinct on (member_id, role)
  id,
  member_id,
  role,
  status,
  version_no,
  supersedes_role_version_id,
  created_at,
  created_by_member_id
from app.member_global_role_versions
order by member_id, role, version_no desc, created_at desc;

create or replace view app.current_member_global_roles as
select
  id,
  member_id,
  role,
  version_no,
  supersedes_role_version_id,
  created_at,
  created_by_member_id
from app.current_member_global_role_versions
where status = 'active';

create table app.network_owner_versions (
  id app.short_id primary key default app.new_id(),
  network_id app.short_id not null references app.networks(id),
  owner_member_id app.short_id not null references app.members(id),
  version_no integer not null check (version_no > 0),
  supersedes_owner_version_id app.short_id references app.network_owner_versions(id),
  created_at timestamptz not null default now(),
  created_by_member_id app.short_id references app.members(id),
  unique (network_id, version_no)
);

create index network_owner_versions_network_idx
  on app.network_owner_versions (network_id, version_no desc, created_at desc);

insert into app.network_owner_versions (
  network_id,
  owner_member_id,
  version_no,
  created_at,
  created_by_member_id
)
select
  n.id,
  n.owner_member_id,
  1,
  n.created_at,
  n.owner_member_id
from app.networks n
where not exists (
  select 1
  from app.network_owner_versions nov
  where nov.network_id = n.id
);

create or replace view app.current_network_owners as
select distinct on (network_id)
  id,
  network_id,
  owner_member_id,
  version_no,
  supersedes_owner_version_id,
  created_at,
  created_by_member_id
from app.network_owner_versions
order by network_id, version_no desc, created_at desc;

create or replace function app.current_actor_is_superadmin()
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from app.current_member_global_roles cmgr
    where cmgr.member_id = app.current_actor_member_id()
      and cmgr.role = 'superadmin'
  )
$$;

alter table app.networks enable row level security;
alter table app.networks force row level security;

drop policy if exists networks_select_scope on app.networks;
create policy networks_select_scope on app.networks
  for select
  using (
    app.current_actor_is_superadmin()
    or app.actor_has_network_access(id)
  );

drop policy if exists networks_insert_superadmin on app.networks;
create policy networks_insert_superadmin on app.networks
  for insert
  with check (
    app.current_actor_is_superadmin()
    and archived_at is null
  );

drop policy if exists networks_update_superadmin on app.networks;
create policy networks_update_superadmin on app.networks
  for update
  using (app.current_actor_is_superadmin())
  with check (app.current_actor_is_superadmin());

commit;
