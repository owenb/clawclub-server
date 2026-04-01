begin;

do $$
begin
  if not exists (
    select 1
    from pg_roles
    where rolname = 'clawclub_security_definer_owner'
  ) then
    create role clawclub_security_definer_owner
      nologin
      nosuperuser
      nocreatedb
      nocreaterole
      noinherit
      noreplication;
  end if;

  if not exists (
    select 1
    from pg_roles
    where rolname = 'clawclub_token_auth_owner'
  ) then
    create role clawclub_token_auth_owner
      nologin
      nosuperuser
      nocreatedb
      nocreaterole
      noinherit
      noreplication;
  end if;

  if not exists (
    select 1
    from pg_roles
    where rolname = 'clawclub_cold_application_owner'
  ) then
    create role clawclub_cold_application_owner
      nologin
      nosuperuser
      nocreatedb
      nocreaterole
      noinherit
      noreplication;
  end if;
end
$$;

grant usage on schema app to clawclub_security_definer_owner;
grant usage on schema app to clawclub_token_auth_owner;
grant usage on schema app to clawclub_cold_application_owner;

grant select on all tables in schema app to clawclub_security_definer_owner;
grant execute on all functions in schema app to clawclub_security_definer_owner;

grant select, update on table app.member_bearer_tokens to clawclub_token_auth_owner;

grant select on table app.networks to clawclub_cold_application_owner;
grant select, insert, update, delete on table app.cold_application_challenges to clawclub_cold_application_owner;
grant select, insert on table app.applications to clawclub_cold_application_owner;
grant insert on table app.application_versions to clawclub_cold_application_owner;
grant execute on all functions in schema app to clawclub_cold_application_owner;

alter default privileges in schema app
  grant select on tables to clawclub_security_definer_owner;

alter default privileges in schema app
  grant execute on functions to clawclub_security_definer_owner;

alter default privileges in schema app
  grant execute on functions to clawclub_cold_application_owner;

create or replace function app.authenticate_member_bearer_token(target_token_id app.short_id, target_token_hash text)
returns table(member_id app.short_id)
language plpgsql
security definer
set search_path = app, pg_temp
as $$
begin
  return query
    update app.member_bearer_tokens mbt
       set last_used_at = now()
     where mbt.id = target_token_id
       and mbt.token_hash = target_token_hash
       and mbt.revoked_at is null
    returning mbt.member_id;
end;
$$;

alter function app.authenticate_member_bearer_token(app.short_id, text) owner to clawclub_token_auth_owner;

create or replace function app.create_cold_application_challenge(
  target_network_slug text,
  target_applicant_email text,
  target_applicant_name text,
  target_difficulty integer,
  target_ttl_ms integer
)
returns table(
  challenge_id app.short_id,
  expires_at text
)
language plpgsql
security definer
set search_path = app, pg_temp
as $$
begin
  delete from app.cold_application_challenges c
  where c.expires_at <= now();

  return query
    with target_network as (
      select n.id as network_id
      from app.networks n
      where n.slug = target_network_slug
        and n.archived_at is null
      limit 1
    ), inserted as (
      insert into app.cold_application_challenges as c (
        network_id,
        applicant_email,
        applicant_name,
        difficulty,
        expires_at
      )
      select
        target_network.network_id,
        target_applicant_email,
        target_applicant_name,
        target_difficulty,
        now() + (target_ttl_ms::integer * interval '1 millisecond')
      from target_network
      returning
        id as challenge_id,
        c.expires_at::text as challenge_expires_at
    )
    select inserted.challenge_id, inserted.challenge_expires_at
    from inserted;
end;
$$;

create or replace function app.get_cold_application_challenge(target_challenge_id app.short_id)
returns table(
  challenge_id app.short_id,
  network_id app.short_id,
  applicant_email text,
  applicant_name text,
  difficulty integer,
  expires_at text
)
language sql
security definer
set search_path = app, pg_temp
as $$
  select
    c.id as challenge_id,
    c.network_id,
    c.applicant_email,
    c.applicant_name,
    c.difficulty,
    c.expires_at::text as expires_at
  from app.cold_application_challenges c
  where c.id = target_challenge_id
  limit 1
  for update
$$;

