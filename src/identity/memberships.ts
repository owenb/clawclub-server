/**
 * Identity domain — membership management.
 *
 * Club memberships, state transitions, member listings, promote/demote.
 */

import type { Pool } from 'pg';
import {
  AppError,
  type AdminMemberSummary,
  type ClubProfileFields,
  type ClubProfileLink,
  type CreateMembershipInput,
  type CreatedBearerToken,
  type MemberRef,
  type MembershipAdminSummary,
  type MembershipState,
  type MembershipSummary,
  type PublicMemberSummary,
  type TransitionMembershipInput,
  type UpdateMembershipInput,
} from '../repository.ts';
import {
  matchesPgCheckConstraint,
  matchesPgConstraint,
  translate23505,
  withTransaction,
  type DbClient,
} from '../db.ts';
import { getConfig } from '../config/index.ts';
import { EMAIL_ALREADY_REGISTERED_MESSAGE, isMembersEmailUniqueViolation, normalizeEmail } from '../email.ts';
import { encodeCursor } from '../schemas/fields.ts';
import { buildSecondClubWelcome } from '../clubs/welcome.ts';
import { appendClubActivity } from '../clubs/content.ts';
import { deliverCoreNotifications, type NotificationRefInput } from '../notification-substrate.ts';
import { throwSecretReplayUnavailable, withIdempotency } from '../idempotency.ts';
import { assertCanApplyToClub, writeApplicantBlock } from '../application-policy.ts';
import { createInitialClubProfileVersion, emptyClubProfileFields } from './profiles.ts';
import { createBearerTokenInDb } from './tokens.ts';

type MembershipAdminRow = {
  membership_id: string;
  club_id: string;
  member_id: string;
  public_name: string;
  sponsor_member_id: string | null;
  sponsor_public_name: string | null;
  role: MembershipSummary['role'];
  is_owner: boolean;
  status: MembershipState;
  state_reason: string | null;
  state_version_no: number;
  state_created_at: string;
  state_created_by_member_id: string | null;
  state_created_by_member_public_name: string | null;
  joined_at: string | null;
  accepted_covenant_at: string | null;
  metadata: Record<string, unknown> | null;
};

type PublicMemberRow = {
  membership_id: string;
  club_id: string;
  member_id: string;
  public_name: string;
  display_name: string;
  tagline: string | null;
  summary: string | null;
  what_i_do: string | null;
  known_for: string | null;
  services_summary: string | null;
  website_url: string | null;
  links: ClubProfileLink[] | null;
  role: MembershipSummary['role'];
  is_owner: boolean;
  joined_at: string;
  sponsor_member_id: string | null;
  sponsor_public_name: string | null;
};

type AdminMemberRow = PublicMemberRow & {
  accepted_covenant_at: string | null;
  left_at: string | null;
  status: MembershipState;
  state_reason: string | null;
  state_version_no: number;
  state_created_at: string;
  state_created_by_member_id: string | null;
  state_created_by_member_public_name: string | null;
};

type NotificationClubRef = {
  clubId: string;
  slug: string;
  name: string;
};

type ActivationFanoutRow = {
  membership_id: string;
  club_id: string;
  club_slug: string;
  club_name: string;
  club_summary: string | null;
  member_id: string;
  member_public_name: string;
  member_display_name: string;
  sponsor_member_id: string | null;
  sponsor_public_name: string | null;
  invitation_id: string | null;
  invitation_sponsor_member_id: string | null;
  joined_at: string | null;
};

function buildMembershipAlreadyActiveDetails(input: {
  clubId: string;
  memberId: string;
}): Record<string, unknown> {
  return {
    membership: {
      clubId: input.clubId,
      memberId: input.memberId,
    },
  };
}

const ADMIN_VALID_TRANSITIONS: Record<MembershipState, readonly MembershipState[]> = {
  active: ['cancelled', 'removed', 'banned'],
  cancelled: ['removed', 'banned'],
  removed: [],
  banned: [],
};

function assertAdminTransitionAllowed(
  currentStatus: MembershipState,
  nextStatus: MembershipState,
  options: { actorIsSuperadmin?: boolean } = {},
): void {
  if (options.actorIsSuperadmin && nextStatus === 'active' && (currentStatus === 'removed' || currentStatus === 'banned')) {
    return;
  }

  const allowedNextStates = ADMIN_VALID_TRANSITIONS[currentStatus];
  if (allowedNextStates.includes(nextStatus)) {
    return;
  }

  if (allowedNextStates.length === 0) {
    throw new AppError('invalid_state_transition',
      `Cannot transition membership from '${currentStatus}' to '${nextStatus}' via clubadmin.members.update. Memberships in state '${currentStatus}' cannot be changed through this surface.`,
    );
  }

  throw new AppError('invalid_state_transition',
    `Cannot transition membership from '${currentStatus}' to '${nextStatus}' via clubadmin.members.update. Legal next states from '${currentStatus}' are: ${allowedNextStates.join(', ')}.`,
  );
}

async function assertAdminStatusChangeAllowed(client: DbClient, input: {
  clubId: string;
  memberId: string;
  actorMemberId: string;
  actorIsSuperadmin?: boolean;
  currentStatus: MembershipState;
  nextStatus: MembershipState;
}): Promise<void> {
  if (input.memberId === input.actorMemberId && input.nextStatus !== 'active' && input.nextStatus !== input.currentStatus) {
    throw new AppError('forbidden_role', 'Admins may not self-revoke or self-reject through this surface');
  }

  if (input.nextStatus !== 'active') {
    const ownerResult = await client.query<{ owner_member_id: string | null }>(
      `select owner_member_id from clubs where id = $1 for update`,
      [input.clubId],
    );
    if (ownerResult.rows[0]?.owner_member_id === input.memberId) {
      throw new AppError('forbidden_role', 'Cannot demote the club owner');
    }
  }

  assertAdminTransitionAllowed(input.currentStatus, input.nextStatus, {
    actorIsSuperadmin: input.actorIsSuperadmin,
  });
}

