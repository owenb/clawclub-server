begin;

create type app.member_update_receipt_state as enum ('processed', 'suppressed');

create table app.member_updates (
  id app.short_id primary key default app.new_id(),
  stream_seq bigint generated always as identity unique,
  recipient_member_id app.short_id not null references app.members(id),
  network_id app.short_id not null references app.networks(id),
  topic text not null check (length(btrim(topic)) > 0),
  payload jsonb not null default '{}'::jsonb,
  entity_id app.short_id references app.entities(id),
  entity_version_id app.short_id references app.entity_versions(id),
  transcript_message_id app.short_id references app.transcript_messages(id),
  created_by_member_id app.short_id references app.members(id),
  created_at timestamptz not null default now(),
  check (
    transcript_message_id is not null
    or (entity_id is not null and entity_version_id is not null)
    or payload <> '{}'::jsonb
  )
);

create index member_updates_recipient_stream_idx
  on app.member_updates (recipient_member_id, stream_seq asc);

create index member_updates_recipient_created_idx
  on app.member_updates (recipient_member_id, created_at desc, id desc);

create index member_updates_transcript_message_idx
  on app.member_updates (transcript_message_id, recipient_member_id, created_at asc, id asc);

create index member_updates_entity_version_idx
  on app.member_updates (entity_version_id, recipient_member_id, created_at asc, id asc);

create table app.member_update_receipts (
  id app.short_id primary key default app.new_id(),
  member_update_id app.short_id not null references app.member_updates(id),
  recipient_member_id app.short_id not null references app.members(id),
  network_id app.short_id not null references app.networks(id),
  state app.member_update_receipt_state not null default 'processed',
  suppression_reason text,
  version_no integer not null check (version_no > 0),
  supersedes_receipt_id app.short_id references app.member_update_receipts(id),
  created_at timestamptz not null default now(),
  created_by_member_id app.short_id references app.members(id),
  unique (member_update_id, recipient_member_id, version_no)
);

create index member_update_receipts_update_recipient_version_idx
  on app.member_update_receipts (member_update_id, recipient_member_id, version_no desc, created_at desc);

create index member_update_receipts_recipient_created_idx
  on app.member_update_receipts (recipient_member_id, created_at desc, id desc);

create or replace view app.current_member_update_receipts as
select distinct on (member_update_id, recipient_member_id)
  id,
  member_update_id,
  recipient_member_id,
  network_id,
  state,
  suppression_reason,
  version_no,
  supersedes_receipt_id,
  created_at,
  created_by_member_id
from app.member_update_receipts
order by member_update_id, recipient_member_id, version_no desc, created_at desc;

create or replace view app.pending_member_updates as
select
  mu.id as update_id,
  mu.stream_seq,
  mu.recipient_member_id,
  mu.network_id,
  mu.topic,
  mu.payload,
  mu.entity_id,
  mu.entity_version_id,
  mu.transcript_message_id,
  mu.created_by_member_id,
  mu.created_at
from app.member_updates mu
left join app.current_member_update_receipts cmur
  on cmur.member_update_id = mu.id
 and cmur.recipient_member_id = mu.recipient_member_id
where cmur.id is null;

create or replace function app.notify_member_update()
returns trigger
language plpgsql
as $$
begin
  perform pg_notify(
    'member_updates',
    json_build_object(
      'updateId', new.id,
      'recipientMemberId', new.recipient_member_id,
      'streamSeq', new.stream_seq
    )::text
  );
  return new;
end;
$$;

drop trigger if exists member_updates_notify_trigger on app.member_updates;
create trigger member_updates_notify_trigger
after insert on app.member_updates
for each row execute function app.notify_member_update();

alter table app.member_updates enable row level security;
alter table app.member_updates force row level security;

drop policy if exists member_updates_select_recipient_scope on app.member_updates;
create policy member_updates_select_recipient_scope on app.member_updates
  for select
  using (
    recipient_member_id = app.current_actor_member_id()
  );

drop policy if exists member_updates_insert_actor_scope on app.member_updates;
create policy member_updates_insert_actor_scope on app.member_updates
  for insert
  with check (
    created_by_member_id = app.current_actor_member_id()
    and app.actor_has_network_access(network_id)
    and exists (
      select 1
      from app.accessible_network_memberships anm
      where anm.network_id = member_updates.network_id
        and anm.member_id = member_updates.recipient_member_id
    )
    and (
      transcript_message_id is null
      or exists (
        select 1
        from app.transcript_messages tm
        join app.transcript_threads tt on tt.id = tm.thread_id
        where tm.id = member_updates.transcript_message_id
          and tt.network_id = member_updates.network_id
      )
    )
    and (
      entity_id is null
      or exists (
        select 1
        from app.entities e
        where e.id = member_updates.entity_id
          and e.network_id = member_updates.network_id
      )
    )
    and (
      entity_version_id is null
      or exists (
        select 1
        from app.entity_versions ev
        join app.entities e on e.id = ev.entity_id
        where ev.id = member_updates.entity_version_id
          and e.network_id = member_updates.network_id
      )
    )
  );

