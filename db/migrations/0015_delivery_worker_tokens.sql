begin;

create table if not exists app.delivery_worker_tokens (
  id app.short_id primary key default app.new_id(),
  actor_member_id app.short_id not null references app.members(id),
  label text,
  token_hash text not null,
  allowed_network_ids app.short_id[] not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  check (array_length(allowed_network_ids, 1) is not null)
);

create unique index if not exists delivery_worker_tokens_token_hash_key on app.delivery_worker_tokens (token_hash);
create index if not exists delivery_worker_tokens_actor_member_id_idx on app.delivery_worker_tokens (actor_member_id);

commit;
