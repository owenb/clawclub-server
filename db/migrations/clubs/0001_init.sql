-- Club database schema — greenfield init (first content shard)
-- Part of the identity/messaging/club database split.
-- Owns: entities, events, RSVPs, admissions, vouches, club activity, quotas, entity embeddings.
-- NO RLS, NO security definer roles.
-- NOTE: Do NOT wrap in BEGIN/COMMIT — the migration runner uses --single-transaction.

SET check_function_bodies = false;
SET default_tablespace = '';
SET default_table_access_method = heap;

-- ============================================================
-- Extensions
-- ============================================================

CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================
-- Schema
-- ============================================================

CREATE SCHEMA app;

-- ============================================================
-- Domain
-- ============================================================

CREATE DOMAIN app.short_id AS text
    CONSTRAINT short_id_check CHECK (VALUE ~ '^[23456789abcdefghjkmnpqrstuvwxyz]{12}$');

-- ============================================================
-- ID generator
-- ============================================================

CREATE FUNCTION app.new_id() RETURNS app.short_id
    LANGUAGE plpgsql
AS $$
declare
  alphabet constant text := '23456789abcdefghjkmnpqrstuvwxyz';
  output text := '';
  idx integer;
begin
  for idx in 1..12 loop
    output := output || substr(alphabet, 1 + floor(random() * length(alphabet))::integer, 1);
  end loop;

  return output::app.short_id;
end;
$$;

-- ============================================================
-- Enums
-- ============================================================

CREATE TYPE app.entity_kind AS ENUM (
    'post',
    'opportunity',
    'service',
    'ask',
    'event',
    'comment',
    'complaint'
);

CREATE TYPE app.entity_state AS ENUM (
    'draft',
    'published',
    'removed'
);

CREATE TYPE app.edge_kind AS ENUM (
    'vouched_for',
    'about',
    'related_to',
    'mentions'
);

CREATE TYPE app.rsvp_state AS ENUM (
    'yes',
    'maybe',
    'no',
    'waitlist'
);

CREATE TYPE app.work_mode AS ENUM (
    'unspecified',
    'remote',
    'in_person',
    'hybrid'
);

CREATE TYPE app.compensation_kind AS ENUM (
    'unspecified',
    'paid',
    'unpaid',
    'mixed',
    'exchange'
);

CREATE TYPE app.application_status AS ENUM (
    'draft',
    'submitted',
    'interview_scheduled',
    'interview_completed',
    'accepted',
    'declined',
    'withdrawn'
);

CREATE TYPE app.quality_gate_status AS ENUM (
    'passed',
    'rejected',
    'rejected_illegal',
    'skipped'
);

CREATE TYPE app.club_activity_audience AS ENUM (
    'members',
    'clubadmins',
    'owners'
);

-- ============================================================
-- Canonical club-content tables
-- Member and club IDs are soft references to the identity database.
-- Display names are resolved at the application layer.
-- ============================================================

-- ── entities ───────────────────────────────────────────────

CREATE TABLE app.entities (
    id                  app.short_id DEFAULT app.new_id() NOT NULL,
    club_id             text NOT NULL,          -- soft ref to clubs (replicated)
    kind                app.entity_kind NOT NULL,
    author_member_id    text NOT NULL,          -- soft ref to members (replicated)
    parent_entity_id    app.short_id,
    client_key          text,                   -- idempotency key
    created_at          timestamptz DEFAULT now() NOT NULL,
    archived_at         timestamptz,
    deleted_at          timestamptz,
    metadata            jsonb DEFAULT '{}' NOT NULL,

    CONSTRAINT entities_pkey PRIMARY KEY (id),
    CONSTRAINT entities_comment_parent_check CHECK (
        (kind = 'comment' AND parent_entity_id IS NOT NULL) OR kind <> 'comment'
    ),
    CONSTRAINT entities_parent_fkey
        FOREIGN KEY (parent_entity_id) REFERENCES app.entities(id)
);

-- Idempotency: one client_key per author
CREATE UNIQUE INDEX entities_idempotent_idx
    ON app.entities (author_member_id, client_key) WHERE client_key IS NOT NULL;

CREATE INDEX entities_club_kind_idx
    ON app.entities (club_id, kind, created_at DESC);
CREATE INDEX entities_author_idx
    ON app.entities (author_member_id, created_at DESC);
