begin;

create or replace view app.current_dm_thread_participants as
select
  tt.id as thread_id,
  tt.network_id,
  tt.created_by_member_id as participant_member_id,
  tt.counterpart_member_id as counterpart_member_id
from app.transcript_threads tt
where tt.kind = 'dm'
  and tt.archived_at is null
  and tt.created_by_member_id is not null
  and tt.counterpart_member_id is not null

union all

select
  tt.id as thread_id,
  tt.network_id,
  tt.counterpart_member_id as participant_member_id,
  tt.created_by_member_id as counterpart_member_id
from app.transcript_threads tt
where tt.kind = 'dm'
  and tt.archived_at is null
  and tt.created_by_member_id is not null
  and tt.counterpart_member_id is not null;

create or replace view app.current_dm_inbox_threads as
with thread_messages as (
  select
    participant.thread_id,
    participant.network_id,
    participant.participant_member_id as recipient_member_id,
    participant.counterpart_member_id,
    tm.id as message_id,
    tm.sender_member_id,
    tm.role,
    tm.message_text,
    tm.created_at,
    row_number() over (partition by participant.participant_member_id, participant.thread_id order by tm.created_at desc, tm.id desc) as latest_row_no
  from app.current_dm_thread_participants participant
  join app.transcript_messages tm on tm.thread_id = participant.thread_id
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
