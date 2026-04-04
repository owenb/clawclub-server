-- Greenfield embedding re-architecture.
--
-- Drops the legacy polymorphic embeddings table, its views, and all 0067 objects.
-- Creates separate artifact tables per surface, a shared jobs queue, and
-- full-text search infrastructure for member profiles.
--
-- NOTE: Changing embedding dimensions later requires a migration to alter
-- the vector(1536) column type.

-- ── 1. Drop legacy objects from 0067 ──────────────────────────────────────────

-- Functions created in 0067
DROP FUNCTION IF EXISTS app.enqueue_embedding_job(text, app.short_id, text, integer);
DROP FUNCTION IF EXISTS app.insert_embedding(app.short_id, app.short_id, text, integer, double precision[], vector, text, jsonb);
DROP FUNCTION IF EXISTS app.claim_embedding_jobs(integer, integer);
DROP FUNCTION IF EXISTS app.complete_embedding_jobs(app.short_id[]);
DROP FUNCTION IF EXISTS app.retry_embedding_jobs(app.short_id[], text);
DROP FUNCTION IF EXISTS app.retry_embedding_job(app.short_id, text);
DROP FUNCTION IF EXISTS app.release_embedding_jobs(app.short_id[]);
DROP FUNCTION IF EXISTS app.load_profile_version_for_embedding(app.short_id);
DROP FUNCTION IF EXISTS app.load_entity_version_for_embedding(app.short_id);
DROP FUNCTION IF EXISTS app.list_profile_versions_needing_embeddings(text, integer);
DROP FUNCTION IF EXISTS app.list_entity_versions_needing_embeddings(text, integer);

-- Table created in 0067
DROP TABLE IF EXISTS app.embedding_jobs;

-- Indexes created in 0067
DROP INDEX IF EXISTS app.embeddings_profile_model_unique_idx;
DROP INDEX IF EXISTS app.embeddings_entity_model_unique_idx;

-- Policy created in 0067
DROP POLICY IF EXISTS embeddings_insert_security_definer_owner ON app.embeddings;

-- Column added in 0067
ALTER TABLE app.embeddings DROP COLUMN IF EXISTS embedding_vector;

-- ── 2. Drop legacy objects from 0001 ──────────────────────────────────────────

-- Views first (depend on table)
DROP VIEW IF EXISTS app.current_profile_version_embeddings;
DROP VIEW IF EXISTS app.current_entity_version_embeddings;

-- Policies
DROP POLICY IF EXISTS embeddings_select_entity_scope ON app.embeddings;
DROP POLICY IF EXISTS embeddings_select_profile_scope ON app.embeddings;

-- Table (cascades indexes, constraints, FK references)
DROP TABLE IF EXISTS app.embeddings CASCADE;

-- ── 3. Member profile artifact table ──────────────────────────────────────────

CREATE TABLE app.embeddings_member_profile_artifacts (
    id              app.short_id DEFAULT app.new_id() NOT NULL,
    member_profile_version_id app.short_id NOT NULL
        REFERENCES app.member_profile_versions(id) ON DELETE CASCADE,
    model           text NOT NULL,
    dimensions      integer NOT NULL,
    source_version  text NOT NULL,
    chunk_index     integer NOT NULL DEFAULT 0,
    source_text     text NOT NULL,
    source_hash     text NOT NULL,
    embedding_vector vector(1536) NOT NULL,
    metadata        jsonb NOT NULL DEFAULT '{}',
    created_at      timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT embeddings_member_profile_artifacts_pkey PRIMARY KEY (id),
    CONSTRAINT embeddings_member_profile_artifacts_dims_check CHECK (dimensions > 0)
);

CREATE UNIQUE INDEX embeddings_mpa_version_model_unique_idx
    ON app.embeddings_member_profile_artifacts
    (member_profile_version_id, model, dimensions, source_version, chunk_index);

-- Fast lookup for semantic search: join current profiles to their artifacts.
CREATE INDEX embeddings_mpa_version_id_idx
    ON app.embeddings_member_profile_artifacts (member_profile_version_id);

ALTER TABLE app.embeddings_member_profile_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY app.embeddings_member_profile_artifacts FORCE ROW LEVEL SECURITY;

CREATE POLICY embeddings_mpa_all_security_definer_owner
    ON app.embeddings_member_profile_artifacts
    FOR ALL
    USING (current_user = 'clawclub_security_definer_owner')
    WITH CHECK (current_user = 'clawclub_security_definer_owner');

GRANT SELECT, INSERT, DELETE ON TABLE app.embeddings_member_profile_artifacts
    TO clawclub_security_definer_owner;

