begin;

-- Per-network quota policies for member-authored writes.
-- When no row exists for a (network, action) pair, the application applies built-in defaults.
create table app.network_quota_policies (
  id app.short_id primary key default app.new_id(),
  network_id app.short_id not null references app.networks(id),
  action_name text not null check (action_name in ('entities.create', 'events.create', 'messages.send')),
  max_per_day integer not null check (max_per_day > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (network_id, action_name)
);

alter table app.network_quota_policies enable row level security;
alter table app.network_quota_policies force row level security;

-- Members can read quota policies for networks they belong to.
create policy member_select_quota_policies on app.network_quota_policies
  for select to clawclub_api_role
  using (
    current_setting('app.actor_member_id', true) is not null
    and exists (
      select 1 from app.accessible_network_memberships anm
      where anm.member_id = current_setting('app.actor_member_id', true)::app.short_id
        and anm.network_id = network_quota_policies.network_id
    )
  );

-- Superadmin can read all quota policies.
create policy superadmin_select_quota_policies on app.network_quota_policies
  for select to clawclub_api_role
  using (
    current_setting('app.actor_member_id', true) is not null
    and exists (
      select 1 from app.current_member_global_roles cmgr
      where cmgr.member_id = current_setting('app.actor_member_id', true)::app.short_id
        and cmgr.role = 'superadmin'
    )
  );

-- Count member writes for the current day (uses database timezone, typically UTC).
-- Security definer so it can read across tables without per-table RLS checks.
create or replace function app.count_member_writes_today(
  target_member_id app.short_id,
  target_network_id app.short_id,
  target_action text
)
returns integer
language sql
stable
security definer
set search_path = app, pg_temp
as $$
  select case target_action
    when 'entities.create' then (
      select count(*)::int from app.entities e
      where e.author_member_id = target_member_id
        and e.network_id = target_network_id
        and e.kind != 'event'
        and e.created_at >= current_date
    )
    when 'events.create' then (
      select count(*)::int from app.entities e
      where e.author_member_id = target_member_id
        and e.network_id = target_network_id
        and e.kind = 'event'
        and e.created_at >= current_date
    )
    when 'messages.send' then (
      select count(*)::int from app.transcript_messages tm
      join app.transcript_threads tt on tt.id = tm.thread_id
      where tm.sender_member_id = target_member_id
        and tt.network_id = target_network_id
        and tm.created_at >= current_date
    )
    else 0
  end
$$;

alter function app.count_member_writes_today(app.short_id, app.short_id, text)
  owner to clawclub_security_definer_owner;

grant execute on function app.count_member_writes_today(app.short_id, app.short_id, text)
  to clawclub_api_role;

commit;
