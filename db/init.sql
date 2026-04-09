-- ClawClub unified database schema
-- Single database, single schema, no RLS.
-- NOTE: Do NOT wrap in BEGIN/COMMIT — apply with --single-transaction.

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

-- ============================================================
-- Domain
-- ============================================================

CREATE DOMAIN short_id AS text
    CONSTRAINT short_id_check CHECK (VALUE ~ '^[23456789abcdefghjkmnpqrstuvwxyz]{12}$');

-- ============================================================
-- ID generator
-- ============================================================

CREATE FUNCTION new_id() RETURNS short_id
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

  return output::short_id;
end;
$$;

-- ============================================================
-- Enums
-- ============================================================

-- Identity
CREATE TYPE member_state AS ENUM ('pending', 'active', 'suspended', 'deleted', 'banned');
CREATE TYPE membership_role AS ENUM ('clubadmin', 'member');
CREATE TYPE membership_state AS ENUM ('invited', 'active', 'paused', 'left', 'removed', 'pending_review', 'revoked', 'rejected', 'payment_pending', 'renewal_pending', 'cancelled', 'banned', 'expired');
CREATE TYPE global_role AS ENUM ('superadmin');
CREATE TYPE assignment_state AS ENUM ('active', 'revoked');
CREATE TYPE subscription_status AS ENUM ('trialing', 'active', 'past_due', 'paused', 'canceled', 'ended');
CREATE TYPE billing_interval AS ENUM ('month', 'year', 'manual');

-- Content
CREATE TYPE entity_kind AS ENUM ('post', 'opportunity', 'service', 'ask', 'gift', 'event', 'comment', 'complaint');
CREATE TYPE entity_state AS ENUM ('draft', 'published', 'removed');
CREATE TYPE edge_kind AS ENUM ('vouched_for', 'about', 'related_to', 'mentions');
CREATE TYPE rsvp_state AS ENUM ('yes', 'maybe', 'no', 'waitlist');

-- Admissions
CREATE TYPE application_status AS ENUM ('draft', 'submitted', 'interview_scheduled', 'interview_completed', 'accepted', 'declined', 'withdrawn');

-- Quality
CREATE TYPE quality_gate_status AS ENUM ('passed', 'rejected', 'rejected_illegal', 'skipped');
CREATE TYPE club_activity_audience AS ENUM ('members', 'clubadmins', 'owners');

-- Messaging
CREATE TYPE thread_kind AS ENUM ('direct');
CREATE TYPE message_role AS ENUM ('member', 'agent', 'system');


-- ============================================================
-- Tables: Members & Identity
-- ============================================================

CREATE TABLE members (
    id                  short_id DEFAULT new_id() NOT NULL,
    handle              text NOT NULL,
    public_name         text NOT NULL,
    state               member_state DEFAULT 'active' NOT NULL,
    source_admission_id short_id,
    metadata            jsonb DEFAULT '{}' NOT NULL,
    created_at          timestamptz DEFAULT now() NOT NULL,

    CONSTRAINT members_pkey PRIMARY KEY (id),
    CONSTRAINT members_handle_unique UNIQUE (handle),
    CONSTRAINT members_public_name_check CHECK (length(btrim(public_name)) > 0)
);

CREATE INDEX members_state_idx ON members (state);
CREATE UNIQUE INDEX members_source_admission_unique_idx
    ON members (source_admission_id) WHERE source_admission_id IS NOT NULL;

-- ── Member bearer tokens ──────────────────────────────────────────

CREATE TABLE member_bearer_tokens (
    id              short_id DEFAULT new_id() NOT NULL,
    member_id       short_id NOT NULL,
    label           text,
    token_hash      text NOT NULL,
    created_at      timestamptz DEFAULT now() NOT NULL,
    last_used_at    timestamptz,
    revoked_at      timestamptz,
    metadata        jsonb DEFAULT '{}' NOT NULL,
    expires_at      timestamptz,

    CONSTRAINT member_bearer_tokens_pkey PRIMARY KEY (id),
    CONSTRAINT member_bearer_tokens_token_hash_unique UNIQUE (token_hash),
    CONSTRAINT member_bearer_tokens_member_fkey FOREIGN KEY (member_id) REFERENCES members(id)
);

CREATE INDEX member_bearer_tokens_member_created_idx ON member_bearer_tokens (member_id, created_at DESC);
CREATE INDEX member_bearer_tokens_active_idx ON member_bearer_tokens (id) WHERE revoked_at IS NULL;

-- ── Member global roles ───────────────────────────────────────────

CREATE TABLE member_global_role_versions (
    id                          short_id DEFAULT new_id() NOT NULL,
    member_id                   short_id NOT NULL,
    role                        global_role NOT NULL,
    status                      assignment_state DEFAULT 'active' NOT NULL,
    version_no                  integer NOT NULL,
    supersedes_role_version_id  short_id,
    created_at                  timestamptz DEFAULT now() NOT NULL,
    created_by_member_id        short_id,

    CONSTRAINT member_global_role_versions_pkey PRIMARY KEY (id),
    CONSTRAINT member_global_role_versions_version_unique UNIQUE (member_id, role, version_no),
    CONSTRAINT member_global_role_versions_version_no_check CHECK (version_no > 0),
    CONSTRAINT member_global_role_versions_member_fkey FOREIGN KEY (member_id) REFERENCES members(id),
    CONSTRAINT member_global_role_versions_supersedes_fkey FOREIGN KEY (supersedes_role_version_id) REFERENCES member_global_role_versions(id),
    CONSTRAINT member_global_role_versions_created_by_fkey FOREIGN KEY (created_by_member_id) REFERENCES members(id)
);

CREATE INDEX member_global_role_versions_lookup_idx
    ON member_global_role_versions (member_id, role, version_no DESC, created_at DESC);

-- ── Member private contacts ───────────────────────────────────────

CREATE TABLE member_private_contacts (
    member_id       short_id NOT NULL,
    email           text,
    created_at      timestamptz DEFAULT now() NOT NULL,
    updated_at      timestamptz DEFAULT now() NOT NULL,

    CONSTRAINT member_private_contacts_pkey PRIMARY KEY (member_id),
    CONSTRAINT member_private_contacts_email_check CHECK (email IS NULL OR email LIKE '%@%'),
    CONSTRAINT member_private_contacts_member_fkey FOREIGN KEY (member_id) REFERENCES members(id)
);

-- ── Member profile versions ───────────────────────────────────────

CREATE TABLE member_profile_versions (
    id                      short_id DEFAULT new_id() NOT NULL,
    member_id               short_id NOT NULL,
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
    created_by_member_id    short_id,

    CONSTRAINT member_profile_versions_pkey PRIMARY KEY (id),
    CONSTRAINT member_profile_versions_member_version_unique UNIQUE (member_id, version_no),
    CONSTRAINT member_profile_versions_version_no_check CHECK (version_no > 0),
    CONSTRAINT member_profile_versions_display_name_check CHECK (length(btrim(display_name)) > 0),
    CONSTRAINT member_profile_versions_member_fkey FOREIGN KEY (member_id) REFERENCES members(id),
    CONSTRAINT member_profile_versions_created_by_fkey FOREIGN KEY (created_by_member_id) REFERENCES members(id)
);

