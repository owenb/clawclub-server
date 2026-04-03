begin;

-- Backfill any members with null handles by deriving from public_name.
-- Uses lowercase, spaces/non-word chars replaced with hyphens, trimmed.
-- Appends a numeric suffix if a collision occurs.
do $$
declare
  rec record;
  base_handle text;
  candidate_handle text;
  suffix int;
begin
  for rec in select id, public_name from app.members where handle is null loop
    base_handle := trim(both '-' from regexp_replace(lower(rec.public_name), '[^a-z0-9]+', '-', 'g'));
    if base_handle = '' then
      base_handle := 'member';
    end if;

    candidate_handle := base_handle;
    suffix := 1;
    while exists (select 1 from app.members where handle = candidate_handle and id <> rec.id) loop
      suffix := suffix + 1;
      candidate_handle := base_handle || '-' || suffix;
    end loop;

    update app.members set handle = candidate_handle where id = rec.id;
  end loop;
end $$;

-- Now enforce NOT NULL
alter table app.members alter column handle set not null;

-- Update create_member_from_admission to generate a handle from public_name
create or replace function app.create_member_from_admission(
  target_public_name text,
  target_email text,
  target_display_name text,
  target_admission_details jsonb
)
returns table(member_id app.short_id)
language plpgsql
security definer
set search_path = app, pg_temp
as $$
declare
  new_member_id app.short_id;
  base_handle text;
  candidate_handle text;
  suffix int;
begin
  -- Derive handle from public_name: lowercase, non-alphanumeric to hyphens
  base_handle := trim(both '-' from regexp_replace(lower(target_public_name), '[^a-z0-9]+', '-', 'g'));
  if base_handle = '' then
    base_handle := 'member';
  end if;

  candidate_handle := base_handle;
  suffix := 1;
  while exists (select 1 from app.members where handle = candidate_handle) loop
    suffix := suffix + 1;
    candidate_handle := base_handle || '-' || suffix;
  end loop;

  -- Create the member
  insert into app.members (public_name, handle, state)
  values (target_public_name, candidate_handle, 'active')
  returning id into new_member_id;

  -- Create private contacts
  if target_email is not null and length(btrim(target_email)) > 0 then
    insert into app.member_private_contacts (member_id, email)
    values (new_member_id, target_email);
  end if;

  -- Create initial profile version
  insert into app.member_profile_versions (
    member_id,
    version_no,
    display_name,
    profile,
    created_by_member_id
  )
  values (
    new_member_id,
    1,
    target_display_name,
    case when target_admission_details ? 'socials' then jsonb_build_object('socials', target_admission_details->'socials') else '{}'::jsonb end,
    new_member_id
  );

  return query select new_member_id;
end;
$$;

alter function app.create_member_from_admission(text, text, text, jsonb)
  owner to clawclub_security_definer_owner;

commit;