function mapMembershipRow(row: MembershipAdminRow): MembershipAdminSummary {
  return {
    membershipId: row.membership_id,
    clubId: row.club_id,
    member: { memberId: row.member_id, publicName: row.public_name },
    sponsor: row.sponsor_member_id
      ? { memberId: row.sponsor_member_id, publicName: row.sponsor_public_name as string }
      : null,
    role: row.role,
    isOwner: row.is_owner,
    version: {
      no: Number(row.state_version_no),
      status: row.status,
      reason: row.state_reason,
      createdAt: row.state_created_at,
      createdByMember: row.state_created_by_member_id
        ? {
          memberId: row.state_created_by_member_id,
          publicName: row.state_created_by_member_public_name as string,
        }
        : null,
    },
    joinedAt: row.joined_at,
    acceptedCovenantAt: row.accepted_covenant_at,
    metadata: row.metadata ?? {},
  };
}

function mapPublicMemberRow(row: PublicMemberRow): PublicMemberSummary {
  return {
    membershipId: row.membership_id,
    memberId: row.member_id,
    publicName: row.public_name,
    tagline: row.tagline,
    summary: row.summary,
    whatIDo: row.what_i_do,
    knownFor: row.known_for,
    servicesSummary: row.services_summary,
    websiteUrl: row.website_url,
    links: row.links ?? [],
    role: row.role,
    isOwner: row.is_owner,
    joinedAt: row.joined_at,
    sponsor: row.sponsor_member_id
      ? { memberId: row.sponsor_member_id, publicName: row.sponsor_public_name as string }
      : null,
    vouches: [],
  };
}

function mapAdminMemberRow(row: AdminMemberRow): AdminMemberSummary {
  return {
    ...mapPublicMemberRow(row),
    acceptedCovenantAt: row.accepted_covenant_at,
    leftAt: row.left_at,
    version: {
      no: Number(row.state_version_no),
      status: row.status,
      reason: row.state_reason,
      createdAt: row.state_created_at,
      createdByMember: row.state_created_by_member_id
        ? {
          memberId: row.state_created_by_member_id,
          publicName: row.state_created_by_member_public_name as string,
        }
        : null,
    },
  };
}

const MEMBERSHIP_SELECT = `
  cnm.id as membership_id, cnm.club_id, cnm.member_id,
  m.public_name,
  cnm.sponsor_member_id,
  sponsor.public_name as sponsor_public_name,
  cnm.role,
  (n.owner_member_id = cnm.member_id) as is_owner,
  cnm.status, cnm.state_reason, cnm.state_version_no,
  cnm.state_created_at::text as state_created_at,
  cnm.state_created_by_member_id,
  state_creator.public_name as state_created_by_member_public_name,
  cnm.joined_at::text as joined_at,
  cnm.accepted_covenant_at::text as accepted_covenant_at,
  cnm.metadata
`;

const MEMBERSHIP_FROM = `
  from current_club_memberships cnm
  join members m on m.id = cnm.member_id
  join clubs n on n.id = cnm.club_id
  left join members sponsor on sponsor.id = cnm.sponsor_member_id
  left join members state_creator on state_creator.id = cnm.state_created_by_member_id
`;

async function readMembershipSummary(client: DbClient, membershipId: string): Promise<MembershipAdminSummary | null> {
  const result = await client.query<MembershipAdminRow>(
    `select ${MEMBERSHIP_SELECT} ${MEMBERSHIP_FROM} where cnm.id = $1 limit 1`,
    [membershipId],
  );
  return result.rows[0] ? mapMembershipRow(result.rows[0]) : null;
}

async function clearApplicantBlock(client: DbClient, input: {
  clubId: string;
  memberId: string;
}): Promise<void> {
  await client.query(
    `delete from club_applicant_blocks
     where club_id = $1
       and member_id = $2`,
    [input.clubId, input.memberId],
  );
}

async function revokeOpenInvitesFromSponsorInClub(client: DbClient, input: {
  sponsorMemberId: string;
  clubId: string;
}): Promise<void> {
  await client.query(
    `update invite_requests
       set revoked_at = coalesce(revoked_at, now())
     where sponsor_member_id = $1
       and club_id = $2
       and revoked_at is null
       and used_at is null`,
    [input.sponsorMemberId, input.clubId],
  );
}

async function isClubAdmin(client: DbClient, memberId: string, clubId: string): Promise<boolean> {
  const result = await client.query<{ ok: boolean }>(
    `select exists(
       select 1 from current_club_memberships
       where club_id = $1 and member_id = $2 and role = 'clubadmin'
     ) as ok`,
    [clubId, memberId],
  );
  return result.rows[0]?.ok === true;
}

async function assertNoLiveMembership(client: DbClient, input: {
  clubId: string;
  memberId: string;
}): Promise<void> {
  const existing = await client.query<{ ok: boolean }>(
    `select exists(
       select 1
       from current_club_memberships
       where club_id = $1
         and member_id = $2
         and left_at is null
     ) as ok`,
    [input.clubId, input.memberId],
  );
  if (existing.rows[0]?.ok) {
    throw new AppError('membership_exists', 'This member already has a membership record in the club');
  }
}

export async function assertClubHasCapacity(client: DbClient, input: {
  clubId: string;
  reserveSlots?: number;
}): Promise<void> {
  await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [`club-capacity:${input.clubId}`]);
  const result = await client.query<{
    uses_free_allowance: boolean;
    member_cap: number | null;
    active_count: number;
  }>(
    `select
        c.uses_free_allowance,
        c.member_cap,
        (
          select count(*)::int
          from current_club_memberships cm
          where cm.club_id = c.id
            and cm.status = 'active'
            and cm.left_at is null
        ) as active_count
     from clubs c
     where c.id = $1
     limit 1`,
    [input.clubId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new AppError('club_not_found', 'Club not found');
  }

  const effectiveCap = row.uses_free_allowance
    ? getConfig().policy.clubs.freeClubMemberCap
    : row.member_cap;
  if (effectiveCap === null) {
    return;
  }

  const reserveSlots = input.reserveSlots ?? 1;
  if (row.active_count + reserveSlots > effectiveCap) {
    throw new AppError('member_cap_reached', 'This club has reached its member cap.');
  }
}

export async function syncMembershipRole(client: DbClient, membershipId: string, role: MembershipSummary['role']): Promise<void> {
  await client.query(`select set_config('app.allow_membership_role_sync', '1', true)`);
  await client.query(
    `update club_memberships
        set role = $2::membership_role
     where id = $1`,
    [membershipId, role],
  );
  await client.query(`select set_config('app.allow_membership_role_sync', '', true)`);
}