create or replace function app.delete_cold_application_challenge(target_challenge_id app.short_id)
returns boolean
language sql
security definer
set search_path = app, pg_temp
as $$
  with deleted as (
    delete from app.cold_application_challenges c
    where c.id = target_challenge_id
    returning 1
  )
  select exists (
    select 1
    from deleted
  )
$$;

create or replace function app.consume_cold_application_challenge(target_challenge_id app.short_id)
returns table(application_id app.short_id)
language sql
security definer
set search_path = app, pg_temp
as $$
  with challenge as (
    delete from app.cold_application_challenges c
    where c.id = target_challenge_id
    returning
      c.network_id,
      c.applicant_email,
      c.applicant_name
  ), inserted as (
    insert into app.applications (
      network_id,
      path,
      applicant_email,
      applicant_name
    )
    select
      challenge.network_id,
      'cold',
      challenge.applicant_email,
      challenge.applicant_name
    from challenge
    returning id as application_id
  ), version_insert as (
    insert into app.application_versions (
      application_id,
      status,
      notes,
      version_no
    )
    select
      inserted.application_id,
      'submitted',
      'Cold application submitted after proof verification',
      1
    from inserted
  )
  select inserted.application_id
  from inserted
$$;

alter function app.create_cold_application_challenge(text, text, text, integer, integer) owner to clawclub_cold_application_owner;
alter function app.get_cold_application_challenge(app.short_id) owner to clawclub_cold_application_owner;
alter function app.delete_cold_application_challenge(app.short_id) owner to clawclub_cold_application_owner;
alter function app.consume_cold_application_challenge(app.short_id) owner to clawclub_cold_application_owner;

alter function app.member_is_active(app.short_id) owner to clawclub_security_definer_owner;
alter function app.resolve_active_member_id_by_handle(text) owner to clawclub_security_definer_owner;
alter function app.membership_has_live_subscription(app.short_id) owner to clawclub_security_definer_owner;
alter function app.actor_has_network_access(app.short_id) owner to clawclub_security_definer_owner;
alter function app.actor_is_network_owner(app.short_id) owner to clawclub_security_definer_owner;
alter function app.current_actor_is_superadmin() owner to clawclub_security_definer_owner;
alter function app.actor_can_access_member(app.short_id) owner to clawclub_security_definer_owner;
alter function app.membership_belongs_to_current_actor(app.short_id) owner to clawclub_security_definer_owner;
alter function app.entity_is_currently_published(app.short_id) owner to clawclub_security_definer_owner;

alter table app.locations enable row level security;
alter table app.locations force row level security;

alter table app.member_locations enable row level security;
alter table app.member_locations force row level security;

alter table app.entity_locations enable row level security;
alter table app.entity_locations force row level security;

alter table app.media_links enable row level security;
alter table app.media_links force row level security;

alter table app.entity_media_links enable row level security;
alter table app.entity_media_links force row level security;

alter table app.embeddings enable row level security;
alter table app.embeddings force row level security;

drop policy if exists members_select_security_definer_owner on app.members;
create policy members_select_security_definer_owner on app.members
  for select
  using (current_user = 'clawclub_security_definer_owner');

drop policy if exists member_global_role_versions_select_security_definer_owner on app.member_global_role_versions;
create policy member_global_role_versions_select_security_definer_owner on app.member_global_role_versions
  for select
  using (current_user = 'clawclub_security_definer_owner');

drop policy if exists networks_select_security_definer_owner on app.networks;
create policy networks_select_security_definer_owner on app.networks
  for select
  using (current_user = 'clawclub_security_definer_owner');

drop policy if exists network_memberships_select_security_definer_owner on app.network_memberships;
create policy network_memberships_select_security_definer_owner on app.network_memberships
  for select
  using (current_user = 'clawclub_security_definer_owner');

drop policy if exists network_membership_state_versions_select_security_definer_owner on app.network_membership_state_versions;
create policy network_membership_state_versions_select_security_definer_owner on app.network_membership_state_versions
  for select
  using (current_user = 'clawclub_security_definer_owner');

drop policy if exists subscriptions_select_security_definer_owner on app.subscriptions;
create policy subscriptions_select_security_definer_owner on app.subscriptions
  for select
  using (current_user = 'clawclub_security_definer_owner');

