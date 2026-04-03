-- 0053_club_listing_owner_contact.sql
--
-- Return club owner name and email when enumerating clubs, both for cold
-- admission challenges (unauthenticated) and admin/platform club listings.
--
-- Problem: list_publicly_listed_clubs() runs as clawclub_cold_application_owner.
-- If it JOINs members or member_private_contacts directly, their existing RLS
-- policies (which inline-reference views like accessible_club_memberships)
-- trigger GRANT errors because cold_application_owner lacks SELECT on those
-- views.
--
-- Solution: a helper security definer function owned by
-- clawclub_security_definer_owner resolves owner name + email. That role
-- already has the necessary grants. list_publicly_listed_clubs() calls the
-- helper via LATERAL instead of joining the tables directly.

begin;

-- RLS policy: security_definer_owner can SELECT members (needed by the new
-- helper function below; previously only had INSERT policy from 0051)
create policy members_select_definer on app.members
  for select using (current_user = 'clawclub_security_definer_owner');

-- Helper: look up a member's public name and private email
create function app.get_member_public_contact(target_member_id app.short_id)
returns table(member_name text, member_email text)
language sql
stable
security definer
set search_path = app, pg_temp
as $$
  select m.public_name, mpc.email
  from app.members m
  left join app.member_private_contacts mpc on mpc.member_id = m.id
  where m.id = target_member_id;
$$;

alter function app.get_member_public_contact(app.short_id) owner to clawclub_security_definer_owner;

-- Recreate list_publicly_listed_clubs() to include owner name and email.
-- Uses clubs.owner_member_id (always current) and the helper function.
drop function app.list_publicly_listed_clubs();

create function app.list_publicly_listed_clubs()
returns table(slug text, name text, summary text, owner_name text, owner_email text)
language sql
stable
security definer
set search_path = app, pg_temp
as $$
  select
    c.slug,
    c.name,
    c.summary,
    oc.member_name as owner_name,
    oc.member_email as owner_email
  from app.clubs c
  cross join lateral app.get_member_public_contact(c.owner_member_id) oc
  where c.publicly_listed = true
    and c.archived_at is null
  order by c.name asc;
$$;

alter function app.list_publicly_listed_clubs() owner to clawclub_cold_application_owner;

commit;