CREATE INDEX member_profile_versions_member_version_idx ON member_profile_versions (member_id, version_no DESC);
CREATE INDEX member_profile_versions_created_idx ON member_profile_versions (created_at DESC);
CREATE INDEX member_profile_versions_search_idx ON member_profile_versions USING gin (search_vector);

CREATE FUNCTION member_profile_versions_search_vector_trigger() RETURNS trigger
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
    BEFORE INSERT OR UPDATE ON member_profile_versions
    FOR EACH ROW
    EXECUTE FUNCTION member_profile_versions_search_vector_trigger();


-- ============================================================
-- Tables: Clubs & Membership
-- ============================================================

CREATE TABLE clubs (
    id                  short_id DEFAULT new_id() NOT NULL,
    slug                text NOT NULL,
    name                text NOT NULL,
    summary             text,
    owner_member_id     short_id NOT NULL,
    admission_policy    text,
    membership_price_amount   numeric(12,2),
    membership_price_currency text DEFAULT 'USD' NOT NULL,
    created_at          timestamptz DEFAULT now() NOT NULL,
    archived_at         timestamptz,

    CONSTRAINT clubs_pkey PRIMARY KEY (id),
    CONSTRAINT clubs_slug_unique UNIQUE (slug),
    CONSTRAINT clubs_slug_check CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
    CONSTRAINT clubs_name_check CHECK (length(btrim(name)) > 0),
    CONSTRAINT clubs_admission_policy_length CHECK (
        admission_policy IS NULL OR char_length(admission_policy) BETWEEN 1 AND 2000
    ),
    CONSTRAINT clubs_price_check CHECK (membership_price_amount IS NULL OR membership_price_amount >= 0),
    CONSTRAINT clubs_currency_check CHECK (membership_price_currency ~ '^[A-Z]{3}$'),
    CONSTRAINT clubs_owner_fkey FOREIGN KEY (owner_member_id) REFERENCES members(id)
);

CREATE FUNCTION normalize_admission_policy() RETURNS trigger
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
    BEFORE INSERT OR UPDATE OF admission_policy ON clubs
    FOR EACH ROW EXECUTE FUNCTION normalize_admission_policy();

CREATE FUNCTION lock_club_versioned_mutation() RETURNS trigger
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

CREATE TRIGGER clubs_versioned_field_lock
    BEFORE UPDATE ON clubs
    FOR EACH ROW EXECUTE FUNCTION lock_club_versioned_mutation();

-- ── Club versions ──────────────────────────────────────────

CREATE TABLE club_versions (
    id                      short_id DEFAULT new_id() NOT NULL,
    club_id                 short_id NOT NULL,
    owner_member_id         short_id NOT NULL,
    name                    text NOT NULL,
    summary                 text,
    admission_policy        text,
    membership_price_amount   numeric(12,2),
    membership_price_currency text DEFAULT 'USD' NOT NULL,
    version_no              integer NOT NULL,
    supersedes_version_id   short_id,
    created_at              timestamptz DEFAULT now() NOT NULL,
    created_by_member_id    short_id,

    CONSTRAINT club_versions_pkey PRIMARY KEY (id),
    CONSTRAINT club_versions_club_version_unique UNIQUE (club_id, version_no),
    CONSTRAINT club_versions_version_no_check CHECK (version_no > 0),
    CONSTRAINT club_versions_name_check CHECK (length(btrim(name)) > 0),
    CONSTRAINT club_versions_admission_policy_length CHECK (
        admission_policy IS NULL OR char_length(admission_policy) BETWEEN 1 AND 2000
    ),
    CONSTRAINT club_versions_price_check CHECK (membership_price_amount IS NULL OR membership_price_amount >= 0),
    CONSTRAINT club_versions_currency_check CHECK (membership_price_currency ~ '^[A-Z]{3}$'),
    CONSTRAINT club_versions_club_fkey FOREIGN KEY (club_id) REFERENCES clubs(id),
    CONSTRAINT club_versions_owner_fkey FOREIGN KEY (owner_member_id) REFERENCES members(id),
    CONSTRAINT club_versions_created_by_fkey FOREIGN KEY (created_by_member_id) REFERENCES members(id),
    CONSTRAINT club_versions_supersedes_fkey FOREIGN KEY (supersedes_version_id) REFERENCES club_versions(id)
);

CREATE INDEX club_versions_club_idx ON club_versions (club_id, version_no DESC, created_at DESC);

CREATE TRIGGER club_versions_normalize_admission_policy
    BEFORE INSERT OR UPDATE OF admission_policy ON club_versions
    FOR EACH ROW EXECUTE FUNCTION normalize_admission_policy();

CREATE FUNCTION sync_club_version_to_club() RETURNS trigger
    LANGUAGE plpgsql
AS $$
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
$$;

CREATE TRIGGER club_versions_sync
    AFTER INSERT ON club_versions
    FOR EACH ROW EXECUTE FUNCTION sync_club_version_to_club();

-- ── Club memberships ────────────────────────────────────────────

CREATE TABLE club_memberships (
    id                      short_id DEFAULT new_id() NOT NULL,
    club_id                 short_id NOT NULL,
    member_id               short_id NOT NULL,
    sponsor_member_id       short_id,
    role                    membership_role DEFAULT 'member' NOT NULL,
    status                  membership_state DEFAULT 'active' NOT NULL,
    joined_at               timestamptz DEFAULT now() NOT NULL,
    left_at                 timestamptz,
    accepted_covenant_at    timestamptz,
    metadata                jsonb DEFAULT '{}' NOT NULL,
    source_admission_id     short_id,
    is_comped               boolean DEFAULT false NOT NULL,
    comped_at               timestamptz,
    comped_by_member_id     short_id,
    approved_price_amount   numeric(12,2),
    approved_price_currency text,

    CONSTRAINT club_memberships_pkey PRIMARY KEY (id),
    CONSTRAINT club_memberships_club_member_unique UNIQUE (club_id, member_id),
    CONSTRAINT club_memberships_sponsor_check CHECK (sponsor_member_id IS NOT NULL OR role = 'clubadmin'),
    CONSTRAINT club_memberships_club_fkey FOREIGN KEY (club_id) REFERENCES clubs(id),
    CONSTRAINT club_memberships_member_fkey FOREIGN KEY (member_id) REFERENCES members(id),
    CONSTRAINT club_memberships_sponsor_fkey FOREIGN KEY (sponsor_member_id) REFERENCES members(id),
    CONSTRAINT club_memberships_comped_by_fkey FOREIGN KEY (comped_by_member_id) REFERENCES members(id)
);

