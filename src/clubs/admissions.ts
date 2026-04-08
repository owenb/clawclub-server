/**
 * Clubs domain — admission workflow.
 *
 * Admissions, admission_versions, admission_challenges, admission_attempts.
 * Member creation on acceptance is handled in the composition layer (postgres.ts).
 */

import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { AppError, type AdmissionStatus, type AdmissionSummary, type AdmissionApplyResult } from '../contract.ts';
import { runAdmissionGate, QUALITY_GATE_PROVIDER, type QualityGateResult } from '../quality-gate.ts';
import { CLAWCLUB_OPENAI_MODEL } from '../ai.ts';
import { withTransaction, type DbClient } from '../db.ts';
import { appendClubActivity } from './entities.ts';

const COLD_APPLICATION_DIFFICULTY = 7;
const CROSS_APPLICATION_DIFFICULTY = 5;
const COLD_APPLICATION_CHALLENGE_TTL_MS = 60 * 60 * 1000;
const MAX_ADMISSION_ATTEMPTS = 5;
const MAX_PENDING_CROSS_APPLICATIONS = 3;

type AdmissionRow = {
  admission_id: string;
  club_id: string;
  applicant_member_id: string | null;
  applicant_email: string | null;
  applicant_name: string | null;
  sponsor_member_id: string | null;
  membership_id: string | null;
  origin: 'self_applied' | 'member_sponsored' | 'owner_nominated';
  intake_kind: string;
  intake_price_amount: string | number | null;
  intake_price_currency: string | null;
  intake_booking_url: string | null;
  intake_booked_at: string | null;
  intake_completed_at: string | null;
  status: AdmissionStatus;
  notes: string | null;
  version_no: number;
  version_created_at: string;
  version_created_by_member_id: string | null;
  admission_details: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

export function mapAdmissionRow(row: AdmissionRow): Omit<AdmissionSummary, 'applicant' | 'sponsor'> & {
  applicantMemberId: string | null;
  applicantName: string | null;
  applicantEmail: string | null;
  sponsorMemberId: string | null;
} {
  return {
    admissionId: row.admission_id,
    clubId: row.club_id,
    applicantMemberId: row.applicant_member_id,
    applicantName: row.applicant_name,
    applicantEmail: row.applicant_email,
    sponsorMemberId: row.sponsor_member_id,
    membershipId: row.membership_id,
    origin: row.origin,
    intake: {
      kind: row.intake_kind as 'fit_check' | 'advice_call' | 'other',
      price: { amount: row.intake_price_amount != null ? Number(row.intake_price_amount) : null, currency: row.intake_price_currency },
      bookingUrl: row.intake_booking_url,
      bookedAt: row.intake_booked_at,
      completedAt: row.intake_completed_at,
    },
    state: {
      status: row.status,
      notes: row.notes,
      versionNo: Number(row.version_no),
      createdAt: row.version_created_at,
      createdByMemberId: row.version_created_by_member_id,
    },
    admissionDetails: row.admission_details ?? {},
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
  };
}

const ADMISSION_SELECT = `
  ca.id as admission_id, ca.club_id, ca.applicant_member_id, ca.applicant_email,
  ca.applicant_name, ca.sponsor_member_id, ca.membership_id, ca.origin,
  ca.intake_kind, ca.intake_price_amount, ca.intake_price_currency,
  ca.intake_booking_url, ca.intake_booked_at::text as intake_booked_at,
  ca.intake_completed_at::text as intake_completed_at,
  ca.status, ca.notes, ca.version_no,
  ca.version_created_at::text as version_created_at,
  ca.version_created_by_member_id, ca.admission_details, ca.metadata,
  ca.created_at::text as created_at
`;

export async function readAdmission(client: DbClient, admissionId: string): Promise<AdmissionRow | null> {
  const result = await client.query<AdmissionRow>(
    `select ${ADMISSION_SELECT} from current_admissions ca where ca.id = $1 limit 1`,
    [admissionId],
  );
  return result.rows[0] ?? null;
}

/**
 * Transition an admission to the next status. Does NOT handle member creation
 * on acceptance — that's handled by postgres.ts.
 */
export async function transitionAdmission(pool: Pool, input: {
  admissionId: string;
  clubIds: string[];
  actorMemberId: string;
  nextStatus: AdmissionStatus;
  notes?: string | null;
  intake?: {
    kind?: string; price?: { amount?: number | null; currency?: string | null };
    bookingUrl?: string | null; bookedAt?: string | null; completedAt?: string | null;
  };
  metadataPatch?: Record<string, unknown>;
}): Promise<{
  admission: AdmissionRow;
  isAcceptance: boolean;
  isOutsider: boolean;
} | null> {
  return withTransaction(pool, async (client) => {
    const admissionResult = await client.query<{
      admission_id: string; club_id: string; applicant_member_id: string | null;
      applicant_name: string | null; applicant_email: string | null;
      current_status: AdmissionStatus; current_version_no: number; current_version_id: string;
      current_metadata: Record<string, unknown> | null;
      current_intake_kind: string; current_intake_price_amount: string | number | null;
      current_intake_price_currency: string | null; current_intake_booking_url: string | null;
      current_intake_booked_at: string | null; current_intake_completed_at: string | null;
      current_membership_id: string | null; sponsor_member_id: string | null;
    }>(
      `select ca.id as admission_id, ca.club_id, ca.applicant_member_id,
              ca.applicant_name, ca.applicant_email,
              ca.status as current_status, ca.version_no as current_version_no,
              ca.version_id as current_version_id, ca.metadata as current_metadata,
              ca.intake_kind as current_intake_kind, ca.intake_price_amount as current_intake_price_amount,
              ca.intake_price_currency as current_intake_price_currency,
              ca.intake_booking_url as current_intake_booking_url,
              ca.intake_booked_at::text as current_intake_booked_at,
              ca.intake_completed_at::text as current_intake_completed_at,
              ca.membership_id as current_membership_id, ca.sponsor_member_id
       from current_admissions ca
       where ca.id = $1 and ca.club_id = any($2::text[])
       limit 1`,
      [input.admissionId, input.clubIds],
    );

    const admission = admissionResult.rows[0];
    if (!admission) return null;

    const mergedMetadata = { ...(admission.current_metadata ?? {}), ...(input.metadataPatch ?? {}) };
    const resolvedCompletedAt = input.intake?.completedAt === undefined ? admission.current_intake_completed_at : input.intake.completedAt;

    // Update admission metadata
    await client.query(
      `update admissions set metadata = $2::jsonb where id = $1`,
      [admission.admission_id, JSON.stringify(mergedMetadata)],
    );

    // Insert new admission version
    await client.query(
      `insert into admission_versions (
         admission_id, status, notes, intake_kind, intake_price_amount, intake_price_currency,
         intake_booking_url, intake_booked_at, intake_completed_at,
         version_no, supersedes_version_id, created_by_member_id
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        admission.admission_id, input.nextStatus, input.notes ?? null,
        input.intake?.kind ?? admission.current_intake_kind,
        input.intake?.price?.amount === undefined ? admission.current_intake_price_amount : input.intake.price.amount,
        input.intake?.price?.currency === undefined ? admission.current_intake_price_currency : input.intake.price.currency,
        input.intake?.bookingUrl === undefined ? admission.current_intake_booking_url : input.intake.bookingUrl,
        input.intake?.bookedAt === undefined ? admission.current_intake_booked_at : input.intake.bookedAt,
        resolvedCompletedAt,
        Number(admission.current_version_no) + 1,
        admission.current_version_id,
        input.actorMemberId,
      ],
    );

    const updated = await readAdmission(client, admission.admission_id);
    if (!updated) return null;

    return {
      admission: updated,
      isAcceptance: input.nextStatus === 'accepted',
      isOutsider: admission.applicant_member_id === null,
    };
  });
}

/**
 * Link an admission to a member and membership (after acceptance saga completes in identity).
 */
export async function linkAdmissionToMember(pool: Pool, admissionId: string, memberId: string, membershipId: string): Promise<void> {
  await pool.query(
    `update admissions set applicant_member_id = $2, membership_id = $3 where id = $1`,
    [admissionId, memberId, membershipId],
  );
}

// ── Cold path ───────────────────────────────────────────────

export async function createAdmissionChallenge(pool: Pool, input: {
  clubSlug: string;
  clubId: string;
  clubName: string;
  clubSummary: string | null;
  admissionPolicy: string;
  ownerName: string;
}): Promise<{ challengeId: string; difficulty: number; expiresAt: string; maxAttempts: number }> {
  const result = await pool.query<{ id: string; expires_at: string }>(
    `insert into admission_challenges (difficulty, club_id, policy_snapshot, club_name, club_summary, owner_name, expires_at)
     values ($1, $2, $3, $4, $5, $6, now() + ($7 || ' milliseconds')::interval)
     returning id, expires_at::text as expires_at`,
    [COLD_APPLICATION_DIFFICULTY, input.clubId, input.admissionPolicy, input.clubName, input.clubSummary, input.ownerName, COLD_APPLICATION_CHALLENGE_TTL_MS],
  );
  const row = result.rows[0];
  if (!row) throw new AppError(500, 'invalid_data', 'Admission challenge was not created');

  return {
    challengeId: row.id,
    difficulty: COLD_APPLICATION_DIFFICULTY,
    expiresAt: new Date(Date.parse(row.expires_at)).toISOString(),
    maxAttempts: MAX_ADMISSION_ATTEMPTS,
  };
}

export async function solveAdmissionChallenge(pool: Pool, input: {
  challengeId: string; nonce: string; name: string; email: string; socials: string; application: string;
}): Promise<AdmissionApplyResult> {
  // Phase 1: Validate challenge
  type ChallengeRow = {
    id: string; difficulty: number; expires_at: string; member_id: string | null;
    club_id: string; policy_snapshot: string;
    club_name: string; club_summary: string | null; owner_name: string;
  };

  let challengeData: ChallengeRow;
  let attemptCount: number;

  const client1 = await pool.connect();
  try {
    await client1.query('BEGIN');
    const challengeResult = await client1.query<ChallengeRow>(
      `select id, difficulty, expires_at::text as expires_at, member_id, club_id, policy_snapshot, club_name, club_summary, owner_name
       from admission_challenges where id = $1 for update`,
      [input.challengeId],
    );
    const challenge = challengeResult.rows[0];
    if (!challenge) { await client1.query('ROLLBACK'); throw new AppError(404, 'challenge_not_found', 'Challenge not found'); }

    // Reject member-bound challenges — they must go through admissions.crossClub.submitApplication
    if (challenge.member_id !== null) {
      await client1.query('ROLLBACK');
      throw new AppError(400, 'challenge_not_cold', 'This challenge is bound to an authenticated member. Use admissions.crossClub.submitApplication instead.');
    }

    if (Date.parse(challenge.expires_at) < Date.now()) {
      await client1.query(`delete from admission_attempts where challenge_id = $1`, [input.challengeId]);
      await client1.query(`delete from admission_challenges where id = $1`, [input.challengeId]);
      await client1.query('COMMIT');
      throw new AppError(410, 'challenge_expired', 'This challenge has expired');
    }

    // Verify proof of work
    const hash = createHash('sha256').update(`${input.challengeId}:${input.nonce}`, 'utf8').digest('hex');
    if (!hash.endsWith('0'.repeat(challenge.difficulty))) {
      await client1.query('ROLLBACK');
      throw new AppError(400, 'invalid_proof', 'The submitted proof does not meet the difficulty requirement');
    }

    // Count attempts
    const countResult = await client1.query<{ count: string }>(
      `select count(*)::text as count from admission_attempts where challenge_id = $1`,
      [input.challengeId],
    );
    attemptCount = Number(countResult.rows[0]?.count ?? 0);
    if (attemptCount >= MAX_ADMISSION_ATTEMPTS) {
      await client1.query(`delete from admission_attempts where challenge_id = $1`, [input.challengeId]);
      await client1.query(`delete from admission_challenges where id = $1`, [input.challengeId]);
      await client1.query('COMMIT');
      return { status: 'attempts_exhausted', message: 'You have used all attempts. Please request a new challenge to try again.' };
    }

    challengeData = challenge;
    await client1.query('COMMIT');
  } catch (error) {
    try { await client1.query('ROLLBACK'); } catch { /* ignore */ }
    throw error;
  } finally {
    client1.release();
  }

  // Phase 2: LLM gate
  const gateResult = await runAdmissionGate(
    { name: input.name, email: input.email, socials: input.socials, application: input.application },
    { name: challengeData.club_name, summary: challengeData.club_summary, admissionPolicy: challengeData.policy_snapshot },
  );

  // Phase 3: Record result
  return withTransaction(pool, async (client) => {
    // Re-validate challenge
    const recheck = await client.query<ChallengeRow>(
      `select id, difficulty, expires_at::text as expires_at, club_id, policy_snapshot, club_name, club_summary, owner_name
       from admission_challenges where id = $1 for update`,
      [input.challengeId],
    );
    if (!recheck.rows[0]) throw new AppError(409, 'challenge_consumed', 'Challenge was consumed by a concurrent request');
    if (Date.parse(recheck.rows[0].expires_at) < Date.now()) {
      await client.query(`delete from admission_attempts where challenge_id = $1`, [input.challengeId]);
      await client.query(`delete from admission_challenges where id = $1`, [input.challengeId]);
      throw new AppError(410, 'challenge_expired', 'This challenge has expired');
    }

    // Re-count attempts
    const liveCount = await client.query<{ count: string }>(
      `select count(*)::text as count from admission_attempts where challenge_id = $1`,
      [input.challengeId],
    );
    const attemptNo = Number(liveCount.rows[0]?.count ?? 0) + 1;
    if (attemptNo > MAX_ADMISSION_ATTEMPTS) {
      await client.query(`delete from admission_attempts where challenge_id = $1`, [input.challengeId]);
      await client.query(`delete from admission_challenges where id = $1`, [input.challengeId]);
      return { status: 'attempts_exhausted' as const, message: 'You have used all attempts. Please request a new challenge to try again.' };
    }

    if (gateResult.status === 'failed') {
      throw new AppError(503, 'gate_unavailable', 'Application gate is temporarily unavailable. Please try again later.');
    }

    const gatePassed = gateResult.status === 'passed';
    const gateStatus = gateResult.status === 'passed' ? 'passed'
      : gateResult.status === 'skipped' ? 'skipped'
      : gateResult.status === 'rejected_illegal' ? 'rejected_illegal'
      : 'rejected';
    const gateFeedback = (gateResult.status === 'rejected' || gateResult.status === 'rejected_illegal') ? gateResult.feedback : null;
    const payload = JSON.stringify({ socials: input.socials, application: input.application });

    // Record attempt
    await client.query(
      `insert into admission_attempts (challenge_id, club_id, attempt_no, applicant_name, applicant_email, payload, gate_status, gate_feedback, policy_snapshot)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)`,
      [input.challengeId, challengeData.club_id, attemptNo, input.name, input.email, payload, gateStatus, gateFeedback, challengeData.policy_snapshot],
    );

    if (gatePassed) {
      // Create admission
      const admissionDetails = JSON.stringify({ socials: input.socials, application: input.application });
      const admissionResult = await client.query<{ id: string }>(
        `insert into admissions (club_id, origin, applicant_email, applicant_name, admission_details)
         values ($1, 'self_applied', $2, $3, $4::jsonb) returning id`,
        [challengeData.club_id, input.email, input.name, admissionDetails],
      );
      const admissionId = admissionResult.rows[0]?.id;
      if (!admissionId) throw new AppError(500, 'admission_creation_failed', 'Failed to create admission');

      await client.query(
        `insert into admission_versions (admission_id, status, notes, version_no)
         values ($1, 'submitted', 'Self-applied via cold admission', 1)`,
        [admissionId],
      );

      // Delete challenge
      await client.query(`delete from admission_attempts where challenge_id = $1`, [input.challengeId]);
      await client.query(`delete from admission_challenges where id = $1`, [input.challengeId]);

      // Notify via activity
      await appendClubActivity(client, {
        clubId: challengeData.club_id,
        topic: 'admission.submitted',
        createdByMemberId: null,
        payload: { admissionId, origin: 'self_applied', applicantName: input.name },
        audience: 'clubadmins',
      });

      // Log LLM usage (fire and forget — errors don't block)
      const usage = 'usage' in gateResult ? gateResult.usage : null;
      client.query(
        `insert into ai_llm_usage_log (member_id, requested_club_id, action_name, gate_name, provider, model, gate_status, skip_reason, prompt_tokens, completion_tokens, provider_error_code)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [null, challengeData.club_id, 'admissions.public.submitApplication', 'admission_gate', QUALITY_GATE_PROVIDER, CLAWCLUB_OPENAI_MODEL, gateStatus, null, usage?.promptTokens ?? null, usage?.completionTokens ?? null, null],
      ).catch(() => {});

      return {
        status: 'accepted' as const,
        message: `Your application has been submitted. ${challengeData.owner_name} will contact you by email to let you know whether an interview has been scheduled. If you don't hear back, know that there are many other clubs you can join.`,
      };
    } else if (attemptNo >= MAX_ADMISSION_ATTEMPTS) {
      await client.query(`delete from admission_attempts where challenge_id = $1`, [input.challengeId]);
      await client.query(`delete from admission_challenges where id = $1`, [input.challengeId]);
      return { status: 'attempts_exhausted' as const, message: 'You have used all attempts. Please request a new challenge to try again.' };
    } else {
      return { status: 'needs_revision' as const, feedback: gateFeedback!, attemptsRemaining: MAX_ADMISSION_ATTEMPTS - attemptNo };
    }
  });
}

