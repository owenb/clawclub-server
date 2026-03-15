begin;

drop view if exists app.pending_deliveries;
drop view if exists app.current_delivery_receipts;
drop view if exists app.current_delivery_attempts;
drop view if exists app.current_delivery_acknowledgements;

drop function if exists app.authenticate_delivery_worker_token(app.short_id, text);

drop policy if exists delivery_endpoints_select_actor_scope on app.delivery_endpoints;
drop policy if exists delivery_endpoints_insert_self on app.delivery_endpoints;
drop policy if exists delivery_endpoints_update_actor_scope on app.delivery_endpoints;

drop table if exists app.delivery_attempts;
drop table if exists app.delivery_acknowledgements;
drop table if exists app.delivery_worker_tokens;
drop table if exists app.deliveries;
drop table if exists app.delivery_endpoints;
drop table if exists app.member_entity_update_receipts;

drop type if exists app.delivery_ack_state;
drop type if exists app.delivery_status;
drop type if exists app.delivery_endpoint_state;
drop type if exists app.delivery_channel;

commit;
