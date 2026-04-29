-- Add a monotonic inbox cursor for resumable DM SSE frames.
-- Existing rows are backfilled deterministically by created_at/id rather than heap order.

create sequence if not exists dm_inbox_seq;

alter sequence dm_inbox_seq owner to clawclub_app;

alter table dm_inbox_entries
  add column if not exists inbox_seq bigint;

with ordered as (
  select id, row_number() over (order by created_at asc, id asc) as seq
  from dm_inbox_entries
)
update dm_inbox_entries ie
set inbox_seq = ordered.seq
from ordered
where ordered.id = ie.id
  and ie.inbox_seq is null;

select setval(
  'dm_inbox_seq',
  coalesce((select max(inbox_seq) from dm_inbox_entries), 1),
  exists (select 1 from dm_inbox_entries where inbox_seq is not null)
);

alter table dm_inbox_entries
  alter column inbox_seq set default nextval('dm_inbox_seq'),
  alter column inbox_seq set not null;

alter sequence dm_inbox_seq owned by dm_inbox_entries.inbox_seq;

create index if not exists dm_inbox_entries_recipient_seq_idx
  on dm_inbox_entries (recipient_member_id, inbox_seq);
