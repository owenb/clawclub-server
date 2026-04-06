-- Identity database schema — greenfield init
-- Part of the identity/messaging/club database split.
-- NO RLS, NO security definer roles, NO special roles.
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

CREATE TYPE app.member_state AS ENUM (
    'pending',
    'active',
    'suspended',
    'deleted'
);

CREATE TYPE app.membership_role AS ENUM (
    'clubadmin',
    'member'
);

CREATE TYPE app.membership_state AS ENUM (
    'invited',
    'active',
    'paused',
    'left',
    'removed',
    'pending_review',
    'revoked',
    'rejected'
);

CREATE TYPE app.global_role AS ENUM (
    'superadmin'
);

CREATE TYPE app.assignment_state AS ENUM (
    'active',
    'revoked'
);

CREATE TYPE app.subscription_status AS ENUM (
    'trialing',
    'active',
    'past_due',
    'paused',
    'canceled',
    'ended'
);

CREATE TYPE app.billing_interval AS ENUM (
    'month',
    'year',
    'manual'
);

-- ============================================================
-- Tables
-- ============================================================

-- ── members ─────────────────────────────────────────────────

CREATE TABLE app.members (
    id                  app.short_id DEFAULT app.new_id() NOT NULL,
    handle              text NOT NULL,
    public_name         text NOT NULL,
    state               app.member_state DEFAULT 'active' NOT NULL,
    source_admission_id text,           -- set when member was created from an outsider admission
    metadata            jsonb DEFAULT '{}' NOT NULL,
    created_at          timestamptz DEFAULT now() NOT NULL,

    CONSTRAINT members_pkey PRIMARY KEY (id),
    CONSTRAINT members_handle_unique UNIQUE (handle),
    CONSTRAINT members_public_name_check CHECK (length(btrim(public_name)) > 0)
);

CREATE INDEX members_state_idx ON app.members USING btree (state);

-- Durable admission anchor: prevents duplicate member creation on concurrent retries
CREATE UNIQUE INDEX members_source_admission_unique_idx
    ON app.members (source_admission_id) WHERE source_admission_id IS NOT NULL;

-- ── member_bearer_tokens ────────────────────────────────────

CREATE TABLE app.member_bearer_tokens (
    id              app.short_id DEFAULT app.new_id() NOT NULL,
    member_id       app.short_id NOT NULL,
    label           text,
    token_hash      text NOT NULL,
    created_at      timestamptz DEFAULT now() NOT NULL,
    last_used_at    timestamptz,
    revoked_at      timestamptz,
    metadata        jsonb DEFAULT '{}' NOT NULL,
    expires_at      timestamptz,

    CONSTRAINT member_bearer_tokens_pkey PRIMARY KEY (id),
    CONSTRAINT member_bearer_tokens_token_hash_unique UNIQUE (token_hash),
    CONSTRAINT member_bearer_tokens_member_id_fkey
        FOREIGN KEY (member_id) REFERENCES app.members(id)
);

CREATE INDEX member_bearer_tokens_member_created_idx
    ON app.member_bearer_tokens USING btree (member_id, created_at DESC);

CREATE INDEX member_bearer_tokens_active_idx
    ON app.member_bearer_tokens USING btree (id) WHERE revoked_at IS NULL;

-- ── member_global_role_versions ─────────────────────────────

CREATE TABLE app.member_global_role_versions (
    id                          app.short_id DEFAULT app.new_id() NOT NULL,
    member_id                   app.short_id NOT NULL,
    role                        app.global_role NOT NULL,
    status                      app.assignment_state DEFAULT 'active' NOT NULL,
    version_no                  integer NOT NULL,
    supersedes_role_version_id  app.short_id,
    created_at                  timestamptz DEFAULT now() NOT NULL,
    created_by_member_id        app.short_id,

    CONSTRAINT member_global_role_versions_pkey PRIMARY KEY (id),
    CONSTRAINT member_global_role_versions_version_unique UNIQUE (member_id, role, version_no),
    CONSTRAINT member_global_role_versions_version_no_check CHECK (version_no > 0),
    CONSTRAINT member_global_role_versions_member_id_fkey
        FOREIGN KEY (member_id) REFERENCES app.members(id),
    CONSTRAINT member_global_role_versions_supersedes_fkey
        FOREIGN KEY (supersedes_role_version_id) REFERENCES app.member_global_role_versions(id),
    CONSTRAINT member_global_role_versions_created_by_fkey
        FOREIGN KEY (created_by_member_id) REFERENCES app.members(id)
);

