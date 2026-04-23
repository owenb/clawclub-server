--
-- PostgreSQL database dump
--

\restrict LMbNRhsTO7aZ6DUkSfA7AnUm6QpxisxIcFMDMZr1tNmZuIfgaUDQwOj3YeZrahe

-- Dumped from database version 18.3 (Homebrew)
-- Dumped by pg_dump version 18.3 (Homebrew)

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
SET row_security = off;

--
-- Name: producer_contract; Type: SCHEMA; Schema: -; Owner: clawclub_app
--

CREATE SCHEMA producer_contract;


ALTER SCHEMA producer_contract OWNER TO clawclub_app;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: postgres
--

-- *not* creating schema, since initdb creates it


ALTER SCHEMA public OWNER TO postgres;

--
-- Name: vector; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;


--
-- Name: EXTENSION vector; Type: COMMENT; Schema: -; Owner: 
--

COMMENT ON EXTENSION vector IS 'vector data type and ivfflat and hnsw access methods';


--
-- Name: assignment_state; Type: TYPE; Schema: public; Owner: clawclub_app
--

CREATE TYPE public.assignment_state AS ENUM (
    'active',
    'revoked'
);


ALTER TYPE public.assignment_state OWNER TO clawclub_app;

--
-- Name: billing_interval; Type: TYPE; Schema: public; Owner: clawclub_app
--

CREATE TYPE public.billing_interval AS ENUM (
    'month',
    'year',
    'manual'
);


ALTER TYPE public.billing_interval OWNER TO clawclub_app;

--
-- Name: club_activity_audience; Type: TYPE; Schema: public; Owner: clawclub_app
--

CREATE TYPE public.club_activity_audience AS ENUM (
    'members',
    'clubadmins',
    'owners'
);


ALTER TYPE public.club_activity_audience OWNER TO clawclub_app;

--
-- Name: content_gate_status; Type: TYPE; Schema: public; Owner: clawclub_app
--

CREATE TYPE public.content_gate_status AS ENUM (
    'passed',
    'rejected_illegal',
    'rejected_quality',
    'rejected_malformed',
    'skipped',
    'failed'
);


ALTER TYPE public.content_gate_status OWNER TO clawclub_app;

--
-- Name: content_kind; Type: TYPE; Schema: public; Owner: clawclub_app
--

CREATE TYPE public.content_kind AS ENUM (
    'post',
    'opportunity',
    'service',
    'ask',
    'gift',
    'event'
);


ALTER TYPE public.content_kind OWNER TO clawclub_app;

--
-- Name: content_state; Type: TYPE; Schema: public; Owner: clawclub_app
--

CREATE TYPE public.content_state AS ENUM (
    'draft',
    'published',
    'removed'
);


ALTER TYPE public.content_state OWNER TO clawclub_app;

--
-- Name: edge_kind; Type: TYPE; Schema: public; Owner: clawclub_app
--

CREATE TYPE public.edge_kind AS ENUM (
    'vouched_for',
    'about',
    'related_to',
    'mentions'
);


ALTER TYPE public.edge_kind OWNER TO clawclub_app;

--
-- Name: global_role; Type: TYPE; Schema: public; Owner: clawclub_app
--

CREATE TYPE public.global_role AS ENUM (
    'superadmin'
);


ALTER TYPE public.global_role OWNER TO clawclub_app;

--
-- Name: member_state; Type: TYPE; Schema: public; Owner: clawclub_app
--

CREATE TYPE public.member_state AS ENUM (
    'pending',
    'active',
    'suspended',
    'deleted',
    'banned'
);


ALTER TYPE public.member_state OWNER TO clawclub_app;

--
-- Name: membership_role; Type: TYPE; Schema: public; Owner: clawclub_app
--

CREATE TYPE public.membership_role AS ENUM (
    'clubadmin',
    'member'
);


ALTER TYPE public.membership_role OWNER TO clawclub_app;

--
-- Name: membership_state; Type: TYPE; Schema: public; Owner: clawclub_app
--

CREATE TYPE public.membership_state AS ENUM (
    'active',
    'cancelled',
    'removed',
    'banned'
);


ALTER TYPE public.membership_state OWNER TO clawclub_app;

--
-- Name: message_role; Type: TYPE; Schema: public; Owner: clawclub_app
--

CREATE TYPE public.message_role AS ENUM (
    'member',
    'agent',
    'system'
);


ALTER TYPE public.message_role OWNER TO clawclub_app;

--
-- Name: rsvp_state; Type: TYPE; Schema: public; Owner: clawclub_app
--

CREATE TYPE public.rsvp_state AS ENUM (
    'yes',
    'maybe',
    'no',
    'waitlist',
    'cancelled'
);


ALTER TYPE public.rsvp_state OWNER TO clawclub_app;

--
-- Name: short_id; Type: DOMAIN; Schema: public; Owner: clawclub_app
--

CREATE DOMAIN public.short_id AS text
	CONSTRAINT short_id_check CHECK ((VALUE ~ '^[23456789abcdefghjkmnpqrstuvwxyz]{12}$'::text));


ALTER DOMAIN public.short_id OWNER TO clawclub_app;

--
-- Name: subscription_status; Type: TYPE; Schema: public; Owner: clawclub_app
--

CREATE TYPE public.subscription_status AS ENUM (
    'trialing',
    'active',
    'past_due',
    'paused',
    'canceled',
    'ended'
);


ALTER TYPE public.subscription_status OWNER TO clawclub_app;

--
-- Name: thread_kind; Type: TYPE; Schema: public; Owner: clawclub_app
--

CREATE TYPE public.thread_kind AS ENUM (
    'direct'
);


ALTER TYPE public.thread_kind OWNER TO clawclub_app;

--
-- Name: find_asks_matching_vector(public.vector, public.short_id, public.short_id, integer, public.short_id); Type: FUNCTION; Schema: producer_contract; Owner: clawclub_app
--

CREATE FUNCTION producer_contract.find_asks_matching_vector(input_vector public.vector, offer_content_id public.short_id, input_club_id public.short_id, max_rows integer, exclude_author_id public.short_id DEFAULT NULL::text) RETURNS TABLE(content_id public.short_id, content_version_id public.short_id, author_member_id public.short_id, distance double precision)
    LANGUAGE sql STABLE
    AS $$
  select cce.content_id,
         cpc.current_version_id as content_version_id,
         cpc.author_member_id,
         min(cce.embedding <=> input_vector)::double precision as distance
    from producer_contract.current_content_embeddings cce
    join producer_contract.current_published_contents cpc
      on cpc.content_id = cce.content_id
   where cpc.club_id = input_club_id
     and cpc.kind = 'ask'
     and cpc.content_id <> offer_content_id
     and cpc.open_loop = true
     and (cpc.expires_at is null or cpc.expires_at > now())
     and (exclude_author_id is null or cpc.author_member_id <> exclude_author_id)
   group by cce.content_id, cpc.current_version_id, cpc.author_member_id
   order by distance asc
   limit greatest(0, least(max_rows, 1000))
$$;


ALTER FUNCTION producer_contract.find_asks_matching_vector(input_vector public.vector, offer_content_id public.short_id, input_club_id public.short_id, max_rows integer, exclude_author_id public.short_id) OWNER TO clawclub_app;

--
-- Name: find_existing_thread_pairs(text[], text[]); Type: FUNCTION; Schema: producer_contract; Owner: clawclub_app
--

CREATE FUNCTION producer_contract.find_existing_thread_pairs(member_a_ids text[], member_b_ids text[]) RETURNS TABLE(member_a_id public.short_id, member_b_id public.short_id)
    LANGUAGE sql STABLE
    AS $$
  select odt.member_a_id,
         odt.member_b_id
    from producer_contract.open_dm_threads odt
   where (odt.member_a_id, odt.member_b_id) in (
       select *
         from unnest(member_a_ids, member_b_ids)
     )
$$;


ALTER FUNCTION producer_contract.find_existing_thread_pairs(member_a_ids text[], member_b_ids text[]) OWNER TO clawclub_app;

--
-- Name: find_members_matching_vector(public.vector, public.short_id, public.short_id, integer); Type: FUNCTION; Schema: producer_contract; Owner: clawclub_app
--

CREATE FUNCTION producer_contract.find_members_matching_vector(input_vector public.vector, input_club_id public.short_id, exclude_member_id public.short_id, max_rows integer) RETURNS TABLE(member_id public.short_id, distance double precision)
    LANGUAGE sql STABLE
    AS $$
  select cmpe.member_id,
         min(cmpe.embedding <=> input_vector)::double precision as distance
    from producer_contract.current_member_profile_embeddings cmpe
    join producer_contract.accessible_memberships am
      on am.member_id = cmpe.member_id
     and am.club_id = input_club_id
   where cmpe.club_id = input_club_id
     and cmpe.member_id <> exclude_member_id
   group by cmpe.member_id
   order by distance asc
   limit greatest(0, least(max_rows, 1000))
$$;


ALTER FUNCTION producer_contract.find_members_matching_vector(input_vector public.vector, input_club_id public.short_id, exclude_member_id public.short_id, max_rows integer) OWNER TO clawclub_app;

--
-- Name: find_similar_members(public.short_id, public.short_id, integer); Type: FUNCTION; Schema: producer_contract; Owner: clawclub_app
--

CREATE FUNCTION producer_contract.find_similar_members(input_member_id public.short_id, input_club_id public.short_id, max_rows integer) RETURNS TABLE(member_id public.short_id, distance double precision)
    LANGUAGE sql STABLE
    AS $$
  with source_vector as (
    select cmpe.embedding
      from producer_contract.current_member_profile_embeddings cmpe
     where cmpe.member_id = input_member_id
       and cmpe.club_id = input_club_id
     limit 1
  )
  select cmpe.member_id,
         min(cmpe.embedding <=> source_vector.embedding)::double precision as distance
    from source_vector
    join producer_contract.current_member_profile_embeddings cmpe
      on cmpe.club_id = input_club_id
    join producer_contract.accessible_memberships am
      on am.member_id = cmpe.member_id
     and am.club_id = input_club_id
   where cmpe.member_id <> input_member_id
   group by cmpe.member_id
   order by distance asc
   limit greatest(0, least(max_rows, 1000))
$$;


ALTER FUNCTION producer_contract.find_similar_members(input_member_id public.short_id, input_club_id public.short_id, max_rows integer) OWNER TO clawclub_app;

--
-- Name: load_current_content_vector(public.short_id); Type: FUNCTION; Schema: producer_contract; Owner: clawclub_app
--

CREATE FUNCTION producer_contract.load_current_content_vector(input_content_id public.short_id) RETURNS text
    LANGUAGE sql STABLE
    AS $$
  select cce.embedding::text
    from producer_contract.current_content_embeddings cce
   where cce.content_id = input_content_id
   limit 1
$$;


ALTER FUNCTION producer_contract.load_current_content_vector(input_content_id public.short_id) OWNER TO clawclub_app;

--
-- Name: members_accessible_since(timestamp with time zone); Type: FUNCTION; Schema: producer_contract; Owner: clawclub_app
--

CREATE FUNCTION producer_contract.members_accessible_since(since_at timestamp with time zone) RETURNS TABLE(member_id public.short_id, club_id public.short_id, occurred_at timestamp with time zone, source_kind text)
    LANGUAGE sql STABLE
    AS $$
  select mae.member_id,
         mae.club_id,
         mae.occurred_at,
         mae.source_kind
    from producer_contract.membership_access_events mae
   where mae.occurred_at > since_at
$$;


ALTER FUNCTION producer_contract.members_accessible_since(since_at timestamp with time zone) OWNER TO clawclub_app;

--
-- Name: tail_activity(bigint, integer, text); Type: FUNCTION; Schema: producer_contract; Owner: clawclub_app
--

CREATE FUNCTION producer_contract.tail_activity(after_seq bigint, max_rows integer, only_topic text DEFAULT NULL::text) RETURNS TABLE(seq bigint, club_id public.short_id, content_id public.short_id, topic text, created_by_member_id public.short_id, created_at timestamp with time zone)
    LANGUAGE sql STABLE
    AS $$
  select ae.seq,
         ae.club_id,
         ae.content_id,
         ae.topic,
         ae.created_by_member_id,
         ae.created_at
    from producer_contract.activity_events ae
   where ae.seq > after_seq
     and (only_topic is null or ae.topic = only_topic)
   order by ae.seq asc
   limit greatest(0, least(max_rows, 1000))
$$;


ALTER FUNCTION producer_contract.tail_activity(after_seq bigint, max_rows integer, only_topic text) OWNER TO clawclub_app;

--
-- Name: bump_platform_stats_applications(); Type: FUNCTION; Schema: public; Owner: clawclub_app
--

CREATE FUNCTION public.bump_platform_stats_applications() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  pending_delta integer := 0;
begin
  if tg_op = 'INSERT' then
    pending_delta := case when new.phase in ('awaiting_review', 'revision_required') then 1 else 0 end;
  elsif tg_op = 'DELETE' then
    pending_delta := case when old.phase in ('awaiting_review', 'revision_required') then -1 else 0 end;
  else
    pending_delta := case
      when old.phase in ('awaiting_review', 'revision_required')
        and new.phase not in ('awaiting_review', 'revision_required') then -1
      when old.phase not in ('awaiting_review', 'revision_required')
        and new.phase in ('awaiting_review', 'revision_required') then 1
      else 0
    end;
  end if;

  update public.platform_stats
  set pending_applications = pending_applications + pending_delta,
      updated_at = now()
  where singleton = true;

  return null;
end;
$$;


ALTER FUNCTION public.bump_platform_stats_applications() OWNER TO clawclub_app;

--
-- Name: bump_platform_stats_clubs(); Type: FUNCTION; Schema: public; Owner: clawclub_app
--

CREATE FUNCTION public.bump_platform_stats_clubs() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  active_delta integer := 0;
begin
  if tg_op = 'INSERT' then
    active_delta := case when new.archived_at is null then 1 else 0 end;
  elsif tg_op = 'DELETE' then
    active_delta := case when old.archived_at is null then -1 else 0 end;
  else
    active_delta := case
      when old.archived_at is null and new.archived_at is not null then -1
      when old.archived_at is not null and new.archived_at is null then 1
      else 0
    end;
  end if;

  update public.platform_stats
  set active_clubs = active_clubs + active_delta,
      updated_at = now()
  where singleton = true;

  return null;
end;
$$;


ALTER FUNCTION public.bump_platform_stats_clubs() OWNER TO clawclub_app;

--
-- Name: bump_platform_stats_contents(); Type: FUNCTION; Schema: public; Owner: clawclub_app
--

CREATE FUNCTION public.bump_platform_stats_contents() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  live_delta integer := 0;
begin
  if tg_op = 'INSERT' then
    live_delta := case when new.deleted_at is null then 1 else 0 end;
  elsif tg_op = 'DELETE' then
    live_delta := case when old.deleted_at is null then -1 else 0 end;
  else
    live_delta := case
      when old.deleted_at is null and new.deleted_at is not null then -1
      when old.deleted_at is not null and new.deleted_at is null then 1
      else 0
    end;
  end if;

  update public.platform_stats
  set live_contents = live_contents + live_delta,
      updated_at = now()
  where singleton = true;

  return null;
end;
$$;


ALTER FUNCTION public.bump_platform_stats_contents() OWNER TO clawclub_app;

--
-- Name: bump_platform_stats_members(); Type: FUNCTION; Schema: public; Owner: clawclub_app
--

CREATE FUNCTION public.bump_platform_stats_members() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  total_delta integer := 0;
  active_delta integer := 0;
begin
  if tg_op = 'INSERT' then
    total_delta := 1;
    active_delta := case when new.state = 'active' then 1 else 0 end;
  elsif tg_op = 'DELETE' then
    total_delta := -1;
    active_delta := case when old.state = 'active' then -1 else 0 end;
  else
    active_delta := case
      when old.state = 'active' and new.state <> 'active' then -1
      when old.state <> 'active' and new.state = 'active' then 1
      else 0
    end;
  end if;

  update public.platform_stats
  set total_members = total_members + total_delta,
      active_members = active_members + active_delta,
      updated_at = now()
  where singleton = true;

  return null;
end;
$$;


ALTER FUNCTION public.bump_platform_stats_members() OWNER TO clawclub_app;

--
-- Name: bump_platform_stats_messages(); Type: FUNCTION; Schema: public; Owner: clawclub_app
--

CREATE FUNCTION public.bump_platform_stats_messages() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  total_delta integer := case when tg_op = 'INSERT' then 1 else -1 end;
begin
  update public.platform_stats
  set total_messages = total_messages + total_delta,
      updated_at = now()
  where singleton = true;

  return null;
end;
$$;


ALTER FUNCTION public.bump_platform_stats_messages() OWNER TO clawclub_app;

--
-- Name: club_memberships_require_profile_version(); Type: FUNCTION; Schema: public; Owner: clawclub_app
--

CREATE FUNCTION public.club_memberships_require_profile_version() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.status NOT IN ('active', 'cancelled') THEN
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


ALTER FUNCTION public.club_memberships_require_profile_version() OWNER TO clawclub_app;

--
-- Name: lock_club_membership_mutation(); Type: FUNCTION; Schema: public; Owner: clawclub_app
--

CREATE FUNCTION public.lock_club_membership_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  allow_state_sync boolean := current_setting('app.allow_membership_state_sync', true) = '1';
  allow_role_sync boolean := current_setting('app.allow_membership_role_sync', true) = '1';
  allow_member_reference_detach boolean := current_setting('app.allow_member_reference_detach', true) = '1';
begin
  if new.club_id is distinct from old.club_id then
    raise exception 'club_memberships.club_id is immutable';
  end if;
  if new.member_id is distinct from old.member_id then
    raise exception 'club_memberships.member_id is immutable';
  end if;
  if new.sponsor_member_id is distinct from old.sponsor_member_id then
    if allow_member_reference_detach
      and old.sponsor_member_id is not null
      and new.sponsor_member_id is null then
      null;
    else
      raise exception 'club_memberships.sponsor_member_id is immutable';
    end if;
  end if;
  if new.invitation_id is distinct from old.invitation_id then
    raise exception 'club_memberships.invitation_id is immutable';
  end if;
  if new.joined_at is distinct from old.joined_at then
    if old.joined_at is null and new.joined_at is not null then
      null;
    else
      raise exception 'club_memberships.joined_at is immutable except for first active transition';
    end if;
  end if;
  if new.role is distinct from old.role and not allow_role_sync then
    raise exception 'club_memberships.role must change via explicit role sync';
  end if;
  if new.metadata is distinct from old.metadata then
    raise exception 'club_memberships.metadata is immutable';
  end if;
  if new.status is distinct from old.status and not allow_state_sync then
    raise exception 'club_memberships.status must change via club_membership_state_versions';
  end if;
  if new.left_at is distinct from old.left_at and not allow_state_sync then
    raise exception 'club_memberships.left_at must change via club_membership_state_versions';
  end if;
  return new;
