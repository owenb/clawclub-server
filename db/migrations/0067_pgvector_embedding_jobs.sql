-- Enable pgvector extension for vector similarity search.
CREATE EXTENSION IF NOT EXISTS vector;

-- Add a typed vector column alongside the existing double precision[] array.
-- Nullable: only populated for rows with the standard 1536-dimension model.
ALTER TABLE app.embeddings ADD COLUMN embedding_vector vector(1536);

-- Backfill existing 1536-dimension rows if any exist.
UPDATE app.embeddings
SET embedding_vector = embedding::vector
WHERE dimensions = 1536 AND embedding_vector IS NULL;

-- Prevent duplicate embeddings for the same version/model/dimensions.
-- This changes the semantics from append-only (pick latest via views) to
-- one-row-per-version. To re-embed after source-builder changes, delete the
-- old row first or bump the model identifier.
--
-- Clean up any pre-existing duplicates before creating the unique indexes.
DELETE FROM app.embeddings e1
WHERE e1.member_profile_version_id IS NOT NULL
  AND e1.id <> (
    SELECT e2.id FROM app.embeddings e2
    WHERE e2.member_profile_version_id = e1.member_profile_version_id
      AND e2.model = e1.model
      AND e2.dimensions = e1.dimensions
    ORDER BY e2.created_at DESC, e2.id DESC
    LIMIT 1
  );

DELETE FROM app.embeddings e1
WHERE e1.entity_version_id IS NOT NULL
  AND e1.id <> (
    SELECT e2.id FROM app.embeddings e2
    WHERE e2.entity_version_id = e1.entity_version_id
      AND e2.model = e1.model
      AND e2.dimensions = e1.dimensions
    ORDER BY e2.created_at DESC, e2.id DESC
    LIMIT 1
  );

CREATE UNIQUE INDEX embeddings_profile_model_unique_idx
    ON app.embeddings (member_profile_version_id, model, dimensions)
    WHERE member_profile_version_id IS NOT NULL;

CREATE UNIQUE INDEX embeddings_entity_model_unique_idx
    ON app.embeddings (entity_version_id, model, dimensions)
    WHERE entity_version_id IS NOT NULL;

-- Allow the security definer owner role to insert embeddings
-- (the insert_embedding function runs as this role).
CREATE POLICY embeddings_insert_security_definer_owner ON app.embeddings
    FOR INSERT
    WITH CHECK (current_user = 'clawclub_security_definer_owner');

GRANT INSERT ON TABLE app.embeddings TO clawclub_security_definer_owner;

-- ── Embedding jobs queue ────────────────────────────────────────────────────

CREATE TABLE app.embedding_jobs (
    id app.short_id DEFAULT app.new_id() NOT NULL,
    subject_kind text NOT NULL,
    subject_version_id app.short_id NOT NULL,
    model text NOT NULL,
    dimensions integer NOT NULL,
    attempt_count integer NOT NULL DEFAULT 0,
    next_attempt_at timestamp with time zone NOT NULL DEFAULT now(),
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT embedding_jobs_pkey PRIMARY KEY (id),
    CONSTRAINT embedding_jobs_subject_kind_check CHECK (subject_kind IN ('member_profile_version', 'entity_version')),
    CONSTRAINT embedding_jobs_dimensions_check CHECK (dimensions > 0),
    CONSTRAINT embedding_jobs_unique UNIQUE (subject_kind, subject_version_id, model, dimensions)
);

CREATE INDEX embedding_jobs_pending_idx
    ON app.embedding_jobs (next_attempt_at ASC)
    WHERE attempt_count < 5;

-- RLS on jobs table: only the security definer owner role can access.
ALTER TABLE app.embedding_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY app.embedding_jobs FORCE ROW LEVEL SECURITY;

CREATE POLICY embedding_jobs_all_security_definer_owner ON app.embedding_jobs
    FOR ALL
    USING (current_user = 'clawclub_security_definer_owner')
    WITH CHECK (current_user = 'clawclub_security_definer_owner');

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.embedding_jobs TO clawclub_security_definer_owner;

-- ── Security-definer functions for the worker ───────────────────────────────
-- These bypass actor-scoped RLS so the worker can read subject data.

CREATE FUNCTION app.load_profile_version_for_embedding(
    p_version_id app.short_id
) RETURNS TABLE (
    id app.short_id,
    member_id app.short_id,
    public_name text,
    display_name text,
    handle text,
    tagline text,
    summary text,
    what_i_do text,
    known_for text,
    services_summary text,
    website_url text,
    links jsonb,
    is_current boolean
)
    LANGUAGE sql STABLE
    SECURITY DEFINER
    SET search_path TO 'app', 'pg_temp'