CREATE UNIQUE INDEX club_memberships_source_admission_unique
    ON club_memberships (source_admission_id) WHERE source_admission_id IS NOT NULL;

CREATE INDEX club_memberships_club_status_idx ON club_memberships (club_id, status);
CREATE INDEX club_memberships_member_status_idx ON club_memberships (member_id, status);
CREATE INDEX club_memberships_sponsor_joined_idx ON club_memberships (sponsor_member_id, joined_at);

CREATE FUNCTION lock_club_membership_mutation() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    IF current_setting('app.allow_membership_state_sync', true) = '1' THEN
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

CREATE TRIGGER club_memberships_guard
    BEFORE UPDATE ON club_memberships
    FOR EACH ROW EXECUTE FUNCTION lock_club_membership_mutation();

-- ── Club membership state versions ──────────────────────────────

CREATE TABLE club_membership_state_versions (
    id                              short_id DEFAULT new_id() NOT NULL,
    membership_id                   short_id NOT NULL,
    status                          membership_state NOT NULL,
    reason                          text,
    version_no                      integer NOT NULL,
    supersedes_state_version_id     short_id,
    created_at                      timestamptz DEFAULT now() NOT NULL,
    created_by_member_id            short_id,

    CONSTRAINT club_membership_state_versions_pkey PRIMARY KEY (id),
    CONSTRAINT club_membership_state_versions_version_unique UNIQUE (membership_id, version_no),
    CONSTRAINT club_membership_state_versions_version_no_check CHECK (version_no > 0),
    CONSTRAINT club_membership_state_versions_membership_fkey FOREIGN KEY (membership_id) REFERENCES club_memberships(id),
    CONSTRAINT club_membership_state_versions_supersedes_fkey FOREIGN KEY (supersedes_state_version_id) REFERENCES club_membership_state_versions(id),
    CONSTRAINT club_membership_state_versions_created_by_fkey FOREIGN KEY (created_by_member_id) REFERENCES members(id)
);

CREATE INDEX club_membership_state_versions_lookup_idx
    ON club_membership_state_versions (membership_id, version_no DESC, created_at DESC);

CREATE FUNCTION sync_club_membership_state() RETURNS trigger
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
$$;

CREATE TRIGGER club_membership_state_versions_sync
    AFTER INSERT ON club_membership_state_versions
    FOR EACH ROW EXECUTE FUNCTION sync_club_membership_state();

-- ── Club subscriptions ──────────────────────────────────────────

CREATE TABLE club_subscriptions (
    id                  short_id DEFAULT new_id() NOT NULL,
    membership_id       short_id NOT NULL,
    payer_member_id     short_id NOT NULL,
    status              subscription_status DEFAULT 'active' NOT NULL,
    amount              numeric(12,2) NOT NULL,
    currency            text DEFAULT 'USD' NOT NULL,
    started_at          timestamptz DEFAULT now() NOT NULL,
    current_period_end  timestamptz,
    ended_at            timestamptz,

    CONSTRAINT club_subscriptions_pkey PRIMARY KEY (id),
    CONSTRAINT club_subscriptions_amount_check CHECK (amount >= 0),
    CONSTRAINT club_subscriptions_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
    CONSTRAINT club_subscriptions_membership_fkey FOREIGN KEY (membership_id) REFERENCES club_memberships(id),
    CONSTRAINT club_subscriptions_payer_fkey FOREIGN KEY (payer_member_id) REFERENCES members(id)
);

CREATE INDEX club_subscriptions_membership_status_idx ON club_subscriptions (membership_id, status);
CREATE INDEX club_subscriptions_payer_status_idx ON club_subscriptions (payer_member_id, status);
CREATE UNIQUE INDEX club_subscriptions_one_live_per_membership
    ON club_subscriptions (membership_id) WHERE status IN ('active', 'trialing', 'past_due');


-- ============================================================
-- Tables: Content
-- ============================================================

CREATE TABLE entities (
    id                  short_id DEFAULT new_id() NOT NULL,
    club_id             short_id NOT NULL,
    kind                entity_kind NOT NULL,
    author_member_id    short_id NOT NULL,
    open_loop           boolean,
    parent_entity_id    short_id,
    client_key          text,
    created_at          timestamptz DEFAULT now() NOT NULL,
    archived_at         timestamptz,
    deleted_at          timestamptz,
    metadata            jsonb DEFAULT '{}' NOT NULL,

    CONSTRAINT entities_pkey PRIMARY KEY (id),
    CONSTRAINT entities_comment_parent_check CHECK (
        (kind = 'comment' AND parent_entity_id IS NOT NULL) OR kind <> 'comment'
    ),
    CONSTRAINT entities_open_loop_kind_check CHECK (
        (
            kind IN ('ask', 'gift', 'service', 'opportunity')
            AND open_loop IS NOT NULL
        )
        OR (
            kind NOT IN ('ask', 'gift', 'service', 'opportunity')
            AND open_loop IS NULL
        )
    ),
    CONSTRAINT entities_club_fkey FOREIGN KEY (club_id) REFERENCES clubs(id),
    CONSTRAINT entities_author_fkey FOREIGN KEY (author_member_id) REFERENCES members(id),
    CONSTRAINT entities_parent_fkey FOREIGN KEY (parent_entity_id) REFERENCES entities(id)
);

CREATE UNIQUE INDEX entities_idempotent_idx
    ON entities (author_member_id, client_key) WHERE client_key IS NOT NULL;
CREATE INDEX entities_club_kind_idx ON entities (club_id, kind, created_at DESC);
CREATE INDEX entities_author_idx ON entities (author_member_id, created_at DESC);
CREATE INDEX entities_parent_idx ON entities (parent_entity_id);
CREATE INDEX entities_live_idx ON entities (club_id, kind) WHERE archived_at IS NULL AND deleted_at IS NULL;

-- ── Entity versions ────────────────────────────────────────

CREATE TABLE entity_versions (
    id                      short_id DEFAULT new_id() NOT NULL,
    entity_id               short_id NOT NULL,
    version_no              integer NOT NULL,
    state                   entity_state DEFAULT 'published' NOT NULL,
    title                   text,
    summary                 text,
    body                    text,
    effective_at            timestamptz DEFAULT now() NOT NULL,
    expires_at              timestamptz,
    content                 jsonb DEFAULT '{}' NOT NULL,
    reason                  text,
    supersedes_version_id   short_id,
    created_at              timestamptz DEFAULT now() NOT NULL,
    created_by_member_id    short_id,

    CONSTRAINT entity_versions_pkey PRIMARY KEY (id),
    CONSTRAINT entity_versions_entity_version_unique UNIQUE (entity_id, version_no),
    CONSTRAINT entity_versions_version_no_check CHECK (version_no > 0),
    CONSTRAINT entity_versions_expiry_check CHECK (expires_at IS NULL OR expires_at >= effective_at),
    CONSTRAINT entity_versions_entity_fkey FOREIGN KEY (entity_id) REFERENCES entities(id),
    CONSTRAINT entity_versions_supersedes_fkey FOREIGN KEY (supersedes_version_id) REFERENCES entity_versions(id),
    CONSTRAINT entity_versions_created_by_fkey FOREIGN KEY (created_by_member_id) REFERENCES members(id)
);

