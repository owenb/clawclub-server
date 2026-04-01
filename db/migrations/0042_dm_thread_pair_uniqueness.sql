begin;

create unique index transcript_threads_live_dm_pair_unique_idx
  on app.transcript_threads (
    network_id,
    least(created_by_member_id::text, counterpart_member_id::text),
    greatest(created_by_member_id::text, counterpart_member_id::text)
  )
  where kind = 'dm'
    and archived_at is null
    and created_by_member_id is not null
    and counterpart_member_id is not null;

commit;