end;
$$;


ALTER FUNCTION public.lock_club_membership_mutation() OWNER TO clawclub_app;

--
-- Name: lock_club_versioned_mutation(); Type: FUNCTION; Schema: public; Owner: clawclub_app
--

CREATE FUNCTION public.lock_club_versioned_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
    if tg_op <> 'UPDATE' then return new; end if;
    if coalesce(current_setting('app.allow_club_version_sync', true), '') = '1' then
        return new;
    end if;
    if new.owner_member_id is distinct from old.owner_member_id then
        raise exception 'clubs.owner_member_id must change via club_versions';
    end if;
    if new.name is distinct from old.name then
        raise exception 'clubs.name must change via club_versions';
    end if;
    if new.summary is distinct from old.summary then
        raise exception 'clubs.summary must change via club_versions';
    end if;
    if new.admission_policy is distinct from old.admission_policy then
        raise exception 'clubs.admission_policy must change via club_versions';
    end if;
    if new.uses_free_allowance is distinct from old.uses_free_allowance then
        raise exception 'clubs.uses_free_allowance must change via club_versions';
    end if;
    if new.member_cap is distinct from old.member_cap then
        raise exception 'clubs.member_cap must change via club_versions';
    end if;
    if new.membership_price_amount is distinct from old.membership_price_amount then
        raise exception 'clubs.membership_price_amount must change via club_versions';
    end if;
    if new.membership_price_currency is distinct from old.membership_price_currency then
        raise exception 'clubs.membership_price_currency must change via club_versions';
    end if;
    return new;
end;
$$;


ALTER FUNCTION public.lock_club_versioned_mutation() OWNER TO clawclub_app;

--
-- Name: member_club_profile_versions_check_membership(); Type: FUNCTION; Schema: public; Owner: clawclub_app
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


ALTER FUNCTION public.member_club_profile_versions_check_membership() OWNER TO clawclub_app;

--
-- Name: member_club_profile_versions_search_vector_trigger(); Type: FUNCTION; Schema: public; Owner: clawclub_app
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


ALTER FUNCTION public.member_club_profile_versions_search_vector_trigger() OWNER TO clawclub_app;

--
-- Name: new_id(); Type: FUNCTION; Schema: public; Owner: clawclub_app
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

  return output::public.short_id;
end;
$$;


ALTER FUNCTION public.new_id() OWNER TO clawclub_app;

--
-- Name: normalize_admission_policy(); Type: FUNCTION; Schema: public; Owner: clawclub_app
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


ALTER FUNCTION public.normalize_admission_policy() OWNER TO clawclub_app;

--
-- Name: notify_club_activity(); Type: FUNCTION; Schema: public; Owner: clawclub_app
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


ALTER FUNCTION public.notify_club_activity() OWNER TO clawclub_app;

--
-- Name: notify_dm_inbox(); Type: FUNCTION; Schema: public; Owner: clawclub_app
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


ALTER FUNCTION public.notify_dm_inbox() OWNER TO clawclub_app;

--
-- Name: notify_member_notification(); Type: FUNCTION; Schema: public; Owner: clawclub_app
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


ALTER FUNCTION public.notify_member_notification() OWNER TO clawclub_app;

--
-- Name: reject_row_mutation(); Type: FUNCTION; Schema: public; Owner: clawclub_app
--

CREATE FUNCTION public.reject_row_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  allow text;
  allow_member_reference_detach boolean := current_setting('app.allow_member_reference_detach', true) = '1';
begin
  if tg_op = 'DELETE' then
    allow := coalesce(
      current_setting('app.allow_delete_' || tg_table_name, true),
      '0'
    );
    if allow = '1' then
      return old;
    end if;
  end if;

  if tg_op = 'UPDATE'
    and allow_member_reference_detach
    and tg_table_name in (
      'club_application_revisions',
      'club_membership_state_versions',
      'content_versions',
      'member_club_profile_versions'
    )
    and old.created_by_member_id is not null
    and new.created_by_member_id is null
    and (to_jsonb(new) - 'created_by_member_id') = (to_jsonb(old) - 'created_by_member_id') then
    return new;
  end if;

  raise exception 'Rows in %.% are immutable',
    quote_ident(tg_table_schema), quote_ident(tg_table_name);
end;
$$;


ALTER FUNCTION public.reject_row_mutation() OWNER TO clawclub_app;

--
-- Name: sync_club_membership_state(); Type: FUNCTION; Schema: public; Owner: clawclub_app
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
           WHEN NEW.status IN ('removed', 'banned')
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


ALTER FUNCTION public.sync_club_membership_state() OWNER TO clawclub_app;

--
-- Name: sync_club_version_to_club(); Type: FUNCTION; Schema: public; Owner: clawclub_app
--

CREATE FUNCTION public.sync_club_version_to_club() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
    perform set_config('app.allow_club_version_sync', '1', true);
    update clubs c set
        owner_member_id           = new.owner_member_id,
        name                      = new.name,
        summary                   = new.summary,
        admission_policy          = new.admission_policy,
        uses_free_allowance       = new.uses_free_allowance,
        member_cap                = new.member_cap,
        membership_price_amount   = new.membership_price_amount,
        membership_price_currency = new.membership_price_currency
    where c.id = new.club_id;
    perform set_config('app.allow_club_version_sync', '', true);
    return new;
exception
    when others then
        perform set_config('app.allow_club_version_sync', '', true);
        raise;
end;
$$;


ALTER FUNCTION public.sync_club_version_to_club() OWNER TO clawclub_app;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: club_membership_state_versions; Type: TABLE; Schema: public; Owner: clawclub_app
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


ALTER TABLE public.club_membership_state_versions OWNER TO clawclub_app;

--
-- Name: club_memberships; Type: TABLE; Schema: public; Owner: clawclub_app
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
    invitation_id public.short_id
);


ALTER TABLE public.club_memberships OWNER TO clawclub_app;

--
-- Name: current_club_membership_states; Type: VIEW; Schema: public; Owner: clawclub_app
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


ALTER VIEW public.current_club_membership_states OWNER TO clawclub_app;

--
-- Name: current_club_memberships; Type: VIEW; Schema: public; Owner: clawclub_app
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
    m.invitation_id,
    cms.id AS state_version_id,
    cms.reason AS state_reason,
    cms.version_no AS state_version_no,
    cms.created_at AS state_created_at,
    cms.created_by_member_id AS state_created_by_member_id
   FROM (public.club_memberships m
     LEFT JOIN public.current_club_membership_states cms ON (((cms.membership_id)::text = (m.id)::text)));


ALTER VIEW public.current_club_memberships OWNER TO clawclub_app;

--
-- Name: accessible_club_memberships; Type: VIEW; Schema: public; Owner: clawclub_app
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
    invitation_id,
    state_version_id,
    state_reason,
    state_version_no,
    state_created_at,
    state_created_by_member_id
   FROM public.current_club_memberships
  WHERE ((status = 'active'::public.membership_state) AND (left_at IS NULL));


ALTER VIEW public.accessible_club_memberships OWNER TO clawclub_app;

--
-- Name: accessible_memberships; Type: VIEW; Schema: producer_contract; Owner: clawclub_app
--

CREATE VIEW producer_contract.accessible_memberships AS
 SELECT member_id,
    club_id
   FROM public.accessible_club_memberships acm;


ALTER VIEW producer_contract.accessible_memberships OWNER TO clawclub_app;

--
-- Name: club_activity; Type: TABLE; Schema: public; Owner: clawclub_app
--

CREATE TABLE public.club_activity (
    id public.short_id DEFAULT public.new_id() NOT NULL,
    club_id public.short_id NOT NULL,
    seq bigint NOT NULL,
    topic text NOT NULL,
    audience public.club_activity_audience DEFAULT 'members'::public.club_activity_audience NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    content_id public.short_id,
    content_version_id public.short_id,
    created_by_member_id public.short_id,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT club_activity_topic_check CHECK ((length(btrim(topic)) > 0))
);


ALTER TABLE public.club_activity OWNER TO clawclub_app;

--
-- Name: activity_events; Type: VIEW; Schema: producer_contract; Owner: clawclub_app
--

CREATE VIEW producer_contract.activity_events AS
 SELECT seq,
    club_id,
    content_id,
    topic,
    created_by_member_id,
    created_at
   FROM public.club_activity ca;


ALTER VIEW producer_contract.activity_events OWNER TO clawclub_app;

--
-- Name: content_embeddings; Type: TABLE; Schema: public; Owner: clawclub_app
--

CREATE TABLE public.content_embeddings (
    id public.short_id DEFAULT public.new_id() NOT NULL,
    content_id public.short_id NOT NULL,
    content_version_id public.short_id NOT NULL,
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
    CONSTRAINT content_embeddings_dimensions_check CHECK ((dimensions > 0))
);


ALTER TABLE public.content_embeddings OWNER TO clawclub_app;

--
-- Name: content_versions; Type: TABLE; Schema: public; Owner: clawclub_app
--

CREATE TABLE public.content_versions (
    id public.short_id DEFAULT public.new_id() NOT NULL,
    content_id public.short_id NOT NULL,
    version_no integer NOT NULL,
    state public.content_state DEFAULT 'published'::public.content_state NOT NULL,
    title text,
    summary text,
    body text,
    effective_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    reason text,
    supersedes_version_id public.short_id,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_member_id public.short_id,
    CONSTRAINT content_versions_expiry_check CHECK (((expires_at IS NULL) OR (expires_at >= effective_at))),
    CONSTRAINT content_versions_version_no_check CHECK ((version_no > 0))
);


ALTER TABLE public.content_versions OWNER TO clawclub_app;

--
-- Name: contents; Type: TABLE; Schema: public; Owner: clawclub_app
--

CREATE TABLE public.contents (
    id public.short_id DEFAULT public.new_id() NOT NULL,
    club_id public.short_id NOT NULL,
    kind public.content_kind NOT NULL,
    author_member_id public.short_id NOT NULL,
    open_loop boolean,
    client_key text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    deleted_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    thread_id public.short_id NOT NULL,
    CONSTRAINT contents_open_loop_kind_check CHECK ((((kind = ANY (ARRAY['ask'::public.content_kind, 'gift'::public.content_kind, 'service'::public.content_kind, 'opportunity'::public.content_kind])) AND (open_loop IS NOT NULL)) OR ((kind <> ALL (ARRAY['ask'::public.content_kind, 'gift'::public.content_kind, 'service'::public.content_kind, 'opportunity'::public.content_kind])) AND (open_loop IS NULL))))
);


ALTER TABLE public.contents OWNER TO clawclub_app;

--
-- Name: current_content_versions; Type: VIEW; Schema: public; Owner: clawclub_app
--

CREATE VIEW public.current_content_versions AS
 SELECT DISTINCT ON (content_id) id,
    content_id,
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
   FROM public.content_versions
  ORDER BY content_id, version_no DESC, created_at DESC;


ALTER VIEW public.current_content_versions OWNER TO clawclub_app;

--
-- Name: current_content_embeddings; Type: VIEW; Schema: producer_contract; Owner: clawclub_app
--

CREATE VIEW producer_contract.current_content_embeddings AS
 SELECT eea.content_id,
    eea.content_version_id,
    e.club_id,
    (e.kind)::text AS kind,
    e.author_member_id,
    e.open_loop,
    cev.expires_at,
    eea.embedding,
    eea.updated_at
   FROM ((public.content_embeddings eea
     JOIN public.current_content_versions cev ON ((((cev.content_id)::text = (eea.content_id)::text) AND ((cev.id)::text = (eea.content_version_id)::text) AND (cev.state = 'published'::public.content_state))))
     JOIN public.contents e ON (((e.id)::text = (eea.content_id)::text)))
  WHERE (e.deleted_at IS NULL);


ALTER VIEW producer_contract.current_content_embeddings OWNER TO clawclub_app;

--
-- Name: member_club_profile_versions; Type: TABLE; Schema: public; Owner: clawclub_app
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


ALTER TABLE public.member_club_profile_versions OWNER TO clawclub_app;

--
-- Name: current_member_club_profiles; Type: VIEW; Schema: public; Owner: clawclub_app
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


ALTER VIEW public.current_member_club_profiles OWNER TO clawclub_app;

--
-- Name: member_profile_embeddings; Type: TABLE; Schema: public; Owner: clawclub_app
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


ALTER TABLE public.member_profile_embeddings OWNER TO clawclub_app;

--
-- Name: current_member_profile_embeddings; Type: VIEW; Schema: producer_contract; Owner: clawclub_app
--

CREATE VIEW producer_contract.current_member_profile_embeddings AS
 SELECT empa.member_id,
    empa.club_id,
    empa.profile_version_id,
    empa.embedding,
    empa.updated_at
   FROM (public.member_profile_embeddings empa
     JOIN public.current_member_club_profiles cmp ON ((((cmp.id)::text = (empa.profile_version_id)::text) AND ((cmp.member_id)::text = (empa.member_id)::text) AND ((cmp.club_id)::text = (empa.club_id)::text))));


ALTER VIEW producer_contract.current_member_profile_embeddings OWNER TO clawclub_app;

--
-- Name: current_published_contents; Type: VIEW; Schema: producer_contract; Owner: clawclub_app
--

CREATE VIEW producer_contract.current_published_contents AS
 SELECT e.id AS content_id,
    e.club_id,
    e.thread_id,
    (e.kind)::text AS kind,
    e.author_member_id,
    e.open_loop,
    e.created_at,
    cev.id AS current_version_id,
    cev.title,
    cev.summary,
    cev.expires_at,
    (NOT (EXISTS ( SELECT 1
           FROM public.contents earlier
          WHERE (((earlier.thread_id)::text = (e.thread_id)::text) AND (earlier.archived_at IS NULL) AND (earlier.deleted_at IS NULL) AND ((earlier.created_at < e.created_at) OR ((earlier.created_at = e.created_at) AND ((earlier.id)::text < (e.id)::text))))))) AS is_thread_subject
   FROM (public.contents e
     JOIN public.current_content_versions cev ON (((cev.content_id)::text = (e.id)::text)))
  WHERE ((e.deleted_at IS NULL) AND (cev.state = 'published'::public.content_state));


ALTER VIEW producer_contract.current_published_contents OWNER TO clawclub_app;

--
-- Name: members; Type: TABLE; Schema: public; Owner: clawclub_app
--

CREATE TABLE public.members (
    id public.short_id DEFAULT public.new_id() NOT NULL,
    public_name text NOT NULL,
    state public.member_state DEFAULT 'active'::public.member_state NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    display_name text NOT NULL,
    email text NOT NULL,
    CONSTRAINT members_display_name_check CHECK ((length(btrim(display_name)) > 0)),
    CONSTRAINT members_public_name_check CHECK ((length(btrim(public_name)) > 0))
);


ALTER TABLE public.members OWNER TO clawclub_app;

--
-- Name: member_identity; Type: VIEW; Schema: producer_contract; Owner: clawclub_app
--

CREATE VIEW producer_contract.member_identity AS
 SELECT id AS member_id,
    public_name,
    state
   FROM public.members m;


ALTER VIEW producer_contract.member_identity OWNER TO clawclub_app;

--
-- Name: club_subscriptions; Type: TABLE; Schema: public; Owner: clawclub_app
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


ALTER TABLE public.club_subscriptions OWNER TO clawclub_app;

--
-- Name: membership_access_events; Type: VIEW; Schema: producer_contract; Owner: clawclub_app
--

CREATE VIEW producer_contract.membership_access_events AS
 SELECT cm.member_id,
    cm.club_id,
    sv.created_at AS occurred_at,
    'membership'::text AS source_kind
   FROM (public.club_membership_state_versions sv
     JOIN public.club_memberships cm ON (((cm.id)::text = (sv.membership_id)::text)))
  WHERE ((sv.status = 'active'::public.membership_state) AND (EXISTS ( SELECT 1
           FROM public.accessible_club_memberships acm
          WHERE (((acm.member_id)::text = (cm.member_id)::text) AND ((acm.club_id)::text = (cm.club_id)::text)))))
UNION ALL
 SELECT cm.member_id,
    cm.club_id,
    s.started_at AS occurred_at,
    'subscription'::text AS source_kind
   FROM (public.club_subscriptions s
     JOIN public.club_memberships cm ON (((cm.id)::text = (s.membership_id)::text)))
  WHERE ((s.status = ANY (ARRAY['active'::public.subscription_status, 'trialing'::public.subscription_status])) AND (EXISTS ( SELECT 1
           FROM public.accessible_club_memberships acm
          WHERE (((acm.member_id)::text = (cm.member_id)::text) AND ((acm.club_id)::text = (cm.club_id)::text)))));


ALTER VIEW producer_contract.membership_access_events OWNER TO clawclub_app;

--
-- Name: meta; Type: TABLE; Schema: producer_contract; Owner: clawclub_app
--

CREATE TABLE producer_contract.meta (
    singleton boolean DEFAULT true NOT NULL,
    version integer NOT NULL,
    hash text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT meta_singleton_check CHECK (singleton),
    CONSTRAINT meta_version_check CHECK ((version > 0))
);


ALTER TABLE producer_contract.meta OWNER TO clawclub_app;

--
-- Name: dm_threads; Type: TABLE; Schema: public; Owner: clawclub_app
--

CREATE TABLE public.dm_threads (
    id public.short_id DEFAULT public.new_id() NOT NULL,
    kind public.thread_kind NOT NULL,
    created_by_member_id public.short_id,
    subject_content_id public.short_id,
    member_a_id public.short_id,
    member_b_id public.short_id,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    CONSTRAINT dm_threads_direct_pair_check CHECK (((kind <> 'direct'::public.thread_kind) OR ((member_a_id IS NOT NULL) AND (member_b_id IS NOT NULL) AND ((member_a_id)::text < (member_b_id)::text))))
);


ALTER TABLE public.dm_threads OWNER TO clawclub_app;

--
-- Name: open_dm_threads; Type: VIEW; Schema: producer_contract; Owner: clawclub_app
--

CREATE VIEW producer_contract.open_dm_threads AS
 SELECT member_a_id,
    member_b_id
   FROM public.dm_threads dt
  WHERE (archived_at IS NULL);


ALTER VIEW producer_contract.open_dm_threads OWNER TO clawclub_app;

--
-- Name: profile_embedding_events; Type: VIEW; Schema: producer_contract; Owner: clawclub_app
--