CREATE INDEX entities_parent_idx
    ON app.entities (parent_entity_id);
CREATE INDEX entities_live_idx
    ON app.entities (club_id, kind) WHERE archived_at IS NULL AND deleted_at IS NULL;

-- ── entity_versions ────────────────────────────────────────

CREATE TABLE app.entity_versions (
    id                      app.short_id DEFAULT app.new_id() NOT NULL,
    entity_id               app.short_id NOT NULL,
    version_no              integer NOT NULL,
    state                   app.entity_state DEFAULT 'published' NOT NULL,
    title                   text,
    summary                 text,
    body                    text,
    location                text,
    work_mode               app.work_mode DEFAULT 'unspecified' NOT NULL,
    compensation            app.compensation_kind DEFAULT 'unspecified' NOT NULL,
    starts_at               timestamptz,
    ends_at                 timestamptz,
    timezone                text,
    recurrence_rule         text,
    capacity                integer,
    effective_at            timestamptz DEFAULT now() NOT NULL,
    expires_at              timestamptz,
    content                 jsonb DEFAULT '{}' NOT NULL,
    reason                  text,
    supersedes_version_id   app.short_id,
    created_at              timestamptz DEFAULT now() NOT NULL,
    created_by_member_id    text,           -- soft ref to members

    CONSTRAINT entity_versions_pkey PRIMARY KEY (id),
    CONSTRAINT entity_versions_entity_version_unique UNIQUE (entity_id, version_no),
    CONSTRAINT entity_versions_version_no_check CHECK (version_no > 0),
    CONSTRAINT entity_versions_capacity_check CHECK (capacity IS NULL OR capacity > 0),
    CONSTRAINT entity_versions_dates_check CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at >= starts_at),
    CONSTRAINT entity_versions_expiry_check CHECK (expires_at IS NULL OR expires_at >= effective_at),
    CONSTRAINT entity_versions_entity_fkey
        FOREIGN KEY (entity_id) REFERENCES app.entities(id),
    CONSTRAINT entity_versions_supersedes_fkey
        FOREIGN KEY (supersedes_version_id) REFERENCES app.entity_versions(id)
);

CREATE INDEX entity_versions_entity_version_idx
    ON app.entity_versions (entity_id, version_no DESC);
CREATE INDEX entity_versions_effective_idx
    ON app.entity_versions (effective_at DESC);
CREATE INDEX entity_versions_starts_idx
    ON app.entity_versions (starts_at);
CREATE INDEX entity_versions_expires_idx
    ON app.entity_versions (expires_at);

-- ── event_rsvps ────────────────────────────────────────────

CREATE TABLE app.event_rsvps (
    id                      app.short_id DEFAULT app.new_id() NOT NULL,
    event_entity_id         app.short_id NOT NULL,
    membership_id           text NOT NULL,      -- soft ref to identity club_memberships
    response                app.rsvp_state NOT NULL,
    note                    text,
    client_key              text,               -- idempotency key
    version_no              integer DEFAULT 1 NOT NULL,
    supersedes_rsvp_id      app.short_id,
    created_at              timestamptz DEFAULT now() NOT NULL,
    created_by_member_id    text,               -- soft ref to members

    CONSTRAINT event_rsvps_pkey PRIMARY KEY (id),
    CONSTRAINT event_rsvps_event_membership_version_unique UNIQUE (event_entity_id, membership_id, version_no),
    CONSTRAINT event_rsvps_event_fkey
        FOREIGN KEY (event_entity_id) REFERENCES app.entities(id),
    CONSTRAINT event_rsvps_supersedes_fkey
        FOREIGN KEY (supersedes_rsvp_id) REFERENCES app.event_rsvps(id)
);

-- Idempotency: one client_key per creator
CREATE UNIQUE INDEX event_rsvps_idempotent_idx
    ON app.event_rsvps (created_by_member_id, client_key) WHERE client_key IS NOT NULL;

CREATE INDEX event_rsvps_event_idx
    ON app.event_rsvps (event_entity_id, response);
CREATE INDEX event_rsvps_event_membership_version_idx
    ON app.event_rsvps (event_entity_id, membership_id, version_no DESC, created_at DESC);
CREATE INDEX event_rsvps_membership_idx
    ON app.event_rsvps (membership_id, created_at DESC);

-- ── edges ──────────────────────────────────────────────────