drop policy if exists applications_select_security_definer_owner on app.applications;
create policy applications_select_security_definer_owner on app.applications
  for select
  using (current_user = 'clawclub_security_definer_owner');

drop policy if exists entity_versions_select_security_definer_owner on app.entity_versions;
create policy entity_versions_select_security_definer_owner on app.entity_versions
  for select
  using (current_user = 'clawclub_security_definer_owner');

drop policy if exists member_bearer_tokens_select_auth_owner on app.member_bearer_tokens;
create policy member_bearer_tokens_select_auth_owner on app.member_bearer_tokens
  for select
  using (current_user = 'clawclub_token_auth_owner');

drop policy if exists member_bearer_tokens_update_actor_scope on app.member_bearer_tokens;
create policy member_bearer_tokens_update_actor_scope on app.member_bearer_tokens
  for update
  using (
    member_id = app.current_actor_member_id()
    or current_user = 'clawclub_token_auth_owner'
  )
  with check (
    member_id = app.current_actor_member_id()
    or current_user = 'clawclub_token_auth_owner'
  );

drop policy if exists networks_select_public_cold_application_owner on app.networks;
create policy networks_select_public_cold_application_owner on app.networks
  for select
  using (
    current_user = 'clawclub_cold_application_owner'
    and archived_at is null
  );

drop policy if exists cold_application_challenges_select_cold on app.cold_application_challenges;
drop policy if exists cold_application_challenges_insert_cold on app.cold_application_challenges;
drop policy if exists cold_application_challenges_delete_cold on app.cold_application_challenges;

create policy cold_application_challenges_select_cold_owner on app.cold_application_challenges
  for select
  using (current_user = 'clawclub_cold_application_owner');

create policy cold_application_challenges_insert_cold_owner on app.cold_application_challenges
  for insert
  with check (current_user = 'clawclub_cold_application_owner');

create policy cold_application_challenges_delete_cold_owner on app.cold_application_challenges
  for delete
  using (current_user = 'clawclub_cold_application_owner');

drop policy if exists cold_application_challenges_update_cold_owner on app.cold_application_challenges;
create policy cold_application_challenges_update_cold_owner on app.cold_application_challenges
  for update
  using (current_user = 'clawclub_cold_application_owner')
  with check (current_user = 'clawclub_cold_application_owner');

drop policy if exists applications_select_cold on app.applications;
drop policy if exists applications_select_cold_owner on app.applications;
create policy applications_select_cold_owner on app.applications
  for select
  using (
    path = 'cold'
    and current_user = 'clawclub_cold_application_owner'
  );

drop policy if exists applications_insert_cold on app.applications;
drop policy if exists applications_update_cold on app.applications;

create policy applications_insert_cold_owner on app.applications
  for insert
  with check (
    path = 'cold'
    and current_user = 'clawclub_cold_application_owner'
  );

drop policy if exists application_versions_select_cold on app.application_versions;
drop policy if exists application_versions_insert_cold on app.application_versions;

create policy application_versions_insert_cold_owner on app.application_versions
  for insert
  with check (current_user = 'clawclub_cold_application_owner');

drop policy if exists embeddings_select_profile_scope on app.embeddings;
create policy embeddings_select_profile_scope on app.embeddings
  for select
  using (
    member_profile_version_id is not null
    and exists (
      select 1
      from app.member_profile_versions mpv
      where mpv.id = embeddings.member_profile_version_id
        and app.actor_can_access_member(mpv.member_id)
    )
  );

drop policy if exists embeddings_select_entity_scope on app.embeddings;
create policy embeddings_select_entity_scope on app.embeddings
  for select
  using (
    entity_version_id is not null
    and exists (
      select 1
      from app.entity_versions ev
      join app.entities e on e.id = ev.entity_id
      where ev.id = embeddings.entity_version_id
        and e.deleted_at is null
        and app.entity_is_currently_published(e.id)
        and app.actor_has_network_access(e.network_id)
    )
  );

do $$
declare
  view_name text;
begin
  if exists (
    select 1
    from pg_roles
    where rolname = 'clawclub_view_owner'
  ) then
    for view_name in
      select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'app'
        and c.relkind = 'v'
    loop
      execute format('alter view app.%I owner to clawclub_view_owner', view_name);
    end loop;
  end if;
end
$$;

commit;
