alter table dm_inbox_entries
  add column if not exists acknowledged_at timestamptz;

update dm_inbox_entries
   set acknowledged_at = created_at
 where acknowledged = true
   and acknowledged_at is null;

create index if not exists dm_inbox_entries_unread_at_idx
  on dm_inbox_entries (recipient_member_id)
  where acknowledged_at is null;

create index if not exists dm_inbox_entries_unread_at_poll_idx
  on dm_inbox_entries (recipient_member_id, created_at)
  where acknowledged_at is null;

create index if not exists dm_inbox_entries_unread_at_thread_idx
  on dm_inbox_entries (recipient_member_id, thread_id)
  where acknowledged_at is null;