CREATE VIEW producer_contract.profile_embedding_events AS
 SELECT empa.member_id,
    empa.club_id,
    empa.profile_version_id,
    empa.updated_at,
    mcp.created_at AS profile_changed_at
   FROM (public.member_profile_embeddings empa
     JOIN public.member_club_profile_versions mcp ON (((mcp.id)::text = (empa.profile_version_id)::text)));


ALTER VIEW producer_contract.profile_embedding_events OWNER TO clawclub_app;

--
-- Name: active_club_memberships; Type: VIEW; Schema: public; Owner: clawclub_app
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
    invitation_id,
    state_version_id,
    state_reason,
    state_version_no,
    state_created_at,
    state_created_by_member_id
   FROM public.current_club_memberships
  WHERE ((status = 'active'::public.membership_state) AND (left_at IS NULL));


ALTER VIEW public.active_club_memberships OWNER TO clawclub_app;

--
-- Name: ai_club_spend_reservations; Type: TABLE; Schema: public; Owner: clawclub_app
--

CREATE TABLE public.ai_club_spend_reservations (
    id public.short_id DEFAULT public.new_id() NOT NULL,
    club_id public.short_id NOT NULL,
    member_id public.short_id,
    action_name text NOT NULL,
    usage_kind text NOT NULL,
    provider text NOT NULL,
    model text NOT NULL,
    status text NOT NULL,
    reserved_micro_cents bigint NOT NULL,
    actual_micro_cents bigint,
    reserved_input_tokens_estimate integer CONSTRAINT ai_club_spend_reservations_reserved_input_tokens_estim_not_null NOT NULL,
    reserved_output_tokens integer NOT NULL,
    actual_prompt_tokens integer,
    actual_completion_tokens integer,
    actual_embedding_tokens integer,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    finalized_at timestamp with time zone,
    CONSTRAINT ai_club_spend_reservations_actual_completion_tokens_check CHECK (((actual_completion_tokens IS NULL) OR (actual_completion_tokens >= 0))),
    CONSTRAINT ai_club_spend_reservations_actual_embedding_tokens_check CHECK (((actual_embedding_tokens IS NULL) OR (actual_embedding_tokens >= 0))),
    CONSTRAINT ai_club_spend_reservations_actual_micro_cents_check CHECK (((actual_micro_cents IS NULL) OR (actual_micro_cents >= 0))),
    CONSTRAINT ai_club_spend_reservations_actual_prompt_tokens_check CHECK (((actual_prompt_tokens IS NULL) OR (actual_prompt_tokens >= 0))),
    CONSTRAINT ai_club_spend_reservations_embedding_shape_check CHECK (((usage_kind <> 'embedding'::text) OR ((reserved_output_tokens = 0) AND (actual_prompt_tokens IS NULL) AND (actual_completion_tokens IS NULL)))),
    CONSTRAINT ai_club_spend_reservations_gate_shape_check CHECK (((usage_kind <> 'gate'::text) OR ((actual_embedding_tokens IS NULL) AND (reserved_output_tokens > 0)))),
    CONSTRAINT ai_club_spend_reservations_pending_shape_check CHECK ((((status = 'pending'::text) AND (actual_micro_cents IS NULL) AND (finalized_at IS NULL)) OR ((status = ANY (ARRAY['finalized'::text, 'released'::text])) AND (actual_micro_cents IS NOT NULL) AND (finalized_at IS NOT NULL)))),
    CONSTRAINT ai_club_spend_reservations_released_zero_check CHECK (((status <> 'released'::text) OR (actual_micro_cents = 0))),
    CONSTRAINT ai_club_spend_reservations_reserved_input_tokens_check CHECK ((reserved_input_tokens_estimate >= 0)),
    CONSTRAINT ai_club_spend_reservations_reserved_micro_cents_check CHECK ((reserved_micro_cents > 0)),
    CONSTRAINT ai_club_spend_reservations_reserved_output_tokens_check CHECK ((reserved_output_tokens >= 0)),
    CONSTRAINT ai_club_spend_reservations_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'finalized'::text, 'released'::text]))),
    CONSTRAINT ai_club_spend_reservations_usage_kind_check CHECK ((usage_kind = ANY (ARRAY['gate'::text, 'embedding'::text])))
);


ALTER TABLE public.ai_club_spend_reservations OWNER TO clawclub_app;

--
-- Name: ai_embedding_jobs; Type: TABLE; Schema: public; Owner: clawclub_app
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
    state text DEFAULT 'queued'::text NOT NULL,
    CONSTRAINT ai_embedding_jobs_dimensions_check CHECK ((dimensions > 0)),
    CONSTRAINT ai_embedding_jobs_state_check CHECK ((state = ANY (ARRAY['queued'::text, 'budget_blocked'::text, 'failed'::text]))),
    CONSTRAINT ai_embedding_jobs_subject_kind_check CHECK ((subject_kind = ANY (ARRAY['member_club_profile_version'::text, 'content_version'::text])))
);


ALTER TABLE public.ai_embedding_jobs OWNER TO clawclub_app;

--
-- Name: ai_llm_quota_reservations; Type: TABLE; Schema: public; Owner: clawclub_app
--

CREATE TABLE public.ai_llm_quota_reservations (
    id public.short_id DEFAULT public.new_id() NOT NULL,
    member_id public.short_id,
    club_id public.short_id NOT NULL,
    action_name text NOT NULL,
    provider text NOT NULL,
    model text NOT NULL,
    status text NOT NULL,
    reserved_output_tokens integer NOT NULL,
    actual_output_tokens integer,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    finalized_at timestamp with time zone,
    CONSTRAINT ai_llm_quota_reservations_actual_check CHECK (((actual_output_tokens IS NULL) OR (actual_output_tokens >= 0))),
    CONSTRAINT ai_llm_quota_reservations_pending_shape_check CHECK ((((status = 'pending'::text) AND (actual_output_tokens IS NULL) AND (finalized_at IS NULL)) OR ((status = ANY (ARRAY['finalized'::text, 'released'::text])) AND (actual_output_tokens IS NOT NULL) AND (finalized_at IS NOT NULL)))),
    CONSTRAINT ai_llm_quota_reservations_released_zero_check CHECK (((status <> 'released'::text) OR (actual_output_tokens = 0))),
    CONSTRAINT ai_llm_quota_reservations_reserved_check CHECK ((reserved_output_tokens > 0)),
    CONSTRAINT ai_llm_quota_reservations_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'finalized'::text, 'released'::text])))
);


ALTER TABLE public.ai_llm_quota_reservations OWNER TO clawclub_app;

--
-- Name: ai_llm_usage_log; Type: TABLE; Schema: public; Owner: clawclub_app
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
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    feedback text,
    CONSTRAINT ai_llm_usage_log_skip_reason_check CHECK ((((gate_status = 'skipped'::public.content_gate_status) AND (skip_reason IS NOT NULL)) OR ((gate_status <> 'skipped'::public.content_gate_status) AND (skip_reason IS NULL))))
);


ALTER TABLE public.ai_llm_usage_log OWNER TO clawclub_app;

--
-- Name: ai_quota_event_log; Type: TABLE; Schema: public; Owner: clawclub_app
--

