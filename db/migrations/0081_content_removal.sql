-- Unified content removal system.
-- Replaces dual archive/redact mechanisms with version-based entity removal
-- and a dedicated dm_message_removals table for messages.
-- Drops the cross-cutting app.redactions table.

-- ── 1. Add reason column to entity_versions ─────────────────────────────────────

ALTER TABLE app.entity_versions ADD COLUMN IF NOT EXISTS reason text;

-- ── 2. Create dm_message_removals table ─────────────────────────────────────────

CREATE TABLE app.dm_message_removals (
  message_id app.short_id PRIMARY KEY REFERENCES app.dm_messages(id),
  club_id app.short_id NOT NULL REFERENCES app.clubs(id),
  removed_by_member_id app.short_id NOT NULL REFERENCES app.members(id),
  reason text,
  removed_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ONLY app.dm_message_removals FORCE ROW LEVEL SECURITY;

CREATE POLICY dm_message_removals_insert_actor ON app.dm_message_removals
  FOR INSERT WITH CHECK (
    (removed_by_member_id)::text = (app.current_actor_member_id())::text
    OR app.current_actor_is_superadmin()
    OR app.actor_is_club_admin(club_id)
  );

CREATE POLICY dm_message_removals_select_club_scope ON app.dm_message_removals
  FOR SELECT USING (
    app.actor_has_club_access(club_id)
    OR app.current_actor_is_superadmin()
  );

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clawclub_app') THEN
    EXECUTE 'GRANT SELECT, INSERT ON TABLE app.dm_message_removals TO clawclub_app';
  END IF;
END $$;

-- ── 2b. Entities: allow club admins to see entities regardless of published state ─
-- Needed for clubadmin/superadmin removal (entities_select_author from 0058
-- already covers author self-service)
CREATE POLICY entities_select_club_admin ON app.entities
  FOR SELECT USING (
    deleted_at IS NULL
    AND app.actor_is_club_admin(club_id)
  );

-- ── 2c. Entity versions: allow club admins to see entity versions regardless of published state ─
CREATE POLICY entity_versions_select_club_admin ON app.entity_versions
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM app.entities e
      WHERE (e.id)::text = (entity_versions.entity_id)::text
        AND e.deleted_at IS NULL
        AND app.actor_is_club_admin(e.club_id)
    )
  );

-- ── 3. Entity versions: allow club admin to insert removal versions ─────────────

CREATE POLICY entity_versions_insert_club_admin_removal ON app.entity_versions
  FOR INSERT WITH CHECK (
    state = 'removed'
    AND (created_by_member_id)::text = (app.current_actor_member_id())::text
    AND EXISTS (
      SELECT 1 FROM app.entities e
      WHERE (e.id)::text = (entity_versions.entity_id)::text
        AND e.deleted_at IS NULL
        AND app.actor_is_club_admin(e.club_id)
    )
  );

-- ── 4. Migrate existing entity redactions → removal versions ────────────────────

INSERT INTO app.entity_versions (entity_id, version_no, state, reason, effective_at, content, supersedes_version_id, created_by_member_id)
SELECT
  e.id,
  cev.version_no + 1,
  'removed',
  r.reason,
  r.created_at,
  cev.content,
  cev.id,
  r.created_by_member_id
FROM app.redactions r
JOIN app.entities e ON e.id = r.target_id AND r.target_kind = 'entity'
JOIN app.current_entity_versions cev ON cev.entity_id = e.id
WHERE cev.state = 'published';

-- ── 5. Migrate existing archived versions → removed ─────────────────────────────

UPDATE app.entity_versions SET state = 'removed' WHERE state = 'archived';

-- ── 6. Migrate existing message redactions → dm_message_removals ────────────────

INSERT INTO app.dm_message_removals (message_id, club_id, removed_by_member_id, reason, removed_at)
SELECT r.target_id, r.club_id, r.created_by_member_id, r.reason, r.created_at
FROM app.redactions r
WHERE r.target_kind = 'dm_message'
ON CONFLICT (message_id) DO NOTHING;

-- ── 7. Update pending_member_updates view ───────────────────────────────────────

DROP VIEW IF EXISTS app.current_dm_inbox_threads;
DROP VIEW IF EXISTS app.pending_member_updates;

