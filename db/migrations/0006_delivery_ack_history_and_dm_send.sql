begin;

alter table app.delivery_acknowledgements
  add column if not exists version_no integer,
  add column if not exists supersedes_acknowledgement_id app.short_id references app.delivery_acknowledgements(id);

update app.delivery_acknowledgements
set version_no = 1
where version_no is null;

alter table app.delivery_acknowledgements
  alter column version_no set default 1,
  alter column version_no set not null;

alter table app.delivery_acknowledgements
  drop constraint if exists delivery_acknowledgements_delivery_id_recipient_member_id_key;

alter table app.delivery_acknowledgements
  add constraint delivery_acknowledgements_delivery_recipient_version_key
  unique (delivery_id, recipient_member_id, version_no);

create index if not exists delivery_acknowledgements_delivery_recipient_version_idx
  on app.delivery_acknowledgements (delivery_id, recipient_member_id, version_no desc, created_at desc);

create or replace view app.current_delivery_acknowledgements as
select distinct on (delivery_id, recipient_member_id)
  id,
  delivery_id,
  recipient_member_id,
  network_id,
  state,
  suppression_reason,
  version_no,
  supersedes_acknowledgement_id,
  created_at,
  created_by_member_id
from app.delivery_acknowledgements
order by delivery_id, recipient_member_id, version_no desc, created_at desc;

create or replace view app.pending_deliveries as
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
left join app.current_delivery_acknowledgements da
  on da.delivery_id = d.id
 and da.recipient_member_id = d.recipient_member_id
where da.id is null
  and d.status = 'sent';

commit;
