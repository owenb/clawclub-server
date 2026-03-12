begin;

create or replace view app.current_dm_inbox_threads as
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
    cdr.recipient_member_id,
    tm.thread_id,
    count(distinct cdr.transcript_message_id)::int as unread_message_count,
    count(*)::int as unread_delivery_count,
    max(tm.created_at) as latest_unread_message_created_at
  from app.current_delivery_receipts cdr
  join app.transcript_messages tm on tm.id = cdr.transcript_message_id
  join app.transcript_threads tt on tt.id = tm.thread_id
  where cdr.topic = 'transcript.message.created'
    and cdr.transcript_message_id is not null
    and cdr.acknowledgement_id is null
    and tt.kind = 'dm'
    and tt.archived_at is null
  group by cdr.recipient_member_id, tm.thread_id
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
  coalesce(um.unread_delivery_count, 0) as unread_delivery_count,
  um.latest_unread_message_created_at::timestamptz as latest_unread_message_created_at,
  (coalesce(um.unread_message_count, 0) > 0) as has_unread
from thread_messages tm
left join unread_messages um
  on um.recipient_member_id = tm.recipient_member_id
 and um.thread_id = tm.thread_id
where tm.latest_row_no = 1;

create index if not exists transcript_messages_thread_created_desc_idx
  on app.transcript_messages (thread_id, created_at desc, id desc);

commit;
