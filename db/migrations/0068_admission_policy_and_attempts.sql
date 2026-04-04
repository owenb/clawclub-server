-- Cold-admissions redesign: club-specific admission policies, LLM gate, attempt tracking.
--
-- Changes:
--   1. Add admission_policy to clubs
--   2. Add club_id + policy_snapshot to admission_challenges (bind challenge to one club)
--   3. Create admission_attempts audit table
--   4. New SQL helpers: list_admission_eligible_clubs, get_admission_eligible_club
--   5. Replace create_admission_challenge with a club-bound version
--   6. Replace consume_admission_challenge to read club_id from challenge row

-- ============================================================
-- 1. admission_policy on clubs
-- ============================================================

ALTER TABLE app.clubs ADD COLUMN admission_policy text;

ALTER TABLE app.clubs ADD CONSTRAINT clubs_admission_policy_length
  CHECK (admission_policy IS NULL OR char_length(admission_policy) BETWEEN 1 AND 2000);

-- Normalize admission_policy: trim whitespace, coerce blank to NULL
CREATE FUNCTION app.normalize_admission_policy() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.admission_policy IS NOT NULL THEN
    NEW.admission_policy := nullif(trim(both from NEW.admission_policy), '');
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER clubs_normalize_admission_policy
  BEFORE INSERT OR UPDATE OF admission_policy ON app.clubs
  FOR EACH ROW EXECUTE FUNCTION app.normalize_admission_policy();

-- ============================================================
-- 2. Bind admission_challenges to a club with a policy snapshot
-- ============================================================

ALTER TABLE app.admission_challenges
  ADD COLUMN club_id app.short_id REFERENCES app.clubs(id),
  ADD COLUMN policy_snapshot text,
  ADD COLUMN club_name text,
  ADD COLUMN club_summary text,
  ADD COLUMN owner_name text;

-- ============================================================
-- 3. admission_attempts audit table
-- ============================================================

CREATE TABLE app.admission_attempts (
    id app.short_id DEFAULT app.new_id() NOT NULL,
    challenge_id app.short_id NOT NULL,
    club_id app.short_id NOT NULL,
    attempt_no integer NOT NULL,
    applicant_name text NOT NULL,
    applicant_email text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    gate_status app.quality_gate_status NOT NULL,
    gate_feedback text,
    policy_snapshot text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT admission_attempts_pkey PRIMARY KEY (id),
    CONSTRAINT admission_attempts_attempt_no_check CHECK (attempt_no BETWEEN 1 AND 5),
    CONSTRAINT admission_attempts_club_id_fkey FOREIGN KEY (club_id) REFERENCES app.clubs(id)
);

CREATE INDEX admission_attempts_challenge_idx ON app.admission_attempts (challenge_id, attempt_no);

ALTER TABLE app.admission_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY app.admission_attempts FORCE ROW LEVEL SECURITY;

CREATE POLICY admission_attempts_insert_cold ON app.admission_attempts
    FOR INSERT WITH CHECK (current_user = 'clawclub_cold_application_owner');

CREATE POLICY admission_attempts_select_cold ON app.admission_attempts
    FOR SELECT USING (current_user = 'clawclub_cold_application_owner');

CREATE POLICY admission_attempts_select_view ON app.admission_attempts
    FOR SELECT USING (current_user = 'clawclub_view_owner');

CREATE POLICY admission_attempts_select_definer ON app.admission_attempts
    FOR SELECT USING (current_user = 'clawclub_security_definer_owner');

GRANT SELECT, INSERT ON TABLE app.admission_attempts TO clawclub_cold_application_owner;
GRANT SELECT ON TABLE app.admission_attempts TO clawclub_view_owner;
GRANT SELECT ON TABLE app.admission_attempts TO clawclub_security_definer_owner;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clawclub_app') THEN
    EXECUTE 'GRANT SELECT ON TABLE app.admission_attempts TO clawclub_app';
  END IF;
END $$;

-- ============================================================
-- 4. list_admission_eligible_clubs (discovery only)
-- ============================================================

