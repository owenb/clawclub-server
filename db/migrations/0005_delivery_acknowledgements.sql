begin;

create type app.delivery_ack_state as enum ('shown', 'suppressed');

create table app.delivery_acknowledgements (
  id app.short_id primary key default app.new_id(),
  delivery_id app.short_id not null references app.deliveries(id),
  recipient_member_id app.short_id not null references app.members(id),
  network_id app.short_id references app.networks(id),
  state app.delivery_ack_state not null,
  suppression_reason text,
  created_at timestamptz not null default now(),
  created_by_member_id app.short_id references app.members(id),
  unique (delivery_id, recipient_member_id)
);

create index delivery_acknowledgements_recipient_created_idx
  on app.delivery_acknowledgements (recipient_member_id, created_at desc);

create index delivery_acknowledgements_network_created_idx
  on app.delivery_acknowledgements (network_id, created_at desc);

create view app.pending_deliveries as
select
  d.id,
  d.network_id,
  d.recipient_member_id,
  d.endpoint_id,
  d.entity_id,
  d.entity_version_id,
  d.transcript_message_id,
  d.topic,
  d.payload,
  d.status,
  d.scheduled_at,
  d.sent_at,
  d.failed_at,
  d.created_at
from app.deliveries d
left join app.delivery_acknowledgements da
  on da.delivery_id = d.id
 and da.recipient_member_id = d.recipient_member_id
where da.id is null
  and d.status = 'sent';

commit;