CREATE INDEX member_global_role_versions_lookup_idx
    ON app.member_global_role_versions USING btree (member_id, role, version_no DESC, created_at DESC);

-- ── member_private_contacts ─────────────────────────────────

CREATE TABLE app.member_private_contacts (
    member_id       app.short_id NOT NULL,
    email           text,
    created_at      timestamptz DEFAULT now() NOT NULL,
    updated_at      timestamptz DEFAULT now() NOT NULL,

    CONSTRAINT member_private_contacts_pkey PRIMARY KEY (member_id),
    CONSTRAINT member_private_contacts_email_check CHECK (email IS NULL OR email LIKE '%@%'),
    CONSTRAINT member_private_contacts_member_id_fkey
        FOREIGN KEY (member_id) REFERENCES app.members(id)
);

-- ── member_profile_versions ─────────────────────────────────

CREATE TABLE app.member_profile_versions (
    id                      app.short_id DEFAULT app.new_id() NOT NULL,
    member_id               app.short_id NOT NULL,
    version_no              integer NOT NULL,
    display_name            text NOT NULL,
    tagline                 text,
    summary                 text,
    what_i_do               text,
    known_for               text,
    services_summary        text,
    website_url             text,
    links                   jsonb DEFAULT '[]' NOT NULL,
    profile                 jsonb DEFAULT '{}' NOT NULL,
    search_vector           tsvector,
    created_at              timestamptz DEFAULT now() NOT NULL,
    created_by_member_id    app.short_id,

    CONSTRAINT member_profile_versions_pkey PRIMARY KEY (id),
    CONSTRAINT member_profile_versions_member_version_unique UNIQUE (member_id, version_no),
    CONSTRAINT member_profile_versions_version_no_check CHECK (version_no > 0),
    CONSTRAINT member_profile_versions_display_name_check CHECK (length(btrim(display_name)) > 0),
    CONSTRAINT member_profile_versions_member_id_fkey
        FOREIGN KEY (member_id) REFERENCES app.members(id),
    CONSTRAINT member_profile_versions_created_by_fkey
        FOREIGN KEY (created_by_member_id) REFERENCES app.members(id)
);

CREATE INDEX member_profile_versions_member_version_idx
    ON app.member_profile_versions USING btree (member_id, version_no DESC);

CREATE INDEX member_profile_versions_created_idx
    ON app.member_profile_versions USING btree (created_at DESC);

CREATE INDEX member_profile_versions_search_idx
    ON app.member_profile_versions USING gin (search_vector);

-- search_vector trigger
CREATE FUNCTION app.member_profile_versions_search_vector_trigger() RETURNS trigger
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

-- ── clubs ───────────────────────────────────────────────────

CREATE TABLE app.clubs (
    id                  app.short_id DEFAULT app.new_id() NOT NULL,
    slug                text NOT NULL,
    name                text NOT NULL,
    summary             text,
    owner_member_id     app.short_id NOT NULL,
    admission_policy    text,
    created_at          timestamptz DEFAULT now() NOT NULL,
    archived_at         timestamptz,

    CONSTRAINT clubs_pkey PRIMARY KEY (id),
    CONSTRAINT clubs_slug_unique UNIQUE (slug),
    CONSTRAINT clubs_slug_check CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
    CONSTRAINT clubs_name_check CHECK (length(btrim(name)) > 0),
    CONSTRAINT clubs_admission_policy_length CHECK (
        admission_policy IS NULL OR char_length(admission_policy) BETWEEN 1 AND 2000
    ),
    CONSTRAINT clubs_owner_member_id_fkey
        FOREIGN KEY (owner_member_id) REFERENCES app.members(id)
);

-- admission_policy normalize trigger
CREATE FUNCTION app.normalize_clubs_admission_policy() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.admission_policy IS NOT NULL THEN
        NEW.admission_policy := btrim(NEW.admission_policy);
        IF NEW.admission_policy = '' THEN
            NEW.admission_policy := NULL;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER clubs_normalize_admission_policy
    BEFORE INSERT OR UPDATE OF admission_policy ON app.clubs
    FOR EACH ROW EXECUTE FUNCTION app.normalize_clubs_admission_policy();