AS $$
    SELECT
        mpv.id,
        mpv.member_id,
        m.public_name,
        mpv.display_name,
        m.handle,
        mpv.tagline,
        mpv.summary,
        mpv.what_i_do,
        mpv.known_for,
        mpv.services_summary,
        mpv.website_url,
        mpv.links,
        (cmp.id IS NOT NULL AND cmp.id = mpv.id) AS is_current
    FROM app.member_profile_versions mpv
    JOIN app.members m ON m.id = mpv.member_id
    LEFT JOIN app.current_member_profiles cmp ON cmp.member_id = mpv.member_id
    WHERE mpv.id = p_version_id;
$$;

ALTER FUNCTION app.load_profile_version_for_embedding(app.short_id)
    OWNER TO clawclub_security_definer_owner;

CREATE FUNCTION app.load_entity_version_for_embedding(
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

ALTER FUNCTION app.load_entity_version_for_embedding(app.short_id)
    OWNER TO clawclub_security_definer_owner;

-- Backfill helper: returns current profile versions missing embeddings.
CREATE FUNCTION app.list_profile_versions_needing_embeddings(
    p_model text,
    p_dimensions integer
) RETURNS TABLE (version_id app.short_id)
    LANGUAGE sql STABLE
    SECURITY DEFINER
    SET search_path TO 'app', 'pg_temp'
AS $$
    SELECT cmp.id AS version_id
    FROM app.current_member_profiles cmp
    JOIN app.members m ON m.id = cmp.member_id AND m.state = 'active'
    WHERE NOT EXISTS (
        SELECT 1 FROM app.embeddings e
        WHERE e.member_profile_version_id = cmp.id
          AND e.model = p_model
          AND e.dimensions = p_dimensions
    );
$$;

ALTER FUNCTION app.list_profile_versions_needing_embeddings(text, integer)
    OWNER TO clawclub_security_definer_owner;

-- Backfill helper: returns current published entity versions missing embeddings.
CREATE FUNCTION app.list_entity_versions_needing_embeddings(
    p_model text,
    p_dimensions integer
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
          SELECT 1 FROM app.embeddings emb
          WHERE emb.entity_version_id = cev.id
            AND emb.model = p_model
            AND emb.dimensions = p_dimensions
      );
$$;

ALTER FUNCTION app.list_entity_versions_needing_embeddings(text, integer)
    OWNER TO clawclub_security_definer_owner;

-- Worker queue operations: claim, retry, complete.
CREATE FUNCTION app.claim_embedding_jobs(
    p_max_attempts integer,
    p_limit integer
) RETURNS TABLE (
    id app.short_id,
    subject_kind text,
    subject_version_id app.short_id,
    model text,
    dimensions integer,
    attempt_count integer
)
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path TO 'app', 'pg_temp'
AS $$
    UPDATE app.embedding_jobs ej
    SET next_attempt_at = now() + interval '10 minutes'
    FROM (
        SELECT ej2.id
        FROM app.embedding_jobs ej2
        WHERE ej2.next_attempt_at <= now() AND ej2.attempt_count < p_max_attempts
        ORDER BY ej2.next_attempt_at ASC
        LIMIT p_limit
        FOR UPDATE SKIP LOCKED
    ) claimed
    WHERE ej.id = claimed.id
    RETURNING ej.id, ej.subject_kind, ej.subject_version_id, ej.model, ej.dimensions, ej.attempt_count;
$$;

ALTER FUNCTION app.claim_embedding_jobs(integer, integer)
    OWNER TO clawclub_security_definer_owner;

CREATE FUNCTION app.complete_embedding_jobs(
    p_job_ids app.short_id[]
) RETURNS void
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path TO 'app', 'pg_temp'
AS $$
    DELETE FROM app.embedding_jobs WHERE id = ANY(p_job_ids);
$$;

ALTER FUNCTION app.complete_embedding_jobs(app.short_id[])
    OWNER TO clawclub_security_definer_owner;

CREATE FUNCTION app.retry_embedding_jobs(
    p_job_ids app.short_id[],
    p_error text
) RETURNS void
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path TO 'app', 'pg_temp'
AS $$
    UPDATE app.embedding_jobs
    SET attempt_count = attempt_count + 1,
        next_attempt_at = now() + (power(2, attempt_count) * interval '1 minute'),
        last_error = p_error
    WHERE id = ANY(p_job_ids);
$$;

ALTER FUNCTION app.retry_embedding_jobs(app.short_id[], text)
    OWNER TO clawclub_security_definer_owner;

-- Release claimed jobs without incrementing attempt_count.
-- Used when a configuration issue (e.g. missing API key) prevents processing
-- but is not the job's fault — jobs should stay eligible for future claims.
CREATE FUNCTION app.release_embedding_jobs(
    p_job_ids app.short_id[]
) RETURNS void
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path TO 'app', 'pg_temp'
AS $$
    UPDATE app.embedding_jobs
    SET next_attempt_at = now()
    WHERE id = ANY(p_job_ids);
$$;

ALTER FUNCTION app.release_embedding_jobs(app.short_id[])
    OWNER TO clawclub_security_definer_owner;

CREATE FUNCTION app.retry_embedding_job(
    p_job_id app.short_id,
    p_error text
) RETURNS void
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path TO 'app', 'pg_temp'
AS $$
    UPDATE app.embedding_jobs
    SET attempt_count = attempt_count + 1,
        next_attempt_at = now() + (power(2, attempt_count) * interval '1 minute'),
        last_error = p_error
    WHERE id = p_job_id;
$$;

ALTER FUNCTION app.retry_embedding_job(app.short_id, text)
    OWNER TO clawclub_security_definer_owner;

-- ── Enqueue function (called in write transactions) ─────────────────────────

CREATE FUNCTION app.enqueue_embedding_job(
    p_subject_kind text,
    p_subject_version_id app.short_id,
    p_model text,
    p_dimensions integer
) RETURNS void
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path TO 'app', 'pg_temp'
AS $$
    INSERT INTO app.embedding_jobs (subject_kind, subject_version_id, model, dimensions)
    VALUES (p_subject_kind, p_subject_version_id, p_model, p_dimensions)
    ON CONFLICT (subject_kind, subject_version_id, model, dimensions) DO NOTHING;
$$;

ALTER FUNCTION app.enqueue_embedding_job(text, app.short_id, text, integer)
    OWNER TO clawclub_security_definer_owner;

-- ── Insert embedding function (called by worker) ───────────────────────────

CREATE FUNCTION app.insert_embedding(
    p_member_profile_version_id app.short_id,
    p_entity_version_id app.short_id,
    p_model text,
    p_dimensions integer,
    p_embedding double precision[],
    p_embedding_vector vector,
    p_source_text text,
    p_metadata jsonb
) RETURNS app.short_id
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path TO 'app', 'pg_temp'
AS $$
    INSERT INTO app.embeddings (
        member_profile_version_id, entity_version_id,
        model, dimensions, embedding, embedding_vector,
        source_text, metadata
    )
    VALUES (
        p_member_profile_version_id, p_entity_version_id,
        p_model, p_dimensions, p_embedding, p_embedding_vector,
        p_source_text, p_metadata
    )
    ON CONFLICT DO NOTHING
    RETURNING id;
$$;

ALTER FUNCTION app.insert_embedding(app.short_id, app.short_id, text, integer, double precision[], vector, text, jsonb)
    OWNER TO clawclub_security_definer_owner;

-- ── Explicit EXECUTE grants for the runtime app role ────────────────────────
-- These ensure deployments that only run migrations (without re-provisioning
-- the app role) still work. The provision script's ALTER DEFAULT PRIVILEGES
-- covers new functions created after provisioning, but these explicit grants
-- are belt-and-suspenders for the migration-only path.

DO $$ BEGIN
  -- Only grant if the app role exists (it may not in fresh test environments
  -- where provision hasn't run yet).
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clawclub_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION app.enqueue_embedding_job(text, app.short_id, text, integer) TO clawclub_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION app.insert_embedding(app.short_id, app.short_id, text, integer, double precision[], vector, text, jsonb) TO clawclub_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION app.load_profile_version_for_embedding(app.short_id) TO clawclub_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION app.load_entity_version_for_embedding(app.short_id) TO clawclub_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION app.list_profile_versions_needing_embeddings(text, integer) TO clawclub_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION app.list_entity_versions_needing_embeddings(text, integer) TO clawclub_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION app.claim_embedding_jobs(integer, integer) TO clawclub_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION app.complete_embedding_jobs(app.short_id[]) TO clawclub_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION app.retry_embedding_jobs(app.short_id[], text) TO clawclub_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION app.retry_embedding_job(app.short_id, text) TO clawclub_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION app.release_embedding_jobs(app.short_id[]) TO clawclub_app';
  END IF;
END $$;