CREATE INDEX entity_versions_entity_version_idx ON entity_versions (entity_id, version_no DESC);
CREATE INDEX entity_versions_effective_idx ON entity_versions (effective_at DESC);
CREATE INDEX entity_versions_expires_idx ON entity_versions (expires_at);

-- ── Event version details (extension table for event-specific fields) ──

CREATE TABLE event_version_details (
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

CREATE INDEX event_version_details_starts_idx ON event_version_details (starts_at);

-- ── Event RSVPs ──────────────────────────────────────────────────

CREATE TABLE event_rsvps (
    id                      short_id DEFAULT new_id() NOT NULL,
    event_entity_id         short_id NOT NULL,
    membership_id           short_id NOT NULL,
    response                rsvp_state NOT NULL,
    note                    text,
    client_key              text,
    version_no              integer DEFAULT 1 NOT NULL,
    supersedes_rsvp_id      short_id,
    created_at              timestamptz DEFAULT now() NOT NULL,
    created_by_member_id    short_id,

    CONSTRAINT event_rsvps_pkey PRIMARY KEY (id),
    CONSTRAINT event_rsvps_event_membership_version_unique UNIQUE (event_entity_id, membership_id, version_no),
    CONSTRAINT event_rsvps_event_fkey FOREIGN KEY (event_entity_id) REFERENCES entities(id),
    CONSTRAINT event_rsvps_membership_fkey FOREIGN KEY (membership_id) REFERENCES club_memberships(id),
    CONSTRAINT event_rsvps_supersedes_fkey FOREIGN KEY (supersedes_rsvp_id) REFERENCES event_rsvps(id),
    CONSTRAINT event_rsvps_created_by_fkey FOREIGN KEY (created_by_member_id) REFERENCES members(id)
);

CREATE UNIQUE INDEX event_rsvps_idempotent_idx
    ON event_rsvps (created_by_member_id, client_key) WHERE client_key IS NOT NULL;
CREATE INDEX event_rsvps_event_idx ON event_rsvps (event_entity_id, response);
CREATE INDEX event_rsvps_event_membership_version_idx ON event_rsvps (event_entity_id, membership_id, version_no DESC, created_at DESC);
CREATE INDEX event_rsvps_membership_idx ON event_rsvps (membership_id, created_at DESC);

-- ── Club edges (vouches, etc.) ──────────────────────────────────

CREATE TABLE club_edges (
    id                      short_id DEFAULT new_id() NOT NULL,
    club_id                 short_id,
    kind                    edge_kind NOT NULL,
    from_member_id          short_id,
    from_entity_id          short_id,
    from_entity_version_id  short_id,
    to_member_id            short_id,
    to_entity_id            short_id,
    to_entity_version_id    short_id,
    reason                  text,
    metadata                jsonb DEFAULT '{}' NOT NULL,
    client_key              text,
    created_by_member_id    short_id,
    created_at              timestamptz DEFAULT now() NOT NULL,
    archived_at             timestamptz,

    CONSTRAINT club_edges_pkey PRIMARY KEY (id),
    CONSTRAINT club_edges_from_check CHECK (
        ((from_member_id IS NOT NULL)::integer
        + (from_entity_id IS NOT NULL)::integer
        + (from_entity_version_id IS NOT NULL)::integer) = 1
    ),
    CONSTRAINT club_edges_to_check CHECK (
        ((to_member_id IS NOT NULL)::integer
        + (to_entity_id IS NOT NULL)::integer
        + (to_entity_version_id IS NOT NULL)::integer) = 1
    ),
    CONSTRAINT club_edges_vouch_check CHECK (
        kind <> 'vouched_for' OR (from_member_id IS NOT NULL AND to_member_id IS NOT NULL AND reason IS NOT NULL)
    ),
    CONSTRAINT club_edges_no_self_vouch CHECK (
        kind <> 'vouched_for' OR from_member_id <> to_member_id
    ),
    CONSTRAINT club_edges_club_fkey FOREIGN KEY (club_id) REFERENCES clubs(id),
    CONSTRAINT club_edges_from_member_fkey FOREIGN KEY (from_member_id) REFERENCES members(id),
    CONSTRAINT club_edges_from_entity_fkey FOREIGN KEY (from_entity_id) REFERENCES entities(id),
    CONSTRAINT club_edges_from_entity_version_fkey FOREIGN KEY (from_entity_version_id) REFERENCES entity_versions(id),
    CONSTRAINT club_edges_to_member_fkey FOREIGN KEY (to_member_id) REFERENCES members(id),
    CONSTRAINT club_edges_to_entity_fkey FOREIGN KEY (to_entity_id) REFERENCES entities(id),
    CONSTRAINT club_edges_to_entity_version_fkey FOREIGN KEY (to_entity_version_id) REFERENCES entity_versions(id),
    CONSTRAINT club_edges_created_by_fkey FOREIGN KEY (created_by_member_id) REFERENCES members(id)
);

CREATE UNIQUE INDEX club_edges_idempotent_idx
    ON club_edges (created_by_member_id, client_key) WHERE client_key IS NOT NULL;
CREATE UNIQUE INDEX club_edges_unique_active_vouch
    ON club_edges (club_id, from_member_id, to_member_id)
    WHERE kind = 'vouched_for' AND archived_at IS NULL;
CREATE INDEX club_edges_club_kind_idx ON club_edges (club_id, kind, created_at DESC);
CREATE INDEX club_edges_from_member_idx ON club_edges (from_member_id, kind, created_at DESC);
CREATE INDEX club_edges_to_entity_idx ON club_edges (to_entity_id, kind, created_at DESC);
CREATE INDEX club_edges_to_member_idx ON club_edges (to_member_id, kind, created_at DESC);


-- ============================================================
-- Tables: Admissions
-- ============================================================

CREATE TABLE admissions (
    id                  short_id DEFAULT new_id() NOT NULL,
    club_id             short_id NOT NULL,
    applicant_member_id short_id,
    sponsor_member_id   short_id,
    membership_id       short_id,
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
    ),
    CONSTRAINT admissions_club_fkey FOREIGN KEY (club_id) REFERENCES clubs(id),
    CONSTRAINT admissions_applicant_fkey FOREIGN KEY (applicant_member_id) REFERENCES members(id),
    CONSTRAINT admissions_sponsor_fkey FOREIGN KEY (sponsor_member_id) REFERENCES members(id),
    CONSTRAINT admissions_membership_fkey FOREIGN KEY (membership_id) REFERENCES club_memberships(id)
);