-- versioned field lock trigger (owner_member_id, name, summary, admission_policy)
CREATE FUNCTION app.lock_club_versioned_mutation() RETURNS trigger
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
    RETURN NEW;
END;
$$;

CREATE TRIGGER clubs_versioned_field_lock
    BEFORE UPDATE ON app.clubs
    FOR EACH ROW EXECUTE FUNCTION app.lock_club_versioned_mutation();

-- ── club_versions ───────────────────────────────────────────

CREATE TABLE app.club_versions (
    id                      app.short_id DEFAULT app.new_id() NOT NULL,
    club_id                 app.short_id NOT NULL,
    owner_member_id         app.short_id NOT NULL,
    name                    text NOT NULL,
    summary                 text,
    admission_policy        text,
    version_no              integer NOT NULL,
    supersedes_version_id   app.short_id,
    created_at              timestamptz DEFAULT now() NOT NULL,
    created_by_member_id    app.short_id,

    CONSTRAINT club_versions_pkey PRIMARY KEY (id),
    CONSTRAINT club_versions_club_version_unique UNIQUE (club_id, version_no),
    CONSTRAINT club_versions_version_no_check CHECK (version_no > 0),
    CONSTRAINT club_versions_name_check CHECK (length(btrim(name)) > 0),
    CONSTRAINT club_versions_admission_policy_length CHECK (
        admission_policy IS NULL OR char_length(admission_policy) BETWEEN 1 AND 2000
    ),
    CONSTRAINT club_versions_club_id_fkey
        FOREIGN KEY (club_id) REFERENCES app.clubs(id),
    CONSTRAINT club_versions_owner_member_id_fkey
        FOREIGN KEY (owner_member_id) REFERENCES app.members(id),
    CONSTRAINT club_versions_created_by_member_id_fkey
        FOREIGN KEY (created_by_member_id) REFERENCES app.members(id),
    CONSTRAINT club_versions_supersedes_version_id_fkey
        FOREIGN KEY (supersedes_version_id) REFERENCES app.club_versions(id)
);

CREATE INDEX club_versions_club_idx
    ON app.club_versions USING btree (club_id, version_no DESC, created_at DESC);

-- admission_policy normalize trigger
CREATE FUNCTION app.normalize_club_versions_admission_policy() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.admission_policy IS NOT NULL THEN
        NEW.admission_policy := btrim(NEW.admission_policy);
        IF NEW.admission_policy = '' THEN
            NEW.admission_policy := NULL;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER club_versions_normalize_admission_policy
    BEFORE INSERT OR UPDATE OF admission_policy ON app.club_versions
    FOR EACH ROW EXECUTE FUNCTION app.normalize_club_versions_admission_policy();

-- sync trigger: club_versions INSERT → update clubs
CREATE FUNCTION app.sync_club_version_to_club() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM set_config('app.allow_club_version_sync', '1', true);
    UPDATE app.clubs c SET
        owner_member_id  = NEW.owner_member_id,
        name             = NEW.name,
        summary          = NEW.summary,
        admission_policy = NEW.admission_policy
    WHERE c.id = NEW.club_id;
    PERFORM set_config('app.allow_club_version_sync', '', true);
    RETURN NEW;
EXCEPTION
    WHEN others THEN
        PERFORM set_config('app.allow_club_version_sync', '', true);
        RAISE;
END;
$$;

CREATE TRIGGER club_versions_sync
    AFTER INSERT ON app.club_versions
    FOR EACH ROW EXECUTE FUNCTION app.sync_club_version_to_club();

-- ── club_memberships ────────────────────────────────────────