-- ── 4. Entity artifact table ──────────────────────────────────────────────────

CREATE TABLE app.embeddings_entity_artifacts (
    id              app.short_id DEFAULT app.new_id() NOT NULL,
    entity_version_id app.short_id NOT NULL
        REFERENCES app.entity_versions(id) ON DELETE CASCADE,
    model           text NOT NULL,
    dimensions      integer NOT NULL,
    source_version  text NOT NULL,
    chunk_index     integer NOT NULL DEFAULT 0,
    source_text     text NOT NULL,
    source_hash     text NOT NULL,
    embedding_vector vector(1536) NOT NULL,
    metadata        jsonb NOT NULL DEFAULT '{}',
    created_at      timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT embeddings_entity_artifacts_pkey PRIMARY KEY (id),
    CONSTRAINT embeddings_entity_artifacts_dims_check CHECK (dimensions > 0)
);

CREATE UNIQUE INDEX embeddings_ea_version_model_unique_idx
    ON app.embeddings_entity_artifacts
    (entity_version_id, model, dimensions, source_version, chunk_index);

CREATE INDEX embeddings_ea_version_id_idx
    ON app.embeddings_entity_artifacts (entity_version_id);

ALTER TABLE app.embeddings_entity_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY app.embeddings_entity_artifacts FORCE ROW LEVEL SECURITY;

CREATE POLICY embeddings_ea_all_security_definer_owner
    ON app.embeddings_entity_artifacts
    FOR ALL
    USING (current_user = 'clawclub_security_definer_owner')
    WITH CHECK (current_user = 'clawclub_security_definer_owner');

GRANT SELECT, INSERT, DELETE ON TABLE app.embeddings_entity_artifacts
    TO clawclub_security_definer_owner;

-- ── 5. Shared jobs queue ──────────────────────────────────────────────────────

CREATE TABLE app.embeddings_jobs (
    id              app.short_id DEFAULT app.new_id() NOT NULL,
    subject_kind    text NOT NULL,
    subject_version_id app.short_id NOT NULL,
    model           text NOT NULL,
    dimensions      integer NOT NULL,
    source_version  text NOT NULL,
    attempt_count   integer NOT NULL DEFAULT 0,
    next_attempt_at timestamp with time zone NOT NULL DEFAULT now(),
    failure_kind    text,  -- 'config' or 'work'
    last_error      text,
    created_at      timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT embeddings_jobs_pkey PRIMARY KEY (id),
    CONSTRAINT embeddings_jobs_subject_kind_check
        CHECK (subject_kind IN ('member_profile_version', 'entity_version')),
    CONSTRAINT embeddings_jobs_dims_check CHECK (dimensions > 0),
    CONSTRAINT embeddings_jobs_unique
        UNIQUE (subject_kind, subject_version_id, model, dimensions, source_version)
);

CREATE INDEX embeddings_jobs_pending_idx
    ON app.embeddings_jobs (next_attempt_at ASC)
    WHERE attempt_count < 5;

ALTER TABLE app.embeddings_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY app.embeddings_jobs FORCE ROW LEVEL SECURITY;

CREATE POLICY embeddings_jobs_all_security_definer_owner
    ON app.embeddings_jobs
    FOR ALL
    USING (current_user = 'clawclub_security_definer_owner')
    WITH CHECK (current_user = 'clawclub_security_definer_owner');

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.embeddings_jobs
    TO clawclub_security_definer_owner;

-- ── 6. Security-definer functions ─────────────────────────────────────────────

-- Enqueue a job (called in write transactions).
CREATE FUNCTION app.embeddings_enqueue_job(
    p_subject_kind text,
    p_subject_version_id app.short_id,
    p_model text,
    p_dimensions integer,
    p_source_version text
) RETURNS void
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path TO 'app', 'pg_temp'
AS $$
    INSERT INTO app.embeddings_jobs (subject_kind, subject_version_id, model, dimensions, source_version)
    VALUES (p_subject_kind, p_subject_version_id, p_model, p_dimensions, p_source_version)
    ON CONFLICT (subject_kind, subject_version_id, model, dimensions, source_version) DO NOTHING;
$$;

ALTER FUNCTION app.embeddings_enqueue_job(text, app.short_id, text, integer, text)
    OWNER TO clawclub_security_definer_owner;