CREATE INDEX admissions_club_created_idx ON admissions (club_id, created_at DESC);
-- Supports cross-apply eligibility checks: pending admissions by applicant
CREATE INDEX admissions_applicant_idx ON admissions (applicant_member_id, club_id);

-- ── Admission versions ─────────────────────────────────────

CREATE TABLE admission_versions (
    id                      short_id DEFAULT new_id() NOT NULL,
    admission_id            short_id NOT NULL,
    status                  application_status NOT NULL,
    notes                   text,
    intake_kind             text DEFAULT 'other' NOT NULL,
    intake_price_amount     numeric(12,2),
    intake_price_currency   text,
    intake_booking_url      text,
    intake_booked_at        timestamptz,
    intake_completed_at     timestamptz,
    version_no              integer NOT NULL,
    supersedes_version_id   short_id,
    created_at              timestamptz DEFAULT now() NOT NULL,
    created_by_member_id    short_id,

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
    CONSTRAINT admission_versions_admission_fkey FOREIGN KEY (admission_id) REFERENCES admissions(id),
    CONSTRAINT admission_versions_supersedes_fkey FOREIGN KEY (supersedes_version_id) REFERENCES admission_versions(id),
    CONSTRAINT admission_versions_created_by_fkey FOREIGN KEY (created_by_member_id) REFERENCES members(id)
);

CREATE INDEX admission_versions_admission_version_idx
    ON admission_versions (admission_id, version_no DESC, created_at DESC);

-- ── Admission challenges ───────────────────────────────────

CREATE TABLE admission_challenges (
    id              short_id DEFAULT new_id() NOT NULL,
    difficulty      integer NOT NULL,
    club_id         short_id,
    member_id       short_id,              -- bound to authenticated member for cross-apply challenges (NULL for cold)
    policy_snapshot text,
    club_name       text,
    club_summary    text,
    owner_name      text,
    expires_at      timestamptz NOT NULL,
    created_at      timestamptz DEFAULT now() NOT NULL,

    CONSTRAINT admission_challenges_pkey PRIMARY KEY (id),
    CONSTRAINT admission_challenges_difficulty_check CHECK (difficulty > 0),
    CONSTRAINT admission_challenges_expiry_check CHECK (expires_at > created_at),
    CONSTRAINT admission_challenges_club_fkey FOREIGN KEY (club_id) REFERENCES clubs(id),
    CONSTRAINT admission_challenges_member_fkey FOREIGN KEY (member_id) REFERENCES members(id)
);

CREATE INDEX admission_challenges_expires_idx ON admission_challenges (expires_at);

-- ── Admission attempts ─────────────────────────────────────

CREATE TABLE admission_attempts (
    id                  short_id DEFAULT new_id() NOT NULL,
    challenge_id        short_id NOT NULL,
    club_id             short_id NOT NULL,
    attempt_no          integer NOT NULL,
    applicant_name      text NOT NULL,
    applicant_email     text NOT NULL,
    payload             jsonb NOT NULL DEFAULT '{}',
    gate_status         quality_gate_status NOT NULL,
    gate_feedback       text,
    policy_snapshot     text NOT NULL,
    created_at          timestamptz DEFAULT now() NOT NULL,

    CONSTRAINT admission_attempts_pkey PRIMARY KEY (id),
    CONSTRAINT admission_attempts_attempt_no_check CHECK (attempt_no BETWEEN 1 AND 5),
    CONSTRAINT admission_attempts_challenge_fkey FOREIGN KEY (challenge_id) REFERENCES admission_challenges(id) ON DELETE CASCADE,
    CONSTRAINT admission_attempts_club_fkey FOREIGN KEY (club_id) REFERENCES clubs(id)
);

CREATE INDEX admission_attempts_challenge_idx ON admission_attempts (challenge_id, attempt_no);


-- ============================================================
-- Tables: Messaging
-- ============================================================

CREATE TABLE dm_threads (
    id                      short_id DEFAULT new_id() NOT NULL,
    kind                    thread_kind NOT NULL,
    created_by_member_id    short_id,
    subject_entity_id       short_id,
    member_a_id             short_id,
    member_b_id             short_id,
    metadata                jsonb DEFAULT '{}' NOT NULL,
    created_at              timestamptz DEFAULT now() NOT NULL,
    archived_at             timestamptz,

    CONSTRAINT dm_threads_pkey PRIMARY KEY (id),
    CONSTRAINT dm_threads_direct_pair_check CHECK (
        kind <> 'direct' OR (
            member_a_id IS NOT NULL
            AND member_b_id IS NOT NULL
            AND member_a_id < member_b_id
        )
    ),
    CONSTRAINT dm_threads_created_by_fkey FOREIGN KEY (created_by_member_id) REFERENCES members(id),
    CONSTRAINT dm_threads_subject_entity_fkey FOREIGN KEY (subject_entity_id) REFERENCES entities(id),
    CONSTRAINT dm_threads_member_a_fkey FOREIGN KEY (member_a_id) REFERENCES members(id),
    CONSTRAINT dm_threads_member_b_fkey FOREIGN KEY (member_b_id) REFERENCES members(id)
);

CREATE UNIQUE INDEX dm_threads_direct_pair_unique_idx
    ON dm_threads (kind, member_a_id, member_b_id)
    WHERE kind = 'direct' AND archived_at IS NULL;
CREATE INDEX dm_threads_created_by_idx ON dm_threads (created_by_member_id, created_at DESC);

-- ── DM thread participants ────────────────────────────────────

CREATE TABLE dm_thread_participants (
    id              short_id DEFAULT new_id() NOT NULL,
    thread_id       short_id NOT NULL,
    member_id       short_id NOT NULL,
    role            text NOT NULL DEFAULT 'participant',
    joined_at       timestamptz DEFAULT now() NOT NULL,
    left_at         timestamptz,

    CONSTRAINT dm_thread_participants_pkey PRIMARY KEY (id),
    CONSTRAINT dm_thread_participants_unique UNIQUE (thread_id, member_id),
    CONSTRAINT dm_thread_participants_thread_fkey FOREIGN KEY (thread_id) REFERENCES dm_threads(id),
    CONSTRAINT dm_thread_participants_member_fkey FOREIGN KEY (member_id) REFERENCES members(id)
);

CREATE INDEX dm_thread_participants_member_idx ON dm_thread_participants (member_id, thread_id);

-- ── DM messages ───────────────────────────────────────────────