CREATE TABLE app.edges (
    id                      app.short_id DEFAULT app.new_id() NOT NULL,
    club_id                 text,               -- soft ref to clubs
    kind                    app.edge_kind NOT NULL,
    from_member_id          text,               -- soft ref to members
    from_entity_id          app.short_id,
    from_entity_version_id  app.short_id,
    to_member_id            text,               -- soft ref to members
    to_entity_id            app.short_id,
    to_entity_version_id    app.short_id,
    reason                  text,
    metadata                jsonb DEFAULT '{}' NOT NULL,
    client_key              text,               -- idempotency key
    created_by_member_id    text,               -- soft ref to members
    created_at              timestamptz DEFAULT now() NOT NULL,
    archived_at             timestamptz,

    CONSTRAINT edges_pkey PRIMARY KEY (id),
    CONSTRAINT edges_from_check CHECK (
        ((from_member_id IS NOT NULL)::integer
        + (from_entity_id IS NOT NULL)::integer
        + (from_entity_version_id IS NOT NULL)::integer) = 1
    ),
    CONSTRAINT edges_to_check CHECK (
        ((to_member_id IS NOT NULL)::integer
        + (to_entity_id IS NOT NULL)::integer
        + (to_entity_version_id IS NOT NULL)::integer) = 1
    ),
    CONSTRAINT edges_vouch_check CHECK (
        kind <> 'vouched_for' OR (from_member_id IS NOT NULL AND to_member_id IS NOT NULL AND reason IS NOT NULL)
    ),
    CONSTRAINT edges_no_self_vouch CHECK (
        kind <> 'vouched_for' OR from_member_id <> to_member_id
    ),
    CONSTRAINT edges_from_entity_fkey
        FOREIGN KEY (from_entity_id) REFERENCES app.entities(id),
    CONSTRAINT edges_from_entity_version_fkey
        FOREIGN KEY (from_entity_version_id) REFERENCES app.entity_versions(id),
    CONSTRAINT edges_to_entity_fkey
        FOREIGN KEY (to_entity_id) REFERENCES app.entities(id),
    CONSTRAINT edges_to_entity_version_fkey
        FOREIGN KEY (to_entity_version_id) REFERENCES app.entity_versions(id)
);

-- Idempotency: one client_key per creator
CREATE UNIQUE INDEX edges_idempotent_idx
    ON app.edges (created_by_member_id, client_key) WHERE client_key IS NOT NULL;

CREATE UNIQUE INDEX edges_unique_active_vouch
    ON app.edges (club_id, from_member_id, to_member_id)
    WHERE kind = 'vouched_for' AND archived_at IS NULL;

CREATE INDEX edges_club_kind_idx
    ON app.edges (club_id, kind, created_at DESC);
CREATE INDEX edges_from_member_idx
    ON app.edges (from_member_id, kind, created_at DESC);
CREATE INDEX edges_to_entity_idx
    ON app.edges (to_entity_id, kind, created_at DESC);
CREATE INDEX edges_to_member_idx
    ON app.edges (to_member_id, kind, created_at DESC);

-- ── admissions ─────────────────────────────────────────────

CREATE TABLE app.admissions (
    id                  app.short_id DEFAULT app.new_id() NOT NULL,
    club_id             text NOT NULL,          -- soft ref to clubs
    applicant_member_id text,                   -- soft ref to members (null for cold apply)
    sponsor_member_id   text,                   -- soft ref to members
    membership_id       text,                   -- soft ref to identity club_memberships
    origin              text NOT NULL,
    metadata            jsonb DEFAULT '{}' NOT NULL,
    created_at          timestamptz DEFAULT now() NOT NULL,
    applicant_email     text,
    applicant_name      text,
    admission_details   jsonb DEFAULT '{}' NOT NULL,

    CONSTRAINT admissions_pkey PRIMARY KEY (id),
    CONSTRAINT admissions_origin_check CHECK (
        origin IN ('self_applied', 'member_sponsored', 'owner_nominated')
    ),
    CONSTRAINT admissions_outsider_identity_check CHECK (
        (origin = 'owner_nominated' AND applicant_member_id IS NOT NULL)
        OR (origin IN ('self_applied', 'member_sponsored')
            AND applicant_email IS NOT NULL
            AND applicant_name IS NOT NULL
            AND length(btrim(applicant_email)) > 0
            AND length(btrim(applicant_name)) > 0)
    )
);