-- Claim jobs for processing.
CREATE FUNCTION app.embeddings_claim_jobs(
    p_max_attempts integer,
    p_limit integer
) RETURNS TABLE (
    id app.short_id,
    subject_kind text,
    subject_version_id app.short_id,
    model text,
    dimensions integer,
    source_version text,
    attempt_count integer
)
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path TO 'app', 'pg_temp'
AS $$
    UPDATE app.embeddings_jobs ej
    SET next_attempt_at = now() + interval '10 minutes'
    FROM (
        SELECT ej2.id
        FROM app.embeddings_jobs ej2
        WHERE ej2.next_attempt_at <= now() AND ej2.attempt_count < p_max_attempts
        ORDER BY ej2.next_attempt_at ASC
        LIMIT p_limit
        FOR UPDATE SKIP LOCKED
    ) claimed
    WHERE ej.id = claimed.id
    RETURNING ej.id, ej.subject_kind, ej.subject_version_id, ej.model,
              ej.dimensions, ej.source_version, ej.attempt_count;
$$;

ALTER FUNCTION app.embeddings_claim_jobs(integer, integer)
    OWNER TO clawclub_security_definer_owner;

-- Complete (delete) jobs.
CREATE FUNCTION app.embeddings_complete_jobs(
    p_job_ids app.short_id[]
) RETURNS void
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path TO 'app', 'pg_temp'
AS $$
    DELETE FROM app.embeddings_jobs WHERE id = ANY(p_job_ids);
$$;

ALTER FUNCTION app.embeddings_complete_jobs(app.short_id[])
    OWNER TO clawclub_security_definer_owner;

-- Retry with penalty (true work failures).
CREATE FUNCTION app.embeddings_retry_jobs(
    p_job_ids app.short_id[],
    p_error text
) RETURNS void
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path TO 'app', 'pg_temp'
AS $$
    UPDATE app.embeddings_jobs
    SET attempt_count = attempt_count + 1,
        next_attempt_at = now() + (power(2, attempt_count) * interval '1 minute'),
        failure_kind = 'work',
        last_error = p_error
    WHERE id = ANY(p_job_ids);
$$;

ALTER FUNCTION app.embeddings_retry_jobs(app.short_id[], text)
    OWNER TO clawclub_security_definer_owner;

-- Release without penalty (config/outage failures).
CREATE FUNCTION app.embeddings_release_jobs(
    p_job_ids app.short_id[]
) RETURNS void
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path TO 'app', 'pg_temp'
AS $$
    UPDATE app.embeddings_jobs
    SET next_attempt_at = now(),
        failure_kind = 'config',
        last_error = 'Released without penalty'
    WHERE id = ANY(p_job_ids);
$$;

ALTER FUNCTION app.embeddings_release_jobs(app.short_id[])
    OWNER TO clawclub_security_definer_owner;