CREATE TABLE app.club_memberships (
    id                      app.short_id DEFAULT app.new_id() NOT NULL,
    club_id                 app.short_id NOT NULL,
    member_id               app.short_id NOT NULL,
    sponsor_member_id       app.short_id,
    role                    app.membership_role DEFAULT 'member' NOT NULL,
    status                  app.membership_state DEFAULT 'active' NOT NULL,
    joined_at               timestamptz DEFAULT now() NOT NULL,
    left_at                 timestamptz,
    accepted_covenant_at    timestamptz,
    metadata                jsonb DEFAULT '{}' NOT NULL,
    source_admission_id     text,

    CONSTRAINT club_memberships_pkey PRIMARY KEY (id),
    CONSTRAINT club_memberships_club_member_unique UNIQUE (club_id, member_id),
    CONSTRAINT club_memberships_sponsor_check CHECK (sponsor_member_id IS NOT NULL OR role = 'clubadmin'),
    CONSTRAINT club_memberships_club_id_fkey
        FOREIGN KEY (club_id) REFERENCES app.clubs(id),
    CONSTRAINT club_memberships_member_id_fkey
        FOREIGN KEY (member_id) REFERENCES app.members(id),
    CONSTRAINT club_memberships_sponsor_member_id_fkey
        FOREIGN KEY (sponsor_member_id) REFERENCES app.members(id)
);

-- partial unique index for saga anchor
CREATE UNIQUE INDEX club_memberships_source_admission_unique
    ON app.club_memberships (source_admission_id) WHERE source_admission_id IS NOT NULL;

CREATE INDEX club_memberships_club_status_idx
    ON app.club_memberships USING btree (club_id, status);

CREATE INDEX club_memberships_member_status_idx
    ON app.club_memberships USING btree (member_id, status);

CREATE INDEX club_memberships_sponsor_joined_idx
    ON app.club_memberships USING btree (sponsor_member_id, joined_at);

-- lock trigger (immutable fields unless bypassed via app.allow_club_membership_state_sync)
CREATE FUNCTION app.lock_club_membership_mutation() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    IF current_setting('app.allow_club_membership_state_sync', true) = '1' THEN
        RETURN NEW;
    END IF;
    IF NEW.club_id IS DISTINCT FROM OLD.club_id THEN
        RAISE EXCEPTION 'club_memberships.club_id is immutable';
    END IF;
    IF NEW.member_id IS DISTINCT FROM OLD.member_id THEN
        RAISE EXCEPTION 'club_memberships.member_id is immutable';
    END IF;
    IF NEW.sponsor_member_id IS DISTINCT FROM OLD.sponsor_member_id THEN
        RAISE EXCEPTION 'club_memberships.sponsor_member_id is immutable';
    END IF;
    IF NEW.joined_at IS DISTINCT FROM OLD.joined_at THEN
        RAISE EXCEPTION 'club_memberships.joined_at is immutable';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        RAISE EXCEPTION 'club_memberships.status must change via club_membership_state_versions';
    END IF;
    IF NEW.left_at IS DISTINCT FROM OLD.left_at THEN
        RAISE EXCEPTION 'club_memberships.left_at must change via club_membership_state_versions';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER club_memberships_identity_guard
    BEFORE UPDATE ON app.club_memberships
    FOR EACH ROW EXECUTE FUNCTION app.lock_club_membership_mutation();

-- ── club_membership_state_versions ──────────────────────────

CREATE TABLE app.club_membership_state_versions (
    id                              app.short_id DEFAULT app.new_id() NOT NULL,
    membership_id                   app.short_id NOT NULL,
    status                          app.membership_state NOT NULL,
    reason                          text,
    version_no                      integer NOT NULL,
    supersedes_state_version_id     app.short_id,
    created_at                      timestamptz DEFAULT now() NOT NULL,
    created_by_member_id            app.short_id,

    CONSTRAINT club_membership_state_versions_pkey PRIMARY KEY (id),
    CONSTRAINT club_membership_state_versions_version_unique UNIQUE (membership_id, version_no),
    CONSTRAINT club_membership_state_versions_version_no_check CHECK (version_no > 0),
    CONSTRAINT club_membership_state_versions_membership_id_fkey
        FOREIGN KEY (membership_id) REFERENCES app.club_memberships(id),
    CONSTRAINT club_membership_state_versions_supersedes_fkey
        FOREIGN KEY (supersedes_state_version_id) REFERENCES app.club_membership_state_versions(id),
    CONSTRAINT club_membership_state_versions_created_by_fkey
        FOREIGN KEY (created_by_member_id) REFERENCES app.members(id)
);

CREATE INDEX club_membership_state_versions_lookup_idx
    ON app.club_membership_state_versions USING btree (membership_id, version_no DESC, created_at DESC);