CREATE TABLE dm_messages (
    id                      short_id DEFAULT new_id() NOT NULL,
    thread_id               short_id NOT NULL,
    sender_member_id        short_id,
    role                    message_role NOT NULL,
    message_text            text,
    payload                 jsonb DEFAULT '{}' NOT NULL,
    in_reply_to_message_id  short_id,
    client_key              text,
    created_at              timestamptz DEFAULT now() NOT NULL,

    CONSTRAINT dm_messages_pkey PRIMARY KEY (id),
    CONSTRAINT dm_messages_content_check CHECK (
        message_text IS NOT NULL OR payload <> '{}'
    ),
    CONSTRAINT dm_messages_thread_fkey FOREIGN KEY (thread_id) REFERENCES dm_threads(id),
    CONSTRAINT dm_messages_sender_fkey FOREIGN KEY (sender_member_id) REFERENCES members(id),
    CONSTRAINT dm_messages_reply_fkey FOREIGN KEY (in_reply_to_message_id) REFERENCES dm_messages(id)
);

CREATE UNIQUE INDEX dm_messages_idempotent_idx
    ON dm_messages (sender_member_id, client_key) WHERE client_key IS NOT NULL;
CREATE INDEX dm_messages_thread_created_desc_idx ON dm_messages (thread_id, created_at DESC, id DESC);
CREATE INDEX dm_messages_thread_created_asc_idx ON dm_messages (thread_id, created_at);
CREATE INDEX dm_messages_sender_idx ON dm_messages (sender_member_id, created_at DESC);

-- ── DM inbox entries ──────────────────────────────────────────

CREATE TABLE dm_inbox_entries (
    id                      short_id DEFAULT new_id() NOT NULL,
    recipient_member_id     short_id NOT NULL,
    thread_id               short_id NOT NULL,
    message_id              short_id NOT NULL,
    acknowledged            boolean NOT NULL DEFAULT false,
    created_at              timestamptz DEFAULT now() NOT NULL,

    CONSTRAINT dm_inbox_entries_pkey PRIMARY KEY (id),
    CONSTRAINT dm_inbox_entries_recipient_message_unique UNIQUE (recipient_member_id, message_id),
    CONSTRAINT dm_inbox_entries_recipient_fkey FOREIGN KEY (recipient_member_id) REFERENCES members(id),
    CONSTRAINT dm_inbox_entries_thread_fkey FOREIGN KEY (thread_id) REFERENCES dm_threads(id),
    CONSTRAINT dm_inbox_entries_message_fkey FOREIGN KEY (message_id) REFERENCES dm_messages(id)
);

CREATE INDEX dm_inbox_entries_unread_idx
    ON dm_inbox_entries (recipient_member_id) WHERE acknowledged = false;
CREATE INDEX dm_inbox_entries_recipient_created_idx
    ON dm_inbox_entries (recipient_member_id, created_at DESC);
-- Supports update-polling query: recipient + unread + created_at cursor (ASC order)
CREATE INDEX dm_inbox_entries_unread_poll_idx
    ON dm_inbox_entries (recipient_member_id, created_at ASC)
    WHERE acknowledged = false;
-- Supports inbox-stats CTE: recipient + thread grouping for unread aggregation
CREATE INDEX dm_inbox_entries_unread_thread_idx
    ON dm_inbox_entries (recipient_member_id, thread_id)
    WHERE acknowledged = false;

-- ── DM message removals ───────────────────────────────────────

CREATE TABLE dm_message_removals (
    message_id              short_id NOT NULL,
    removed_by_member_id    short_id NOT NULL,
    reason                  text,
    removed_at              timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT dm_message_removals_pkey PRIMARY KEY (message_id),
    CONSTRAINT dm_message_removals_message_fkey FOREIGN KEY (message_id) REFERENCES dm_messages(id),
    CONSTRAINT dm_message_removals_removed_by_fkey FOREIGN KEY (removed_by_member_id) REFERENCES members(id)
);


-- ============================================================
-- Tables: Activity & Signals
-- ============================================================

CREATE TABLE club_activity (
    id                      short_id DEFAULT new_id() NOT NULL,
    club_id                 short_id NOT NULL,
    seq                     bigint GENERATED ALWAYS AS IDENTITY,
    topic                   text NOT NULL,
    audience                club_activity_audience NOT NULL DEFAULT 'members',
    payload                 jsonb NOT NULL DEFAULT '{}',
    entity_id               short_id,
    entity_version_id       short_id,
    created_by_member_id    short_id,
    created_at              timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT club_activity_pkey PRIMARY KEY (id),
    CONSTRAINT club_activity_seq_unique UNIQUE (seq),
    CONSTRAINT club_activity_topic_check CHECK (length(btrim(topic)) > 0),
    CONSTRAINT club_activity_club_fkey FOREIGN KEY (club_id) REFERENCES clubs(id),
    CONSTRAINT club_activity_entity_fkey FOREIGN KEY (entity_id) REFERENCES entities(id),
    CONSTRAINT club_activity_created_by_fkey FOREIGN KEY (created_by_member_id) REFERENCES members(id)
);

CREATE INDEX club_activity_club_seq_idx ON club_activity (club_id, seq);

-- ── Club activity cursors ───────────────────────────────────────

CREATE TABLE club_activity_cursors (
    member_id       short_id NOT NULL,
    club_id         short_id NOT NULL,
    last_seq        bigint NOT NULL DEFAULT 0,
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT club_activity_cursors_pkey PRIMARY KEY (member_id, club_id),
    CONSTRAINT club_activity_cursors_member_fkey FOREIGN KEY (member_id) REFERENCES members(id),
    CONSTRAINT club_activity_cursors_club_fkey FOREIGN KEY (club_id) REFERENCES clubs(id)
);

-- ── Signal deliveries ────────────────────────────────────────────────

CREATE TABLE signal_deliveries (
    id                      short_id DEFAULT new_id() NOT NULL,
    club_id                 short_id NOT NULL,
    recipient_member_id     short_id NOT NULL,
    seq                     bigint GENERATED ALWAYS AS IDENTITY,
    topic                   text NOT NULL,
    payload                 jsonb NOT NULL DEFAULT '{}',
    entity_id               short_id,
    match_id                short_id,
    acknowledged_state      text,
    acknowledged_at         timestamptz,
    suppression_reason      text,
    created_at              timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT signal_deliveries_pkey PRIMARY KEY (id),
    CONSTRAINT signal_deliveries_seq_unique UNIQUE (seq),
    CONSTRAINT signal_deliveries_topic_check CHECK (length(btrim(topic)) > 0),
    CONSTRAINT signal_deliveries_ack_state_check CHECK (
        acknowledged_state IS NULL OR acknowledged_state IN ('processed', 'suppressed')
    ),
    CONSTRAINT signal_deliveries_suppression_check CHECK (
        (acknowledged_state = 'suppressed' AND suppression_reason IS NOT NULL)
        OR (acknowledged_state IS DISTINCT FROM 'suppressed')
    ),
    CONSTRAINT signal_deliveries_club_fkey FOREIGN KEY (club_id) REFERENCES clubs(id),
    CONSTRAINT signal_deliveries_recipient_fkey FOREIGN KEY (recipient_member_id) REFERENCES members(id),
    CONSTRAINT signal_deliveries_entity_fkey FOREIGN KEY (entity_id) REFERENCES entities(id)
);