CREATE VIEW app.pending_member_updates AS
 SELECT mu.id AS update_id,
    mu.stream_seq,
    mu.recipient_member_id,
    mu.club_id,
    mu.topic,
    mu.payload,
    mu.entity_id,
    mu.entity_version_id,
    mu.dm_message_id,
    mu.created_by_member_id,
    mu.created_at
   FROM app.member_updates mu
   LEFT JOIN app.current_member_update_receipts cmur
     ON cmur.member_update_id = mu.id
    AND cmur.recipient_member_id = mu.recipient_member_id
   LEFT JOIN app.dm_message_removals dmr
     ON dmr.message_id = mu.dm_message_id
  WHERE cmur.id IS NULL
    AND dmr.message_id IS NULL
    AND (mu.entity_id IS NULL OR EXISTS (
      SELECT 1 FROM app.current_published_entity_versions cev WHERE cev.entity_id = mu.entity_id
    ));

ALTER TABLE app.pending_member_updates OWNER TO clawclub_view_owner;
GRANT SELECT ON TABLE app.pending_member_updates TO clawclub_security_definer_owner;

-- ── 8. Update current_dm_inbox_threads view ─────────────────────────────────────
-- Honor dm_message_removals for latest_message_text preview.

CREATE VIEW app.current_dm_inbox_threads AS
 WITH thread_messages AS (
   SELECT tt.id AS thread_id,
      tt.club_id,
      participant.recipient_member_id,
      CASE
        WHEN tt.created_by_member_id::text = participant.recipient_member_id::text
          THEN tt.counterpart_member_id
        ELSE tt.created_by_member_id
      END AS counterpart_member_id,
      tm_1.id AS message_id,
      tm_1.sender_member_id,
      tm_1.role,
      CASE WHEN dmr.message_id IS NOT NULL THEN '[Message removed]' ELSE tm_1.message_text END AS message_text,
      tm_1.created_at,
      row_number() OVER (
        PARTITION BY participant.recipient_member_id, tt.id
        ORDER BY tm_1.created_at DESC, tm_1.id DESC
      ) AS latest_row_no
     FROM app.dm_threads tt
     JOIN (
       SELECT tt_inner.id AS thread_id,
              tt_inner.created_by_member_id AS recipient_member_id
         FROM app.dm_threads tt_inner
        WHERE tt_inner.kind = 'conversation'::app.dm_thread_kind
          AND tt_inner.archived_at IS NULL
          AND tt_inner.created_by_member_id IS NOT NULL
       UNION
       SELECT tt_inner.id AS thread_id,
              tt_inner.counterpart_member_id AS recipient_member_id
         FROM app.dm_threads tt_inner
        WHERE tt_inner.kind = 'conversation'::app.dm_thread_kind
          AND tt_inner.archived_at IS NULL
          AND tt_inner.counterpart_member_id IS NOT NULL
     ) participant ON participant.thread_id::text = tt.id::text
     JOIN app.dm_messages tm_1 ON tm_1.thread_id::text = tt.id::text
     LEFT JOIN app.dm_message_removals dmr ON dmr.message_id = tm_1.id
    WHERE tt.kind = 'conversation'::app.dm_thread_kind
      AND tt.archived_at IS NULL
 ), unread_messages AS (
   SELECT pmu.recipient_member_id,
      tm_1.thread_id,
      count(DISTINCT pmu.dm_message_id)::integer AS unread_message_count,
      count(*)::integer AS unread_update_count,
      max(tm_1.created_at) AS latest_unread_message_created_at
     FROM app.pending_member_updates pmu
     JOIN app.dm_messages tm_1 ON tm_1.id::text = pmu.dm_message_id::text
     JOIN app.dm_threads tt ON tt.id::text = tm_1.thread_id::text
    WHERE pmu.topic = 'dm.message.created'
      AND pmu.dm_message_id IS NOT NULL
      AND tt.kind = 'conversation'::app.dm_thread_kind
      AND tt.archived_at IS NULL
    GROUP BY pmu.recipient_member_id, tm_1.thread_id
 )
 SELECT tm.recipient_member_id,
    tm.club_id,
    tm.thread_id,
    tm.counterpart_member_id,
    tm.message_id AS latest_message_id,
    tm.sender_member_id AS latest_sender_member_id,
    tm.role AS latest_role,
    tm.message_text AS latest_message_text,
    tm.created_at AS latest_created_at,
    COALESCE(um.unread_message_count, 0) AS unread_message_count,
    COALESCE(um.unread_update_count, 0) AS unread_update_count,
    um.latest_unread_message_created_at,
    (COALESCE(um.unread_message_count, 0) > 0) AS has_unread
   FROM thread_messages tm
   LEFT JOIN unread_messages um
     ON um.recipient_member_id::text = tm.recipient_member_id::text
    AND um.thread_id::text = tm.thread_id::text
  WHERE tm.latest_row_no = 1;