async function ensureProfileVersionForActiveMembership(client: DbClient, input: {
  membershipId: string;
  memberId: string;
  clubId: string;
  creatorMemberId: string | null;
}): Promise<void> {
  const existing = await client.query<{ ok: boolean }>(
    `select exists(
       select 1
       from current_member_club_profiles
       where membership_id = $1
     ) as ok`,
    [input.membershipId],
  );
  if (existing.rows[0]?.ok) {
    return;
  }

  await createInitialClubProfileVersion(client, {
    membershipId: input.membershipId,
    memberId: input.memberId,
    clubId: input.clubId,
    fields: emptyClubProfileFields(),
    creatorMemberId: input.creatorMemberId,
    generationSource: 'membership_seed',
  });
}

async function readActivationFanoutRow(client: DbClient, membershipId: string): Promise<ActivationFanoutRow | null> {
  const result = await client.query<ActivationFanoutRow>(
    `select
        cm.id as membership_id,
        cm.club_id,
        c.slug as club_slug,
        c.name as club_name,
        c.summary as club_summary,
        cm.member_id,
        m.public_name as member_public_name,
        m.display_name as member_display_name,
        cm.sponsor_member_id,
        sponsor.public_name as sponsor_public_name,
        cm.invitation_id,
        i.sponsor_member_id as invitation_sponsor_member_id,
        cm.joined_at::text as joined_at
     from current_club_memberships cm
     join clubs c on c.id = cm.club_id
     join members m on m.id = cm.member_id
     left join members sponsor on sponsor.id = cm.sponsor_member_id
     left join invite_requests i on i.id = cm.invitation_id
     where cm.id = $1
     limit 1`,
    [membershipId],
  );
  return result.rows[0] ?? null;
}

async function insertInvitationResolvedNotification(client: DbClient, row: ActivationFanoutRow): Promise<void> {
  if (!row.invitation_id || !row.invitation_sponsor_member_id) {
    return;
  }
  await deliverCoreNotifications(client, [{
    clubId: row.club_id,
    recipientMemberId: row.invitation_sponsor_member_id,
    topic: 'invitation.resolved',
    payloadVersion: 1,
    payload: {
      invitationId: row.invitation_id,
      clubName: row.club_name,
      applicantName: row.member_public_name,
      phase: 'active',
      resolvedAt: row.joined_at,
    },
    refs: [
      { role: 'subject', kind: 'invitation', id: row.invitation_id },
      { role: 'club_context', kind: 'club', id: row.club_id },
      { role: 'actor', kind: 'member', id: row.member_id },
    ],
  }]);
}

async function insertMembershipActivatedNotification(client: DbClient, row: ActivationFanoutRow): Promise<void> {
  const refs: NotificationRefInput[] = [
    { role: 'subject', kind: 'membership', id: row.membership_id },
    { role: 'club_context', kind: 'club', id: row.club_id },
  ];
  if (row.sponsor_member_id) {
    refs.push({ role: 'actor', kind: 'member', id: row.sponsor_member_id });
  }

  await deliverCoreNotifications(client, [{
    clubId: row.club_id,
    recipientMemberId: row.member_id,
    topic: 'membership.activated',
    payloadVersion: 1,
    payload: {
      clubId: row.club_id,
      clubName: row.club_name,
      summary: row.club_summary,
      ...(row.sponsor_member_id ? { sponsorId: row.sponsor_member_id } : {}),
      ...(row.sponsor_public_name ? { sponsorPublicName: row.sponsor_public_name } : {}),
      welcome: buildSecondClubWelcome({
        clubName: row.club_name,
        memberName: row.member_display_name,
        sponsorPublicName: row.sponsor_public_name,
      }),
    },
    refs,
  }]);
}

async function insertMembershipActivatedActivity(client: DbClient, row: ActivationFanoutRow, actorMemberId: string): Promise<void> {
  await appendClubActivity(client, {
    clubId: row.club_id,
    topic: 'membership.activated',
    creatorMemberId: actorMemberId,
    audience: 'clubadmins',
    payload: {
      publicName: row.member_public_name,
    },
  });
}

async function applyMembershipApplicationEffects(client: DbClient, input: {
  membershipId: string;
  clubId: string;
  memberId: string;
  nextStatus: 'removed' | 'banned';
  actorMemberId: string;
  actorMemberships?: Array<{ clubId: string; slug: string; name: string }>;
}): Promise<void> {
  const club = await resolveNotificationClubRef(client, {
    clubId: input.clubId,
    actorMemberships: input.actorMemberships,
  });
  await client.query(
    `update club_applications
       set phase = $2,
           decided_at = coalesce(decided_at, now()),
           decided_by_member_id = coalesce(decided_by_member_id, $3),
           updated_at = now()
     where activated_membership_id = $1`,
    [input.membershipId, input.nextStatus, input.actorMemberId],
  );
  await deliverCoreNotifications(client, [{
    clubId: null,
    recipientMemberId: input.memberId,
    topic: input.nextStatus === 'banned' ? 'membership.banned' : 'membership.removed',
    payloadVersion: 1,
    payload: {
      club,
    },
    refs: [
      { role: 'subject', kind: 'membership', id: input.membershipId },
      { role: 'club_context', kind: 'club', id: input.clubId },
      { role: 'actor', kind: 'member', id: input.actorMemberId },
    ],
  }]);
}

export async function resolveNotificationClubRef(client: DbClient, input: {
  clubId: string;
  actorMemberships?: Array<{ clubId: string; slug: string; name: string }>;
}): Promise<NotificationClubRef> {
  const fromActor = input.actorMemberships?.find((membership) => membership.clubId === input.clubId);
  if (fromActor) {
    return {
      clubId: fromActor.clubId,
      slug: fromActor.slug,
      name: fromActor.name,
    };
  }

  const result = await client.query<{ slug: string; name: string }>(
    `select slug, name from clubs where id = $1 limit 1`,
    [input.clubId],
  );
  const club = result.rows[0];
  if (!club) {
    throw new AppError('missing_row', 'Club could not be reloaded for the notification payload');
  }
  return {
    clubId: input.clubId,
    slug: club.slug,
    name: club.name,
  };
}

