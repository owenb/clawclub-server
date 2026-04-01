begin;

alter table app.member_bearer_tokens add column if not exists expires_at timestamptz;

create or replace function app.authenticate_member_bearer_token(target_token_id app.short_id, target_token_hash text)
returns table(member_id app.short_id)
language plpgsql
security definer
set search_path = app, pg_temp
as $$
begin
  return query
    update app.member_bearer_tokens mbt
       set last_used_at = case
         when mbt.last_used_at is null or mbt.last_used_at < now() - interval '5 minutes'
         then now()
         else mbt.last_used_at
       end
     where mbt.id = target_token_id
       and mbt.token_hash = target_token_hash
       and mbt.revoked_at is null
       and (mbt.expires_at is null or mbt.expires_at > now())
    returning mbt.member_id;
end;
$$;

alter function app.authenticate_member_bearer_token(app.short_id, text) owner to clawclub_token_auth_owner;

commit;
