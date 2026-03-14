begin;

create table if not exists app.member_entity_update_receipts (
  id app.short_id primary key default app.new_id(),
  member_id app.short_id not null references app.members(id),
  network_id app.short_id not null references app.networks(id),
  entity_id app.short_id not null references app.entities(id),
  entity_version_id app.short_id not null references app.entity_versions(id),
  seen_at timestamptz not null default now(),
  created_by_member_id app.short_id references app.members(id),
  unique (member_id, entity_version_id)
);

create index if not exists member_entity_update_receipts_member_seen_idx
  on app.member_entity_update_receipts (member_id, seen_at desc, id desc);

create index if not exists member_entity_update_receipts_entity_version_idx
  on app.member_entity_update_receipts (entity_version_id, member_id);

alter table app.member_entity_update_receipts enable row level security;
alter table app.member_entity_update_receipts force row level security;

drop policy if exists member_entity_update_receipts_select_self on app.member_entity_update_receipts;
create policy member_entity_update_receipts_select_self on app.member_entity_update_receipts
  for select
  using (
    member_id = app.current_actor_member_id()
    and app.actor_has_network_access(network_id)
  );

drop policy if exists member_entity_update_receipts_insert_self on app.member_entity_update_receipts;
create policy member_entity_update_receipts_insert_self on app.member_entity_update_receipts
  for insert
  with check (
    member_id = app.current_actor_member_id()
    and created_by_member_id = app.current_actor_member_id()
    and app.actor_has_network_access(network_id)
  );

commit;
