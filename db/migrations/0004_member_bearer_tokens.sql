begin;

create table if not exists app.member_bearer_tokens (
  id app.short_id primary key default app.new_id(),
  member_id app.short_id not null references app.members(id),
  label text,
  token_hash text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  unique (token_hash)
);

create index if not exists member_bearer_tokens_member_idx
  on app.member_bearer_tokens (member_id, created_at desc);

create index if not exists member_bearer_tokens_active_idx
  on app.member_bearer_tokens (id)
  where revoked_at is null;

commit;