CREATE INDEX admissions_club_created_idx
    ON app.admissions (club_id, created_at DESC);

-- ── admission_versions ─────────────────────────────────────

CREATE TABLE app.admission_versions (
    id                      app.short_id DEFAULT app.new_id() NOT NULL,
    admission_id            app.short_id NOT NULL,
    status                  app.application_status NOT NULL,
    notes                   text,
    intake_kind             text DEFAULT 'other' NOT NULL,
    intake_price_amount     numeric(12,2),
    intake_price_currency   text,
    intake_booking_url      text,
    intake_booked_at        timestamptz,
    intake_completed_at     timestamptz,
    version_no              integer NOT NULL,
    supersedes_version_id   app.short_id,
    created_at              timestamptz DEFAULT now() NOT NULL,
    created_by_member_id    text,               -- soft ref to members

    CONSTRAINT admission_versions_pkey PRIMARY KEY (id),
    CONSTRAINT admission_versions_admission_version_unique UNIQUE (admission_id, version_no),
    CONSTRAINT admission_versions_version_no_check CHECK (version_no > 0),
    CONSTRAINT admission_versions_intake_kind_check CHECK (
        intake_kind IN ('fit_check', 'advice_call', 'other')
    ),
    CONSTRAINT admission_versions_intake_price_check CHECK (
        intake_price_amount IS NULL OR intake_price_amount >= 0
    ),
    CONSTRAINT admission_versions_intake_currency_check CHECK (
        intake_price_currency IS NULL OR intake_price_currency ~ '^[A-Z]{3}$'
    ),
    CONSTRAINT admission_versions_intake_dates_check CHECK (
        intake_completed_at IS NULL OR intake_booked_at IS NULL OR intake_completed_at >= intake_booked_at
    ),
    CONSTRAINT admission_versions_admission_fkey
        FOREIGN KEY (admission_id) REFERENCES app.admissions(id),
    CONSTRAINT admission_versions_supersedes_fkey
        FOREIGN KEY (supersedes_version_id) REFERENCES app.admission_versions(id)
);

CREATE INDEX admission_versions_admission_version_idx
    ON app.admission_versions (admission_id, version_no DESC, created_at DESC);

-- ── admission_challenges ───────────────────────────────────

CREATE TABLE app.admission_challenges (
    id              app.short_id DEFAULT app.new_id() NOT NULL,
    difficulty      integer NOT NULL,
    club_id         text,                       -- soft ref to clubs
    policy_snapshot text,
    club_name       text,
    club_summary    text,
    owner_name      text,
    expires_at      timestamptz NOT NULL,
    created_at      timestamptz DEFAULT now() NOT NULL,

    CONSTRAINT admission_challenges_pkey PRIMARY KEY (id),
    CONSTRAINT admission_challenges_difficulty_check CHECK (difficulty > 0),
    CONSTRAINT admission_challenges_expiry_check CHECK (expires_at > created_at)
);

CREATE INDEX admission_challenges_expires_idx
    ON app.admission_challenges (expires_at);

-- ── admission_attempts ─────────────────────────────────────

CREATE TABLE app.admission_attempts (
    id                  app.short_id DEFAULT app.new_id() NOT NULL,
    challenge_id        app.short_id NOT NULL,
    club_id             text NOT NULL,          -- soft ref to clubs
    attempt_no          integer NOT NULL,
    applicant_name      text NOT NULL,
    applicant_email     text NOT NULL,
    payload             jsonb NOT NULL DEFAULT '{}',
    gate_status         app.quality_gate_status NOT NULL,
    gate_feedback       text,
    policy_snapshot     text NOT NULL,
    created_at          timestamptz DEFAULT now() NOT NULL,

    CONSTRAINT admission_attempts_pkey PRIMARY KEY (id),
    CONSTRAINT admission_attempts_attempt_no_check CHECK (attempt_no BETWEEN 1 AND 5)
);

CREATE INDEX admission_attempts_challenge_idx
    ON app.admission_attempts (challenge_id, attempt_no);

-- ── club_activity ──────────────────────────────────────────