async function applyActivationFanout(client: DbClient, membershipId: string, options: {
  wasFirstActivation: boolean;
  actorMemberId: string;
}): Promise<void> {
  const row = await readActivationFanoutRow(client, membershipId);
  if (!row) {
    return;
  }

  await insertMembershipActivatedActivity(client, row, options.actorMemberId);
  if (!options.wasFirstActivation) {
    return;
  }

  await insertInvitationResolvedNotification(client, row);
  await insertMembershipActivatedNotification(client, row);
}

export async function createMembershipInTransaction(client: DbClient, input: CreateMembershipInput): Promise<MembershipAdminSummary | null> {
  if (!input.skipClubAdminCheck && !(await isClubAdmin(client, input.actorMemberId, input.clubId))) return null;

  if (input.sponsorId && (input.skipClubAdminCheck || input.sponsorId !== input.actorMemberId)) {
    const sponsorCheck = await client.query<{ id: string }>(
      `select cnm.id from current_club_memberships cnm
       where cnm.club_id = $1 and cnm.member_id = $2 and cnm.status = 'active' limit 1`,
      [input.clubId, input.sponsorId],
    );
    if (!sponsorCheck.rows[0]) return null;
  }

  await assertNoLiveMembership(client, {
    clubId: input.clubId,
    memberId: input.memberId,
  });

  if (input.initialStatus === 'active') {
    await assertClubHasCapacity(client, { clubId: input.clubId });
  }

  let membershipResult;
  try {
    membershipResult = await client.query<{ id: string }>(
      `insert into club_memberships (club_id, member_id, sponsor_member_id, role, status, joined_at, metadata)
       select $1::short_id, $6::short_id, $2::short_id, $3::membership_role, $4::membership_state,
              case when $4::membership_state = 'active' then now() else null end,
              $5::jsonb
       where exists (select 1 from members where id = $6::short_id and state = 'active')
      returning id`,
      [input.clubId, input.sponsorId, input.role, input.initialStatus, JSON.stringify(input.metadata ?? {}), input.memberId],
    );
  } catch (error) {
    if (matchesPgConstraint(error, 'club_memberships_non_terminal_unique')) {
      throw new AppError('member_already_active', 'This member already has an active membership in the club.', {
        details: buildMembershipAlreadyActiveDetails({
          clubId: input.clubId,
          memberId: input.memberId,
        }),
      });
    }
    if (matchesPgCheckConstraint(error, 'short_id_check')) {
      throw new AppError('invalid_input', 'Resource id is not a valid ClawClub short_id.', { cause: error });
    }
    throw error;
  }

  const membershipId = membershipResult.rows[0]?.id ?? null;
  if (!membershipId) return null;

  await client.query(
    `insert into club_membership_state_versions (membership_id, status, reason, version_no, created_by_member_id)
     values ($1, $2, $3, 1, $4)`,
    [membershipId, input.initialStatus, input.reason ?? null, input.actorMemberId],
  );

  if (input.initialStatus === 'active') {
    await createInitialClubProfileVersion(client, {
      membershipId,
      memberId: input.memberId,
      clubId: input.clubId,
      fields: input.initialProfile.fields,
      creatorMemberId: input.actorMemberId,
      generationSource: input.initialProfile.generationSource,
    });
    await applyActivationFanout(client, membershipId, {
      wasFirstActivation: true,
      actorMemberId: input.actorMemberId,
    });
  }

  return readMembershipSummary(client, membershipId);
}

export async function reactivateCancelledMembershipInTransaction(client: DbClient, input: {
  actorMemberId: string;
  clubId: string;
  memberId: string;
  reason?: string | null;
}): Promise<MembershipAdminSummary | null> {
  const membershipResult = await client.query<{
    membership_id: string;
    current_status: MembershipState;
    current_version_no: number;
    current_state_version_id: string;
    current_joined_at: string | null;
  }>(
    `select cnm.id as membership_id,
            cnm.status as current_status,
            cnm.state_version_no as current_version_no,
            cnm.state_version_id as current_state_version_id,
            cnm.joined_at::text as current_joined_at
       from current_club_memberships cnm
      where cnm.club_id = $1
        and cnm.member_id = $2
      limit 1`,
    [input.clubId, input.memberId],
  );

  const membership = membershipResult.rows[0];
  if (!membership) {
    return null;
  }
  if (membership.current_status === 'active') {
    throw new AppError('member_already_active', 'This member already has an active membership in the club.', {
      details: buildMembershipAlreadyActiveDetails({
        clubId: input.clubId,
        memberId: input.memberId,
      }),
    });
  }
  if (membership.current_status !== 'cancelled') {
    return null;
  }

  await assertClubHasCapacity(client, { clubId: input.clubId });

  try {
    await client.query(
      `insert into club_membership_state_versions
       (membership_id, status, reason, version_no, supersedes_state_version_id, created_by_member_id)
       values ($1, 'active', $2, $3, $4, $5)`,
      [
        membership.membership_id,
        input.reason ?? null,
        Number(membership.current_version_no) + 1,
        membership.current_state_version_id,
        input.actorMemberId,
      ],
    );
  } catch (error) {
    translate23505(error, 'club_membership_state_versions_version_unique', 'version_conflict');
    throw error;
  }

  await applyActivationFanout(client, membership.membership_id, {
    wasFirstActivation: membership.current_joined_at === null,
    actorMemberId: input.actorMemberId,
  });
  await ensureProfileVersionForActiveMembership(client, {
    membershipId: membership.membership_id,
    memberId: input.memberId,
    clubId: input.clubId,
    creatorMemberId: input.actorMemberId,
  });

  return readMembershipSummary(client, membership.membership_id);
}

// ── Exported functions ────────────────────────────────────────

