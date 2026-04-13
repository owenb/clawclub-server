CREATE TABLE public.invitations (
    id                         short_id DEFAULT new_id() NOT NULL,
    club_id                    short_id NOT NULL,
    sponsor_member_id          short_id NOT NULL,
    candidate_name             text NOT NULL,
    candidate_email            text NOT NULL,
    candidate_email_normalized text GENERATED ALWAYS AS (lower(btrim(candidate_email))) STORED,
    reason                     text NOT NULL,
    code_hash                  text NOT NULL,
    expires_at                 timestamptz NOT NULL,
    expired_at                 timestamptz,
    used_at                    timestamptz,
    used_membership_id         short_id,
    revoked_at                 timestamptz,
    created_at                 timestamptz DEFAULT now() NOT NULL,
    metadata                   jsonb DEFAULT '{}'::jsonb NOT NULL,

    CONSTRAINT invitations_pkey PRIMARY KEY (id),
    CONSTRAINT invitations_code_hash_unique UNIQUE (code_hash),
    CONSTRAINT invitations_club_fkey FOREIGN KEY (club_id) REFERENCES public.clubs(id),
    CONSTRAINT invitations_sponsor_fkey FOREIGN KEY (sponsor_member_id) REFERENCES public.members(id),
    CONSTRAINT invitations_used_membership_fkey FOREIGN KEY (used_membership_id) REFERENCES public.club_memberships(id)
);

CREATE INDEX invitations_candidate_lookup_idx
    ON public.invitations (club_id, candidate_email_normalized, created_at DESC);

CREATE UNIQUE INDEX invitations_open_per_sponsor_candidate_idx
    ON public.invitations (club_id, sponsor_member_id, candidate_email_normalized)
    WHERE revoked_at IS NULL AND used_at IS NULL AND expired_at IS NULL;

