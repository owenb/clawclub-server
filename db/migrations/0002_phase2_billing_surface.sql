-- Phase 2: Billing surface — club pricing, approved-price snapshot, view updates.
-- Requires phase 1 migration (0001_phase1_access_state_rewrite.sql) to have been applied.
-- NOTE: Do NOT wrap in BEGIN/COMMIT — the migration runner uses --single-transaction.

-- ============================================================
-- 1. Add pricing columns to clubs
-- ============================================================

ALTER TABLE app.clubs ADD COLUMN IF NOT EXISTS membership_price_amount numeric(12,2);
ALTER TABLE app.clubs ADD COLUMN IF NOT EXISTS membership_price_currency text NOT NULL DEFAULT 'USD';

DO $$ BEGIN
  ALTER TABLE app.clubs ADD CONSTRAINT clubs_price_check
    CHECK (membership_price_amount IS NULL OR membership_price_amount >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE app.clubs ADD CONSTRAINT clubs_currency_check
    CHECK (membership_price_currency ~ '^[A-Z]{3}$');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- 2. Add pricing columns to club_versions
-- ============================================================

ALTER TABLE app.club_versions ADD COLUMN IF NOT EXISTS membership_price_amount numeric(12,2);
ALTER TABLE app.club_versions ADD COLUMN IF NOT EXISTS membership_price_currency text NOT NULL DEFAULT 'USD';

DO $$ BEGIN
  ALTER TABLE app.club_versions ADD CONSTRAINT club_versions_price_check
    CHECK (membership_price_amount IS NULL OR membership_price_amount >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE app.club_versions ADD CONSTRAINT club_versions_currency_check
    CHECK (membership_price_currency ~ '^[A-Z]{3}$');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- 3. Update versioned field lock trigger for pricing
-- ============================================================

CREATE OR REPLACE FUNCTION app.lock_club_versioned_mutation() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    IF tg_op <> 'UPDATE' THEN RETURN NEW; END IF;
    IF coalesce(current_setting('app.allow_club_version_sync', true), '') = '1' THEN
        RETURN NEW;
    END IF;
    IF NEW.owner_member_id IS DISTINCT FROM OLD.owner_member_id THEN
        RAISE EXCEPTION 'clubs.owner_member_id must change via club_versions';
    END IF;
    IF NEW.name IS DISTINCT FROM OLD.name THEN
        RAISE EXCEPTION 'clubs.name must change via club_versions';
    END IF;
    IF NEW.summary IS DISTINCT FROM OLD.summary THEN
        RAISE EXCEPTION 'clubs.summary must change via club_versions';
    END IF;
    IF NEW.admission_policy IS DISTINCT FROM OLD.admission_policy THEN
        RAISE EXCEPTION 'clubs.admission_policy must change via club_versions';
    END IF;
    IF NEW.membership_price_amount IS DISTINCT FROM OLD.membership_price_amount THEN
        RAISE EXCEPTION 'clubs.membership_price_amount must change via club_versions';
    END IF;
    IF NEW.membership_price_currency IS DISTINCT FROM OLD.membership_price_currency THEN
        RAISE EXCEPTION 'clubs.membership_price_currency must change via club_versions';
    END IF;
    RETURN NEW;
END;
$$;

-- ============================================================
-- 4. Update club version sync trigger for pricing
-- ============================================================

CREATE OR REPLACE FUNCTION app.sync_club_version_to_club() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM set_config('app.allow_club_version_sync', '1', true);
    UPDATE app.clubs c SET
        owner_member_id           = NEW.owner_member_id,
        name                      = NEW.name,
        summary                   = NEW.summary,
        admission_policy          = NEW.admission_policy,
        membership_price_amount   = NEW.membership_price_amount,
        membership_price_currency = NEW.membership_price_currency
    WHERE c.id = NEW.club_id;
    PERFORM set_config('app.allow_club_version_sync', '', true);
    RETURN NEW;
EXCEPTION
    WHEN others THEN
        PERFORM set_config('app.allow_club_version_sync', '', true);
        RAISE;
END;
$$;

-- ============================================================
-- 5. Add approved-price columns to memberships
-- ============================================================

ALTER TABLE app.memberships ADD COLUMN IF NOT EXISTS approved_price_amount numeric(12,2);
ALTER TABLE app.memberships ADD COLUMN IF NOT EXISTS approved_price_currency text;

-- ============================================================
-- 6. Update current_memberships view to include approved price
-- ============================================================

-- Drop dependent views first
DROP VIEW IF EXISTS app.accessible_memberships;
DROP VIEW IF EXISTS app.active_memberships;
DROP VIEW IF EXISTS app.current_memberships;

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
        m.approved_price_amount,
        m.approved_price_currency,
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