// ── Cross-apply path (existing network members) ───────────────

/**
 * Assert cross-apply eligibility. Runs against the provided client so it
 * participates in the caller's transaction (needed for atomicity in Phase 3).
 * On failure, throws — caller is responsible for rollback.
 */
async function assertCrossEligibility(client: DbClient, memberId: string, clubId: string): Promise<void> {
  const hasActive = await client.query<{ ok: boolean }>(
    `select exists(select 1 from current_club_memberships where member_id = $1 and status = 'active') as ok`,
    [memberId],
  );
  if (!hasActive.rows[0]?.ok) {
    throw new AppError(403, 'no_active_membership', 'You must be an active member of at least one club to cross-apply');
  }

  const existingMembership = await client.query<{ id: string }>(
    `select id from club_memberships where club_id = $1 and member_id = $2 limit 1`,
    [clubId, memberId],
  );
  if (existingMembership.rows[0]) {
    throw new AppError(409, 'membership_exists', 'You have a prior membership record in this club. Contact the club admin.');
  }

  const existingAdmission = await client.query<{ id: string }>(
    `select ca.id from current_admissions ca
     where ca.club_id = $1 and ca.applicant_member_id = $2
       and ca.status in ('submitted', 'interview_scheduled', 'interview_completed', 'draft')
     limit 1`,
    [clubId, memberId],
  );
  if (existingAdmission.rows[0]) {
    throw new AppError(409, 'admission_pending', 'You already have a pending admission for this club');
  }

  const pendingCount = await client.query<{ count: string }>(
    `select count(*)::text as count from current_admissions ca
     where ca.applicant_member_id = $1
       and ca.status in ('submitted', 'interview_scheduled', 'interview_completed')`,
    [memberId],
  );
  if (Number(pendingCount.rows[0]?.count ?? 0) >= MAX_PENDING_CROSS_APPLICATIONS) {
    throw new AppError(429, 'too_many_pending', `You have too many pending applications. Wait for existing applications to be resolved before applying to more clubs (max ${MAX_PENDING_CROSS_APPLICATIONS}).`);
  }
}