export async function listMembers(pool: Pool, input: {
  clubId: string;
  limit: number;
  cursor?: { joinedAt: string; membershipId: string } | null;
}): Promise<{ results: PublicMemberSummary[]; hasMore: boolean; nextCursor: string | null }> {
  const fetchLimit = input.limit + 1;
  const cursorJoinedAt = input.cursor?.joinedAt ?? null;
  const cursorMembershipId = input.cursor?.membershipId ?? null;

  const result = await pool.query<PublicMemberRow>(
    `select
       acm.id as membership_id,
       acm.club_id,
       acm.member_id,
       m.public_name,
       m.display_name,
       cmp.tagline,
       cmp.summary,
       cmp.what_i_do,
       cmp.known_for,
       cmp.services_summary,
       cmp.website_url,
       cmp.links,
       acm.role,
       (c.owner_member_id = acm.member_id) as is_owner,
       acm.joined_at::text as joined_at,
       acm.sponsor_member_id,
       sponsor.public_name as sponsor_public_name
     from accessible_club_memberships acm
     join members m on m.id = acm.member_id and m.state = 'active'
     join clubs c on c.id = acm.club_id and c.archived_at is null
     join current_member_club_profiles cmp on cmp.member_id = acm.member_id and cmp.club_id = acm.club_id
     left join members sponsor on sponsor.id = acm.sponsor_member_id
     where acm.club_id = $1
       and ($3::timestamptz is null
         or acm.joined_at < $3
         or (acm.joined_at = $3 and acm.id < $4))
     order by acm.joined_at desc, acm.id desc
     limit $2`,
    [input.clubId, fetchLimit, cursorJoinedAt, cursorMembershipId],
  );

  const rows = result.rows.map(mapPublicMemberRow);
  const hasMore = rows.length > input.limit;
  if (hasMore) rows.pop();
  const last = rows[rows.length - 1];
  const nextCursor = last ? encodeCursor([last.joinedAt, last.membershipId]) : null;
  return { results: rows, hasMore, nextCursor };
}

export async function getMember(pool: Pool, input: {
  clubId: string;
  memberId: string;
}): Promise<PublicMemberSummary | null> {
  const result = await pool.query<PublicMemberRow>(
    `select
       acm.id as membership_id,
       acm.club_id,
       acm.member_id,
       m.public_name,
       m.display_name,
       cmp.tagline,
       cmp.summary,
       cmp.what_i_do,
       cmp.known_for,
       cmp.services_summary,
       cmp.website_url,
       cmp.links,
       acm.role,
       (c.owner_member_id = acm.member_id) as is_owner,
       acm.joined_at::text as joined_at,
       acm.sponsor_member_id,
       sponsor.public_name as sponsor_public_name
     from accessible_club_memberships acm
     join members m on m.id = acm.member_id and m.state = 'active'
     join clubs c on c.id = acm.club_id and c.archived_at is null
     join current_member_club_profiles cmp on cmp.member_id = acm.member_id and cmp.club_id = acm.club_id
     left join members sponsor on sponsor.id = acm.sponsor_member_id
     where acm.club_id = $1
       and acm.member_id = $2
     limit 1`,
    [input.clubId, input.memberId],
  );
  return result.rows[0] ? mapPublicMemberRow(result.rows[0]) : null;
}

export async function listAdminMembers(pool: Pool, input: {
  clubId: string;
  limit: number;
  statuses?: MembershipState[] | null;
  roles?: Array<'clubadmin' | 'member'> | null;
  cursor?: { joinedAt: string; membershipId: string } | null;
}): Promise<{ results: AdminMemberSummary[]; hasMore: boolean; nextCursor: string | null }> {
  const fetchLimit = input.limit + 1;
  const cursorJoinedAt = input.cursor?.joinedAt ?? null;
  const cursorMembershipId = input.cursor?.membershipId ?? null;

  const result = await pool.query<AdminMemberRow>(
    `select
       cm.id as membership_id,
       cm.club_id,
       cm.member_id,
       m.public_name,
       m.display_name,
       cmp.tagline,
       cmp.summary,
       cmp.what_i_do,
       cmp.known_for,
       cmp.services_summary,
       cmp.website_url,
       cmp.links,
       cm.role,
       (c.owner_member_id = cm.member_id) as is_owner,
       cm.joined_at::text as joined_at,
       cm.sponsor_member_id,
       sponsor.public_name as sponsor_public_name,
       cm.accepted_covenant_at::text as accepted_covenant_at,
       cm.left_at::text as left_at,
       cm.status,
       cm.state_reason,
       cm.state_version_no,
       cm.state_created_at::text as state_created_at,
       cm.state_created_by_member_id,
       state_creator.public_name as state_created_by_member_public_name
     from current_club_memberships cm
     join members m on m.id = cm.member_id and m.state = 'active'
     join clubs c on c.id = cm.club_id and c.archived_at is null
     join current_member_club_profiles cmp on cmp.member_id = cm.member_id and cmp.club_id = cm.club_id
     left join members sponsor on sponsor.id = cm.sponsor_member_id
     left join members state_creator on state_creator.id = cm.state_created_by_member_id
     where cm.club_id = $1
       and cm.status = any(coalesce($3::membership_state[], array['active','cancelled']::membership_state[]))
       and ($4::membership_role[] is null or cm.role = any($4))
       and ($5::timestamptz is null
         or cm.joined_at < $5
         or (cm.joined_at = $5 and cm.id < $6))
     order by cm.joined_at desc, cm.id desc
     limit $2`,
    [input.clubId, fetchLimit, input.statuses ?? null, input.roles ?? null, cursorJoinedAt, cursorMembershipId],
  );

  const rows = result.rows.map(mapAdminMemberRow);
  const hasMore = rows.length > input.limit;
  if (hasMore) rows.pop();
  const last = rows[rows.length - 1];
  const nextCursor = last ? encodeCursor([last.joinedAt, last.membershipId]) : null;
  return { results: rows, hasMore, nextCursor };
}

