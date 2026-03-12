begin;

create or replace view app.current_delivery_receipts as
select
  d.id as delivery_id,
  d.network_id,
  d.recipient_member_id,
  d.endpoint_id,
  d.entity_id,
  d.entity_version_id,
  d.transcript_message_id,
  d.topic,
  d.payload,
  d.status,
  d.attempt_count,
  d.scheduled_at,
  d.sent_at,
  d.failed_at,
  d.last_error,
  d.created_at,
  da.id as acknowledgement_id,
  da.state as acknowledgement_state,
  da.suppression_reason as acknowledgement_suppression_reason,
  da.version_no as acknowledgement_version_no,
  da.supersedes_acknowledgement_id,
  da.created_at as acknowledgement_created_at,
  da.created_by_member_id as acknowledgement_created_by_member_id
from app.deliveries d
left join app.current_delivery_acknowledgements da
  on da.delivery_id = d.id
 and da.recipient_member_id = d.recipient_member_id;

commit;
