begin;

create or replace function app.current_actor_member_id()
returns app.short_id
language sql
stable
as $$
  select nullif(current_setting('app.actor_member_id', true), '')::app.short_id
$$;

create or replace function app.current_actor_network_ids()
returns app.short_id[]
language sql
stable
as $$
  select coalesce(
    string_to_array(nullif(current_setting('app.actor_network_ids', true), ''), ',')::app.short_id[],
    array[]::app.short_id[]
  )
$$;

create or replace function app.actor_has_network_access(target_network_id app.short_id)
returns boolean
language sql
stable
as $$
  select target_network_id = any(app.current_actor_network_ids())
$$;

create or replace function app.actor_can_access_thread(target_thread_id app.short_id)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from app.transcript_threads tt
    where tt.id = target_thread_id
      and tt.archived_at is null
      and app.actor_has_network_access(tt.network_id)
      and app.current_actor_member_id() in (tt.created_by_member_id, tt.counterpart_member_id)
  )
$$;

alter table app.entities enable row level security;
alter table app.entities force row level security;

drop policy if exists entities_select_accessible on app.entities;
create policy entities_select_accessible on app.entities
  for select
  using (
    archived_at is null
    and deleted_at is null
    and app.actor_has_network_access(network_id)
  );

drop policy if exists entities_insert_author_scope on app.entities;
create policy entities_insert_author_scope on app.entities
  for insert
  with check (
    archived_at is null
    and deleted_at is null
    and author_member_id = app.current_actor_member_id()
    and app.actor_has_network_access(network_id)
  );

alter table app.entity_versions enable row level security;
alter table app.entity_versions force row level security;

drop policy if exists entity_versions_select_accessible on app.entity_versions;
create policy entity_versions_select_accessible on app.entity_versions
  for select
  using (
    exists (
      select 1
      from app.entities e
      where e.id = entity_id
        and e.archived_at is null
        and e.deleted_at is null
        and app.actor_has_network_access(e.network_id)
    )
  );

drop policy if exists entity_versions_insert_author_scope on app.entity_versions;
create policy entity_versions_insert_author_scope on app.entity_versions
  for insert
  with check (
    created_by_member_id = app.current_actor_member_id()
    and exists (
      select 1
      from app.entities e
      where e.id = entity_id
        and e.archived_at is null
        and e.deleted_at is null
        and e.author_member_id = app.current_actor_member_id()
        and app.actor_has_network_access(e.network_id)
    )
  );

alter table app.event_rsvps enable row level security;
alter table app.event_rsvps force row level security;

drop policy if exists event_rsvps_select_accessible on app.event_rsvps;
create policy event_rsvps_select_accessible on app.event_rsvps
  for select
  using (
    exists (
      select 1
      from app.entities e
      where e.id = event_entity_id
        and e.kind = 'event'
        and e.archived_at is null
        and e.deleted_at is null
        and app.actor_has_network_access(e.network_id)
    )
  );

drop policy if exists event_rsvps_insert_owned_membership on app.event_rsvps;
create policy event_rsvps_insert_owned_membership on app.event_rsvps
  for insert
  with check (
    created_by_member_id = app.current_actor_member_id()
    and exists (
      select 1
      from app.network_memberships nm
      join app.entities e on e.id = event_entity_id
      where nm.id = membership_id
        and nm.member_id = app.current_actor_member_id()
        and e.kind = 'event'
        and e.network_id = nm.network_id
        and e.archived_at is null
        and e.deleted_at is null
        and app.actor_has_network_access(e.network_id)
    )
  );

alter table app.transcript_threads enable row level security;
alter table app.transcript_threads force row level security;

drop policy if exists transcript_threads_select_participant_scope on app.transcript_threads;
create policy transcript_threads_select_participant_scope on app.transcript_threads
  for select
  using (
    archived_at is null
    and app.actor_has_network_access(network_id)
    and app.current_actor_member_id() in (created_by_member_id, counterpart_member_id)
  );

drop policy if exists transcript_threads_insert_participant_scope on app.transcript_threads;
create policy transcript_threads_insert_participant_scope on app.transcript_threads
  for insert
  with check (
    archived_at is null
    and kind = 'dm'
    and created_by_member_id = app.current_actor_member_id()
    and counterpart_member_id is not null
    and app.actor_has_network_access(network_id)
  );

alter table app.transcript_messages enable row level security;
alter table app.transcript_messages force row level security;

drop policy if exists transcript_messages_select_thread_scope on app.transcript_messages;
create policy transcript_messages_select_thread_scope on app.transcript_messages
  for select
  using (app.actor_can_access_thread(thread_id));

drop policy if exists transcript_messages_insert_thread_scope on app.transcript_messages;
create policy transcript_messages_insert_thread_scope on app.transcript_messages
  for insert
  with check (
    role = 'member'
    and sender_member_id = app.current_actor_member_id()
    and app.actor_can_access_thread(thread_id)
  );

alter table app.deliveries enable row level security;
alter table app.deliveries force row level security;

drop policy if exists deliveries_select_recipient_scope on app.deliveries;
create policy deliveries_select_recipient_scope on app.deliveries
  for select
  using (
    recipient_member_id = app.current_actor_member_id()
    and app.actor_has_network_access(network_id)
  );

drop policy if exists deliveries_insert_shared_surface on app.deliveries;
create policy deliveries_insert_shared_surface on app.deliveries
  for insert
  with check (
    app.actor_has_network_access(network_id)
    and (
      (entity_id is not null and exists (
        select 1
        from app.entities e
        where e.id = entity_id
          and e.network_id = deliveries.network_id
          and e.archived_at is null
          and e.deleted_at is null
      ))
      or (transcript_message_id is not null and exists (
        select 1
        from app.transcript_messages tm
        join app.transcript_threads tt on tt.id = tm.thread_id
        where tm.id = transcript_message_id
          and tt.network_id = deliveries.network_id
          and tt.archived_at is null
          and app.current_actor_member_id() in (tt.created_by_member_id, tt.counterpart_member_id)
      ))
    )
  );

alter table app.delivery_acknowledgements enable row level security;
alter table app.delivery_acknowledgements force row level security;

drop policy if exists delivery_acknowledgements_select_recipient_scope on app.delivery_acknowledgements;
create policy delivery_acknowledgements_select_recipient_scope on app.delivery_acknowledgements
  for select
  using (
    recipient_member_id = app.current_actor_member_id()
    and app.actor_has_network_access(network_id)
  );

drop policy if exists delivery_acknowledgements_insert_recipient_scope on app.delivery_acknowledgements;
create policy delivery_acknowledgements_insert_recipient_scope on app.delivery_acknowledgements
  for insert
  with check (
    recipient_member_id = app.current_actor_member_id()
    and created_by_member_id = app.current_actor_member_id()
    and app.actor_has_network_access(network_id)
    and exists (
      select 1
      from app.deliveries d
      where d.id = delivery_id
        and d.recipient_member_id = app.current_actor_member_id()
        and d.network_id = delivery_acknowledgements.network_id
    )
  );

commit;
