import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { AppError } from './errors.ts';
import type { DbClient } from './db.ts';
import { EMAIL_ALREADY_REGISTERED_MESSAGE, isMembersEmailUniqueViolation, normalizeEmail } from './email.ts';
import { createBearerTokenInDb } from './identity/tokens.ts';
import { normalizeInvitationCode } from './token.ts';
import {
  computeInviteCodeMac,
  getColdApplicationDifficulty,
  getInvitedRegistrationDifficulty,
  issuePowChallenge,
  validatePowSolution,
  verifyInviteCodeMac,
  verifyPowChallenge,
} from './pow-challenge.ts';
import {
  mapApplicationGateVerdict,
  type StoredApplicationGateResult,
} from './application-gate.ts';
import { checkLlmGate, type ApplicationArtifact, type ApplicationGateVerdict } from './gate.ts';
import { logMalformedGateVerdict } from './gate-results.ts';
import { CLAWCLUB_OPENAI_MODEL } from './ai.ts';
import {
  generateClubApplicationProfile,
  normalizeClubProfileFields,
} from './identity/profiles.ts';
import {
  createMembershipInTransaction,
  reactivateCancelledMembershipInTransaction,
  resolveNotificationClubRef,
  transitionMembershipState,
} from './identity/memberships.ts';
import type { ClubProfileFields, MembershipAdminSummary, TransitionMembershipInput } from './repository.ts';
import { matchesPgConstraint, withTransaction } from './db.ts';
import { lookupIdempotency, withIdempotency } from './idempotency.ts';
import { encodeCursor } from './schemas/fields.ts';
import { getConfig } from './config/index.ts';
import {
  enforceDurableGlobalEventQuota,
  finalizeLlmOutputBudget,
  getLlmGateMaxOutputTokens,
  QUOTA_ACTIONS,
  reserveLlmOutputBudget,
} from './quotas.ts';
import {
  autoAcknowledgeNotifications,
  deliverCoreNotifications,
  type NotificationRefInput,
} from './notification-substrate.ts';

const REGISTER_POW_SCOPE = '__account_register__';
const REGISTER_TOKEN_GUIDANCE = 'This is your member token. Save it somewhere safe. There is no self-service recovery flow.';
const DEFAULT_PAGE_LIMIT = 20;

type ClubRow = {
  club_id: string;
  slug: string;
  name: string;
  summary: string | null;
  admission_policy: string | null;
  owner_name: string;
};

type InvitationRedeemRow = {
  invitation_id: string;
  club_id: string;
  club_slug: string;
  club_name: string;
  club_summary: string | null;
  admission_policy: string | null;
  sponsor_member_id: string | null;
  sponsor_public_name: string | null;
  candidate_name: string;
  candidate_email: string;
  candidate_email_normalized: string;
  reason: string;
  delivery_kind: 'notification' | 'code';
  code: string;
  expires_at: string;
  expired_at: string | null;
  used_at: string | null;
  used_membership_id: string | null;
  revoked_at: string | null;
};

type InvitationRegistrationRow = {
  invitation_id: string;
  candidate_email_normalized: string;
  delivery_kind: 'notification' | 'code';
  expires_at: string;
  expires_at_in_past: boolean;
  expired_at: string | null;
  used_at: string | null;
  revoked_at: string | null;
  support_withdrawn_at: string | null;
};

type ApplicationRow = {
  application_id: string;
  club_id: string;
  club_slug: string;
  club_name: string;
  club_summary: string | null;
  admission_policy: string | null;
  applicant_member_id: string;
  sponsor_member_id: string | null;
  sponsor_public_name: string | null;
  submission_path: 'cold' | 'invitation';
  invitation_id: string | null;
  invite_reason_snapshot: string | null;
  invite_mode: 'internal' | 'external' | null;
  invitation_support_withdrawn_at: string | null;
  phase: 'revision_required' | 'awaiting_review' | 'active' | 'declined' | 'banned' | 'removed' | 'withdrawn';
  draft_name: string;
  draft_socials: string;
  draft_application: string;
  generated_profile_draft: Record<string, unknown> | null;
  gate_verdict: 'passed' | 'needs_revision' | 'not_run' | 'unavailable' | null;
  gate_feedback: { message?: string; missingItems?: string[] } | null;
  gate_last_run_at: string | null;
  gate_input_hash: string | null;
  admin_note: string | null;
  admin_workflow_stage: string | null;
  created_at: string;
  updated_at: string;
  submitted_at: string;
  decided_at: string | null;
  decided_by_member_id: string | null;
  activated_membership_id: string | null;
  migrated_from_membership_id: string | null;
  migration_reason: string | null;
  membership_joined_at: string | null;
  membership_role: 'clubadmin' | 'member' | null;
};

const INVALID_INVITATION_CODE_MESSAGE = 'Invitation code is invalid or no longer usable.';

function canonicalizeInvitationCodeForRegistrationMac(value: string): string {
  return value.trim().toUpperCase();
}