export async function createCrossChallenge(pool: Pool, input: {
  memberId: string;
  clubId: string;
  clubName: string;
  clubSummary: string | null;
  admissionPolicy: string;
  ownerName: string;
}): Promise<{ challengeId: string; difficulty: number; expiresAt: string; maxAttempts: number }> {
  await assertCrossEligibility(pool, input.memberId, input.clubId);

  // Guard: profile must have a usable name and email
  const contact = await pool.query<{ public_name: string; email: string | null }>(
    `select m.public_name, mpc.email
     from members m
     left join member_private_contacts mpc on mpc.member_id = m.id
     where m.id = $1`,
    [input.memberId],
  );
  const memberContact = contact.rows[0];
  if (!memberContact || !memberContact.public_name || memberContact.public_name.trim().length === 0) {
    throw new AppError(422, 'incomplete_profile', 'Your profile is missing a name. Update your profile before cross-applying.');
  }
  if (!memberContact.email || memberContact.email.trim().length === 0) {
    throw new AppError(422, 'incomplete_profile', 'Your profile is missing an email. Update your profile before cross-applying.');
  }

  const result = await pool.query<{ id: string; expires_at: string }>(
    `insert into admission_challenges (difficulty, club_id, member_id, policy_snapshot, club_name, club_summary, owner_name, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, now() + ($8 || ' milliseconds')::interval)
     returning id, expires_at::text as expires_at`,
    [CROSS_APPLICATION_DIFFICULTY, input.clubId, input.memberId, input.admissionPolicy, input.clubName, input.clubSummary, input.ownerName, COLD_APPLICATION_CHALLENGE_TTL_MS],
  );
  const row = result.rows[0];
  if (!row) throw new AppError(500, 'invalid_data', 'Admission challenge was not created');

  return {
    challengeId: row.id,
    difficulty: CROSS_APPLICATION_DIFFICULTY,
    expiresAt: new Date(Date.parse(row.expires_at)).toISOString(),
    maxAttempts: MAX_ADMISSION_ATTEMPTS,
  };
}