CREATE TABLE public.application_pow_challenges (
    id              short_id DEFAULT new_id() NOT NULL,
    membership_id   short_id NOT NULL,
    difficulty      integer NOT NULL,
    expires_at      timestamptz NOT NULL,
    solved_at       timestamptz,
    attempts        integer DEFAULT 0 NOT NULL,
    created_at      timestamptz DEFAULT now() NOT NULL,

    CONSTRAINT application_pow_challenges_pkey PRIMARY KEY (id),
    CONSTRAINT application_pow_challenges_membership_fkey
        FOREIGN KEY (membership_id) REFERENCES public.club_memberships(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX application_pow_challenges_one_active_per_membership
    ON public.application_pow_challenges (membership_id)
    WHERE solved_at IS NULL;

ALTER TABLE public.club_memberships
    ADD COLUMN application_name text,
    ADD COLUMN application_email text,
    ADD COLUMN application_email_normalized text GENERATED ALWAYS AS (lower(btrim(application_email))) STORED,
    ADD COLUMN application_socials text,
    ADD COLUMN application_text text,
    ADD COLUMN applied_at timestamptz,
    ADD COLUMN application_submitted_at timestamptz,
    ADD COLUMN submission_path text,
    ADD COLUMN proof_kind text,
    ADD COLUMN invitation_id short_id,
    ADD COLUMN generated_profile_draft jsonb;

ALTER TABLE public.club_memberships
    ADD CONSTRAINT club_memberships_submission_path_check
        CHECK (
            submission_path IS NULL
            OR submission_path IN ('cold', 'invitation', 'cross_apply', 'owner_nominated')
        ),
    ADD CONSTRAINT club_memberships_proof_kind_check
        CHECK (
            proof_kind IS NULL
            OR proof_kind IN ('pow', 'invitation', 'none')
        ),
    ADD CONSTRAINT club_memberships_invitation_fkey
        FOREIGN KEY (invitation_id) REFERENCES public.invitations(id);

CREATE INDEX club_memberships_application_email_lookup_idx
    ON public.club_memberships (club_id, application_email_normalized)
    WHERE application_email_normalized IS NOT NULL;

DROP VIEW IF EXISTS public.accessible_club_memberships;
DROP VIEW IF EXISTS public.active_club_memberships;
DROP VIEW IF EXISTS public.current_club_memberships;
DROP VIEW IF EXISTS public.current_club_membership_states;

DROP TRIGGER IF EXISTS club_memberships_guard ON public.club_memberships;
DROP FUNCTION IF EXISTS public.lock_club_membership_mutation();

DROP TRIGGER IF EXISTS club_membership_state_versions_sync ON public.club_membership_state_versions;
DROP FUNCTION IF EXISTS public.sync_club_membership_state();

DROP TRIGGER IF EXISTS admission_versions_notify ON public.admission_versions;
DROP FUNCTION IF EXISTS public.notify_admission_version();

ALTER TABLE public.club_memberships
    DROP CONSTRAINT club_memberships_club_member_unique,
    DROP CONSTRAINT club_memberships_sponsor_check;

DROP INDEX IF EXISTS public.club_memberships_source_admission_unique;
DROP INDEX IF EXISTS public.members_source_admission_unique_idx;

ALTER TABLE public.club_memberships
    ALTER COLUMN status DROP DEFAULT,
    ALTER COLUMN joined_at DROP DEFAULT,
    ALTER COLUMN joined_at DROP NOT NULL,
    ALTER COLUMN status TYPE text USING status::text;

ALTER TABLE public.club_membership_state_versions
    ALTER COLUMN status TYPE text USING status::text;

UPDATE public.club_memberships m
SET status = CASE
    WHEN m.status = 'invited' THEN 'applying'
    WHEN m.status = 'pending_review' THEN CASE
        WHEN m.source_admission_id IS NOT NULL
          AND EXISTS (
              SELECT 1
              FROM public.admissions a
              WHERE a.id = m.source_admission_id
                AND jsonb_typeof(a.admission_details -> 'application') = 'string'
                AND nullif(btrim(a.admission_details ->> 'application'), '') IS NOT NULL
          ) THEN 'submitted'
        ELSE 'applying'
    END
    WHEN m.status = 'paused' THEN 'expired'
    WHEN m.status = 'left' THEN 'expired'
    WHEN m.status = 'revoked' THEN 'removed'
    WHEN m.status = 'rejected' THEN 'declined'
    ELSE m.status
END;

UPDATE public.club_membership_state_versions sv
SET status = CASE
    WHEN sv.status = 'invited' THEN 'applying'
    WHEN sv.status = 'pending_review' THEN CASE
        WHEN m.source_admission_id IS NOT NULL
          AND EXISTS (
              SELECT 1
              FROM public.admissions a
              WHERE a.id = m.source_admission_id
                AND jsonb_typeof(a.admission_details -> 'application') = 'string'
                AND nullif(btrim(a.admission_details ->> 'application'), '') IS NOT NULL
          ) THEN 'submitted'
        ELSE 'applying'
    END
    WHEN sv.status = 'paused' THEN 'expired'
    WHEN sv.status = 'left' THEN 'expired'
    WHEN sv.status = 'revoked' THEN 'removed'
    WHEN sv.status = 'rejected' THEN 'declined'
    ELSE sv.status
END
FROM public.club_memberships m
WHERE m.id = sv.membership_id;

DO $$
DECLARE
    bad_status text;
BEGIN
    SELECT status
    INTO bad_status
    FROM (
        SELECT DISTINCT status
        FROM public.club_memberships
    ) s
    WHERE status NOT IN (
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
    )
    LIMIT 1;

    IF bad_status IS NOT NULL THEN
        RAISE EXCEPTION 'Unmapped legacy membership status remains after rewrite: %', bad_status;
    END IF;
END
$$;

CREATE TEMP TABLE legacy_admission_current AS
SELECT
    a.id AS admission_id,
    a.club_id,
    a.applicant_member_id,
    a.sponsor_member_id,
    a.membership_id,
    a.origin,
    a.metadata,
    a.created_at AS admission_created_at,
    a.applicant_email,
    a.applicant_name,
    a.admission_details,
    a.generated_profile_draft,
    cav.status::text AS current_status,
    cav.created_at AS current_status_created_at,
    cav.created_by_member_id AS current_status_created_by_member_id,
    submitted.submitted_at,
    CASE
        WHEN a.origin = 'owner_nominated' THEN 'owner_nominated'
        WHEN a.origin = 'member_sponsored' AND a.sponsor_member_id IS NOT NULL THEN 'invitation'
        WHEN a.origin = 'member_sponsored' AND a.sponsor_member_id IS NULL THEN 'cold'
        WHEN a.origin = 'self_applied' AND a.applicant_member_id IS NOT NULL THEN 'cross_apply'
        ELSE 'cold'
    END AS submission_path,
    CASE
        WHEN a.origin = 'owner_nominated' THEN 'none'
        WHEN a.origin = 'member_sponsored' AND a.sponsor_member_id IS NOT NULL THEN 'invitation'
        WHEN a.origin = 'member_sponsored' AND a.sponsor_member_id IS NULL THEN 'pow'
        ELSE 'pow'
    END AS proof_kind,
    CASE
        WHEN jsonb_typeof(a.admission_details -> 'application') = 'string'
            THEN nullif(btrim(a.admission_details ->> 'application'), '')
        ELSE NULL
    END AS application_text,
    CASE
        WHEN jsonb_typeof(a.admission_details -> 'socials') = 'string'
            THEN nullif(btrim(a.admission_details ->> 'socials'), '')
        ELSE NULL
    END AS application_socials,
    CASE
        WHEN jsonb_typeof(a.admission_details -> 'reason') = 'string'
            THEN nullif(btrim(a.admission_details ->> 'reason'), '')
        ELSE NULL
    END AS invitation_reason
FROM public.admissions a
JOIN LATERAL (
    SELECT av.status, av.created_at, av.created_by_member_id
    FROM public.admission_versions av
    WHERE av.admission_id = a.id
    ORDER BY av.version_no DESC, av.created_at DESC
    LIMIT 1
) cav ON TRUE
LEFT JOIN LATERAL (
    SELECT av.created_at AS submitted_at
    FROM public.admission_versions av
    WHERE av.admission_id = a.id
      AND av.status = 'submitted'
    ORDER BY av.version_no ASC, av.created_at ASC
    LIMIT 1
) submitted ON TRUE;

CREATE TEMP TABLE legacy_admission_link AS
SELECT
    lac.admission_id,
    a.membership_id AS direct_membership_id,
    source_membership.id AS source_membership_id,
    CASE
        WHEN a.membership_id IS NOT NULL THEN a.membership_id
        ELSE source_membership.id
    END AS resolved_membership_id
FROM legacy_admission_current lac
JOIN public.admissions a ON a.id = lac.admission_id
LEFT JOIN LATERAL (
    SELECT cm.id
    FROM public.club_memberships cm
    WHERE cm.source_admission_id = a.id
    LIMIT 1
) source_membership ON TRUE;

DO $$
DECLARE
    bad_admission_id text;
BEGIN
    SELECT lac.admission_id
    INTO bad_admission_id
    FROM legacy_admission_current lac
    LEFT JOIN legacy_admission_link l ON l.admission_id = lac.admission_id
    WHERE lac.current_status = 'accepted'
      AND lac.applicant_member_id IS NULL
      AND l.resolved_membership_id IS NULL
    LIMIT 1;

    IF bad_admission_id IS NOT NULL THEN
        RAISE EXCEPTION 'Cannot migrate accepted outsider admission %: missing applicant_member_id and membership link', bad_admission_id;
    END IF;

    SELECT lac.admission_id
    INTO bad_admission_id
    FROM legacy_admission_current lac
    JOIN legacy_admission_link l ON l.admission_id = lac.admission_id
    LEFT JOIN public.club_memberships cm ON cm.id = l.resolved_membership_id
    WHERE lac.current_status = 'accepted'
      AND l.resolved_membership_id IS NOT NULL
      AND cm.id IS NULL
    LIMIT 1;

    IF bad_admission_id IS NOT NULL THEN
        RAISE EXCEPTION 'Cannot migrate accepted admission %: linked membership is missing', bad_admission_id;
    END IF;

    SELECT lac.admission_id
    INTO bad_admission_id
    FROM legacy_admission_current lac
    WHERE lac.current_status = 'accepted'
      AND lac.applicant_member_id IS NOT NULL
      AND NOT EXISTS (
          SELECT 1
          FROM legacy_admission_link l
          WHERE l.admission_id = lac.admission_id
            AND l.resolved_membership_id IS NOT NULL
      )
    LIMIT 1;

    IF bad_admission_id IS NOT NULL THEN
        RAISE EXCEPTION 'Cannot migrate accepted cross-apply admission %: accepted admission has applicant_member_id but no linked membership', bad_admission_id;
    END IF;
END
$$;

UPDATE public.club_memberships cm
SET application_name = lac.applicant_name,
    application_email = lac.applicant_email,
    application_socials = lac.application_socials,
    application_text = lac.application_text,
    applied_at = lac.admission_created_at,
    application_submitted_at = coalesce(lac.submitted_at, lac.admission_created_at),
    submission_path = lac.submission_path,
    proof_kind = lac.proof_kind,
    sponsor_member_id = coalesce(lac.sponsor_member_id, cm.sponsor_member_id),
    generated_profile_draft = coalesce(lac.generated_profile_draft, cm.generated_profile_draft),
    metadata = coalesce(cm.metadata, '{}'::jsonb) || coalesce(lac.metadata, '{}'::jsonb)
FROM legacy_admission_current lac
JOIN legacy_admission_link l ON l.admission_id = lac.admission_id
WHERE cm.id = l.resolved_membership_id;

WITH linked_target AS (
    SELECT
        l.resolved_membership_id AS membership_id,
        lac.admission_id,
        CASE
            WHEN lac.current_status = 'accepted' THEN NULL
            ELSE lac.current_status
        END AS target_status,
        lac.current_status_created_at
    FROM legacy_admission_current lac
    JOIN legacy_admission_link l ON l.admission_id = lac.admission_id
    JOIN public.club_memberships cm ON cm.id = l.resolved_membership_id
    WHERE l.resolved_membership_id IS NOT NULL
      AND lac.current_status <> 'accepted'
      AND cm.status IS DISTINCT FROM lac.current_status
),
linked_versions AS (
    SELECT
        lt.membership_id,
        lt.target_status,
        lt.current_status_created_at,
        cms.version_no + 1 AS next_version_no,
        cms.id AS supersedes_state_version_id
    FROM linked_target lt
    JOIN LATERAL (
        SELECT csv.id, csv.version_no
        FROM public.club_membership_state_versions csv
        WHERE csv.membership_id = lt.membership_id
        ORDER BY csv.version_no DESC, csv.created_at DESC
        LIMIT 1
    ) cms ON TRUE
)
INSERT INTO public.club_membership_state_versions (
    membership_id,
    status,
    reason,
    version_no,
    supersedes_state_version_id,
    created_at,
    created_by_member_id
)
SELECT
    membership_id,
    target_status,
    'Migrated from legacy admission',
    next_version_no,
    supersedes_state_version_id,
    current_status_created_at,
    NULL
FROM linked_versions;

UPDATE public.club_memberships cm
SET status = lac.current_status,
    left_at = CASE
        WHEN lac.current_status IN ('declined', 'withdrawn', 'expired', 'removed', 'banned')
            THEN coalesce(cm.left_at, lac.current_status_created_at)
        ELSE NULL
    END,
    joined_at = CASE
        WHEN lac.current_status IN ('applying', 'submitted', 'interview_scheduled', 'interview_completed', 'payment_pending')
            THEN NULL
        ELSE cm.joined_at
    END
FROM legacy_admission_current lac
JOIN legacy_admission_link l ON l.admission_id = lac.admission_id
WHERE cm.id = l.resolved_membership_id
  AND lac.current_status <> 'accepted'
  AND cm.status IS DISTINCT FROM lac.current_status;

CREATE TEMP TABLE legacy_new_membership_seed AS
SELECT
    lac.admission_id,
    CASE
        WHEN lac.applicant_member_id IS NOT NULL THEN lac.applicant_member_id
        ELSE new_id()
    END AS member_id,
    new_id() AS membership_id,
    lac.club_id,
    CASE
        WHEN lac.origin = 'member_sponsored' AND lac.sponsor_member_id IS NULL THEN NULL
        ELSE lac.sponsor_member_id
    END AS sponsor_member_id,
    'member'::membership_role AS role,
    lac.current_status AS status,
    CASE
        WHEN lac.origin = 'member_sponsored' AND lac.sponsor_member_id IS NULL
            THEN coalesce(lac.metadata, '{}'::jsonb) || jsonb_build_object('legacyMissingSponsor', true)
        ELSE coalesce(lac.metadata, '{}'::jsonb)
    END AS metadata,
    lac.applicant_name AS application_name,
    lac.applicant_email AS application_email,
    lac.application_socials,
    lac.application_text,
    lac.admission_created_at AS applied_at,
    coalesce(lac.submitted_at, lac.admission_created_at) AS application_submitted_at,
    lac.submission_path,
    lac.proof_kind,
    lac.generated_profile_draft,
    CASE
        WHEN lac.current_status IN ('declined', 'withdrawn', 'expired', 'removed', 'banned')
            THEN lac.current_status_created_at
        ELSE NULL
    END AS left_at,
    CASE
        WHEN lac.current_status = 'active' THEN lac.current_status_created_at
        ELSE NULL
    END AS joined_at,
    lac.current_status_created_at,
    lac.applicant_member_id IS NULL AS needs_member_insert
FROM legacy_admission_current lac
LEFT JOIN legacy_admission_link l ON l.admission_id = lac.admission_id
WHERE l.resolved_membership_id IS NULL
  AND lac.current_status <> 'accepted';

DO $$
DECLARE
    bad_admission_id text;
BEGIN
    SELECT seed.admission_id
    INTO bad_admission_id
    FROM legacy_new_membership_seed seed
    JOIN public.club_memberships cm
      ON cm.club_id = seed.club_id
     AND cm.member_id = seed.member_id
     AND cm.status NOT IN ('declined', 'withdrawn', 'expired', 'removed', 'banned')
    LIMIT 1;

    IF bad_admission_id IS NOT NULL THEN
        RAISE EXCEPTION 'Cannot migrate admission %: existing non-terminal membership already exists for the same club/member', bad_admission_id;
    END IF;
END
$$;

INSERT INTO public.members (
    id,
    handle,
    public_name,
    display_name,
    state,
    metadata
)
SELECT
    seed.member_id,
    'legacy-' || seed.admission_id,
    coalesce(seed.application_name, 'Legacy Applicant'),
    coalesce(seed.application_name, 'Legacy Applicant'),
    'active',
    jsonb_build_object('migratedLegacyAdmissionId', seed.admission_id)
FROM legacy_new_membership_seed seed
WHERE seed.needs_member_insert;

INSERT INTO public.member_private_contacts (
    member_id,
    email
)
SELECT
    seed.member_id,
    seed.application_email
FROM legacy_new_membership_seed seed
WHERE seed.needs_member_insert
  AND seed.application_email IS NOT NULL;

INSERT INTO public.club_memberships (
    id,
    club_id,
    member_id,
    sponsor_member_id,
    role,
    status,
    joined_at,
    left_at,
    metadata,
    approved_price_amount,
    approved_price_currency,
    application_name,
    application_email,
    application_socials,
    application_text,
    applied_at,
    application_submitted_at,
    submission_path,
    proof_kind,
    generated_profile_draft
)
SELECT
    seed.membership_id,
    seed.club_id,
    seed.member_id,
    seed.sponsor_member_id,
    seed.role,
    seed.status,
    seed.joined_at,
    seed.left_at,
    seed.metadata,
    NULL,
    NULL,
    seed.application_name,
    seed.application_email,
    seed.application_socials,
    seed.application_text,
    seed.applied_at,
    seed.application_submitted_at,
    seed.submission_path,
    seed.proof_kind,
    seed.generated_profile_draft
FROM legacy_new_membership_seed seed;

INSERT INTO public.club_membership_state_versions (
    membership_id,
    status,
    reason,
    version_no,
    created_at,
    created_by_member_id
)
SELECT
    seed.membership_id,
    seed.status,
    'Migrated from legacy admission',
    1,
    seed.current_status_created_at,
    NULL
FROM legacy_new_membership_seed seed;

CREATE TEMP TABLE legacy_admission_membership_map AS
SELECT
    lac.admission_id,
    coalesce(l.resolved_membership_id, seed.membership_id) AS membership_id,
    coalesce(existing_cm.member_id, seed.member_id) AS member_id
FROM legacy_admission_current lac
LEFT JOIN legacy_admission_link l ON l.admission_id = lac.admission_id
LEFT JOIN public.club_memberships existing_cm ON existing_cm.id = l.resolved_membership_id
LEFT JOIN legacy_new_membership_seed seed ON seed.admission_id = lac.admission_id;

INSERT INTO public.invitations (
    club_id,
    sponsor_member_id,
    candidate_name,
    candidate_email,
    reason,
    code_hash,
    expires_at,
    expired_at,
    used_at,
    used_membership_id,
    metadata
)
SELECT
    lac.club_id,
    lac.sponsor_member_id,
    coalesce(lac.applicant_name, 'Legacy Candidate'),
    coalesce(lac.applicant_email, ''),
    coalesce(lac.invitation_reason, 'Legacy migrated invitation'),
    'legacy-migrated-' || lac.admission_id,
    lac.admission_created_at + interval '30 days',
    CASE
        WHEN coalesce(lac.submitted_at, lac.admission_created_at) IS NOT NULL THEN NULL
        WHEN lac.admission_created_at + interval '30 days' < now() THEN now()
        ELSE NULL
    END,
    coalesce(lac.submitted_at, lac.admission_created_at),
    map.membership_id,
    jsonb_build_object('legacyAdmissionId', lac.admission_id)
FROM legacy_admission_current lac
JOIN legacy_admission_membership_map map ON map.admission_id = lac.admission_id
WHERE lac.origin = 'member_sponsored'
  AND lac.sponsor_member_id IS NOT NULL;

UPDATE public.club_memberships cm
SET invitation_id = inv.id
FROM public.invitations inv
WHERE inv.used_membership_id = cm.id;

WITH legacy_membership_application_defaults AS (
    SELECT
        cm.id AS membership_id,
        min(csv.created_at) AS first_state_at,
        min(csv.created_at) FILTER (WHERE csv.status = 'submitted') AS submitted_at,
        max(pc.email) AS contact_email,
        max(m.public_name) AS public_name
    FROM public.club_memberships cm
    LEFT JOIN public.club_membership_state_versions csv ON csv.membership_id = cm.id
    LEFT JOIN public.member_private_contacts pc ON pc.member_id = cm.member_id
    LEFT JOIN public.members m ON m.id = cm.member_id
    GROUP BY cm.id
)
UPDATE public.club_memberships cm
SET application_name = coalesce(cm.application_name, defaults.public_name),
    application_email = coalesce(cm.application_email, defaults.contact_email),
    applied_at = coalesce(cm.applied_at, defaults.first_state_at),
    application_submitted_at = CASE
        WHEN cm.status = 'submitted'
            THEN coalesce(cm.application_submitted_at, defaults.submitted_at, defaults.first_state_at)
        WHEN cm.status IN ('interview_scheduled', 'interview_completed')
            THEN coalesce(cm.application_submitted_at, defaults.submitted_at, defaults.first_state_at)
        ELSE cm.application_submitted_at
    END,
    submission_path = CASE
        WHEN cm.submission_path IS NOT NULL THEN cm.submission_path
        WHEN cm.status IN ('applying', 'submitted', 'interview_scheduled', 'interview_completed')
             AND cm.sponsor_member_id IS NOT NULL THEN 'invitation'
        WHEN cm.status IN ('applying', 'submitted', 'interview_scheduled', 'interview_completed')
             AND cm.sponsor_member_id IS NULL THEN 'cross_apply'
        ELSE cm.submission_path
    END,
    proof_kind = CASE
        WHEN cm.proof_kind IS NOT NULL THEN cm.proof_kind
        WHEN cm.status IN ('applying', 'submitted', 'interview_scheduled', 'interview_completed')
             AND cm.sponsor_member_id IS NOT NULL THEN 'invitation'
        WHEN cm.status IN ('applying', 'submitted', 'interview_scheduled', 'interview_completed')
             AND cm.sponsor_member_id IS NULL THEN 'pow'
        ELSE cm.proof_kind
    END
FROM legacy_membership_application_defaults defaults
WHERE defaults.membership_id = cm.id;

UPDATE public.club_memberships
SET joined_at = NULL
WHERE status IN ('applying', 'submitted', 'interview_scheduled', 'interview_completed', 'payment_pending');

UPDATE public.club_memberships
SET left_at = now()
WHERE status IN ('expired', 'removed', 'banned', 'declined', 'withdrawn')
  AND left_at IS NULL;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM public.club_memberships
        WHERE status IN ('active', 'renewal_pending', 'cancelled')
          AND joined_at IS NULL
    ) THEN
        RAISE EXCEPTION 'joined_at backfill failed: access-granting memberships with NULL joined_at remain';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.club_memberships
        WHERE status IN ('applying', 'submitted', 'interview_scheduled', 'interview_completed', 'payment_pending')
          AND joined_at IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'joined_at backfill failed: pre-access memberships still have joined_at populated';
    END IF;
END
$$;

DROP VIEW IF EXISTS public.current_admissions;
DROP VIEW IF EXISTS public.current_admission_versions;

DROP TABLE public.admission_versions CASCADE;
DROP TABLE public.admission_attempts CASCADE;
DROP TABLE public.admission_challenges CASCADE;
DROP TABLE public.admissions CASCADE;

DROP TYPE public.application_status;

ALTER TABLE public.club_memberships
    DROP COLUMN source_admission_id;

ALTER TABLE public.members
    DROP COLUMN source_admission_id;

DROP TYPE public.membership_state;

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

ALTER TABLE public.club_memberships
    ALTER COLUMN status TYPE public.membership_state
    USING status::public.membership_state;

ALTER TABLE public.club_membership_state_versions
    ALTER COLUMN status TYPE public.membership_state
    USING status::public.membership_state;

CREATE UNIQUE INDEX club_memberships_non_terminal_unique
    ON public.club_memberships (club_id, member_id)
    WHERE status NOT IN ('declined', 'withdrawn', 'expired', 'removed', 'banned');

CREATE OR REPLACE FUNCTION public.club_memberships_require_profile_version() RETURNS trigger
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

CREATE OR REPLACE FUNCTION public.lock_club_membership_mutation() RETURNS trigger
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

CREATE TRIGGER club_memberships_guard
    BEFORE UPDATE ON public.club_memberships
    FOR EACH ROW EXECUTE FUNCTION public.lock_club_membership_mutation();

CREATE OR REPLACE FUNCTION public.sync_club_membership_state() RETURNS trigger
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

CREATE TRIGGER club_membership_state_versions_sync
    AFTER INSERT ON public.club_membership_state_versions
    FOR EACH ROW EXECUTE FUNCTION public.sync_club_membership_state();

CREATE OR REPLACE FUNCTION public.notify_club_membership_state_version() RETURNS trigger
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

CREATE TRIGGER club_membership_state_versions_notify
    AFTER INSERT ON public.club_membership_state_versions
    FOR EACH ROW EXECUTE FUNCTION public.notify_club_membership_state_version();

CREATE VIEW public.current_club_membership_states AS
    SELECT DISTINCT ON (membership_id) *
    FROM public.club_membership_state_versions
    ORDER BY membership_id, version_no DESC, created_at DESC;

CREATE VIEW public.current_club_memberships AS
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
    FROM public.club_memberships m
    LEFT JOIN public.current_club_membership_states cms ON cms.membership_id = m.id;

CREATE VIEW public.active_club_memberships AS
    SELECT *
    FROM public.current_club_memberships
    WHERE status = 'active' AND left_at IS NULL;

CREATE VIEW public.accessible_club_memberships AS
    SELECT cm.*
    FROM public.current_club_memberships cm
    WHERE cm.left_at IS NULL
      AND (
          cm.role = 'clubadmin'
          OR (cm.is_comped = true AND cm.status = 'active')
          OR (
              cm.status IN ('active', 'cancelled')
              AND EXISTS (
                  SELECT 1
                  FROM public.club_subscriptions s
                  WHERE s.membership_id = cm.id
                    AND s.status IN ('trialing', 'active', 'past_due')
                    AND coalesce(s.ended_at, 'infinity'::timestamptz) > now()
                    AND coalesce(s.current_period_end, 'infinity'::timestamptz) > now()
              )
          )
          OR (
              cm.status = 'renewal_pending'
              AND cm.state_created_at + interval '7 days' > now()
          )
      );