function readOptionalInvitationCode(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function throwInvalidRegistrationChallenge(): never {
  throw new AppError('invalid_challenge', 'The registration challenge is invalid or expired.');
}

function readVerifiedInviteBinding(payload: {
  inviteCodeMac?: string;
  email?: string;
}): { inviteCodeMac: string; email: string } | null {
  if (payload.inviteCodeMac === undefined && payload.email === undefined) {
    return null;
  }
  if (!payload.inviteCodeMac || !payload.email) {
    throwInvalidRegistrationChallenge();
  }
  return { inviteCodeMac: payload.inviteCodeMac, email: payload.email };
}

function assertInvitationSponsorAvailable(
  invitation: InvitationRedeemRow,
): asserts invitation is InvitationRedeemRow & { sponsor_member_id: string; sponsor_public_name: string } {
  if (!invitation.sponsor_member_id || !invitation.sponsor_public_name) {
    // Orphaned invitation rows are intentionally non-redeemable.
    throw new AppError('invalid_invitation_code', INVALID_INVITATION_CODE_MESSAGE);
  }
}

type ExistingMembershipRow = {
  membership_id: string;
  club_id: string;
  member_id: string;
  role: 'clubadmin' | 'member';
  status: 'active' | 'cancelled';
  joined_at: string | null;
};

type InternalInvitationBindingRow = {
  invitation_id: string;
  club_id: string;
  sponsor_member_id: string;
  sponsor_public_name: string;
  candidate_member_id: string;
  candidate_name: string;
  candidate_email: string;
  reason: string;
  expires_at: string;
  created_at: string;
};

const APPLICATION_ROW_SELECT = `select
    ca.id as application_id,
    ca.club_id,
    c.slug as club_slug,
    c.name as club_name,
    c.summary as club_summary,
    c.admission_policy,
    ca.applicant_member_id,
    ca.sponsor_member_id,
    coalesce(ca.sponsor_name_snapshot, sponsor.public_name) as sponsor_public_name,
    ca.submission_path,
    ca.invitation_id,
    ca.invite_reason_snapshot,
    ca.invite_mode,
    ir.support_withdrawn_at::text as invitation_support_withdrawn_at,
    ca.phase,
    ca.draft_name,
    ca.draft_socials,
    ca.draft_application,
    ca.generated_profile_draft,
    ca.gate_verdict,
    ca.gate_feedback,
    ca.gate_last_run_at::text as gate_last_run_at,
    ca.gate_input_hash,
    ca.admin_note,
    ca.admin_workflow_stage,
    ca.created_at::text as created_at,
    ca.updated_at::text as updated_at,
    ca.submitted_at::text as submitted_at,
    ca.decided_at::text as decided_at,
    ca.decided_by_member_id,
    ca.activated_membership_id,
    ca.migrated_from_membership_id,
    ca.migration_reason,
    cm.joined_at::text as membership_joined_at,
    cm.role::text as membership_role
 from club_applications ca
 join clubs c on c.id = ca.club_id
 left join members sponsor on sponsor.id = ca.sponsor_member_id
 left join invite_requests ir on ir.id = ca.invitation_id
 left join current_club_memberships cm on cm.id = ca.activated_membership_id`;

async function readClubBySlug(client: DbClient, clubSlug: string): Promise<ClubRow | null> {
  const result = await client.query<ClubRow>(
    `select
        c.id as club_id,
        c.slug,
        c.name,
        c.summary,
        c.admission_policy,
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

async function readInvitationForRedeem(
  client: DbClient,
  code: string,
  options: { forUpdate?: boolean } = {},
): Promise<InvitationRedeemRow | null> {
  const normalizedCode = normalizeInvitationCode(code);
  if (!normalizedCode) {
    throw new AppError('invalid_invitation_code', INVALID_INVITATION_CODE_MESSAGE);
  }

  const lockClause = options.forUpdate ? 'for update of i' : '';
  const result = await client.query<InvitationRedeemRow>(
    `select
        ir.id as invitation_id,
        ir.club_id,
        c.slug as club_slug,
        c.name as club_name,
        c.summary as club_summary,
        c.admission_policy,
        ir.sponsor_member_id,
        sponsor.public_name as sponsor_public_name,
        ir.candidate_name,
        ir.candidate_email,
        ir.candidate_email_normalized,
        ir.reason,
        ir.delivery_kind::text as delivery_kind,
        ic.code,
        ir.expires_at::text as expires_at,
        ir.expired_at::text as expired_at,
        ir.used_at::text as used_at,
        ir.used_membership_id,
        ir.revoked_at::text as revoked_at
     from invite_codes ic
     join invite_requests ir on ir.id = ic.invite_request_id
     join clubs c on c.id = ir.club_id
     -- Sponsor-deleted invitation rows are preserved for audit/history. Redeem
     -- still reads them so the caller gets a stable invalid_invitation_code error.
     left join members sponsor on sponsor.id = ir.sponsor_member_id
     where ic.code = $1
     limit 1
     ${lockClause.replace('for update of i', 'for update of ir, ic')}`,
    [normalizedCode],
  );
  const row = result.rows[0] ?? null;
  if (row && row.delivery_kind !== 'code') {
    throw new AppError('invalid_invitation_code', INVALID_INVITATION_CODE_MESSAGE);
  }
  return row;
}

async function loadInvitationForRegistration(
  client: DbClient,
  normalizedCode: string,
): Promise<InvitationRegistrationRow | null> {
  const result = await client.query<InvitationRegistrationRow>(
    `select
        ir.id as invitation_id,
        ir.candidate_email_normalized,
        ir.delivery_kind::text as delivery_kind,
        ir.expires_at::text as expires_at,
        (ir.expires_at <= now()) as expires_at_in_past,
        ir.expired_at::text as expired_at,
        ir.used_at::text as used_at,
        ir.revoked_at::text as revoked_at,
        ir.support_withdrawn_at::text as support_withdrawn_at
     from invite_codes ic
     join invite_requests ir on ir.id = ic.invite_request_id
     where ic.code = $1
     limit 1`,
    [normalizedCode],
  );
  return result.rows[0] ?? null;
}

async function readMemberEmail(client: DbClient, memberId: string): Promise<string | null> {
  const result = await client.query<{ email: string | null }>(
    `select email from members where id = $1 limit 1`,
    [memberId],
  );
  return result.rows[0]?.email ?? null;
}

async function readMemberPublicName(client: DbClient, memberId: string): Promise<string | null> {
  const result = await client.query<{ public_name: string | null }>(
    `select public_name from members where id = $1 limit 1`,
    [memberId],
  );
  return result.rows[0]?.public_name ?? null;
}

async function countInFlightApplications(client: DbClient, memberId: string): Promise<number> {
  const result = await client.query<{ count: string }>(
    `select count(*)::text as count
     from club_applications
     where applicant_member_id = $1
       and phase in ('revision_required', 'awaiting_review')`,
    [memberId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function assertApplicationCapacity(client: DbClient, memberId: string): Promise<void> {
  const maxInFlightApplications = getConfig().policy.applications.maxInFlightPerMember;
  const inFlightCount = await countInFlightApplications(client, memberId);
  if (inFlightCount >= maxInFlightApplications) {
    throw new AppError('application_limit_reached', `You already have ${maxInFlightApplications} live applications in flight.`);
  }
}

async function assertNoClubBlock(client: DbClient, clubId: string, memberId: string): Promise<void> {
  const result = await client.query<{ block_kind: 'banned' | 'removed' }>(
    `select block_kind
     from club_applicant_blocks
     where club_id = $1
       and member_id = $2
     order by created_at desc
     limit 1`,
    [clubId, memberId],
  );
  const block = result.rows[0];
  if (!block) return;
  throw new AppError('application_blocked', `You cannot apply to this club after being ${block.block_kind}.`);
}

async function readExistingMembership(client: DbClient, clubId: string, memberId: string): Promise<ExistingMembershipRow | null> {
  const membership = await client.query<ExistingMembershipRow>(
    `select id as membership_id
            , club_id
            , member_id
            , role::text
            , status::text
            , joined_at::text
     from current_club_memberships
     where club_id = $1
       and member_id = $2
       and status in ('active', 'cancelled')
     limit 1`,
    [clubId, memberId],
  );
  return membership.rows[0] ?? null;
}

function buildMembershipConflictDetails(membership: ExistingMembershipRow): Record<string, unknown> {
  return {
    membership: {
      membershipId: membership.membership_id,
      clubId: membership.club_id,
      memberId: membership.member_id,
      role: membership.role,
      status: membership.status,
      joinedAt: membership.joined_at,
    },
  };
}

function assertMembershipAllowsApplication(membership: ExistingMembershipRow | null): void {
  if (!membership || membership.status === 'cancelled') {
    return;
  }
  throw new AppError('member_already_active', 'This member already has an active membership in the club.', {
    details: buildMembershipConflictDetails(membership),
  });
}

function mapCandidateInvitationChoice(row: InternalInvitationBindingRow): Record<string, unknown> {
  return {
    invitationId: row.invitation_id,
    sponsor: {
      memberId: row.sponsor_member_id,
      publicName: row.sponsor_public_name,
    },
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

async function listLiveInternalInvitationsForApplicant(
  client: DbClient,
  input: {
    clubId: string;
    applicantMemberId: string;
  },
): Promise<InternalInvitationBindingRow[]> {
  const result = await client.query<InternalInvitationBindingRow>(
    `select
        ir.id as invitation_id,
        ir.club_id,
        ir.sponsor_member_id,
        sponsor.public_name as sponsor_public_name,
        ir.candidate_member_id,
        ir.candidate_name,
        ir.candidate_email,
        ir.reason,
        ir.expires_at::text as expires_at,
        ir.created_at::text as created_at
     from invite_requests ir
     join members sponsor on sponsor.id = ir.sponsor_member_id
     where ir.club_id = $1
       and ir.candidate_member_id = $2
       and ir.delivery_kind = 'notification'
       and ir.revoked_at is null
       and ir.used_at is null
       and ir.expired_at is null
       and ir.expires_at > now()
     order by ir.created_at desc, ir.id desc`,
    [input.clubId, input.applicantMemberId],
  );
  return result.rows;
}

async function readLiveInternalInvitationById(
  client: DbClient,
  input: {
    invitationId: string;
    clubId: string;
    applicantMemberId: string;
  },
): Promise<InternalInvitationBindingRow | null> {
  const result = await client.query<InternalInvitationBindingRow>(
    `select
        ir.id as invitation_id,
        ir.club_id,
        ir.sponsor_member_id,
        sponsor.public_name as sponsor_public_name,
        ir.candidate_member_id,
        ir.candidate_name,
        ir.candidate_email,
        ir.reason,
        ir.expires_at::text as expires_at,
        ir.created_at::text as created_at
     from invite_requests ir
     join members sponsor on sponsor.id = ir.sponsor_member_id
     where ir.id = $1
       and ir.club_id = $2
       and ir.candidate_member_id = $3
       and ir.delivery_kind = 'notification'
       and ir.revoked_at is null
       and ir.used_at is null
       and ir.expired_at is null
       and ir.expires_at > now()
     limit 1
     for update of ir`,
    [input.invitationId, input.clubId, input.applicantMemberId],
  );
  return result.rows[0] ?? null;
}

async function resolveApplicationInvitationBinding(
  client: DbClient,
  input: {
    clubId: string;
    applicantMemberId: string;
    invitationId?: string;
  },
): Promise<{
  invitationId?: string;
  sponsorId?: string;
  sponsorNameSnapshot?: string;
  inviteReasonSnapshot?: string;
  inviteMode?: 'internal';
} | null> {
  if (input.invitationId) {
    const invitation = await readLiveInternalInvitationById(client, {
      invitationId: input.invitationId,
      clubId: input.clubId,
      applicantMemberId: input.applicantMemberId,
    });
    if (!invitation) {
      throw new AppError('invitation_not_found', 'Invitation not found.', {
        details: {
          invitationId: input.invitationId,
          clubId: input.clubId,
        },
      });
    }
    return {
      invitationId: invitation.invitation_id,
      sponsorId: invitation.sponsor_member_id,
      sponsorNameSnapshot: invitation.sponsor_public_name,
      inviteReasonSnapshot: invitation.reason,
      inviteMode: 'internal',
    };
  }

  const invitations = await listLiveInternalInvitationsForApplicant(client, {
    clubId: input.clubId,
    applicantMemberId: input.applicantMemberId,
  });
  if (invitations.length === 0) {
    return null;
  }
  if (invitations.length > 1) {
    throw new AppError('invitation_ambiguous', 'Multiple open invitations exist for this club. Choose one invitationId and retry.', {
      details: {
        invitations: invitations.map((row) => mapCandidateInvitationChoice(row)),
      },
    });
  }
  const invitation = await readLiveInternalInvitationById(client, {
    invitationId: invitations[0]!.invitation_id,
    clubId: input.clubId,
    applicantMemberId: input.applicantMemberId,
  });
  if (!invitation) {
    throw new AppError('application_not_mutable', 'Invitation details changed while the application was being prepared. Retry the request.');
  }
  return {
    invitationId: invitation.invitation_id,
    sponsorId: invitation.sponsor_member_id,
    sponsorNameSnapshot: invitation.sponsor_public_name,
    inviteReasonSnapshot: invitation.reason,
    inviteMode: 'internal',
  };
}

function buildRoadmap(phase: ApplicationRow['phase']): Array<Record<string, string>> {
  const roadmap: Array<Record<string, string>> = [];
  if (phase === 'revision_required') {
    roadmap.push(
      { phase: 'revision_required', description: 'Your draft is saved, but it is not yet in the admin review queue. Revise it to address the missing policy items.' },
      { phase: 'awaiting_review', description: 'After a successful revise, club admins review the submitted application.' },
      { phase: 'active', description: 'If approved, your existing bearer immediately gains access to the club.' },
    );
    return roadmap;
  }
  if (phase === 'awaiting_review') {
    roadmap.push(
      { phase: 'awaiting_review', description: 'This application is already submitted and waiting in the club-admin review queue.' },
      { phase: 'active', description: 'If approved, your existing bearer immediately gains access to the club.' },
    );
    return roadmap;
  }
  if (phase === 'active') {
    roadmap.push({ phase: 'active', description: 'You are admitted to the club and can use your existing bearer there.' });
    return roadmap;
  }
  roadmap.push({ phase, description: 'This application is terminal.' });
  return roadmap;
}

function buildApplicationWorkflow(row: Pick<ApplicationRow, 'phase' | 'submitted_at' | 'gate_verdict'>): Record<string, unknown> {
  const submittedToAdminsAt = row.gate_verdict === 'needs_revision'
    ? null
    : row.submitted_at;

  switch (row.phase) {
    case 'revision_required':
      return {
        awaitingActor: 'applicant',
        currentlySubmittedToAdmins: false,
        submittedToAdminsAt,
        applicantMustActNow: true,
        canApplicantRevise: true,
      };
    case 'awaiting_review':
      return {
        awaitingActor: 'clubadmins',
        currentlySubmittedToAdmins: true,
        submittedToAdminsAt,
        applicantMustActNow: false,
        canApplicantRevise: false,
      };
    default:
      return {
        awaitingActor: 'none',
        currentlySubmittedToAdmins: false,
        submittedToAdminsAt,
        applicantMustActNow: false,
        canApplicantRevise: false,
      };
  }
}

function buildNextDirective(phase: ApplicationRow['phase'], applicationId: string): Record<string, unknown> | null {
  switch (phase) {
    case 'revision_required':
      return {
        action: 'clubs.applications.revise',
        requiredInputs: ['applicationId', 'draft', 'clientKey'],
        reason: 'Your current draft is saved, but it has not been submitted to club admins yet. Revise it before it can enter the admin queue.',
        estimatedEffort: 'immediate',
        applicationId,
      };
    case 'awaiting_review':
      return {
        action: 'updates.list',
        reason: 'This application is already submitted to club admins. Do not reapply or revise it; poll updates for the verdict.',
        estimatedEffort: 'later',
        applicationId,
      };
    case 'active':
      return {
        action: 'updates.list',
        reason: 'You have been admitted. Welcome and first-action guidance arrive through updates.',
        estimatedEffort: 'immediate',
      };
    default:
      return null;
  }
}

function buildMessages(row: ApplicationRow): { summary: string; details: string } {
  switch (row.phase) {
    case 'revision_required':
      return {
        summary: 'Your current draft is saved, but it has NOT been submitted to club admins yet.',
        details: row.gate_feedback?.message
          ? `${row.gate_feedback.message} Revise this saved draft with clubs.applications.revise.`
          : 'You have not applied yet. Revise this saved draft with clubs.applications.revise to submit it.',
      };
    case 'awaiting_review':
      return {
        summary: 'Your application HAS been submitted to club admins and is waiting for review.',
        details: 'No applicant action is available in this phase. Do not call clubs.applications.revise; poll updates.list for the verdict.',
      };
    case 'active':
      return {
        summary: 'You have been admitted to this club.',
        details: 'Use updates.list to read the welcome and suggested first actions for this club.',
      };
    case 'declined':
      return {
        summary: 'This application was declined.',
        details: 'You may reapply later if you still want to join.',
      };
    case 'banned':
      return {
        summary: 'This application was banned.',
        details: 'This member identity can no longer apply to this club.',
      };
    case 'removed':
      return {
        summary: 'This membership was later removed.',
        details: 'The application remains as audit history for the admission that led to the removed membership.',
      };
    case 'withdrawn':
      return {
        summary: 'This application was withdrawn.',
        details: 'You can start a new application later if you still want to join.',
      };
  }
}

async function readApplicationRow(
  client: DbClient,
  applicationId: string,
  options: { clubId?: string } = {},
): Promise<ApplicationRow | null> {
  const result = await client.query<ApplicationRow>(
    `${APPLICATION_ROW_SELECT}
     where ca.id = $1
       and ($2::short_id is null or ca.club_id = $2::short_id)
     limit 1`,
    [applicationId, options.clubId ?? null],
  );
  return result.rows[0] ?? null;
}

async function readApplicationForUpdate(
  client: DbClient,
  applicationId: string,
  options: { clubId?: string } = {},
): Promise<ApplicationRow | null> {
  const result = await client.query<ApplicationRow>(
    `${APPLICATION_ROW_SELECT}
     where ca.id = $1
       and ($2::short_id is null or ca.club_id = $2::short_id)
     limit 1
     for update of ca`,
    [applicationId, options.clubId ?? null],
  );
  return result.rows[0] ?? null;
}

async function getExistingOpenApplicationIfAny(
  client: DbClient,
  input: {
    clubId: string;
    memberId: string;
    forUpdate?: boolean;
  },
): Promise<ApplicationRow | null> {
  const lockClause = input.forUpdate ? 'for update of ca' : '';
  const result = await client.query<ApplicationRow>(
    `${APPLICATION_ROW_SELECT}
     where ca.club_id = $1
       and ca.applicant_member_id = $2
       and ca.phase in ('revision_required', 'awaiting_review')
     order by ca.submitted_at desc, ca.id desc
     limit 1
     ${lockClause}`,
    [input.clubId, input.memberId],
  );
  return result.rows[0] ?? null;
}

function applicationDecisionDetails(row: ApplicationRow): Record<string, unknown> {
  return {
    application: mapAdminApplicationState(row),
  };
}

function throwApplicationAlreadyDecided(row: ApplicationRow): never {
  throw new AppError('application_already_decided', 'This application has already been decided.', {
    details: applicationDecisionDetails(row),
  });
}

async function throwApplicationInFlight(client: DbClient, row: ApplicationRow): Promise<never> {
  throw new AppError('application_in_flight', 'You already have an open application for this club.', {
    details: await buildApplicationPayload(client, row),
  });
}

async function runApplicationPreflight(pool: Pool, input: {
  actorMemberId: string;
  clubId: string;
}): Promise<void> {
  return withTransaction(pool, async (client) => {
    const membership = await readExistingMembership(client, input.clubId, input.actorMemberId);
    assertMembershipAllowsApplication(membership);

    const existingOpen = await getExistingOpenApplicationIfAny(client, {
      clubId: input.clubId,
      memberId: input.actorMemberId,
    });
    if (existingOpen) {
      await throwApplicationInFlight(client, existingOpen);
    }

    await assertApplicationCapacity(client, input.actorMemberId);
    await assertNoClubBlock(client, input.clubId, input.actorMemberId);
  });
}

function mapMemberGate(row: ApplicationRow): Record<string, unknown> {
  return {
    verdict: row.gate_verdict ?? 'not_run',
    feedback: row.gate_feedback
      ? {
          message: row.gate_feedback.message ?? null,
          missingItems: row.gate_feedback.missingItems ?? [],
        }
      : null,
  };
}

function buildMemberInvitationMetadata(row: Pick<ApplicationRow, 'invitation_id' | 'invite_mode'>): Record<string, unknown> | null {
  if (!row.invitation_id || !row.invite_mode) {
    return null;
  }
  return {
    invitationId: row.invitation_id,
    inviteMode: row.invite_mode,
  };
}

function buildAdminInvitationMetadata(
  row: Pick<ApplicationRow, 'invitation_id' | 'invite_mode' | 'invite_reason_snapshot' | 'invitation_support_withdrawn_at'>,
): Record<string, unknown> | null {
  if (!row.invitation_id || !row.invite_mode || !row.invite_reason_snapshot) {
    return null;
  }
  return {
    invitationId: row.invitation_id,
    inviteMode: row.invite_mode,
    inviteReasonSnapshot: row.invite_reason_snapshot,
    sponsorshipStillOpen: row.invitation_support_withdrawn_at === null,
  };
}

function mapApplicationState(row: ApplicationRow, inFlightCount: number): Record<string, unknown> {
  const messages = buildMessages(row);

  const data: Record<string, unknown> = {
    application: {
      applicationId: row.application_id,
      clubId: row.club_id,
      clubSlug: row.club_slug,
      clubName: row.club_name,
      clubSummary: row.club_summary,
      admissionPolicy: row.admission_policy,
      submissionPath: row.submission_path,
      sponsorName: row.sponsor_public_name,
      invitation: buildMemberInvitationMetadata(row),
      phase: row.phase,
      submittedAt: row.submitted_at,
      decidedAt: row.decided_at,
    },
    draft: {
      name: row.draft_name,
      socials: row.draft_socials,
      application: row.draft_application,
    },
    gate: mapMemberGate(row),
    workflow: buildApplicationWorkflow(row),
    next: buildNextDirective(row.phase, row.application_id),
    roadmap: buildRoadmap(row.phase),
    applicationLimits: {
      inFlightCount,
      maxInFlight: getConfig().policy.applications.maxInFlightPerMember,
    },
    messages,
  };

  if (row.phase === 'active' && row.activated_membership_id) {
    data.membership = {
      membershipId: row.activated_membership_id,
      clubId: row.club_id,
      role: row.membership_role ?? 'member',
      joinedAt: row.membership_joined_at,
    };
  }

  return data;
}

async function queueNotification(
  client: DbClient,
  input: {
    clubId: string | null;
    recipientMemberId: string;
    topic: string;
    payload: Record<string, unknown>;
    refs?: NotificationRefInput[];
  },
): Promise<void> {
  await deliverCoreNotifications(client, [{
    clubId: input.clubId,
    recipientMemberId: input.recipientMemberId,
    topic: input.topic,
    payload: input.payload,
    payloadVersion: 1,
    refs: input.refs ?? [],
  }]);
}

async function queueApplicationNotification(
  client: DbClient,
  input: {
    recipientMemberId: string;
    topic: string;
    payload: Record<string, unknown>;
    refs?: NotificationRefInput[];
  },
): Promise<void> {
  await queueNotification(client, {
    clubId: null,
    recipientMemberId: input.recipientMemberId,
    topic: input.topic,
    payload: input.payload,
    refs: input.refs,
  });
}

function applicationSubjectRefs(input: {
  applicationId: string;
  clubId: string;
  actorMemberId?: string | null;
  targetMembershipId?: string | null;
}): NotificationRefInput[] {
  const refs: NotificationRefInput[] = [
    { role: 'subject', kind: 'application', id: input.applicationId },
    { role: 'club_context', kind: 'club', id: input.clubId },
  ];
  if (input.actorMemberId) {
    refs.push({ role: 'actor', kind: 'member', id: input.actorMemberId });
  }
  if (input.targetMembershipId) {
    refs.push({ role: 'target', kind: 'membership', id: input.targetMembershipId });
  }
  return refs;
}

function invitationSubjectRefs(input: {
  invitationId: string;
  clubId: string;
  actorMemberId?: string | null;
  targetApplicationId?: string | null;
  targetMemberId?: string | null;
}): NotificationRefInput[] {
  const refs: NotificationRefInput[] = [
    { role: 'subject', kind: 'invitation', id: input.invitationId },
    { role: 'club_context', kind: 'club', id: input.clubId },
  ];
  if (input.actorMemberId) {
    refs.push({ role: 'actor', kind: 'member', id: input.actorMemberId });
  }
  if (input.targetApplicationId) {
    refs.push({ role: 'target', kind: 'application', id: input.targetApplicationId });
  }
  if (input.targetMemberId) {
    refs.push({ role: 'target', kind: 'member', id: input.targetMemberId });
  }
  return refs;
}

function membershipSubjectRefs(input: {
  membershipId: string;
  clubId: string;
  actorMemberId?: string | null;
}): NotificationRefInput[] {
  const refs: NotificationRefInput[] = [
    { role: 'subject', kind: 'membership', id: input.membershipId },
    { role: 'club_context', kind: 'club', id: input.clubId },
  ];
  if (input.actorMemberId) {
    refs.push({ role: 'actor', kind: 'member', id: input.actorMemberId });
  }
  return refs;
}

function buildApplicantNotificationPayload(row: ApplicationRow): Record<string, unknown> {
  return {
    applicationId: row.application_id,
    clubId: row.club_id,
    clubSlug: row.club_slug,
    clubName: row.club_name,
    submissionPath: row.submission_path,
    invitation: buildMemberInvitationMetadata(row),
    phase: row.phase,
    workflow: buildApplicationWorkflow(row),
    gate: mapMemberGate(row),
    next: buildNextDirective(row.phase, row.application_id),
    messages: buildMessages(row),
    submittedAt: row.submitted_at,
  };
}

async function queueClubadminApplicationPendingNotifications(
  client: DbClient,
  input: {
    clubId: string;
    clubName: string;
    applicationId: string;
    applicantMemberId: string;
    applicantName: string;
    submissionPath: 'cold' | 'invitation';
    submittedAt?: string;
    revisedAt?: string;
    previousPhase: ApplicationRow['phase'] | null;
  },
): Promise<void> {
  const recipients = await client.query<{ member_id: string }>(
    `select distinct acm.member_id
     from accessible_club_memberships acm
     where acm.club_id = $1
       and acm.role = 'clubadmin'`,
    [input.clubId],
  );

  await deliverCoreNotifications(client, recipients.rows.map((row) => ({
    clubId: input.clubId,
    recipientMemberId: row.member_id,
    topic: 'clubadmin.application_pending',
    payloadVersion: 1,
    payload: {
      applicationId: input.applicationId,
      clubId: input.clubId,
      clubName: input.clubName,
      applicantName: input.applicantName,
      submissionPath: input.submissionPath,
      previousPhase: input.previousPhase,
      ...(input.submittedAt ? { submittedAt: input.submittedAt } : {}),
      ...(input.revisedAt ? { revisedAt: input.revisedAt } : {}),
    },
    refs: [
      { role: 'subject', kind: 'application', id: input.applicationId },
      { role: 'club_context', kind: 'club', id: input.clubId },
      { role: 'actor', kind: 'member', id: input.applicantMemberId },
    ],
  })));
}

async function acknowledgeClubadminApplicationPendingNotifications(
  client: DbClient,
  input: {
    clubId: string;
    applicationId: string;
  },
): Promise<void> {
  await autoAcknowledgeNotifications(client, {
    producerId: 'core',
    topic: 'clubadmin.application_pending',
    clubId: input.clubId,
    matchesAny: [
      {
        ref: {
          role: 'subject',
          kind: 'application',
          id: input.applicationId,
        },
      },
      {
        payloadFields: {
          applicationId: input.applicationId,
        },
      },
    ],
  });
}

function canEmitInvitationResolved(row: Pick<ApplicationRow, 'submission_path' | 'sponsor_member_id' | 'invitation_id'>): boolean {
  return row.submission_path === 'invitation' && row.sponsor_member_id !== null && row.invitation_id !== null;
}

function buildRegisterNotification(memberId: string, publicName: string): Record<string, unknown> {
  return {
    memberId,
    publicName,
    welcomeMessage: `Welcome, ${publicName}. Great to have you here! Please save your bearer token carefully.`,
    capabilities: [
      'You can now create your own trial club.',
      'You can redeem invitations sent to you.',
      'You can apply to clubs and track decisions through updates.list.',
      'You cannot access any club content until an admin accepts your application.',
    ],
    limits: {
      maxInFlightApplications: getConfig().policy.applications.maxInFlightPerMember,
      proofOfWork: 'Registration requires one proof-of-work puzzle. Club applications do not.',
    },
    suggestedNext: [
      { action: 'clubs.apply', reason: 'Apply to a club using a clubSlug you already know (from an invitation or operator — ClawClub has no public club directory).' },
      { action: 'invitations.redeem', reason: 'Redeem an invitation code someone sent you.' },
    ],
  };
}

async function buildApplicationPayload(client: DbClient, row: ApplicationRow): Promise<Record<string, unknown>> {
  const inFlightCount = await countInFlightApplications(client, row.applicant_member_id);
  return mapApplicationState(row, inFlightCount);
}

async function throwMemberApplicationNotMutable(
  client: DbClient,
  row: ApplicationRow,
  message: string,
): Promise<never> {
  throw new AppError('application_not_mutable', message, {
    details: await buildApplicationPayload(client, row),
  });
}

function mapAdminApplicationState(row: ApplicationRow): Record<string, unknown> {
  return {
    applicationId: row.application_id,
    clubId: row.club_id,
    clubSlug: row.club_slug,
    clubName: row.club_name,
    clubSummary: row.club_summary,
    admissionPolicy: row.admission_policy,
    applicantMemberId: row.applicant_member_id,
    sponsorId: row.sponsor_member_id,
    sponsorName: row.sponsor_public_name,
    submissionPath: row.submission_path,
    invitation: buildAdminInvitationMetadata(row),
    phase: row.phase,
    draft: {
      name: row.draft_name,
      socials: row.draft_socials,
      application: row.draft_application,
    },
    gate: {
      verdict: row.gate_verdict ?? 'not_run',
      feedback: row.gate_feedback
        ? {
            message: row.gate_feedback.message ?? null,
            missingItems: row.gate_feedback.missingItems ?? [],
          }
        : null,
      lastRunAt: row.gate_last_run_at,
    },
    admin: {
      note: row.admin_note,
      workflowStage: row.admin_workflow_stage,
    },
    submittedAt: row.submitted_at,
    decidedAt: row.decided_at,
    activatedMembershipId: row.activated_membership_id,
  };
}

type ApplicationDraft = {
  name: string;
  socials: string;
  application: string;
};

type PreparedApplicationEvaluation = {
  generatedProfileDraft: ClubProfileFields;
  phase: ApplicationRow['phase'];
  gateVerdict: ApplicationRow['gate_verdict'];
  gateFeedback: Record<string, unknown> | null;
  gateLastRunAt: string | null;
  gateInputHash: string;
};

function computeGateInputHash(input: {
  draft: ApplicationDraft;
  memberEmail: string | null;
  clubName: string;
  clubSummary: string | null;
  admissionPolicy: string | null;
}): string {
  return createHash('sha256').update(
    JSON.stringify({
      name: input.draft.name,
      memberEmail: input.memberEmail,
      socials: input.draft.socials,
      application: input.draft.application,
      clubName: input.clubName,
      clubSummary: input.clubSummary,
      admissionPolicy: input.admissionPolicy && input.admissionPolicy.trim().length > 0
        ? input.admissionPolicy
        : null,
    }),
    'utf8',
  ).digest('hex');
}

async function prepareApplicationEvaluation(pool: Pool, input: {
  actorMemberId: string;
  club: ClubRow;
  draft: ApplicationDraft;
  previousApplication?: Pick<
    ApplicationRow,
    'phase'
    | 'generated_profile_draft'
    | 'gate_verdict'
    | 'gate_feedback'
    | 'gate_last_run_at'
    | 'gate_input_hash'
  > | null;
}): Promise<PreparedApplicationEvaluation> {
  const memberEmail = await readMemberEmail(pool, input.actorMemberId);
  const gateInputHash = computeGateInputHash({
    draft: input.draft,
    memberEmail,
    clubName: input.club.name,
    clubSummary: input.club.summary,
    admissionPolicy: input.club.admission_policy,
  });

  if (
    input.previousApplication
    && input.previousApplication.gate_input_hash === gateInputHash
    && input.previousApplication.gate_verdict
  ) {
    return {
      generatedProfileDraft: normalizeClubProfileFields(input.previousApplication.generated_profile_draft),
      phase: input.previousApplication.phase,
      gateVerdict: input.previousApplication.gate_verdict,
      gateFeedback: input.previousApplication.gate_feedback,
      gateLastRunAt: input.previousApplication.gate_last_run_at,
      gateInputHash,
    };
  }

  const generatedProfileDraft = await runBudgetedLlmCall(pool, {
    memberId: input.actorMemberId,
    clubId: input.club.club_id,
    actionName: QUOTA_ACTIONS.clubsApply,
    execute: ({ maxOutputTokens }) => generateClubApplicationProfile({
      club: {
        name: input.club.name,
        summary: input.club.summary,
        admissionPolicy: input.club.admission_policy,
      },
      applicantName: input.draft.name,
      application: input.draft.application,
      socials: input.draft.socials,
      maxOutputTokens,
    }),
    getActualOutputTokens: (result) => result.usage?.completionTokens ?? 0,
  });

  const admissionPolicy = input.club.admission_policy;
  if (!admissionPolicy || admissionPolicy.trim().length === 0) {
    return {
      generatedProfileDraft: generatedProfileDraft.profile,
      phase: 'awaiting_review',
      gateVerdict: 'not_run',
      gateFeedback: null,
      gateLastRunAt: null,
      gateInputHash,
    };
  }

  const gateLastRunAt = new Date().toISOString();
  const artifact: ApplicationArtifact = {
    kind: 'application',
    club: {
      name: input.club.name,
      summary: input.club.summary,
      admissionPolicy,
    },
    applicant: {
      name: input.draft.name,
      email: memberEmail ?? '',
      socials: input.draft.socials,
      application: input.draft.application,
    },
  };
  const gateVerdict = await runBudgetedLlmCall(pool, {
    memberId: input.actorMemberId,
    clubId: input.club.club_id,
    actionName: QUOTA_ACTIONS.clubsApply,
    execute: ({ maxOutputTokens }) => checkLlmGate(artifact, { maxOutputTokens }),
    getActualOutputTokens: (result) => ('usage' in result ? result.usage.completionTokens : 0),
  });
  logMalformedGateVerdict({
    actionName: QUOTA_ACTIONS.clubsApply,
    memberId: input.actorMemberId,
    requestedClubId: input.club.club_id,
    artifactKind: artifact.kind,
    verdict: gateVerdict,
  });
  const gate = mapApplicationGateVerdict({
    verdict: gateVerdict,
    gateLastRunAt,
  }) satisfies StoredApplicationGateResult;

  return {
    generatedProfileDraft: generatedProfileDraft.profile,
    gateInputHash,
    ...gate,
  };
}

function assertPreparedClubStillCurrent(preparedClub: ClubRow, currentClub: ClubRow): void {
  if (
    preparedClub.club_id !== currentClub.club_id
    || preparedClub.name !== currentClub.name
    || preparedClub.summary !== currentClub.summary
    || preparedClub.admission_policy !== currentClub.admission_policy
  ) {
    throw new AppError('application_not_mutable', 'Club details changed while the application was being prepared. Retry the request.');
  }
}

function assertPreparedInvitationStillCurrent(prepared: InvitationRedeemRow, current: InvitationRedeemRow): void {
  if (
    prepared.club_id !== current.club_id
    || prepared.club_name !== current.club_name
    || prepared.club_summary !== current.club_summary
    || prepared.admission_policy !== current.admission_policy
    || prepared.sponsor_member_id !== current.sponsor_member_id
    || prepared.candidate_email_normalized !== current.candidate_email_normalized
    || prepared.delivery_kind !== current.delivery_kind
    || prepared.expires_at !== current.expires_at
  ) {
    throw new AppError('application_not_mutable', 'Invitation details changed while the application was being prepared. Retry the request.');
  }
}

async function runBudgetedLlmCall<T extends object>(pool: Pool, input: {
  memberId: string;
  clubId: string;
  actionName: string;
  execute: (options: { maxOutputTokens: number }) => Promise<T>;
  getActualOutputTokens: (result: T) => number;
}): Promise<T> {
  const reservation = await reserveLlmOutputBudget(pool, {
    memberId: input.memberId,
    clubId: input.clubId,
    actionName: input.actionName,
    provider: 'openai',
    model: CLAWCLUB_OPENAI_MODEL,
    maxOutputTokens: getLlmGateMaxOutputTokens(),
  });

  try {
    const result = await input.execute({ maxOutputTokens: getLlmGateMaxOutputTokens() });
    await finalizeLlmOutputBudget(pool, {
      reservationId: reservation.reservationId,
      actualOutputTokens: Math.max(0, input.getActualOutputTokens(result)),
    });
    return result;
  } catch (error) {
    await finalizeLlmOutputBudget(pool, {
      reservationId: reservation.reservationId,
      actualOutputTokens: 0,
    });
    throw error;
  }
}

async function createApplicationRecord(
  client: DbClient,
  input: {
    actorMemberId: string;
    club: ClubRow;
    submissionPath: 'cold' | 'invitation';
    invitationId?: string | null;
    sponsorId?: string | null;
    sponsorNameSnapshot?: string | null;
    inviteReasonSnapshot?: string | null;
    inviteMode?: 'internal' | 'external' | null;
    draft: ApplicationDraft;
    evaluation: PreparedApplicationEvaluation;
  },
): Promise<ApplicationRow> {
  const inserted = await client.query<{ application_id: string }>(
    `insert into club_applications (
       club_id,
       applicant_member_id,
       submission_path,
       invitation_id,
       sponsor_member_id,
       sponsor_name_snapshot,
       invite_reason_snapshot,
       invite_mode,
       phase,
       draft_name,
       draft_socials,
       draft_application,
       generated_profile_draft,
       gate_verdict,
       gate_feedback,
       gate_last_run_at,
       gate_input_hash
     )
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15::jsonb, $16::timestamptz, $17)
     returning id as application_id`,
    [
      input.club.club_id,
      input.actorMemberId,
      input.submissionPath,
      input.invitationId ?? null,
      input.sponsorId ?? null,
      input.sponsorNameSnapshot ?? null,
      input.inviteReasonSnapshot ?? null,
      input.inviteMode ?? null,
      input.evaluation.phase,
      input.draft.name,
      input.draft.socials,
      input.draft.application,
      JSON.stringify(input.evaluation.generatedProfileDraft),
      input.evaluation.gateVerdict,
      JSON.stringify(input.evaluation.gateFeedback),
      input.evaluation.gateLastRunAt,
      input.evaluation.gateInputHash,
    ],
  );

  const applicationId = inserted.rows[0]?.application_id;
  if (!applicationId) {
    throw new AppError('application_creation_failed', 'Failed to create application.');
  }

  await client.query(
    `insert into club_application_revisions (
       application_id,
       version_no,
       draft_name,
       draft_socials,
       draft_application,
       gate_verdict,
       gate_feedback,
       created_by_member_id
     )
     values ($1, 1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [
      applicationId,
      input.draft.name,
      input.draft.socials,
      input.draft.application,
      input.evaluation.gateVerdict,
      JSON.stringify(input.evaluation.gateFeedback),
      input.actorMemberId,
    ],
  );

  const row = await readApplicationRow(client, applicationId);
  if (!row) {
    throw new AppError('application_creation_failed', 'Created application row was not returned.');
  }

  const notificationTopic = row.phase === 'revision_required' ? 'application.revision_required' : 'application.awaiting_review';
  await queueApplicationNotification(client, {
    recipientMemberId: input.actorMemberId,
    topic: notificationTopic,
    payload: buildApplicantNotificationPayload(row),
    refs: applicationSubjectRefs({
      applicationId: row.application_id,
      clubId: row.club_id,
      actorMemberId: row.applicant_member_id,
    }),
  });
  if (row.phase === 'awaiting_review') {
    await queueClubadminApplicationPendingNotifications(client, {
      clubId: row.club_id,
      clubName: row.club_name,
      applicationId: row.application_id,
      applicantMemberId: row.applicant_member_id,
      applicantName: row.draft_name,
      submissionPath: row.submission_path,
      submittedAt: row.submitted_at,
      previousPhase: null,
    });
  }

  return row;
}

async function createApplicationRecordOrThrowInFlight(
  client: DbClient,
  input: {
    actorMemberId: string;
    club: ClubRow;
    submissionPath: 'cold' | 'invitation';
    invitationId?: string | null;
    sponsorId?: string | null;
    sponsorNameSnapshot?: string | null;
    inviteReasonSnapshot?: string | null;
    inviteMode?: 'internal' | 'external' | null;
    draft: ApplicationDraft;
    evaluation: PreparedApplicationEvaluation;
  },
): Promise<ApplicationRow> {
  await client.query('savepoint club_application_insert_attempt');
  try {
    const row = await createApplicationRecord(client, input);
    await client.query('release savepoint club_application_insert_attempt');
    return row;
  } catch (error) {
    await client.query('rollback to savepoint club_application_insert_attempt');
    await client.query('release savepoint club_application_insert_attempt');
    if (!matchesPgConstraint(error, 'club_applications_one_open_per_member_club')) {
      throw error;
    }
    const raced = await getExistingOpenApplicationIfAny(client, {
      clubId: input.club.club_id,
      memberId: input.actorMemberId,
      forUpdate: true,
    });
    if (!raced) {
      throw error;
    }
    return throwApplicationInFlight(client, raced);
  }
}

export async function registerAccount(pool: Pool, input: {
  clientKey?: string;
  mode: 'discover' | 'submit';
  name?: string;
  email?: string;
  challengeBlob?: string;
  nonce?: string;
  invitationCode?: string;
  clientIp?: string | null;
}): Promise<Record<string, unknown>> {
  if (input.mode === 'discover') {
    const invitationCode = readOptionalInvitationCode(input.invitationCode);
    const invitationEmail = typeof input.email === 'string' && input.email.trim().length > 0
      ? normalizeEmail(input.email)
      : undefined;
    if ((invitationCode === undefined) !== (invitationEmail === undefined)) {
      throw new AppError('invalid_input', 'Registration discover requires invitationCode and email to be supplied together.');
    }
    const inviteBinding = invitationCode && invitationEmail
      ? {
        inviteCodeMac: computeInviteCodeMac(canonicalizeInvitationCodeForRegistrationMac(invitationCode)),
        email: invitationEmail,
      }
      : null;
    const challenge = issuePowChallenge({
      clubId: REGISTER_POW_SCOPE,
      difficulty: inviteBinding ? getInvitedRegistrationDifficulty() : getColdApplicationDifficulty(),
      ...(inviteBinding ?? {}),
    });
    return {
      phase: 'proof_required',
      challenge,
      next: {
        action: 'accounts.register',
        requiredInputs: ['mode', 'name', 'email', 'challengeBlob', 'nonce', 'clientKey'],
        reason: 'Solve the proof-of-work puzzle and resubmit with your name and contact email.',
      },
      messages: {
        summary: 'Create your ClawClub account.',
        details: 'Registration creates a server identity and returns the only bearer token you will need. Save it safely.',
      },
    };
  }

  if (!input.clientKey || !input.name || !input.email || !input.challengeBlob || !input.nonce) {
    throw new AppError('invalid_input', 'Registration submit requires name, email, challengeBlob, nonce, and clientKey.');
  }
  const { clientKey, name, email, challengeBlob, nonce } = input;

  return withTransaction(pool, async (client) => {
    const anonymousScope = `anonymous:${input.clientIp ?? 'unknown'}:accounts.register`;
    return withIdempotency(client, {
      clientKey,
      actorContext: anonymousScope,
      requestValue: {
        mode: input.mode,
        name,
        email,
        challengeBlob,
        nonce,
        invitationCode: input.invitationCode,
      },
      execute: async () => {
        const verified = verifyPowChallenge({
          challengeBlob,
          expectedClubId: REGISTER_POW_SCOPE,
        });
        if (!verified.ok) {
          throw new AppError(
            verified.reason === 'expired' ? 'challenge_expired' : 'invalid_challenge',
            'The registration challenge is invalid or expired.',
          );
        }
        if (!validatePowSolution(verified.payload.id, nonce, verified.payload.difficulty)) {
          throw new AppError('invalid_proof', 'The supplied nonce does not satisfy the registration challenge.');
        }
        const normalizedEmail = normalizeEmail(email);
        const inviteBinding = readVerifiedInviteBinding(verified.payload);

        let normalizedInvitationCodeForLookup: string | null = null;
        let invitedRegistration: InvitationRegistrationRow | null = null;
        if (inviteBinding) {
          const submittedInvitationCode = readOptionalInvitationCode(input.invitationCode);
          if (!submittedInvitationCode) {
            throwInvalidRegistrationChallenge();
          }
          const canonicalSubmittedInvitationCode = canonicalizeInvitationCodeForRegistrationMac(submittedInvitationCode);
          if (!verifyInviteCodeMac(canonicalSubmittedInvitationCode, inviteBinding.inviteCodeMac)) {
            throwInvalidRegistrationChallenge();
          }
          if (normalizedEmail !== inviteBinding.email) {
            throwInvalidRegistrationChallenge();
          }
          normalizedInvitationCodeForLookup = normalizeInvitationCode(submittedInvitationCode);
        } else if (readOptionalInvitationCode(input.invitationCode)) {
          throwInvalidRegistrationChallenge();
        }

        const existingMember = await client.query<{ id: string }>(
          `select id
           from members
           where lower(email) = lower($1)
           limit 1`,
          [normalizedEmail],
        );
        if (existingMember.rows[0]) {
          throw new AppError('email_already_registered', EMAIL_ALREADY_REGISTERED_MESSAGE);
        }
        const consumed = await client.query(
          `insert into consumed_account_registration_pow_challenges (challenge_id)
           values ($1)
           on conflict (challenge_id) do nothing`,
          [verified.payload.id],
        );
        if (consumed.rowCount === 0) {
          throw new AppError('challenge_already_used', 'That registration challenge was already used.');
        }

        if (inviteBinding) {
          // Post-PoW invitation business errors roll back the consumed marker;
          // the signed code/email binding keeps retries pinned to the same intent.
          if (!normalizedInvitationCodeForLookup) {
            throw new AppError('invitation_invalid', 'No invitation matches the supplied code.');
          }
          invitedRegistration = await loadInvitationForRegistration(client, normalizedInvitationCodeForLookup);
          if (!invitedRegistration || invitedRegistration.delivery_kind !== 'code') {
            throw new AppError('invitation_invalid', 'No invitation matches the supplied code.');
          }
          if (invitedRegistration.revoked_at) {
            throw new AppError('invitation_revoked', 'The invitation has been revoked.');
          }
          if (invitedRegistration.support_withdrawn_at) {
            throw new AppError('invitation_support_withdrawn', 'The sponsor has withdrawn support for this invitation.');
          }
          if (invitedRegistration.used_at) {
            throw new AppError('invitation_used', 'The invitation has already been redeemed.');
          }
          if (invitedRegistration.expired_at || invitedRegistration.expires_at_in_past) {
            throw new AppError('invitation_expired', 'The invitation has expired.');
          }
          if (invitedRegistration.candidate_email_normalized !== normalizedEmail) {
            throw new AppError('email_does_not_match_invite', 'The submitted email does not match the candidate email on this invitation.');
          }
        }

        let member;
        try {
          member = await client.query<{ member_id: string; public_name: string; email: string; created_at: string }>(
            `insert into members (public_name, display_name, email, state, registered_via_invite_request_id)
             values ($1, $1, $2, 'active', $3)
             returning id as member_id, public_name, email, created_at::text as created_at`,
            [name, normalizedEmail, invitedRegistration?.invitation_id ?? null],
          );
        } catch (error) {
          if (isMembersEmailUniqueViolation(error)) {
            throw new AppError('email_already_registered', EMAIL_ALREADY_REGISTERED_MESSAGE);
          }
          throw error;
        }
        const row = member.rows[0];
        if (!row) {
          throw new AppError('member_creation_failed', 'Failed to create member.');
        }

        const token = await createBearerTokenInDb(client, {
          memberId: row.member_id,
          label: 'accounts.register',
          metadata: { flow: 'accounts.register' },
        });

        await queueNotification(client, {
          clubId: null,
          recipientMemberId: row.member_id,
          topic: 'account.registered',
          payload: buildRegisterNotification(row.member_id, row.public_name),
          refs: [
            { role: 'subject', kind: 'member', id: row.member_id },
          ],
        });

        return {
          responseValue: {
            phase: 'registered',
            member: {
              memberId: row.member_id,
              publicName: row.public_name,
              email: row.email,
              registeredAt: row.created_at,
            },
            credentials: {
              kind: 'member_bearer',
              memberBearer: token.bearerToken,
              guidance: REGISTER_TOKEN_GUIDANCE,
            },
            next: {
              action: 'updates.list',
              reason: 'Registration succeeded. Poll updates to receive your welcome and next-step guidance.',
            },
            applicationLimits: {
              inFlightCount: 0,
              maxInFlight: getConfig().policy.applications.maxInFlightPerMember,
            },
            messages: {
              summary: 'Welcome. Save your token and then apply to a club.',
              details: 'Everything else in ClawClub depends on this bearer. There is no self-service recovery flow.',
            },
          },
          storedValue: {
            phase: 'registration_already_completed',
            member: {
              memberId: row.member_id,
              publicName: row.public_name,
              email: row.email,
              registeredAt: row.created_at,
            },
            next: {
              action: null,
              reason: 'This clientKey already completed registration. If the original bearer was lost, register again with a fresh clientKey and a fresh PoW challenge, or contact the operator for out-of-band recovery.',
            },
            messages: {
              summary: 'Registration already completed for this clientKey.',
              details: 'The bearer from the first successful response is never replayed.',
            },
          },
        };
      },
    });
  });
}

export async function updateContactEmail(pool: Pool, input: {
  actorMemberId: string;
  newEmail: string;
  clientKey: string;
}): Promise<Record<string, unknown>> {
  return withTransaction(pool, async (client) => {
    return withIdempotency(client, {
      clientKey: input.clientKey,
      actorContext: `member:${input.actorMemberId}:accounts.updateContactEmail`,
      requestValue: input,
      execute: async () => {
        let result;
        try {
          result = await client.query<{ member_id: string; public_name: string; email: string }>(
            `update members
             set email = $2
             where id = $1
               and state = 'active'
             returning id as member_id, public_name, email`,
            [input.actorMemberId, normalizeEmail(input.newEmail)],
          );
        } catch (error) {
          if (isMembersEmailUniqueViolation(error)) {
            throw new AppError('email_already_registered', EMAIL_ALREADY_REGISTERED_MESSAGE);
          }
          throw error;
        }
        const row = result.rows[0];
        if (!row) {
          throw new AppError('member_not_found', 'Member not found.');
        }
        const response = {
          member: {
            memberId: row.member_id,
            publicName: row.public_name,
            email: row.email,
          },
          messages: {
            summary: 'Your contact email has been updated.',
            details: 'Admins will now use this address for out-of-band contact.',
          },
        };
        return { responseValue: response };
      },
    });
  });
}

export async function applyToClub(pool: Pool, input: {
  actorMemberId: string;
  clubSlug: string;
  invitationId?: string;
  draft: { name: string; socials: string; application: string };
  clientKey: string;
}): Promise<Record<string, unknown>> {
  const actorContext = `member:${input.actorMemberId}:clubs.apply`;
  const replay = await lookupIdempotency<Record<string, unknown>>(pool, {
    clientKey: input.clientKey,
    actorContext,
    requestValue: input,
  });
  if (replay.status === 'hit') {
    return replay.responseValue;
  }

  const preparedClub = await readClubBySlug(pool, input.clubSlug);
  if (!preparedClub) {
    throw new AppError('club_not_found', 'Club not found.');
  }
  await runApplicationPreflight(pool, {
    actorMemberId: input.actorMemberId,
    clubId: preparedClub.club_id,
  });
  await enforceDurableGlobalEventQuota(pool, {
    action: QUOTA_ACTIONS.clubsApply,
    memberId: input.actorMemberId,
  });
  const evaluation = await prepareApplicationEvaluation(pool, {
    actorMemberId: input.actorMemberId,
    club: preparedClub,
    draft: input.draft,
  });

  return withTransaction(pool, async (client) => {
    return withIdempotency(client, {
      clientKey: input.clientKey,
      actorContext,
      requestValue: input,
      execute: async () => {
        const club = await readClubBySlug(client, input.clubSlug);
        if (!club) {
          throw new AppError('club_not_found', 'Club not found.');
        }
        assertPreparedClubStillCurrent(preparedClub, club);
        const membership = await readExistingMembership(client, club.club_id, input.actorMemberId);
        assertMembershipAllowsApplication(membership);

        const existingOpen = await getExistingOpenApplicationIfAny(client, {
          clubId: club.club_id,
          memberId: input.actorMemberId,
          forUpdate: true,
        });
        if (existingOpen) {
          // Divergent-intent conflicts should not create an idempotency replay row.
          await throwApplicationInFlight(client, existingOpen);
        }

        await assertApplicationCapacity(client, input.actorMemberId);
        await assertNoClubBlock(client, club.club_id, input.actorMemberId);
        const invitationBinding = await resolveApplicationInvitationBinding(client, {
          clubId: club.club_id,
          applicantMemberId: input.actorMemberId,
          invitationId: input.invitationId,
        });
        if (invitationBinding?.invitationId) {
          const consumed = await client.query(
            `update invite_requests
             set used_at = now()
             where id = $1
               and used_at is null
               and revoked_at is null
               and expired_at is null`,
            [invitationBinding.invitationId],
          );
          if (consumed.rowCount === 0) {
            throw new AppError('application_not_mutable', 'Invitation details changed while the application was being prepared. Retry the request.');
          }
        }
        const row = await createApplicationRecordOrThrowInFlight(client, {
          actorMemberId: input.actorMemberId,
          club,
          submissionPath: invitationBinding ? 'invitation' : 'cold',
          invitationId: invitationBinding?.invitationId ?? null,
          sponsorId: invitationBinding?.sponsorId ?? null,
          sponsorNameSnapshot: invitationBinding?.sponsorNameSnapshot ?? null,
          inviteReasonSnapshot: invitationBinding?.inviteReasonSnapshot ?? null,
          inviteMode: invitationBinding?.inviteMode ?? null,
          draft: input.draft,
          evaluation,
        });
        if (invitationBinding?.sponsorId && invitationBinding.invitationId) {
          const candidatePublicName = await readMemberPublicName(client, input.actorMemberId);
          await queueNotification(client, {
            clubId: club.club_id,
            recipientMemberId: invitationBinding.sponsorId,
            topic: 'invitation.redeemed',
            payload: {
              invitationId: invitationBinding.invitationId,
              inviteMode: 'internal',
              clubId: club.club_id,
              clubName: club.name,
              candidateMemberId: input.actorMemberId,
              candidatePublicName: candidatePublicName ?? row.draft_name,
              applicationId: row.application_id,
              applicationPhase: row.phase,
              applicationWorkflow: buildApplicationWorkflow(row),
              applicationMessages: buildMessages(row),
            },
            refs: invitationSubjectRefs({
              invitationId: invitationBinding.invitationId,
              clubId: club.club_id,
              actorMemberId: input.actorMemberId,
              targetApplicationId: row.application_id,
            }),
          });
        }
        return { responseValue: await buildApplicationPayload(client, row) };
      },
    });
  });
}

export async function redeemInvitationApplication(pool: Pool, input: {
  actorMemberId: string;
  code: string;
  draft: { name: string; socials: string; application: string };
  clientKey: string;
}): Promise<Record<string, unknown>> {
  const actorContext = `member:${input.actorMemberId}:invitations.redeem`;
  const replay = await lookupIdempotency<Record<string, unknown>>(pool, {
    clientKey: input.clientKey,
    actorContext,
    requestValue: input,
  });
  if (replay.status === 'hit') {
    return replay.responseValue;
  }

  const preparedInvitation = await readInvitationForRedeem(pool, input.code);
  if (!preparedInvitation) {
    throw new AppError('invalid_invitation_code', INVALID_INVITATION_CODE_MESSAGE);
  }
  assertInvitationSponsorAvailable(preparedInvitation);
  await runApplicationPreflight(pool, {
    actorMemberId: input.actorMemberId,
    clubId: preparedInvitation.club_id,
  });
  if (
    preparedInvitation.revoked_at
    || preparedInvitation.expired_at
    || preparedInvitation.used_at
    || Date.parse(preparedInvitation.expires_at) <= Date.now()
  ) {
    throw new AppError('invalid_invitation_code', INVALID_INVITATION_CODE_MESSAGE);
  }
  const preparedClub: ClubRow = {
    club_id: preparedInvitation.club_id,
    slug: preparedInvitation.club_slug,
    name: preparedInvitation.club_name,
    summary: preparedInvitation.club_summary,
    admission_policy: preparedInvitation.admission_policy,
    owner_name: preparedInvitation.sponsor_public_name,
  };
  await enforceDurableGlobalEventQuota(pool, {
    action: QUOTA_ACTIONS.clubsApply,
    memberId: input.actorMemberId,
  });
  const evaluation = await prepareApplicationEvaluation(pool, {
    actorMemberId: input.actorMemberId,
    club: preparedClub,
    draft: input.draft,
  });

  return withTransaction(pool, async (client) => {
    return withIdempotency(client, {
      clientKey: input.clientKey,
      actorContext,
      requestValue: input,
      execute: async () => {
        const invitation = await readInvitationForRedeem(client, input.code, { forUpdate: true });
        if (!invitation) {
          throw new AppError('invalid_invitation_code', INVALID_INVITATION_CODE_MESSAGE);
        }
        assertInvitationSponsorAvailable(invitation);

        const membership = await readExistingMembership(client, invitation.club_id, input.actorMemberId);
        assertMembershipAllowsApplication(membership);

        const existingOpen = await getExistingOpenApplicationIfAny(client, {
          clubId: invitation.club_id,
          memberId: input.actorMemberId,
          forUpdate: true,
        });
        if (existingOpen) {
          // Divergent-intent conflicts should not create an idempotency replay row.
          await throwApplicationInFlight(client, existingOpen);
        }

        if (invitation.revoked_at || invitation.expired_at || invitation.used_at || Date.parse(invitation.expires_at) <= Date.now()) {
          throw new AppError('invalid_invitation_code', INVALID_INVITATION_CODE_MESSAGE);
        }
        assertPreparedInvitationStillCurrent(preparedInvitation, invitation);
        const club: ClubRow = {
          club_id: invitation.club_id,
          slug: invitation.club_slug,
          name: invitation.club_name,
          summary: invitation.club_summary,
          admission_policy: invitation.admission_policy,
          owner_name: invitation.sponsor_public_name,
        };
        await assertApplicationCapacity(client, input.actorMemberId);
        await assertNoClubBlock(client, invitation.club_id, input.actorMemberId);
        await client.query(
          `update invite_requests
           set used_at = now()
           where id = $1
             and used_at is null
             and revoked_at is null
             and expired_at is null`,
          [invitation.invitation_id],
        );
        const row = await createApplicationRecordOrThrowInFlight(client, {
          actorMemberId: input.actorMemberId,
          club,
          submissionPath: 'invitation',
          invitationId: invitation.invitation_id,
          sponsorId: invitation.sponsor_member_id,
          sponsorNameSnapshot: invitation.sponsor_public_name,
          inviteReasonSnapshot: invitation.reason,
          inviteMode: 'external',
          draft: input.draft,
          evaluation,
        });
        const candidatePublicName = await readMemberPublicName(client, input.actorMemberId);
        await queueNotification(client, {
          clubId: invitation.club_id,
          recipientMemberId: invitation.sponsor_member_id,
          topic: 'invitation.redeemed',
          payload: {
            invitationId: invitation.invitation_id,
            inviteMode: 'external',
            clubId: invitation.club_id,
            clubName: invitation.club_name,
            candidateMemberId: input.actorMemberId,
            candidatePublicName: candidatePublicName ?? row.draft_name,
            applicationId: row.application_id,
            applicationPhase: row.phase,
            applicationWorkflow: buildApplicationWorkflow(row),
            applicationMessages: buildMessages(row),
          },
          refs: invitationSubjectRefs({
            invitationId: invitation.invitation_id,
            clubId: invitation.club_id,
            actorMemberId: input.actorMemberId,
            targetApplicationId: row.application_id,
          }),
        });
        return { responseValue: await buildApplicationPayload(client, row) };
      },
    });
  });
}

export async function reviseClubApplication(pool: Pool, input: {
  actorMemberId: string;
  applicationId: string;
  draft: { name: string; socials: string; application: string };
  clientKey: string;
}): Promise<Record<string, unknown>> {
  const actorContext = `member:${input.actorMemberId}:clubs.applications.revise:${input.applicationId}`;
  const replay = await lookupIdempotency<Record<string, unknown>>(pool, {
    clientKey: input.clientKey,
    actorContext,
    requestValue: input,
  });
  if (replay.status === 'hit') {
    return replay.responseValue;
  }

  const preparedExisting = await readApplicationRow(pool, input.applicationId);
  if (!preparedExisting || preparedExisting.applicant_member_id !== input.actorMemberId) {
    throw new AppError('application_not_found', 'Application not found.');
  }
  if (preparedExisting.phase !== 'revision_required') {
    await throwMemberApplicationNotMutable(
      pool,
      preparedExisting,
      'Only applications in revision_required can be revised. If this application is already in awaiting_review, it has already been submitted to club admins and the applicant must wait.',
    );
  }
  const preparedClub = await readClubBySlug(pool, preparedExisting.club_slug);
  if (!preparedClub) {
    throw new AppError('club_not_found', 'Club not found.');
  }
  await enforceDurableGlobalEventQuota(pool, {
    action: QUOTA_ACTIONS.clubsApply,
    memberId: input.actorMemberId,
  });
  const evaluation = await prepareApplicationEvaluation(pool, {
    actorMemberId: input.actorMemberId,
    club: preparedClub,
    draft: input.draft,
    previousApplication: preparedExisting,
  });

  return withTransaction(pool, async (client) => {
    return withIdempotency(client, {
      clientKey: input.clientKey,
      actorContext,
      requestValue: input,
      execute: async () => {
        const existing = await readApplicationForUpdate(client, input.applicationId);
        if (!existing || existing.applicant_member_id !== input.actorMemberId) {
          throw new AppError('application_not_found', 'Application not found.');
        }
        if (existing.phase !== 'revision_required') {
          await throwMemberApplicationNotMutable(
            client,
            existing,
            'Only applications in revision_required can be revised. If this application is already in awaiting_review, it has already been submitted to club admins and the applicant must wait.',
          );
        }

        const club = await readClubBySlug(client, existing.club_slug);
        if (!club) {
          throw new AppError('club_not_found', 'Club not found.');
        }
        assertPreparedClubStillCurrent(preparedClub, club);

        await client.query(
          `update club_applications
           set phase = $2,
               draft_name = $3,
               draft_socials = $4,
               draft_application = $5,
               generated_profile_draft = $6::jsonb,
               gate_verdict = $7,
               gate_feedback = $8::jsonb,
               gate_last_run_at = $9::timestamptz,
               gate_input_hash = $10,
               updated_at = now(),
               submitted_at = now()
           where id = $1`,
          [
            input.applicationId,
            evaluation.phase,
            input.draft.name,
            input.draft.socials,
            input.draft.application,
            JSON.stringify(evaluation.generatedProfileDraft),
            evaluation.gateVerdict,
            JSON.stringify(evaluation.gateFeedback),
            evaluation.gateLastRunAt,
            evaluation.gateInputHash,
          ],
        );

        const version = await client.query<{ next_version_no: number }>(
          `select coalesce(max(version_no), 0) + 1 as next_version_no
           from club_application_revisions
           where application_id = $1`,
          [input.applicationId],
        );
        await client.query(
          `insert into club_application_revisions (
             application_id,
             version_no,
             draft_name,
             draft_socials,
             draft_application,
             gate_verdict,
             gate_feedback,
             created_by_member_id
           )
           values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
          [
            input.applicationId,
            Number(version.rows[0]?.next_version_no ?? 1),
            input.draft.name,
            input.draft.socials,
            input.draft.application,
            evaluation.gateVerdict,
            JSON.stringify(evaluation.gateFeedback),
            input.actorMemberId,
          ],
        );

        const row = await readApplicationRow(client, input.applicationId);
        if (!row) {
          throw new AppError('application_update_failed', 'Updated application row was not returned.');
        }

        await queueApplicationNotification(client, {
          recipientMemberId: input.actorMemberId,
          topic: row.phase === 'revision_required' ? 'application.revision_required' : 'application.awaiting_review',
          payload: buildApplicantNotificationPayload(row),
          refs: applicationSubjectRefs({
            applicationId: row.application_id,
            clubId: row.club_id,
            actorMemberId: row.applicant_member_id,
          }),
        });
        if (row.phase === 'awaiting_review') {
          await queueClubadminApplicationPendingNotifications(client, {
            clubId: row.club_id,
            clubName: row.club_name,
            applicationId: row.application_id,
            applicantMemberId: row.applicant_member_id,
            applicantName: row.draft_name,
            submissionPath: row.submission_path,
            revisedAt: row.submitted_at,
            previousPhase: existing.phase,
          });
        }

        return { responseValue: await buildApplicationPayload(client, row) };
      },
    });
  });
}

export async function getMemberApplicationById(pool: Pool, input: {
  actorMemberId: string;
  applicationId: string;
}): Promise<Record<string, unknown> | null> {
  const row = await readApplicationRow(pool, input.applicationId);
  if (!row || row.applicant_member_id !== input.actorMemberId) {
    return null;
  }
  const inFlightCount = await countInFlightApplications(pool, input.actorMemberId);
  return mapApplicationState(row, inFlightCount);
}

export async function listMemberApplications(pool: Pool, input: {
  actorMemberId: string;
  phases?: string[] | null;
  limit: number;
  cursor?: { submittedAt: string; applicationId: string } | null;
}): Promise<{ results: Record<string, unknown>[]; hasMore: boolean; nextCursor: string | null }> {
  const phases = input.phases && input.phases.length > 0
    ? input.phases
    : ['awaiting_review', 'active'];
  const fetchLimit = Math.max(1, Math.min(input.limit, DEFAULT_PAGE_LIMIT)) + 1;
  const result = await pool.query<ApplicationRow>(
    `${APPLICATION_ROW_SELECT}
     where ca.applicant_member_id = $1
       and ca.phase = any($2::text[])
       and (
         $3::timestamptz is null
         or ca.submitted_at < $3
         or (ca.submitted_at = $3 and ca.id < $4)
       )
     order by ca.submitted_at desc, ca.id desc
     limit $5`,
    [
      input.actorMemberId,
      phases,
      input.cursor?.submittedAt ?? null,
      input.cursor?.applicationId ?? null,
      fetchLimit,
    ],
  );
  const inFlightCount = await countInFlightApplications(pool, input.actorMemberId);
  const page = result.rows.slice(0, fetchLimit - 1);
  const last = page[page.length - 1];
  return {
    results: page.map((row) => mapApplicationState(row, inFlightCount)),
    hasMore: result.rows.length > page.length,
    nextCursor: result.rows.length > page.length && last
      ? encodeCursor([last.submitted_at, last.application_id])
      : null,
  };
}

export async function withdrawClubApplication(pool: Pool, input: {
  actorMemberId: string;
  applicationId: string;
  clientKey: string;
}): Promise<Record<string, unknown> | null> {
  return withTransaction(pool, async (client) => {
    return withIdempotency(client, {
      clientKey: input.clientKey,
      actorContext: `member:${input.actorMemberId}:clubs.applications.withdraw:${input.applicationId}`,
      requestValue: input,
      execute: async () => {
        const row = await readApplicationForUpdate(client, input.applicationId);
        if (!row || row.applicant_member_id !== input.actorMemberId) {
          throw new AppError('application_not_found', 'Application not found.');
        }
        if (!['revision_required', 'awaiting_review'].includes(row.phase)) {
          await throwMemberApplicationNotMutable(
            client,
            row,
            'Only non-terminal applications can be withdrawn. Read the canonical application state in error.details and follow that state instead of retrying withdraw.',
          );
        }

        await client.query(
          `update club_applications
           set phase = 'withdrawn',
               decided_at = now(),
               updated_at = now()
           where id = $1`,
          [input.applicationId],
        );

        const updated = await readApplicationRow(client, input.applicationId);
        if (!updated) {
          throw new AppError('application_update_failed', 'Updated application row was not returned.');
        }

        await queueApplicationNotification(client, {
          recipientMemberId: input.actorMemberId,
          topic: 'application.withdrawn',
          payload: {
            applicationId: updated.application_id,
            clubId: updated.club_id,
            clubName: updated.club_name,
          },
          refs: applicationSubjectRefs({
            applicationId: updated.application_id,
            clubId: updated.club_id,
            actorMemberId: updated.applicant_member_id,
          }),
        });

        if (canEmitInvitationResolved(updated)) {
          await queueNotification(client, {
            clubId: updated.club_id,
            recipientMemberId: updated.sponsor_member_id!,
            topic: 'invitation.resolved',
            payload: {
              applicantName: updated.draft_name,
              clubName: updated.club_name,
              phase: 'withdrawn',
              resolvedAt: updated.decided_at ?? new Date().toISOString(),
              invitationId: updated.invitation_id,
            },
            refs: invitationSubjectRefs({
              invitationId: updated.invitation_id!,
              clubId: updated.club_id,
              actorMemberId: updated.applicant_member_id,
            }),
          });
        }

        return { responseValue: await buildApplicationPayload(client, updated) };
      },
    });
  });
}

export async function listAdminClubApplications(pool: Pool, input: {
  actorMemberId: string;
  clubId: string;
  phases?: string[] | null;
  limit: number;
  cursor?: { submittedAt: string; applicationId: string } | null;
}): Promise<{ results: Record<string, unknown>[]; hasMore: boolean; nextCursor: string | null }> {
  const phases = input.phases && input.phases.length > 0
    ? input.phases
    : ['awaiting_review'];
  const fetchLimit = Math.max(1, Math.min(input.limit, DEFAULT_PAGE_LIMIT)) + 1;
  const result = await pool.query<ApplicationRow>(
    `${APPLICATION_ROW_SELECT}
     where ca.club_id = $1
       and ca.phase = any($2::text[])
       and (
         $3::timestamptz is null
         or ca.submitted_at < $3
         or (ca.submitted_at = $3 and ca.id < $4)
       )
     order by ca.submitted_at desc, ca.id desc
     limit $5`,
    [input.clubId, phases, input.cursor?.submittedAt ?? null, input.cursor?.applicationId ?? null, fetchLimit],
  );
  const page = result.rows.slice(0, fetchLimit - 1);
  const last = page[page.length - 1];
  return {
    results: page.map((row) => mapAdminApplicationState(row)),
    hasMore: result.rows.length > page.length,
    nextCursor: result.rows.length > page.length && last
      ? encodeCursor([last.submitted_at, last.application_id])
      : null,
  };
}

export async function getAdminClubApplicationById(pool: Pool, input: {
  actorMemberId: string;
  clubId: string;
  applicationId: string;
}): Promise<Record<string, unknown> | null> {
  const row = await readApplicationRow(pool, input.applicationId);
  if (!row || row.club_id !== input.clubId) {
    return null;
  }
  return mapAdminApplicationState(row);
}

export async function decideClubApplication(pool: Pool, input: {
  actorMemberId: string;
  actorPublicName?: string;
  clubId: string;
  applicationId: string;
  decision: 'accept' | 'decline' | 'ban';
  adminNote?: string | null;
  clientKey: string;
}): Promise<Record<string, unknown> | null> {
  return withTransaction(pool, async (client) => {
    return withIdempotency(client, {
      clientKey: input.clientKey,
      actorContext: `member:${input.actorMemberId}:clubadmin.applications.decide:${input.applicationId}`,
      requestValue: input,
      execute: async () => {
        const row = await readApplicationForUpdate(client, input.applicationId, { clubId: input.clubId });
        if (!row) {
          throw new AppError('application_not_found', 'Application not found.');
        }
        if (row.phase !== 'awaiting_review') {
          if (['active', 'declined', 'banned', 'removed'].includes(row.phase)) {
            throwApplicationAlreadyDecided(row);
          }
          throw new AppError(
            'application_not_mutable',
            'Only applications in awaiting_review can be decided. If the row is revision_required, the applicant still needs to revise before admins can act.',
            { details: applicationDecisionDetails(row) },
          );
        }

        if (input.decision === 'accept') {
          const currentMembership = await readExistingMembership(client, row.club_id, row.applicant_member_id);
          const membership = currentMembership?.status === 'cancelled'
            ? await reactivateCancelledMembershipInTransaction(client, {
                actorMemberId: input.actorMemberId,
                clubId: row.club_id,
                memberId: row.applicant_member_id,
                reason: input.adminNote ?? null,
              })
            : await createMembershipInTransaction(client, {
                actorMemberId: input.actorMemberId,
                clubId: row.club_id,
                memberId: row.applicant_member_id,
                sponsorId: row.sponsor_member_id ?? null,
                role: 'member',
                initialStatus: 'active',
                reason: input.adminNote ?? null,
                metadata: {},
                initialProfile: {
                  fields: (row.generated_profile_draft as ClubProfileFields | null) ?? {
                    tagline: null,
                    summary: null,
                    whatIDo: null,
                    knownFor: null,
                    servicesSummary: null,
                    websiteUrl: null,
                    links: [],
                  },
                  generationSource: row.generated_profile_draft ? 'application_generated' : 'membership_seed',
                },
              });
          if (!membership) {
            throw new AppError('member_not_found', 'Club or member was not available for activation.');
          }

          await client.query(
            `update club_applications
             set phase = 'active',
                 admin_note = $2,
                 decided_at = now(),
                 decided_by_member_id = $3,
                 activated_membership_id = $4,
                 updated_at = now()
             where id = $1`,
            [row.application_id, input.adminNote ?? null, input.actorMemberId, membership.membershipId],
          );

          if (row.invitation_id) {
            await client.query(
              `update invite_requests
               set used_membership_id = $2
               where id = $1`,
              [row.invitation_id, membership.membershipId],
            );
          }

          const updated = await readApplicationRow(client, row.application_id);
          if (!updated) {
            throw new AppError('application_update_failed', 'Updated application row was not returned.');
          }
          await acknowledgeClubadminApplicationPendingNotifications(client, {
            clubId: updated.club_id,
            applicationId: updated.application_id,
          });
          const decidingAdminPublicName = input.actorPublicName ?? await readMemberPublicName(client, input.actorMemberId);
          if (!decidingAdminPublicName) {
            throw new AppError('missing_row', 'Deciding admin could not be reloaded for the acceptance notification.');
          }

          await queueApplicationNotification(client, {
            recipientMemberId: updated.applicant_member_id,
            topic: 'application.accepted',
            payload: {
              applicationId: updated.application_id,
              membership: {
                membershipId: membership.membershipId,
                clubId: membership.clubId,
                role: membership.role,
                joinedAt: membership.joinedAt,
              },
              welcomeMessage: `Welcome to ${updated.club_name}.`,
              clubName: updated.club_name,
              clubSummary: updated.club_summary,
              admissionPolicy: updated.admission_policy,
              decidedByAdmin: {
                memberId: input.actorMemberId,
                publicName: decidingAdminPublicName,
              },
              suggestedFirstActions: ['updates.list', 'content.list', 'events.list', 'members.list'],
            },
            refs: applicationSubjectRefs({
              applicationId: updated.application_id,
              clubId: updated.club_id,
              actorMemberId: input.actorMemberId,
              targetMembershipId: membership.membershipId,
            }),
          });

          if (canEmitInvitationResolved(updated)) {
            await queueNotification(client, {
              clubId: updated.club_id,
              recipientMemberId: updated.sponsor_member_id!,
              topic: 'invitation.resolved',
              payload: {
                applicantName: updated.draft_name,
                clubName: updated.club_name,
                phase: 'active',
                resolvedAt: updated.decided_at,
                invitationId: updated.invitation_id,
              },
              refs: invitationSubjectRefs({
                invitationId: updated.invitation_id!,
                clubId: updated.club_id,
                actorMemberId: updated.applicant_member_id,
                targetApplicationId: updated.application_id,
              }),
            });
          }

          return { responseValue: { application: mapAdminApplicationState(updated) } };
        }

        const nextPhase = input.decision === 'decline' ? 'declined' : 'banned';
        await client.query(
          `update club_applications
           set phase = $2,
               admin_note = $3,
               decided_at = now(),
               decided_by_member_id = $4,
               updated_at = now()
           where id = $1`,
          [row.application_id, nextPhase, input.adminNote ?? null, input.actorMemberId],
        );

        if (input.decision === 'ban') {
          await client.query(
            `insert into club_applicant_blocks (club_id, member_id, block_kind, created_by_member_id, reason)
             values ($1, $2, 'banned', $3, $4)
             on conflict (club_id, member_id, block_kind) do nothing`,
            [row.club_id, row.applicant_member_id, input.actorMemberId, input.adminNote ?? 'application_ban'],
          );
        }

        const updated = await readApplicationRow(client, row.application_id);
        if (!updated) {
          throw new AppError('application_update_failed', 'Updated application row was not returned.');
        }
        await acknowledgeClubadminApplicationPendingNotifications(client, {
          clubId: updated.club_id,
          applicationId: updated.application_id,
        });

        await queueApplicationNotification(client, {
          recipientMemberId: updated.applicant_member_id,
          topic: input.decision === 'decline' ? 'application.declined' : 'application.banned',
          payload: {
            applicationId: updated.application_id,
            clubId: updated.club_id,
            clubName: updated.club_name,
          },
          refs: applicationSubjectRefs({
            applicationId: updated.application_id,
            clubId: updated.club_id,
            actorMemberId: input.actorMemberId,
          }),
        });

        if (canEmitInvitationResolved(updated)) {
          await queueNotification(client, {
            clubId: updated.club_id,
            recipientMemberId: updated.sponsor_member_id!,
            topic: 'invitation.resolved',
            payload: {
              applicantName: updated.draft_name,
              clubName: updated.club_name,
              phase: updated.phase,
              resolvedAt: updated.decided_at,
              invitationId: updated.invitation_id,
            },
            refs: invitationSubjectRefs({
              invitationId: updated.invitation_id!,
              clubId: updated.club_id,
              actorMemberId: updated.applicant_member_id,
              targetApplicationId: updated.application_id,
            }),
          });
        }

        return { responseValue: { application: mapAdminApplicationState(updated) } };
      },
    });
  });
}

export async function transitionMembershipStateWithApplicationEffects(
  pool: Pool,
  input: TransitionMembershipInput,
): Promise<MembershipAdminSummary | null> {
  return transitionMembershipState(pool, input, {
    afterTransition: async (client, ctx) => {
      if (ctx.nextStatus !== 'removed' && ctx.nextStatus !== 'banned') {
        return;
      }

      await client.query(
        `update club_applications
         set phase = $2,
             decided_at = coalesce(decided_at, now()),
             decided_by_member_id = coalesce(decided_by_member_id, $3),
             updated_at = now()
         where activated_membership_id = $1`,
        [ctx.membership.membershipId, ctx.nextStatus, input.actorMemberId],
      );

      await queueNotification(client, {
        clubId: null,
        recipientMemberId: ctx.membership.member.memberId,
        topic: ctx.nextStatus === 'banned' ? 'membership.banned' : 'membership.removed',
        payload: {
          club: await resolveNotificationClubRef(client, {
            clubId: ctx.membership.clubId,
            actorMemberships: input.actorMemberships,
          }),
        },
        refs: membershipSubjectRefs({
          membershipId: ctx.membership.membershipId,
          clubId: ctx.membership.clubId,
          actorMemberId: input.actorMemberId,
        }),
      });
    },
  });
}