-- sync trigger: INSERT → update club_memberships.status and left_at
CREATE FUNCTION app.sync_club_membership_state_to_membership() RETURNS trigger
    LANGUAGE plpgsql
AS $$
DECLARE
    mirrored_left_at timestamptz;
BEGIN
    mirrored_left_at := CASE
        WHEN NEW.status IN ('revoked', 'rejected') THEN NEW.created_at
        ELSE NULL
    END;
    PERFORM set_config('app.allow_club_membership_state_sync', '1', true);
    UPDATE app.club_memberships cm
       SET status = NEW.status,
           left_at = mirrored_left_at
     WHERE cm.id = NEW.membership_id;
    PERFORM set_config('app.allow_club_membership_state_sync', '', true);
    RETURN NEW;
EXCEPTION
    WHEN others THEN
        PERFORM set_config('app.allow_club_membership_state_sync', '', true);
        RAISE;
END;
$$;

CREATE TRIGGER club_membership_state_versions_sync
    AFTER INSERT ON app.club_membership_state_versions
    FOR EACH ROW EXECUTE FUNCTION app.sync_club_membership_state_to_membership();

-- ── subscriptions ───────────────────────────────────────────

CREATE TABLE app.subscriptions (
    id                  app.short_id DEFAULT app.new_id() NOT NULL,
    membership_id       app.short_id NOT NULL,
    payer_member_id     app.short_id NOT NULL,
    status              app.subscription_status DEFAULT 'active' NOT NULL,
    amount              numeric(12,2) NOT NULL,
    currency            text DEFAULT 'USD' NOT NULL,
    started_at          timestamptz DEFAULT now() NOT NULL,
    current_period_end  timestamptz,
    ended_at            timestamptz,

    CONSTRAINT subscriptions_pkey PRIMARY KEY (id),
    CONSTRAINT subscriptions_amount_check CHECK (amount >= 0),
    CONSTRAINT subscriptions_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
    CONSTRAINT subscriptions_membership_id_fkey
        FOREIGN KEY (membership_id) REFERENCES app.club_memberships(id),
    CONSTRAINT subscriptions_payer_member_id_fkey
        FOREIGN KEY (payer_member_id) REFERENCES app.members(id)
);

CREATE INDEX subscriptions_membership_status_idx
    ON app.subscriptions USING btree (membership_id, status);

CREATE INDEX subscriptions_payer_status_idx
    ON app.subscriptions USING btree (payer_member_id, status);

-- ── club_routing ────────────────────────────────────────────

CREATE TABLE app.club_routing (
    club_id     app.short_id NOT NULL,
    shard_id    integer NOT NULL DEFAULT 1,
    created_at  timestamptz DEFAULT now() NOT NULL,
    updated_at  timestamptz DEFAULT now() NOT NULL,

    CONSTRAINT club_routing_pkey PRIMARY KEY (club_id),
    CONSTRAINT club_routing_club_id_fkey
        FOREIGN KEY (club_id) REFERENCES app.clubs(id)
);

-- ── embeddings_member_profile_artifacts ─────────────────────

CREATE TABLE app.embeddings_member_profile_artifacts (
    id                  app.short_id DEFAULT app.new_id() NOT NULL,
    member_id           app.short_id NOT NULL,
    profile_version_id  app.short_id NOT NULL,
    model               text NOT NULL,
    dimensions          integer NOT NULL,
    source_version      text NOT NULL,
    chunk_index         integer NOT NULL DEFAULT 0,
    source_text         text NOT NULL,
    source_hash         text NOT NULL,
    embedding           vector(1536) NOT NULL,
    metadata            jsonb NOT NULL DEFAULT '{}',
    created_at          timestamptz DEFAULT now() NOT NULL,
    updated_at          timestamptz DEFAULT now() NOT NULL,

    CONSTRAINT embeddings_member_profile_artifacts_pkey PRIMARY KEY (id),
    CONSTRAINT embeddings_member_profile_artifacts_unique
        UNIQUE (member_id, model, dimensions, source_version, chunk_index),
    CONSTRAINT embeddings_member_profile_artifacts_dimensions_check CHECK (dimensions > 0),
    CONSTRAINT embeddings_member_profile_artifacts_member_fkey
        FOREIGN KEY (member_id) REFERENCES app.members(id),
    CONSTRAINT embeddings_member_profile_artifacts_version_fkey
        FOREIGN KEY (profile_version_id) REFERENCES app.member_profile_versions(id) ON DELETE CASCADE
);