export async function getAdminMember(pool: Pool, input: {
  clubId: string;
  memberId: string;
}): Promise<AdminMemberSummary | null> {
  const result = await pool.query<AdminMemberRow>(
    `select
       cm.id as membership_id,
       cm.club_id,
       cm.member_id,
       m.public_name,
       m.display_name,
       cmp.tagline,
       cmp.summary,
       cmp.what_i_do,
       cmp.known_for,
       cmp.services_summary,
       cmp.website_url,
       cmp.links,
       cm.role,
       (c.owner_member_id = cm.member_id) as is_owner,
       cm.joined_at::text as joined_at,
       cm.sponsor_member_id,
       sponsor.public_name as sponsor_public_name,
       cm.accepted_covenant_at::text as accepted_covenant_at,
       cm.left_at::text as left_at,
       cm.status,
       cm.state_reason,
       cm.state_version_no,
       cm.state_created_at::text as state_created_at,
       cm.state_created_by_member_id,
       state_creator.public_name as state_created_by_member_public_name
     from current_club_memberships cm
     join members m on m.id = cm.member_id and m.state = 'active'
     join clubs c on c.id = cm.club_id and c.archived_at is null
     join current_member_club_profiles cmp on cmp.member_id = cm.member_id and cmp.club_id = cm.club_id
     left join members sponsor on sponsor.id = cm.sponsor_member_id
     left join members state_creator on state_creator.id = cm.state_created_by_member_id
     where cm.club_id = $1
       and cm.member_id = $2
     limit 1`,
    [input.clubId, input.memberId],
  );
  return result.rows[0] ? mapAdminMemberRow(result.rows[0]) : null;
}

export async function createMembership(pool: Pool, input: CreateMembershipInput): Promise<MembershipAdminSummary | null> {
  return withTransaction(pool, async (client) => {
    return createMembershipInTransaction(client, input);
  });
}

type TransitionMembershipOptions = {
  afterTransition?: (
    client: DbClient,
    ctx: {
      membership: MembershipAdminSummary;
      previousStatus: MembershipState;
      nextStatus: MembershipState;
    },
  ) => Promise<void>;
};

export async function transitionMembershipState(
  pool: Pool,
  input: TransitionMembershipInput,
  options: TransitionMembershipOptions = {},
): Promise<MembershipAdminSummary | null> {
  return withTransaction(pool, async (client) => {
    const membershipResult = await client.query<{
      membership_id: string; club_id: string; member_id: string;
      current_status: MembershipState; current_version_no: number; current_state_version_id: string; current_joined_at: string | null;
    }>(
      `select cnm.id as membership_id, cnm.club_id, cnm.member_id,
              cnm.status as current_status, cnm.state_version_no as current_version_no,
              cnm.state_version_id as current_state_version_id,
              cnm.joined_at::text as current_joined_at
       from current_club_memberships cnm
       where cnm.id = $1 and cnm.club_id = any($2::short_id[])
       limit 1`,
      [input.membershipId, input.accessibleClubIds],
    );

    const membership = membershipResult.rows[0];
    if (!membership) return null;

    if (!input.skipClubAdminCheck && !(await isClubAdmin(client, input.actorMemberId, membership.club_id))) return null;

    await assertAdminStatusChangeAllowed(client, {
      clubId: membership.club_id,
      memberId: membership.member_id,
      actorMemberId: input.actorMemberId,
      actorIsSuperadmin: input.actorIsSuperadmin,
      currentStatus: membership.current_status,
      nextStatus: input.nextStatus,
    });

    if (input.nextStatus === 'active') {
      await assertClubHasCapacity(client, { clubId: membership.club_id });
    }

    try {
      await client.query(
        `insert into club_membership_state_versions
         (membership_id, status, reason, version_no, supersedes_state_version_id, created_by_member_id)
         values ($1, $2, $3, $4, $5, $6)`,
        [membership.membership_id, input.nextStatus, input.reason ?? null,
         Number(membership.current_version_no) + 1, membership.current_state_version_id, input.actorMemberId],
      );
    } catch (error) {
      translate23505(error, 'club_membership_state_versions_version_unique', 'version_conflict');
      throw error;
    }

    if (input.nextStatus === 'active') {
      await applyActivationFanout(client, membership.membership_id, {
        wasFirstActivation: membership.current_joined_at === null,
        actorMemberId: input.actorMemberId,
      });
      await ensureProfileVersionForActiveMembership(client, {
        membershipId: membership.membership_id,
        memberId: membership.member_id,
        clubId: membership.club_id,
        creatorMemberId: input.actorMemberId,
      });
      if (membership.current_status === 'removed' || membership.current_status === 'banned') {
        await clearApplicantBlock(client, {
          clubId: membership.club_id,
          memberId: membership.member_id,
        });
      }
    }

    if (input.nextStatus === 'removed' || input.nextStatus === 'banned') {
      await writeApplicantBlock(client, {
        clubId: membership.club_id,
        memberId: membership.member_id,
        blockKind: input.nextStatus,
        source: 'membership_transition',
        creatorMemberId: input.actorMemberId,
        reason: input.reason ?? null,
      });
    }

    if (input.nextStatus === 'removed' || input.nextStatus === 'banned' || input.nextStatus === 'cancelled') {
      await revokeOpenInvitesFromSponsorInClub(client, {
        sponsorMemberId: membership.member_id,
        clubId: membership.club_id,
      });
    }

    const summary = await readMembershipSummary(client, membership.membership_id);
    if (!summary) {
      return null;
    }
    if (options.afterTransition) {
      await options.afterTransition(client, {
        membership: summary,
        previousStatus: membership.current_status,
        nextStatus: input.nextStatus,
      });
    }
    return summary;
  });
}

