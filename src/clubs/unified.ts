import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import {
  AppError,
  type ApplicationSummary,
  type InvitationStatus,
  type InvitationSummary,
  type JoinClubInput,
  type JoinClubResult,
  type MembershipState,
  type SubmitClubApplicationInput,
  type SubmitClubApplicationResult,
} from '../contract.ts';
import { withTransaction, type DbClient } from '../db.ts';
import { generateClubApplicationProfile } from '../identity/profiles.ts';
import { buildBearerToken, buildInvitationCode, generateTokenId, hashTokenSecret, parseInvitationCode } from '../token.ts';
import { runApplicationGate } from '../admissions-gate.ts';

const COLD_APPLICATION_DIFFICULTY = 7;
const CROSS_APPLICATION_DIFFICULTY = 5;
const APPLICATION_CHALLENGE_TTL_MS = 60 * 60 * 1000;
const MAX_APPLICATION_ATTEMPTS = 5;
const MAX_PENDING_APPLICATIONS = 3;
const OPEN_INVITATION_CAP = 3;

type ClubLookupRow = {
  club_id: string;
  slug: string;
  name: string;
  summary: string | null;
  admission_policy: string | null;
  membership_price_amount: string | null;
  membership_price_currency: string | null;
  owner_name: string;
};

type MembershipApplicationRow = {
  membership_id: string;
  club_id: string;
  club_slug: string;
  club_name: string;
  member_id: string;
  sponsor_member_id: string | null;
  sponsor_public_name: string | null;
  member_public_name: string;
  role: 'clubadmin' | 'member';
  status: MembershipState;
  state_reason: string | null;
  state_version_no: number;
  state_created_at: string;
  state_created_by_member_id: string | null;
  joined_at: string | null;
  accepted_covenant_at: string | null;
  metadata: Record<string, unknown> | null;
  application_name: string | null;
  application_email: string | null;
  application_socials: string | null;
  application_text: string | null;
  applied_at: string | null;
  application_submitted_at: string | null;
  submission_path: 'cold' | 'invitation' | 'cross_apply' | 'owner_nominated' | null;
  proof_kind: 'pow' | 'invitation' | 'none' | null;
  invitation_id: string | null;
  generated_profile_draft: Record<string, unknown> | null;
  club_summary: string | null;
  owner_name: string;
  admission_policy: string | null;
  membership_price_amount: string | null;
  membership_price_currency: string | null;
  accessible: boolean;
  is_owner: boolean;
};

type InvitationRow = {
  invitation_id: string;
  club_id: string;
  sponsor_member_id: string;
  sponsor_public_name: string;
  candidate_name: string;
  candidate_email: string;
  candidate_email_normalized: string;
  reason: string;
  code_hash: string;
  expires_at: string;
  expired_at: string | null;
  used_at: string | null;
  used_membership_id: string | null;
  revoked_at: string | null;
  created_at: string;
};

type PowChallengeRow = {
  challenge_id: string;
  membership_id: string;
  difficulty: number;
  expires_at: string;
  solved_at: string | null;
  attempts: number;
  created_at: string;
};

function getPositiveIntegerEnv(name: string): number | null {
  const raw = process.env[name];
  if (raw == null || raw.trim().length === 0) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return null;
  return parsed;
}

function getColdApplicationDifficulty(): number {
  return getPositiveIntegerEnv('CLAWCLUB_TEST_COLD_APPLICATION_DIFFICULTY') ?? COLD_APPLICATION_DIFFICULTY;
}

