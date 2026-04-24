import type { Pool } from 'pg';
import {
  AppError,
  type IssueInvitationInput,
  type ResolveInvitationTargetInput,
  type InvitationQuotaState,
  type InvitationStatus,
  type InvitationSummary,
  type ResolvedInvitationTarget,
} from '../repository.ts';
import { withTransaction, type DbClient } from '../db.ts';
import { getConfig } from '../config/index.ts';
import { normalizeEmail } from '../email.ts';
import { withIdempotency } from '../idempotency.ts';
import { deliverCoreNotifications } from '../notification-substrate.ts';
import { buildInvitationCode } from '../token.ts';

const INVITATION_CODE_UNIQUE_CONSTRAINT = 'invite_codes_code_unique';
const INVITATION_CODE_RETRY_LIMIT = 3;

type InvitationRow = {
  invitation_id: string;
  club_id: string;
  sponsor_member_id: string | null;
  sponsor_public_name: string | null;
  candidate_name: string;
  candidate_email: string;
  candidate_email_normalized: string;
  candidate_member_id: string | null;
  // How the sponsor addressed the target. Email-origin rows may still have a
  // resolved candidate_member_id for internal delivery, so sponsor-facing reads
  // must gate on target_source before surfacing that member id back out.
  target_source: 'member_id' | 'email';
  reason: string;
  delivery_kind: 'notification' | 'code';
  code: string | null;
  expires_at: string;
  expired_at: string | null;
  used_at: string | null;
  used_membership_id: string | null;
  revoked_at: string | null;
  support_withdrawn_at: string | null;
  created_at: string;
  quota_state?: InvitationQuotaState | null;
};

type InvitationTargetMemberRow = {
  member_id: string;
  public_name: string;
  email: string | null;
};

type InvitationClubNotificationRow = {
  slug: string;
  name: string;
  admission_policy: string | null;
};

type ExistingMembershipRow = {
  membership_id: string;
  club_id: string;
  member_id: string;
  role: 'clubadmin' | 'member';
  status: 'active' | 'cancelled';
  joined_at: string | null;
};

type ApplicantBlockRow = {
  block_kind: 'banned' | 'removed';
};

function assertInvitationSponsorPresent(
  row: InvitationRow,
): asserts row is InvitationRow & { sponsor_member_id: string; sponsor_public_name: string } {
  if (!row.sponsor_member_id || !row.sponsor_public_name) {
    throw new AppError('invalid_data', 'Sponsor-visible invitation is missing sponsor details.');
  }
}

function computeInvitationStatus(row: InvitationRow): InvitationStatus {
  if (row.revoked_at) return 'revoked';
  if (row.used_at) return 'used';
  if (row.expired_at || Date.parse(row.expires_at) <= Date.now()) return 'expired';
  return 'open';
}

function computeInvitationQuotaState(row: InvitationRow): InvitationQuotaState {
  const status = computeInvitationStatus(row);
  if (status === 'open') return 'counted';
  if (status === 'used') {
    if (row.support_withdrawn_at) {
      return 'free';
    }
    return row.quota_state === 'counted' ? 'counted' : 'free';
  }
  return 'free';
}