export async function updateMembership(pool: Pool, input: UpdateMembershipInput): Promise<{ membership: MembershipAdminSummary; changed: boolean } | null> {
  const performUpdate = async (client: DbClient) => {
    const membershipResult = await client.query<{
      membership_id: string;
      club_id: string;
      member_id: string;
      current_status: MembershipState;
      current_role: MembershipSummary['role'];
      current_version_no: number;
      current_state_version_id: string;
      current_joined_at: string | null;
    }>(
      `select cnm.id as membership_id,
              cnm.club_id,
              cnm.member_id,
              cnm.status as current_status,
              cnm.role as current_role,
              cnm.state_version_no as current_version_no,
              cnm.state_version_id as current_state_version_id,
              cnm.joined_at::text as current_joined_at
         from current_club_memberships cnm
        where cnm.club_id = $1
          and cnm.member_id = $2
        limit 1`,
      [input.clubId, input.memberId],
    );

    const membership = membershipResult.rows[0];
    if (!membership) return null;

    if (!input.skipClubAdminCheck && !(await isClubAdmin(client, input.actorMemberId, membership.club_id))) return null;

    let changed = false;
    let currentStatus = membership.current_status;
    let currentRole = membership.current_role;
    let currentVersionNo = Number(membership.current_version_no);
    let currentStateVersionId = membership.current_state_version_id;

    const applyRoleChange = async () => {
      const nextRole = input.patch.role;
      if (!nextRole || nextRole === currentRole) return;
      if (currentStatus !== 'active') {
        throw new AppError('invalid_state', 'Membership role can only change while the membership is active.');
      }
      if (nextRole === 'member') {
        const ownerCheck = await client.query<{ owner_member_id: string }>(
          `select owner_member_id from clubs where id = $1 limit 1`,
          [membership.club_id],
        );
        if (ownerCheck.rows[0]?.owner_member_id === membership.member_id) {
          throw new AppError('forbidden_role', 'Cannot demote the club owner');
        }
      }
      await syncMembershipRole(client, membership.membership_id, nextRole);
      currentRole = nextRole;
      changed = true;
    };

    if (input.patch.status && input.patch.status !== currentStatus) {
      await assertAdminStatusChangeAllowed(client, {
        clubId: membership.club_id,
        memberId: membership.member_id,
        actorMemberId: input.actorMemberId,
        actorIsSuperadmin: input.actorIsSuperadmin,
        currentStatus,
        nextStatus: input.patch.status,
      });

      if (input.patch.status === 'active') {
        await assertClubHasCapacity(client, { clubId: membership.club_id });
      }

      try {
        await client.query(
          `insert into club_membership_state_versions
           (membership_id, status, reason, version_no, supersedes_state_version_id, created_by_member_id)
           values ($1, $2, $3, $4, $5, $6)`,
          [
            membership.membership_id,
            input.patch.status,
            input.patch.reason ?? null,
            currentVersionNo + 1,
            currentStateVersionId,
            input.actorMemberId,
          ],
        );
      } catch (error) {
        translate23505(error, 'club_membership_state_versions_version_unique', 'version_conflict');
        throw error;
      }

      currentVersionNo += 1;
      currentStatus = input.patch.status;
      changed = true;

      if (currentStatus === 'active') {
        await applyActivationFanout(client, membership.membership_id, {
          wasFirstActivation: membership.current_joined_at === null,
          actorMemberId: input.actorMemberId,
        });
        await ensureProfileVersionForActiveMembership(client, {
          membershipId: membership.membership_id,
          memberId: membership.member_id,
          clubId: membership.club_id,
          creatorMemberId: input.actorMemberId,
        });
        if (membership.current_status === 'removed' || membership.current_status === 'banned') {
          await clearApplicantBlock(client, {
            clubId: membership.club_id,
            memberId: membership.member_id,
          });
        }
      }

      if (currentStatus === 'removed' || currentStatus === 'banned') {
        await writeApplicantBlock(client, {
          clubId: membership.club_id,
          memberId: membership.member_id,
          blockKind: currentStatus,
          source: 'membership_transition',
          creatorMemberId: input.actorMemberId,
          reason: input.patch.reason ?? null,
        });
      }
      if (currentStatus === 'removed' || currentStatus === 'banned' || currentStatus === 'cancelled') {
        await revokeOpenInvitesFromSponsorInClub(client, {
          sponsorMemberId: membership.member_id,
          clubId: membership.club_id,
        });
      }
      if (currentStatus === 'removed' || currentStatus === 'banned') {
        await applyMembershipApplicationEffects(client, {
          membershipId: membership.membership_id,
          clubId: membership.club_id,
          memberId: membership.member_id,
          nextStatus: currentStatus,
          actorMemberId: input.actorMemberId,
          actorMemberships: input.actorMemberships,
        });
      }
    }

    await applyRoleChange();

    const summary = await readMembershipSummary(client, membership.membership_id);
    if (!summary) return null;
    return { membership: summary, changed };
  };

  if (!input.clientKey) {
    return withTransaction(pool, performUpdate);
  }
  if (!input.idempotencyActorContext) {
    throw new AppError('invalid_data', 'Membership update idempotency actor context is required when clientKey is supplied.');
  }
  return withTransaction(pool, (client) => withIdempotency(client, {
    actorContext: input.idempotencyActorContext!,
    clientKey: input.clientKey!,
    requestValue: input.idempotencyRequestValue ?? {
      clubId: input.clubId,
      memberId: input.memberId,
      patch: input.patch,
    },
    execute: async () => ({ responseValue: await performUpdate(client) }),
  }));
}

export async function promoteMemberToAdmin(pool: Pool, input: {
  actorMemberId: string; clubId: string; memberId: string;
}): Promise<{ membership: MembershipAdminSummary; changed: boolean } | null> {
  return withTransaction(pool, async (client) => {
    const result = await client.query<{ id: string; role: string }>(
      `select cnm.id, cnm.role from current_club_memberships cnm
       where cnm.club_id = $1 and cnm.member_id = $2 and cnm.status = 'active' limit 1`,
      [input.clubId, input.memberId],
    );
    const membership = result.rows[0];
    if (!membership) return null;
    const changed = membership.role !== 'clubadmin';
    if (changed) {
      await syncMembershipRole(client, membership.id, 'clubadmin');
    }
    const summary = await readMembershipSummary(client, membership.id);
    if (!summary) return null;
    return { membership: summary, changed };
  });
}

export async function demoteMemberFromAdmin(pool: Pool, input: {
  actorMemberId: string; clubId: string; memberId: string;
}): Promise<{ membership: MembershipAdminSummary; changed: boolean } | null> {
  return withTransaction(pool, async (client) => {
    const ownerCheck = await client.query<{ owner_member_id: string }>(
      `select owner_member_id from clubs where id = $1 limit 1`,
      [input.clubId],
    );
    if (ownerCheck.rows[0]?.owner_member_id === input.memberId) {
      throw new AppError('forbidden_role', 'Cannot demote the club owner');
    }

    const result = await client.query<{ id: string; role: string }>(
      `select cnm.id, cnm.role from current_club_memberships cnm
       where cnm.club_id = $1 and cnm.member_id = $2 and cnm.status = 'active' limit 1`,
      [input.clubId, input.memberId],
    );
    const membership = result.rows[0];
    if (!membership) return null;
    const changed = membership.role === 'clubadmin';
    if (changed) {
      await syncMembershipRole(client, membership.id, 'member');
    }
    const summary = await readMembershipSummary(client, membership.id);
    if (!summary) return null;
    return { membership: summary, changed };
  });
}