CREATE INDEX signal_deliveries_recipient_poll_idx
    ON signal_deliveries (recipient_member_id, club_id, seq) WHERE acknowledged_state IS NULL;
CREATE UNIQUE INDEX signal_deliveries_match_unique_idx
    ON signal_deliveries (match_id) WHERE match_id IS NOT NULL;


-- ============================================================
-- Tables: Quotas & Quality
-- ============================================================

CREATE TYPE quota_scope AS ENUM ('global', 'club');

CREATE TABLE quota_policies (
    id              short_id DEFAULT new_id() NOT NULL,
    scope           quota_scope NOT NULL,
    club_id         short_id,
    action_name     text NOT NULL,
    max_per_day     integer NOT NULL,
    created_at      timestamptz DEFAULT now() NOT NULL,
    updated_at      timestamptz DEFAULT now() NOT NULL,

    CONSTRAINT quota_policies_pkey PRIMARY KEY (id),
    CONSTRAINT quota_policies_action_check CHECK (
        action_name IN ('content.create', 'events.create')
    ),
    CONSTRAINT quota_policies_max_check CHECK (max_per_day > 0),
    CONSTRAINT quota_policies_club_fkey FOREIGN KEY (club_id) REFERENCES clubs(id),
    -- Global rows must not have a club_id; club rows must have one
    CONSTRAINT quota_policies_scope_club_check CHECK (
        (scope = 'global' AND club_id IS NULL) OR
        (scope = 'club'   AND club_id IS NOT NULL)
    )
);

-- At most one global policy per action
CREATE UNIQUE INDEX quota_policies_global_action_unique
    ON quota_policies (action_name) WHERE (scope = 'global');

-- At most one club override per club/action
CREATE UNIQUE INDEX quota_policies_club_action_unique
    ON quota_policies (club_id, action_name) WHERE (scope = 'club');

-- Global default quotas (bootstrap data)
INSERT INTO quota_policies (scope, club_id, action_name, max_per_day) VALUES
    ('global', NULL, 'content.create', 30),
    ('global', NULL, 'events.create',  20);

CREATE TABLE ai_llm_usage_log (
    id                      short_id DEFAULT new_id() NOT NULL,
    member_id               short_id,
    requested_club_id       short_id,
    action_name             text NOT NULL,
    gate_name               text NOT NULL DEFAULT 'quality_gate',
    provider                text NOT NULL,
    model                   text NOT NULL,
    gate_status             quality_gate_status NOT NULL,
    skip_reason             text,
    prompt_tokens           integer,
    completion_tokens       integer,
    provider_error_code     text,
    created_at              timestamptz DEFAULT now() NOT NULL,

    CONSTRAINT ai_llm_usage_log_pkey PRIMARY KEY (id),
    CONSTRAINT ai_llm_usage_log_skip_reason_check CHECK (
        (gate_status = 'skipped' AND skip_reason IS NOT NULL)
        OR (gate_status <> 'skipped' AND skip_reason IS NULL)
    ),
    CONSTRAINT ai_llm_usage_log_member_fkey FOREIGN KEY (member_id) REFERENCES members(id),
    CONSTRAINT ai_llm_usage_log_club_fkey FOREIGN KEY (requested_club_id) REFERENCES clubs(id)
);

CREATE INDEX ai_llm_usage_log_club_created_idx ON ai_llm_usage_log (requested_club_id, created_at DESC);
CREATE INDEX ai_llm_usage_log_member_created_idx ON ai_llm_usage_log (member_id, created_at DESC);


-- ============================================================
-- Tables: Embeddings
-- ============================================================

CREATE TABLE member_profile_embeddings (
    id                  short_id DEFAULT new_id() NOT NULL,
    member_id           short_id NOT NULL,
    profile_version_id  short_id NOT NULL,
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

    CONSTRAINT member_profile_embeddings_pkey PRIMARY KEY (id),
    CONSTRAINT member_profile_embeddings_unique UNIQUE (member_id, model, dimensions, source_version, chunk_index),
    CONSTRAINT member_profile_embeddings_dimensions_check CHECK (dimensions > 0),
    CONSTRAINT member_profile_embeddings_member_fkey FOREIGN KEY (member_id) REFERENCES members(id),
    CONSTRAINT member_profile_embeddings_version_fkey FOREIGN KEY (profile_version_id) REFERENCES member_profile_versions(id) ON DELETE CASCADE
);

CREATE INDEX member_profile_embeddings_member_idx ON member_profile_embeddings (member_id);
CREATE INDEX member_profile_embeddings_version_idx ON member_profile_embeddings (profile_version_id);

CREATE TABLE entity_embeddings (
    id                  short_id DEFAULT new_id() NOT NULL,
    entity_id           short_id NOT NULL,
    entity_version_id   short_id NOT NULL,
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

    CONSTRAINT entity_embeddings_pkey PRIMARY KEY (id),
    CONSTRAINT entity_embeddings_unique UNIQUE (entity_id, model, dimensions, source_version, chunk_index),
    CONSTRAINT entity_embeddings_dimensions_check CHECK (dimensions > 0),
    CONSTRAINT entity_embeddings_entity_fkey FOREIGN KEY (entity_id) REFERENCES entities(id),
    CONSTRAINT entity_embeddings_version_fkey FOREIGN KEY (entity_version_id) REFERENCES entity_versions(id) ON DELETE CASCADE
);

CREATE INDEX entity_embeddings_entity_idx ON entity_embeddings (entity_id);
CREATE INDEX entity_embeddings_version_idx ON entity_embeddings (entity_version_id);

-- Unified embedding jobs queue (profiles + entities)

CREATE TABLE ai_embedding_jobs (
    id                  short_id DEFAULT new_id() NOT NULL,
    subject_kind        text NOT NULL,
    subject_version_id  short_id NOT NULL,
    model               text NOT NULL,
    dimensions          integer NOT NULL,
    source_version      text NOT NULL,
    attempt_count       integer NOT NULL DEFAULT 0,
    next_attempt_at     timestamptz NOT NULL DEFAULT now(),
    failure_kind        text,
    last_error          text,
    created_at          timestamptz DEFAULT now() NOT NULL,

    CONSTRAINT ai_embedding_jobs_pkey PRIMARY KEY (id),
    CONSTRAINT ai_embedding_jobs_unique UNIQUE (subject_kind, subject_version_id, model, dimensions, source_version),
    CONSTRAINT ai_embedding_jobs_subject_kind_check CHECK (subject_kind IN ('member_profile_version', 'entity_version')),
    CONSTRAINT ai_embedding_jobs_dimensions_check CHECK (dimensions > 0)
);

CREATE INDEX ai_embedding_jobs_claimable_idx
    ON ai_embedding_jobs (next_attempt_at ASC) WHERE attempt_count < 5;