drop policy if exists member_updates_delete_none on app.member_updates;
create policy member_updates_delete_none on app.member_updates
  for delete
  using (false);

alter table app.member_update_receipts enable row level security;
alter table app.member_update_receipts force row level security;

drop policy if exists member_update_receipts_select_recipient_scope on app.member_update_receipts;
create policy member_update_receipts_select_recipient_scope on app.member_update_receipts
  for select
  using (
    recipient_member_id = app.current_actor_member_id()
  );

drop policy if exists member_update_receipts_insert_recipient_scope on app.member_update_receipts;
create policy member_update_receipts_insert_recipient_scope on app.member_update_receipts
  for insert
  with check (
    recipient_member_id = app.current_actor_member_id()
    and created_by_member_id = app.current_actor_member_id()
    and exists (
      select 1
      from app.member_updates mu
      where mu.id = member_update_receipts.member_update_id
        and mu.recipient_member_id = member_update_receipts.recipient_member_id
        and mu.network_id = member_update_receipts.network_id
    )
  );

drop policy if exists member_update_receipts_delete_none on app.member_update_receipts;
create policy member_update_receipts_delete_none on app.member_update_receipts
  for delete
  using (false);

drop view if exists app.current_dm_inbox_threads;
create view app.current_dm_inbox_threads as
with thread_messages as (
  select
    tt.id as thread_id,
    tt.network_id,
    participant.recipient_member_id,
    case
      when tt.created_by_member_id = participant.recipient_member_id then tt.counterpart_member_id
      else tt.created_by_member_id
    end as counterpart_member_id,
    tm.id as message_id,
    tm.sender_member_id,
    tm.role,
    tm.message_text,
    tm.created_at,
    row_number() over (partition by participant.recipient_member_id, tt.id order by tm.created_at desc, tm.id desc) as latest_row_no
  from app.transcript_threads tt
  join (
    select tt_inner.id as thread_id, tt_inner.created_by_member_id as recipient_member_id
    from app.transcript_threads tt_inner
    where tt_inner.kind = 'dm'
      and tt_inner.archived_at is null
      and tt_inner.created_by_member_id is not null
    union
    select tt_inner.id as thread_id, tt_inner.counterpart_member_id as recipient_member_id
    from app.transcript_threads tt_inner
    where tt_inner.kind = 'dm'
      and tt_inner.archived_at is null
      and tt_inner.counterpart_member_id is not null
  ) participant on participant.thread_id = tt.id
  join app.transcript_messages tm on tm.thread_id = tt.id
  where tt.kind = 'dm'
    and tt.archived_at is null
),
unread_messages as (
  select
    pmu.recipient_member_id,
    tm.thread_id,
    count(distinct pmu.transcript_message_id)::int as unread_message_count,
    count(*)::int as unread_update_count,
    max(tm.created_at) as latest_unread_message_created_at
  from app.pending_member_updates pmu
  join app.transcript_messages tm on tm.id = pmu.transcript_message_id
  join app.transcript_threads tt on tt.id = tm.thread_id
  where pmu.topic = 'transcript.message.created'
    and pmu.transcript_message_id is not null
    and tt.kind = 'dm'
    and tt.archived_at is null
  group by pmu.recipient_member_id, tm.thread_id
)
select
  tm.recipient_member_id,
  tm.network_id,
  tm.thread_id,
  tm.counterpart_member_id,
  tm.message_id as latest_message_id,
  tm.sender_member_id as latest_sender_member_id,
  tm.role as latest_role,
  tm.message_text as latest_message_text,
  tm.created_at as latest_created_at,
  coalesce(um.unread_message_count, 0) as unread_message_count,
  coalesce(um.unread_update_count, 0) as unread_update_count,
  um.latest_unread_message_created_at::timestamptz as latest_unread_message_created_at,
  (coalesce(um.unread_message_count, 0) > 0) as has_unread
from thread_messages tm
left join unread_messages um
  on um.recipient_member_id = tm.recipient_member_id
 and um.thread_id = tm.thread_id
where tm.latest_row_no = 1;

commit;