export { applyActivationFanout };

/**
 * Create a member record directly (superadmin bypass, no application flow).
 * Returns the new member ref and a bearer token.
 */
export async function createMemberDirect(pool: Pool, input: {
  actorMemberId: string;
  clientKey: string;
  idempotencyActorContext: string;
  idempotencyRequestValue: unknown;
  publicName: string;
  email: string;
}): Promise<{ member: MemberRef; token: CreatedBearerToken }> {
  const email = normalizeEmail(input.email);

  const performCreate = async (client: DbClient) => {
    let memberResult;
    try {
      memberResult = await client.query<{ id: string }>(
        `insert into members (public_name, display_name, email, state)
         values ($1, $2, $3, 'active')
         returning id`,
        [input.publicName, input.publicName, email],
      );
    } catch (error) {
      if (isMembersEmailUniqueViolation(error)) {
        throw new AppError('email_already_registered', EMAIL_ALREADY_REGISTERED_MESSAGE);
      }
      throw error;
    }
    const row = memberResult.rows[0];
    if (!row) throw new AppError('member_creation_failed', 'Failed to create member');

    const memberId = row.id;

    const token = await createBearerTokenInDb(client, {
      memberId,
      label: 'superadmin-issued',
      metadata: {},
    });

    return {
      member: {
        memberId,
        publicName: input.publicName,
      },
      token,
    };
  };

  return withTransaction(pool, (client) => withIdempotency(client, {
    actorContext: input.idempotencyActorContext,
    clientKey: input.clientKey,
    requestValue: input.idempotencyRequestValue,
    execute: async () => {
      const result = await performCreate(client);
      const { bearerToken: _bearerToken, ...safeToken } = result.token;
      return {
        responseValue: result,
        storedValue: { member: result.member, token: safeToken },
      };
    },
    onReplay: (storedValue) => throwSecretReplayUnavailable(storedValue),
  }));
}

/**
 * Create a membership as superadmin (bypasses club admin check).
 * Sponsor is optional under the unified join model.
 */
export async function createMembershipAsSuperadmin(pool: Pool, input: {
  actorMemberId: string;
  clientKey: string;
  idempotencyActorContext: string;
  idempotencyRequestValue: unknown;
  clubId: string;
  memberId: string;
  role: 'member' | 'clubadmin';
  sponsorId?: string | null;
  initialStatus: 'active';
  reason?: string | null;
  initialProfile: {
    fields: ClubProfileFields;
    generationSource: 'membership_seed' | 'application_generated';
  };
}): Promise<MembershipAdminSummary | null> {
  const performCreate = async (client: DbClient) => {
    const clubResult = await client.query<{ owner_member_id: string }>(
      `select owner_member_id from clubs where id = $1 and archived_at is null limit 1`,
      [input.clubId],
    );
    if (!clubResult.rows[0]) {
      throw new AppError('club_not_found', 'Club not found or archived');
    }

    // Validate explicit sponsor exists and has an active membership in the club
    if (input.sponsorId) {
      const sponsorCheck = await client.query<{ id: string }>(
        `select cnm.id from current_club_memberships cnm
         where cnm.club_id = $1 and cnm.member_id = $2 and cnm.status = 'active' limit 1`,
        [input.clubId, input.sponsorId],
      );
      if (!sponsorCheck.rows[0]) {
        throw new AppError('sponsor_not_found', 'Sponsor not found or does not have an active membership in this club');
      }
    }

    await assertNoLiveMembership(client, {
      clubId: input.clubId,
      memberId: input.memberId,
    });
    await assertCanApplyToClub(client, {
      clubId: input.clubId,
      memberId: input.memberId,
    });

    if (input.initialStatus === 'active') {
      await assertClubHasCapacity(client, { clubId: input.clubId });
    }

    let membershipResult;
    try {
      membershipResult = await client.query<{ id: string }>(
        `insert into club_memberships (club_id, member_id, sponsor_member_id, role, status, joined_at, metadata)
         select $1::short_id, $2::short_id, $3::short_id, $4::membership_role, $5::membership_state,
                case when $5::membership_state = 'active' then now() else null end,
                '{}'::jsonb
         where exists (select 1 from members where id = $2::short_id and state = 'active')
         returning id`,
        [input.clubId, input.memberId, input.role === 'clubadmin' ? null : (input.sponsorId ?? null), input.role, input.initialStatus],
      );
    } catch (error) {
      if (matchesPgConstraint(error, 'club_memberships_non_terminal_unique')) {
        throw new AppError('member_already_active', 'This member already has an active membership in the club.', {
          details: buildMembershipAlreadyActiveDetails({
            clubId: input.clubId,
            memberId: input.memberId,
          }),
        });
      }
      if (matchesPgCheckConstraint(error, 'short_id_check')) {
        throw new AppError('invalid_input', 'Resource id is not a valid ClawClub short_id.', { cause: error });
      }
      throw error;
    }

    const membershipId = membershipResult.rows[0]?.id ?? null;
    if (!membershipId) return null;

    await client.query(
      `insert into club_membership_state_versions (membership_id, status, reason, version_no, created_by_member_id)
       values ($1, $2, $3, 1, $4)`,
      [membershipId, input.initialStatus, input.reason ?? null, input.actorMemberId],
    );

    if (input.initialStatus === 'active') {
      await createInitialClubProfileVersion(client, {
        membershipId,
        memberId: input.memberId,
        clubId: input.clubId,
        fields: input.initialProfile.fields,
        creatorMemberId: input.actorMemberId,
        generationSource: input.initialProfile.generationSource,
      });
      await applyActivationFanout(client, membershipId, {
        wasFirstActivation: true,
        actorMemberId: input.actorMemberId,
      });
    }

    return readMembershipSummary(client, membershipId);
  };

  return withTransaction(pool, (client) => withIdempotency(client, {
    actorContext: input.idempotencyActorContext,
    clientKey: input.clientKey,
    requestValue: input.idempotencyRequestValue,
    execute: async () => ({ responseValue: await performCreate(client) }),
  }));
}