function mapInvitationSummary(row: InvitationRow): InvitationSummary {
  assertInvitationSponsorPresent(row);
  return {
    invitationId: row.invitation_id,
    clubId: row.club_id,
    candidateName: row.candidate_name,
    candidateEmail: row.candidate_email,
    // Only explicit member-id invitations echo the resolved member id back to
    // the sponsor. Email-addressed invites keep the delivery mode visible but
    // must not leak the resolved identity if the email belongs to a member.
    candidateMemberId: row.target_source === 'member_id' ? row.candidate_member_id : null,
    deliveryKind: row.delivery_kind,
    code: row.code,
    sponsor: {
      memberId: row.sponsor_member_id,
      publicName: row.sponsor_public_name,
    },
    reason: row.reason,
    status: computeInvitationStatus(row),
    quotaState: computeInvitationQuotaState(row),
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

async function readActiveMemberTarget(
  client: DbClient,
  candidateMemberId: string,
): Promise<ResolvedInvitationTarget> {
  const result = await client.query<InvitationTargetMemberRow>(
    `select id as member_id, public_name, email
     from members
     where id = $1
       and state = 'active'
     limit 1`,
    [candidateMemberId],
  );
  const row = result.rows[0];
  if (!row?.email) {
    throw new AppError('member_not_found', 'Candidate member not found or does not have a registered email address.');
  }
  return {
    kind: 'member',
    memberId: row.member_id,
    publicName: row.public_name,
    email: normalizeEmail(row.email),
    source: 'member_id',
    sponsorLabel: row.public_name,
  };
}

export async function resolveInvitationTarget(
  pool: Pool,
  input: ResolveInvitationTargetInput,
): Promise<ResolvedInvitationTarget> {
  if (input.candidateMemberId) {
    return readActiveMemberTarget(pool, input.candidateMemberId);
  }

  if (!input.candidateEmail) {
    throw new AppError('invalid_input', 'Invitation target is missing.');
  }

  const normalizedEmail = normalizeEmail(input.candidateEmail);
  const existing = await pool.query<InvitationTargetMemberRow>(
    `select id as member_id, public_name, email
     from members
     where email = $1
       and state = 'active'
     limit 1`,
    [normalizedEmail],
  );
  const existingRow = existing.rows[0];
  if (existingRow?.email) {
    return {
      kind: 'member',
      memberId: existingRow.member_id,
      publicName: existingRow.public_name,
      email: normalizeEmail(existingRow.email),
      source: 'email',
      sponsorLabel: input.candidateName?.trim() || normalizedEmail,
    };
  }

  if (!input.candidateName) {
    throw new AppError('candidate_name_required', 'candidateName is required when candidateEmail does not belong to an existing active member.');
  }

  return {
    kind: 'external_email',
    email: normalizedEmail,
    nameHint: input.candidateName,
    source: 'email',
    sponsorLabel: input.candidateName,
  };
}

async function readExistingMembership(
  client: DbClient,
  clubId: string,
  memberId: string,
): Promise<ExistingMembershipRow | null> {
  const result = await client.query<ExistingMembershipRow>(
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
  return result.rows[0] ?? null;
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

async function assertInvitationTargetCanApply(
  client: DbClient,
  input: {
    clubId: string;
    target: ResolvedInvitationTarget;
  },
): Promise<void> {
  if (input.target.kind !== 'member') {
    return;
  }

  const membership = await readExistingMembership(client, input.clubId, input.target.memberId);
  if (membership?.status === 'active') {
    throw new AppError('member_already_active', 'This member already has an active membership in the club.', {
      details: buildMembershipConflictDetails(membership),
    });
  }

  const block = await client.query<ApplicantBlockRow>(
    `select block_kind
     from club_applicant_blocks
     where club_id = $1
       and member_id = $2
     order by created_at desc
     limit 1`,
    [input.clubId, input.target.memberId],
  );
  const row = block.rows[0];
  if (row) {
    throw new AppError('application_blocked', `This member is blocked from reapplying to this club after being ${row.block_kind}.`);
  }
}

function invitationTargetKey(target: ResolvedInvitationTarget): { candidateMemberId: string | null; candidateEmail: string } {
  if (target.kind === 'member') {
    return {
      candidateMemberId: target.memberId,
      candidateEmail: target.email,
    };
  }
  return {
    candidateMemberId: null,
    candidateEmail: target.email,
  };
}

function invitationTargetName(target: ResolvedInvitationTarget): string {
  return target.sponsorLabel;
}

async function readInvitationClubNotificationData(
  client: DbClient,
  clubId: string,
): Promise<InvitationClubNotificationRow | null> {
  const result = await client.query<InvitationClubNotificationRow>(
    `select slug, name, admission_policy
     from clubs
     where id = $1
       and archived_at is null
     limit 1`,
    [clubId],
  );
  return result.rows[0] ?? null;
}

async function queueInvitationReceivedNotification(
  client: DbClient,
  input: {
    invitation: InvitationRow;
    target: Extract<ResolvedInvitationTarget, { kind: 'member' }>;
    recipientMemberId: string;
    sponsorPublicName: string;
    club: InvitationClubNotificationRow;
  },
): Promise<void> {
  await deliverCoreNotifications(client, [{
    clubId: null,
    recipientMemberId: input.recipientMemberId,
    topic: 'invitation.received',
    payloadVersion: 1,
    payload: {
      invitationId: input.invitation.invitation_id,
      deliveryKind: input.invitation.delivery_kind,
      candidateMemberId: input.target.memberId,
      candidateName: input.target.publicName,
      candidateEmail: input.target.email,
      sponsor: {
        memberId: input.invitation.sponsor_member_id,
        publicName: input.sponsorPublicName,
      },
      club: {
        clubId: input.invitation.club_id,
        slug: input.club.slug,
        name: input.club.name,
        admissionPolicy: input.club.admission_policy,
      },
      expiresAt: input.invitation.expires_at,
      createdAt: input.invitation.created_at,
      messages: {
        summary: `${input.sponsorPublicName} invited you to apply to ${input.club.name}.`,
        details: 'This is only a heads-up to apply. Because you already have a ClawClub account, no code was issued and you still go through the normal club application review flow.',
      },
      next: {
        action: 'clubs.apply',
        requiredInputs: ['clubSlug', 'invitationId', 'draft', 'clientKey'],
        reason: 'Submit a normal club application. No membership is granted until that application is accepted.',
        estimatedEffort: 'immediate',
        invitationId: input.invitation.invitation_id,
      },
    },
    refs: [
      { role: 'subject', kind: 'invitation', id: input.invitation.invitation_id },
      { role: 'club_context', kind: 'club', id: input.invitation.club_id },
      { role: 'actor', kind: 'member', id: input.invitation.sponsor_member_id! },
      { role: 'target', kind: 'member', id: input.target.memberId },
    ],
  }]);
}

async function materializeExpiredInvitation(client: DbClient, invitationId: string): Promise<void> {
  await client.query(
    `update invite_requests
     set expired_at = now()
     where id = $1
       and expired_at is null
       and expires_at <= now()
       and used_at is null`,
    [invitationId],
  );
}

async function materializeInvitationExpiryForTarget(
  client: DbClient,
  input: {
    clubId: string;
    sponsorId: string;
    target: ResolvedInvitationTarget;
  },
): Promise<void> {
  const key = invitationTargetKey(input.target);
  await client.query(
    `update invite_requests
     set expired_at = now()
     where club_id = $1
       and sponsor_member_id = $2
       and (
         ($3::short_id is not null and (candidate_member_id = $3 or candidate_email_normalized = $4))
         or ($3::short_id is null and candidate_email_normalized = $4)
       )
       and expired_at is null
       and expires_at <= now()
       and used_at is null`,
    [input.clubId, input.sponsorId, key.candidateMemberId, key.candidateEmail],
  );
}

async function readInvitationForValidation(client: DbClient, invitationId: string): Promise<InvitationRow | null> {
  await materializeExpiredInvitation(client, invitationId);
  const result = await client.query<InvitationRow>(
    `select
        ir.id as invitation_id,
        ir.club_id,
        ir.sponsor_member_id,
        sponsor.public_name as sponsor_public_name,
        ir.candidate_name,
        ir.candidate_email,
        ir.candidate_email_normalized,
        ir.candidate_member_id,
        ir.target_source,
        ir.reason,
        ir.delivery_kind::text as delivery_kind,
        ic.code,
        ir.expires_at::text as expires_at,
        ir.expired_at::text as expired_at,
        ir.used_at::text as used_at,
        ir.used_membership_id,
        ir.revoked_at::text as revoked_at,
        ir.support_withdrawn_at::text as support_withdrawn_at,
        ir.created_at::text as created_at
     from invite_requests ir
     left join invite_codes ic on ic.invite_request_id = ir.id
     -- Intentionally hide orphaned invitation rows from sponsor-facing surfaces.
     -- Sponsor-deleted invitations are preserved only for audit/history.
     join members sponsor on sponsor.id = ir.sponsor_member_id
     where ir.id = $1
     for update of ir`,
    [invitationId],
  );
  return result.rows[0] ?? null;
}

function isInvitationCodeUniqueViolation(error: unknown): boolean {
  return !!error
    && typeof error === 'object'
    && 'code' in error
    && error.code === '23505'
    && 'constraint' in error
    && error.constraint === INVITATION_CODE_UNIQUE_CONSTRAINT;
}

async function insertInvitationWithRetry(
  client: DbClient,
  input: {
    actorMemberId: string;
    clubId: string;
    target: ResolvedInvitationTarget;
    reason: string;
  },
  sponsorPublicName: string,
): Promise<InvitationRow> {
  for (let attempt = 1; attempt <= INVITATION_CODE_RETRY_LIMIT; attempt += 1) {
    const code = input.target.kind === 'external_email' ? buildInvitationCode() : null;
    const key = invitationTargetKey(input.target);
    await client.query('savepoint invite_request_insert_attempt');
    try {
      const result = await client.query<InvitationRow>(
        `insert into invite_requests (
           club_id,
           sponsor_member_id,
           candidate_name,
           candidate_email,
           candidate_member_id,
           target_source,
           reason,
           delivery_kind,
           expires_at
         )
         values ($1, $2, $3, $4, $5, $6, $7, $8, now() + interval '30 days')
         returning
           id as invitation_id,
           club_id,
           sponsor_member_id,
           $9::text as sponsor_public_name,
           candidate_name,
           candidate_email,
           candidate_email_normalized,
           candidate_member_id,
           target_source,
           reason,
           delivery_kind::text as delivery_kind,
           (select code from invite_codes where invite_request_id = invite_requests.id) as code,
           expires_at::text as expires_at,
           expired_at::text as expired_at,
           used_at::text as used_at,
           used_membership_id,
            revoked_at::text as revoked_at,
           support_withdrawn_at::text as support_withdrawn_at,
           created_at::text as created_at`,
        [
          input.clubId,
          input.actorMemberId,
          invitationTargetName(input.target),
          key.candidateEmail,
          key.candidateMemberId,
          input.target.source,
          input.reason,
          input.target.kind === 'member' ? 'notification' : 'code',
          sponsorPublicName,
        ],
      );
      const row = result.rows[0];
      if (!row) {
        throw new AppError('invitation_issue_failed', 'Failed to create invitation');
      }
      if (code) {
        await client.query(
          `insert into invite_codes (invite_request_id, code)
           values ($1, $2)`,
          [row.invitation_id, code],
        );
        row.code = code;
      }
      await client.query('release savepoint invite_request_insert_attempt');
      return row;
    } catch (error) {
      await client.query('rollback to savepoint invite_request_insert_attempt');
      await client.query('release savepoint invite_request_insert_attempt');
      if (isInvitationCodeUniqueViolation(error)) {
        if (attempt < INVITATION_CODE_RETRY_LIMIT) {
          continue;
        }
        throw new AppError('invitation_issue_failed', 'Failed to create invitation');
      }
      throw error;
    }
  }

  throw new AppError('invitation_issue_failed', 'Failed to create invitation');
}

async function readLiveInvitationForTarget(
  client: DbClient,
  input: {
    clubId: string;
    sponsorId: string;
    target: ResolvedInvitationTarget;
  },
): Promise<InvitationRow | null> {
  const key = invitationTargetKey(input.target);
  const result = await client.query<InvitationRow>(
    `select
        ir.id as invitation_id,
        ir.club_id,
        ir.sponsor_member_id,
        sponsor.public_name as sponsor_public_name,
        ir.candidate_name,
        ir.candidate_email,
        ir.candidate_email_normalized,
        ir.candidate_member_id,
        ir.target_source,
        ir.reason,
        ir.delivery_kind::text as delivery_kind,
        ic.code,
        ir.expires_at::text as expires_at,
        ir.expired_at::text as expired_at,
        ir.used_at::text as used_at,
        ir.used_membership_id,
        ir.revoked_at::text as revoked_at,
        ir.support_withdrawn_at::text as support_withdrawn_at,
        ir.created_at::text as created_at
     from invite_requests ir
     left join invite_codes ic on ic.invite_request_id = ir.id
     join members sponsor on sponsor.id = ir.sponsor_member_id
     where ir.club_id = $1
       and ir.sponsor_member_id = $2
       and (
         ($3::short_id is not null and (ir.candidate_member_id = $3 or ir.candidate_email_normalized = $4))
         or ($3::short_id is null and ir.candidate_email_normalized = $4)
       )
       and ir.revoked_at is null
       and ir.used_at is null
       and ir.expired_at is null
       and ir.expires_at > now()
     order by ir.created_at desc, ir.id desc
     limit 1`,
    [input.clubId, input.sponsorId, key.candidateMemberId, key.candidateEmail],
  );
  return result.rows[0] ?? null;
}

function throwInvitationAlreadyOpen(row: InvitationRow): never {
  throw new AppError('invitation_already_open', 'You already have an open invitation for this candidate in this club.', {
    details: {
      invitation: mapInvitationSummary(row),
    },
  });
}

async function readLiveInvitationApplicationPhase(
  client: DbClient,
  invitationId: string,
): Promise<'revision_required' | 'awaiting_review' | null> {
  const result = await client.query<{ phase: 'revision_required' | 'awaiting_review' }>(
    `select phase::text
     from club_applications
     where invitation_id = $1
       and phase in ('revision_required', 'awaiting_review')
     order by submitted_at desc, id desc
     limit 1`,
    [invitationId],
  );
  return result.rows[0]?.phase ?? null;
}

export async function issueInvitation(
  pool: Pool,
  input: IssueInvitationInput,
): Promise<{ invitation: InvitationSummary } | null> {
  const performIssue = async (client: DbClient): Promise<{ invitation: InvitationSummary } | null> => {
    const membership = await client.query<{ ok: boolean }>(
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

    await assertInvitationTargetCanApply(client, {
      clubId: input.clubId,
      target: input.target,
    });
    const sponsor = await client.query<{ public_name: string }>(
      `select public_name from members where id = $1`,
      [input.actorMemberId],
    );
    const sponsorPublicName = sponsor.rows[0]?.public_name;
    if (!sponsorPublicName) {
      throw new AppError('invalid_data', 'Missing public name for sponsoring member');
    }

    await client.query(
      `select pg_advisory_xact_lock(hashtext('invitation_issue:' || $1 || ':' || $2))`,
      [input.clubId, input.actorMemberId],
    );

    await materializeInvitationExpiryForTarget(client, {
      clubId: input.clubId,
      sponsorId: input.actorMemberId,
      target: input.target,
    });

    const existingLive = await readLiveInvitationForTarget(client, {
      clubId: input.clubId,
      sponsorId: input.actorMemberId,
      target: input.target,
    });
    if (existingLive) {
      throwInvitationAlreadyOpen(existingLive);
    }

    const quota = await client.query<{ count: string }>(
      `with open_invitations as (
         select ir.id
         from invite_requests ir
         where ir.club_id = $1
           and ir.sponsor_member_id = $2
           and ir.revoked_at is null
           and ir.used_at is null
           and ir.expired_at is null
           and ir.expires_at > now()
       ),
       live_sponsored_applications as (
         select ca.id
         from club_applications ca
         left join invite_requests ir on ir.id = ca.invitation_id
         where ca.club_id = $1
           and ca.sponsor_member_id = $2
           and ca.phase in ('revision_required', 'awaiting_review')
           and (ca.invitation_id is null or ir.support_withdrawn_at is null)
       )
       select (
         (select count(*) from open_invitations) +
         (select count(*) from live_sponsored_applications)
       )::text as count`,
      [input.clubId, input.actorMemberId],
    );
    const openInvitationCap = getConfig().policy.invitations.openPerSponsorPerClub;
    if (Number(quota.rows[0]?.count ?? 0) >= openInvitationCap) {
      throw new AppError('invitation_quota_exceeded',
        `Maximum ${openInvitationCap} live invitations per sponsor and club. An invitation counts until it is revoked, expires, or its resulting application reaches a terminal state.`,
      );
    }

    const row = await insertInvitationWithRetry(client, {
      actorMemberId: input.actorMemberId,
      clubId: input.clubId,
      target: input.target,
      reason: input.reason,
    }, sponsorPublicName);

    if (input.target.kind === 'member') {
      const club = await readInvitationClubNotificationData(client, input.clubId);
      if (club) {
        await queueInvitationReceivedNotification(client, {
          invitation: row,
          target: input.target,
          recipientMemberId: input.target.memberId,
          sponsorPublicName,
          club,
        });
      }
    }

    return {
      invitation: mapInvitationSummary(row),
    };
  };

  return withTransaction(pool, async (client) => {
    if (!input.clientKey) {
      return performIssue(client);
    }
    return withIdempotency(client, {
      clientKey: input.clientKey,
      actorContext: input.idempotencyActorContext ?? `member:${input.actorMemberId}:invitations.issue`,
      requestValue: input.idempotencyRequestValue ?? input,
      execute: async () => ({ responseValue: await performIssue(client) }),
    });
  });
}

export async function listIssuedInvitations(pool: Pool, input: {
  actorMemberId: string;
  clubId?: string;
  status?: InvitationStatus;
}): Promise<InvitationSummary[]> {
  const result = await pool.query<InvitationRow>(
    `select
        ir.id as invitation_id,
        ir.club_id,
        ir.sponsor_member_id,
        sponsor.public_name as sponsor_public_name,
        ir.candidate_name,
        ir.candidate_email,
        ir.candidate_email_normalized,
        ir.candidate_member_id,
        ir.target_source,
        ir.reason,
        ir.delivery_kind::text as delivery_kind,
        ic.code,
        ir.expires_at::text as expires_at,
        ir.expired_at::text as expired_at,
        ir.used_at::text as used_at,
        ir.used_membership_id,
        ir.revoked_at::text as revoked_at,
        ir.support_withdrawn_at::text as support_withdrawn_at,
        ir.created_at::text as created_at,
        case
          when ir.revoked_at is not null then 'free'
          when ir.used_at is null and (ir.expired_at is null and ir.expires_at > now()) then 'counted'
          when ir.support_withdrawn_at is not null then 'free'
          when live_app.id is not null then 'counted'
          else 'free'
        end as quota_state
     from invite_requests ir
     left join invite_codes ic on ic.invite_request_id = ir.id
     -- Intentionally sponsor-scoped. Rows whose sponsor was hard-deleted remain in
     -- storage for audit/history but should not reappear in normal invitation UIs.
     join members sponsor on sponsor.id = ir.sponsor_member_id
     left join club_applications live_app
       on live_app.invitation_id = ir.id
      and live_app.phase in ('revision_required', 'awaiting_review')
     where ir.sponsor_member_id = $1
       and ($2::short_id is null or ir.club_id = $2)
     order by ir.created_at desc, ir.id desc`,
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

    const actorIsSponsor = invitation.sponsor_member_id === input.actorMemberId;
    const actorIsClubAdmin = (input.adminClubIds ?? []).includes(invitation.club_id);
    const allowed = actorIsSponsor || actorIsClubAdmin;
    if (!allowed) {
      throw new AppError('forbidden',
        'You may only revoke your own invitations or invitations in clubs you administer',
      );
    }

    if (invitation.used_at) {
      const livePhase = await readLiveInvitationApplicationPhase(client, invitation.invitation_id);
      if (!livePhase) {
        throw new AppError('invalid_state', 'Used invitations cannot be changed after the resulting application becomes terminal.');
      }
      if (!actorIsSponsor) {
        throw new AppError('forbidden', 'Only the original sponsor may withdraw support after the invitation has already been consumed into a live application.');
      }
      if (invitation.support_withdrawn_at) {
        return mapInvitationSummary(invitation);
      }
      const updated = await client.query<InvitationRow>(
        `update invite_requests
         set support_withdrawn_at = now()
         where id = $1
         returning
           id as invitation_id,
           club_id,
           sponsor_member_id,
           $2::text as sponsor_public_name,
           candidate_name,
           candidate_email,
           candidate_email_normalized,
           candidate_member_id,
           target_source,
           reason,
           delivery_kind::text as delivery_kind,
           (select code from invite_codes where invite_request_id = invite_requests.id) as code,
           expires_at::text as expires_at,
           expired_at::text as expired_at,
           used_at::text as used_at,
           used_membership_id,
           revoked_at::text as revoked_at,
           support_withdrawn_at::text as support_withdrawn_at,
           created_at::text as created_at`,
        [input.invitationId, invitation.sponsor_public_name],
      );
      return updated.rows[0] ? mapInvitationSummary(updated.rows[0]) : mapInvitationSummary(invitation);
    }
    if (invitation.revoked_at) {
      throw new AppError('invitation_already_revoked', 'Invitation is already revoked.', {
        details: { invitation: mapInvitationSummary(invitation) },
      });
    }
    if (invitation.expired_at || Date.parse(invitation.expires_at) <= Date.now()) {
      throw new AppError('invitation_already_expired', 'Invitation is already expired.', {
        details: { invitation: mapInvitationSummary(invitation) },
      });
    }

    const updated = await client.query<InvitationRow>(
      `update invite_requests
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
         candidate_member_id,
         target_source,
         reason,
         delivery_kind::text as delivery_kind,
         (select code from invite_codes where invite_request_id = invite_requests.id) as code,
         expires_at::text as expires_at,
         expired_at::text as expired_at,
         used_at::text as used_at,
         used_membership_id,
         revoked_at::text as revoked_at,
         support_withdrawn_at::text as support_withdrawn_at,
         created_at::text as created_at`,
      [input.invitationId, invitation.sponsor_public_name],
    );
    return updated.rows[0] ? mapInvitationSummary(updated.rows[0]) : mapInvitationSummary(invitation);
  });
}
