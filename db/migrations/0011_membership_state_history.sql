begin;

alter type app.membership_state add value if not exists 'pending_review';
alter type app.membership_state add value if not exists 'revoked';
alter type app.membership_state add value if not exists 'rejected';

create table if not exists app.network_membership_state_versions (
  id app.short_id primary key default app.new_id(),
  membership_id app.short_id not null references app.network_memberships(id),
  status app.membership_state not null,
  reason text,
  version_no integer not null check (version_no > 0),
  supersedes_state_version_id app.short_id references app.network_membership_state_versions(id),
  source_transcript_thread_id app.short_id references app.transcript_threads(id),
  source_transcript_message_id app.short_id references app.transcript_messages(id),
  created_at timestamptz not null default now(),
  created_by_member_id app.short_id references app.members(id),
  unique (membership_id, version_no)
);

create index if not exists network_membership_state_versions_membership_version_idx
  on app.network_membership_state_versions (membership_id, version_no desc, created_at desc);

insert into app.network_membership_state_versions (
  membership_id,
  status,
  reason,
  version_no,
  created_at,
  created_by_member_id
)
select
  nm.id,
  case nm.status
    when 'removed'::app.membership_state then 'revoked'::app.membership_state
    when 'left'::app.membership_state then 'revoked'::app.membership_state
    else nm.status
  end,
  null,
  1,
  coalesce(nm.joined_at, now()),
  case when nm.role = 'owner' then n.owner_member_id else nm.sponsor_member_id end
from app.network_memberships nm
join app.networks n on n.id = nm.network_id
where not exists (
  select 1
  from app.network_membership_state_versions nmsv
  where nmsv.membership_id = nm.id
);

create or replace view app.current_network_membership_states as
select distinct on (membership_id)
  id,
  membership_id,
  status,
  reason,
  version_no,
  supersedes_state_version_id,
  source_transcript_thread_id,
  source_transcript_message_id,
  created_at,
  created_by_member_id
from app.network_membership_state_versions
order by membership_id, version_no desc, created_at desc;

create or replace view app.current_network_memberships as
select
  nm.id,
  nm.network_id,
  nm.member_id,
  nm.sponsor_member_id,
  nm.role,
  cnms.status,
  nm.joined_at,
  case when cnms.status in ('revoked', 'rejected') then cnms.created_at else nm.left_at end as left_at,
  nm.accepted_covenant_at,
  nm.metadata,
  cnms.id as state_version_id,
  cnms.reason as state_reason,
  cnms.version_no as state_version_no,
  cnms.supersedes_state_version_id,
  cnms.source_transcript_thread_id,
  cnms.source_transcript_message_id,
  cnms.created_at as state_created_at,
  cnms.created_by_member_id as state_created_by_member_id
from app.network_memberships nm
join app.current_network_membership_states cnms on cnms.membership_id = nm.id;

create or replace view app.active_network_memberships as
select *
from app.current_network_memberships
where status = 'active' and left_at is null;

create or replace view app.accessible_network_memberships as
select nm.id,
  nm.network_id,
  nm.member_id,
  nm.sponsor_member_id,
  nm.role,
  nm.status,
  nm.joined_at,
  nm.left_at,
  nm.accepted_covenant_at,
  nm.metadata
from app.active_network_memberships nm
where nm.role = 'owner'
   or exists (
     select 1
     from app.live_subscriptions ls
     where ls.membership_id = nm.id
   );

create or replace function app.lock_network_membership_mutation()
returns trigger
language plpgsql
as $$
begin
  if new.network_id is distinct from old.network_id then
    raise exception 'network_memberships.network_id is immutable';
  end if;

  if new.member_id is distinct from old.member_id then
    raise exception 'network_memberships.member_id is immutable';
  end if;

  if new.sponsor_member_id is distinct from old.sponsor_member_id then
    raise exception 'network_memberships.sponsor_member_id is immutable';
  end if;

  if new.joined_at is distinct from old.joined_at then
    raise exception 'network_memberships.joined_at is immutable';
  end if;

  if new.status is distinct from old.status then
    raise exception 'network_memberships.status must change via network_membership_state_versions';
  end if;

  if new.left_at is distinct from old.left_at then
    raise exception 'network_memberships.left_at must change via network_membership_state_versions';
  end if;

  return new;
end;
$$;

drop trigger if exists network_memberships_identity_guard on app.network_memberships;
create trigger network_memberships_identity_guard
before update on app.network_memberships
for each row
execute function app.lock_network_membership_mutation();

commit;
