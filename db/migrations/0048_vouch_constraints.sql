begin;

-- One active vouch per (network, from, to) pair.
create unique index edges_unique_active_vouch
  on app.edges (network_id, from_member_id, to_member_id)
  where kind = 'vouched_for' and archived_at is null;

-- Self-vouching is not allowed.
alter table app.edges add constraint edges_no_self_vouch
  check (kind <> 'vouched_for' or from_member_id <> to_member_id);

commit;
