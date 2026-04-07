-- Phase 1: Access-state rewrite for billing preparation.
-- Adds new membership states, is_comped flag, rewrites access view.
-- Requires PostgreSQL 12+ (ALTER TYPE ADD VALUE in transactions).
-- NOTE: Do NOT wrap in BEGIN/COMMIT — the migration runner uses --single-transaction.

-- ============================================================
-- 1. Add new enum values
-- ============================================================

ALTER TYPE app.member_state ADD VALUE IF NOT EXISTS 'banned';

ALTER TYPE app.membership_state ADD VALUE IF NOT EXISTS 'payment_pending';
ALTER TYPE app.membership_state ADD VALUE IF NOT EXISTS 'renewal_pending';
ALTER TYPE app.membership_state ADD VALUE IF NOT EXISTS 'cancelled';
ALTER TYPE app.membership_state ADD VALUE IF NOT EXISTS 'banned';
ALTER TYPE app.membership_state ADD VALUE IF NOT EXISTS 'expired';

-- ============================================================
-- 2. Add is_comped columns to memberships
-- ============================================================

ALTER TABLE app.memberships ADD COLUMN IF NOT EXISTS is_comped boolean NOT NULL DEFAULT false;
ALTER TABLE app.memberships ADD COLUMN IF NOT EXISTS comped_at timestamptz;
ALTER TABLE app.memberships ADD COLUMN IF NOT EXISTS comped_by_member_id app.short_id;

-- FK constraint (safe if already exists)
DO $$ BEGIN
  ALTER TABLE app.memberships
    ADD CONSTRAINT memberships_comped_by_fkey
    FOREIGN KEY (comped_by_member_id) REFERENCES app.members(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- 3. Backfill is_comped from $0 subscriptions
-- ============================================================

UPDATE app.memberships m
SET is_comped = true, comped_at = s.started_at
FROM app.subscriptions s
WHERE s.membership_id = m.id
  AND s.amount = 0
  AND s.status = 'active'
  AND m.is_comped = false;

-- ============================================================
-- 4. Drop views (reverse dependency order)
-- ============================================================

DROP VIEW IF EXISTS app.accessible_memberships;
DROP VIEW IF EXISTS app.active_memberships;
DROP VIEW IF EXISTS app.current_memberships;

-- ============================================================
-- 5. Recreate views
-- ============================================================

CREATE VIEW app.current_memberships AS
    SELECT
        m.id,
        m.club_id,
        m.member_id,
        m.sponsor_member_id,
        m.role,
        m.status,
        m.joined_at,
        m.left_at,
        m.accepted_covenant_at,
        m.metadata,
        m.source_admission_id,
        m.is_comped,
        m.comped_at,
        m.comped_by_member_id,
        cms.id              AS state_version_id,
        cms.reason          AS state_reason,
        cms.version_no      AS state_version_no,
        cms.created_at      AS state_created_at,
        cms.created_by_member_id AS state_created_by_member_id
    FROM app.memberships m
    LEFT JOIN app.current_membership_states cms ON cms.membership_id = m.id;

CREATE VIEW app.active_memberships AS
    SELECT * FROM app.current_memberships
    WHERE status = 'active' AND left_at IS NULL;

CREATE VIEW app.accessible_memberships AS
    SELECT cm.*
    FROM app.current_memberships cm
    WHERE cm.left_at IS NULL
      AND (
          -- Club admins always have access
          cm.role = 'clubadmin'
          -- Comped members: access without subscription
          OR (cm.is_comped = true AND cm.status = 'active')
          -- Paid members: active or cancelled with live subscription
          OR (
              cm.status IN ('active', 'cancelled')
              AND EXISTS (
                  SELECT 1 FROM app.subscriptions s
                  WHERE s.membership_id = cm.id
                    AND s.status IN ('trialing', 'active', 'past_due')
                    AND coalesce(s.ended_at, 'infinity'::timestamptz) > now()
                    AND coalesce(s.current_period_end, 'infinity'::timestamptz) > now()
              )
          )
          -- Grace period: 7 days from state entry, regardless of subscription dates
          OR (
              cm.status = 'renewal_pending'
              AND cm.state_created_at + interval '7 days' > now()
          )
      );

-- ============================================================
-- 6. Replace sync_membership_state trigger function
-- ============================================================

CREATE OR REPLACE FUNCTION app.sync_membership_state() RETURNS trigger
    LANGUAGE plpgsql
AS $$
DECLARE
    mirrored_left_at timestamptz;
BEGIN
    mirrored_left_at := CASE
        WHEN NEW.status IN ('revoked', 'rejected', 'expired', 'banned', 'removed') THEN NEW.created_at
        ELSE NULL
    END;
    PERFORM set_config('app.allow_membership_state_sync', '1', true);
    UPDATE app.memberships m
       SET status = NEW.status,
           left_at = mirrored_left_at
     WHERE m.id = NEW.membership_id;
    PERFORM set_config('app.allow_membership_state_sync', '', true);
    RETURN NEW;
EXCEPTION
    WHEN others THEN
        PERFORM set_config('app.allow_membership_state_sync', '', true);
        RAISE;
END;
$$;

-- ============================================================
-- 7. Guard + create unique partial index on subscriptions
-- ============================================================

DO $$
DECLARE
  dup_count integer;
BEGIN
  SELECT count(*) INTO dup_count
  FROM (
    SELECT membership_id
    FROM app.subscriptions
    WHERE status IN ('active', 'trialing', 'past_due')
    GROUP BY membership_id
    HAVING count(*) > 1
  ) x;

  IF dup_count > 0 THEN
    RAISE EXCEPTION 'Found % memberships with multiple live subscriptions. Clean up before migration.', dup_count;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_one_live_per_membership
    ON app.subscriptions (membership_id) WHERE status IN ('active', 'trialing', 'past_due');

-- ============================================================
-- 8. Delete orphaned $0 subscriptions (replaced by is_comped)
-- ============================================================

DELETE FROM app.subscriptions s
WHERE s.amount = 0
  AND s.status = 'active'
  AND EXISTS (
    SELECT 1 FROM app.memberships m
    WHERE m.id = s.membership_id AND m.is_comped = true
  );
