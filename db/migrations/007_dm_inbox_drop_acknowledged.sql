drop index if exists dm_inbox_entries_unread_idx;
drop index if exists dm_inbox_entries_unread_poll_idx;
drop index if exists dm_inbox_entries_unread_thread_idx;

alter table dm_inbox_entries
  drop column if exists acknowledged;