function getCrossApplicationDifficulty(): number {
  return getPositiveIntegerEnv('CLAWCLUB_TEST_CROSS_APPLICATION_DIFFICULTY') ?? CROSS_APPLICATION_DIFFICULTY;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function validateApplicationPow(challengeId: string, nonce: string, difficulty: number): boolean {
  const hash = createHash('sha256').update(`${challengeId}:${nonce}`, 'utf8').digest('hex');
  return hash.endsWith('0'.repeat(difficulty));
}

function decideApplicationTimestamp(status: MembershipState, stateCreatedAt: string): string | null {
  return ['applying', 'submitted', 'interview_scheduled', 'interview_completed'].includes(status)
    ? null
    : stateCreatedAt;
}

function mapApplicationSummary(row: MembershipApplicationRow): ApplicationSummary {
  const billingRequired = row.membership_price_amount !== null;
  return {
    membershipId: row.membership_id,
    clubId: row.club_id,
    clubSlug: row.club_slug,
    clubName: row.club_name,
    state: row.status,
    submissionPath: row.submission_path ?? 'owner_nominated',
    appliedAt: row.applied_at ?? row.state_created_at,
    submittedAt: row.application_submitted_at,
    decidedAt: decideApplicationTimestamp(row.status, row.state_created_at),
    applicationName: row.application_name,
    applicationEmail: row.application_email,
    applicationSocials: row.application_socials,
    applicationText: row.application_text,
    billing: {
      required: billingRequired,
      membershipState: row.status,
      accessible: row.accessible,
    },
  };
}

function computeInvitationStatus(row: InvitationRow): InvitationStatus {
  if (row.revoked_at) return 'revoked';
  if (row.used_at) return 'used';
  if (row.expired_at || Date.parse(row.expires_at) <= Date.now()) return 'expired';
  return 'open';
}

function mapInvitationSummary(row: InvitationRow): InvitationSummary {
  return {
    invitationId: row.invitation_id,
    clubId: row.club_id,
    candidateName: row.candidate_name,
    candidateEmail: row.candidate_email,
    sponsor: {
      memberId: row.sponsor_member_id,
      publicName: row.sponsor_public_name,
    },
    reason: row.reason,
    status: computeInvitationStatus(row),
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

async function readClubBySlug(client: DbClient, clubSlug: string): Promise<ClubLookupRow | null> {
  const result = await client.query<ClubLookupRow>(
    `select
        c.id as club_id,
        c.slug,
        c.name,
        c.summary,
        c.admission_policy,
        c.membership_price_amount::text as membership_price_amount,
        c.membership_price_currency,
        owner.public_name as owner_name
     from clubs c
     join members owner on owner.id = c.owner_member_id
     where c.slug = $1
       and c.archived_at is null
     limit 1`,
    [clubSlug],
  );
  return result.rows[0] ?? null;
}

async function readMemberContactEmail(client: DbClient, memberId: string): Promise<string | null> {
  const result = await client.query<{ email: string | null }>(
    `select email from member_private_contacts where member_id = $1`,
    [memberId],
  );
  return result.rows[0]?.email ?? null;
}

async function setMemberContactEmail(client: DbClient, memberId: string, email: string): Promise<void> {
  await client.query(
    `insert into member_private_contacts (member_id, email)
     values ($1, $2)
     on conflict (member_id) do update
       set email = excluded.email`,
    [memberId, email],
  );
}

async function issueBearerToken(client: DbClient, memberId: string, label: string, metadata: Record<string, unknown>): Promise<string> {
  const token = buildBearerToken();
  await client.query(
    `insert into member_bearer_tokens (id, member_id, label, token_hash, metadata)
     values ($1, $2, $3, $4, $5::jsonb)`,
    [token.tokenId, memberId, label, token.tokenHash, JSON.stringify(metadata)],
  );
  return token.bearerToken;
}

function buildPlaceholderName(email: string, nameHint?: string | null): string {
  if (nameHint && nameHint.trim().length > 0) {
    return nameHint.trim();
  }
  const local = email.split('@')[0] ?? 'applicant';
  const cleaned = local.replace(/[._-]+/g, ' ').trim();
  return cleaned.length > 0 ? cleaned : 'Applicant';
}

async function createAnonymousMember(client: DbClient, input: {
  email: string;
  nameHint?: string | null;
}): Promise<string> {
  const publicName = buildPlaceholderName(input.email, input.nameHint);
  const result = await client.query<{ member_id: string }>(
    `insert into members (public_name, display_name, state)
     values ($1, $1, 'active')
     returning id as member_id`,
    [publicName],
  );
  const memberId = result.rows[0]?.member_id;
  if (!memberId) {
    throw new AppError(500, 'member_creation_failed', 'Failed to create member');
  }
  await setMemberContactEmail(client, memberId, input.email);
  return memberId;
}

async function readMembershipApplicationRow(client: DbClient, membershipId: string): Promise<MembershipApplicationRow | null> {
  const result = await client.query<MembershipApplicationRow>(
    `select
        cm.id as membership_id,
        cm.club_id,
        c.slug as club_slug,
        c.name as club_name,
        cm.member_id,
        cm.sponsor_member_id,
        sponsor.public_name as sponsor_public_name,
        member_row.public_name as member_public_name,
        cm.role::text as role,
        cm.status,
        cm.state_reason,
        cm.state_version_no,
        cm.state_created_at::text as state_created_at,
        cm.state_created_by_member_id,
        cm.joined_at::text as joined_at,
        cm.accepted_covenant_at::text as accepted_covenant_at,
        cm.metadata,
        cm.application_name,
        cm.application_email,
        cm.application_socials,
        cm.application_text,
        cm.applied_at::text as applied_at,
        cm.application_submitted_at::text as application_submitted_at,
        cm.submission_path,
        cm.proof_kind,
        cm.invitation_id,
        cm.generated_profile_draft,
        c.summary as club_summary,
        owner.public_name as owner_name,
        c.admission_policy,
        c.membership_price_amount::text as membership_price_amount,
        c.membership_price_currency,
        exists(
          select 1
          from accessible_club_memberships acm
          where acm.id = cm.id
        ) as accessible,
        (c.owner_member_id = cm.member_id) as is_owner
     from current_club_memberships cm
     join clubs c on c.id = cm.club_id
     join members owner on owner.id = c.owner_member_id
     join members member_row on member_row.id = cm.member_id
     left join members sponsor on sponsor.id = cm.sponsor_member_id
     where cm.id = $1
     limit 1`,
    [membershipId],
  );
  return result.rows[0] ?? null;
}

async function readActivePowChallenge(client: DbClient, membershipId: string): Promise<PowChallengeRow | null> {
  const result = await client.query<PowChallengeRow>(
    `select
        id as challenge_id,
        membership_id,
        difficulty,
        expires_at::text as expires_at,
        solved_at::text as solved_at,
        attempts,
        created_at::text as created_at
     from application_pow_challenges
     where membership_id = $1
       and solved_at is null
     order by created_at desc
     limit 1`,
    [membershipId],
  );
  return result.rows[0] ?? null;
}

async function ensurePowChallenge(client: DbClient, membershipId: string, difficulty: number): Promise<JoinClubResult['proof']> {
  const existing = await readActivePowChallenge(client, membershipId);
  if (existing && Date.parse(existing.expires_at) > Date.now()) {
    return {
      kind: 'pow',
      challengeId: existing.challenge_id,
      difficulty: existing.difficulty,
      expiresAt: existing.expires_at,
      maxAttempts: MAX_APPLICATION_ATTEMPTS,
    };
  }

  if (existing) {
    await client.query(`delete from application_pow_challenges where id = $1`, [existing.challenge_id]);
  }

  const result = await client.query<{ challenge_id: string; expires_at: string }>(
    `insert into application_pow_challenges (membership_id, difficulty, expires_at)
     values ($1, $2, now() + ($3 || ' milliseconds')::interval)
     returning id as challenge_id, expires_at::text as expires_at`,
    [membershipId, difficulty, APPLICATION_CHALLENGE_TTL_MS],
  );
  const row = result.rows[0];
  if (!row) {
    throw new AppError(500, 'challenge_creation_failed', 'Failed to create application challenge');
  }
  return {
    kind: 'pow',
    challengeId: row.challenge_id,
    difficulty,
    expiresAt: row.expires_at,
    maxAttempts: MAX_APPLICATION_ATTEMPTS,
  };
}

async function materializeExpiredInvitation(client: DbClient, invitationId: string): Promise<void> {
  await client.query(
    `update invitations
     set expired_at = now()
     where id = $1
       and expired_at is null
       and expires_at <= now()
       and used_at is null`,
    [invitationId],
  );
}

async function readInvitationForValidation(client: DbClient, invitationId: string): Promise<InvitationRow | null> {
  const result = await client.query<InvitationRow>(
    `select
        i.id as invitation_id,
        i.club_id,
        i.sponsor_member_id,
        sponsor.public_name as sponsor_public_name,
        i.candidate_name,
        i.candidate_email,
        i.candidate_email_normalized,
        i.reason,
        i.code_hash,
        i.expires_at::text as expires_at,
        i.expired_at::text as expired_at,
        i.used_at::text as used_at,
        i.used_membership_id,
        i.revoked_at::text as revoked_at,
        i.created_at::text as created_at
     from invitations i
     join members sponsor on sponsor.id = i.sponsor_member_id
     where i.id = $1
     for update`,
    [invitationId],
  );
  return result.rows[0] ?? null;
}

async function validateInvitationForJoin(client: DbClient, input: {
  invitationCode: string;
  clubId: string;
  normalizedEmail: string;
  replayMembershipId?: string | null;
}): Promise<InvitationRow> {
  const parsed = parseInvitationCode(input.invitationCode);
  if (!parsed) {
    throw new AppError(400, 'invalid_invitation_code', 'Invitation code is invalid');
  }

  await materializeExpiredInvitation(client, parsed.tokenId);
  const invitation = await readInvitationForValidation(client, parsed.tokenId);
  if (!invitation) {
    throw new AppError(400, 'invalid_invitation_code', 'Invitation code is invalid');
  }

  const sponsorLive = await client.query<{ ok: boolean }>(
    `select exists(
       select 1
       from accessible_club_memberships
       where club_id = $1
         and member_id = $2
     ) as ok`,
    [invitation.club_id, invitation.sponsor_member_id],
  );

  const replayAllowed = invitation.used_membership_id !== null && invitation.used_membership_id === input.replayMembershipId;
  const valid = invitation.club_id === input.clubId
    && invitation.candidate_email_normalized === input.normalizedEmail
    && invitation.revoked_at === null
    && (invitation.used_at === null || replayAllowed)
    && invitation.expired_at === null
    && Date.parse(invitation.expires_at) > Date.now()
    && sponsorLive.rows[0]?.ok === true
    && invitation.code_hash === hashTokenSecret(parsed.secret);

  if (!valid) {
    throw new AppError(400, 'invalid_invitation_code', 'Invitation code is invalid');
  }

  return invitation;
}

async function assertPendingApplicationCap(client: DbClient, memberId: string): Promise<void> {
  const result = await client.query<{ count: string }>(
    `select count(*)::text as count
     from current_club_memberships
     where member_id = $1
       and status in ('applying', 'submitted', 'interview_scheduled', 'interview_completed', 'payment_pending')`,
    [memberId],
  );
  if (Number(result.rows[0]?.count ?? 0) >= MAX_PENDING_APPLICATIONS) {
    throw new AppError(429, 'too_many_pending', `You have too many pending club applications (max ${MAX_PENDING_APPLICATIONS}).`);
  }
}

async function insertApplyingMembership(client: DbClient, input: {
  clubId: string;
  memberId: string;
  sponsorMemberId: string | null;
  applicationEmail: string;
  submissionPath: 'cold' | 'invitation' | 'cross_apply';
  proofKind: 'pow' | 'invitation';
  invitationId: string | null;
}): Promise<string> {
  const result = await client.query<{ membership_id: string }>(
    `insert into club_memberships (
        club_id,
        member_id,
        sponsor_member_id,
        role,
        status,
        application_email,
        applied_at,
        submission_path,
        proof_kind,
        invitation_id
     )
     values ($1, $2, $3, 'member', 'applying', $4, now(), $5, $6, $7)
     returning id as membership_id`,
    [
      input.clubId,
      input.memberId,
      input.sponsorMemberId,
      input.applicationEmail,
      input.submissionPath,
      input.proofKind,
      input.invitationId,
    ],
  );
  const membershipId = result.rows[0]?.membership_id;
  if (!membershipId) {
    throw new AppError(500, 'membership_creation_failed', 'Failed to create membership');
  }
  await client.query(
    `insert into club_membership_state_versions (membership_id, status, version_no)
     values ($1, 'applying', 1)`,
    [membershipId],
  );
  return membershipId;
}

async function materializeInvitationExpiryForTuple(client: DbClient, clubId: string, sponsorMemberId: string, normalizedEmail: string): Promise<void> {
  await client.query(
    `update invitations
     set expired_at = now()
     where club_id = $1
       and sponsor_member_id = $2
       and candidate_email_normalized = $3
       and expired_at is null
       and expires_at <= now()
       and used_at is null`,
    [clubId, sponsorMemberId, normalizedEmail],
  );
}

async function readCurrentOpenMembershipByMember(client: DbClient, clubId: string, memberId: string): Promise<{ membership_id: string; status: MembershipState; proof_kind: 'pow' | 'invitation' | 'none' | null } | null> {
  const result = await client.query<{ membership_id: string; status: MembershipState; proof_kind: 'pow' | 'invitation' | 'none' | null }>(
    `select id as membership_id, status, proof_kind
     from current_club_memberships
     where club_id = $1
       and member_id = $2
       and status <> all(array['declined'::membership_state, 'withdrawn'::membership_state, 'expired'::membership_state, 'removed'::membership_state, 'banned'::membership_state])
     order by applied_at desc nulls last, id desc
     limit 1`,
    [clubId, memberId],
  );
  return result.rows[0] ?? null;
}

async function hasActiveMembershipForPowDiscount(client: DbClient, memberId: string): Promise<boolean> {
  const result = await client.query<{ ok: boolean }>(
    `select exists(
       select 1
       from current_club_memberships
       where member_id = $1
         and status = 'active'
         and left_at is null
     ) as ok`,
    [memberId],
  );
  return result.rows[0]?.ok === true;
}

async function summarizeProofForMembership(client: DbClient, membershipId: string, proofKind: 'pow' | 'invitation' | 'none' | null, memberId: string): Promise<JoinClubResult['proof']> {
  if (proofKind === 'invitation' || proofKind === 'none') {
    return { kind: 'none' };
  }
  const crossApply = await hasActiveMembershipForPowDiscount(client, memberId);
  return ensurePowChallenge(client, membershipId, crossApply ? getCrossApplicationDifficulty() : getColdApplicationDifficulty());
}

export async function joinClub(pool: Pool, input: JoinClubInput): Promise<JoinClubResult> {
  return withTransaction(pool, async (client) => {
    const club = await readClubBySlug(client, input.clubSlug);
    if (!club) {
      throw new AppError(404, 'not_found', 'Club not found');
    }

    if (input.actorMemberId) {
      let email = await readMemberContactEmail(client, input.actorMemberId);
      if (!email) {
        if (!input.email) {
          throw new AppError(422, 'email_required_for_first_join', 'An email is required before this member can join a club');
        }
        email = input.email;
        await setMemberContactEmail(client, input.actorMemberId, email);
      }
      const normalizedEmail = normalizeEmail(email);

      if (input.invitationCode) {
        await validateInvitationForJoin(client, {
          invitationCode: input.invitationCode,
          clubId: club.club_id,
          normalizedEmail,
        });
      }

      await client.query(`select pg_advisory_xact_lock(hashtext('application_join:' || $1 || ':' || $2))`, [club.club_id, normalizedEmail]);
      await client.query(`select pg_advisory_xact_lock(hashtext('cross_apply:' || $1))`, [input.actorMemberId]);

      const existing = await readCurrentOpenMembershipByMember(client, club.club_id, input.actorMemberId);
      if (existing) {
        if (input.invitationCode) {
          await validateInvitationForJoin(client, {
            invitationCode: input.invitationCode,
            clubId: club.club_id,
            normalizedEmail,
            replayMembershipId: existing.membership_id,
          });
        }
        return {
          memberToken: null,
          clubId: club.club_id,
          membershipId: existing.membership_id,
          proof: await summarizeProofForMembership(client, existing.membership_id, existing.proof_kind, input.actorMemberId),
          club: {
            name: club.name,
            summary: club.summary,
            ownerName: club.owner_name,
            admissionPolicy: club.admission_policy,
            priceUsd: club.membership_price_currency === 'USD' && club.membership_price_amount !== null
              ? Number(club.membership_price_amount)
              : null,
          },
        };
      }

      await assertPendingApplicationCap(client, input.actorMemberId);

      let invitation: InvitationRow | null = null;
      if (input.invitationCode) {
        invitation = await validateInvitationForJoin(client, {
          invitationCode: input.invitationCode,
          clubId: club.club_id,
          normalizedEmail,
        });
      }

      const membershipId = await insertApplyingMembership(client, {
        clubId: club.club_id,
        memberId: input.actorMemberId,
        sponsorMemberId: invitation?.sponsor_member_id ?? null,
        applicationEmail: email,
        submissionPath: invitation ? 'invitation' : 'cross_apply',
        proofKind: invitation ? 'invitation' : 'pow',
        invitationId: invitation?.invitation_id ?? null,
      });

      if (invitation) {
        await client.query(
          `update invitations
           set used_at = now(), used_membership_id = $2
           where id = $1`,
          [invitation.invitation_id, membershipId],
        );
      }

      return {
        memberToken: null,
        clubId: club.club_id,
        membershipId,
        proof: invitation
          ? { kind: 'none' }
          : await summarizeProofForMembership(client, membershipId, 'pow', input.actorMemberId),
        club: {
          name: club.name,
          summary: club.summary,
          ownerName: club.owner_name,
          admissionPolicy: club.admission_policy,
          priceUsd: club.membership_price_currency === 'USD' && club.membership_price_amount !== null
            ? Number(club.membership_price_amount)
            : null,
        },
      };
    }

    if (!input.email) {
      throw new AppError(422, 'email_required_for_first_join', 'Anonymous joins require an email address');
    }
    const normalizedEmail = normalizeEmail(input.email);

    let invitation: InvitationRow | null = null;
    if (input.invitationCode) {
      const parsed = parseInvitationCode(input.invitationCode);
      if (!parsed) {
        throw new AppError(400, 'invalid_invitation_code', 'Invitation code is invalid');
      }
      await materializeExpiredInvitation(client, parsed.tokenId);
      invitation = await readInvitationForValidation(client, parsed.tokenId);
      if (!invitation) {
        throw new AppError(400, 'invalid_invitation_code', 'Invitation code is invalid');
      }
    }

    await client.query(`select pg_advisory_xact_lock(hashtext('application_join:' || $1 || ':' || $2))`, [club.club_id, normalizedEmail]);

    if (input.invitationCode) {
      invitation = await validateInvitationForJoin(client, {
        invitationCode: input.invitationCode,
        clubId: club.club_id,
        normalizedEmail,
      });
    }

    const memberId = await createAnonymousMember(client, {
      email: input.email,
      nameHint: invitation?.candidate_name ?? null,
    });
    const memberToken = await issueBearerToken(client, memberId, 'clubs.join', {
      flow: 'clubs.join',
      clubId: club.club_id,
    });

    const membershipId = await insertApplyingMembership(client, {
      clubId: club.club_id,
      memberId,
      sponsorMemberId: invitation?.sponsor_member_id ?? null,
      applicationEmail: input.email,
      submissionPath: invitation ? 'invitation' : 'cold',
      proofKind: invitation ? 'invitation' : 'pow',
      invitationId: invitation?.invitation_id ?? null,
    });

    if (invitation) {
      await client.query(
        `update invitations
         set used_at = now(), used_membership_id = $2
         where id = $1`,
        [invitation.invitation_id, membershipId],
      );
    }

    return {
      memberToken,
      clubId: club.club_id,
      membershipId,
      proof: invitation
        ? { kind: 'none' }
        : await summarizeProofForMembership(client, membershipId, 'pow', memberId),
      club: {
        name: club.name,
        summary: club.summary,
        ownerName: club.owner_name,
        admissionPolicy: club.admission_policy,
        priceUsd: club.membership_price_currency === 'USD' && club.membership_price_amount !== null
          ? Number(club.membership_price_amount)
          : null,
      },
    };
  });
}

export async function submitClubApplication(pool: Pool, input: SubmitClubApplicationInput): Promise<SubmitClubApplicationResult> {
  type PhaseOne = {
    membershipId: string;
    clubId: string;
    clubName: string;
    clubSummary: string | null;
    admissionPolicy: string | null;
    applicationEmail: string;
    proofKind: 'pow' | 'invitation' | 'none' | null;
    challengeId: string | null;
    challengeDifficulty: number | null;
    challengeExpiresAt: string | null;
    challengeAttempts: number;
  };

  type PhaseOneResult = PhaseOne | Extract<SubmitClubApplicationResult, { status: 'attempts_exhausted' }>;

  const phaseOne: PhaseOneResult = await withTransaction(pool, async (client) => {
    const membership = await client.query<{
      membership_id: string;
      club_id: string;
      club_name: string;
      club_summary: string | null;
      admission_policy: string | null;
      application_email: string | null;
      status: MembershipState;
      proof_kind: 'pow' | 'invitation' | 'none' | null;
    }>(
      `select cm.id as membership_id,
              cm.club_id,
              c.name as club_name,
              c.summary as club_summary,
              c.admission_policy,
              cm.application_email,
              cm.status,
              cm.proof_kind
       from current_club_memberships cm
       join clubs c on c.id = cm.club_id
       where cm.id = $1
         and cm.member_id = $2
       limit 1`,
      [input.membershipId, input.actorMemberId],
    );
    const row = membership.rows[0];
    if (!row) {
      throw new AppError(404, 'not_found', 'Application not found');
    }
    if (row.status !== 'applying') {
      throw new AppError(409, 'invalid_state', 'Only applying memberships can be submitted');
    }
    if (!row.application_email) {
      throw new AppError(500, 'application_email_missing', 'Applying memberships must carry an application email');
    }

    if (row.proof_kind !== 'pow') {
      return {
        membershipId: row.membership_id,
        clubId: row.club_id,
        clubName: row.club_name,
        clubSummary: row.club_summary,
        admissionPolicy: row.admission_policy,
        applicationEmail: row.application_email,
        proofKind: row.proof_kind,
        challengeId: null,
        challengeDifficulty: null,
        challengeExpiresAt: null,
        challengeAttempts: 0,
      } satisfies PhaseOne;
    }

    if (!input.nonce) {
      throw new AppError(400, 'missing_nonce', 'A nonce is required for proof-of-work applications');
    }

    const challenge = await client.query<PowChallengeRow>(
      `select
          id as challenge_id,
          membership_id,
          difficulty,
          expires_at::text as expires_at,
          solved_at::text as solved_at,
          attempts,
          created_at::text as created_at
       from application_pow_challenges
       where membership_id = $1
         and solved_at is null
       for update`,
      [row.membership_id],
    );
    const challengeRow = challenge.rows[0];
    if (!challengeRow || Date.parse(challengeRow.expires_at) <= Date.now()) {
      if (challengeRow) {
        await client.query(`delete from application_pow_challenges where id = $1`, [challengeRow.challenge_id]);
      }
      throw new AppError(410, 'challenge_expired', 'The active proof-of-work challenge has expired');
    }
    if (!validateApplicationPow(challengeRow.challenge_id, input.nonce, challengeRow.difficulty)) {
      throw new AppError(400, 'invalid_proof', 'The supplied proof does not satisfy the challenge difficulty');
    }
    if (challengeRow.attempts >= MAX_APPLICATION_ATTEMPTS) {
      await client.query(`update application_pow_challenges set solved_at = now() where id = $1`, [challengeRow.challenge_id]);
      return {
        status: 'attempts_exhausted',
        message: 'You have used all attempts. Re-call clubs.join authenticated with your bearer token to request a new challenge.',
      };
    }
    return {
      membershipId: row.membership_id,
      clubId: row.club_id,
      clubName: row.club_name,
      clubSummary: row.club_summary,
      admissionPolicy: row.admission_policy,
      applicationEmail: row.application_email,
      proofKind: row.proof_kind,
      challengeId: challengeRow.challenge_id,
      challengeDifficulty: challengeRow.difficulty,
      challengeExpiresAt: challengeRow.expires_at,
      challengeAttempts: challengeRow.attempts,
    } satisfies PhaseOne;
  });

  if ('status' in phaseOne) {
    return phaseOne;
  }

  const gate = await runApplicationGate(
    {
      name: input.name,
      email: phaseOne.applicationEmail,
      socials: input.socials,
      application: input.application,
    },
    {
      name: phaseOne.clubName,
      summary: phaseOne.clubSummary,
      admissionPolicy: phaseOne.admissionPolicy ?? '',
    },
  );

  if (gate.status === 'unavailable') {
    throw new AppError(503, 'gate_unavailable', 'Application gate is temporarily unavailable. Please try again later.');
  }
  if (gate.status === 'needs_revision') {
    return withTransaction(pool, async (client) => {
      await client.query(
        `update application_pow_challenges
         set attempts = attempts + 1
         where id = $1`,
        [phaseOne.challengeId],
      );
      const nextAttemptResult = await client.query<{ attempts: number }>(
        `select attempts
         from application_pow_challenges
         where id = $1`,
        [phaseOne.challengeId],
      );
      const attempts = Number(nextAttemptResult.rows[0]?.attempts ?? 0);
      const attemptsRemaining = Math.max(0, MAX_APPLICATION_ATTEMPTS - attempts);
      if (attemptsRemaining <= 0) {
        await client.query(
          `update application_pow_challenges
           set solved_at = now()
           where id = $1`,
          [phaseOne.challengeId],
        );
        return {
          status: 'attempts_exhausted',
          message: 'You have used all attempts. Re-call clubs.join authenticated with your bearer token to request a new challenge.',
        } as const;
      }

      return {
        status: 'needs_revision',
        feedback: gate.feedback,
        attemptsRemaining,
      } as const;
    });
  }

  const generatedProfileDraft = await generateClubApplicationProfile({
    club: {
      name: phaseOne.clubName,
      summary: phaseOne.clubSummary,
      admissionPolicy: phaseOne.admissionPolicy,
    },
    applicantName: input.name,
    application: input.application,
    socials: input.socials,
  });

  await withTransaction(pool, async (client) => {
    await client.query(
      `update club_memberships
       set generated_profile_draft = $2::jsonb
       where id = $1
         and member_id = $3`,
      [input.membershipId, JSON.stringify(generatedProfileDraft), input.actorMemberId],
    );
  });

  return withTransaction(pool, async (client) => {
    const membership = await client.query<{
      status: MembershipState;
      state_version_no: number;
      state_version_id: string;
      proof_kind: 'pow' | 'invitation' | 'none' | null;
    }>(
      `select status, state_version_no, state_version_id, proof_kind
       from current_club_memberships
       where id = $1
         and member_id = $2
       limit 1`,
      [input.membershipId, input.actorMemberId],
    );
    const membershipRow = membership.rows[0];
    if (!membershipRow) {
      throw new AppError(404, 'not_found', 'Application not found');
    }
    if (membershipRow.status !== 'applying') {
      throw new AppError(409, 'invalid_state', 'Only applying memberships can be submitted');
    }

    let nextAttemptNo = 1;
    if (membershipRow.proof_kind === 'pow') {
      if (!input.nonce) {
        throw new AppError(400, 'missing_nonce', 'A nonce is required for proof-of-work applications');
      }
      const challenge = await client.query<PowChallengeRow>(
        `select
            id as challenge_id,
            membership_id,
            difficulty,
            expires_at::text as expires_at,
            solved_at::text as solved_at,
            attempts,
            created_at::text as created_at
         from application_pow_challenges
         where membership_id = $1
           and solved_at is null
         for update`,
        [input.membershipId],
      );
      const challengeRow = challenge.rows[0];
      if (!challengeRow || Date.parse(challengeRow.expires_at) <= Date.now()) {
        if (challengeRow) {
          await client.query(`delete from application_pow_challenges where id = $1`, [challengeRow.challenge_id]);
        }
        throw new AppError(410, 'challenge_expired', 'The active proof-of-work challenge has expired');
      }
      if (!validateApplicationPow(challengeRow.challenge_id, input.nonce, challengeRow.difficulty)) {
        throw new AppError(400, 'invalid_proof', 'The supplied proof does not satisfy the challenge difficulty');
      }
      nextAttemptNo = challengeRow.attempts + 1;
      if (nextAttemptNo > MAX_APPLICATION_ATTEMPTS) {
        await client.query(`update application_pow_challenges set solved_at = now() where id = $1`, [challengeRow.challenge_id]);
        return {
          status: 'attempts_exhausted',
          message: 'You have used all attempts. Re-call clubs.join authenticated with your bearer token to request a new challenge.',
        } satisfies SubmitClubApplicationResult;
      }

      await client.query(
        `update application_pow_challenges
         set attempts = $2,
             solved_at = now()
         where id = $1`,
        [challengeRow.challenge_id, nextAttemptNo],
      );
    }

    await client.query(
      `update club_memberships
       set application_name = $2,
           application_socials = $3,
           application_text = $4,
           application_submitted_at = now()
       where id = $1`,
      [input.membershipId, input.name, input.socials, input.application],
    );
    await client.query(
      `insert into club_membership_state_versions (
          membership_id,
          status,
          reason,
          version_no,
          supersedes_state_version_id,
          created_by_member_id
       )
       values ($1, 'submitted', null, $2, $3, $4)`,
      [input.membershipId, Number(membershipRow.state_version_no) + 1, membershipRow.state_version_id, input.actorMemberId],
    );

    const submitted = await client.query<{ application_submitted_at: string }>(
      `select application_submitted_at::text as application_submitted_at
       from club_memberships
       where id = $1`,
      [input.membershipId],
    );

    return {
      status: 'submitted',
      membershipId: input.membershipId,
      applicationSubmittedAt: submitted.rows[0]?.application_submitted_at ?? new Date().toISOString(),
    } satisfies SubmitClubApplicationResult;
  });
}

export async function getClubApplication(pool: Pool, actorMemberId: string, membershipId: string): Promise<ApplicationSummary | null> {
  const row = await readMembershipApplicationRow(pool, membershipId);
  if (!row || row.member_id !== actorMemberId) {
    return null;
  }
  return mapApplicationSummary(row);
}

export async function listClubApplications(pool: Pool, input: {
  actorMemberId: string;
  clubId?: string;
  statuses?: MembershipState[];
}): Promise<ApplicationSummary[]> {
  const result = await pool.query<{ membership_id: string }>(
    `select id as membership_id
     from current_club_memberships
     where member_id = $1
       and ($2::short_id is null or club_id = $2)
       and ($3::membership_state[] is null or status = any($3))
     order by coalesce(application_submitted_at, applied_at, state_created_at) desc nulls last, id desc`,
    [input.actorMemberId, input.clubId ?? null, input.statuses ?? null],
  );
  const summaries: ApplicationSummary[] = [];
  for (const row of result.rows) {
    const application = await getClubApplication(pool, input.actorMemberId, row.membership_id);
    if (application) summaries.push(application);
  }
  return summaries;
}

export async function issueInvitation(pool: Pool, input: {
  actorMemberId: string;
  clubId: string;
  candidateName: string;
  candidateEmail: string;
  reason: string;
}): Promise<{ invitation: InvitationSummary; invitationCode: string } | null> {
  return withTransaction(pool, async (client) => {
    const membership = await client.query<{ role: 'clubadmin' | 'member'; ok: boolean }>(
      `select exists(
         select 1
         from accessible_club_memberships
         where club_id = $1
           and member_id = $2
       ) as ok`,
      [input.clubId, input.actorMemberId],
    );
    if (!membership.rows[0]?.ok) {
      return null;
    }

    const normalizedEmail = normalizeEmail(input.candidateEmail);
    const sponsor = await client.query<{ public_name: string }>(
      `select public_name from members where id = $1`,
      [input.actorMemberId],
    );
    await client.query(
      `select pg_advisory_xact_lock(hashtext('invitation_issue:' || $1 || ':' || $2))`,
      [input.clubId, input.actorMemberId],
    );

    await materializeInvitationExpiryForTuple(client, input.clubId, input.actorMemberId, normalizedEmail);

    const quota = await client.query<{ count: string }>(
      `select count(*)::text as count
       from invitations
       where club_id = $1
         and sponsor_member_id = $2
         and created_at >= now() - interval '30 days'
         and revoked_at is null
         and used_at is null
         and expired_at is null`,
      [input.clubId, input.actorMemberId],
    );
    if (Number(quota.rows[0]?.count ?? 0) >= OPEN_INVITATION_CAP) {
      throw new AppError(429, 'invitation_quota_exceeded', `Maximum ${OPEN_INVITATION_CAP} open invitations per sponsor and club`);
    }

    await client.query(
      `update invitations
       set revoked_at = coalesce(revoked_at, now())
       where club_id = $1
         and sponsor_member_id = $2
         and candidate_email_normalized = $3
         and revoked_at is null
         and used_at is null
         and expired_at is null`,
      [input.clubId, input.actorMemberId, normalizedEmail],
    );

    const code = buildInvitationCode();
    const result = await client.query<InvitationRow>(
      `insert into invitations (
          id,
          club_id,
          sponsor_member_id,
          candidate_name,
          candidate_email,
          reason,
          code_hash,
          expires_at
       )
       values ($1, $2, $3, $4, $5, $6, $7, now() + interval '30 days')
       returning
         id as invitation_id,
         club_id,
         sponsor_member_id,
         $8::text as sponsor_public_name,
         candidate_name,
         candidate_email,
         candidate_email_normalized,
         reason,
         code_hash,
         expires_at::text as expires_at,
         expired_at::text as expired_at,
         used_at::text as used_at,
         used_membership_id,
         revoked_at::text as revoked_at,
         created_at::text as created_at`,
      [
        code.tokenId,
        input.clubId,
        input.actorMemberId,
        input.candidateName,
        input.candidateEmail,
        input.reason,
        code.tokenHash,
        sponsor.rows[0]?.public_name ?? 'Unknown sponsor',
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new AppError(500, 'invitation_issue_failed', 'Failed to create invitation');
    }
    return {
      invitation: mapInvitationSummary(row),
      invitationCode: code.invitationCode,
    };
  });
}

export async function listIssuedInvitations(pool: Pool, input: {
  actorMemberId: string;
  clubId?: string;
  status?: InvitationStatus;
}): Promise<InvitationSummary[]> {
  const result = await pool.query<InvitationRow>(
    `select
        i.id as invitation_id,
        i.club_id,
        i.sponsor_member_id,
        sponsor.public_name as sponsor_public_name,
        i.candidate_name,
        i.candidate_email,
        i.candidate_email_normalized,
        i.reason,
        i.code_hash,
        i.expires_at::text as expires_at,
        i.expired_at::text as expired_at,
        i.used_at::text as used_at,
        i.used_membership_id,
        i.revoked_at::text as revoked_at,
        i.created_at::text as created_at
     from invitations i
     join members sponsor on sponsor.id = i.sponsor_member_id
     where i.sponsor_member_id = $1
       and ($2::short_id is null or i.club_id = $2)
     order by i.created_at desc, i.id desc`,
    [input.actorMemberId, input.clubId ?? null],
  );
  return result.rows
    .map((row) => mapInvitationSummary(row))
    .filter((row) => input.status === undefined || row.status === input.status);
}

export async function revokeInvitation(pool: Pool, input: {
  actorMemberId: string;
  invitationId: string;
  adminClubIds?: string[];
}): Promise<InvitationSummary | null> {
  return withTransaction(pool, async (client) => {
    const invitation = await readInvitationForValidation(client, input.invitationId);
    if (!invitation) {
      return null;
    }
    const allowed = invitation.sponsor_member_id === input.actorMemberId
      || (input.adminClubIds ?? []).includes(invitation.club_id);
    if (!allowed) {
      throw new AppError(403, 'forbidden', 'You may only revoke your own invitations or invitations in clubs you administer');
    }
    if (invitation.used_at) {
      throw new AppError(409, 'invalid_state', 'Used invitations cannot be revoked');
    }
    if (invitation.revoked_at || invitation.expired_at || Date.parse(invitation.expires_at) <= Date.now()) {
      return mapInvitationSummary(invitation);
    }
    const updated = await client.query<InvitationRow>(
      `update invitations
       set revoked_at = now()
       where id = $1
       returning
         id as invitation_id,
         club_id,
         sponsor_member_id,
         $2::text as sponsor_public_name,
         candidate_name,
         candidate_email,
         candidate_email_normalized,
         reason,
         code_hash,
         expires_at::text as expires_at,
         expired_at::text as expired_at,
         used_at::text as used_at,
         used_membership_id,
         revoked_at::text as revoked_at,
         created_at::text as created_at`,
      [input.invitationId, invitation.sponsor_public_name],
    );
    return updated.rows[0] ? mapInvitationSummary(updated.rows[0]) : mapInvitationSummary(invitation);
  });
}

export async function startMembershipCheckout(pool: Pool, input: {
  actorMemberId: string;
  clubId: string;
}): Promise<{ checkoutUrl: string } | null> {
  const membership = await pool.query<{ membership_id: string }>(
    `select id as membership_id
     from current_club_memberships
     where member_id = $1
       and club_id = $2
       and status = 'payment_pending'
     limit 1`,
    [input.actorMemberId, input.clubId],
  );
  const membershipId = membership.rows[0]?.membership_id;
  if (!membershipId) {
    return null;
  }

  const template = process.env.BILLING_CHECKOUT_URL_TEMPLATE;
  if (!template) {
    throw new AppError(501, 'not_available', 'Billing checkout is not configured for this deployment');
  }

  return {
    checkoutUrl: template
      .replaceAll('{membershipId}', membershipId)
      .replaceAll('{clubId}', input.clubId),
  };
}
