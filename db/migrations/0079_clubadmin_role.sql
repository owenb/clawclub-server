-- Permissions overhaul: introduce clubadmin role.
--
-- Replaces the owner-only admin model with a delegable clubadmin role.
-- Club ownership (billing/curation) stays on clubs.owner_member_id via club_owner_versions.
-- Operational admin (memberships, admissions, moderation) is now role = 'clubadmin'.
-- Multiple members per club can hold the clubadmin role.
-- The club owner's membership is always role = 'clubadmin'.

-- ── 1. Migrate existing role values ─────────────────────────────────────────
-- (enum value 'clubadmin' was added in 0078_clubadmin_role_enum.sql)

UPDATE app.club_memberships SET role = 'clubadmin' WHERE role IN ('owner', 'admin');

-- ── 3. Update sponsor CHECK constraint ──────────────────────────────────────

ALTER TABLE app.club_memberships DROP CONSTRAINT network_memberships_check;

ALTER TABLE app.club_memberships ADD CONSTRAINT club_memberships_sponsor_check
  CHECK (sponsor_member_id IS NOT NULL OR role = 'clubadmin');

-- ── 4. Create actor_is_club_admin() ─────────────────────────────────────────

CREATE FUNCTION app.actor_is_club_admin(target_club_id app.short_id) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'app', 'pg_temp'
    AS $$
  select exists (
    select 1 from app.club_memberships cm
    join app.current_club_membership_states ccms on ccms.membership_id = cm.id
    where cm.member_id = app.current_actor_member_id()
      and cm.club_id = target_club_id
      and ccms.status = 'active'
      and cm.role = 'clubadmin'
  ) or app.current_actor_is_superadmin()
$$;

-- ── 5. Update actor_has_club_access() ───────────────────────────────────────

CREATE OR REPLACE FUNCTION app.actor_has_club_access(target_club_id app.short_id) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'app', 'pg_temp'
    AS $$
  select exists (
    select 1 from app.club_memberships cm
    join app.current_club_membership_states ccms on ccms.membership_id = cm.id
    where cm.member_id = app.current_actor_member_id()
      and cm.club_id = target_club_id
      and ccms.status = 'active'
      and (cm.role = 'clubadmin' or app.membership_has_live_subscription(cm.id))
  )
$$;

-- ── 5b. Update accessible_club_memberships view ─────────────────────────────

CREATE OR REPLACE VIEW app.accessible_club_memberships AS
  SELECT ccm.*
  FROM app.current_club_memberships ccm
  WHERE ccm.status = 'active'
    AND ccm.left_at IS NULL
    AND (ccm.role = 'clubadmin' OR app.membership_has_live_subscription(ccm.id));

-- ── 6. Update actor_can_access_member() ─────────────────────────────────────

CREATE OR REPLACE FUNCTION app.actor_can_access_member(target_member_id app.short_id) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'app', 'pg_temp'
    AS $$
  select
    target_member_id = app.current_actor_member_id()
    or app.current_actor_is_superadmin()
    or exists (
      select 1 from app.accessible_club_memberships acm
      where acm.member_id = target_member_id
        and app.actor_has_club_access(acm.club_id)
    )
    or exists (
      select 1 from app.current_club_memberships ccm
      where ccm.member_id = target_member_id
        and app.actor_is_club_admin(ccm.club_id)
    )
    or exists (
      select 1 from app.admissions a
      where (a.applicant_member_id = target_member_id or a.sponsor_member_id = target_member_id)
        and (
          app.actor_is_club_admin(a.club_id)
          or (
            (a.applicant_member_id = app.current_actor_member_id() or a.sponsor_member_id = app.current_actor_member_id())
            and app.actor_has_club_access(a.club_id)
          )
        )
    )
$$;

-- ── 7. Update RLS policies ──────────────────────────────────────────────────

-- 7a. club_memberships

DROP POLICY club_memberships_insert_owner_scope ON app.club_memberships;
CREATE POLICY club_memberships_insert_admin_scope ON app.club_memberships
  FOR INSERT WITH CHECK (app.current_actor_is_superadmin() OR app.actor_is_club_admin(club_id));