CREATE TABLE app.club_activity (
    id                      app.short_id DEFAULT app.new_id() NOT NULL,
    club_id                 text NOT NULL,          -- soft ref to clubs
    seq                     bigint GENERATED ALWAYS AS IDENTITY,
    topic                   text NOT NULL,
    audience                app.club_activity_audience NOT NULL DEFAULT 'members',
    payload                 jsonb NOT NULL DEFAULT '{}',
    entity_id               app.short_id,
    entity_version_id       app.short_id,
    created_by_member_id    text,                   -- soft ref to members
    created_at              timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT club_activity_pkey PRIMARY KEY (id),
    CONSTRAINT club_activity_seq_unique UNIQUE (seq),
    CONSTRAINT club_activity_topic_check CHECK (length(btrim(topic)) > 0),
    CONSTRAINT club_activity_entity_fkey
        FOREIGN KEY (entity_id) REFERENCES app.entities(id)
);

-- Primary query path: "activity for this club since seq N"
CREATE INDEX club_activity_club_seq_idx ON app.club_activity (club_id, seq);

-- ── club_activity_cursors ──────────────────────────────────

CREATE TABLE app.club_activity_cursors (
    member_id       text NOT NULL,              -- soft ref to members
    club_id         text NOT NULL,              -- soft ref to clubs
    last_seq        bigint NOT NULL DEFAULT 0,
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT club_activity_cursors_pkey PRIMARY KEY (member_id, club_id)
);

-- ── club_quota_policies ────────────────────────────────────

CREATE TABLE app.club_quota_policies (
    id              app.short_id DEFAULT app.new_id() NOT NULL,
    club_id         text NOT NULL,              -- soft ref to clubs
    action_name     text NOT NULL,
    max_per_day     integer NOT NULL,
    created_at      timestamptz DEFAULT now() NOT NULL,
    updated_at      timestamptz DEFAULT now() NOT NULL,

    CONSTRAINT club_quota_policies_pkey PRIMARY KEY (id),
    CONSTRAINT club_quota_policies_club_action_unique UNIQUE (club_id, action_name),
    CONSTRAINT club_quota_policies_action_check CHECK (
        action_name IN ('entities.create', 'events.create')
    ),
    CONSTRAINT club_quota_policies_max_check CHECK (max_per_day > 0)
);

-- ── club-scope redactions (entity removals are version-based; this covers dm_message removals) ──

-- NOTE: The old cross-cutting app.redactions table is gone. Entity removals
-- use entity_versions with state='removed'. DM message removals are in the
-- messaging DB. This space intentionally left without a redactions table.

-- ── embeddings_entity_artifacts ────────────────────────────

CREATE TABLE app.embeddings_entity_artifacts (
    id                  app.short_id DEFAULT app.new_id() NOT NULL,
    entity_version_id   app.short_id NOT NULL,
    model               text NOT NULL,
    dimensions          integer NOT NULL,
    source_version      text NOT NULL,
    chunk_index         integer NOT NULL DEFAULT 0,
    source_text         text NOT NULL,
    source_hash         text NOT NULL,
    embedding_vector    vector(1536) NOT NULL,
    metadata            jsonb NOT NULL DEFAULT '{}',
    created_at          timestamptz DEFAULT now() NOT NULL,

    CONSTRAINT embeddings_entity_artifacts_pkey PRIMARY KEY (id),
    CONSTRAINT embeddings_entity_artifacts_unique
        UNIQUE (entity_version_id, model, dimensions, source_version, chunk_index),
    CONSTRAINT embeddings_entity_artifacts_dims_check CHECK (dimensions > 0),
    CONSTRAINT embeddings_entity_artifacts_version_fkey
        FOREIGN KEY (entity_version_id) REFERENCES app.entity_versions(id) ON DELETE CASCADE
);

CREATE INDEX embeddings_entity_artifacts_version_idx
    ON app.embeddings_entity_artifacts (entity_version_id);

-- ── embeddings_jobs (club instance — entity embeddings only) ──

