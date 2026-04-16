-- ClawClub unified database schema
-- Single database, single schema, no RLS.
-- NOTE: Do NOT wrap in BEGIN/COMMIT — apply with --single-transaction.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET default_tablespace = '';
SET default_table_access_method = heap;
SET row_security = off;

-- ============================================================
-- Extensions (require superuser)
-- ============================================================

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

-- ============================================================
-- Schema ownership
-- ============================================================
--
-- From this point on, every object is created as clawclub_app so that
-- the same role that runs the app can also run migrations against its
-- own objects (ALTER TYPE, ALTER TABLE, DROP VIEW, etc. all require
-- ownership). The clawclub_app role must already exist — run
-- scripts/provision-app-role.sh before db/init.sql.
--
-- SET SESSION AUTHORIZATION requires the connecting role to be a
-- superuser. That is fine: db/init.sql is a one-time bootstrap step
-- that already needs admin credentials for CREATE EXTENSION above.

SET SESSION AUTHORIZATION clawclub_app;

CREATE TYPE public.assignment_state AS ENUM (
    'active',
    'revoked'
);


--
-- Name: billing_interval; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.billing_interval AS ENUM (
    'month',
    'year',
    'manual'
);


--
-- Name: club_activity_audience; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.club_activity_audience AS ENUM (
    'members',
    'clubadmins',
    'owners'
);


--
-- Name: edge_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.edge_kind AS ENUM (
    'vouched_for',
    'about',
    'related_to',
    'mentions'
);


--
-- Name: entity_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.entity_kind AS ENUM (
    'post',
    'opportunity',
    'service',
    'ask',
    'gift',
    'event',
    'complaint',
    'migration_canary'
);


--
-- Name: entity_state; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.entity_state AS ENUM (
    'draft',
    'published',
    'removed'
);


--
-- Name: global_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.global_role AS ENUM (
    'superadmin'
);


--
-- Name: member_state; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.member_state AS ENUM (
    'pending',
    'active',
    'suspended',
    'deleted',
    'banned'
);


--
-- Name: membership_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.membership_role AS ENUM (
    'clubadmin',
    'member'
);


--
-- Name: membership_state; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.membership_state AS ENUM (
    'applying',
    'submitted',
    'interview_scheduled',
    'interview_completed',
    'payment_pending',
    'active',
    'renewal_pending',
    'cancelled',
    'expired',
    'removed',
    'banned',
    'declined',
    'withdrawn'
);


--
-- Name: message_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.message_role AS ENUM (
    'member',
    'agent',
    'system'
);


--
-- Name: content_gate_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.content_gate_status AS ENUM (
    'passed',
    'rejected_illegal',
    'rejected_quality',
    'rejected_malformed',
    'skipped',
    'failed'
);


--
-- Name: quota_scope; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.quota_scope AS ENUM (
    'global',
    'club'
);


--
-- Name: rsvp_state; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.rsvp_state AS ENUM (
    'yes',
    'maybe',
    'no',
    'waitlist',
    'cancelled'
);


--
-- Name: short_id; Type: DOMAIN; Schema: public; Owner: -
--

CREATE DOMAIN public.short_id AS text
	CONSTRAINT short_id_check CHECK ((VALUE ~ '^[23456789abcdefghjkmnpqrstuvwxyz]{12}$'::text));


--
-- Name: subscription_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.subscription_status AS ENUM (
    'trialing',
    'active',
    'past_due',
    'paused',
    'canceled',
    'ended'
);


--
-- Name: thread_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.thread_kind AS ENUM (
    'direct'
);


--
-- Name: club_memberships_require_profile_version(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.club_memberships_require_profile_version() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.status NOT IN ('active', 'renewal_pending', 'cancelled') THEN
        RETURN NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM public.member_club_profile_versions
         WHERE membership_id = NEW.id
    ) THEN
        RAISE EXCEPTION 'club_memberships row % has no profile version — version 1 must be inserted in the same transaction', NEW.id;
    END IF;

    RETURN NULL;
END;
$$;


--
-- Name: lock_club_membership_mutation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.lock_club_membership_mutation() RETURNS trigger
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
    IF NEW.applied_at IS DISTINCT FROM OLD.applied_at THEN
        RAISE EXCEPTION 'club_memberships.applied_at is immutable';
    END IF;
    IF NEW.application_email IS DISTINCT FROM OLD.application_email THEN
        RAISE EXCEPTION 'club_memberships.application_email is immutable';
    END IF;
    IF NEW.submission_path IS DISTINCT FROM OLD.submission_path THEN
        RAISE EXCEPTION 'club_memberships.submission_path is immutable';
    END IF;
    IF NEW.proof_kind IS DISTINCT FROM OLD.proof_kind THEN
        RAISE EXCEPTION 'club_memberships.proof_kind is immutable';
    END IF;
    IF NEW.invitation_id IS DISTINCT FROM OLD.invitation_id THEN
        RAISE EXCEPTION 'club_memberships.invitation_id is immutable';
    END IF;
    IF NEW.joined_at IS DISTINCT FROM OLD.joined_at THEN
        IF OLD.joined_at IS NULL AND NEW.joined_at IS NOT NULL THEN
            RETURN NEW;
        END IF;
        RAISE EXCEPTION 'club_memberships.joined_at is immutable except for first active transition';
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


--
-- Name: lock_club_versioned_mutation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.lock_club_versioned_mutation() RETURNS trigger
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