CREATE TABLE public.ai_quota_event_log (
    id public.short_id DEFAULT public.new_id() NOT NULL,
    member_id public.short_id NOT NULL,
    action_name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.ai_quota_event_log OWNER TO clawclub_app;

--
-- Name: api_request_log; Type: TABLE; Schema: public; Owner: clawclub_app
--

CREATE TABLE public.api_request_log (
    id public.short_id DEFAULT public.new_id() NOT NULL,
    member_id public.short_id,
    action_name text NOT NULL,
    ip_address inet,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.api_request_log OWNER TO clawclub_app;

--
-- Name: club_activity_cursors; Type: TABLE; Schema: public; Owner: clawclub_app
--

CREATE TABLE public.club_activity_cursors (
    member_id public.short_id NOT NULL,
    club_id public.short_id NOT NULL,
    last_seq bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.club_activity_cursors OWNER TO clawclub_app;

--
-- Name: club_activity_seq_seq; Type: SEQUENCE; Schema: public; Owner: clawclub_app
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
-- Name: club_applicant_blocks; Type: TABLE; Schema: public; Owner: clawclub_app
--

CREATE TABLE public.club_applicant_blocks (
    id public.short_id DEFAULT public.new_id() NOT NULL,
    club_id public.short_id NOT NULL,
    member_id public.short_id NOT NULL,
    block_kind text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_member_id public.short_id,
    reason text,
    CONSTRAINT club_applicant_blocks_block_kind_check CHECK ((block_kind = ANY (ARRAY['banned'::text, 'removed'::text])))
);


ALTER TABLE public.club_applicant_blocks OWNER TO clawclub_app;

--
-- Name: club_application_revisions; Type: TABLE; Schema: public; Owner: clawclub_app
--

CREATE TABLE public.club_application_revisions (
    id public.short_id DEFAULT public.new_id() NOT NULL,
    application_id public.short_id NOT NULL,
    version_no integer NOT NULL,
    draft_name text NOT NULL,
    draft_socials text NOT NULL,
    draft_application text NOT NULL,
    gate_verdict text,
    gate_feedback jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_member_id public.short_id,
    CONSTRAINT club_application_revisions_version_no_check CHECK ((version_no > 0))
);


ALTER TABLE public.club_application_revisions OWNER TO clawclub_app;

--
-- Name: club_applications; Type: TABLE; Schema: public; Owner: clawclub_app
--

CREATE TABLE public.club_applications (
    id public.short_id DEFAULT public.new_id() NOT NULL,
    club_id public.short_id NOT NULL,
    applicant_member_id public.short_id NOT NULL,
    submission_path text NOT NULL,
    invitation_id public.short_id,
    sponsor_member_id public.short_id,
    phase text NOT NULL,
    draft_name text NOT NULL,
    draft_socials text NOT NULL,
    draft_application text NOT NULL,
    generated_profile_draft jsonb,
    gate_verdict text,
    gate_feedback jsonb,
    gate_last_run_at timestamp with time zone,
    admin_note text,
    admin_workflow_stage text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    submitted_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_at timestamp with time zone,
    decided_by_member_id public.short_id,
    activated_membership_id public.short_id,
    migrated_from_membership_id public.short_id,
    migration_reason text,
    gate_input_hash text,
    sponsor_name_snapshot text,
    invite_reason_snapshot text,
    invite_mode text,
    CONSTRAINT club_applications_content_nonempty CHECK (((length(btrim(draft_name)) > 0) AND (length(btrim(draft_application)) > 0))),
    CONSTRAINT club_applications_gate_verdict_check CHECK (((gate_verdict IS NULL) OR (gate_verdict = ANY (ARRAY['passed'::text, 'needs_revision'::text, 'not_run'::text, 'unavailable'::text])))),
    CONSTRAINT club_applications_invitation_coupling_check CHECK (((submission_path = 'invitation'::text) = (invitation_id IS NOT NULL))),
    CONSTRAINT club_applications_invitation_snapshot_check CHECK ((((invitation_id IS NULL) = (invite_reason_snapshot IS NULL)) AND ((invitation_id IS NULL) = (invite_mode IS NULL)))),
    CONSTRAINT club_applications_invite_mode_check CHECK (((invite_mode IS NULL) OR (invite_mode = ANY (ARRAY['internal'::text, 'external'::text])))),
    CONSTRAINT club_applications_phase_check CHECK ((phase = ANY (ARRAY['revision_required'::text, 'awaiting_review'::text, 'active'::text, 'declined'::text, 'banned'::text, 'removed'::text, 'withdrawn'::text]))),
    CONSTRAINT club_applications_submission_path_check CHECK ((submission_path = ANY (ARRAY['cold'::text, 'invitation'::text])))
);


ALTER TABLE public.club_applications OWNER TO clawclub_app;

--
-- Name: club_edges; Type: TABLE; Schema: public; Owner: clawclub_app
--

CREATE TABLE public.club_edges (
    id public.short_id DEFAULT public.new_id() NOT NULL,
    club_id public.short_id,
    kind public.edge_kind NOT NULL,
    from_member_id public.short_id,
    from_content_id public.short_id,
    from_content_version_id public.short_id,
    to_member_id public.short_id,
    to_content_id public.short_id,
    to_content_version_id public.short_id,
    reason text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    client_key text,
    created_by_member_id public.short_id,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    CONSTRAINT club_edges_from_check CHECK ((((((from_member_id IS NOT NULL))::integer + ((from_content_id IS NOT NULL))::integer) + ((from_content_version_id IS NOT NULL))::integer) = 1)),
    CONSTRAINT club_edges_no_self_vouch CHECK (((kind <> 'vouched_for'::public.edge_kind) OR ((from_member_id)::text <> (to_member_id)::text))),
    CONSTRAINT club_edges_to_check CHECK ((((((to_member_id IS NOT NULL))::integer + ((to_content_id IS NOT NULL))::integer) + ((to_content_version_id IS NOT NULL))::integer) = 1)),
    CONSTRAINT club_edges_vouch_check CHECK (((kind <> 'vouched_for'::public.edge_kind) OR ((from_member_id IS NOT NULL) AND (to_member_id IS NOT NULL) AND (reason IS NOT NULL))))
);


ALTER TABLE public.club_edges OWNER TO clawclub_app;

--
-- Name: club_removal_archives; Type: TABLE; Schema: public; Owner: clawclub_app
--

CREATE TABLE public.club_removal_archives (
    id public.short_id DEFAULT public.new_id() NOT NULL,
    club_id public.short_id NOT NULL,
    club_slug text NOT NULL,
    removed_at timestamp with time zone DEFAULT now() NOT NULL,
    removed_by_member_id public.short_id,
    reason text NOT NULL,
    retained_until timestamp with time zone NOT NULL,
    payload jsonb NOT NULL,
    CONSTRAINT club_removal_archives_club_slug_check CHECK ((club_slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'::text)),
    CONSTRAINT club_removal_archives_reason_check CHECK ((length(btrim(reason)) > 0))
);


ALTER TABLE public.club_removal_archives OWNER TO clawclub_app;

--
-- Name: club_versions; Type: TABLE; Schema: public; Owner: clawclub_app
--

CREATE TABLE public.club_versions (
    id public.short_id DEFAULT public.new_id() NOT NULL,
    club_id public.short_id NOT NULL,
    owner_member_id public.short_id,
    name text NOT NULL,
    summary text,
    admission_policy text,
    membership_price_amount numeric(12,2),
    membership_price_currency text DEFAULT 'USD'::text NOT NULL,
    version_no integer NOT NULL,
    supersedes_version_id public.short_id,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_member_id public.short_id,
    uses_free_allowance boolean DEFAULT false NOT NULL,
    member_cap integer,
    CONSTRAINT club_versions_admission_policy_length CHECK (((admission_policy IS NULL) OR ((char_length(admission_policy) >= 1) AND (char_length(admission_policy) <= 2000)))),
    CONSTRAINT club_versions_currency_check CHECK ((membership_price_currency ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT club_versions_member_cap_check CHECK (((member_cap IS NULL) OR (member_cap >= 1))),
    CONSTRAINT club_versions_name_check CHECK ((length(btrim(name)) > 0)),
    CONSTRAINT club_versions_price_check CHECK (((membership_price_amount IS NULL) OR (membership_price_amount >= (0)::numeric))),
    CONSTRAINT club_versions_version_no_check CHECK ((version_no > 0))
);


ALTER TABLE public.club_versions OWNER TO clawclub_app;

--
-- Name: clubs; Type: TABLE; Schema: public; Owner: clawclub_app
--

CREATE TABLE public.clubs (
    id public.short_id DEFAULT public.new_id() NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    summary text,
    owner_member_id public.short_id NOT NULL,
    admission_policy text,
    membership_price_amount numeric(12,2),
    membership_price_currency text DEFAULT 'USD'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    uses_free_allowance boolean DEFAULT false NOT NULL,
    member_cap integer,
    CONSTRAINT clubs_admission_policy_length CHECK (((admission_policy IS NULL) OR ((char_length(admission_policy) >= 1) AND (char_length(admission_policy) <= 2000)))),
    CONSTRAINT clubs_currency_check CHECK ((membership_price_currency ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT clubs_member_cap_check CHECK (((member_cap IS NULL) OR (member_cap >= 1))),
    CONSTRAINT clubs_name_check CHECK ((length(btrim(name)) > 0)),
    CONSTRAINT clubs_price_check CHECK (((membership_price_amount IS NULL) OR (membership_price_amount >= (0)::numeric))),
    CONSTRAINT clubs_slug_check CHECK ((slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'::text))
);


ALTER TABLE public.clubs OWNER TO clawclub_app;

--
-- Name: consumed_account_registration_pow_challenges; Type: TABLE; Schema: public; Owner: clawclub_app
--

CREATE TABLE public.consumed_account_registration_pow_challenges (
    challenge_id text CONSTRAINT consumed_account_registration_pow_challen_challenge_id_not_null NOT NULL,
    consumed_at timestamp with time zone DEFAULT now() CONSTRAINT consumed_account_registration_pow_challeng_consumed_at_not_null NOT NULL
);


ALTER TABLE public.consumed_account_registration_pow_challenges OWNER TO clawclub_app;

--
-- Name: consumed_pow_challenges; Type: TABLE; Schema: public; Owner: clawclub_app
--

CREATE TABLE public.consumed_pow_challenges (
    challenge_id text NOT NULL,
    consumed_at timestamp with time zone DEFAULT now() NOT NULL,
    club_id public.short_id NOT NULL
);


ALTER TABLE public.consumed_pow_challenges OWNER TO clawclub_app;

--
-- Name: content_threads; Type: TABLE; Schema: public; Owner: clawclub_app
--

CREATE TABLE public.content_threads (
    id public.short_id DEFAULT public.new_id() NOT NULL,
    club_id public.short_id NOT NULL,
    created_by_member_id public.short_id,
    last_activity_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone
);


ALTER TABLE public.content_threads OWNER TO clawclub_app;

--
-- Name: content_version_mentions; Type: TABLE; Schema: public; Owner: clawclub_app
--

CREATE TABLE public.content_version_mentions (
    content_version_id public.short_id NOT NULL,
    field text NOT NULL,
    start_offset integer NOT NULL,
    end_offset integer NOT NULL,
    mentioned_member_id public.short_id NOT NULL,
    authored_label text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT content_version_mentions_field_check CHECK ((field = ANY (ARRAY['title'::text, 'summary'::text, 'body'::text]))),
    CONSTRAINT content_version_mentions_offset_check CHECK (((start_offset >= 0) AND (end_offset > start_offset)))
);


ALTER TABLE public.content_version_mentions OWNER TO clawclub_app;

--
-- Name: current_club_versions; Type: VIEW; Schema: public; Owner: clawclub_app
--

CREATE VIEW public.current_club_versions AS
 SELECT DISTINCT ON (club_id) id,
    club_id,
    owner_member_id,
    name,
    summary,
    admission_policy,
    uses_free_allowance,
    member_cap,
    membership_price_amount,
    membership_price_currency,
    version_no,
    supersedes_version_id,
    created_at,
    created_by_member_id
   FROM public.club_versions
  ORDER BY club_id, version_no DESC, created_at DESC;


ALTER VIEW public.current_club_versions OWNER TO clawclub_app;

--
-- Name: event_rsvps; Type: TABLE; Schema: public; Owner: clawclub_app
--

CREATE TABLE public.event_rsvps (
    id public.short_id DEFAULT public.new_id() NOT NULL,
    event_content_id public.short_id NOT NULL,
    membership_id public.short_id NOT NULL,
    response public.rsvp_state NOT NULL,
    note text,
    client_key text,
    version_no integer DEFAULT 1 NOT NULL,
    supersedes_rsvp_id public.short_id,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_member_id public.short_id
);


ALTER TABLE public.event_rsvps OWNER TO clawclub_app;

--
-- Name: current_event_rsvps; Type: VIEW; Schema: public; Owner: clawclub_app
--

CREATE VIEW public.current_event_rsvps AS
 SELECT DISTINCT ON (event_content_id, membership_id) id,
    event_content_id,
    membership_id,
    response,
    note,
    client_key,
    version_no,
    supersedes_rsvp_id,
    created_at,
    created_by_member_id
   FROM public.event_rsvps
  ORDER BY event_content_id, membership_id, version_no DESC, created_at DESC;


ALTER VIEW public.current_event_rsvps OWNER TO clawclub_app;

--
-- Name: event_version_details; Type: TABLE; Schema: public; Owner: clawclub_app
--

CREATE TABLE public.event_version_details (
    content_version_id public.short_id NOT NULL,
    location text,
    starts_at timestamp with time zone,
    ends_at timestamp with time zone,
    timezone text,
    recurrence_rule text,
    capacity integer,
    CONSTRAINT event_version_details_capacity_check CHECK (((capacity IS NULL) OR (capacity > 0))),
    CONSTRAINT event_version_details_dates_check CHECK (((ends_at IS NULL) OR (starts_at IS NULL) OR (ends_at >= starts_at)))
);


ALTER TABLE public.event_version_details OWNER TO clawclub_app;

--
-- Name: current_event_versions; Type: VIEW; Schema: public; Owner: clawclub_app
--

CREATE VIEW public.current_event_versions AS
 SELECT ccv.id,
    ccv.content_id,
    ccv.version_no,
    ccv.state,
    ccv.title,
    ccv.summary,
    ccv.body,
    ccv.effective_at,
    ccv.expires_at,
    ccv.reason,
    ccv.supersedes_version_id,
    ccv.created_at,
    ccv.created_by_member_id,
    evd.location,
    evd.starts_at,
    evd.ends_at,
    evd.timezone,
    evd.recurrence_rule,
    evd.capacity
   FROM (public.current_content_versions ccv
     JOIN public.event_version_details evd ON (((evd.content_version_id)::text = (ccv.id)::text)));


ALTER VIEW public.current_event_versions OWNER TO clawclub_app;

--
-- Name: member_global_role_versions; Type: TABLE; Schema: public; Owner: clawclub_app
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


ALTER TABLE public.member_global_role_versions OWNER TO clawclub_app;

--
-- Name: current_member_global_role_versions; Type: VIEW; Schema: public; Owner: clawclub_app
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


ALTER VIEW public.current_member_global_role_versions OWNER TO clawclub_app;

--
-- Name: current_member_global_roles; Type: VIEW; Schema: public; Owner: clawclub_app
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


ALTER VIEW public.current_member_global_roles OWNER TO clawclub_app;

--
-- Name: dm_inbox_entries; Type: TABLE; Schema: public; Owner: clawclub_app
--

CREATE TABLE public.dm_inbox_entries (
    id public.short_id DEFAULT public.new_id() NOT NULL,
    recipient_member_id public.short_id NOT NULL,
    thread_id public.short_id NOT NULL,
    message_id public.short_id NOT NULL,
    acknowledged boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.dm_inbox_entries OWNER TO clawclub_app;

--
-- Name: dm_message_mentions; Type: TABLE; Schema: public; Owner: clawclub_app
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


ALTER TABLE public.dm_message_mentions OWNER TO clawclub_app;

--
-- Name: dm_message_removals; Type: TABLE; Schema: public; Owner: clawclub_app
--

CREATE TABLE public.dm_message_removals (
    message_id public.short_id NOT NULL,
    removed_by_member_id public.short_id NOT NULL,
    reason text,
    removed_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.dm_message_removals OWNER TO clawclub_app;

--
-- Name: dm_messages; Type: TABLE; Schema: public; Owner: clawclub_app
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


ALTER TABLE public.dm_messages OWNER TO clawclub_app;

--
-- Name: dm_thread_participants; Type: TABLE; Schema: public; Owner: clawclub_app
--

CREATE TABLE public.dm_thread_participants (
    id public.short_id DEFAULT public.new_id() NOT NULL,
    thread_id public.short_id NOT NULL,
    member_id public.short_id NOT NULL,
    role text DEFAULT 'participant'::text NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    left_at timestamp with time zone
);


ALTER TABLE public.dm_thread_participants OWNER TO clawclub_app;

--
-- Name: idempotency_keys; Type: TABLE; Schema: public; Owner: clawclub_app
--

CREATE TABLE public.idempotency_keys (
    client_key text NOT NULL,
    actor_context text NOT NULL,
    request_hash text NOT NULL,
    response_envelope jsonb NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '30 days'::interval) NOT NULL
);


ALTER TABLE public.idempotency_keys OWNER TO clawclub_app;

--
-- Name: invite_codes; Type: TABLE; Schema: public; Owner: clawclub_app
--

CREATE TABLE public.invite_codes (
    invite_request_id public.short_id NOT NULL,
    code text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT invite_codes_code_format_check CHECK ((code ~ '^[A-HJ-KM-NP-TV-Z2-9]{4}-[A-HJ-KM-NP-TV-Z2-9]{4}$'::text))
);


ALTER TABLE public.invite_codes OWNER TO clawclub_app;

--
-- Name: invite_requests; Type: TABLE; Schema: public; Owner: clawclub_app
--

CREATE TABLE public.invite_requests (
    id public.short_id DEFAULT public.new_id() NOT NULL,
    club_id public.short_id NOT NULL,
    sponsor_member_id public.short_id,
    candidate_name text NOT NULL,
    candidate_email text NOT NULL,
    candidate_email_normalized text GENERATED ALWAYS AS (lower(btrim(candidate_email))) STORED,
    reason text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    expired_at timestamp with time zone,
    used_at timestamp with time zone,
    used_membership_id public.short_id,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    candidate_member_id public.short_id,
    delivery_kind text NOT NULL,
    support_withdrawn_at timestamp with time zone,
    target_source text NOT NULL,
    CONSTRAINT invite_requests_delivery_kind_check CHECK ((delivery_kind = ANY (ARRAY['notification'::text, 'code'::text]))),
    CONSTRAINT invite_requests_target_source_check CHECK ((target_source = ANY (ARRAY['member_id'::text, 'email'::text])))
);


ALTER TABLE public.invite_requests OWNER TO clawclub_app;

--
-- Name: published_content_versions; Type: VIEW; Schema: public; Owner: clawclub_app
--

CREATE VIEW public.published_content_versions AS
 SELECT id,
    content_id,
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
   FROM public.current_content_versions
  WHERE (state = 'published'::public.content_state);


ALTER VIEW public.published_content_versions OWNER TO clawclub_app;

--
-- Name: live_content; Type: VIEW; Schema: public; Owner: clawclub_app
--

CREATE VIEW public.live_content AS
 SELECT c.id AS content_id,
    c.club_id,
    c.kind,
    c.open_loop,
    c.author_member_id,
    c.thread_id,
    c.created_at AS content_created_at,
    pcv.id AS content_version_id,
    pcv.version_no,
    pcv.state,
    pcv.title,
    pcv.summary,
    pcv.body,
    pcv.effective_at,
    pcv.expires_at,
    pcv.created_at AS version_created_at,
    pcv.created_by_member_id
   FROM (public.contents c
     JOIN public.published_content_versions pcv ON (((pcv.content_id)::text = (c.id)::text)))
  WHERE ((c.archived_at IS NULL) AND (c.deleted_at IS NULL) AND ((pcv.expires_at IS NULL) OR (pcv.expires_at > now())));


ALTER VIEW public.live_content OWNER TO clawclub_app;

--
-- Name: live_events; Type: VIEW; Schema: public; Owner: clawclub_app
--

CREATE VIEW public.live_events AS
 SELECT lc.content_id,
    lc.club_id,
    lc.kind,
    lc.open_loop,
    lc.author_member_id,
    lc.thread_id,
    lc.content_created_at,
    lc.content_version_id,
    lc.version_no,
    lc.state,
    lc.title,
    lc.summary,
    lc.body,
    lc.effective_at,
    lc.expires_at,
    lc.version_created_at,
    lc.created_by_member_id,
    evd.location,
    evd.starts_at,
    evd.ends_at,
    evd.timezone,
    evd.recurrence_rule,
    evd.capacity
   FROM (public.live_content lc
     JOIN public.event_version_details evd ON (((evd.content_version_id)::text = (lc.content_version_id)::text)))
  WHERE (lc.kind = 'event'::public.content_kind);


ALTER VIEW public.live_events OWNER TO clawclub_app;

--
-- Name: member_bearer_tokens; Type: TABLE; Schema: public; Owner: clawclub_app
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


ALTER TABLE public.member_bearer_tokens OWNER TO clawclub_app;

--
-- Name: member_notifications; Type: TABLE; Schema: public; Owner: clawclub_app
--

CREATE TABLE public.member_notifications (
    id public.short_id DEFAULT public.new_id() NOT NULL,
    club_id public.short_id,
    recipient_member_id public.short_id NOT NULL,
    seq bigint NOT NULL,
    topic text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    acknowledged_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    producer_id text DEFAULT 'core'::text NOT NULL,
    payload_version integer DEFAULT 1 NOT NULL,
    idempotency_key text,
    request_fingerprint text,
    expires_at timestamp with time zone,
    CONSTRAINT member_notifications_idempotency_key_check CHECK (((idempotency_key IS NULL) OR (length(btrim(idempotency_key)) > 0))),
    CONSTRAINT member_notifications_idempotency_pairing_check CHECK (((idempotency_key IS NULL) = (request_fingerprint IS NULL))),
    CONSTRAINT member_notifications_payload_version_check CHECK ((payload_version > 0)),
    CONSTRAINT member_notifications_request_fingerprint_check CHECK (((request_fingerprint IS NULL) OR (length(btrim(request_fingerprint)) > 0))),
    CONSTRAINT member_notifications_topic_check CHECK ((length(btrim(topic)) > 0))
);


ALTER TABLE public.member_notifications OWNER TO clawclub_app;

--
-- Name: member_notifications_seq_seq; Type: SEQUENCE; Schema: public; Owner: clawclub_app
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
-- Name: notification_delivery_counters; Type: TABLE; Schema: public; Owner: clawclub_app
--

CREATE TABLE public.notification_delivery_counters (
    producer_id text NOT NULL,
    recipient_member_id public.short_id,
    delivery_class text NOT NULL,
    window_kind text NOT NULL,
    window_start timestamp with time zone NOT NULL,
    delivery_count integer NOT NULL,
    CONSTRAINT notification_delivery_counters_delivery_class_check CHECK ((delivery_class = ANY (ARRAY['transactional'::text, 'informational'::text, 'suggestion'::text]))),
    CONSTRAINT notification_delivery_counters_delivery_count_check CHECK ((delivery_count >= 0)),
    CONSTRAINT notification_delivery_counters_window_kind_check CHECK ((window_kind = ANY (ARRAY['burst'::text, 'hour'::text, 'day'::text])))
);


ALTER TABLE public.notification_delivery_counters OWNER TO clawclub_app;

--
-- Name: notification_producer_topics; Type: TABLE; Schema: public; Owner: clawclub_app
--

CREATE TABLE public.notification_producer_topics (
    producer_id text NOT NULL,
    topic text NOT NULL,
    delivery_class text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT notification_producer_topics_delivery_class_check CHECK ((delivery_class = ANY (ARRAY['transactional'::text, 'informational'::text, 'suggestion'::text]))),
    CONSTRAINT notification_producer_topics_status_check CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text]))),
    CONSTRAINT notification_producer_topics_topic_check CHECK ((length(btrim(topic)) > 0))
);


ALTER TABLE public.notification_producer_topics OWNER TO clawclub_app;

--
-- Name: notification_producers; Type: TABLE; Schema: public; Owner: clawclub_app
--

CREATE TABLE public.notification_producers (
    producer_id text NOT NULL,
    secret_hash_current text NOT NULL,
    secret_hash_previous text,
    namespace_prefix text NOT NULL,
    burst_limit integer,
    hourly_limit integer,
    daily_limit integer,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    rotated_at timestamp with time zone,
    CONSTRAINT notification_producers_burst_limit_check CHECK (((burst_limit IS NULL) OR (burst_limit > 0))),
    CONSTRAINT notification_producers_daily_limit_check CHECK (((daily_limit IS NULL) OR (daily_limit > 0))),
    CONSTRAINT notification_producers_hourly_limit_check CHECK (((hourly_limit IS NULL) OR (hourly_limit > 0))),
    CONSTRAINT notification_producers_status_check CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text])))
);


ALTER TABLE public.notification_producers OWNER TO clawclub_app;

--
-- Name: notification_refs; Type: TABLE; Schema: public; Owner: clawclub_app
--

CREATE TABLE public.notification_refs (
    notification_id public.short_id NOT NULL,
    ref_role text NOT NULL,
    ref_kind text NOT NULL,
    ref_id public.short_id NOT NULL,
    CONSTRAINT notification_refs_ref_kind_check CHECK ((ref_kind = ANY (ARRAY['member'::text, 'club'::text, 'content'::text, 'dm_thread'::text, 'membership'::text, 'application'::text, 'invitation'::text, 'subscription'::text, 'support_request'::text]))),
    CONSTRAINT notification_refs_ref_role_check CHECK ((length(btrim(ref_role)) > 0))
);


ALTER TABLE public.notification_refs OWNER TO clawclub_app;

--
-- Name: platform_stats; Type: TABLE; Schema: public; Owner: clawclub_app
--

CREATE TABLE public.platform_stats (
    singleton boolean DEFAULT true NOT NULL,
    total_members integer NOT NULL,
    active_members integer NOT NULL,
    active_clubs integer NOT NULL,
    live_contents integer NOT NULL,
    total_messages integer NOT NULL,
    pending_applications integer NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT platform_stats_singleton_check CHECK (singleton)
);


ALTER TABLE public.platform_stats OWNER TO clawclub_app;

--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: clawclub_app
--

CREATE TABLE public.schema_migrations (
    filename text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.schema_migrations OWNER TO clawclub_app;

--
-- Name: worker_state; Type: TABLE; Schema: public; Owner: clawclub_app
--

CREATE TABLE public.worker_state (
    worker_id text NOT NULL,
    state_key text NOT NULL,
    state_value text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.worker_state OWNER TO clawclub_app;

--
-- Data for Name: meta; Type: TABLE DATA; Schema: producer_contract; Owner: clawclub_app
--

COPY producer_contract.meta (singleton, version, hash, updated_at) FROM stdin;
t	1	049_producer_contract_initial	2026-04-23 12:21:40.80753+01
\.


--
-- Data for Name: ai_club_spend_reservations; Type: TABLE DATA; Schema: public; Owner: clawclub_app
--

COPY public.ai_club_spend_reservations (id, club_id, member_id, action_name, usage_kind, provider, model, status, reserved_micro_cents, actual_micro_cents, reserved_input_tokens_estimate, reserved_output_tokens, actual_prompt_tokens, actual_completion_tokens, actual_embedding_tokens, expires_at, created_at, finalized_at) FROM stdin;
\.


--
-- Data for Name: ai_embedding_jobs; Type: TABLE DATA; Schema: public; Owner: clawclub_app
--

COPY public.ai_embedding_jobs (id, subject_kind, subject_version_id, model, dimensions, source_version, attempt_count, next_attempt_at, failure_kind, last_error, created_at, state) FROM stdin;
\.


--
-- Data for Name: ai_llm_quota_reservations; Type: TABLE DATA; Schema: public; Owner: clawclub_app
--

COPY public.ai_llm_quota_reservations (id, member_id, club_id, action_name, provider, model, status, reserved_output_tokens, actual_output_tokens, expires_at, created_at, finalized_at) FROM stdin;
\.


--
-- Data for Name: ai_llm_usage_log; Type: TABLE DATA; Schema: public; Owner: clawclub_app
--

COPY public.ai_llm_usage_log (id, member_id, requested_club_id, action_name, artifact_kind, provider, model, gate_status, skip_reason, prompt_tokens, completion_tokens, provider_error_code, created_at, feedback) FROM stdin;
\.


--
-- Data for Name: ai_quota_event_log; Type: TABLE DATA; Schema: public; Owner: clawclub_app
--

COPY public.ai_quota_event_log (id, member_id, action_name, created_at) FROM stdin;
\.


--
-- Data for Name: api_request_log; Type: TABLE DATA; Schema: public; Owner: clawclub_app
--

COPY public.api_request_log (id, member_id, action_name, ip_address, created_at) FROM stdin;
\.


--
-- Data for Name: club_activity; Type: TABLE DATA; Schema: public; Owner: clawclub_app
--

COPY public.club_activity (id, club_id, seq, topic, audience, payload, content_id, content_version_id, created_by_member_id, created_at) FROM stdin;
\.


--
-- Data for Name: club_activity_cursors; Type: TABLE DATA; Schema: public; Owner: clawclub_app
--

COPY public.club_activity_cursors (member_id, club_id, last_seq, updated_at) FROM stdin;
\.


--
-- Data for Name: club_applicant_blocks; Type: TABLE DATA; Schema: public; Owner: clawclub_app
--

COPY public.club_applicant_blocks (id, club_id, member_id, block_kind, created_at, created_by_member_id, reason) FROM stdin;
\.


--
-- Data for Name: club_application_revisions; Type: TABLE DATA; Schema: public; Owner: clawclub_app
--

COPY public.club_application_revisions (id, application_id, version_no, draft_name, draft_socials, draft_application, gate_verdict, gate_feedback, created_at, created_by_member_id) FROM stdin;
\.


--
-- Data for Name: club_applications; Type: TABLE DATA; Schema: public; Owner: clawclub_app
--

COPY public.club_applications (id, club_id, applicant_member_id, submission_path, invitation_id, sponsor_member_id, phase, draft_name, draft_socials, draft_application, generated_profile_draft, gate_verdict, gate_feedback, gate_last_run_at, admin_note, admin_workflow_stage, created_at, updated_at, submitted_at, decided_at, decided_by_member_id, activated_membership_id, migrated_from_membership_id, migration_reason, gate_input_hash, sponsor_name_snapshot, invite_reason_snapshot, invite_mode) FROM stdin;
\.


--
-- Data for Name: club_edges; Type: TABLE DATA; Schema: public; Owner: clawclub_app
--

COPY public.club_edges (id, club_id, kind, from_member_id, from_content_id, from_content_version_id, to_member_id, to_content_id, to_content_version_id, reason, metadata, client_key, created_by_member_id, created_at, archived_at) FROM stdin;
\.


--
-- Data for Name: club_membership_state_versions; Type: TABLE DATA; Schema: public; Owner: clawclub_app
--

COPY public.club_membership_state_versions (id, membership_id, status, reason, version_no, supersedes_state_version_id, created_at, created_by_member_id) FROM stdin;
\.


--
-- Data for Name: club_memberships; Type: TABLE DATA; Schema: public; Owner: clawclub_app
--

COPY public.club_memberships (id, club_id, member_id, sponsor_member_id, role, status, joined_at, left_at, accepted_covenant_at, metadata, is_comped, comped_at, comped_by_member_id, invitation_id) FROM stdin;
\.


--
-- Data for Name: club_removal_archives; Type: TABLE DATA; Schema: public; Owner: clawclub_app
--

COPY public.club_removal_archives (id, club_id, club_slug, removed_at, removed_by_member_id, reason, retained_until, payload) FROM stdin;
\.


--
-- Data for Name: club_subscriptions; Type: TABLE DATA; Schema: public; Owner: clawclub_app
--

COPY public.club_subscriptions (id, membership_id, payer_member_id, status, amount, currency, started_at, current_period_end, ended_at) FROM stdin;
\.


--
-- Data for Name: club_versions; Type: TABLE DATA; Schema: public; Owner: clawclub_app
--

COPY public.club_versions (id, club_id, owner_member_id, name, summary, admission_policy, membership_price_amount, membership_price_currency, version_no, supersedes_version_id, created_at, created_by_member_id, uses_free_allowance, member_cap) FROM stdin;
\.


--
-- Data for Name: clubs; Type: TABLE DATA; Schema: public; Owner: clawclub_app
--

COPY public.clubs (id, slug, name, summary, owner_member_id, admission_policy, membership_price_amount, membership_price_currency, created_at, archived_at, uses_free_allowance, member_cap) FROM stdin;
\.


--
-- Data for Name: consumed_account_registration_pow_challenges; Type: TABLE DATA; Schema: public; Owner: clawclub_app
--

COPY public.consumed_account_registration_pow_challenges (challenge_id, consumed_at) FROM stdin;
\.


--
-- Data for Name: consumed_pow_challenges; Type: TABLE DATA; Schema: public; Owner: clawclub_app
--

COPY public.consumed_pow_challenges (challenge_id, consumed_at, club_id) FROM stdin;
\.


--
-- Data for Name: content_embeddings; Type: TABLE DATA; Schema: public; Owner: clawclub_app
--

COPY public.content_embeddings (id, content_id, content_version_id, model, dimensions, source_version, chunk_index, source_text, source_hash, embedding, metadata, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: content_threads; Type: TABLE DATA; Schema: public; Owner: clawclub_app
--

COPY public.content_threads (id, club_id, created_by_member_id, last_activity_at, created_at, archived_at) FROM stdin;
\.


--
-- Data for Name: content_version_mentions; Type: TABLE DATA; Schema: public; Owner: clawclub_app
--

COPY public.content_version_mentions (content_version_id, field, start_offset, end_offset, mentioned_member_id, authored_label, created_at) FROM stdin;
\.


--
-- Data for Name: content_versions; Type: TABLE DATA; Schema: public; Owner: clawclub_app
--

COPY public.content_versions (id, content_id, version_no, state, title, summary, body, effective_at, expires_at, reason, supersedes_version_id, created_at, created_by_member_id) FROM stdin;
\.


--
-- Data for Name: contents; Type: TABLE DATA; Schema: public; Owner: clawclub_app
--

COPY public.contents (id, club_id, kind, author_member_id, open_loop, client_key, created_at, archived_at, deleted_at, metadata, thread_id) FROM stdin;
\.


--
-- Data for Name: dm_inbox_entries; Type: TABLE DATA; Schema: public; Owner: clawclub_app
--

COPY public.dm_inbox_entries (id, recipient_member_id, thread_id, message_id, acknowledged, created_at) FROM stdin;
\.


--
-- Data for Name: dm_message_mentions; Type: TABLE DATA; Schema: public; Owner: clawclub_app
--

COPY public.dm_message_mentions (message_id, start_offset, end_offset, mentioned_member_id, authored_label, created_at) FROM stdin;
\.


--
-- Data for Name: dm_message_removals; Type: TABLE DATA; Schema: public; Owner: clawclub_app
--

COPY public.dm_message_removals (message_id, removed_by_member_id, reason, removed_at) FROM stdin;
\.


--
-- Data for Name: dm_messages; Type: TABLE DATA; Schema: public; Owner: clawclub_app
--

COPY public.dm_messages (id, thread_id, sender_member_id, role, message_text, payload, in_reply_to_message_id, client_key, created_at) FROM stdin;
\.


--
-- Data for Name: dm_thread_participants; Type: TABLE DATA; Schema: public; Owner: clawclub_app
--

COPY public.dm_thread_participants (id, thread_id, member_id, role, joined_at, left_at) FROM stdin;
\.


--
-- Data for Name: dm_threads; Type: TABLE DATA; Schema: public; Owner: clawclub_app
--

COPY public.dm_threads (id, kind, created_by_member_id, subject_content_id, member_a_id, member_b_id, metadata, created_at, archived_at) FROM stdin;
\.


--
-- Data for Name: event_rsvps; Type: TABLE DATA; Schema: public; Owner: clawclub_app
--

COPY public.event_rsvps (id, event_content_id, membership_id, response, note, client_key, version_no, supersedes_rsvp_id, created_at, created_by_member_id) FROM stdin;
\.


--
-- Data for Name: event_version_details; Type: TABLE DATA; Schema: public; Owner: clawclub_app
--

COPY public.event_version_details (content_version_id, location, starts_at, ends_at, timezone, recurrence_rule, capacity) FROM stdin;
\.


--
-- Data for Name: idempotency_keys; Type: TABLE DATA; Schema: public; Owner: clawclub_app
--

COPY public.idempotency_keys (client_key, actor_context, request_hash, response_envelope, first_seen_at, last_seen_at, expires_at) FROM stdin;
\.


--
-- Data for Name: invite_codes; Type: TABLE DATA; Schema: public; Owner: clawclub_app
--

COPY public.invite_codes (invite_request_id, code, created_at) FROM stdin;
\.


--
-- Data for Name: invite_requests; Type: TABLE DATA; Schema: public; Owner: clawclub_app
--

COPY public.invite_requests (id, club_id, sponsor_member_id, candidate_name, candidate_email, reason, expires_at, expired_at, used_at, used_membership_id, revoked_at, created_at, metadata, candidate_member_id, delivery_kind, support_withdrawn_at, target_source) FROM stdin;
\.


--
-- Data for Name: member_bearer_tokens; Type: TABLE DATA; Schema: public; Owner: clawclub_app
--

COPY public.member_bearer_tokens (id, member_id, label, token_hash, created_at, last_used_at, revoked_at, metadata, expires_at) FROM stdin;
\.


--
-- Data for Name: member_club_profile_versions; Type: TABLE DATA; Schema: public; Owner: clawclub_app
--

COPY public.member_club_profile_versions (id, membership_id, member_id, club_id, version_no, tagline, summary, what_i_do, known_for, services_summary, website_url, links, search_vector, created_at, created_by_member_id, generation_source) FROM stdin;
\.


--
-- Data for Name: member_global_role_versions; Type: TABLE DATA; Schema: public; Owner: clawclub_app
--

COPY public.member_global_role_versions (id, member_id, role, status, version_no, supersedes_role_version_id, created_at, created_by_member_id) FROM stdin;
\.


--
-- Data for Name: member_notifications; Type: TABLE DATA; Schema: public; Owner: clawclub_app
--

COPY public.member_notifications (id, club_id, recipient_member_id, seq, topic, payload, acknowledged_at, created_at, producer_id, payload_version, idempotency_key, request_fingerprint, expires_at) FROM stdin;
\.


--
-- Data for Name: member_profile_embeddings; Type: TABLE DATA; Schema: public; Owner: clawclub_app
--

COPY public.member_profile_embeddings (id, member_id, club_id, profile_version_id, model, dimensions, source_version, chunk_index, source_text, source_hash, embedding, metadata, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: members; Type: TABLE DATA; Schema: public; Owner: clawclub_app
--

COPY public.members (id, public_name, state, metadata, created_at, display_name, email) FROM stdin;
\.


--
-- Data for Name: notification_delivery_counters; Type: TABLE DATA; Schema: public; Owner: clawclub_app
--

COPY public.notification_delivery_counters (producer_id, recipient_member_id, delivery_class, window_kind, window_start, delivery_count) FROM stdin;
\.


--
-- Data for Name: notification_producer_topics; Type: TABLE DATA; Schema: public; Owner: clawclub_app
--

COPY public.notification_producer_topics (producer_id, topic, delivery_class, status, created_at) FROM stdin;
core	application.accepted	transactional	active	2026-04-23 12:21:40.508832+01
core	application.awaiting_review	transactional	active	2026-04-23 12:21:40.508832+01
core	application.banned	transactional	active	2026-04-23 12:21:40.508832+01
core	application.declined	transactional	active	2026-04-23 12:21:40.508832+01
core	application.revision_required	transactional	active	2026-04-23 12:21:40.508832+01
core	application.withdrawn	transactional	active	2026-04-23 12:21:40.508832+01
core	clubadmin.application_pending	transactional	active	2026-04-23 12:21:40.508832+01
core	event.removed	informational	active	2026-04-23 12:21:40.508832+01
core	event.rsvp.updated	informational	active	2026-04-23 12:21:40.508832+01
core	event.updated	informational	active	2026-04-23 12:21:40.508832+01
core	invitation.received	transactional	active	2026-04-23 12:21:40.508832+01
core	invitation.redeemed	informational	active	2026-04-23 12:21:40.508832+01
core	invitation.resolved	transactional	active	2026-04-23 12:21:40.508832+01
core	membership.activated	transactional	active	2026-04-23 12:21:40.508832+01
core	membership.banned	transactional	active	2026-04-23 12:21:40.508832+01
core	membership.removed	transactional	active	2026-04-23 12:21:40.508832+01
core	vouch.received	informational	active	2026-04-23 12:21:40.508832+01
core	account.registered	transactional	active	2026-04-23 12:21:40.630191+01
\.


--
-- Data for Name: notification_producers; Type: TABLE DATA; Schema: public; Owner: clawclub_app
--

COPY public.notification_producers (producer_id, secret_hash_current, secret_hash_previous, namespace_prefix, burst_limit, hourly_limit, daily_limit, status, created_at, rotated_at) FROM stdin;
core	internal-only	\N		\N	\N	\N	active	2026-04-23 12:21:40.508832+01	\N
\.


--
-- Data for Name: notification_refs; Type: TABLE DATA; Schema: public; Owner: clawclub_app
--

COPY public.notification_refs (notification_id, ref_role, ref_kind, ref_id) FROM stdin;
\.


--
-- Data for Name: platform_stats; Type: TABLE DATA; Schema: public; Owner: clawclub_app
--

COPY public.platform_stats (singleton, total_members, active_members, active_clubs, live_contents, total_messages, pending_applications, updated_at) FROM stdin;
t	0	0	0	0	0	0	2026-04-21 01:00:00+01
\.


--
-- Data for Name: schema_migrations; Type: TABLE DATA; Schema: public; Owner: clawclub_app
--

COPY public.schema_migrations (filename, applied_at) FROM stdin;
019_member_ephemeral_fk_cascade.sql	2026-04-24 00:49:00+01
\.


--
-- Data for Name: worker_state; Type: TABLE DATA; Schema: public; Owner: clawclub_app
--

COPY public.worker_state (worker_id, state_key, state_value, updated_at) FROM stdin;
\.


--
-- Name: club_activity_seq_seq; Type: SEQUENCE SET; Schema: public; Owner: clawclub_app
--

SELECT pg_catalog.setval('public.club_activity_seq_seq', 1, false);


--
-- Name: member_notifications_seq_seq; Type: SEQUENCE SET; Schema: public; Owner: clawclub_app
--

SELECT pg_catalog.setval('public.member_notifications_seq_seq', 1, false);


--
-- Name: meta meta_pkey; Type: CONSTRAINT; Schema: producer_contract; Owner: clawclub_app
--

ALTER TABLE ONLY producer_contract.meta
    ADD CONSTRAINT meta_pkey PRIMARY KEY (singleton);


--
-- Name: ai_club_spend_reservations ai_club_spend_reservations_pkey; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.ai_club_spend_reservations
    ADD CONSTRAINT ai_club_spend_reservations_pkey PRIMARY KEY (id);


--
-- Name: ai_embedding_jobs ai_embedding_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.ai_embedding_jobs
    ADD CONSTRAINT ai_embedding_jobs_pkey PRIMARY KEY (id);


--
-- Name: ai_embedding_jobs ai_embedding_jobs_unique; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.ai_embedding_jobs
    ADD CONSTRAINT ai_embedding_jobs_unique UNIQUE (subject_kind, subject_version_id, model, dimensions, source_version);


--
-- Name: ai_llm_quota_reservations ai_llm_quota_reservations_pkey; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.ai_llm_quota_reservations
    ADD CONSTRAINT ai_llm_quota_reservations_pkey PRIMARY KEY (id);


--
-- Name: ai_llm_usage_log ai_llm_usage_log_pkey; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.ai_llm_usage_log
    ADD CONSTRAINT ai_llm_usage_log_pkey PRIMARY KEY (id);


--
-- Name: ai_quota_event_log ai_quota_event_log_pkey; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.ai_quota_event_log
    ADD CONSTRAINT ai_quota_event_log_pkey PRIMARY KEY (id);


--
-- Name: api_request_log api_request_log_pkey; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.api_request_log
    ADD CONSTRAINT api_request_log_pkey PRIMARY KEY (id);


--
-- Name: club_activity_cursors club_activity_cursors_pkey; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_activity_cursors
    ADD CONSTRAINT club_activity_cursors_pkey PRIMARY KEY (member_id, club_id);


--
-- Name: club_activity club_activity_pkey; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_activity
    ADD CONSTRAINT club_activity_pkey PRIMARY KEY (id);


--
-- Name: club_activity club_activity_seq_unique; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_activity
    ADD CONSTRAINT club_activity_seq_unique UNIQUE (seq);


--
-- Name: club_applicant_blocks club_applicant_blocks_club_id_member_id_block_kind_key; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_applicant_blocks
    ADD CONSTRAINT club_applicant_blocks_club_id_member_id_block_kind_key UNIQUE (club_id, member_id, block_kind);


--
-- Name: club_applicant_blocks club_applicant_blocks_pkey; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_applicant_blocks
    ADD CONSTRAINT club_applicant_blocks_pkey PRIMARY KEY (id);


--
-- Name: club_application_revisions club_application_revisions_application_id_version_no_key; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_application_revisions
    ADD CONSTRAINT club_application_revisions_application_id_version_no_key UNIQUE (application_id, version_no);


--
-- Name: club_application_revisions club_application_revisions_pkey; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_application_revisions
    ADD CONSTRAINT club_application_revisions_pkey PRIMARY KEY (id);


--
-- Name: club_applications club_applications_pkey; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_applications
    ADD CONSTRAINT club_applications_pkey PRIMARY KEY (id);


--
-- Name: club_edges club_edges_pkey; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_edges
    ADD CONSTRAINT club_edges_pkey PRIMARY KEY (id);


--
-- Name: club_membership_state_versions club_membership_state_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_membership_state_versions
    ADD CONSTRAINT club_membership_state_versions_pkey PRIMARY KEY (id);


--
-- Name: club_membership_state_versions club_membership_state_versions_version_unique; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_membership_state_versions
    ADD CONSTRAINT club_membership_state_versions_version_unique UNIQUE (membership_id, version_no);


--
-- Name: club_memberships club_memberships_pkey; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_memberships
    ADD CONSTRAINT club_memberships_pkey PRIMARY KEY (id);


--
-- Name: club_removal_archives club_removal_archives_pkey; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_removal_archives
    ADD CONSTRAINT club_removal_archives_pkey PRIMARY KEY (id);


--
-- Name: club_subscriptions club_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_subscriptions
    ADD CONSTRAINT club_subscriptions_pkey PRIMARY KEY (id);


--
-- Name: club_versions club_versions_club_version_unique; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_versions
    ADD CONSTRAINT club_versions_club_version_unique UNIQUE (club_id, version_no);


--
-- Name: club_versions club_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_versions
    ADD CONSTRAINT club_versions_pkey PRIMARY KEY (id);


--
-- Name: clubs clubs_pkey; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.clubs
    ADD CONSTRAINT clubs_pkey PRIMARY KEY (id);


--
-- Name: clubs clubs_slug_unique; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.clubs
    ADD CONSTRAINT clubs_slug_unique UNIQUE (slug);


--
-- Name: consumed_account_registration_pow_challenges consumed_account_registration_pow_challenges_pkey; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.consumed_account_registration_pow_challenges
    ADD CONSTRAINT consumed_account_registration_pow_challenges_pkey PRIMARY KEY (challenge_id);


--
-- Name: consumed_pow_challenges consumed_pow_challenges_pkey; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.consumed_pow_challenges
    ADD CONSTRAINT consumed_pow_challenges_pkey PRIMARY KEY (challenge_id);


--
-- Name: content_embeddings content_embeddings_pkey; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.content_embeddings
    ADD CONSTRAINT content_embeddings_pkey PRIMARY KEY (id);


--
-- Name: content_embeddings content_embeddings_unique; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.content_embeddings
    ADD CONSTRAINT content_embeddings_unique UNIQUE (content_id, model, dimensions, source_version, chunk_index);


--
-- Name: content_threads content_threads_pkey; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.content_threads
    ADD CONSTRAINT content_threads_pkey PRIMARY KEY (id);


--
-- Name: content_version_mentions content_version_mentions_pkey; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.content_version_mentions
    ADD CONSTRAINT content_version_mentions_pkey PRIMARY KEY (content_version_id, field, start_offset);


--
-- Name: content_versions content_versions_content_version_unique; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.content_versions
    ADD CONSTRAINT content_versions_content_version_unique UNIQUE (content_id, version_no);


--
-- Name: content_versions content_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.content_versions
    ADD CONSTRAINT content_versions_pkey PRIMARY KEY (id);


--
-- Name: contents contents_pkey; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.contents
    ADD CONSTRAINT contents_pkey PRIMARY KEY (id);


--
-- Name: dm_inbox_entries dm_inbox_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.dm_inbox_entries
    ADD CONSTRAINT dm_inbox_entries_pkey PRIMARY KEY (id);


--
-- Name: dm_inbox_entries dm_inbox_entries_recipient_message_unique; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.dm_inbox_entries
    ADD CONSTRAINT dm_inbox_entries_recipient_message_unique UNIQUE (recipient_member_id, message_id);


--
-- Name: dm_message_mentions dm_message_mentions_pkey; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.dm_message_mentions
    ADD CONSTRAINT dm_message_mentions_pkey PRIMARY KEY (message_id, start_offset);


--
-- Name: dm_message_removals dm_message_removals_pkey; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.dm_message_removals
    ADD CONSTRAINT dm_message_removals_pkey PRIMARY KEY (message_id);


--
-- Name: dm_messages dm_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.dm_messages
    ADD CONSTRAINT dm_messages_pkey PRIMARY KEY (id);


--
-- Name: dm_thread_participants dm_thread_participants_pkey; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.dm_thread_participants
    ADD CONSTRAINT dm_thread_participants_pkey PRIMARY KEY (id);


--
-- Name: dm_thread_participants dm_thread_participants_unique; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.dm_thread_participants
    ADD CONSTRAINT dm_thread_participants_unique UNIQUE (thread_id, member_id);


--
-- Name: dm_threads dm_threads_pkey; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.dm_threads
    ADD CONSTRAINT dm_threads_pkey PRIMARY KEY (id);


--
-- Name: event_rsvps event_rsvps_event_content_membership_version_unique; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.event_rsvps
    ADD CONSTRAINT event_rsvps_event_content_membership_version_unique UNIQUE (event_content_id, membership_id, version_no);


--
-- Name: event_rsvps event_rsvps_pkey; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.event_rsvps
    ADD CONSTRAINT event_rsvps_pkey PRIMARY KEY (id);


--
-- Name: event_version_details event_version_details_pkey; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.event_version_details
    ADD CONSTRAINT event_version_details_pkey PRIMARY KEY (content_version_id);


--
-- Name: idempotency_keys idempotency_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.idempotency_keys
    ADD CONSTRAINT idempotency_keys_pkey PRIMARY KEY (client_key);


--
-- Name: invite_codes invite_codes_code_unique; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.invite_codes
    ADD CONSTRAINT invite_codes_code_unique UNIQUE (code);


--
-- Name: invite_codes invite_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.invite_codes
    ADD CONSTRAINT invite_codes_pkey PRIMARY KEY (invite_request_id);


--
-- Name: invite_requests invite_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.invite_requests
    ADD CONSTRAINT invite_requests_pkey PRIMARY KEY (id);


--
-- Name: member_bearer_tokens member_bearer_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.member_bearer_tokens
    ADD CONSTRAINT member_bearer_tokens_pkey PRIMARY KEY (id);


--
-- Name: member_bearer_tokens member_bearer_tokens_token_hash_unique; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.member_bearer_tokens
    ADD CONSTRAINT member_bearer_tokens_token_hash_unique UNIQUE (token_hash);


--
-- Name: member_club_profile_versions member_club_profile_versions_member_club_version_unique; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.member_club_profile_versions
    ADD CONSTRAINT member_club_profile_versions_member_club_version_unique UNIQUE (member_id, club_id, version_no);


--
-- Name: member_club_profile_versions member_club_profile_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.member_club_profile_versions
    ADD CONSTRAINT member_club_profile_versions_pkey PRIMARY KEY (id);


--
-- Name: member_global_role_versions member_global_role_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.member_global_role_versions
    ADD CONSTRAINT member_global_role_versions_pkey PRIMARY KEY (id);


--
-- Name: member_global_role_versions member_global_role_versions_version_unique; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.member_global_role_versions
    ADD CONSTRAINT member_global_role_versions_version_unique UNIQUE (member_id, role, version_no);


--
-- Name: member_notifications member_notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.member_notifications
    ADD CONSTRAINT member_notifications_pkey PRIMARY KEY (id);


--
-- Name: member_notifications member_notifications_seq_unique; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.member_notifications
    ADD CONSTRAINT member_notifications_seq_unique UNIQUE (seq);


--
-- Name: member_profile_embeddings member_profile_embeddings_pkey; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.member_profile_embeddings
    ADD CONSTRAINT member_profile_embeddings_pkey PRIMARY KEY (id);


--
-- Name: member_profile_embeddings member_profile_embeddings_unique; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.member_profile_embeddings
    ADD CONSTRAINT member_profile_embeddings_unique UNIQUE (member_id, club_id, model, dimensions, source_version, chunk_index);


--
-- Name: members members_pkey; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.members
    ADD CONSTRAINT members_pkey PRIMARY KEY (id);


--
-- Name: notification_producer_topics notification_producer_topics_pkey; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.notification_producer_topics
    ADD CONSTRAINT notification_producer_topics_pkey PRIMARY KEY (producer_id, topic);


--
-- Name: notification_producers notification_producers_pkey; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.notification_producers
    ADD CONSTRAINT notification_producers_pkey PRIMARY KEY (producer_id);


--
-- Name: notification_refs notification_refs_pkey; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.notification_refs
    ADD CONSTRAINT notification_refs_pkey PRIMARY KEY (notification_id, ref_role, ref_kind, ref_id);


--
-- Name: platform_stats platform_stats_pkey; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.platform_stats
    ADD CONSTRAINT platform_stats_pkey PRIMARY KEY (singleton);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (filename);


--
-- Name: worker_state worker_state_pkey; Type: CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.worker_state
    ADD CONSTRAINT worker_state_pkey PRIMARY KEY (worker_id, state_key);


--
-- Name: ai_club_spend_reservations_club_created_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX ai_club_spend_reservations_club_created_idx ON public.ai_club_spend_reservations USING btree (club_id, created_at DESC);


--
-- Name: ai_embedding_jobs_claimable_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX ai_embedding_jobs_claimable_idx ON public.ai_embedding_jobs USING btree (next_attempt_at) WHERE (state = ANY (ARRAY['queued'::text, 'budget_blocked'::text]));


--
-- Name: ai_llm_quota_reservations_member_club_created_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX ai_llm_quota_reservations_member_club_created_idx ON public.ai_llm_quota_reservations USING btree (member_id, club_id, created_at DESC);


--
-- Name: ai_llm_usage_log_club_created_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX ai_llm_usage_log_club_created_idx ON public.ai_llm_usage_log USING btree (requested_club_id, created_at DESC);


--
-- Name: ai_llm_usage_log_member_created_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX ai_llm_usage_log_member_created_idx ON public.ai_llm_usage_log USING btree (member_id, created_at DESC);


--
-- Name: ai_quota_event_log_member_action_created_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX ai_quota_event_log_member_action_created_idx ON public.ai_quota_event_log USING btree (member_id, action_name, created_at DESC);


--
-- Name: api_request_log_created_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX api_request_log_created_idx ON public.api_request_log USING btree (created_at DESC);


--
-- Name: api_request_log_member_created_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX api_request_log_member_created_idx ON public.api_request_log USING btree (member_id, created_at DESC);


--
-- Name: club_activity_club_seq_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX club_activity_club_seq_idx ON public.club_activity USING btree (club_id, seq);


--
-- Name: club_applicant_blocks_lookup_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX club_applicant_blocks_lookup_idx ON public.club_applicant_blocks USING btree (club_id, member_id);


--
-- Name: club_application_revisions_lookup_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX club_application_revisions_lookup_idx ON public.club_application_revisions USING btree (application_id, version_no DESC, created_at DESC);


--
-- Name: club_applications_applicant_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX club_applications_applicant_idx ON public.club_applications USING btree (applicant_member_id, submitted_at DESC, id DESC);


--
-- Name: club_applications_club_phase_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX club_applications_club_phase_idx ON public.club_applications USING btree (club_id, phase, submitted_at DESC, id DESC);


--
-- Name: club_applications_invitation_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX club_applications_invitation_idx ON public.club_applications USING btree (invitation_id) WHERE (invitation_id IS NOT NULL);


--
-- Name: club_applications_one_open_per_member_club; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE UNIQUE INDEX club_applications_one_open_per_member_club ON public.club_applications USING btree (club_id, applicant_member_id) WHERE (phase = ANY (ARRAY['revision_required'::text, 'awaiting_review'::text]));


--
-- Name: club_edges_club_kind_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX club_edges_club_kind_idx ON public.club_edges USING btree (club_id, kind, created_at DESC);


--
-- Name: club_edges_from_member_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX club_edges_from_member_idx ON public.club_edges USING btree (from_member_id, kind, created_at DESC);


--
-- Name: club_edges_idempotent_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE UNIQUE INDEX club_edges_idempotent_idx ON public.club_edges USING btree (created_by_member_id, client_key) WHERE (client_key IS NOT NULL);


--
-- Name: club_edges_to_content_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX club_edges_to_content_idx ON public.club_edges USING btree (to_content_id, kind, created_at DESC);


--
-- Name: club_edges_to_member_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX club_edges_to_member_idx ON public.club_edges USING btree (to_member_id, kind, created_at DESC);


--
-- Name: club_edges_unique_active_vouch; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE UNIQUE INDEX club_edges_unique_active_vouch ON public.club_edges USING btree (club_id, from_member_id, to_member_id) WHERE ((kind = 'vouched_for'::public.edge_kind) AND (archived_at IS NULL));


--
-- Name: club_membership_state_versions_lookup_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX club_membership_state_versions_lookup_idx ON public.club_membership_state_versions USING btree (membership_id, version_no DESC, created_at DESC);


--
-- Name: club_memberships_club_status_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX club_memberships_club_status_idx ON public.club_memberships USING btree (club_id, status);


--
-- Name: club_memberships_member_status_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX club_memberships_member_status_idx ON public.club_memberships USING btree (member_id, status);


--
-- Name: club_memberships_non_terminal_unique; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE UNIQUE INDEX club_memberships_non_terminal_unique ON public.club_memberships USING btree (club_id, member_id) WHERE (status = ANY (ARRAY['active'::public.membership_state, 'cancelled'::public.membership_state]));


--
-- Name: club_memberships_sponsor_joined_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX club_memberships_sponsor_joined_idx ON public.club_memberships USING btree (sponsor_member_id, joined_at);


--
-- Name: club_removal_archives_club_slug_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX club_removal_archives_club_slug_idx ON public.club_removal_archives USING btree (club_slug, removed_at DESC, id DESC);


--
-- Name: club_removal_archives_removed_at_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX club_removal_archives_removed_at_idx ON public.club_removal_archives USING btree (removed_at DESC, id DESC);


--
-- Name: club_subscriptions_membership_status_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX club_subscriptions_membership_status_idx ON public.club_subscriptions USING btree (membership_id, status);


--
-- Name: club_subscriptions_one_live_per_membership; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE UNIQUE INDEX club_subscriptions_one_live_per_membership ON public.club_subscriptions USING btree (membership_id) WHERE (status = ANY (ARRAY['active'::public.subscription_status, 'trialing'::public.subscription_status, 'past_due'::public.subscription_status]));


--
-- Name: club_subscriptions_payer_status_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX club_subscriptions_payer_status_idx ON public.club_subscriptions USING btree (payer_member_id, status);


--
-- Name: club_versions_club_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX club_versions_club_idx ON public.club_versions USING btree (club_id, version_no DESC, created_at DESC);


--
-- Name: consumed_pow_challenges_consumed_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX consumed_pow_challenges_consumed_idx ON public.consumed_pow_challenges USING btree (consumed_at);


--
-- Name: content_embeddings_content_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX content_embeddings_content_idx ON public.content_embeddings USING btree (content_id);


--
-- Name: content_embeddings_version_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX content_embeddings_version_idx ON public.content_embeddings USING btree (content_version_id);


--
-- Name: content_threads_club_activity_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX content_threads_club_activity_idx ON public.content_threads USING btree (club_id, last_activity_at DESC, id DESC) WHERE (archived_at IS NULL);


--
-- Name: content_threads_id_club_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE UNIQUE INDEX content_threads_id_club_idx ON public.content_threads USING btree (id, club_id);


--
-- Name: content_version_mentions_member_created_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX content_version_mentions_member_created_idx ON public.content_version_mentions USING btree (mentioned_member_id, created_at DESC);


--
-- Name: content_versions_content_version_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX content_versions_content_version_idx ON public.content_versions USING btree (content_id, version_no DESC);


--
-- Name: content_versions_effective_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX content_versions_effective_idx ON public.content_versions USING btree (effective_at DESC);


--
-- Name: content_versions_expires_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX content_versions_expires_idx ON public.content_versions USING btree (expires_at);


--
-- Name: contents_author_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX contents_author_idx ON public.contents USING btree (author_member_id, created_at DESC);


--
-- Name: contents_club_kind_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX contents_club_kind_idx ON public.contents USING btree (club_id, kind, created_at DESC);


--
-- Name: contents_idempotent_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE UNIQUE INDEX contents_idempotent_idx ON public.contents USING btree (author_member_id, client_key) WHERE (client_key IS NOT NULL);


--
-- Name: contents_live_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX contents_live_idx ON public.contents USING btree (club_id, kind) WHERE ((archived_at IS NULL) AND (deleted_at IS NULL));


--
-- Name: contents_thread_created_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX contents_thread_created_idx ON public.contents USING btree (thread_id, created_at, id) WHERE ((archived_at IS NULL) AND (deleted_at IS NULL));


--
-- Name: dm_inbox_entries_recipient_created_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX dm_inbox_entries_recipient_created_idx ON public.dm_inbox_entries USING btree (recipient_member_id, created_at DESC);


--
-- Name: dm_inbox_entries_unread_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX dm_inbox_entries_unread_idx ON public.dm_inbox_entries USING btree (recipient_member_id) WHERE (acknowledged = false);


--
-- Name: dm_inbox_entries_unread_poll_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX dm_inbox_entries_unread_poll_idx ON public.dm_inbox_entries USING btree (recipient_member_id, created_at) WHERE (acknowledged = false);


--
-- Name: dm_inbox_entries_unread_thread_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX dm_inbox_entries_unread_thread_idx ON public.dm_inbox_entries USING btree (recipient_member_id, thread_id) WHERE (acknowledged = false);


--
-- Name: dm_message_mentions_member_created_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX dm_message_mentions_member_created_idx ON public.dm_message_mentions USING btree (mentioned_member_id, created_at DESC);


--
-- Name: dm_messages_idempotent_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE UNIQUE INDEX dm_messages_idempotent_idx ON public.dm_messages USING btree (sender_member_id, client_key) WHERE (client_key IS NOT NULL);


--
-- Name: dm_messages_sender_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX dm_messages_sender_idx ON public.dm_messages USING btree (sender_member_id, created_at DESC);


--
-- Name: dm_messages_thread_created_asc_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX dm_messages_thread_created_asc_idx ON public.dm_messages USING btree (thread_id, created_at);


--
-- Name: dm_messages_thread_created_desc_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX dm_messages_thread_created_desc_idx ON public.dm_messages USING btree (thread_id, created_at DESC, id DESC);


--
-- Name: dm_thread_participants_member_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX dm_thread_participants_member_idx ON public.dm_thread_participants USING btree (member_id, thread_id);


--
-- Name: dm_threads_created_by_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX dm_threads_created_by_idx ON public.dm_threads USING btree (created_by_member_id, created_at DESC);


--
-- Name: dm_threads_direct_pair_unique_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE UNIQUE INDEX dm_threads_direct_pair_unique_idx ON public.dm_threads USING btree (kind, member_a_id, member_b_id) WHERE ((kind = 'direct'::public.thread_kind) AND (archived_at IS NULL));


--
-- Name: event_rsvps_event_content_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX event_rsvps_event_content_idx ON public.event_rsvps USING btree (event_content_id, response);


--
-- Name: event_rsvps_event_content_membership_version_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX event_rsvps_event_content_membership_version_idx ON public.event_rsvps USING btree (event_content_id, membership_id, version_no DESC, created_at DESC);


--
-- Name: event_rsvps_idempotent_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE UNIQUE INDEX event_rsvps_idempotent_idx ON public.event_rsvps USING btree (created_by_member_id, client_key) WHERE (client_key IS NOT NULL);


--
-- Name: event_rsvps_membership_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX event_rsvps_membership_idx ON public.event_rsvps USING btree (membership_id, created_at DESC);


--
-- Name: event_version_details_starts_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX event_version_details_starts_idx ON public.event_version_details USING btree (starts_at);


--
-- Name: idempotency_keys_expiry_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX idempotency_keys_expiry_idx ON public.idempotency_keys USING btree (expires_at);


--
-- Name: invite_requests_candidate_lookup_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX invite_requests_candidate_lookup_idx ON public.invite_requests USING btree (club_id, candidate_email_normalized, created_at DESC);


--
-- Name: invite_requests_open_candidate_member_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX invite_requests_open_candidate_member_idx ON public.invite_requests USING btree (club_id, candidate_member_id, created_at DESC, id DESC) WHERE ((candidate_member_id IS NOT NULL) AND (revoked_at IS NULL) AND (used_at IS NULL) AND (expired_at IS NULL));


--
-- Name: invite_requests_open_per_sponsor_email_candidate_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE UNIQUE INDEX invite_requests_open_per_sponsor_email_candidate_idx ON public.invite_requests USING btree (club_id, sponsor_member_id, candidate_email_normalized) WHERE ((candidate_member_id IS NULL) AND (revoked_at IS NULL) AND (used_at IS NULL) AND (expired_at IS NULL));


--
-- Name: invite_requests_open_per_sponsor_member_candidate_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE UNIQUE INDEX invite_requests_open_per_sponsor_member_candidate_idx ON public.invite_requests USING btree (club_id, sponsor_member_id, candidate_member_id) WHERE ((candidate_member_id IS NOT NULL) AND (revoked_at IS NULL) AND (used_at IS NULL) AND (expired_at IS NULL));


--
-- Name: member_bearer_tokens_active_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX member_bearer_tokens_active_idx ON public.member_bearer_tokens USING btree (id) WHERE (revoked_at IS NULL);


--
-- Name: member_bearer_tokens_member_created_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX member_bearer_tokens_member_created_idx ON public.member_bearer_tokens USING btree (member_id, created_at DESC);


--
-- Name: member_club_profile_versions_club_member_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX member_club_profile_versions_club_member_idx ON public.member_club_profile_versions USING btree (club_id, member_id, version_no DESC);


--
-- Name: member_club_profile_versions_member_club_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX member_club_profile_versions_member_club_idx ON public.member_club_profile_versions USING btree (member_id, club_id, version_no DESC);


--
-- Name: member_club_profile_versions_membership_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX member_club_profile_versions_membership_idx ON public.member_club_profile_versions USING btree (membership_id, version_no DESC);


--
-- Name: member_club_profile_versions_search_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX member_club_profile_versions_search_idx ON public.member_club_profile_versions USING gin (search_vector);


--
-- Name: member_global_role_versions_lookup_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX member_global_role_versions_lookup_idx ON public.member_global_role_versions USING btree (member_id, role, version_no DESC, created_at DESC);


--
-- Name: member_notifications_expires_unacked_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX member_notifications_expires_unacked_idx ON public.member_notifications USING btree (expires_at) WHERE ((expires_at IS NOT NULL) AND (acknowledged_at IS NULL));


--
-- Name: member_notifications_producer_idempotency_unique_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE UNIQUE INDEX member_notifications_producer_idempotency_unique_idx ON public.member_notifications USING btree (producer_id, idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: member_notifications_producer_topic_seq_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX member_notifications_producer_topic_seq_idx ON public.member_notifications USING btree (producer_id, topic, seq);


--
-- Name: member_notifications_recipient_club_seq_unacked_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX member_notifications_recipient_club_seq_unacked_idx ON public.member_notifications USING btree (recipient_member_id, club_id, seq) WHERE (acknowledged_at IS NULL);


--
-- Name: member_notifications_recipient_seq_unacked_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX member_notifications_recipient_seq_unacked_idx ON public.member_notifications USING btree (recipient_member_id, seq) WHERE (acknowledged_at IS NULL);


--
-- Name: member_profile_embeddings_club_member_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX member_profile_embeddings_club_member_idx ON public.member_profile_embeddings USING btree (club_id, member_id);


--
-- Name: member_profile_embeddings_member_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX member_profile_embeddings_member_idx ON public.member_profile_embeddings USING btree (member_id);


--
-- Name: member_profile_embeddings_version_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX member_profile_embeddings_version_idx ON public.member_profile_embeddings USING btree (profile_version_id);


--
-- Name: members_email_unique; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE UNIQUE INDEX members_email_unique ON public.members USING btree (lower(email));


--
-- Name: members_state_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX members_state_idx ON public.members USING btree (state);


--
-- Name: notification_delivery_counters_scope_unique; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE UNIQUE INDEX notification_delivery_counters_scope_unique ON public.notification_delivery_counters USING btree (producer_id, recipient_member_id, delivery_class, window_kind, window_start) NULLS NOT DISTINCT;


--
-- Name: notification_refs_entity_idx; Type: INDEX; Schema: public; Owner: clawclub_app
--

CREATE INDEX notification_refs_entity_idx ON public.notification_refs USING btree (ref_kind, ref_id);


--
-- Name: club_activity club_activity_notify; Type: TRIGGER; Schema: public; Owner: clawclub_app
--

CREATE TRIGGER club_activity_notify AFTER INSERT ON public.club_activity FOR EACH ROW EXECUTE FUNCTION public.notify_club_activity();


--
-- Name: club_application_revisions club_application_revisions_immutable; Type: TRIGGER; Schema: public; Owner: clawclub_app
--

CREATE TRIGGER club_application_revisions_immutable BEFORE DELETE OR UPDATE ON public.club_application_revisions FOR EACH ROW EXECUTE FUNCTION public.reject_row_mutation();


--
-- Name: club_applications club_applications_platform_stats; Type: TRIGGER; Schema: public; Owner: clawclub_app
--

CREATE TRIGGER club_applications_platform_stats AFTER INSERT OR DELETE OR UPDATE OF phase ON public.club_applications FOR EACH ROW EXECUTE FUNCTION public.bump_platform_stats_applications();


--
-- Name: club_membership_state_versions club_membership_state_versions_immutable; Type: TRIGGER; Schema: public; Owner: clawclub_app
--

CREATE TRIGGER club_membership_state_versions_immutable BEFORE DELETE OR UPDATE ON public.club_membership_state_versions FOR EACH ROW EXECUTE FUNCTION public.reject_row_mutation();


--
-- Name: club_membership_state_versions club_membership_state_versions_sync; Type: TRIGGER; Schema: public; Owner: clawclub_app
--

CREATE TRIGGER club_membership_state_versions_sync AFTER INSERT ON public.club_membership_state_versions FOR EACH ROW EXECUTE FUNCTION public.sync_club_membership_state();


--
-- Name: club_memberships club_memberships_guard; Type: TRIGGER; Schema: public; Owner: clawclub_app
--

CREATE TRIGGER club_memberships_guard BEFORE UPDATE ON public.club_memberships FOR EACH ROW EXECUTE FUNCTION public.lock_club_membership_mutation();


--
-- Name: club_memberships club_memberships_require_profile_version_trigger; Type: TRIGGER; Schema: public; Owner: clawclub_app
--

CREATE CONSTRAINT TRIGGER club_memberships_require_profile_version_trigger AFTER INSERT ON public.club_memberships DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.club_memberships_require_profile_version();


--
-- Name: club_versions club_versions_normalize_admission_policy; Type: TRIGGER; Schema: public; Owner: clawclub_app
--

CREATE TRIGGER club_versions_normalize_admission_policy BEFORE INSERT OR UPDATE OF admission_policy ON public.club_versions FOR EACH ROW EXECUTE FUNCTION public.normalize_admission_policy();


--
-- Name: club_versions club_versions_sync; Type: TRIGGER; Schema: public; Owner: clawclub_app
--

CREATE TRIGGER club_versions_sync AFTER INSERT ON public.club_versions FOR EACH ROW EXECUTE FUNCTION public.sync_club_version_to_club();


--
-- Name: clubs clubs_normalize_admission_policy; Type: TRIGGER; Schema: public; Owner: clawclub_app
--

CREATE TRIGGER clubs_normalize_admission_policy BEFORE INSERT OR UPDATE OF admission_policy ON public.clubs FOR EACH ROW EXECUTE FUNCTION public.normalize_admission_policy();


--
-- Name: clubs clubs_platform_stats; Type: TRIGGER; Schema: public; Owner: clawclub_app
--

CREATE TRIGGER clubs_platform_stats AFTER INSERT OR DELETE OR UPDATE OF archived_at ON public.clubs FOR EACH ROW EXECUTE FUNCTION public.bump_platform_stats_clubs();


--
-- Name: clubs clubs_versioned_field_lock; Type: TRIGGER; Schema: public; Owner: clawclub_app
--

CREATE TRIGGER clubs_versioned_field_lock BEFORE UPDATE ON public.clubs FOR EACH ROW EXECUTE FUNCTION public.lock_club_versioned_mutation();


--
-- Name: content_versions content_versions_immutable; Type: TRIGGER; Schema: public; Owner: clawclub_app
--

CREATE TRIGGER content_versions_immutable BEFORE DELETE OR UPDATE ON public.content_versions FOR EACH ROW EXECUTE FUNCTION public.reject_row_mutation();


--
-- Name: contents contents_platform_stats; Type: TRIGGER; Schema: public; Owner: clawclub_app
--

CREATE TRIGGER contents_platform_stats AFTER INSERT OR DELETE OR UPDATE OF deleted_at ON public.contents FOR EACH ROW EXECUTE FUNCTION public.bump_platform_stats_contents();


--
-- Name: dm_inbox_entries dm_inbox_entries_notify; Type: TRIGGER; Schema: public; Owner: clawclub_app
--

CREATE TRIGGER dm_inbox_entries_notify AFTER INSERT ON public.dm_inbox_entries FOR EACH ROW EXECUTE FUNCTION public.notify_dm_inbox();


--
-- Name: dm_messages dm_messages_platform_stats; Type: TRIGGER; Schema: public; Owner: clawclub_app
--

CREATE TRIGGER dm_messages_platform_stats AFTER INSERT OR DELETE ON public.dm_messages FOR EACH ROW EXECUTE FUNCTION public.bump_platform_stats_messages();


--
-- Name: member_club_profile_versions member_club_profile_versions_check_membership_trigger; Type: TRIGGER; Schema: public; Owner: clawclub_app
--

CREATE TRIGGER member_club_profile_versions_check_membership_trigger BEFORE INSERT ON public.member_club_profile_versions FOR EACH ROW EXECUTE FUNCTION public.member_club_profile_versions_check_membership();


--
-- Name: member_club_profile_versions member_club_profile_versions_immutable; Type: TRIGGER; Schema: public; Owner: clawclub_app
--

CREATE TRIGGER member_club_profile_versions_immutable BEFORE DELETE OR UPDATE ON public.member_club_profile_versions FOR EACH ROW EXECUTE FUNCTION public.reject_row_mutation();


--
-- Name: member_club_profile_versions member_club_profile_versions_search_vector_insert; Type: TRIGGER; Schema: public; Owner: clawclub_app
--

CREATE TRIGGER member_club_profile_versions_search_vector_insert BEFORE INSERT ON public.member_club_profile_versions FOR EACH ROW EXECUTE FUNCTION public.member_club_profile_versions_search_vector_trigger();


--
-- Name: member_notifications member_notifications_notify; Type: TRIGGER; Schema: public; Owner: clawclub_app
--

CREATE TRIGGER member_notifications_notify AFTER INSERT ON public.member_notifications FOR EACH ROW EXECUTE FUNCTION public.notify_member_notification();


--
-- Name: members members_platform_stats; Type: TRIGGER; Schema: public; Owner: clawclub_app
--

CREATE TRIGGER members_platform_stats AFTER INSERT OR DELETE OR UPDATE OF state ON public.members FOR EACH ROW EXECUTE FUNCTION public.bump_platform_stats_members();


--
-- Name: ai_club_spend_reservations ai_club_spend_reservations_club_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.ai_club_spend_reservations
    ADD CONSTRAINT ai_club_spend_reservations_club_fkey FOREIGN KEY (club_id) REFERENCES public.clubs(id) ON DELETE CASCADE;


--
-- Name: ai_club_spend_reservations ai_club_spend_reservations_member_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.ai_club_spend_reservations
    ADD CONSTRAINT ai_club_spend_reservations_member_fkey FOREIGN KEY (member_id) REFERENCES public.members(id);


--
-- Name: ai_llm_quota_reservations ai_llm_quota_reservations_club_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.ai_llm_quota_reservations
    ADD CONSTRAINT ai_llm_quota_reservations_club_fkey FOREIGN KEY (club_id) REFERENCES public.clubs(id) ON DELETE CASCADE;


--
-- Name: ai_llm_quota_reservations ai_llm_quota_reservations_member_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.ai_llm_quota_reservations
    ADD CONSTRAINT ai_llm_quota_reservations_member_fkey FOREIGN KEY (member_id) REFERENCES public.members(id);


--
-- Name: ai_llm_usage_log ai_llm_usage_log_club_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.ai_llm_usage_log
    ADD CONSTRAINT ai_llm_usage_log_club_fkey FOREIGN KEY (requested_club_id) REFERENCES public.clubs(id) ON DELETE SET NULL;


--
-- Name: ai_llm_usage_log ai_llm_usage_log_member_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.ai_llm_usage_log
    ADD CONSTRAINT ai_llm_usage_log_member_fkey FOREIGN KEY (member_id) REFERENCES public.members(id);


--
-- Name: ai_quota_event_log ai_quota_event_log_member_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.ai_quota_event_log
    ADD CONSTRAINT ai_quota_event_log_member_fkey FOREIGN KEY (member_id) REFERENCES public.members(id);


--
-- Name: api_request_log api_request_log_member_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.api_request_log
    ADD CONSTRAINT api_request_log_member_fkey FOREIGN KEY (member_id) REFERENCES public.members(id) ON DELETE SET NULL;


--
-- Name: club_activity club_activity_club_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_activity
    ADD CONSTRAINT club_activity_club_fkey FOREIGN KEY (club_id) REFERENCES public.clubs(id) ON DELETE CASCADE;


--
-- Name: club_activity club_activity_content_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_activity
    ADD CONSTRAINT club_activity_content_fkey FOREIGN KEY (content_id) REFERENCES public.contents(id) ON DELETE CASCADE;


--
-- Name: club_activity club_activity_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_activity
    ADD CONSTRAINT club_activity_created_by_fkey FOREIGN KEY (created_by_member_id) REFERENCES public.members(id);


--
-- Name: club_activity_cursors club_activity_cursors_club_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_activity_cursors
    ADD CONSTRAINT club_activity_cursors_club_fkey FOREIGN KEY (club_id) REFERENCES public.clubs(id) ON DELETE CASCADE;


--
-- Name: club_activity_cursors club_activity_cursors_member_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_activity_cursors
    ADD CONSTRAINT club_activity_cursors_member_fkey FOREIGN KEY (member_id) REFERENCES public.members(id) ON DELETE CASCADE;


--
-- Name: club_applicant_blocks club_applicant_blocks_club_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_applicant_blocks
    ADD CONSTRAINT club_applicant_blocks_club_id_fkey FOREIGN KEY (club_id) REFERENCES public.clubs(id) ON DELETE CASCADE;


--
-- Name: club_applicant_blocks club_applicant_blocks_created_by_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_applicant_blocks
    ADD CONSTRAINT club_applicant_blocks_created_by_member_id_fkey FOREIGN KEY (created_by_member_id) REFERENCES public.members(id) ON DELETE SET NULL;


--
-- Name: club_applicant_blocks club_applicant_blocks_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_applicant_blocks
    ADD CONSTRAINT club_applicant_blocks_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.members(id) ON DELETE CASCADE;


--
-- Name: club_application_revisions club_application_revisions_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_application_revisions
    ADD CONSTRAINT club_application_revisions_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.club_applications(id) ON DELETE CASCADE;


--
-- Name: club_application_revisions club_application_revisions_created_by_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_application_revisions
    ADD CONSTRAINT club_application_revisions_created_by_member_id_fkey FOREIGN KEY (created_by_member_id) REFERENCES public.members(id) ON DELETE SET NULL;


--
-- Name: club_applications club_applications_activated_membership_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_applications
    ADD CONSTRAINT club_applications_activated_membership_id_fkey FOREIGN KEY (activated_membership_id) REFERENCES public.club_memberships(id) ON DELETE SET NULL;


--
-- Name: club_applications club_applications_applicant_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_applications
    ADD CONSTRAINT club_applications_applicant_member_id_fkey FOREIGN KEY (applicant_member_id) REFERENCES public.members(id) ON DELETE CASCADE;


--
-- Name: club_applications club_applications_club_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_applications
    ADD CONSTRAINT club_applications_club_id_fkey FOREIGN KEY (club_id) REFERENCES public.clubs(id) ON DELETE CASCADE;


--
-- Name: club_applications club_applications_decided_by_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_applications
    ADD CONSTRAINT club_applications_decided_by_member_id_fkey FOREIGN KEY (decided_by_member_id) REFERENCES public.members(id) ON DELETE SET NULL;


--
-- Name: club_applications club_applications_invitation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_applications
    ADD CONSTRAINT club_applications_invitation_id_fkey FOREIGN KEY (invitation_id) REFERENCES public.invite_requests(id) ON DELETE SET NULL;


--
-- Name: club_applications club_applications_sponsor_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_applications
    ADD CONSTRAINT club_applications_sponsor_member_id_fkey FOREIGN KEY (sponsor_member_id) REFERENCES public.members(id) ON DELETE SET NULL;


--
-- Name: club_edges club_edges_club_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_edges
    ADD CONSTRAINT club_edges_club_fkey FOREIGN KEY (club_id) REFERENCES public.clubs(id) ON DELETE CASCADE;


--
-- Name: club_edges club_edges_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_edges
    ADD CONSTRAINT club_edges_created_by_fkey FOREIGN KEY (created_by_member_id) REFERENCES public.members(id);


--
-- Name: club_edges club_edges_from_content_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_edges
    ADD CONSTRAINT club_edges_from_content_fkey FOREIGN KEY (from_content_id) REFERENCES public.contents(id) ON DELETE CASCADE;


--
-- Name: club_edges club_edges_from_content_version_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_edges
    ADD CONSTRAINT club_edges_from_content_version_fkey FOREIGN KEY (from_content_version_id) REFERENCES public.content_versions(id) ON DELETE CASCADE;


--
-- Name: club_edges club_edges_from_member_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_edges
    ADD CONSTRAINT club_edges_from_member_fkey FOREIGN KEY (from_member_id) REFERENCES public.members(id);


--
-- Name: club_edges club_edges_to_content_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_edges
    ADD CONSTRAINT club_edges_to_content_fkey FOREIGN KEY (to_content_id) REFERENCES public.contents(id) ON DELETE CASCADE;


--
-- Name: club_edges club_edges_to_content_version_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_edges
    ADD CONSTRAINT club_edges_to_content_version_fkey FOREIGN KEY (to_content_version_id) REFERENCES public.content_versions(id) ON DELETE CASCADE;


--
-- Name: club_edges club_edges_to_member_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_edges
    ADD CONSTRAINT club_edges_to_member_fkey FOREIGN KEY (to_member_id) REFERENCES public.members(id);


--
-- Name: club_membership_state_versions club_membership_state_versions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_membership_state_versions
    ADD CONSTRAINT club_membership_state_versions_created_by_fkey FOREIGN KEY (created_by_member_id) REFERENCES public.members(id);


--
-- Name: club_membership_state_versions club_membership_state_versions_membership_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_membership_state_versions
    ADD CONSTRAINT club_membership_state_versions_membership_fkey FOREIGN KEY (membership_id) REFERENCES public.club_memberships(id) ON DELETE CASCADE;


--
-- Name: club_membership_state_versions club_membership_state_versions_supersedes_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_membership_state_versions
    ADD CONSTRAINT club_membership_state_versions_supersedes_fkey FOREIGN KEY (supersedes_state_version_id) REFERENCES public.club_membership_state_versions(id) ON DELETE CASCADE;


--
-- Name: club_memberships club_memberships_club_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_memberships
    ADD CONSTRAINT club_memberships_club_fkey FOREIGN KEY (club_id) REFERENCES public.clubs(id) ON DELETE CASCADE;


--
-- Name: club_memberships club_memberships_comped_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_memberships
    ADD CONSTRAINT club_memberships_comped_by_fkey FOREIGN KEY (comped_by_member_id) REFERENCES public.members(id);


--
-- Name: club_memberships club_memberships_invitation_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_memberships
    ADD CONSTRAINT club_memberships_invitation_fkey FOREIGN KEY (invitation_id) REFERENCES public.invite_requests(id);


--
-- Name: club_memberships club_memberships_member_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_memberships
    ADD CONSTRAINT club_memberships_member_fkey FOREIGN KEY (member_id) REFERENCES public.members(id);


--
-- Name: club_memberships club_memberships_sponsor_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_memberships
    ADD CONSTRAINT club_memberships_sponsor_fkey FOREIGN KEY (sponsor_member_id) REFERENCES public.members(id);


--
-- Name: club_removal_archives club_removal_archives_removed_by_member_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_removal_archives
    ADD CONSTRAINT club_removal_archives_removed_by_member_fkey FOREIGN KEY (removed_by_member_id) REFERENCES public.members(id) ON DELETE SET NULL;


--
-- Name: club_subscriptions club_subscriptions_membership_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_subscriptions
    ADD CONSTRAINT club_subscriptions_membership_fkey FOREIGN KEY (membership_id) REFERENCES public.club_memberships(id) ON DELETE CASCADE;


--
-- Name: club_subscriptions club_subscriptions_payer_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_subscriptions
    ADD CONSTRAINT club_subscriptions_payer_fkey FOREIGN KEY (payer_member_id) REFERENCES public.members(id);


--
-- Name: club_versions club_versions_club_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_versions
    ADD CONSTRAINT club_versions_club_fkey FOREIGN KEY (club_id) REFERENCES public.clubs(id) ON DELETE CASCADE;


--
-- Name: club_versions club_versions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_versions
    ADD CONSTRAINT club_versions_created_by_fkey FOREIGN KEY (created_by_member_id) REFERENCES public.members(id);


--
-- Name: club_versions club_versions_owner_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_versions
    ADD CONSTRAINT club_versions_owner_fkey FOREIGN KEY (owner_member_id) REFERENCES public.members(id);


--
-- Name: club_versions club_versions_supersedes_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.club_versions
    ADD CONSTRAINT club_versions_supersedes_fkey FOREIGN KEY (supersedes_version_id) REFERENCES public.club_versions(id) ON DELETE CASCADE;


--
-- Name: clubs clubs_owner_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.clubs
    ADD CONSTRAINT clubs_owner_fkey FOREIGN KEY (owner_member_id) REFERENCES public.members(id);


--
-- Name: consumed_pow_challenges consumed_pow_challenges_club_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.consumed_pow_challenges
    ADD CONSTRAINT consumed_pow_challenges_club_fkey FOREIGN KEY (club_id) REFERENCES public.clubs(id) ON DELETE CASCADE;


--
-- Name: content_embeddings content_embeddings_content_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.content_embeddings
    ADD CONSTRAINT content_embeddings_content_fkey FOREIGN KEY (content_id) REFERENCES public.contents(id) ON DELETE CASCADE;


--
-- Name: content_embeddings content_embeddings_version_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.content_embeddings
    ADD CONSTRAINT content_embeddings_version_fkey FOREIGN KEY (content_version_id) REFERENCES public.content_versions(id) ON DELETE CASCADE;


--
-- Name: content_threads content_threads_club_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.content_threads
    ADD CONSTRAINT content_threads_club_fkey FOREIGN KEY (club_id) REFERENCES public.clubs(id) ON DELETE CASCADE;


--
-- Name: content_threads content_threads_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.content_threads
    ADD CONSTRAINT content_threads_created_by_fkey FOREIGN KEY (created_by_member_id) REFERENCES public.members(id);


--
-- Name: content_version_mentions content_version_mentions_member_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.content_version_mentions
    ADD CONSTRAINT content_version_mentions_member_fkey FOREIGN KEY (mentioned_member_id) REFERENCES public.members(id);


--
-- Name: content_version_mentions content_version_mentions_version_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.content_version_mentions
    ADD CONSTRAINT content_version_mentions_version_fkey FOREIGN KEY (content_version_id) REFERENCES public.content_versions(id) ON DELETE CASCADE;


--
-- Name: content_versions content_versions_content_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.content_versions
    ADD CONSTRAINT content_versions_content_fkey FOREIGN KEY (content_id) REFERENCES public.contents(id) ON DELETE CASCADE;


--
-- Name: content_versions content_versions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.content_versions
    ADD CONSTRAINT content_versions_created_by_fkey FOREIGN KEY (created_by_member_id) REFERENCES public.members(id);


--
-- Name: content_versions content_versions_supersedes_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.content_versions
    ADD CONSTRAINT content_versions_supersedes_fkey FOREIGN KEY (supersedes_version_id) REFERENCES public.content_versions(id) ON DELETE CASCADE;


--
-- Name: contents contents_author_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.contents
    ADD CONSTRAINT contents_author_fkey FOREIGN KEY (author_member_id) REFERENCES public.members(id);


--
-- Name: contents contents_club_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.contents
    ADD CONSTRAINT contents_club_fkey FOREIGN KEY (club_id) REFERENCES public.clubs(id) ON DELETE CASCADE;


--
-- Name: contents contents_thread_same_club_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.contents
    ADD CONSTRAINT contents_thread_same_club_fkey FOREIGN KEY (thread_id, club_id) REFERENCES public.content_threads(id, club_id);


--
-- Name: dm_inbox_entries dm_inbox_entries_message_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.dm_inbox_entries
    ADD CONSTRAINT dm_inbox_entries_message_fkey FOREIGN KEY (message_id) REFERENCES public.dm_messages(id);


--
-- Name: dm_inbox_entries dm_inbox_entries_recipient_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.dm_inbox_entries
    ADD CONSTRAINT dm_inbox_entries_recipient_fkey FOREIGN KEY (recipient_member_id) REFERENCES public.members(id);


--
-- Name: dm_inbox_entries dm_inbox_entries_thread_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.dm_inbox_entries
    ADD CONSTRAINT dm_inbox_entries_thread_fkey FOREIGN KEY (thread_id) REFERENCES public.dm_threads(id);


--
-- Name: dm_message_mentions dm_message_mentions_member_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.dm_message_mentions
    ADD CONSTRAINT dm_message_mentions_member_fkey FOREIGN KEY (mentioned_member_id) REFERENCES public.members(id);


--
-- Name: dm_message_mentions dm_message_mentions_message_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.dm_message_mentions
    ADD CONSTRAINT dm_message_mentions_message_fkey FOREIGN KEY (message_id) REFERENCES public.dm_messages(id);


--
-- Name: dm_message_removals dm_message_removals_message_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.dm_message_removals
    ADD CONSTRAINT dm_message_removals_message_fkey FOREIGN KEY (message_id) REFERENCES public.dm_messages(id);


--
-- Name: dm_message_removals dm_message_removals_removed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.dm_message_removals
    ADD CONSTRAINT dm_message_removals_removed_by_fkey FOREIGN KEY (removed_by_member_id) REFERENCES public.members(id);


--
-- Name: dm_messages dm_messages_reply_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.dm_messages
    ADD CONSTRAINT dm_messages_reply_fkey FOREIGN KEY (in_reply_to_message_id) REFERENCES public.dm_messages(id);


--
-- Name: dm_messages dm_messages_sender_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.dm_messages
    ADD CONSTRAINT dm_messages_sender_fkey FOREIGN KEY (sender_member_id) REFERENCES public.members(id);


--
-- Name: dm_messages dm_messages_thread_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.dm_messages
    ADD CONSTRAINT dm_messages_thread_fkey FOREIGN KEY (thread_id) REFERENCES public.dm_threads(id);


--
-- Name: dm_thread_participants dm_thread_participants_member_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.dm_thread_participants
    ADD CONSTRAINT dm_thread_participants_member_fkey FOREIGN KEY (member_id) REFERENCES public.members(id);


--
-- Name: dm_thread_participants dm_thread_participants_thread_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.dm_thread_participants
    ADD CONSTRAINT dm_thread_participants_thread_fkey FOREIGN KEY (thread_id) REFERENCES public.dm_threads(id);


--
-- Name: dm_threads dm_threads_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.dm_threads
    ADD CONSTRAINT dm_threads_created_by_fkey FOREIGN KEY (created_by_member_id) REFERENCES public.members(id);


--
-- Name: dm_threads dm_threads_member_a_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.dm_threads
    ADD CONSTRAINT dm_threads_member_a_fkey FOREIGN KEY (member_a_id) REFERENCES public.members(id);


--
-- Name: dm_threads dm_threads_member_b_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.dm_threads
    ADD CONSTRAINT dm_threads_member_b_fkey FOREIGN KEY (member_b_id) REFERENCES public.members(id);


--
-- Name: dm_threads dm_threads_subject_content_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.dm_threads
    ADD CONSTRAINT dm_threads_subject_content_fkey FOREIGN KEY (subject_content_id) REFERENCES public.contents(id) ON DELETE SET NULL;


--
-- Name: event_rsvps event_rsvps_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.event_rsvps
    ADD CONSTRAINT event_rsvps_created_by_fkey FOREIGN KEY (created_by_member_id) REFERENCES public.members(id);


--
-- Name: event_rsvps event_rsvps_event_content_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.event_rsvps
    ADD CONSTRAINT event_rsvps_event_content_fkey FOREIGN KEY (event_content_id) REFERENCES public.contents(id) ON DELETE CASCADE;


--
-- Name: event_rsvps event_rsvps_membership_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.event_rsvps
    ADD CONSTRAINT event_rsvps_membership_fkey FOREIGN KEY (membership_id) REFERENCES public.club_memberships(id) ON DELETE CASCADE;


--
-- Name: event_rsvps event_rsvps_supersedes_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.event_rsvps
    ADD CONSTRAINT event_rsvps_supersedes_fkey FOREIGN KEY (supersedes_rsvp_id) REFERENCES public.event_rsvps(id) ON DELETE CASCADE;


--
-- Name: event_version_details event_version_details_content_version_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.event_version_details
    ADD CONSTRAINT event_version_details_content_version_fkey FOREIGN KEY (content_version_id) REFERENCES public.content_versions(id) ON DELETE CASCADE;


--
-- Name: invite_codes invite_codes_invite_request_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.invite_codes
    ADD CONSTRAINT invite_codes_invite_request_fkey FOREIGN KEY (invite_request_id) REFERENCES public.invite_requests(id) ON DELETE CASCADE;


--
-- Name: invite_requests invite_requests_candidate_member_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.invite_requests
    ADD CONSTRAINT invite_requests_candidate_member_fkey FOREIGN KEY (candidate_member_id) REFERENCES public.members(id) ON DELETE SET NULL;


--
-- Name: invite_requests invite_requests_club_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.invite_requests
    ADD CONSTRAINT invite_requests_club_fkey FOREIGN KEY (club_id) REFERENCES public.clubs(id) ON DELETE CASCADE;


--
-- Name: invite_requests invite_requests_sponsor_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.invite_requests
    ADD CONSTRAINT invite_requests_sponsor_fkey FOREIGN KEY (sponsor_member_id) REFERENCES public.members(id) ON DELETE SET NULL;


--
-- Name: invite_requests invite_requests_used_membership_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.invite_requests
    ADD CONSTRAINT invite_requests_used_membership_fkey FOREIGN KEY (used_membership_id) REFERENCES public.club_memberships(id) ON DELETE SET NULL;


--
-- Name: member_bearer_tokens member_bearer_tokens_member_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.member_bearer_tokens
    ADD CONSTRAINT member_bearer_tokens_member_fkey FOREIGN KEY (member_id) REFERENCES public.members(id) ON DELETE CASCADE;


--
-- Name: member_club_profile_versions member_club_profile_versions_club_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.member_club_profile_versions
    ADD CONSTRAINT member_club_profile_versions_club_fkey FOREIGN KEY (club_id) REFERENCES public.clubs(id) ON DELETE CASCADE;


--
-- Name: member_club_profile_versions member_club_profile_versions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.member_club_profile_versions
    ADD CONSTRAINT member_club_profile_versions_created_by_fkey FOREIGN KEY (created_by_member_id) REFERENCES public.members(id);


--
-- Name: member_club_profile_versions member_club_profile_versions_member_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.member_club_profile_versions
    ADD CONSTRAINT member_club_profile_versions_member_fkey FOREIGN KEY (member_id) REFERENCES public.members(id);


--
-- Name: member_club_profile_versions member_club_profile_versions_membership_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.member_club_profile_versions
    ADD CONSTRAINT member_club_profile_versions_membership_fkey FOREIGN KEY (membership_id) REFERENCES public.club_memberships(id) ON DELETE CASCADE;


--
-- Name: member_global_role_versions member_global_role_versions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.member_global_role_versions
    ADD CONSTRAINT member_global_role_versions_created_by_fkey FOREIGN KEY (created_by_member_id) REFERENCES public.members(id);


--
-- Name: member_global_role_versions member_global_role_versions_member_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.member_global_role_versions
    ADD CONSTRAINT member_global_role_versions_member_fkey FOREIGN KEY (member_id) REFERENCES public.members(id);


--
-- Name: member_global_role_versions member_global_role_versions_supersedes_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.member_global_role_versions
    ADD CONSTRAINT member_global_role_versions_supersedes_fkey FOREIGN KEY (supersedes_role_version_id) REFERENCES public.member_global_role_versions(id);


--
-- Name: member_notifications member_notifications_club_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.member_notifications
    ADD CONSTRAINT member_notifications_club_fkey FOREIGN KEY (club_id) REFERENCES public.clubs(id) ON DELETE CASCADE;


--
-- Name: member_notifications member_notifications_producer_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.member_notifications
    ADD CONSTRAINT member_notifications_producer_fkey FOREIGN KEY (producer_id) REFERENCES public.notification_producers(producer_id);


--
-- Name: member_notifications member_notifications_recipient_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.member_notifications
    ADD CONSTRAINT member_notifications_recipient_fkey FOREIGN KEY (recipient_member_id) REFERENCES public.members(id);


--
-- Name: member_profile_embeddings member_profile_embeddings_club_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.member_profile_embeddings
    ADD CONSTRAINT member_profile_embeddings_club_fkey FOREIGN KEY (club_id) REFERENCES public.clubs(id) ON DELETE CASCADE;


--
-- Name: member_profile_embeddings member_profile_embeddings_member_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.member_profile_embeddings
    ADD CONSTRAINT member_profile_embeddings_member_fkey FOREIGN KEY (member_id) REFERENCES public.members(id) ON DELETE CASCADE;


--
-- Name: member_profile_embeddings member_profile_embeddings_version_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.member_profile_embeddings
    ADD CONSTRAINT member_profile_embeddings_version_fkey FOREIGN KEY (profile_version_id) REFERENCES public.member_club_profile_versions(id) ON DELETE CASCADE;


--
-- Name: notification_delivery_counters notification_delivery_counters_producer_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.notification_delivery_counters
    ADD CONSTRAINT notification_delivery_counters_producer_fkey FOREIGN KEY (producer_id) REFERENCES public.notification_producers(producer_id) ON DELETE CASCADE;


--
-- Name: notification_producer_topics notification_producer_topics_producer_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.notification_producer_topics
    ADD CONSTRAINT notification_producer_topics_producer_fkey FOREIGN KEY (producer_id) REFERENCES public.notification_producers(producer_id) ON DELETE CASCADE;


--
-- Name: notification_refs notification_refs_notification_fkey; Type: FK CONSTRAINT; Schema: public; Owner: clawclub_app
--

ALTER TABLE ONLY public.notification_refs
    ADD CONSTRAINT notification_refs_notification_fkey FOREIGN KEY (notification_id) REFERENCES public.member_notifications(id) ON DELETE CASCADE;


--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: postgres
--

REVOKE USAGE ON SCHEMA public FROM PUBLIC;
GRANT ALL ON SCHEMA public TO PUBLIC;
GRANT ALL ON SCHEMA public TO clawclub_app;


--
-- Name: FUNCTION find_asks_matching_vector(input_vector public.vector, offer_content_id public.short_id, input_club_id public.short_id, max_rows integer, exclude_author_id public.short_id); Type: ACL; Schema: producer_contract; Owner: clawclub_app
--

REVOKE ALL ON FUNCTION producer_contract.find_asks_matching_vector(input_vector public.vector, offer_content_id public.short_id, input_club_id public.short_id, max_rows integer, exclude_author_id public.short_id) FROM PUBLIC;


--
-- Name: FUNCTION find_existing_thread_pairs(member_a_ids text[], member_b_ids text[]); Type: ACL; Schema: producer_contract; Owner: clawclub_app
--

REVOKE ALL ON FUNCTION producer_contract.find_existing_thread_pairs(member_a_ids text[], member_b_ids text[]) FROM PUBLIC;


--
-- Name: FUNCTION find_members_matching_vector(input_vector public.vector, input_club_id public.short_id, exclude_member_id public.short_id, max_rows integer); Type: ACL; Schema: producer_contract; Owner: clawclub_app
--

REVOKE ALL ON FUNCTION producer_contract.find_members_matching_vector(input_vector public.vector, input_club_id public.short_id, exclude_member_id public.short_id, max_rows integer) FROM PUBLIC;


--
-- Name: FUNCTION find_similar_members(input_member_id public.short_id, input_club_id public.short_id, max_rows integer); Type: ACL; Schema: producer_contract; Owner: clawclub_app
--

REVOKE ALL ON FUNCTION producer_contract.find_similar_members(input_member_id public.short_id, input_club_id public.short_id, max_rows integer) FROM PUBLIC;


--
-- Name: FUNCTION load_current_content_vector(input_content_id public.short_id); Type: ACL; Schema: producer_contract; Owner: clawclub_app
--

REVOKE ALL ON FUNCTION producer_contract.load_current_content_vector(input_content_id public.short_id) FROM PUBLIC;


--
-- Name: FUNCTION members_accessible_since(since_at timestamp with time zone); Type: ACL; Schema: producer_contract; Owner: clawclub_app
--

REVOKE ALL ON FUNCTION producer_contract.members_accessible_since(since_at timestamp with time zone) FROM PUBLIC;


--
-- Name: FUNCTION tail_activity(after_seq bigint, max_rows integer, only_topic text); Type: ACL; Schema: producer_contract; Owner: clawclub_app
--

REVOKE ALL ON FUNCTION producer_contract.tail_activity(after_seq bigint, max_rows integer, only_topic text) FROM PUBLIC;


--
-- PostgreSQL database dump complete
--

\unrestrict LMbNRhsTO7aZ6DUkSfA7AnUm6QpxisxIcFMDMZr1tNmZuIfgaUDQwOj3YeZrahe