-- Load profile version for embedding (bypasses RLS).
CREATE FUNCTION app.embeddings_load_profile_version(
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

ALTER FUNCTION app.embeddings_load_profile_version(app.short_id)
    OWNER TO clawclub_security_definer_owner;

-- Load entity version for embedding (bypasses RLS).
CREATE FUNCTION app.embeddings_load_entity_version(
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

ALTER FUNCTION app.embeddings_load_entity_version(app.short_id)
    OWNER TO clawclub_security_definer_owner;

-- Insert profile artifact.
CREATE FUNCTION app.embeddings_insert_profile_artifact(
    p_member_profile_version_id app.short_id,
    p_model text,
    p_dimensions integer,
    p_source_version text,
    p_chunk_index integer,
    p_source_text text,
    p_source_hash text,
    p_embedding_vector vector,
    p_metadata jsonb
) RETURNS app.short_id
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path TO 'app', 'pg_temp'
AS $$
    INSERT INTO app.embeddings_member_profile_artifacts (
        member_profile_version_id, model, dimensions, source_version,
        chunk_index, source_text, source_hash, embedding_vector, metadata
    )
    VALUES (
        p_member_profile_version_id, p_model, p_dimensions, p_source_version,
        p_chunk_index, p_source_text, p_source_hash, p_embedding_vector, p_metadata
    )
    ON CONFLICT (member_profile_version_id, model, dimensions, source_version, chunk_index)
    DO NOTHING
    RETURNING id;
$$;

ALTER FUNCTION app.embeddings_insert_profile_artifact(app.short_id, text, integer, text, integer, text, text, vector, jsonb)
    OWNER TO clawclub_security_definer_owner;

-- Insert entity artifact.
CREATE FUNCTION app.embeddings_insert_entity_artifact(
    p_entity_version_id app.short_id,
    p_model text,
    p_dimensions integer,
    p_source_version text,
    p_chunk_index integer,
    p_source_text text,
    p_source_hash text,
    p_embedding_vector vector,
    p_metadata jsonb
) RETURNS app.short_id
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path TO 'app', 'pg_temp'
AS $$
    INSERT INTO app.embeddings_entity_artifacts (
        entity_version_id, model, dimensions, source_version,
        chunk_index, source_text, source_hash, embedding_vector, metadata
    )
    VALUES (
        p_entity_version_id, p_model, p_dimensions, p_source_version,
        p_chunk_index, p_source_text, p_source_hash, p_embedding_vector, p_metadata
    )
    ON CONFLICT (entity_version_id, model, dimensions, source_version, chunk_index)
    DO NOTHING
    RETURNING id;
$$;

ALTER FUNCTION app.embeddings_insert_entity_artifact(app.short_id, text, integer, text, integer, text, text, vector, jsonb)
    OWNER TO clawclub_security_definer_owner;

-- Backfill: list current profile versions missing artifacts.
CREATE FUNCTION app.embeddings_list_profiles_needing_artifacts(
    p_model text,
    p_dimensions integer,
    p_source_version text
) RETURNS TABLE (version_id app.short_id)
    LANGUAGE sql STABLE
    SECURITY DEFINER
    SET search_path TO 'app', 'pg_temp'
AS $$
    SELECT cmp.id AS version_id
    FROM app.current_member_profiles cmp
    JOIN app.members m ON m.id = cmp.member_id AND m.state = 'active'
    WHERE NOT EXISTS (
        SELECT 1 FROM app.embeddings_member_profile_artifacts a
        WHERE a.member_profile_version_id = cmp.id
          AND a.model = p_model
          AND a.dimensions = p_dimensions
          AND a.source_version = p_source_version
    );
$$;

ALTER FUNCTION app.embeddings_list_profiles_needing_artifacts(text, integer, text)
    OWNER TO clawclub_security_definer_owner;

-- Backfill: list current published entity versions missing artifacts.
CREATE FUNCTION app.embeddings_list_entities_needing_artifacts(
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

ALTER FUNCTION app.embeddings_list_entities_needing_artifacts(text, integer, text)
    OWNER TO clawclub_security_definer_owner;

-- ── 7. Full-text search infrastructure ────────────────────────────────────────

-- Add a tsvector column to member_profile_versions for FTS.
ALTER TABLE app.member_profile_versions
    ADD COLUMN search_vector tsvector;

-- Backfill existing rows.
UPDATE app.member_profile_versions
SET search_vector = to_tsvector('english',
    coalesce(display_name, '') || ' ' ||
    coalesce(tagline, '') || ' ' ||
    coalesce(summary, '') || ' ' ||
    coalesce(what_i_do, '') || ' ' ||
    coalesce(known_for, '') || ' ' ||
    coalesce(services_summary, '')
);

-- GIN index for fast FTS queries.
CREATE INDEX member_profile_versions_search_vector_idx
    ON app.member_profile_versions USING GIN (search_vector);

-- Trigger to auto-update search_vector on INSERT or UPDATE.
CREATE FUNCTION app.member_profile_versions_search_vector_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.search_vector := to_tsvector('english',
        coalesce(NEW.display_name, '') || ' ' ||
        coalesce(NEW.tagline, '') || ' ' ||
        coalesce(NEW.summary, '') || ' ' ||
        coalesce(NEW.what_i_do, '') || ' ' ||
        coalesce(NEW.known_for, '') || ' ' ||
        coalesce(NEW.services_summary, '')
    );
    RETURN NEW;
END;
$$;

CREATE TRIGGER member_profile_versions_search_vector_update
    BEFORE INSERT OR UPDATE ON app.member_profile_versions
    FOR EACH ROW
    EXECUTE FUNCTION app.member_profile_versions_search_vector_trigger();

-- ── 8. Explicit EXECUTE grants for app role ───────────────────────────────────

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clawclub_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION app.embeddings_enqueue_job(text, app.short_id, text, integer, text) TO clawclub_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION app.embeddings_claim_jobs(integer, integer) TO clawclub_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION app.embeddings_complete_jobs(app.short_id[]) TO clawclub_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION app.embeddings_retry_jobs(app.short_id[], text) TO clawclub_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION app.embeddings_release_jobs(app.short_id[]) TO clawclub_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION app.embeddings_load_profile_version(app.short_id) TO clawclub_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION app.embeddings_load_entity_version(app.short_id) TO clawclub_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION app.embeddings_insert_profile_artifact(app.short_id, text, integer, text, integer, text, text, vector, jsonb) TO clawclub_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION app.embeddings_insert_entity_artifact(app.short_id, text, integer, text, integer, text, text, vector, jsonb) TO clawclub_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION app.embeddings_list_profiles_needing_artifacts(text, integer, text) TO clawclub_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION app.embeddings_list_entities_needing_artifacts(text, integer, text) TO clawclub_app';
  END IF;
END $$;
