/**
 * Club plane — admission workflow.
 *
 * Admissions, admission_versions, admission_challenges, admission_attempts.
 * Cross-plane saga (member creation on acceptance) is handled in the composition layer.
 */

import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { AppError, type AdmissionStatus, type AdmissionSummary, type AdmissionApplyResult } from '../contract.ts';
import { runAdmissionGate, QUALITY_GATE_PROVIDER, type QualityGateResult } from '../quality-gate.ts';
import { CLAWCLUB_OPENAI_MODEL } from '../ai.ts';
import { withTransaction, type DbClient } from '../db.ts';
import { appendClubActivity } from './entities.ts';

const COLD_APPLICATION_DIFFICULTY = 7;
const COLD_APPLICATION_CHALLENGE_TTL_MS = 60 * 60 * 1000;
const MAX_ADMISSION_ATTEMPTS = 5;

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
    `select ${ADMISSION_SELECT} from app.current_admissions ca where ca.id = $1 limit 1`,
    [admissionId],
  );
  return result.rows[0] ?? null;
}

/**
 * Transition an admission to the next status. Does NOT handle member creation
 * on acceptance — that's the composition layer's job.
 * Returns the admission row data and the fields needed for the acceptance saga.
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
       from app.current_admissions ca
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
      `update app.admissions set metadata = $2::jsonb where id = $1`,
      [admission.admission_id, JSON.stringify(mergedMetadata)],
    );

    // Insert new admission version
    await client.query(
      `insert into app.admission_versions (
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
    `update app.admissions set applicant_member_id = $2, membership_id = $3 where id = $1`,
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
    `insert into app.admission_challenges (difficulty, club_id, policy_snapshot, club_name, club_summary, owner_name, expires_at)
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
    id: string; difficulty: number; expires_at: string;
    club_id: string; policy_snapshot: string;
    club_name: string; club_summary: string | null; owner_name: string;
  };

  let challengeData: ChallengeRow;
  let attemptCount: number;

  const client1 = await pool.connect();
  try {
    await client1.query('BEGIN');
    const challengeResult = await client1.query<ChallengeRow>(
      `select id, difficulty, expires_at::text as expires_at, club_id, policy_snapshot, club_name, club_summary, owner_name
       from app.admission_challenges where id = $1 for update`,
      [input.challengeId],
    );
    const challenge = challengeResult.rows[0];
    if (!challenge) { await client1.query('ROLLBACK'); throw new AppError(404, 'challenge_not_found', 'Challenge not found'); }

    if (Date.parse(challenge.expires_at) < Date.now()) {
      await client1.query(`delete from app.admission_challenges where id = $1`, [input.challengeId]);
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
      `select count(*)::text as count from app.admission_attempts where challenge_id = $1`,
      [input.challengeId],
    );
    attemptCount = Number(countResult.rows[0]?.count ?? 0);
    if (attemptCount >= MAX_ADMISSION_ATTEMPTS) {
      await client1.query(`delete from app.admission_challenges where id = $1`, [input.challengeId]);
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
       from app.admission_challenges where id = $1 for update`,
      [input.challengeId],
    );
    if (!recheck.rows[0]) throw new AppError(409, 'challenge_consumed', 'Challenge was consumed by a concurrent request');
    if (Date.parse(recheck.rows[0].expires_at) < Date.now()) {
      await client.query(`delete from app.admission_challenges where id = $1`, [input.challengeId]);
      throw new AppError(410, 'challenge_expired', 'This challenge has expired');
    }

    // Re-count attempts
    const liveCount = await client.query<{ count: string }>(
      `select count(*)::text as count from app.admission_attempts where challenge_id = $1`,
      [input.challengeId],
    );
    const attemptNo = Number(liveCount.rows[0]?.count ?? 0) + 1;
    if (attemptNo > MAX_ADMISSION_ATTEMPTS) {
      await client.query(`delete from app.admission_challenges where id = $1`, [input.challengeId]);
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
      `insert into app.admission_attempts (challenge_id, club_id, attempt_no, applicant_name, applicant_email, payload, gate_status, gate_feedback, policy_snapshot)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)`,
      [input.challengeId, challengeData.club_id, attemptNo, input.name, input.email, payload, gateStatus, gateFeedback, challengeData.policy_snapshot],
    );

    if (gatePassed) {
      // Create admission
      const admissionDetails = JSON.stringify({ socials: input.socials, application: input.application });
      const admissionResult = await client.query<{ id: string }>(
        `insert into app.admissions (club_id, origin, applicant_email, applicant_name, admission_details)
         values ($1, 'self_applied', $2, $3, $4::jsonb) returning id`,
        [challengeData.club_id, input.email, input.name, admissionDetails],
      );
      const admissionId = admissionResult.rows[0]?.id;
      if (!admissionId) throw new AppError(500, 'admission_creation_failed', 'Failed to create admission');

      await client.query(
        `insert into app.admission_versions (admission_id, status, notes, version_no)
         values ($1, 'submitted', 'Self-applied via cold admission', 1)`,
        [admissionId],
      );

      // Delete challenge
      await client.query(`delete from app.admission_challenges where id = $1`, [input.challengeId]);

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
        `insert into app.llm_usage_log (member_id, requested_club_id, action_name, gate_name, provider, model, gate_status, skip_reason, prompt_tokens, completion_tokens, provider_error_code)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [null, challengeData.club_id, 'admissions.apply', 'admission_gate', QUALITY_GATE_PROVIDER, CLAWCLUB_OPENAI_MODEL, gateStatus, null, usage?.promptTokens ?? null, usage?.completionTokens ?? null, null],
      ).catch(() => {});

      return {
        status: 'accepted' as const,
        message: `Your application has been submitted. ${challengeData.owner_name} will contact you by email to let you know whether an interview has been scheduled. If you don't hear back, know that there are many other clubs you can join.`,
      };
    } else if (attemptNo >= MAX_ADMISSION_ATTEMPTS) {
      await client.query(`delete from app.admission_challenges where id = $1`, [input.challengeId]);
      return { status: 'attempts_exhausted' as const, message: 'You have used all attempts. Please request a new challenge to try again.' };
    } else {
      return { status: 'needs_revision' as const, feedback: gateFeedback!, attemptsRemaining: MAX_ADMISSION_ATTEMPTS - attemptNo };
    }
  });
}
