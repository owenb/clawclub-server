-- Fixes for embeddings v2 greenfield architecture.
--
-- 1. Actor-scoped SELECT access on artifact tables (semantic search queries)
-- 2. Exclude redacted entities from backfill discovery
-- 3. Exclude redacted entities from worker entity loading (is_current_published = false)

-- ── 1. Actor-scoped SELECT policies on artifact tables ────────────────────────
--
-- Semantic search queries (members.findViaEmbedding, entities.findViaEmbedding)
-- run under the app role with actor context. They need to read artifact tables
-- to find embedding vectors. These policies mirror the pattern used on the old
-- app.embeddings table: profile artifacts are visible if the actor can access
-- the member; entity artifacts are visible if the actor has club access to the
-- entity's club. This enforces scope at the table layer rather than relying
-- only on the surrounding query shape.

CREATE POLICY embeddings_mpa_select_actor_scope
    ON app.embeddings_member_profile_artifacts
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM app.member_profile_versions mpv
            WHERE mpv.id = member_profile_version_id
              AND app.actor_can_access_member(mpv.member_id)
        )
    );

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
              AND NOT EXISTS (
                  SELECT 1 FROM app.redactions rdc
                  WHERE rdc.target_kind = 'entity' AND rdc.target_id = e.id
              )
        )
    );

-- ── 2. Exclude redacted entities from backfill discovery ──────────────────────
--
-- The existing embeddings_list_entities_needing_artifacts function does not
-- check for redactions. Redacted entities should not be indexed.

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
          SELECT 1 FROM app.redactions rdc
          WHERE rdc.target_kind = 'entity' AND rdc.target_id = e.id
      )
      AND NOT EXISTS (
          SELECT 1 FROM app.embeddings_entity_artifacts a
          WHERE a.entity_version_id = cev.id
            AND a.model = p_model
            AND a.dimensions = p_dimensions
            AND a.source_version = p_source_version
      );
$$;

-- ── 3. Exclude redacted entities from worker entity loading ───────────────────
--
-- The existing embeddings_load_entity_version function returns
-- is_current_published = true even for redacted entities. Adding a redaction
-- check makes the worker treat redacted entities as stale (skip + delete job).

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
         AND e.deleted_at IS NULL AND e.archived_at IS NULL
         AND NOT EXISTS (
             SELECT 1 FROM app.redactions rdc
             WHERE rdc.target_kind = 'entity' AND rdc.target_id = e.id
         )) AS is_current_published
    FROM app.entity_versions ev
    JOIN app.entities e ON e.id = ev.entity_id
    LEFT JOIN app.current_entity_versions cev ON cev.entity_id = e.id
    WHERE ev.id = p_version_id;
$$;

-- ── 4. Conditional grants for app role ────────────────────────────────────────

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clawclub_app') THEN
    EXECUTE 'GRANT SELECT ON TABLE app.embeddings_member_profile_artifacts TO clawclub_app';
    EXECUTE 'GRANT SELECT ON TABLE app.embeddings_entity_artifacts TO clawclub_app';
  END IF;
END $$;
