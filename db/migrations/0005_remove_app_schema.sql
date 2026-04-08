-- Migration 0005: Remove the `app` schema, move everything to `public`.
--
-- The `app` schema was introduced alongside RLS (since removed).
-- All objects move to `public`; the `app` schema is dropped.
--
-- Idempotent: checks for `app` schema existence before doing anything.

DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'app') THEN
    RAISE NOTICE 'app schema does not exist — migration already applied';
    RETURN;
  END IF;

  -- ================================================================
  -- 1. Drop all views (they store schema-qualified SQL text internally;
  --    we must recreate them with unqualified names after the move).
  -- ================================================================

  DROP VIEW IF EXISTS app.live_entities;
  DROP VIEW IF EXISTS app.published_entity_versions;
  DROP VIEW IF EXISTS app.current_entity_versions;
  DROP VIEW IF EXISTS app.current_event_rsvps;
  DROP VIEW IF EXISTS app.accessible_club_memberships;
  DROP VIEW IF EXISTS app.active_club_memberships;
  DROP VIEW IF EXISTS app.current_club_memberships;
  DROP VIEW IF EXISTS app.current_club_membership_states;
  DROP VIEW IF EXISTS app.current_admissions;
  DROP VIEW IF EXISTS app.current_admission_versions;
  DROP VIEW IF EXISTS app.current_club_versions;
  DROP VIEW IF EXISTS app.current_member_global_roles;
  DROP VIEW IF EXISTS app.current_member_global_role_versions;
  DROP VIEW IF EXISTS app.current_member_profiles;

  -- ================================================================
  -- 2. Move 18 enum types to public
  -- ================================================================

  ALTER TYPE app.member_state SET SCHEMA public;
  ALTER TYPE app.membership_role SET SCHEMA public;
  ALTER TYPE app.membership_state SET SCHEMA public;
  ALTER TYPE app.global_role SET SCHEMA public;
  ALTER TYPE app.assignment_state SET SCHEMA public;
  ALTER TYPE app.subscription_status SET SCHEMA public;
  ALTER TYPE app.billing_interval SET SCHEMA public;
  ALTER TYPE app.entity_kind SET SCHEMA public;
  ALTER TYPE app.entity_state SET SCHEMA public;
  ALTER TYPE app.edge_kind SET SCHEMA public;
  ALTER TYPE app.rsvp_state SET SCHEMA public;
  -- work_mode and compensation_kind removed from schema
  ALTER TYPE app.application_status SET SCHEMA public;
  ALTER TYPE app.quality_gate_status SET SCHEMA public;
  ALTER TYPE app.club_activity_audience SET SCHEMA public;
  ALTER TYPE app.thread_kind SET SCHEMA public;
  ALTER TYPE app.message_role SET SCHEMA public;

  -- ================================================================
  -- 3. Move domain
  -- ================================================================

  ALTER DOMAIN app.short_id SET SCHEMA public;

  -- ================================================================
  -- 4. Move all functions to public
  -- ================================================================

  ALTER FUNCTION app.new_id() SET SCHEMA public;
  ALTER FUNCTION app.member_profile_versions_search_vector_trigger() SET SCHEMA public;
  ALTER FUNCTION app.normalize_admission_policy() SET SCHEMA public;
  ALTER FUNCTION app.lock_club_versioned_mutation() SET SCHEMA public;
  ALTER FUNCTION app.sync_club_version_to_club() SET SCHEMA public;
  ALTER FUNCTION app.lock_club_membership_mutation() SET SCHEMA public;
  ALTER FUNCTION app.sync_club_membership_state() SET SCHEMA public;
  ALTER FUNCTION app.notify_club_activity() SET SCHEMA public;
  ALTER FUNCTION app.notify_signal_delivery() SET SCHEMA public;
  ALTER FUNCTION app.notify_dm_inbox() SET SCHEMA public;
  ALTER FUNCTION app.resolve_active_member_id_by_handle(text) SET SCHEMA public;

  -- ================================================================
  -- 5. Move all 34 tables to public
  -- ================================================================

  ALTER TABLE app.members SET SCHEMA public;
  ALTER TABLE app.member_bearer_tokens SET SCHEMA public;
  ALTER TABLE app.member_global_role_versions SET SCHEMA public;
  ALTER TABLE app.member_private_contacts SET SCHEMA public;
  ALTER TABLE app.member_profile_versions SET SCHEMA public;
  ALTER TABLE app.clubs SET SCHEMA public;
  ALTER TABLE app.club_versions SET SCHEMA public;
  ALTER TABLE app.club_memberships SET SCHEMA public;
  ALTER TABLE app.club_membership_state_versions SET SCHEMA public;
  ALTER TABLE app.club_subscriptions SET SCHEMA public;
  ALTER TABLE app.mutation_confirmations SET SCHEMA public;
  ALTER TABLE app.entities SET SCHEMA public;
  ALTER TABLE app.entity_versions SET SCHEMA public;
  ALTER TABLE app.event_rsvps SET SCHEMA public;
  ALTER TABLE app.club_edges SET SCHEMA public;
  ALTER TABLE app.admissions SET SCHEMA public;
  ALTER TABLE app.admission_versions SET SCHEMA public;
  ALTER TABLE app.admission_challenges SET SCHEMA public;
  ALTER TABLE app.admission_attempts SET SCHEMA public;
  ALTER TABLE app.dm_threads SET SCHEMA public;
  ALTER TABLE app.dm_thread_participants SET SCHEMA public;
  ALTER TABLE app.dm_messages SET SCHEMA public;
  ALTER TABLE app.dm_inbox_entries SET SCHEMA public;
  ALTER TABLE app.dm_message_removals SET SCHEMA public;
  ALTER TABLE app.club_activity SET SCHEMA public;
  ALTER TABLE app.club_activity_cursors SET SCHEMA public;
  ALTER TABLE app.signal_deliveries SET SCHEMA public;
  ALTER TABLE app.club_quota_policies SET SCHEMA public;
  ALTER TABLE app.ai_llm_usage_log SET SCHEMA public;
  ALTER TABLE app.member_profile_embeddings SET SCHEMA public;
  ALTER TABLE app.entity_embeddings SET SCHEMA public;
  ALTER TABLE app.ai_embedding_jobs SET SCHEMA public;
  ALTER TABLE app.signal_background_matches SET SCHEMA public;
  ALTER TABLE app.signal_recompute_queue SET SCHEMA public;
  ALTER TABLE app.worker_state SET SCHEMA public;

  -- ================================================================
  -- 6. Recreate 4 functions that had app. in their SQL bodies
  --    (GUC settings app.allow_* are preserved — they are config
  --    variable namespaces, not schema references)
  -- ================================================================

  CREATE OR REPLACE FUNCTION new_id() RETURNS short_id
      LANGUAGE plpgsql
  AS $fn$
  declare
    alphabet constant text := '23456789abcdefghjkmnpqrstuvwxyz';
    output text := '';
    idx integer;
  begin
    for idx in 1..12 loop
      output := output || substr(alphabet, 1 + floor(random() * length(alphabet))::integer, 1);
    end loop;
    return output::short_id;
  end;
  $fn$;

  CREATE OR REPLACE FUNCTION sync_club_version_to_club() RETURNS trigger
      LANGUAGE plpgsql
  AS $fn$
  BEGIN
      PERFORM set_config('app.allow_club_version_sync', '1', true);
      UPDATE clubs c SET
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
  $fn$;

  CREATE OR REPLACE FUNCTION sync_club_membership_state() RETURNS trigger
      LANGUAGE plpgsql
  AS $fn$
  DECLARE
      mirrored_left_at timestamptz;
  BEGIN
      mirrored_left_at := CASE
          WHEN NEW.status IN ('revoked', 'rejected', 'expired', 'banned', 'removed') THEN NEW.created_at
          ELSE NULL
      END;
      PERFORM set_config('app.allow_membership_state_sync', '1', true);
      UPDATE club_memberships m
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
  $fn$;

  CREATE OR REPLACE FUNCTION resolve_active_member_id_by_handle(target_handle text) RETURNS short_id
      LANGUAGE sql STABLE
  AS $fn$
      SELECT m.id
      FROM members m
      WHERE m.handle = target_handle
        AND m.state = 'active'
      LIMIT 1;
  $fn$;

  -- ================================================================
  -- 7. Recreate all 14 views with unqualified table names
  -- ================================================================

  -- Profiles
  CREATE VIEW current_member_profiles AS
      SELECT DISTINCT ON (member_id) *
      FROM member_profile_versions
      ORDER BY member_id, version_no DESC, created_at DESC;

  -- Global roles
  CREATE VIEW current_member_global_role_versions AS
      SELECT DISTINCT ON (member_id, role) *
      FROM member_global_role_versions
      ORDER BY member_id, role, version_no DESC, created_at DESC;

  CREATE VIEW current_member_global_roles AS
      SELECT * FROM current_member_global_role_versions WHERE status = 'active';

  -- Memberships
  CREATE VIEW current_club_membership_states AS
      SELECT DISTINCT ON (membership_id) *
      FROM club_membership_state_versions
      ORDER BY membership_id, version_no DESC, created_at DESC;

  CREATE VIEW current_club_memberships AS
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
      FROM club_memberships m
      LEFT JOIN current_club_membership_states cms ON cms.membership_id = m.id;

  CREATE VIEW active_club_memberships AS
      SELECT * FROM current_club_memberships
      WHERE status = 'active' AND left_at IS NULL;

  CREATE VIEW accessible_club_memberships AS
      SELECT cm.*
      FROM current_club_memberships cm
      WHERE cm.left_at IS NULL
        AND (
            cm.role = 'clubadmin'
            OR (cm.is_comped = true AND cm.status = 'active')
            OR (
                cm.status IN ('active', 'cancelled')
                AND EXISTS (
                    SELECT 1 FROM club_subscriptions s
                    WHERE s.membership_id = cm.id
                      AND s.status IN ('trialing', 'active', 'past_due')
                      AND coalesce(s.ended_at, 'infinity'::timestamptz) > now()
                      AND coalesce(s.current_period_end, 'infinity'::timestamptz) > now()
                )
            )
            OR (
                cm.status = 'renewal_pending'
                AND cm.state_created_at + interval '7 days' > now()
            )
        );

  -- Clubs
  CREATE VIEW current_club_versions AS
      SELECT DISTINCT ON (club_id) *
      FROM club_versions
      ORDER BY club_id, version_no DESC, created_at DESC;

  -- Admissions
  CREATE VIEW current_admission_versions AS
      SELECT DISTINCT ON (admission_id) *
      FROM admission_versions
      ORDER BY admission_id, version_no DESC, created_at DESC;

  CREATE VIEW current_admissions AS
      SELECT
          a.id,
          a.club_id,
          a.applicant_member_id,
          a.sponsor_member_id,
          a.membership_id,
          a.origin,
          a.admission_details,
          a.metadata,
          a.created_at,
          a.applicant_email,
          a.applicant_name,
          cav.id              AS version_id,
          cav.status,
          cav.notes,
          cav.intake_kind,
          cav.intake_price_amount,
          cav.intake_price_currency,
          cav.intake_booking_url,
          cav.intake_booked_at,
          cav.intake_completed_at,
          cav.version_no,
          cav.supersedes_version_id,
          cav.created_at      AS version_created_at,
          cav.created_by_member_id AS version_created_by_member_id
      FROM admissions a
      JOIN current_admission_versions cav ON cav.admission_id = a.id;

  -- Entities
  CREATE VIEW current_entity_versions AS
      SELECT DISTINCT ON (entity_id) *
      FROM entity_versions
      ORDER BY entity_id, version_no DESC, created_at DESC;

  CREATE VIEW published_entity_versions AS
      SELECT * FROM current_entity_versions WHERE state = 'published';

  CREATE VIEW current_event_rsvps AS
      SELECT DISTINCT ON (event_entity_id, membership_id) *
      FROM event_rsvps
      ORDER BY event_entity_id, membership_id, version_no DESC, created_at DESC;

  CREATE VIEW live_entities AS
      SELECT
          e.id                AS entity_id,
          e.club_id,
          e.kind,
          e.author_member_id,
          e.parent_entity_id,
          e.created_at        AS entity_created_at,
          pev.id              AS entity_version_id,
          pev.version_no,
          pev.state,
          pev.title,
          pev.summary,
          pev.body,
          pev.effective_at,
          pev.expires_at,
          pev.content,
          pev.created_at      AS version_created_at,
          pev.created_by_member_id
      FROM entities e
      JOIN published_entity_versions pev ON pev.entity_id = e.id
      WHERE e.archived_at IS NULL
        AND e.deleted_at IS NULL
        AND (pev.expires_at IS NULL OR pev.expires_at > now());

  -- ================================================================
  -- 8. Slim entity_versions and create event_version_details
  -- ================================================================

  -- Drop work_mode and compensation columns, then clean up the enum types
  -- from whichever schema they ended up in (app or public).
  ALTER TABLE entity_versions DROP COLUMN IF EXISTS work_mode;
  ALTER TABLE entity_versions DROP COLUMN IF EXISTS compensation;
  DROP TYPE IF EXISTS public.work_mode;
  DROP TYPE IF EXISTS public.compensation_kind;
  DROP TYPE IF EXISTS app.work_mode;
  DROP TYPE IF EXISTS app.compensation_kind;

  -- Move event-specific columns from entity_versions to extension table
  CREATE TABLE IF NOT EXISTS event_version_details (
      entity_version_id       short_id NOT NULL,
      location                text,
      starts_at               timestamptz,
      ends_at                 timestamptz,
      timezone                text,
      recurrence_rule         text,
      capacity                integer,

      CONSTRAINT event_version_details_pkey PRIMARY KEY (entity_version_id),
      CONSTRAINT event_version_details_capacity_check CHECK (capacity IS NULL OR capacity > 0),
      CONSTRAINT event_version_details_dates_check CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at >= starts_at),
      CONSTRAINT event_version_details_version_fkey FOREIGN KEY (entity_version_id) REFERENCES entity_versions(id)
  );

  CREATE INDEX IF NOT EXISTS event_version_details_starts_idx ON event_version_details (starts_at);

  -- Migrate existing event data from entity_versions to event_version_details
  INSERT INTO event_version_details (entity_version_id, location, starts_at, ends_at, timezone, recurrence_rule, capacity)
  SELECT ev.id, ev.location, ev.starts_at, ev.ends_at, ev.timezone, ev.recurrence_rule, ev.capacity
  FROM entity_versions ev
  JOIN entities e ON e.id = ev.entity_id
  WHERE e.kind = 'event'
    AND (ev.location IS NOT NULL OR ev.starts_at IS NOT NULL OR ev.ends_at IS NOT NULL
         OR ev.timezone IS NOT NULL OR ev.recurrence_rule IS NOT NULL OR ev.capacity IS NOT NULL)
  ON CONFLICT (entity_version_id) DO NOTHING;

  -- Drop the old columns from entity_versions
  ALTER TABLE entity_versions DROP COLUMN IF EXISTS location;
  ALTER TABLE entity_versions DROP COLUMN IF EXISTS starts_at;
  ALTER TABLE entity_versions DROP COLUMN IF EXISTS ends_at;
  ALTER TABLE entity_versions DROP COLUMN IF EXISTS timezone;
  ALTER TABLE entity_versions DROP COLUMN IF EXISTS recurrence_rule;
  ALTER TABLE entity_versions DROP COLUMN IF EXISTS capacity;

  -- Drop stale indexes that referenced removed columns
  DROP INDEX IF EXISTS entity_versions_starts_idx;

  -- Create event-focused views
  CREATE VIEW current_event_versions AS
      SELECT cev.*, evd.location, evd.starts_at, evd.ends_at,
             evd.timezone, evd.recurrence_rule, evd.capacity
      FROM current_entity_versions cev
      JOIN event_version_details evd ON evd.entity_version_id = cev.id;

  CREATE VIEW live_events AS
      SELECT le.*, evd.location, evd.starts_at, evd.ends_at,
             evd.timezone, evd.recurrence_rule, evd.capacity
      FROM live_entities le
      JOIN event_version_details evd ON evd.entity_version_id = le.entity_version_id
      WHERE le.kind = 'event';

  -- ================================================================
  -- 9. Performance indexes
  -- ================================================================

  -- DM inbox: update-polling (recipient + unread + created_at cursor)
  CREATE INDEX IF NOT EXISTS dm_inbox_entries_unread_poll_idx
      ON dm_inbox_entries (recipient_member_id, created_at ASC)
      WHERE acknowledged = false;

  -- DM inbox: inbox-stats CTE (recipient + thread grouping for unread aggregation)
  CREATE INDEX IF NOT EXISTS dm_inbox_entries_unread_thread_idx
      ON dm_inbox_entries (recipient_member_id, thread_id)
      WHERE acknowledged = false;

  -- Admissions: cross-apply eligibility checks by applicant
  CREATE INDEX IF NOT EXISTS admissions_applicant_idx
      ON admissions (applicant_member_id, club_id);

  -- ================================================================
  -- 10. Drop the app schema
  -- ================================================================

  DROP SCHEMA app;

END $migration$;

-- ================================================================
-- Record migration
-- ================================================================

INSERT INTO public.schema_migrations (filename)
VALUES ('0005_remove_app_schema.sql')
ON CONFLICT (filename) DO NOTHING;