CREATE INDEX embeddings_member_profile_artifacts_member_idx
    ON app.embeddings_member_profile_artifacts (member_id);

CREATE INDEX embeddings_member_profile_artifacts_version_idx
    ON app.embeddings_member_profile_artifacts (profile_version_id);

-- ── embeddings_jobs ─────────────────────────────────────────

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
    CONSTRAINT embeddings_jobs_subject_kind_check CHECK (subject_kind = 'member_profile_version'),
    CONSTRAINT embeddings_jobs_dimensions_check CHECK (dimensions > 0)
);

CREATE INDEX embeddings_jobs_claimable_idx
    ON app.embeddings_jobs USING btree (next_attempt_at ASC) WHERE attempt_count < 5;

-- ============================================================
-- Views
-- ============================================================

-- ── current_member_profiles ─────────────────────────────────

CREATE VIEW app.current_member_profiles AS
    SELECT DISTINCT ON (member_id) *
    FROM app.member_profile_versions
    ORDER BY member_id, version_no DESC, created_at DESC;

-- ── current_member_global_role_versions ─────────────────────

CREATE VIEW app.current_member_global_role_versions AS
    SELECT DISTINCT ON (member_id, role) *
    FROM app.member_global_role_versions
    ORDER BY member_id, role, version_no DESC, created_at DESC;

-- ── current_member_global_roles ─────────────────────────────

CREATE VIEW app.current_member_global_roles AS
    SELECT *
    FROM app.current_member_global_role_versions
    WHERE status = 'active';

-- ── current_club_membership_states ──────────────────────────

CREATE VIEW app.current_club_membership_states AS
    SELECT DISTINCT ON (membership_id) *
    FROM app.club_membership_state_versions
    ORDER BY membership_id, version_no DESC, created_at DESC;

-- ── current_club_memberships ────────────────────────────────

CREATE VIEW app.current_club_memberships AS
    SELECT
        cm.id,
        cm.club_id,
        cm.member_id,
        cm.sponsor_member_id,
        cm.role,
        cm.status,
        cm.joined_at,
        cm.left_at,
        cm.accepted_covenant_at,
        cm.metadata,
        cm.source_admission_id,
        ccms.id              AS state_version_id,
        ccms.reason          AS state_reason,
        ccms.version_no      AS state_version_no,
        ccms.created_at      AS state_created_at,
        ccms.created_by_member_id AS state_created_by_member_id
    FROM app.club_memberships cm
    LEFT JOIN app.current_club_membership_states ccms ON ccms.membership_id = cm.id;

-- ── active_club_memberships ─────────────────────────────────

CREATE VIEW app.active_club_memberships AS
    SELECT *
    FROM app.current_club_memberships
    WHERE status = 'active'
      AND left_at IS NULL;

-- ── accessible_club_memberships ─────────────────────────────

CREATE VIEW app.accessible_club_memberships AS
    SELECT ccm.*
    FROM app.current_club_memberships ccm
    WHERE ccm.status = 'active'
      AND ccm.left_at IS NULL
      AND (
          ccm.role = 'clubadmin'
          OR EXISTS (
              SELECT 1 FROM app.subscriptions s
              WHERE s.membership_id = ccm.id
                AND s.status IN ('trialing', 'active')
                AND coalesce(s.ended_at, 'infinity'::timestamptz) > now()
                AND coalesce(s.current_period_end, 'infinity'::timestamptz) > now()
          )
      );

-- ── current_club_versions ───────────────────────────────────

CREATE VIEW app.current_club_versions AS
    SELECT DISTINCT ON (club_id) *
    FROM app.club_versions
    ORDER BY club_id, version_no DESC, created_at DESC;

-- ============================================================
-- Utility functions (plain SQL, no security definer)
-- ============================================================

CREATE FUNCTION app.resolve_active_member_id_by_handle(target_handle text) RETURNS app.short_id
    LANGUAGE sql STABLE
AS $$
    SELECT m.id
    FROM app.members m
    WHERE m.handle = target_handle
      AND m.state = 'active'
    LIMIT 1;
$$;