DROP POLICY club_memberships_select_actor_scope ON app.club_memberships;
CREATE POLICY club_memberships_select_actor_scope ON app.club_memberships
  FOR SELECT USING (
    (member_id)::text = (app.current_actor_member_id())::text
    OR app.current_actor_is_superadmin()
    OR app.actor_is_club_owner(club_id)
    OR app.actor_has_club_access(club_id)
  );

-- Allow club owner to UPDATE role for promote/demote
CREATE POLICY club_memberships_update_club_owner
  ON app.club_memberships
  FOR UPDATE
  USING (app.actor_is_club_owner(club_id))
  WITH CHECK (app.actor_is_club_owner(club_id));

-- 7b. club_membership_state_versions

DROP POLICY club_membership_state_versions_insert_owner_scope ON app.club_membership_state_versions;
CREATE POLICY club_membership_state_versions_insert_admin_scope ON app.club_membership_state_versions
  FOR INSERT WITH CHECK (
    (created_by_member_id)::text = (app.current_actor_member_id())::text
    AND EXISTS (
      SELECT 1 FROM app.club_memberships cm
      WHERE (cm.id)::text = (club_membership_state_versions.membership_id)::text
        AND (app.current_actor_is_superadmin() OR app.actor_is_club_admin(cm.club_id))
    )
  );

-- 7c. admissions

DROP POLICY admissions_insert_owner_scope ON app.admissions;
CREATE POLICY admissions_insert_admin_scope ON app.admissions
  FOR INSERT WITH CHECK (app.current_actor_is_superadmin() OR app.actor_is_club_admin(club_id));

DROP POLICY admissions_select_actor_scope ON app.admissions;
CREATE POLICY admissions_select_actor_scope ON app.admissions
  FOR SELECT USING (
    app.current_actor_is_superadmin()
    OR app.actor_is_club_admin(club_id)
    OR (applicant_member_id)::text = (app.current_actor_member_id())::text
    OR (sponsor_member_id)::text = (app.current_actor_member_id())::text
  );

DROP POLICY admissions_update_owner_scope ON app.admissions;
CREATE POLICY admissions_update_admin_scope ON app.admissions
  FOR UPDATE
  USING (app.current_actor_is_superadmin() OR app.actor_is_club_admin(club_id))
  WITH CHECK (app.current_actor_is_superadmin() OR app.actor_is_club_admin(club_id));

-- 7d. admission_versions

DROP POLICY admission_versions_insert_owner_scope ON app.admission_versions;
CREATE POLICY admission_versions_insert_admin_scope ON app.admission_versions
  FOR INSERT WITH CHECK (
    (created_by_member_id)::text = (app.current_actor_member_id())::text
    AND EXISTS (
      SELECT 1 FROM app.admissions a
      WHERE (a.id)::text = (admission_versions.admission_id)::text
        AND (app.current_actor_is_superadmin() OR app.actor_is_club_admin(a.club_id))
    )
  );

DROP POLICY admission_versions_select_actor_scope ON app.admission_versions;
CREATE POLICY admission_versions_select_actor_scope ON app.admission_versions
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM app.admissions a
      WHERE (a.id)::text = (admission_versions.admission_id)::text
        AND (
          app.current_actor_is_superadmin()
          OR app.actor_is_club_admin(a.club_id)
          OR (a.applicant_member_id)::text = (app.current_actor_member_id())::text
          OR (a.sponsor_member_id)::text = (app.current_actor_member_id())::text
        )
    )
  );

-- 7e. member_private_contacts

DROP POLICY member_private_contacts_select_owner ON app.member_private_contacts;
CREATE POLICY member_private_contacts_select_club_admin ON app.member_private_contacts
  FOR SELECT USING (
    EXISTS (
      SELECT 1
      FROM app.accessible_club_memberships admin_acm
      JOIN app.accessible_club_memberships target_acm
        ON (target_acm.club_id)::text = (admin_acm.club_id)::text
        AND (target_acm.member_id)::text = (member_private_contacts.member_id)::text
      WHERE (admin_acm.member_id)::text = (app.current_actor_member_id())::text
        AND admin_acm.role = 'clubadmin'
    )
  );

-- ── 8. Grants ───────────────────────────────────────────────────────────────

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clawclub_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION app.actor_is_club_admin(app.short_id) TO clawclub_app';
  END IF;
END $$;
