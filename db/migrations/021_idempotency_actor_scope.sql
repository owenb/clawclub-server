-- Scope durable idempotency rows to the actor context so two callers can
-- safely reuse the same clientKey without creating cross-actor conflicts.
alter table idempotency_keys
  drop constraint idempotency_keys_pkey;

alter table idempotency_keys
  add constraint idempotency_keys_pkey primary key (actor_context, client_key);