CREATE TABLE app.embeddings_jobs (
    id                  app.short_id DEFAULT app.new_id() NOT NULL,
    subject_kind        text NOT NULL,
    subject_version_id  app.short_id NOT NULL,
    model               text NOT NULL,
    dimensions          integer NOT NULL,
    source_version      text NOT NULL,
    attempt_count       integer NOT NULL DEFAULT 0,
    next_attempt_at     timestamptz NOT NULL DEFAULT now(),
    failure_kind        text,
    last_error          text,
    created_at          timestamptz DEFAULT now() NOT NULL,

    CONSTRAINT embeddings_jobs_pkey PRIMARY KEY (id),
    CONSTRAINT embeddings_jobs_unique
        UNIQUE (subject_kind, subject_version_id, model, dimensions, source_version),
    CONSTRAINT embeddings_jobs_subject_kind_check CHECK (subject_kind = 'entity_version'),
    CONSTRAINT embeddings_jobs_dims_check CHECK (dimensions > 0)
);

CREATE INDEX embeddings_jobs_claimable_idx
    ON app.embeddings_jobs (next_attempt_at ASC) WHERE attempt_count < 5;

-- ── llm_usage_log ──────────────────────────────────────────

CREATE TABLE app.llm_usage_log (
    id                      app.short_id DEFAULT app.new_id() NOT NULL,
    member_id               text,               -- soft ref to members
    requested_club_id       text,               -- soft ref to clubs
    action_name             text NOT NULL,
    gate_name               text NOT NULL DEFAULT 'quality_gate',
    provider                text NOT NULL,
    model                   text NOT NULL,
    gate_status             app.quality_gate_status NOT NULL,
    skip_reason             text,
    prompt_tokens           integer,
    completion_tokens       integer,
    provider_error_code     text,
    created_at              timestamptz DEFAULT now() NOT NULL,

    CONSTRAINT llm_usage_log_pkey PRIMARY KEY (id),
    CONSTRAINT llm_usage_log_skip_reason_check CHECK (
        (gate_status = 'skipped' AND skip_reason IS NOT NULL)
        OR (gate_status <> 'skipped' AND skip_reason IS NULL)
    )
);

CREATE INDEX llm_usage_log_club_created_idx
    ON app.llm_usage_log (requested_club_id, created_at DESC);
CREATE INDEX llm_usage_log_member_created_idx
    ON app.llm_usage_log (member_id, created_at DESC);

-- ============================================================
-- NOTIFY triggers (for SSE streaming)
-- ============================================================

CREATE FUNCTION app.notify_club_activity() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM pg_notify('club_activity', json_build_object('clubId', NEW.club_id)::text);
    RETURN NEW;
END;
$$;

CREATE TRIGGER club_activity_notify
    AFTER INSERT ON app.club_activity
    FOR EACH ROW
    EXECUTE FUNCTION app.notify_club_activity();

-- ============================================================
-- Views
-- ============================================================

CREATE VIEW app.current_admission_versions AS
    SELECT DISTINCT ON (admission_id) *
    FROM app.admission_versions
    ORDER BY admission_id, version_no DESC, created_at DESC;

CREATE VIEW app.current_admissions AS
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
    FROM app.admissions a
    JOIN app.current_admission_versions cav ON cav.admission_id = a.id;

CREATE VIEW app.current_entity_versions AS
    SELECT DISTINCT ON (entity_id) *
    FROM app.entity_versions
    ORDER BY entity_id, version_no DESC, created_at DESC;

CREATE VIEW app.current_published_entity_versions AS
    SELECT *
    FROM app.current_entity_versions
    WHERE state = 'published';

CREATE VIEW app.current_event_rsvps AS
    SELECT DISTINCT ON (event_entity_id, membership_id) *
    FROM app.event_rsvps
    ORDER BY event_entity_id, membership_id, version_no DESC, created_at DESC;

CREATE VIEW app.live_entities AS
    SELECT
        e.id                AS entity_id,
        e.club_id,
        e.kind,
        e.author_member_id,
        e.parent_entity_id,
        e.created_at        AS entity_created_at,
        cev.id              AS entity_version_id,
        cev.version_no,
        cev.state,
        cev.title,
        cev.summary,
        cev.body,
        cev.location,
        cev.work_mode,
        cev.compensation,
        cev.starts_at,
        cev.ends_at,
        cev.timezone,
        cev.recurrence_rule,
        cev.capacity,
        cev.effective_at,
        cev.expires_at,
        cev.content,
        cev.created_at      AS version_created_at,
        cev.created_by_member_id
    FROM app.entities e
    JOIN app.current_published_entity_versions cev ON cev.entity_id = e.id
    WHERE e.archived_at IS NULL
      AND e.deleted_at IS NULL
      AND (cev.expires_at IS NULL OR cev.expires_at > now());
