begin;

-- Security definer function to create a comped subscription during admission acceptance.
-- The app role cannot insert subscriptions directly (superadmin-only RLS),
-- so this runs as the security definer owner which gets an explicit grant.

create function app.create_comped_subscription(
  target_membership_id app.short_id,
  payer_member_id app.short_id
)
returns void
language sql
security definer
set search_path = app, pg_temp
as $$
  insert into app.subscriptions (membership_id, payer_member_id, status, amount, currency)
  values (target_membership_id, payer_member_id, 'active', 0, 'GBP');
$$;

alter function app.create_comped_subscription(app.short_id, app.short_id)
  owner to clawclub_security_definer_owner;

grant insert on table app.subscriptions to clawclub_security_definer_owner;

comment on function app.create_comped_subscription(app.short_id, app.short_id) is
  'Creates a zero-amount active subscription so the membership appears in accessible_club_memberships. Called during admission acceptance.';

commit;