--
-- Name: member_club_profile_versions_check_membership(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.member_club_profile_versions_check_membership() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    m_member_id short_id;
    m_club_id short_id;
BEGIN
    SELECT member_id, club_id
      INTO m_member_id, m_club_id
      FROM club_memberships
     WHERE id = NEW.membership_id;

    IF m_member_id IS NULL THEN
        RAISE EXCEPTION 'membership_id % not found', NEW.membership_id;
    END IF;

    IF NEW.member_id <> m_member_id OR NEW.club_id <> m_club_id THEN
        RAISE EXCEPTION 'member_id/club_id mismatch: version has (%, %) but membership has (%, %)',
            NEW.member_id, NEW.club_id, m_member_id, m_club_id;
    END IF;

    RETURN NEW;
END;
$$;


--
-- Name: member_club_profile_versions_search_vector_trigger(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.member_club_profile_versions_search_vector_trigger() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.search_vector := to_tsvector('english',
        coalesce(NEW.tagline, '') || ' ' ||
        coalesce(NEW.summary, '') || ' ' ||
        coalesce(NEW.what_i_do, '') || ' ' ||
        coalesce(NEW.known_for, '') || ' ' ||
        coalesce(NEW.services_summary, '')
    );
    RETURN NEW;
END;
$$;


--
-- Name: new_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.new_id() RETURNS public.short_id
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


--
-- Name: normalize_admission_policy(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.normalize_admission_policy() RETURNS trigger
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


--
-- Name: notify_club_activity(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_club_activity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM pg_notify('stream', json_build_object(
        'clubId', NEW.club_id,
        'kind', 'activity'
    )::text);
    RETURN NEW;
END;
$$;


--
-- Name: notify_club_membership_state_version(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_club_membership_state_version() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_club_id short_id;
BEGIN
    SELECT club_id
    INTO v_club_id
    FROM public.club_memberships
    WHERE id = NEW.membership_id;

    PERFORM pg_notify('stream', json_build_object(
        'clubId', v_club_id,
        'kind', 'notification'
    )::text);
    RETURN NEW;
END;
$$;


--
-- Name: notify_dm_inbox(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_dm_inbox() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM pg_notify('stream', json_build_object(
        'recipientMemberId', NEW.recipient_member_id,
        'kind', 'message'
    )::text);
    RETURN NEW;
END;
$$;


--
-- Name: notify_member_notification(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_member_notification() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM pg_notify('stream', json_build_object(
        'clubId', NEW.club_id,
        'recipientMemberId', NEW.recipient_member_id,
        'kind', 'notification'
    )::text);
    RETURN NEW;
END;
$$;


--
-- Name: reject_row_mutation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reject_row_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION '% not allowed on %', TG_OP, TG_TABLE_NAME;
END;
$$;


--
-- Name: sync_club_membership_state(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_club_membership_state() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM set_config('app.allow_membership_state_sync', '1', true);
    UPDATE public.club_memberships m
       SET status = NEW.status,
           joined_at = CASE
               WHEN NEW.status = 'active' AND m.joined_at IS NULL THEN NEW.created_at
               ELSE m.joined_at
           END,
           left_at = CASE
               WHEN NEW.status IN ('declined', 'withdrawn', 'expired', 'removed', 'banned')
                   THEN coalesce(m.left_at, NEW.created_at)
               ELSE NULL
           END
     WHERE m.id = NEW.membership_id;
    PERFORM set_config('app.allow_membership_state_sync', '', true);
    RETURN NEW;
EXCEPTION
    WHEN others THEN
        PERFORM set_config('app.allow_membership_state_sync', '', true);
        RAISE;
END;
$$;


--
-- Name: sync_club_version_to_club(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_club_version_to_club() RETURNS trigger
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


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: club_membership_state_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.club_membership_state_versions (
    id public.short_id DEFAULT public.new_id() NOT NULL,
    membership_id public.short_id NOT NULL,
    status public.membership_state NOT NULL,
    reason text,
    version_no integer NOT NULL,
    supersedes_state_version_id public.short_id,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_member_id public.short_id,
    CONSTRAINT club_membership_state_versions_version_no_check CHECK ((version_no > 0))
);


--
-- Name: club_memberships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.club_memberships (
    id public.short_id DEFAULT public.new_id() NOT NULL,
    club_id public.short_id NOT NULL,
    member_id public.short_id NOT NULL,
    sponsor_member_id public.short_id,
    role public.membership_role DEFAULT 'member'::public.membership_role NOT NULL,
    status public.membership_state NOT NULL,
    joined_at timestamp with time zone,
    left_at timestamp with time zone,
    accepted_covenant_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_comped boolean DEFAULT false NOT NULL,
    comped_at timestamp with time zone,
    comped_by_member_id public.short_id,
    approved_price_amount numeric(12,2),
    approved_price_currency text,
    application_name text,
    application_email text,
    application_email_normalized text GENERATED ALWAYS AS (lower(btrim(application_email))) STORED,
    application_socials text,
    application_text text,
    applied_at timestamp with time zone,
    application_submitted_at timestamp with time zone,
    submission_path text,
    proof_kind text,
    invitation_id public.short_id,
    generated_profile_draft jsonb,
    CONSTRAINT club_memberships_proof_kind_check CHECK (((proof_kind IS NULL) OR (proof_kind = ANY (ARRAY['pow'::text, 'invitation'::text, 'none'::text])))),
    CONSTRAINT club_memberships_submission_path_check CHECK (((submission_path IS NULL) OR (submission_path = ANY (ARRAY['cold'::text, 'invitation'::text, 'cross_apply'::text, 'owner_nominated'::text]))))
);


--
-- Name: club_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.club_subscriptions (
    id public.short_id DEFAULT public.new_id() NOT NULL,
    membership_id public.short_id NOT NULL,
    payer_member_id public.short_id NOT NULL,
    status public.subscription_status DEFAULT 'active'::public.subscription_status NOT NULL,
    amount numeric(12,2) NOT NULL,
    currency text DEFAULT 'USD'::text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    current_period_end timestamp with time zone,
    ended_at timestamp with time zone,
    CONSTRAINT club_subscriptions_amount_check CHECK ((amount >= (0)::numeric)),
    CONSTRAINT club_subscriptions_currency_check CHECK ((currency ~ '^[A-Z]{3}$'::text))
);


--
-- Name: current_club_membership_states; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.current_club_membership_states AS
 SELECT DISTINCT ON (membership_id) id,
    membership_id,
    status,
    reason,
    version_no,
    supersedes_state_version_id,
    created_at,
    created_by_member_id
   FROM public.club_membership_state_versions
  ORDER BY membership_id, version_no DESC, created_at DESC;


--
-- Name: current_club_memberships; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.current_club_memberships AS
 SELECT m.id,
    m.club_id,
    m.member_id,
    m.sponsor_member_id,
    m.role,
    m.status,
    m.joined_at,
    m.left_at,
    m.accepted_covenant_at,
    m.metadata,
    m.is_comped,
    m.comped_at,
    m.comped_by_member_id,
    m.approved_price_amount,
    m.approved_price_currency,
    m.application_name,
    m.application_email,
    m.application_email_normalized,
    m.application_socials,
    m.application_text,
    m.applied_at,
    m.application_submitted_at,
    m.submission_path,
    m.proof_kind,
    m.invitation_id,
    m.generated_profile_draft,
    cms.id AS state_version_id,
    cms.reason AS state_reason,
    cms.version_no AS state_version_no,
    cms.created_at AS state_created_at,
    cms.created_by_member_id AS state_created_by_member_id
   FROM (public.club_memberships m
     LEFT JOIN public.current_club_membership_states cms ON (((cms.membership_id)::text = (m.id)::text)));


--
-- Name: accessible_club_memberships; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.accessible_club_memberships AS
 SELECT id,
    club_id,
    member_id,
    sponsor_member_id,
    role,
    status,
    joined_at,
    left_at,
    accepted_covenant_at,
    metadata,
    is_comped,
    comped_at,
    comped_by_member_id,
    approved_price_amount,
    approved_price_currency,
    application_name,
    application_email,
    application_email_normalized,
    application_socials,
    application_text,
    applied_at,
    application_submitted_at,
    submission_path,
    proof_kind,
    invitation_id,
    generated_profile_draft,
    state_version_id,
    state_reason,
    state_version_no,
    state_created_at,
    state_created_by_member_id
   FROM public.current_club_memberships cm
  WHERE ((left_at IS NULL) AND (((is_comped = true) AND (status = 'active'::public.membership_state)) OR ((status = ANY (ARRAY['active'::public.membership_state, 'cancelled'::public.membership_state])) AND (EXISTS ( SELECT 1
           FROM public.club_subscriptions s
          WHERE (((s.membership_id)::text = (cm.id)::text) AND (s.status = ANY (ARRAY['trialing'::public.subscription_status, 'active'::public.subscription_status, 'past_due'::public.subscription_status])) AND (COALESCE(s.ended_at, 'infinity'::timestamp with time zone) > now()) AND (COALESCE(s.current_period_end, 'infinity'::timestamp with time zone) > now()))))) OR ((status = 'renewal_pending'::public.membership_state) AND ((state_created_at + '7 days'::interval) > now()))));


--
-- Name: active_club_memberships; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.active_club_memberships AS
 SELECT id,
    club_id,
    member_id,
    sponsor_member_id,
    role,
    status,
    joined_at,
    left_at,
    accepted_covenant_at,
    metadata,
    is_comped,
    comped_at,
    comped_by_member_id,
    approved_price_amount,
    approved_price_currency,
    application_name,
    application_email,
    application_email_normalized,
    application_socials,
    application_text,
    applied_at,
    application_submitted_at,
    submission_path,
    proof_kind,
    invitation_id,
    generated_profile_draft,
    state_version_id,
    state_reason,
    state_version_no,
    state_created_at,
    state_created_by_member_id
   FROM public.current_club_memberships
  WHERE ((status = 'active'::public.membership_state) AND (left_at IS NULL));


--
-- Name: ai_embedding_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_embedding_jobs (
    id public.short_id DEFAULT public.new_id() NOT NULL,
    subject_kind text NOT NULL,
    subject_version_id public.short_id NOT NULL,
    model text NOT NULL,
    dimensions integer NOT NULL,
    source_version text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    failure_kind text,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_embedding_jobs_dimensions_check CHECK ((dimensions > 0)),
    CONSTRAINT ai_embedding_jobs_subject_kind_check CHECK ((subject_kind = ANY (ARRAY['member_club_profile_version'::text, 'entity_version'::text])))
);


--
-- Name: ai_llm_usage_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_llm_usage_log (
    id public.short_id DEFAULT public.new_id() NOT NULL,
    member_id public.short_id,
    requested_club_id public.short_id,
    action_name text NOT NULL,
    artifact_kind text NOT NULL,
    provider text NOT NULL,
    model text NOT NULL,
    gate_status public.content_gate_status NOT NULL,
    skip_reason text,
    prompt_tokens integer,
    completion_tokens integer,
    provider_error_code text,
    feedback text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_llm_usage_log_skip_reason_check CHECK ((((gate_status = 'skipped'::public.content_gate_status) AND (skip_reason IS NOT NULL)) OR ((gate_status <> 'skipped'::public.content_gate_status) AND (skip_reason IS NULL))))
);


--
-- Name: application_pow_challenges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.application_pow_challenges (
    id public.short_id DEFAULT public.new_id() NOT NULL,
    membership_id public.short_id NOT NULL,
    difficulty integer NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    solved_at timestamp with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: club_activity; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.club_activity (
    id public.short_id DEFAULT public.new_id() NOT NULL,
    club_id public.short_id NOT NULL,
    seq bigint NOT NULL,
    topic text NOT NULL,
    audience public.club_activity_audience DEFAULT 'members'::public.club_activity_audience NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    entity_id public.short_id,
    entity_version_id public.short_id,
    created_by_member_id public.short_id,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT club_activity_topic_check CHECK ((length(btrim(topic)) > 0))
);


--
-- Name: club_activity_cursors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.club_activity_cursors (
    member_id public.short_id NOT NULL,
    club_id public.short_id NOT NULL,
    last_seq bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: club_activity_seq_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.club_activity ALTER COLUMN seq ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.club_activity_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: club_edges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.club_edges (
    id public.short_id DEFAULT public.new_id() NOT NULL,
    club_id public.short_id,
    kind public.edge_kind NOT NULL,
    from_member_id public.short_id,
    from_entity_id public.short_id,
    from_entity_version_id public.short_id,
    to_member_id public.short_id,
    to_entity_id public.short_id,
    to_entity_version_id public.short_id,
    reason text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    client_key text,
    created_by_member_id public.short_id,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    CONSTRAINT club_edges_from_check CHECK ((((((from_member_id IS NOT NULL))::integer + ((from_entity_id IS NOT NULL))::integer) + ((from_entity_version_id IS NOT NULL))::integer) = 1)),
    CONSTRAINT club_edges_no_self_vouch CHECK (((kind <> 'vouched_for'::public.edge_kind) OR ((from_member_id)::text <> (to_member_id)::text))),
    CONSTRAINT club_edges_to_check CHECK ((((((to_member_id IS NOT NULL))::integer + ((to_entity_id IS NOT NULL))::integer) + ((to_entity_version_id IS NOT NULL))::integer) = 1)),
    CONSTRAINT club_edges_vouch_check CHECK (((kind <> 'vouched_for'::public.edge_kind) OR ((from_member_id IS NOT NULL) AND (to_member_id IS NOT NULL) AND (reason IS NOT NULL))))
);


--
-- Name: club_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.club_versions (
    id public.short_id DEFAULT public.new_id() NOT NULL,
    club_id public.short_id NOT NULL,
    owner_member_id public.short_id NOT NULL,
    name text NOT NULL,
    summary text,
    admission_policy text,
    membership_price_amount numeric(12,2),
    membership_price_currency text DEFAULT 'USD'::text NOT NULL,
    version_no integer NOT NULL,
    supersedes_version_id public.short_id,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_member_id public.short_id,
    CONSTRAINT club_versions_admission_policy_length CHECK (((admission_policy IS NULL) OR ((char_length(admission_policy) >= 1) AND (char_length(admission_policy) <= 2000)))),
    CONSTRAINT club_versions_currency_check CHECK ((membership_price_currency ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT club_versions_name_check CHECK ((length(btrim(name)) > 0)),
    CONSTRAINT club_versions_price_check CHECK (((membership_price_amount IS NULL) OR (membership_price_amount >= (0)::numeric))),
    CONSTRAINT club_versions_version_no_check CHECK ((version_no > 0))
);


--
-- Name: clubs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.clubs (
    id public.short_id DEFAULT public.new_id() NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    summary text,
    owner_member_id public.short_id NOT NULL,
    admission_policy text,
    welcome_template jsonb,
    membership_price_amount numeric(12,2),
    membership_price_currency text DEFAULT 'USD'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    CONSTRAINT clubs_admission_policy_length CHECK (((admission_policy IS NULL) OR ((char_length(admission_policy) >= 1) AND (char_length(admission_policy) <= 2000)))),
    CONSTRAINT clubs_currency_check CHECK ((membership_price_currency ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT clubs_name_check CHECK ((length(btrim(name)) > 0)),
    CONSTRAINT clubs_price_check CHECK (((membership_price_amount IS NULL) OR (membership_price_amount >= (0)::numeric))),
    CONSTRAINT clubs_slug_check CHECK ((slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'::text))
);


--
-- Name: content_threads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.content_threads (
    id public.short_id DEFAULT public.new_id() NOT NULL,
    club_id public.short_id NOT NULL,
    created_by_member_id public.short_id NOT NULL,
    last_activity_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone
);


--
-- Name: current_club_versions; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.current_club_versions AS
 SELECT DISTINCT ON (club_id) id,
    club_id,
    owner_member_id,
    name,
    summary,
    admission_policy,
    membership_price_amount,
    membership_price_currency,
    version_no,
    supersedes_version_id,
    created_at,
    created_by_member_id
   FROM public.club_versions
  ORDER BY club_id, version_no DESC, created_at DESC;


--
-- Name: entity_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entity_versions (
    id public.short_id DEFAULT public.new_id() NOT NULL,
    entity_id public.short_id NOT NULL,
    version_no integer NOT NULL,
    state public.entity_state DEFAULT 'published'::public.entity_state NOT NULL,
    title text,
    summary text,
    body text,
    effective_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    reason text,
    supersedes_version_id public.short_id,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_member_id public.short_id,
    CONSTRAINT entity_versions_expiry_check CHECK (((expires_at IS NULL) OR (expires_at >= effective_at))),
    CONSTRAINT entity_versions_version_no_check CHECK ((version_no > 0))
);


--
-- Name: current_entity_versions; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.current_entity_versions AS
 SELECT DISTINCT ON (entity_id) id,
    entity_id,
    version_no,
    state,
    title,
    summary,
    body,
    effective_at,
    expires_at,
    reason,
    supersedes_version_id,
    created_at,
    created_by_member_id
   FROM public.entity_versions
  ORDER BY entity_id, version_no DESC, created_at DESC;


--
-- Name: event_rsvps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.event_rsvps (
    id public.short_id DEFAULT public.new_id() NOT NULL,
    event_entity_id public.short_id NOT NULL,
    membership_id public.short_id NOT NULL,
    response public.rsvp_state NOT NULL,
    note text,
    client_key text,
    version_no integer DEFAULT 1 NOT NULL,
    supersedes_rsvp_id public.short_id,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_member_id public.short_id
);


--
-- Name: current_event_rsvps; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.current_event_rsvps AS
 SELECT DISTINCT ON (event_entity_id, membership_id) id,
    event_entity_id,
    membership_id,
    response,
    note,
    client_key,
    version_no,
    supersedes_rsvp_id,
    created_at,
    created_by_member_id
   FROM public.event_rsvps
  ORDER BY event_entity_id, membership_id, version_no DESC, created_at DESC;


--
-- Name: event_version_details; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.event_version_details (
    entity_version_id public.short_id NOT NULL,
    location text,
    starts_at timestamp with time zone,
    ends_at timestamp with time zone,
    timezone text,
    recurrence_rule text,
    capacity integer,
    CONSTRAINT event_version_details_capacity_check CHECK (((capacity IS NULL) OR (capacity > 0))),
    CONSTRAINT event_version_details_dates_check CHECK (((ends_at IS NULL) OR (starts_at IS NULL) OR (ends_at >= starts_at)))
);


--
-- Name: current_event_versions; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.current_event_versions AS
 SELECT cev.id,
    cev.entity_id,
    cev.version_no,
    cev.state,
    cev.title,
    cev.summary,
    cev.body,
    cev.effective_at,
    cev.expires_at,
    cev.reason,
    cev.supersedes_version_id,
    cev.created_at,
    cev.created_by_member_id,
    evd.location,
    evd.starts_at,
    evd.ends_at,
    evd.timezone,
    evd.recurrence_rule,
    evd.capacity
   FROM (public.current_entity_versions cev
     JOIN public.event_version_details evd ON (((evd.entity_version_id)::text = (cev.id)::text)));


--
-- Name: member_club_profile_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.member_club_profile_versions (
    id public.short_id DEFAULT public.new_id() NOT NULL,
    membership_id public.short_id NOT NULL,
    member_id public.short_id NOT NULL,
    club_id public.short_id NOT NULL,
    version_no integer NOT NULL,
    tagline text,
    summary text,
    what_i_do text,
    known_for text,
    services_summary text,
    website_url text,
    links jsonb DEFAULT '[]'::jsonb NOT NULL,
    search_vector tsvector,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_member_id public.short_id,
    generation_source text DEFAULT 'manual'::text NOT NULL,
    CONSTRAINT member_club_profile_versions_generation_source_check CHECK ((generation_source = ANY (ARRAY['manual'::text, 'migration_backfill'::text, 'application_generated'::text, 'membership_seed'::text]))),
    CONSTRAINT member_club_profile_versions_version_no_check CHECK ((version_no > 0))
);


--
-- Name: current_member_club_profiles; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.current_member_club_profiles AS
 SELECT DISTINCT ON (member_id, club_id) id,
    membership_id,
    member_id,
    club_id,
    version_no,
    tagline,
    summary,
    what_i_do,
    known_for,
    services_summary,
    website_url,
    links,
    search_vector,
    created_at,
    created_by_member_id,
    generation_source
   FROM public.member_club_profile_versions
  ORDER BY member_id, club_id, version_no DESC, created_at DESC;


--
-- Name: member_global_role_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.member_global_role_versions (
    id public.short_id DEFAULT public.new_id() NOT NULL,
    member_id public.short_id NOT NULL,
    role public.global_role NOT NULL,
    status public.assignment_state DEFAULT 'active'::public.assignment_state NOT NULL,
    version_no integer NOT NULL,
    supersedes_role_version_id public.short_id,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_member_id public.short_id,
    CONSTRAINT member_global_role_versions_version_no_check CHECK ((version_no > 0))
);


--
-- Name: current_member_global_role_versions; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.current_member_global_role_versions AS
 SELECT DISTINCT ON (member_id, role) id,
    member_id,
    role,
    status,
    version_no,
    supersedes_role_version_id,
    created_at,
    created_by_member_id
   FROM public.member_global_role_versions
  ORDER BY member_id, role, version_no DESC, created_at DESC;


--
-- Name: current_member_global_roles; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.current_member_global_roles AS
 SELECT id,
    member_id,
    role,
    status,
    version_no,
    supersedes_role_version_id,
    created_at,
    created_by_member_id
   FROM public.current_member_global_role_versions
  WHERE (status = 'active'::public.assignment_state);


--
-- Name: dm_inbox_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dm_inbox_entries (
    id public.short_id DEFAULT public.new_id() NOT NULL,
    recipient_member_id public.short_id NOT NULL,
    thread_id public.short_id NOT NULL,
    message_id public.short_id NOT NULL,
    acknowledged boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: dm_message_mentions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dm_message_mentions (
    message_id public.short_id NOT NULL,
    start_offset integer NOT NULL,
    end_offset integer NOT NULL,
    mentioned_member_id public.short_id NOT NULL,
    authored_label text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT dm_message_mentions_offset_check CHECK (((start_offset >= 0) AND (end_offset > start_offset)))
);


--
-- Name: dm_message_removals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dm_message_removals (
    message_id public.short_id NOT NULL,
    removed_by_member_id public.short_id NOT NULL,
    reason text,
    removed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: dm_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dm_messages (
    id public.short_id DEFAULT public.new_id() NOT NULL,
    thread_id public.short_id NOT NULL,
    sender_member_id public.short_id,
    role public.message_role NOT NULL,
    message_text text,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    in_reply_to_message_id public.short_id,
    client_key text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT dm_messages_content_check CHECK (((message_text IS NOT NULL) OR (payload <> '{}'::jsonb)))
);


--
-- Name: dm_thread_participants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dm_thread_participants (
    id public.short_id DEFAULT public.new_id() NOT NULL,
    thread_id public.short_id NOT NULL,
    member_id public.short_id NOT NULL,
    role text DEFAULT 'participant'::text NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    left_at timestamp with time zone
);


--
-- Name: dm_threads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dm_threads (
    id public.short_id DEFAULT public.new_id() NOT NULL,
    kind public.thread_kind NOT NULL,
    created_by_member_id public.short_id,
    subject_entity_id public.short_id,
    member_a_id public.short_id,
    member_b_id public.short_id,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    CONSTRAINT dm_threads_direct_pair_check CHECK (((kind <> 'direct'::public.thread_kind) OR ((member_a_id IS NOT NULL) AND (member_b_id IS NOT NULL) AND ((member_a_id)::text < (member_b_id)::text))))
);


--
-- Name: entities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entities (
    id public.short_id DEFAULT public.new_id() NOT NULL,
    club_id public.short_id NOT NULL,
    kind public.entity_kind NOT NULL,
    author_member_id public.short_id NOT NULL,
    open_loop boolean,
    content_thread_id public.short_id NOT NULL,
    client_key text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    deleted_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT entities_open_loop_kind_check CHECK ((((kind = ANY (ARRAY['ask'::public.entity_kind, 'gift'::public.entity_kind, 'service'::public.entity_kind, 'opportunity'::public.entity_kind])) AND (open_loop IS NOT NULL)) OR ((kind <> ALL (ARRAY['ask'::public.entity_kind, 'gift'::public.entity_kind, 'service'::public.entity_kind, 'opportunity'::public.entity_kind])) AND (open_loop IS NULL))))
);


--
-- Name: entity_embeddings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entity_embeddings (
    id public.short_id DEFAULT public.new_id() NOT NULL,
    entity_id public.short_id NOT NULL,
    entity_version_id public.short_id NOT NULL,
    model text NOT NULL,
    dimensions integer NOT NULL,
    source_version text NOT NULL,
    chunk_index integer DEFAULT 0 NOT NULL,
    source_text text NOT NULL,
    source_hash text NOT NULL,
    embedding public.vector(1536) NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT entity_embeddings_dimensions_check CHECK ((dimensions > 0))
);


--
-- Name: entity_version_mentions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entity_version_mentions (
    entity_version_id public.short_id NOT NULL,
    field text NOT NULL,
    start_offset integer NOT NULL,
    end_offset integer NOT NULL,
    mentioned_member_id public.short_id NOT NULL,
    authored_label text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT entity_version_mentions_field_check CHECK ((field = ANY (ARRAY['title'::text, 'summary'::text, 'body'::text]))),
    CONSTRAINT entity_version_mentions_offset_check CHECK (((start_offset >= 0) AND (end_offset > start_offset)))
);


--
-- Name: invitations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invitations (
    id public.short_id DEFAULT public.new_id() NOT NULL,
    club_id public.short_id NOT NULL,
    sponsor_member_id public.short_id NOT NULL,
    candidate_name text NOT NULL,
    candidate_email text NOT NULL,
    candidate_email_normalized text GENERATED ALWAYS AS (lower(btrim(candidate_email))) STORED,
    reason text NOT NULL,
    code_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    expired_at timestamp with time zone,
    used_at timestamp with time zone,
    used_membership_id public.short_id,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: published_entity_versions; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.published_entity_versions AS
 SELECT id,
    entity_id,
    version_no,
    state,
    title,
    summary,
    body,
    effective_at,
    expires_at,
    reason,
    supersedes_version_id,
    created_at,
    created_by_member_id
   FROM public.current_entity_versions
  WHERE (state = 'published'::public.entity_state);


--
-- Name: live_entities; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.live_entities AS
 SELECT e.id AS entity_id,
    e.club_id,
    e.kind,
    e.open_loop,
    e.author_member_id,
    e.content_thread_id,
    e.created_at AS entity_created_at,
    pev.id AS entity_version_id,
    pev.version_no,
    pev.state,
    pev.title,
    pev.summary,
    pev.body,
    pev.effective_at,
    pev.expires_at,
    pev.created_at AS version_created_at,
    pev.created_by_member_id
   FROM (public.entities e
     JOIN public.published_entity_versions pev ON (((pev.entity_id)::text = (e.id)::text)))
  WHERE ((e.archived_at IS NULL) AND (e.deleted_at IS NULL) AND ((pev.expires_at IS NULL) OR (pev.expires_at > now())));


--
-- Name: live_events; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.live_events AS
 SELECT le.entity_id,
    le.club_id,
    le.kind,
    le.open_loop,
    le.author_member_id,
    le.content_thread_id,
    le.entity_created_at,
    le.entity_version_id,
    le.version_no,
    le.state,
    le.title,
    le.summary,
    le.body,
    le.effective_at,
    le.expires_at,
    le.version_created_at,
    le.created_by_member_id,
    evd.location,
    evd.starts_at,
    evd.ends_at,
    evd.timezone,
    evd.recurrence_rule,
    evd.capacity
   FROM (public.live_entities le
     JOIN public.event_version_details evd ON (((evd.entity_version_id)::text = (le.entity_version_id)::text)))
  WHERE (le.kind = 'event'::public.entity_kind);


--
-- Name: member_bearer_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.member_bearer_tokens (
    id public.short_id DEFAULT public.new_id() NOT NULL,
    member_id public.short_id NOT NULL,
    label text,
    token_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    revoked_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    expires_at timestamp with time zone
);


--
-- Name: member_notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.member_notifications (
    id public.short_id DEFAULT public.new_id() NOT NULL,
    club_id public.short_id,
    recipient_member_id public.short_id NOT NULL,
    seq bigint NOT NULL,
    topic text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    entity_id public.short_id,
    match_id public.short_id,
    acknowledged_state text,
    acknowledged_at timestamp with time zone,
    suppression_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT member_notifications_ack_state_check CHECK (((acknowledged_state IS NULL) OR (acknowledged_state = ANY (ARRAY['processed'::text, 'suppressed'::text])))),
    CONSTRAINT member_notifications_suppression_check CHECK ((((acknowledged_state = 'suppressed'::text) AND (suppression_reason IS NOT NULL)) OR (acknowledged_state IS DISTINCT FROM 'suppressed'::text))),
    CONSTRAINT member_notifications_topic_check CHECK ((length(btrim(topic)) > 0))
);


--
-- Name: member_notifications_seq_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.member_notifications ALTER COLUMN seq ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.member_notifications_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: member_private_contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.member_private_contacts (
    member_id public.short_id NOT NULL,
    email text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT member_private_contacts_email_check CHECK (((email IS NULL) OR (email ~~ '%@%'::text)))
);


--
-- Name: member_profile_embeddings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.member_profile_embeddings (
    id public.short_id DEFAULT public.new_id() NOT NULL,
    member_id public.short_id NOT NULL,
    club_id public.short_id NOT NULL,
    profile_version_id public.short_id NOT NULL,
    model text NOT NULL,
    dimensions integer NOT NULL,
    source_version text NOT NULL,
    chunk_index integer DEFAULT 0 NOT NULL,
    source_text text NOT NULL,
    source_hash text NOT NULL,
    embedding public.vector(1536) NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT member_profile_embeddings_dimensions_check CHECK ((dimensions > 0))
);


--
-- Name: members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.members (
    id public.short_id DEFAULT public.new_id() NOT NULL,
    public_name text NOT NULL,
    display_name text NOT NULL,
    state public.member_state DEFAULT 'active'::public.member_state NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    onboarded_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT members_display_name_check CHECK ((length(btrim(display_name)) > 0)),
    CONSTRAINT members_public_name_check CHECK ((length(btrim(public_name)) > 0))
);


--
-- Name: quota_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.quota_policies (
    id public.short_id DEFAULT public.new_id() NOT NULL,
    scope public.quota_scope NOT NULL,
    club_id public.short_id,
    action_name text NOT NULL,
    max_per_day integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT quota_policies_action_check CHECK ((action_name = 'content.create'::text)),
    CONSTRAINT quota_policies_max_check CHECK ((max_per_day > 0)),
    CONSTRAINT quota_policies_scope_club_check CHECK ((((scope = 'global'::public.quota_scope) AND (club_id IS NULL)) OR ((scope = 'club'::public.quota_scope) AND (club_id IS NOT NULL))))
);


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    filename text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: signal_background_matches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.signal_background_matches (
    id public.short_id DEFAULT public.new_id() NOT NULL,
    club_id public.short_id NOT NULL,
    match_kind text NOT NULL,
    source_id text NOT NULL,
    target_member_id public.short_id NOT NULL,
    score double precision NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    signal_id public.short_id,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    delivered_at timestamp with time zone,
    expires_at timestamp with time zone,
    CONSTRAINT signal_background_matches_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'delivered'::text, 'expired'::text])))
);


--
-- Name: signal_recompute_queue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.signal_recompute_queue (
    id public.short_id DEFAULT public.new_id() NOT NULL,
    queue_name text NOT NULL,
    member_id public.short_id NOT NULL,
    club_id public.short_id NOT NULL,
    recompute_after timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    claimed_at timestamp with time zone
);


--
-- Name: worker_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.worker_state (
    worker_id text NOT NULL,
    state_key text NOT NULL,
    state_value text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ai_embedding_jobs ai_embedding_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_embedding_jobs
    ADD CONSTRAINT ai_embedding_jobs_pkey PRIMARY KEY (id);


--
-- Name: ai_embedding_jobs ai_embedding_jobs_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_embedding_jobs
    ADD CONSTRAINT ai_embedding_jobs_unique UNIQUE (subject_kind, subject_version_id, model, dimensions, source_version);


--
-- Name: ai_llm_usage_log ai_llm_usage_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_llm_usage_log
    ADD CONSTRAINT ai_llm_usage_log_pkey PRIMARY KEY (id);


--
-- Name: application_pow_challenges application_pow_challenges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.application_pow_challenges
    ADD CONSTRAINT application_pow_challenges_pkey PRIMARY KEY (id);


--
-- Name: club_activity_cursors club_activity_cursors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.club_activity_cursors
    ADD CONSTRAINT club_activity_cursors_pkey PRIMARY KEY (member_id, club_id);


--
-- Name: club_activity club_activity_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.club_activity
    ADD CONSTRAINT club_activity_pkey PRIMARY KEY (id);


--
-- Name: club_activity club_activity_seq_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.club_activity
    ADD CONSTRAINT club_activity_seq_unique UNIQUE (seq);


--
-- Name: club_edges club_edges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.club_edges
    ADD CONSTRAINT club_edges_pkey PRIMARY KEY (id);


--
-- Name: club_membership_state_versions club_membership_state_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.club_membership_state_versions
    ADD CONSTRAINT club_membership_state_versions_pkey PRIMARY KEY (id);


--
-- Name: club_membership_state_versions club_membership_state_versions_version_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.club_membership_state_versions
    ADD CONSTRAINT club_membership_state_versions_version_unique UNIQUE (membership_id, version_no);


--
-- Name: club_memberships club_memberships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.club_memberships
    ADD CONSTRAINT club_memberships_pkey PRIMARY KEY (id);


--
-- Name: club_subscriptions club_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.club_subscriptions
    ADD CONSTRAINT club_subscriptions_pkey PRIMARY KEY (id);


--
-- Name: club_versions club_versions_club_version_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.club_versions
    ADD CONSTRAINT club_versions_club_version_unique UNIQUE (club_id, version_no);


--
-- Name: club_versions club_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.club_versions
    ADD CONSTRAINT club_versions_pkey PRIMARY KEY (id);


--
-- Name: clubs clubs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clubs
    ADD CONSTRAINT clubs_pkey PRIMARY KEY (id);


--
-- Name: clubs clubs_slug_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clubs
    ADD CONSTRAINT clubs_slug_unique UNIQUE (slug);


--
-- Name: content_threads content_threads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_threads
    ADD CONSTRAINT content_threads_pkey PRIMARY KEY (id);


--
-- Name: dm_inbox_entries dm_inbox_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dm_inbox_entries
    ADD CONSTRAINT dm_inbox_entries_pkey PRIMARY KEY (id);


--
-- Name: dm_inbox_entries dm_inbox_entries_recipient_message_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dm_inbox_entries
    ADD CONSTRAINT dm_inbox_entries_recipient_message_unique UNIQUE (recipient_member_id, message_id);


--
-- Name: dm_message_mentions dm_message_mentions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dm_message_mentions
    ADD CONSTRAINT dm_message_mentions_pkey PRIMARY KEY (message_id, start_offset);


--
-- Name: dm_message_removals dm_message_removals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dm_message_removals
    ADD CONSTRAINT dm_message_removals_pkey PRIMARY KEY (message_id);


--
-- Name: dm_messages dm_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dm_messages
    ADD CONSTRAINT dm_messages_pkey PRIMARY KEY (id);


--
-- Name: dm_thread_participants dm_thread_participants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dm_thread_participants
    ADD CONSTRAINT dm_thread_participants_pkey PRIMARY KEY (id);


--
-- Name: dm_thread_participants dm_thread_participants_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dm_thread_participants
    ADD CONSTRAINT dm_thread_participants_unique UNIQUE (thread_id, member_id);


--
-- Name: dm_threads dm_threads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dm_threads
    ADD CONSTRAINT dm_threads_pkey PRIMARY KEY (id);


--
-- Name: entities entities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entities
    ADD CONSTRAINT entities_pkey PRIMARY KEY (id);


--
-- Name: entity_embeddings entity_embeddings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_embeddings
    ADD CONSTRAINT entity_embeddings_pkey PRIMARY KEY (id);


--
-- Name: entity_embeddings entity_embeddings_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_embeddings
    ADD CONSTRAINT entity_embeddings_unique UNIQUE (entity_id, model, dimensions, source_version, chunk_index);


--
-- Name: entity_version_mentions entity_version_mentions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_version_mentions
    ADD CONSTRAINT entity_version_mentions_pkey PRIMARY KEY (entity_version_id, field, start_offset);


--
-- Name: entity_versions entity_versions_entity_version_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_versions
    ADD CONSTRAINT entity_versions_entity_version_unique UNIQUE (entity_id, version_no);


--
-- Name: entity_versions entity_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_versions
    ADD CONSTRAINT entity_versions_pkey PRIMARY KEY (id);


--
-- Name: event_rsvps event_rsvps_event_membership_version_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_rsvps
    ADD CONSTRAINT event_rsvps_event_membership_version_unique UNIQUE (event_entity_id, membership_id, version_no);


--
-- Name: event_rsvps event_rsvps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_rsvps
    ADD CONSTRAINT event_rsvps_pkey PRIMARY KEY (id);


--
-- Name: event_version_details event_version_details_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_version_details
    ADD CONSTRAINT event_version_details_pkey PRIMARY KEY (entity_version_id);


--
-- Name: invitations invitations_code_hash_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_code_hash_unique UNIQUE (code_hash);


--
-- Name: invitations invitations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_pkey PRIMARY KEY (id);


--
-- Name: member_bearer_tokens member_bearer_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_bearer_tokens
    ADD CONSTRAINT member_bearer_tokens_pkey PRIMARY KEY (id);


--
-- Name: member_bearer_tokens member_bearer_tokens_token_hash_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_bearer_tokens
    ADD CONSTRAINT member_bearer_tokens_token_hash_unique UNIQUE (token_hash);


--
-- Name: member_club_profile_versions member_club_profile_versions_member_club_version_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_club_profile_versions
    ADD CONSTRAINT member_club_profile_versions_member_club_version_unique UNIQUE (member_id, club_id, version_no);


--
-- Name: member_club_profile_versions member_club_profile_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_club_profile_versions
    ADD CONSTRAINT member_club_profile_versions_pkey PRIMARY KEY (id);


--
-- Name: member_global_role_versions member_global_role_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_global_role_versions
    ADD CONSTRAINT member_global_role_versions_pkey PRIMARY KEY (id);


--
-- Name: member_global_role_versions member_global_role_versions_version_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_global_role_versions
    ADD CONSTRAINT member_global_role_versions_version_unique UNIQUE (member_id, role, version_no);


--
-- Name: member_notifications member_notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_notifications
    ADD CONSTRAINT member_notifications_pkey PRIMARY KEY (id);


--
-- Name: member_notifications member_notifications_seq_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_notifications
    ADD CONSTRAINT member_notifications_seq_unique UNIQUE (seq);


--
-- Name: member_private_contacts member_private_contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_private_contacts
    ADD CONSTRAINT member_private_contacts_pkey PRIMARY KEY (member_id);


--
-- Name: member_profile_embeddings member_profile_embeddings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_profile_embeddings
    ADD CONSTRAINT member_profile_embeddings_pkey PRIMARY KEY (id);


--
-- Name: member_profile_embeddings member_profile_embeddings_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_profile_embeddings
    ADD CONSTRAINT member_profile_embeddings_unique UNIQUE (member_id, club_id, model, dimensions, source_version, chunk_index);


--
-- Name: members members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.members
    ADD CONSTRAINT members_pkey PRIMARY KEY (id);


--
-- Name: quota_policies quota_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quota_policies
    ADD CONSTRAINT quota_policies_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (filename);


--
-- Name: signal_background_matches signal_background_matches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signal_background_matches
    ADD CONSTRAINT signal_background_matches_pkey PRIMARY KEY (id);


--
-- Name: signal_background_matches signal_background_matches_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signal_background_matches
    ADD CONSTRAINT signal_background_matches_unique UNIQUE (match_kind, source_id, target_member_id);


--
-- Name: signal_recompute_queue signal_recompute_queue_pending_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signal_recompute_queue
    ADD CONSTRAINT signal_recompute_queue_pending_unique UNIQUE (queue_name, member_id, club_id);


--
-- Name: signal_recompute_queue signal_recompute_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signal_recompute_queue
    ADD CONSTRAINT signal_recompute_queue_pkey PRIMARY KEY (id);


--
-- Name: worker_state worker_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.worker_state
    ADD CONSTRAINT worker_state_pkey PRIMARY KEY (worker_id, state_key);


--
-- Name: ai_embedding_jobs_claimable_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_embedding_jobs_claimable_idx ON public.ai_embedding_jobs USING btree (next_attempt_at) WHERE (attempt_count < 5);


--
-- Name: ai_llm_usage_log_club_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_llm_usage_log_club_created_idx ON public.ai_llm_usage_log USING btree (requested_club_id, created_at DESC);


--
-- Name: ai_llm_usage_log_member_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_llm_usage_log_member_created_idx ON public.ai_llm_usage_log USING btree (member_id, created_at DESC);


--
-- Name: application_pow_challenges_one_active_per_membership; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX application_pow_challenges_one_active_per_membership ON public.application_pow_challenges USING btree (membership_id) WHERE (solved_at IS NULL);


--
-- Name: club_activity_club_seq_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX club_activity_club_seq_idx ON public.club_activity USING btree (club_id, seq);


--
-- Name: club_edges_club_kind_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX club_edges_club_kind_idx ON public.club_edges USING btree (club_id, kind, created_at DESC);


--
-- Name: club_edges_from_member_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX club_edges_from_member_idx ON public.club_edges USING btree (from_member_id, kind, created_at DESC);


--
-- Name: club_edges_idempotent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX club_edges_idempotent_idx ON public.club_edges USING btree (created_by_member_id, client_key) WHERE (client_key IS NOT NULL);


--
-- Name: club_edges_to_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX club_edges_to_entity_idx ON public.club_edges USING btree (to_entity_id, kind, created_at DESC);


--
-- Name: club_edges_to_member_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX club_edges_to_member_idx ON public.club_edges USING btree (to_member_id, kind, created_at DESC);


--
-- Name: club_edges_unique_active_vouch; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX club_edges_unique_active_vouch ON public.club_edges USING btree (club_id, from_member_id, to_member_id) WHERE ((kind = 'vouched_for'::public.edge_kind) AND (archived_at IS NULL));


--
-- Name: club_membership_state_versions_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX club_membership_state_versions_lookup_idx ON public.club_membership_state_versions USING btree (membership_id, version_no DESC, created_at DESC);


--
-- Name: club_memberships_application_email_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX club_memberships_application_email_lookup_idx ON public.club_memberships USING btree (club_id, application_email_normalized) WHERE (application_email_normalized IS NOT NULL);


--
-- Name: club_memberships_club_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX club_memberships_club_status_idx ON public.club_memberships USING btree (club_id, status);


--
-- Name: club_memberships_member_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX club_memberships_member_status_idx ON public.club_memberships USING btree (member_id, status);


--
-- Name: club_memberships_non_terminal_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX club_memberships_non_terminal_unique ON public.club_memberships USING btree (club_id, member_id) WHERE (status <> ALL (ARRAY['declined'::public.membership_state, 'withdrawn'::public.membership_state, 'expired'::public.membership_state, 'removed'::public.membership_state, 'banned'::public.membership_state]));


--
-- Name: club_memberships_sponsor_joined_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX club_memberships_sponsor_joined_idx ON public.club_memberships USING btree (sponsor_member_id, joined_at);


--
-- Name: club_subscriptions_membership_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX club_subscriptions_membership_status_idx ON public.club_subscriptions USING btree (membership_id, status);


--
-- Name: club_subscriptions_one_live_per_membership; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX club_subscriptions_one_live_per_membership ON public.club_subscriptions USING btree (membership_id) WHERE (status = ANY (ARRAY['active'::public.subscription_status, 'trialing'::public.subscription_status, 'past_due'::public.subscription_status]));


--
-- Name: club_subscriptions_payer_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX club_subscriptions_payer_status_idx ON public.club_subscriptions USING btree (payer_member_id, status);


--
-- Name: club_versions_club_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX club_versions_club_idx ON public.club_versions USING btree (club_id, version_no DESC, created_at DESC);


--
-- Name: content_threads_club_activity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX content_threads_club_activity_idx ON public.content_threads USING btree (club_id, last_activity_at DESC, id DESC) WHERE (archived_at IS NULL);


--
-- Name: content_threads_id_club_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX content_threads_id_club_idx ON public.content_threads USING btree (id, club_id);


--
-- Name: dm_inbox_entries_recipient_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dm_inbox_entries_recipient_created_idx ON public.dm_inbox_entries USING btree (recipient_member_id, created_at DESC);


--
-- Name: dm_inbox_entries_unread_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dm_inbox_entries_unread_idx ON public.dm_inbox_entries USING btree (recipient_member_id) WHERE (acknowledged = false);


--
-- Name: dm_inbox_entries_unread_poll_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dm_inbox_entries_unread_poll_idx ON public.dm_inbox_entries USING btree (recipient_member_id, created_at) WHERE (acknowledged = false);


--
-- Name: dm_inbox_entries_unread_thread_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dm_inbox_entries_unread_thread_idx ON public.dm_inbox_entries USING btree (recipient_member_id, thread_id) WHERE (acknowledged = false);


--
-- Name: dm_message_mentions_member_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dm_message_mentions_member_created_idx ON public.dm_message_mentions USING btree (mentioned_member_id, created_at DESC);


--
-- Name: dm_messages_idempotent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX dm_messages_idempotent_idx ON public.dm_messages USING btree (sender_member_id, client_key) WHERE (client_key IS NOT NULL);


--
-- Name: dm_messages_sender_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dm_messages_sender_idx ON public.dm_messages USING btree (sender_member_id, created_at DESC);


--
-- Name: dm_messages_thread_created_asc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dm_messages_thread_created_asc_idx ON public.dm_messages USING btree (thread_id, created_at);


--
-- Name: dm_messages_thread_created_desc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dm_messages_thread_created_desc_idx ON public.dm_messages USING btree (thread_id, created_at DESC, id DESC);


--
-- Name: dm_thread_participants_member_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dm_thread_participants_member_idx ON public.dm_thread_participants USING btree (member_id, thread_id);


--
-- Name: dm_threads_created_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dm_threads_created_by_idx ON public.dm_threads USING btree (created_by_member_id, created_at DESC);


--
-- Name: dm_threads_direct_pair_unique_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX dm_threads_direct_pair_unique_idx ON public.dm_threads USING btree (kind, member_a_id, member_b_id) WHERE ((kind = 'direct'::public.thread_kind) AND (archived_at IS NULL));


--
-- Name: entities_author_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entities_author_idx ON public.entities USING btree (author_member_id, created_at DESC);


--
-- Name: entities_club_kind_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entities_club_kind_idx ON public.entities USING btree (club_id, kind, created_at DESC);


--
-- Name: entities_idempotent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX entities_idempotent_idx ON public.entities USING btree (author_member_id, client_key) WHERE (client_key IS NOT NULL);


--
-- Name: entities_live_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entities_live_idx ON public.entities USING btree (club_id, kind) WHERE ((archived_at IS NULL) AND (deleted_at IS NULL));

--
-- Name: entities_thread_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entities_thread_created_idx ON public.entities USING btree (content_thread_id, created_at, id) WHERE ((archived_at IS NULL) AND (deleted_at IS NULL));


--
-- Name: entity_embeddings_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entity_embeddings_entity_idx ON public.entity_embeddings USING btree (entity_id);


--
-- Name: entity_embeddings_version_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entity_embeddings_version_idx ON public.entity_embeddings USING btree (entity_version_id);


--
-- Name: entity_version_mentions_member_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entity_version_mentions_member_created_idx ON public.entity_version_mentions USING btree (mentioned_member_id, created_at DESC);


--
-- Name: entity_versions_effective_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entity_versions_effective_idx ON public.entity_versions USING btree (effective_at DESC);


--
-- Name: entity_versions_entity_version_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entity_versions_entity_version_idx ON public.entity_versions USING btree (entity_id, version_no DESC);


--
-- Name: entity_versions_expires_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entity_versions_expires_idx ON public.entity_versions USING btree (expires_at);


--
-- Name: event_rsvps_event_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX event_rsvps_event_idx ON public.event_rsvps USING btree (event_entity_id, response);


--
-- Name: event_rsvps_event_membership_version_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX event_rsvps_event_membership_version_idx ON public.event_rsvps USING btree (event_entity_id, membership_id, version_no DESC, created_at DESC);


--
-- Name: event_rsvps_idempotent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX event_rsvps_idempotent_idx ON public.event_rsvps USING btree (created_by_member_id, client_key) WHERE (client_key IS NOT NULL);


--
-- Name: event_rsvps_membership_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX event_rsvps_membership_idx ON public.event_rsvps USING btree (membership_id, created_at DESC);


--
-- Name: event_version_details_starts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX event_version_details_starts_idx ON public.event_version_details USING btree (starts_at);


--
-- Name: invitations_candidate_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX invitations_candidate_lookup_idx ON public.invitations USING btree (club_id, candidate_email_normalized, created_at DESC);


--
-- Name: invitations_open_per_sponsor_candidate_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX invitations_open_per_sponsor_candidate_idx ON public.invitations USING btree (club_id, sponsor_member_id, candidate_email_normalized) WHERE ((revoked_at IS NULL) AND (used_at IS NULL) AND (expired_at IS NULL));


--
-- Name: member_bearer_tokens_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX member_bearer_tokens_active_idx ON public.member_bearer_tokens USING btree (id) WHERE (revoked_at IS NULL);


--
-- Name: member_bearer_tokens_member_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX member_bearer_tokens_member_created_idx ON public.member_bearer_tokens USING btree (member_id, created_at DESC);


--
-- Name: member_club_profile_versions_club_member_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX member_club_profile_versions_club_member_idx ON public.member_club_profile_versions USING btree (club_id, member_id, version_no DESC);


--
-- Name: member_club_profile_versions_member_club_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX member_club_profile_versions_member_club_idx ON public.member_club_profile_versions USING btree (member_id, club_id, version_no DESC);


--
-- Name: member_club_profile_versions_membership_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX member_club_profile_versions_membership_idx ON public.member_club_profile_versions USING btree (membership_id, version_no DESC);


--
-- Name: member_club_profile_versions_search_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX member_club_profile_versions_search_idx ON public.member_club_profile_versions USING gin (search_vector);


--
-- Name: member_global_role_versions_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX member_global_role_versions_lookup_idx ON public.member_global_role_versions USING btree (member_id, role, version_no DESC, created_at DESC);


--
-- Name: member_notifications_match_unique_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX member_notifications_match_unique_idx ON public.member_notifications USING btree (match_id) WHERE (match_id IS NOT NULL);


--
-- Name: member_notifications_recipient_poll_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX member_notifications_recipient_poll_idx ON public.member_notifications USING btree (recipient_member_id, club_id, seq) WHERE (acknowledged_state IS NULL);


--
-- Name: member_profile_embeddings_club_member_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX member_profile_embeddings_club_member_idx ON public.member_profile_embeddings USING btree (club_id, member_id);


--
-- Name: member_profile_embeddings_member_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX member_profile_embeddings_member_idx ON public.member_profile_embeddings USING btree (member_id);


--
-- Name: member_profile_embeddings_version_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX member_profile_embeddings_version_idx ON public.member_profile_embeddings USING btree (profile_version_id);


--
-- Name: members_state_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX members_state_idx ON public.members USING btree (state);


--
-- Name: quota_policies_club_action_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX quota_policies_club_action_unique ON public.quota_policies USING btree (club_id, action_name) WHERE (scope = 'club'::public.quota_scope);


--
-- Name: quota_policies_global_action_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX quota_policies_global_action_unique ON public.quota_policies USING btree (action_name) WHERE (scope = 'global'::public.quota_scope);


--
-- Name: signal_background_matches_delivery_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX signal_background_matches_delivery_idx ON public.signal_background_matches USING btree (target_member_id, delivered_at) WHERE (state = 'delivered'::text);


--
-- Name: signal_background_matches_expires_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX signal_background_matches_expires_idx ON public.signal_background_matches USING btree (expires_at) WHERE ((expires_at IS NOT NULL) AND (state = 'pending'::text));


--
-- Name: signal_background_matches_kind_delivery_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX signal_background_matches_kind_delivery_idx ON public.signal_background_matches USING btree (target_member_id, match_kind, delivered_at) WHERE (state = 'delivered'::text);


--
-- Name: signal_background_matches_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX signal_background_matches_pending_idx ON public.signal_background_matches USING btree (state, created_at) WHERE (state = 'pending'::text);


--
-- Name: signal_recompute_queue_claimable_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX signal_recompute_queue_claimable_idx ON public.signal_recompute_queue USING btree (queue_name, recompute_after) WHERE (claimed_at IS NULL);


--
-- Name: club_activity club_activity_notify; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER club_activity_notify AFTER INSERT ON public.club_activity FOR EACH ROW EXECUTE FUNCTION public.notify_club_activity();


--
-- Name: club_membership_state_versions club_membership_state_versions_notify; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER club_membership_state_versions_notify AFTER INSERT ON public.club_membership_state_versions FOR EACH ROW EXECUTE FUNCTION public.notify_club_membership_state_version();


--
-- Name: club_membership_state_versions club_membership_state_versions_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER club_membership_state_versions_sync AFTER INSERT ON public.club_membership_state_versions FOR EACH ROW EXECUTE FUNCTION public.sync_club_membership_state();


--
-- Name: club_memberships club_memberships_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER club_memberships_guard BEFORE UPDATE ON public.club_memberships FOR EACH ROW EXECUTE FUNCTION public.lock_club_membership_mutation();


--
-- Name: club_memberships club_memberships_require_profile_version_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER club_memberships_require_profile_version_trigger AFTER INSERT ON public.club_memberships DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.club_memberships_require_profile_version();


--
-- Name: club_versions club_versions_normalize_admission_policy; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER club_versions_normalize_admission_policy BEFORE INSERT OR UPDATE OF admission_policy ON public.club_versions FOR EACH ROW EXECUTE FUNCTION public.normalize_admission_policy();


--
-- Name: club_versions club_versions_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER club_versions_sync AFTER INSERT ON public.club_versions FOR EACH ROW EXECUTE FUNCTION public.sync_club_version_to_club();


--
-- Name: clubs clubs_normalize_admission_policy; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER clubs_normalize_admission_policy BEFORE INSERT OR UPDATE OF admission_policy ON public.clubs FOR EACH ROW EXECUTE FUNCTION public.normalize_admission_policy();


--
-- Name: clubs clubs_versioned_field_lock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER clubs_versioned_field_lock BEFORE UPDATE ON public.clubs FOR EACH ROW EXECUTE FUNCTION public.lock_club_versioned_mutation();


--
-- Name: dm_inbox_entries dm_inbox_entries_notify; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER dm_inbox_entries_notify AFTER INSERT ON public.dm_inbox_entries FOR EACH ROW EXECUTE FUNCTION public.notify_dm_inbox();


--
-- Name: member_club_profile_versions member_club_profile_versions_check_membership_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER member_club_profile_versions_check_membership_trigger BEFORE INSERT ON public.member_club_profile_versions FOR EACH ROW EXECUTE FUNCTION public.member_club_profile_versions_check_membership();


--
-- Name: member_club_profile_versions member_club_profile_versions_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER member_club_profile_versions_immutable BEFORE DELETE OR UPDATE ON public.member_club_profile_versions FOR EACH ROW EXECUTE FUNCTION public.reject_row_mutation();


--
-- Name: member_club_profile_versions member_club_profile_versions_search_vector_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER member_club_profile_versions_search_vector_insert BEFORE INSERT ON public.member_club_profile_versions FOR EACH ROW EXECUTE FUNCTION public.member_club_profile_versions_search_vector_trigger();


--
-- Name: member_notifications member_notifications_notify; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER member_notifications_notify AFTER INSERT ON public.member_notifications FOR EACH ROW EXECUTE FUNCTION public.notify_member_notification();


--
-- Name: ai_llm_usage_log ai_llm_usage_log_club_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_llm_usage_log
    ADD CONSTRAINT ai_llm_usage_log_club_fkey FOREIGN KEY (requested_club_id) REFERENCES public.clubs(id);


--
-- Name: ai_llm_usage_log ai_llm_usage_log_member_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_llm_usage_log
    ADD CONSTRAINT ai_llm_usage_log_member_fkey FOREIGN KEY (member_id) REFERENCES public.members(id);


--
-- Name: application_pow_challenges application_pow_challenges_membership_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.application_pow_challenges
    ADD CONSTRAINT application_pow_challenges_membership_fkey FOREIGN KEY (membership_id) REFERENCES public.club_memberships(id) ON DELETE CASCADE;


--
-- Name: club_activity club_activity_club_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.club_activity
    ADD CONSTRAINT club_activity_club_fkey FOREIGN KEY (club_id) REFERENCES public.clubs(id);


--
-- Name: club_activity club_activity_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.club_activity
    ADD CONSTRAINT club_activity_created_by_fkey FOREIGN KEY (created_by_member_id) REFERENCES public.members(id);


--
-- Name: club_activity_cursors club_activity_cursors_club_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.club_activity_cursors
    ADD CONSTRAINT club_activity_cursors_club_fkey FOREIGN KEY (club_id) REFERENCES public.clubs(id);


--
-- Name: club_activity_cursors club_activity_cursors_member_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.club_activity_cursors
    ADD CONSTRAINT club_activity_cursors_member_fkey FOREIGN KEY (member_id) REFERENCES public.members(id);


--
-- Name: club_activity club_activity_entity_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.club_activity
    ADD CONSTRAINT club_activity_entity_fkey FOREIGN KEY (entity_id) REFERENCES public.entities(id);


--
-- Name: club_edges club_edges_club_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.club_edges
    ADD CONSTRAINT club_edges_club_fkey FOREIGN KEY (club_id) REFERENCES public.clubs(id);


--
-- Name: club_edges club_edges_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.club_edges
    ADD CONSTRAINT club_edges_created_by_fkey FOREIGN KEY (created_by_member_id) REFERENCES public.members(id);


--
-- Name: club_edges club_edges_from_entity_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.club_edges
    ADD CONSTRAINT club_edges_from_entity_fkey FOREIGN KEY (from_entity_id) REFERENCES public.entities(id);


--
-- Name: club_edges club_edges_from_entity_version_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.club_edges
    ADD CONSTRAINT club_edges_from_entity_version_fkey FOREIGN KEY (from_entity_version_id) REFERENCES public.entity_versions(id);


--
-- Name: club_edges club_edges_from_member_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.club_edges
    ADD CONSTRAINT club_edges_from_member_fkey FOREIGN KEY (from_member_id) REFERENCES public.members(id);


--
-- Name: club_edges club_edges_to_entity_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.club_edges
    ADD CONSTRAINT club_edges_to_entity_fkey FOREIGN KEY (to_entity_id) REFERENCES public.entities(id);


--
-- Name: club_edges club_edges_to_entity_version_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.club_edges
    ADD CONSTRAINT club_edges_to_entity_version_fkey FOREIGN KEY (to_entity_version_id) REFERENCES public.entity_versions(id);


--
-- Name: club_edges club_edges_to_member_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.club_edges
    ADD CONSTRAINT club_edges_to_member_fkey FOREIGN KEY (to_member_id) REFERENCES public.members(id);


--
-- Name: club_membership_state_versions club_membership_state_versions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.club_membership_state_versions
    ADD CONSTRAINT club_membership_state_versions_created_by_fkey FOREIGN KEY (created_by_member_id) REFERENCES public.members(id);


--
-- Name: club_membership_state_versions club_membership_state_versions_membership_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.club_membership_state_versions
    ADD CONSTRAINT club_membership_state_versions_membership_fkey FOREIGN KEY (membership_id) REFERENCES public.club_memberships(id);


--
-- Name: club_membership_state_versions club_membership_state_versions_supersedes_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.club_membership_state_versions
    ADD CONSTRAINT club_membership_state_versions_supersedes_fkey FOREIGN KEY (supersedes_state_version_id) REFERENCES public.club_membership_state_versions(id);


--
-- Name: club_memberships club_memberships_club_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.club_memberships
    ADD CONSTRAINT club_memberships_club_fkey FOREIGN KEY (club_id) REFERENCES public.clubs(id);


--
-- Name: club_memberships club_memberships_comped_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.club_memberships
    ADD CONSTRAINT club_memberships_comped_by_fkey FOREIGN KEY (comped_by_member_id) REFERENCES public.members(id);


--
-- Name: club_memberships club_memberships_invitation_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.club_memberships
    ADD CONSTRAINT club_memberships_invitation_fkey FOREIGN KEY (invitation_id) REFERENCES public.invitations(id);


--
-- Name: club_memberships club_memberships_member_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.club_memberships
    ADD CONSTRAINT club_memberships_member_fkey FOREIGN KEY (member_id) REFERENCES public.members(id);


--
-- Name: club_memberships club_memberships_sponsor_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.club_memberships
    ADD CONSTRAINT club_memberships_sponsor_fkey FOREIGN KEY (sponsor_member_id) REFERENCES public.members(id);


--
-- Name: club_subscriptions club_subscriptions_membership_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.club_subscriptions
    ADD CONSTRAINT club_subscriptions_membership_fkey FOREIGN KEY (membership_id) REFERENCES public.club_memberships(id);


--
-- Name: club_subscriptions club_subscriptions_payer_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.club_subscriptions
    ADD CONSTRAINT club_subscriptions_payer_fkey FOREIGN KEY (payer_member_id) REFERENCES public.members(id);


--
-- Name: club_versions club_versions_club_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.club_versions
    ADD CONSTRAINT club_versions_club_fkey FOREIGN KEY (club_id) REFERENCES public.clubs(id);


--
-- Name: club_versions club_versions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.club_versions
    ADD CONSTRAINT club_versions_created_by_fkey FOREIGN KEY (created_by_member_id) REFERENCES public.members(id);


--
-- Name: club_versions club_versions_owner_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.club_versions
    ADD CONSTRAINT club_versions_owner_fkey FOREIGN KEY (owner_member_id) REFERENCES public.members(id);


--
-- Name: club_versions club_versions_supersedes_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.club_versions
    ADD CONSTRAINT club_versions_supersedes_fkey FOREIGN KEY (supersedes_version_id) REFERENCES public.club_versions(id);


--
-- Name: clubs clubs_owner_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clubs
    ADD CONSTRAINT clubs_owner_fkey FOREIGN KEY (owner_member_id) REFERENCES public.members(id);


--
-- Name: content_threads content_threads_club_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_threads
    ADD CONSTRAINT content_threads_club_fkey FOREIGN KEY (club_id) REFERENCES public.clubs(id);


--
-- Name: content_threads content_threads_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_threads
    ADD CONSTRAINT content_threads_created_by_fkey FOREIGN KEY (created_by_member_id) REFERENCES public.members(id);


--
-- Name: dm_inbox_entries dm_inbox_entries_message_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dm_inbox_entries
    ADD CONSTRAINT dm_inbox_entries_message_fkey FOREIGN KEY (message_id) REFERENCES public.dm_messages(id);


--
-- Name: dm_inbox_entries dm_inbox_entries_recipient_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dm_inbox_entries
    ADD CONSTRAINT dm_inbox_entries_recipient_fkey FOREIGN KEY (recipient_member_id) REFERENCES public.members(id);


--
-- Name: dm_inbox_entries dm_inbox_entries_thread_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dm_inbox_entries
    ADD CONSTRAINT dm_inbox_entries_thread_fkey FOREIGN KEY (thread_id) REFERENCES public.dm_threads(id);


--
-- Name: dm_message_mentions dm_message_mentions_member_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dm_message_mentions
    ADD CONSTRAINT dm_message_mentions_member_fkey FOREIGN KEY (mentioned_member_id) REFERENCES public.members(id);


--
-- Name: dm_message_mentions dm_message_mentions_message_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dm_message_mentions
    ADD CONSTRAINT dm_message_mentions_message_fkey FOREIGN KEY (message_id) REFERENCES public.dm_messages(id);


--
-- Name: dm_message_removals dm_message_removals_message_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dm_message_removals
    ADD CONSTRAINT dm_message_removals_message_fkey FOREIGN KEY (message_id) REFERENCES public.dm_messages(id);


--
-- Name: dm_message_removals dm_message_removals_removed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dm_message_removals
    ADD CONSTRAINT dm_message_removals_removed_by_fkey FOREIGN KEY (removed_by_member_id) REFERENCES public.members(id);


--
-- Name: dm_messages dm_messages_reply_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dm_messages
    ADD CONSTRAINT dm_messages_reply_fkey FOREIGN KEY (in_reply_to_message_id) REFERENCES public.dm_messages(id);


--
-- Name: dm_messages dm_messages_sender_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dm_messages
    ADD CONSTRAINT dm_messages_sender_fkey FOREIGN KEY (sender_member_id) REFERENCES public.members(id);


--
-- Name: dm_messages dm_messages_thread_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dm_messages
    ADD CONSTRAINT dm_messages_thread_fkey FOREIGN KEY (thread_id) REFERENCES public.dm_threads(id);


--
-- Name: dm_thread_participants dm_thread_participants_member_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dm_thread_participants
    ADD CONSTRAINT dm_thread_participants_member_fkey FOREIGN KEY (member_id) REFERENCES public.members(id);


--
-- Name: dm_thread_participants dm_thread_participants_thread_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dm_thread_participants
    ADD CONSTRAINT dm_thread_participants_thread_fkey FOREIGN KEY (thread_id) REFERENCES public.dm_threads(id);


--
-- Name: dm_threads dm_threads_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dm_threads
    ADD CONSTRAINT dm_threads_created_by_fkey FOREIGN KEY (created_by_member_id) REFERENCES public.members(id);


--
-- Name: dm_threads dm_threads_member_a_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dm_threads
    ADD CONSTRAINT dm_threads_member_a_fkey FOREIGN KEY (member_a_id) REFERENCES public.members(id);


--
-- Name: dm_threads dm_threads_member_b_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dm_threads
    ADD CONSTRAINT dm_threads_member_b_fkey FOREIGN KEY (member_b_id) REFERENCES public.members(id);


--
-- Name: dm_threads dm_threads_subject_entity_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dm_threads
    ADD CONSTRAINT dm_threads_subject_entity_fkey FOREIGN KEY (subject_entity_id) REFERENCES public.entities(id);


--
-- Name: entities entities_author_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entities
    ADD CONSTRAINT entities_author_fkey FOREIGN KEY (author_member_id) REFERENCES public.members(id);


--
-- Name: entities entities_club_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entities
    ADD CONSTRAINT entities_club_fkey FOREIGN KEY (club_id) REFERENCES public.clubs(id);


--
-- Name: entities entities_content_thread_same_club_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entities
    ADD CONSTRAINT entities_content_thread_same_club_fkey FOREIGN KEY (content_thread_id, club_id) REFERENCES public.content_threads(id, club_id);

--
-- Name: entity_embeddings entity_embeddings_entity_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_embeddings
    ADD CONSTRAINT entity_embeddings_entity_fkey FOREIGN KEY (entity_id) REFERENCES public.entities(id);


--
-- Name: entity_embeddings entity_embeddings_version_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_embeddings
    ADD CONSTRAINT entity_embeddings_version_fkey FOREIGN KEY (entity_version_id) REFERENCES public.entity_versions(id) ON DELETE CASCADE;


--
-- Name: entity_version_mentions entity_version_mentions_member_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_version_mentions
    ADD CONSTRAINT entity_version_mentions_member_fkey FOREIGN KEY (mentioned_member_id) REFERENCES public.members(id);


--
-- Name: entity_version_mentions entity_version_mentions_version_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_version_mentions
    ADD CONSTRAINT entity_version_mentions_version_fkey FOREIGN KEY (entity_version_id) REFERENCES public.entity_versions(id);


--
-- Name: entity_versions entity_versions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_versions
    ADD CONSTRAINT entity_versions_created_by_fkey FOREIGN KEY (created_by_member_id) REFERENCES public.members(id);


--
-- Name: entity_versions entity_versions_entity_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_versions
    ADD CONSTRAINT entity_versions_entity_fkey FOREIGN KEY (entity_id) REFERENCES public.entities(id);


--
-- Name: entity_versions entity_versions_supersedes_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_versions
    ADD CONSTRAINT entity_versions_supersedes_fkey FOREIGN KEY (supersedes_version_id) REFERENCES public.entity_versions(id);


--
-- Name: event_rsvps event_rsvps_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_rsvps
    ADD CONSTRAINT event_rsvps_created_by_fkey FOREIGN KEY (created_by_member_id) REFERENCES public.members(id);


--
-- Name: event_rsvps event_rsvps_event_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_rsvps
    ADD CONSTRAINT event_rsvps_event_fkey FOREIGN KEY (event_entity_id) REFERENCES public.entities(id);


--
-- Name: event_rsvps event_rsvps_membership_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_rsvps
    ADD CONSTRAINT event_rsvps_membership_fkey FOREIGN KEY (membership_id) REFERENCES public.club_memberships(id);


--
-- Name: event_rsvps event_rsvps_supersedes_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_rsvps
    ADD CONSTRAINT event_rsvps_supersedes_fkey FOREIGN KEY (supersedes_rsvp_id) REFERENCES public.event_rsvps(id);


--
-- Name: event_version_details event_version_details_version_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_version_details
    ADD CONSTRAINT event_version_details_version_fkey FOREIGN KEY (entity_version_id) REFERENCES public.entity_versions(id);


--
-- Name: invitations invitations_club_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_club_fkey FOREIGN KEY (club_id) REFERENCES public.clubs(id);


--
-- Name: invitations invitations_sponsor_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_sponsor_fkey FOREIGN KEY (sponsor_member_id) REFERENCES public.members(id);


--
-- Name: invitations invitations_used_membership_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_used_membership_fkey FOREIGN KEY (used_membership_id) REFERENCES public.club_memberships(id);


--
-- Name: member_bearer_tokens member_bearer_tokens_member_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_bearer_tokens
    ADD CONSTRAINT member_bearer_tokens_member_fkey FOREIGN KEY (member_id) REFERENCES public.members(id);


--
-- Name: member_club_profile_versions member_club_profile_versions_club_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_club_profile_versions
    ADD CONSTRAINT member_club_profile_versions_club_fkey FOREIGN KEY (club_id) REFERENCES public.clubs(id);


--
-- Name: member_club_profile_versions member_club_profile_versions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_club_profile_versions
    ADD CONSTRAINT member_club_profile_versions_created_by_fkey FOREIGN KEY (created_by_member_id) REFERENCES public.members(id);


--
-- Name: member_club_profile_versions member_club_profile_versions_member_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_club_profile_versions
    ADD CONSTRAINT member_club_profile_versions_member_fkey FOREIGN KEY (member_id) REFERENCES public.members(id);


--
-- Name: member_club_profile_versions member_club_profile_versions_membership_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_club_profile_versions
    ADD CONSTRAINT member_club_profile_versions_membership_fkey FOREIGN KEY (membership_id) REFERENCES public.club_memberships(id);


--
-- Name: member_global_role_versions member_global_role_versions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_global_role_versions
    ADD CONSTRAINT member_global_role_versions_created_by_fkey FOREIGN KEY (created_by_member_id) REFERENCES public.members(id);


--
-- Name: member_global_role_versions member_global_role_versions_member_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_global_role_versions
    ADD CONSTRAINT member_global_role_versions_member_fkey FOREIGN KEY (member_id) REFERENCES public.members(id);


--
-- Name: member_global_role_versions member_global_role_versions_supersedes_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_global_role_versions
    ADD CONSTRAINT member_global_role_versions_supersedes_fkey FOREIGN KEY (supersedes_role_version_id) REFERENCES public.member_global_role_versions(id);


--
-- Name: member_notifications member_notifications_club_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_notifications
    ADD CONSTRAINT member_notifications_club_fkey FOREIGN KEY (club_id) REFERENCES public.clubs(id);


--
-- Name: member_notifications member_notifications_entity_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_notifications
    ADD CONSTRAINT member_notifications_entity_fkey FOREIGN KEY (entity_id) REFERENCES public.entities(id);


--
-- Name: member_notifications member_notifications_recipient_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_notifications
    ADD CONSTRAINT member_notifications_recipient_fkey FOREIGN KEY (recipient_member_id) REFERENCES public.members(id);


--
-- Name: member_private_contacts member_private_contacts_member_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_private_contacts
    ADD CONSTRAINT member_private_contacts_member_fkey FOREIGN KEY (member_id) REFERENCES public.members(id);


--
-- Name: member_profile_embeddings member_profile_embeddings_club_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_profile_embeddings
    ADD CONSTRAINT member_profile_embeddings_club_fkey FOREIGN KEY (club_id) REFERENCES public.clubs(id);


--
-- Name: member_profile_embeddings member_profile_embeddings_member_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_profile_embeddings
    ADD CONSTRAINT member_profile_embeddings_member_fkey FOREIGN KEY (member_id) REFERENCES public.members(id);


--
-- Name: member_profile_embeddings member_profile_embeddings_version_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member_profile_embeddings
    ADD CONSTRAINT member_profile_embeddings_version_fkey FOREIGN KEY (profile_version_id) REFERENCES public.member_club_profile_versions(id) ON DELETE CASCADE;


--
-- Name: quota_policies quota_policies_club_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quota_policies
    ADD CONSTRAINT quota_policies_club_fkey FOREIGN KEY (club_id) REFERENCES public.clubs(id);


--
-- Name: signal_background_matches signal_background_matches_club_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signal_background_matches
    ADD CONSTRAINT signal_background_matches_club_fkey FOREIGN KEY (club_id) REFERENCES public.clubs(id);


--
-- Name: signal_background_matches signal_background_matches_signal_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signal_background_matches
    ADD CONSTRAINT signal_background_matches_signal_fkey FOREIGN KEY (signal_id) REFERENCES public.member_notifications(id);


--
-- Name: signal_background_matches signal_background_matches_target_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signal_background_matches
    ADD CONSTRAINT signal_background_matches_target_fkey FOREIGN KEY (target_member_id) REFERENCES public.members(id);


--
-- Name: signal_recompute_queue signal_recompute_queue_club_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signal_recompute_queue
    ADD CONSTRAINT signal_recompute_queue_club_fkey FOREIGN KEY (club_id) REFERENCES public.clubs(id);


--
-- Name: signal_recompute_queue signal_recompute_queue_member_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signal_recompute_queue
    ADD CONSTRAINT signal_recompute_queue_member_fkey FOREIGN KEY (member_id) REFERENCES public.members(id);


--

-- ============================================================
-- Seed data applied by shipped migrations
-- ============================================================

-- pg_dump sets search_path to '' at the top of this file. Restore it so
-- unqualified type references in default-value functions (e.g. new_id() →
-- short_id) resolve correctly during INSERT.
SET search_path TO public;

-- From 009_global_content_quota_default.sql
INSERT INTO public.quota_policies (scope, club_id, action_name, max_per_day)
SELECT 'global', NULL, 'content.create', 50
WHERE NOT EXISTS (
  SELECT 1 FROM public.quota_policies WHERE scope = 'global' AND action_name = 'content.create'
);

-- ============================================================
-- Schema migration ledger
-- ============================================================

INSERT INTO public.schema_migrations (filename) VALUES
  ('0001_init.sql'),
  ('003_test_canary.sql'),
  ('004_club_scoped_profiles.sql'),
  ('005_unified_threaded_public_content.sql'),
  ('006_mentions.sql'),
  ('007_member_notifications_stream.sql'),
  ('008_unified_club_join.sql'),
  ('009_global_content_quota_default.sql'),
  ('010_rename_application_generated_profile_source.sql'),
  ('011_delete_handles.sql'),
  ('012_kill_untyped_json_surface.sql'),
  ('013_comp_owners_and_remove_clubadmin_bypass.sql'),
  ('014_content_gate_redesign.sql');
