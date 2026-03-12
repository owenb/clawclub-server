begin;

create table app.delivery_attempts (
  id app.short_id primary key default app.new_id(),
  delivery_id app.short_id not null references app.deliveries(id),
  network_id app.short_id references app.networks(id),
  endpoint_id app.short_id not null references app.delivery_endpoints(id),
  worker_key text,
  status app.delivery_status not null check (status in ('processing', 'sent', 'failed', 'canceled')),
  attempt_no integer not null check (attempt_no > 0),
  response_status_code integer,
  response_body text,
  error_message text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_by_member_id app.short_id references app.members(id),
  check (
    (status = 'processing' and finished_at is null)
    or (status in ('sent', 'failed', 'canceled') and finished_at is not null)
  )
);

create unique index delivery_attempts_delivery_attempt_no_idx
  on app.delivery_attempts (delivery_id, attempt_no);

create index delivery_attempts_network_started_idx
  on app.delivery_attempts (network_id, started_at desc);

create index delivery_attempts_endpoint_started_idx
  on app.delivery_attempts (endpoint_id, started_at desc);

create or replace view app.current_delivery_attempts as
select distinct on (delivery_id)
  id,
  delivery_id,
  network_id,
  endpoint_id,
  worker_key,
  status,
  attempt_no,
  response_status_code,
  response_body,
  error_message,
  started_at,
  finished_at,
  created_by_member_id
from app.delivery_attempts
order by delivery_id, attempt_no desc, started_at desc, id desc;

commit;