ALTER TABLE app.current_dm_inbox_threads OWNER TO clawclub_view_owner;
GRANT SELECT ON TABLE app.current_dm_inbox_threads TO clawclub_security_definer_owner;

-- ── 9. Update embedding functions and RLS ───────────────────────────────────────
-- Remove redaction checks — entity_is_currently_published() / cev.state = 'published'
-- already excludes removed entities.

-- 9a. RLS policy on embeddings_entity_artifacts: remove redaction NOT EXISTS
DROP POLICY IF EXISTS embeddings_ea_select_actor_scope ON app.embeddings_entity_artifacts;

CREATE POLICY embeddings_ea_select_actor_scope
    ON app.embeddings_entity_artifacts
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM app.entity_versions ev
            JOIN app.entities e ON e.id = ev.entity_id
            WHERE ev.id = entity_version_id
              AND e.deleted_at IS NULL
              AND app.entity_is_currently_published(e.id)
              AND app.actor_has_club_access(e.club_id)
        )
    );

-- 9b. embeddings_list_entities_needing_artifacts: remove redaction NOT EXISTS
CREATE OR REPLACE FUNCTION app.embeddings_list_entities_needing_artifacts(
    p_model text,
    p_dimensions integer,
    p_source_version text
) RETURNS TABLE (version_id app.short_id)
    LANGUAGE sql STABLE
    SECURITY DEFINER
    SET search_path TO 'app', 'pg_temp'
AS $$
    SELECT cev.id AS version_id
    FROM app.current_entity_versions cev
    JOIN app.entities e ON e.id = cev.entity_id
    WHERE cev.state = 'published'
      AND e.deleted_at IS NULL
      AND e.archived_at IS NULL
      AND NOT EXISTS (
          SELECT 1 FROM app.embeddings_entity_artifacts a
          WHERE a.entity_version_id = cev.id
            AND a.model = p_model
            AND a.dimensions = p_dimensions
            AND a.source_version = p_source_version
      );
$$;

-- 9c. embeddings_load_entity_version: remove redaction NOT EXISTS from is_current_published
CREATE OR REPLACE FUNCTION app.embeddings_load_entity_version(
    p_version_id app.short_id
) RETURNS TABLE (
    id app.short_id,
    entity_id app.short_id,
    kind text,
    title text,
    summary text,
    body text,
    location text,
    starts_at text,
    ends_at text,
    timezone text,
    recurrence_rule text,
    content jsonb,
    is_current_published boolean
)
    LANGUAGE sql STABLE
    SECURITY DEFINER
    SET search_path TO 'app', 'pg_temp'
AS $$
    SELECT
        ev.id,
        e.id AS entity_id,
        e.kind::text,
        ev.title,
        ev.summary,
        ev.body,
        ev.location,
        ev.starts_at::text,
        ev.ends_at::text,
        ev.timezone,
        ev.recurrence_rule,
        ev.content,
        (cev.id IS NOT NULL AND cev.id = ev.id AND ev.state = 'published'
         AND e.deleted_at IS NULL AND e.archived_at IS NULL) AS is_current_published
    FROM app.entity_versions ev
    JOIN app.entities e ON e.id = ev.entity_id
    LEFT JOIN app.current_entity_versions cev ON cev.entity_id = e.id
    WHERE ev.id = p_version_id;
$$;

-- ── 10. Drop app.redactions ─────────────────────────────────────────────────────

DROP POLICY IF EXISTS redactions_insert_actor ON app.redactions;
DROP POLICY IF EXISTS redactions_select_club_scope ON app.redactions;
DROP POLICY IF EXISTS redactions_select_superadmin ON app.redactions;
DROP TABLE IF EXISTS app.redactions;