-- ============================================================
-- Tables: Background Work
-- ============================================================

CREATE TABLE signal_background_matches (
    id                      short_id DEFAULT new_id() NOT NULL,
    club_id                 short_id NOT NULL,
    match_kind              text NOT NULL,
    source_id               text NOT NULL,
    target_member_id        short_id NOT NULL,
    score                   double precision NOT NULL,
    state                   text NOT NULL DEFAULT 'pending',
    payload                 jsonb NOT NULL DEFAULT '{}',
    signal_id               short_id,
    created_at              timestamptz NOT NULL DEFAULT now(),
    delivered_at            timestamptz,
    expires_at              timestamptz,

    CONSTRAINT signal_background_matches_pkey PRIMARY KEY (id),
    CONSTRAINT signal_background_matches_state_check CHECK (state IN ('pending', 'delivered', 'expired')),
    CONSTRAINT signal_background_matches_unique UNIQUE (match_kind, source_id, target_member_id),
    CONSTRAINT signal_background_matches_club_fkey FOREIGN KEY (club_id) REFERENCES clubs(id),
    CONSTRAINT signal_background_matches_target_fkey FOREIGN KEY (target_member_id) REFERENCES members(id),
    CONSTRAINT signal_background_matches_signal_fkey FOREIGN KEY (signal_id) REFERENCES signal_deliveries(id)
);

CREATE INDEX signal_background_matches_pending_idx
    ON signal_background_matches (state, created_at) WHERE state = 'pending';
CREATE INDEX signal_background_matches_expires_idx
    ON signal_background_matches (expires_at) WHERE expires_at IS NOT NULL AND state = 'pending';
CREATE INDEX signal_background_matches_delivery_idx
    ON signal_background_matches (target_member_id, delivered_at) WHERE state = 'delivered';
CREATE INDEX signal_background_matches_kind_delivery_idx
    ON signal_background_matches (target_member_id, match_kind, delivered_at) WHERE state = 'delivered';

CREATE TABLE signal_recompute_queue (
    id                  short_id DEFAULT new_id() NOT NULL,
    queue_name          text NOT NULL,
    member_id           short_id NOT NULL,
    club_id             short_id NOT NULL,
    recompute_after     timestamptz NOT NULL DEFAULT now(),
    created_at          timestamptz NOT NULL DEFAULT now(),
    claimed_at          timestamptz,

    CONSTRAINT signal_recompute_queue_pkey PRIMARY KEY (id),
    CONSTRAINT signal_recompute_queue_pending_unique UNIQUE (queue_name, member_id, club_id),
    CONSTRAINT signal_recompute_queue_member_fkey FOREIGN KEY (member_id) REFERENCES members(id),
    CONSTRAINT signal_recompute_queue_club_fkey FOREIGN KEY (club_id) REFERENCES clubs(id)
);

CREATE INDEX signal_recompute_queue_claimable_idx
    ON signal_recompute_queue (queue_name, recompute_after) WHERE claimed_at IS NULL;

CREATE TABLE worker_state (
    worker_id       text NOT NULL,
    state_key       text NOT NULL,
    state_value     text NOT NULL,
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT worker_state_pkey PRIMARY KEY (worker_id, state_key)
);


-- ============================================================
-- NOTIFY triggers
-- ============================================================

-- Single unified channel for all real-time notifications.
-- The notifier dispatches by payload shape:
--   { clubId } → wake waiters watching that club
--   { recipientMemberId } → wake waiters for that member
--   { clubId, recipientMemberId } → wake both

CREATE FUNCTION notify_club_activity() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM pg_notify('updates', json_build_object('clubId', NEW.club_id)::text);
    RETURN NEW;
END;
$$;

CREATE TRIGGER club_activity_notify
    AFTER INSERT ON club_activity
    FOR EACH ROW EXECUTE FUNCTION notify_club_activity();

CREATE FUNCTION notify_signal_delivery() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM pg_notify('updates', json_build_object(
        'clubId', NEW.club_id,
        'recipientMemberId', NEW.recipient_member_id
    )::text);
    RETURN NEW;
END;
$$;

CREATE TRIGGER signal_deliveries_notify
    AFTER INSERT ON signal_deliveries
    FOR EACH ROW EXECUTE FUNCTION notify_signal_delivery();

CREATE FUNCTION notify_dm_inbox() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM pg_notify('updates', json_build_object('recipientMemberId', NEW.recipient_member_id)::text);
    RETURN NEW;
END;
$$;

CREATE TRIGGER dm_inbox_entries_notify
    AFTER INSERT ON dm_inbox_entries
    FOR EACH ROW EXECUTE FUNCTION notify_dm_inbox();


-- ============================================================
-- Views
-- ============================================================

-- ── Profiles ───────────────────────────────────────────────

CREATE VIEW current_member_profiles AS
    SELECT DISTINCT ON (member_id) *
    FROM member_profile_versions
    ORDER BY member_id, version_no DESC, created_at DESC;

-- ── Member global roles ───────────────────────────────────────────

CREATE VIEW current_member_global_role_versions AS
    SELECT DISTINCT ON (member_id, role) *
    FROM member_global_role_versions
    ORDER BY member_id, role, version_no DESC, created_at DESC;

CREATE VIEW current_member_global_roles AS
    SELECT * FROM current_member_global_role_versions WHERE status = 'active';

-- ── Club memberships ────────────────────────────────────────────

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
          -- Club admins always have access
          cm.role = 'clubadmin'
          -- Comped members: access without subscription
          OR (cm.is_comped = true AND cm.status = 'active')
          -- Paid members: active or cancelled with live subscription
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
          -- Grace period: 7 days from state entry, regardless of subscription dates
          OR (
              cm.status = 'renewal_pending'
              AND cm.state_created_at + interval '7 days' > now()
          )
      );

-- ── Clubs ──────────────────────────────────────────────────

CREATE VIEW current_club_versions AS
    SELECT DISTINCT ON (club_id) *
    FROM club_versions
    ORDER BY club_id, version_no DESC, created_at DESC;

-- ── Admissions ─────────────────────────────────────────────

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

-- ── Entities ───────────────────────────────────────────────

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
        e.open_loop,
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

-- ── Event-focused views ────────────────────────────────────────

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


-- ============================================================
-- Utility functions
-- ============================================================

-- ============================================================
-- Migration tracking
-- ============================================================

CREATE TABLE IF NOT EXISTS public.schema_migrations (
    filename text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.schema_migrations (filename) VALUES ('0001_init.sql');


-- ============================================================
-- Utility functions
-- ============================================================

CREATE FUNCTION resolve_active_member_id_by_handle(target_handle text) RETURNS short_id
    LANGUAGE sql STABLE
AS $$
    SELECT m.id
    FROM members m
    WHERE m.handle = target_handle
      AND m.state = 'active'
    LIMIT 1;
$$;
