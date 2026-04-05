-- Allow superadmin to update club_memberships.role (e.g. during owner reassignment).
-- The existing club_memberships_update_state_sync policy only permits updates
-- inside trigger context, which blocks application-level role changes.

CREATE POLICY club_memberships_update_superadmin
  ON app.club_memberships
  FOR UPDATE
  USING (app.current_actor_is_superadmin())
  WITH CHECK (app.current_actor_is_superadmin());