CREATE FUNCTION app.list_admission_eligible_clubs()
RETURNS TABLE(slug text, name text, summary text, admission_policy text, owner_name text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'app', 'pg_temp'
AS $$
  SELECT
    c.slug,
    c.name,
    c.summary,
    c.admission_policy,
    oc.member_name AS owner_name
  FROM app.clubs c
  CROSS JOIN LATERAL app.get_member_public_contact(c.owner_member_id) oc
  WHERE c.publicly_listed = true
    AND c.archived_at IS NULL
    AND c.admission_policy IS NOT NULL
  ORDER BY c.name ASC;
$$;

ALTER FUNCTION app.list_admission_eligible_clubs() OWNER TO clawclub_cold_application_owner;

GRANT EXECUTE ON FUNCTION app.list_admission_eligible_clubs() TO clawclub_view_owner;
GRANT EXECUTE ON FUNCTION app.list_admission_eligible_clubs() TO clawclub_security_definer_owner;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clawclub_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION app.list_admission_eligible_clubs() TO clawclub_app';
  END IF;
END $$;

-- ============================================================
-- 5. get_admission_eligible_club (single club lookup for challenge binding)
-- ============================================================

CREATE FUNCTION app.get_admission_eligible_club(target_slug text)
RETURNS TABLE(club_id app.short_id, name text, summary text, admission_policy text, owner_name text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'app', 'pg_temp'
AS $$
  SELECT
    c.id AS club_id,
    c.name,
    c.summary,
    c.admission_policy,
    oc.member_name AS owner_name
  FROM app.clubs c
  CROSS JOIN LATERAL app.get_member_public_contact(c.owner_member_id) oc
  WHERE c.slug = target_slug
    AND c.publicly_listed = true
    AND c.archived_at IS NULL
    AND c.admission_policy IS NOT NULL
  LIMIT 1;
$$;

ALTER FUNCTION app.get_admission_eligible_club(text) OWNER TO clawclub_cold_application_owner;

GRANT EXECUTE ON FUNCTION app.get_admission_eligible_club(text) TO clawclub_view_owner;
GRANT EXECUTE ON FUNCTION app.get_admission_eligible_club(text) TO clawclub_security_definer_owner;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clawclub_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION app.get_admission_eligible_club(text) TO clawclub_app';
  END IF;
END $$;

-- ============================================================
-- 6. Replace create_admission_challenge (now club-bound)
-- ============================================================

DROP FUNCTION app.create_admission_challenge(integer, integer);

CREATE FUNCTION app.create_admission_challenge(
  target_difficulty integer,
  target_ttl_ms bigint,
  target_club_id app.short_id,
  target_policy_snapshot text,
  target_club_name text,
  target_club_summary text,
  target_owner_name text
) RETURNS TABLE(challenge_id app.short_id, expires_at text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'app', 'pg_temp'
AS $$
BEGIN
  -- Clean expired challenges
  DELETE FROM app.admission_challenges c WHERE c.expires_at <= now();

  RETURN QUERY
    INSERT INTO app.admission_challenges (
      difficulty, expires_at, club_id, policy_snapshot, club_name, club_summary, owner_name
    )
    VALUES (
      target_difficulty,
      now() + (target_ttl_ms * interval '1 millisecond'),
      target_club_id,
      target_policy_snapshot,
      target_club_name,
      target_club_summary,
      target_owner_name
    )
    RETURNING
      id AS challenge_id,
      admission_challenges.expires_at::text AS expires_at;
END;
$$;

ALTER FUNCTION app.create_admission_challenge(integer, bigint, app.short_id, text, text, text, text)
    OWNER TO clawclub_cold_application_owner;

GRANT EXECUTE ON FUNCTION app.create_admission_challenge(integer, bigint, app.short_id, text, text, text, text)
    TO clawclub_view_owner;
GRANT EXECUTE ON FUNCTION app.create_admission_challenge(integer, bigint, app.short_id, text, text, text, text)
    TO clawclub_security_definer_owner;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clawclub_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION app.create_admission_challenge(integer, bigint, app.short_id, text, text, text, text) TO clawclub_app';
  END IF;
END $$;

-- ============================================================
-- 7. Replace consume_admission_challenge (reads club_id from challenge row)
-- ============================================================

DROP FUNCTION app.consume_admission_challenge(app.short_id, text, text, text, jsonb);

CREATE FUNCTION app.consume_admission_challenge(
  target_challenge_id app.short_id,
  target_name text,
  target_email text,
  target_admission_details jsonb
) RETURNS TABLE(admission_id app.short_id)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'app', 'pg_temp'
AS $$
  WITH challenge AS (
    DELETE FROM app.admission_challenges c
    WHERE c.id = target_challenge_id
    RETURNING c.club_id
  ), inserted AS (
    INSERT INTO app.admissions (
      club_id, origin, applicant_email, applicant_name, admission_details
    )
    SELECT
      challenge.club_id,
      'self_applied',
      target_email,
      target_name,
      target_admission_details
    FROM challenge
    WHERE challenge.club_id IS NOT NULL
    RETURNING id AS admission_id
  ), version_insert AS (
    INSERT INTO app.admission_versions (
      admission_id, status, notes, version_no
    )
    SELECT
      inserted.admission_id,
      'submitted',
      'Self-applied admission submitted after proof verification',
      1
    FROM inserted
  )
  SELECT inserted.admission_id FROM inserted;
$$;

ALTER FUNCTION app.consume_admission_challenge(app.short_id, text, text, jsonb)
    OWNER TO clawclub_cold_application_owner;

GRANT EXECUTE ON FUNCTION app.consume_admission_challenge(app.short_id, text, text, jsonb)
    TO clawclub_view_owner;
GRANT EXECUTE ON FUNCTION app.consume_admission_challenge(app.short_id, text, text, jsonb)
    TO clawclub_security_definer_owner;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clawclub_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION app.consume_admission_challenge(app.short_id, text, text, jsonb) TO clawclub_app';
  END IF;
END $$;

-- ============================================================
-- 8. Update get_admission_challenge to return bound club data
-- ============================================================

DROP FUNCTION app.get_admission_challenge(app.short_id);

CREATE FUNCTION app.get_admission_challenge(target_challenge_id app.short_id)
RETURNS TABLE(
  challenge_id app.short_id,
  difficulty integer,
  expires_at text,
  club_id app.short_id,
  policy_snapshot text,
  club_name text,
  club_summary text,
  owner_name text
)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'app', 'pg_temp'
AS $$
  SELECT
    c.id AS challenge_id,
    c.difficulty,
    c.expires_at::text AS expires_at,
    c.club_id,
    c.policy_snapshot,
    c.club_name,
    c.club_summary,
    c.owner_name
  FROM app.admission_challenges c
  WHERE c.id = target_challenge_id
  LIMIT 1
  FOR UPDATE;
$$;

ALTER FUNCTION app.get_admission_challenge(app.short_id) OWNER TO clawclub_cold_application_owner;

GRANT EXECUTE ON FUNCTION app.get_admission_challenge(app.short_id) TO clawclub_view_owner;
GRANT EXECUTE ON FUNCTION app.get_admission_challenge(app.short_id) TO clawclub_security_definer_owner;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clawclub_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION app.get_admission_challenge(app.short_id) TO clawclub_app';
  END IF;
END $$;

-- ============================================================
-- 9. Security definer helpers for admission attempts + club check
-- ============================================================

-- Count attempts for a challenge (bypasses RLS on admission_attempts)
CREATE FUNCTION app.count_admission_attempts(target_challenge_id app.short_id)
RETURNS integer
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'app', 'pg_temp'
AS $$
  SELECT COALESCE(count(*)::integer, 0)
  FROM app.admission_attempts
  WHERE challenge_id = target_challenge_id;
$$;

ALTER FUNCTION app.count_admission_attempts(app.short_id) OWNER TO clawclub_cold_application_owner;

GRANT EXECUTE ON FUNCTION app.count_admission_attempts(app.short_id) TO clawclub_view_owner;
GRANT EXECUTE ON FUNCTION app.count_admission_attempts(app.short_id) TO clawclub_security_definer_owner;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clawclub_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION app.count_admission_attempts(app.short_id) TO clawclub_app';
  END IF;
END $$;

-- Record an admission attempt (bypasses RLS on admission_attempts)
CREATE FUNCTION app.record_admission_attempt(
  target_challenge_id app.short_id,
  target_club_id app.short_id,
  target_attempt_no integer,
  target_applicant_name text,
  target_applicant_email text,
  target_payload jsonb,
  target_gate_status app.quality_gate_status,
  target_gate_feedback text,
  target_policy_snapshot text
) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'app', 'pg_temp'
AS $$
  INSERT INTO app.admission_attempts (
    challenge_id, club_id, attempt_no,
    applicant_name, applicant_email, payload,
    gate_status, gate_feedback, policy_snapshot
  ) VALUES (
    target_challenge_id, target_club_id, target_attempt_no,
    target_applicant_name, target_applicant_email, target_payload,
    target_gate_status, target_gate_feedback, target_policy_snapshot
  );
$$;

ALTER FUNCTION app.record_admission_attempt(app.short_id, app.short_id, integer, text, text, jsonb, app.quality_gate_status, text, text)
    OWNER TO clawclub_cold_application_owner;

GRANT EXECUTE ON FUNCTION app.record_admission_attempt(app.short_id, app.short_id, integer, text, text, jsonb, app.quality_gate_status, text, text)
    TO clawclub_view_owner;
GRANT EXECUTE ON FUNCTION app.record_admission_attempt(app.short_id, app.short_id, integer, text, text, jsonb, app.quality_gate_status, text, text)
    TO clawclub_security_definer_owner;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clawclub_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION app.record_admission_attempt(app.short_id, app.short_id, integer, text, text, jsonb, app.quality_gate_status, text, text) TO clawclub_app';
  END IF;
END $$;

-- Check if a club is still accepting applications (bypasses RLS on clubs)
CREATE FUNCTION app.check_club_admission_eligible(target_club_id app.short_id)
RETURNS TABLE(eligible boolean)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'app', 'pg_temp'
AS $$
  SELECT
    (c.archived_at IS NULL AND c.publicly_listed = true AND c.admission_policy IS NOT NULL) AS eligible
  FROM app.clubs c
  WHERE c.id = target_club_id;
$$;

ALTER FUNCTION app.check_club_admission_eligible(app.short_id) OWNER TO clawclub_cold_application_owner;

GRANT EXECUTE ON FUNCTION app.check_club_admission_eligible(app.short_id) TO clawclub_view_owner;
GRANT EXECUTE ON FUNCTION app.check_club_admission_eligible(app.short_id) TO clawclub_security_definer_owner;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clawclub_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION app.check_club_admission_eligible(app.short_id) TO clawclub_app';
  END IF;
END $$;