export async function solveCrossChallenge(pool: Pool, input: {
  memberId: string;
  challengeId: string;
  nonce: string;
  socials: string;
  application: string;
}): Promise<AdmissionApplyResult> {
  // Phase 1: Validate challenge and member binding
  type ChallengeRow = {
    id: string; difficulty: number; expires_at: string; member_id: string | null;
    club_id: string; policy_snapshot: string;
    club_name: string; club_summary: string | null; owner_name: string;
  };

  let challengeData: ChallengeRow;
  let memberName: string;
  let memberEmail: string;

  const client1 = await pool.connect();
  try {
    await client1.query('BEGIN');
    const challengeResult = await client1.query<ChallengeRow>(
      `select id, difficulty, expires_at::text as expires_at, member_id, club_id, policy_snapshot, club_name, club_summary, owner_name
       from admission_challenges where id = $1 for update`,
      [input.challengeId],
    );
    const challenge = challengeResult.rows[0];
    if (!challenge) { await client1.query('ROLLBACK'); throw new AppError(404, 'challenge_not_found', 'Challenge not found'); }

    // Verify challenge is bound to this member
    if (challenge.member_id !== input.memberId) {
      await client1.query('ROLLBACK');
      throw new AppError(403, 'challenge_not_yours', 'This challenge was not issued to you');
    }

    // Early eligibility check (avoids wasting an LLM call; authoritative check is in Phase 3)
    await assertCrossEligibility(client1, input.memberId, challenge.club_id);

    if (Date.parse(challenge.expires_at) < Date.now()) {
      await client1.query(`delete from admission_attempts where challenge_id = $1`, [input.challengeId]);
      await client1.query(`delete from admission_challenges where id = $1`, [input.challengeId]);
      await client1.query('COMMIT');
      throw new AppError(410, 'challenge_expired', 'This challenge has expired');
    }

    // Verify proof of work
    const hash = createHash('sha256').update(`${input.challengeId}:${input.nonce}`, 'utf8').digest('hex');
    if (!hash.endsWith('0'.repeat(challenge.difficulty))) {
      await client1.query('ROLLBACK');
      throw new AppError(400, 'invalid_proof', 'The submitted proof does not meet the difficulty requirement');
    }

    // Count attempts
    const countResult = await client1.query<{ count: string }>(
      `select count(*)::text as count from admission_attempts where challenge_id = $1`,
      [input.challengeId],
    );
    const attemptCount = Number(countResult.rows[0]?.count ?? 0);
    if (attemptCount >= MAX_ADMISSION_ATTEMPTS) {
      await client1.query(`delete from admission_attempts where challenge_id = $1`, [input.challengeId]);
      await client1.query(`delete from admission_challenges where id = $1`, [input.challengeId]);
      await client1.query('COMMIT');
      return { status: 'attempts_exhausted', message: 'You have used all attempts. Please request a new challenge to try again.' };
    }

    // Snapshot name and email from profile
    const contactResult = await client1.query<{ public_name: string; email: string | null }>(
      `select m.public_name, mpc.email
       from members m
       left join member_private_contacts mpc on mpc.member_id = m.id
       where m.id = $1`,
      [input.memberId],
    );
    const contact = contactResult.rows[0];
    if (!contact?.public_name || !contact.email) {
      await client1.query('ROLLBACK');
      throw new AppError(422, 'incomplete_profile', 'Your profile is missing a name or email. Update your profile before cross-applying.');
    }
    memberName = contact.public_name;
    memberEmail = contact.email;

    challengeData = challenge;
    await client1.query('COMMIT');
  } catch (error) {
    try { await client1.query('ROLLBACK'); } catch { /* ignore */ }
    throw error;
  } finally {
    client1.release();
  }

  // Phase 2: LLM admission gate (completeness check — same as cold)
  const gateResult = await runAdmissionGate(
    { name: memberName, email: memberEmail, socials: input.socials, application: input.application },
    { name: challengeData.club_name, summary: challengeData.club_summary, admissionPolicy: challengeData.policy_snapshot },
  );

  // Phase 3: Record result
  return withTransaction(pool, async (client) => {
    // Re-validate challenge
    const recheck = await client.query<ChallengeRow>(
      `select id, difficulty, expires_at::text as expires_at, member_id, club_id, policy_snapshot, club_name, club_summary, owner_name
       from admission_challenges where id = $1 for update`,
      [input.challengeId],
    );
    if (!recheck.rows[0]) throw new AppError(409, 'challenge_consumed', 'Challenge was consumed by a concurrent request');
    if (Date.parse(recheck.rows[0].expires_at) < Date.now()) {
      await client.query(`delete from admission_attempts where challenge_id = $1`, [input.challengeId]);
      await client.query(`delete from admission_challenges where id = $1`, [input.challengeId]);
      throw new AppError(410, 'challenge_expired', 'This challenge has expired');
    }

    // Re-count attempts
    const liveCount = await client.query<{ count: string }>(
      `select count(*)::text as count from admission_attempts where challenge_id = $1`,
      [input.challengeId],
    );
    const attemptNo = Number(liveCount.rows[0]?.count ?? 0) + 1;
    if (attemptNo > MAX_ADMISSION_ATTEMPTS) {
      await client.query(`delete from admission_attempts where challenge_id = $1`, [input.challengeId]);
      await client.query(`delete from admission_challenges where id = $1`, [input.challengeId]);
      return { status: 'attempts_exhausted' as const, message: 'You have used all attempts. Please request a new challenge to try again.' };
    }

    if (gateResult.status === 'failed') {
      throw new AppError(503, 'gate_unavailable', 'Application gate is temporarily unavailable. Please try again later.');
    }

    const gatePassed = gateResult.status === 'passed';
    const gateStatus = gateResult.status === 'passed' ? 'passed'
      : gateResult.status === 'skipped' ? 'skipped'
      : gateResult.status === 'rejected_illegal' ? 'rejected_illegal'
      : 'rejected';
    const gateFeedback = (gateResult.status === 'rejected' || gateResult.status === 'rejected_illegal') ? gateResult.feedback : null;
    const payload = JSON.stringify({ socials: input.socials, application: input.application });

    // Record attempt
    await client.query(
      `insert into admission_attempts (challenge_id, club_id, attempt_no, applicant_name, applicant_email, payload, gate_status, gate_feedback, policy_snapshot)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)`,
      [input.challengeId, challengeData.club_id, attemptNo, memberName, memberEmail, payload, gateStatus, gateFeedback, challengeData.policy_snapshot],
    );

    if (gatePassed) {
      // Serialize all cross-apply inserts for this member. Advisory lock is held until
      // transaction commit, so concurrent solves for the same member will queue here.
      // This ensures assertCrossEligibility + insert are atomic with respect to each other.
      await client.query(
        `select pg_advisory_xact_lock(hashtext('cross_apply:' || $1))`,
        [input.memberId],
      );

      // Authoritative eligibility check — now serialized by the advisory lock
      await assertCrossEligibility(client, input.memberId, challengeData.club_id);

      // Create admission with applicant_member_id set (existing network member)
      const admissionDetails = JSON.stringify({ socials: input.socials, application: input.application });
      const admissionResult = await client.query<{ id: string }>(
        `insert into admissions (club_id, origin, applicant_member_id, applicant_email, applicant_name, admission_details)
         values ($1, 'self_applied', $2, $3, $4, $5::jsonb) returning id`,
        [challengeData.club_id, input.memberId, memberEmail, memberName, admissionDetails],
      );
      const admissionId = admissionResult.rows[0]?.id;
      if (!admissionId) throw new AppError(500, 'admission_creation_failed', 'Failed to create admission');

      await client.query(
        `insert into admission_versions (admission_id, status, notes, version_no, created_by_member_id)
         values ($1, 'submitted', 'Cross-applied by existing network member', 1, $2)`,
        [admissionId, input.memberId],
      );

      // Delete challenge
      await client.query(`delete from admission_attempts where challenge_id = $1`, [input.challengeId]);
      await client.query(`delete from admission_challenges where id = $1`, [input.challengeId]);

      // Notify via activity
      await appendClubActivity(client, {
        clubId: challengeData.club_id,
        topic: 'admission.submitted',
        createdByMemberId: input.memberId,
        payload: { admissionId, origin: 'self_applied', applicantName: memberName, crossApply: true },
        audience: 'clubadmins',
      });

      // Log LLM usage
      const usage = 'usage' in gateResult ? gateResult.usage : null;
      client.query(
        `insert into ai_llm_usage_log (member_id, requested_club_id, action_name, gate_name, provider, model, gate_status, skip_reason, prompt_tokens, completion_tokens, provider_error_code)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [input.memberId, challengeData.club_id, 'admissions.crossClub.submitApplication', 'admission_gate', QUALITY_GATE_PROVIDER, CLAWCLUB_OPENAI_MODEL, gateStatus, null, usage?.promptTokens ?? null, usage?.completionTokens ?? null, null],
      ).catch(() => {});

      return {
        status: 'accepted' as const,
        message: `Your application has been submitted. ${challengeData.owner_name} will review your application and contact you if an interview is scheduled.`,
      };
    } else if (attemptNo >= MAX_ADMISSION_ATTEMPTS) {
      await client.query(`delete from admission_attempts where challenge_id = $1`, [input.challengeId]);
      await client.query(`delete from admission_challenges where id = $1`, [input.challengeId]);
      return { status: 'attempts_exhausted' as const, message: 'You have used all attempts. Please request a new challenge to try again.' };
    } else {
      return { status: 'needs_revision' as const, feedback: gateFeedback!, attemptsRemaining: MAX_ADMISSION_ATTEMPTS - attemptNo };
    }
  });
}
