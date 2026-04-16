/**
 * Identity domain — membership management.
 *
 * Club memberships, state transitions, member listings, promote/demote.
 */

import type { Pool } from 'pg';
import {
  AppError,
  type AdminApplicationSummary,
  type AdminMemberSummary,
  type ClubProfileFields,
  type ClubProfileLink,
  type CreateMembershipInput,
  type MembershipAdminSummary,
  type MembershipState,
  type MembershipSummary,
  type PublicMemberSummary,
  type TransitionMembershipInput,
} from '../contract.ts';
import { withTransaction, type DbClient } from '../db.ts';
import { encodeCursor } from '../schemas/fields.ts';
import { buildSecondClubWelcome, buildSponsorHeadsUp } from '../clubs/welcome.ts';
import { createInitialClubProfileVersion, emptyClubProfileFields, normalizeClubProfileFields } from './profiles.ts';

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
  is_comped: boolean;
  comped_at: string | null;
  comped_by_member_id: string | null;
  approved_price_amount: string | null;
  approved_price_currency: string | null;
  subscription_status: 'trialing' | 'active' | 'past_due' | 'cancelled' | 'ended' | null;
  subscription_current_period_end: string | null;
  subscription_ended_at: string | null;
  accepted_covenant_at: string | null;
  left_at: string | null;
  status: MembershipState;
  state_reason: string | null;
  state_version_no: number;
  state_created_at: string;
  state_created_by_member_id: string | null;
};

type AdminApplicationRow = {
  membership_id: string;
  club_id: string;
  club_slug: string;
  club_name: string;
  club_summary: string | null;
  admission_policy: string | null;
  owner_name: string | null;
  membership_price_amount: string | null;
  membership_price_currency: string | null;
  member_id: string;
  public_name: string;
  display_name: string | null;
  status: Extract<MembershipState, 'applying' | 'submitted' | 'interview_scheduled' | 'interview_completed' | 'payment_pending'>;
  state_reason: string | null;
  state_version_no: number;
  state_created_at: string;
  state_created_by_member_id: string | null;
  applied_at: string | null;
  application_submitted_at: string | null;
  application_name: string | null;
  application_email: string | null;
  application_socials: string | null;
  application_text: string | null;
  proof_kind: 'pow' | 'invitation' | 'none' | null;
  submission_path: 'cold' | 'invitation' | 'cross_apply' | 'owner_nominated' | null;
  generated_profile_draft: ClubProfileFields | null;
  sponsor_member_id: string | null;
  sponsor_public_name: string | null;
  invitation_id: string | null;
  invitation_reason: string | null;
  sponsor_active_sponsored_count: number;
  sponsor_sponsored_this_month_count: number;
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
  member_onboarded_at: string | null;
  sponsor_member_id: string | null;
  sponsor_public_name: string | null;
  invitation_id: string | null;
  invitation_sponsor_member_id: string | null;
  joined_at: string | null;
};

const ADMIN_VALID_TRANSITIONS: Record<MembershipState, readonly MembershipState[]> = {
  applying: ['banned', 'removed'],
  submitted: ['interview_scheduled', 'interview_completed', 'payment_pending', 'active', 'declined', 'banned', 'removed'],
  interview_scheduled: ['interview_completed', 'declined', 'banned', 'removed'],
  interview_completed: ['payment_pending', 'active', 'declined', 'banned', 'removed'],
  payment_pending: ['declined', 'banned', 'removed'],
  active: ['banned', 'removed'],
  renewal_pending: ['banned', 'removed'],
  cancelled: ['banned', 'removed'],
  expired: ['banned', 'removed'],
  removed: [],
  banned: [],
  declined: [],
  withdrawn: [],
};

function assertAdminTransitionAllowed(currentStatus: MembershipState, nextStatus: MembershipState): void {
  const allowedNextStates = ADMIN_VALID_TRANSITIONS[currentStatus];
  if (allowedNextStates.includes(nextStatus)) {
    return;
  }

  if (allowedNextStates.length === 0) {
    throw new AppError(
      422,
      'invalid_state_transition',
      `Cannot transition membership from '${currentStatus}' to '${nextStatus}' via clubadmin.memberships.setStatus. Memberships in state '${currentStatus}' cannot be changed through this surface.`,
    );
  }

  throw new AppError(
    422,
    'invalid_state_transition',
    `Cannot transition membership from '${currentStatus}' to '${nextStatus}' via clubadmin.memberships.setStatus. Legal next states from '${currentStatus}' are: ${allowedNextStates.join(', ')}.`,
  );
}

function mapMembershipRow(row: MembershipAdminRow): MembershipAdminSummary {
  return {
    membershipId: row.membership_id,
    clubId: row.club_id,
    member: { memberId: row.member_id, publicName: row.public_name },
    sponsor: row.sponsor_member_id
      ? { memberId: row.sponsor_member_id, publicName: row.sponsor_public_name ?? 'Unknown sponsor' }
      : null,
    role: row.role,
    isOwner: row.is_owner,
    state: {
      status: row.status,
      reason: row.state_reason,
      versionNo: Number(row.state_version_no),
      createdAt: row.state_created_at,
      createdByMemberId: row.state_created_by_member_id,
    },
    joinedAt: row.joined_at,
    acceptedCovenantAt: row.accepted_covenant_at,
    metadata: row.metadata ?? {},
  };
}

function parseNullableNumber(value: string | null): number | null {
  return value === null ? null : Number(value);
}

function mapPublicMemberRow(row: PublicMemberRow): PublicMemberSummary {
  return {
    membershipId: row.membership_id,
    memberId: row.member_id,
    publicName: row.public_name,
    displayName: row.display_name,
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
      ? { memberId: row.sponsor_member_id, publicName: row.sponsor_public_name ?? 'Unknown sponsor' }
      : null,
    vouches: [],
  };
}

function mapAdminMemberRow(row: AdminMemberRow): AdminMemberSummary {
  return {
    ...mapPublicMemberRow(row),
    isComped: row.is_comped,
    compedAt: row.comped_at,
    compedByMemberId: row.comped_by_member_id,
    approvedPriceAmount: parseNullableNumber(row.approved_price_amount),
    approvedPriceCurrency: row.approved_price_currency,
    subscription: row.is_comped || row.subscription_status === null
      ? null
      : {
          status: row.subscription_status,
          currentPeriodEnd: row.subscription_current_period_end,
          endedAt: row.subscription_ended_at,
        },
    acceptedCovenantAt: row.accepted_covenant_at,
    leftAt: row.left_at,
    state: {
      status: row.status,
      reason: row.state_reason,
      versionNo: Number(row.state_version_no),
      createdAt: row.state_created_at,
      createdByMemberId: row.state_created_by_member_id,
    },
  };
}

function mapAdminApplicationRow(row: AdminApplicationRow): AdminApplicationSummary {
  return {
    membershipId: row.membership_id,
    memberId: row.member_id,
    publicName: row.public_name,
    displayName: row.display_name,
    state: {
      status: row.status,
      reason: row.state_reason,
      versionNo: Number(row.state_version_no),
      createdAt: row.state_created_at,
      createdByMemberId: row.state_created_by_member_id,
    },
    appliedAt: row.applied_at,
    submittedAt: row.application_submitted_at,
    applicationName: row.application_name,
    applicationEmail: row.application_email,
    applicationSocials: row.application_socials,
    applicationText: row.application_text,
    proofKind: row.proof_kind,
    submissionPath: row.submission_path,
    generatedProfileDraft: row.generated_profile_draft ? normalizeClubProfileFields(row.generated_profile_draft) : null,
    sponsor: row.sponsor_member_id
      ? { memberId: row.sponsor_member_id, publicName: row.sponsor_public_name ?? 'Unknown sponsor' }
      : null,
    invitation: row.invitation_id
      ? { id: row.invitation_id, reason: row.invitation_reason }
      : null,
    sponsorStats: row.sponsor_member_id
      ? {
          activeSponsoredCount: Number(row.sponsor_active_sponsored_count ?? 0),
          sponsoredThisMonthCount: Number(row.sponsor_sponsored_this_month_count ?? 0),
        }
      : null,
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
  cnm.joined_at::text as joined_at,
  cnm.accepted_covenant_at::text as accepted_covenant_at,
  cnm.metadata
`;

const MEMBERSHIP_FROM = `
  from current_club_memberships cnm
  join members m on m.id = cnm.member_id
  join clubs n on n.id = cnm.club_id
  left join members sponsor on sponsor.id = cnm.sponsor_member_id
`;

async function readMembershipSummary(client: DbClient, membershipId: string): Promise<MembershipAdminSummary | null> {
  const result = await client.query<MembershipAdminRow>(
    `select ${MEMBERSHIP_SELECT} ${MEMBERSHIP_FROM} where cnm.id = $1 limit 1`,
    [membershipId],
  );
  return result.rows[0] ? mapMembershipRow(result.rows[0]) : null;
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

async function hasLiveAccess(client: DbClient, membershipId: string): Promise<boolean> {
  const result = await client.query<{ has_access: boolean }>(
    `select exists(
       select 1 from club_memberships where id = $1 and is_comped = true
       union all
       select 1 from club_subscriptions
       where membership_id = $1
         and status in ('trialing', 'active', 'past_due')
         and coalesce(ended_at, 'infinity'::timestamptz) > now()
         and coalesce(current_period_end, 'infinity'::timestamptz) > now()
     ) as has_access`,
    [membershipId],
  );
  return result.rows[0]?.has_access === true;
}

async function reuseOrRejectExistingMembership(client: DbClient, input: {
  clubId: string;
  memberId: string;
  sponsorMemberId: string | null;
  role: 'member' | 'clubadmin';
  initialStatus: Extract<MembershipState, 'applying' | 'submitted' | 'active' | 'payment_pending'>;
  reason: string | null;
  metadata: Record<string, unknown>;
  actorMemberId: string;
}): Promise<string | null> {
  const existing = await client.query<{
    id: string;
    left_at: string | null;
    state_version_no: number;
  }>(
    `select id, left_at::text as left_at, state_version_no
     from current_club_memberships
     where club_id = $1 and member_id = $2
     order by (left_at is null) desc, state_created_at desc, id desc
     limit 1`,
    [input.clubId, input.memberId],
  );
  const row = existing.rows[0];
  if (!row) return null;
  if (row.left_at === null) {
    throw new AppError(409, 'membership_exists', 'This member already has a membership record in the club');
  }

  await client.query(`select set_config('app.allow_membership_state_sync', '1', true)`);
  try {
    await client.query(
      `update club_memberships
       set sponsor_member_id = $2,
           role = $3::membership_role,
           joined_at = case
             when joined_at is not null then joined_at
             when $5::membership_state = 'active' then now()
             else null
           end,
           metadata = $4::jsonb
       where id = $1`,
      [row.id, input.sponsorMemberId, input.role, JSON.stringify(input.metadata), input.initialStatus],
    );
  } finally {
    await client.query(`select set_config('app.allow_membership_state_sync', '', true)`);
  }

  await client.query(
    `insert into club_membership_state_versions (membership_id, status, reason, version_no, created_by_member_id)
     values ($1, $2, $3, $4, $5)`,
    [row.id, input.initialStatus, input.reason, Number(row.state_version_no) + 1, input.actorMemberId],
  );

  return row.id;
}

async function setComped(client: DbClient, membershipId: string, compedByMemberId: string): Promise<void> {
  await client.query(
    `update club_memberships set is_comped = true, comped_at = now(), comped_by_member_id = $2
     where id = $1 and is_comped = false`,
    [membershipId, compedByMemberId],
  );
}

async function ensureProfileVersionForActiveMembership(client: DbClient, input: {
  membershipId: string;
  memberId: string;
  clubId: string;
  createdByMemberId: string | null;
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

  const membership = await client.query<{ generated_profile_draft: Record<string, unknown> | null }>(
    `select generated_profile_draft
     from club_memberships
     where id = $1
     limit 1`,
    [input.membershipId],
  );
  const draft = membership.rows[0]?.generated_profile_draft ?? null;
  const fields = draft ? normalizeClubProfileFields(draft) : emptyClubProfileFields();

  await createInitialClubProfileVersion(client, {
    membershipId: input.membershipId,
    memberId: input.memberId,
    clubId: input.clubId,
    fields,
    createdByMemberId: input.createdByMemberId,
    generationSource: draft ? 'application_generated' : 'membership_seed',
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
        m.onboarded_at::text as member_onboarded_at,
        cm.sponsor_member_id,
        sponsor.public_name as sponsor_public_name,
        cm.invitation_id,
        i.sponsor_member_id as invitation_sponsor_member_id,
        cm.joined_at::text as joined_at
     from current_club_memberships cm
     join clubs c on c.id = cm.club_id
     join members m on m.id = cm.member_id
     left join members sponsor on sponsor.id = cm.sponsor_member_id
     left join invitations i on i.id = cm.invitation_id
     where cm.id = $1
     limit 1`,
    [membershipId],
  );
  return result.rows[0] ?? null;
}

async function insertInvitationAcceptedNotification(client: DbClient, row: ActivationFanoutRow): Promise<void> {
  if (!row.invitation_id || !row.invitation_sponsor_member_id) {
    return;
  }
  await client.query(
    `insert into member_notifications (club_id, recipient_member_id, topic, payload)
     values ($1, $2, 'invitation.accepted', $3::jsonb)`,
    [
      row.club_id,
      row.invitation_sponsor_member_id,
      JSON.stringify({
        newMemberId: row.member_id,
        newMemberPublicName: row.member_public_name,
        invitationId: row.invitation_id,
        clubName: row.club_name,
        headsUp: buildSponsorHeadsUp({
          newMemberPublicName: row.member_public_name,
          clubName: row.club_name,
        }),
      }),
    ],
  );
}

async function insertMembershipActivatedNotification(client: DbClient, row: ActivationFanoutRow): Promise<void> {
  if (row.member_onboarded_at === null) {
    return;
  }
  await client.query(
    `insert into member_notifications (club_id, recipient_member_id, topic, payload)
     values ($1, $2, 'membership.activated', $3::jsonb)`,
    [
      row.club_id,
      row.member_id,
      JSON.stringify({
        clubId: row.club_id,
        clubName: row.club_name,
        summary: row.club_summary,
        ...(row.sponsor_member_id ? { sponsorMemberId: row.sponsor_member_id } : {}),
        ...(row.sponsor_public_name ? { sponsorPublicName: row.sponsor_public_name } : {}),
        welcome: buildSecondClubWelcome({
          clubName: row.club_name,
          memberName: row.member_display_name,
          sponsorPublicName: row.sponsor_public_name,
        }),
      }),
    ],
  );
}

async function applyActivationFanout(client: DbClient, membershipId: string, options: {
  wasFirstActivation: boolean;
}): Promise<void> {
  if (!options.wasFirstActivation) {
    return;
  }

  const row = await readActivationFanoutRow(client, membershipId);
  if (!row) {
    return;
  }

  await insertInvitationAcceptedNotification(client, row);
  await insertMembershipActivatedNotification(client, row);
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
  statuses?: Array<Extract<MembershipState, 'active' | 'renewal_pending' | 'cancelled'>> | null;
  roles?: Array<'clubadmin' | 'member'> | null;
  cursor?: { joinedAt: string; membershipId: string } | null;
}): Promise<{ results: AdminMemberSummary[]; hasMore: boolean; nextCursor: string | null }> {
  const fetchLimit = input.limit + 1;
  const cursorJoinedAt = input.cursor?.joinedAt ?? null;
  const cursorMembershipId = input.cursor?.membershipId ?? null;

  const result = await pool.query<AdminMemberRow>(
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
       sponsor.public_name as sponsor_public_name,
       acm.is_comped,
       acm.comped_at::text as comped_at,
       acm.comped_by_member_id,
       acm.approved_price_amount::text as approved_price_amount,
       acm.approved_price_currency,
       sub.status::text as subscription_status,
       sub.current_period_end::text as subscription_current_period_end,
       sub.ended_at::text as subscription_ended_at,
       acm.accepted_covenant_at::text as accepted_covenant_at,
       acm.left_at::text as left_at,
       acm.status,
       acm.state_reason,
       acm.state_version_no,
       acm.state_created_at::text as state_created_at,
       acm.state_created_by_member_id
     from accessible_club_memberships acm
     join members m on m.id = acm.member_id and m.state = 'active'
     join clubs c on c.id = acm.club_id and c.archived_at is null
     join current_member_club_profiles cmp on cmp.member_id = acm.member_id and cmp.club_id = acm.club_id
     left join members sponsor on sponsor.id = acm.sponsor_member_id
     left join lateral (
       select s.status, s.current_period_end, s.ended_at
       from club_subscriptions s
       where s.membership_id = acm.id
       order by s.started_at desc, s.id desc
       limit 1
     ) sub on true
     where acm.club_id = $1
       and ($3::membership_state[] is null or acm.status = any($3))
       and ($4::membership_role[] is null or acm.role = any($4))
       and ($5::timestamptz is null
         or acm.joined_at < $5
         or (acm.joined_at = $5 and acm.id < $6))
     order by acm.joined_at desc, acm.id desc
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
  membershipId: string;
}): Promise<AdminMemberSummary | null> {
  const result = await pool.query<AdminMemberRow>(
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
       sponsor.public_name as sponsor_public_name,
       acm.is_comped,
       acm.comped_at::text as comped_at,
       acm.comped_by_member_id,
       acm.approved_price_amount::text as approved_price_amount,
       acm.approved_price_currency,
       sub.status::text as subscription_status,
       sub.current_period_end::text as subscription_current_period_end,
       sub.ended_at::text as subscription_ended_at,
       acm.accepted_covenant_at::text as accepted_covenant_at,
       acm.left_at::text as left_at,
       acm.status,
       acm.state_reason,
       acm.state_version_no,
       acm.state_created_at::text as state_created_at,
       acm.state_created_by_member_id
     from accessible_club_memberships acm
     join members m on m.id = acm.member_id and m.state = 'active'
     join clubs c on c.id = acm.club_id and c.archived_at is null
     join current_member_club_profiles cmp on cmp.member_id = acm.member_id and cmp.club_id = acm.club_id
     left join members sponsor on sponsor.id = acm.sponsor_member_id
     left join lateral (
       select s.status, s.current_period_end, s.ended_at
       from club_subscriptions s
       where s.membership_id = acm.id
       order by s.started_at desc, s.id desc
       limit 1
     ) sub on true
     where acm.club_id = $1
       and acm.id = $2
     limit 1`,
    [input.clubId, input.membershipId],
  );
  return result.rows[0] ? mapAdminMemberRow(result.rows[0]) : null;
}

export async function listAdminApplications(pool: Pool, input: {
  clubId: string;
  limit: number;
  statuses?: Array<Extract<MembershipState, 'applying' | 'submitted' | 'interview_scheduled' | 'interview_completed' | 'payment_pending'>> | null;
  cursor?: { stateCreatedAt: string; membershipId: string } | null;
}): Promise<{ results: AdminApplicationSummary[]; hasMore: boolean; nextCursor: string | null }> {
  const fetchLimit = input.limit + 1;
  const cursorStateCreatedAt = input.cursor?.stateCreatedAt ?? null;
  const cursorMembershipId = input.cursor?.membershipId ?? null;

  const result = await pool.query<AdminApplicationRow>(
    `with sponsor_stats as (
       select
         sponsored.sponsor_member_id,
         sponsored.club_id,
         count(*) filter (where sponsored.status = 'active')::int as active_sponsored_count,
         count(*) filter (
           where sponsored.joined_at is not null
             and date_trunc('month', sponsored.joined_at) = date_trunc('month', now())
         )::int as sponsored_this_month_count
       from current_club_memberships sponsored
       where sponsored.club_id = $1
         and sponsored.sponsor_member_id is not null
       group by sponsored.sponsor_member_id, sponsored.club_id
     )
     select
       cm.id as membership_id,
       cm.club_id,
       c.slug as club_slug,
       c.name as club_name,
       c.summary as club_summary,
       c.admission_policy,
       owner.public_name as owner_name,
       c.membership_price_amount::text as membership_price_amount,
       c.membership_price_currency,
       cm.member_id,
       m.public_name,
       m.display_name,
       cm.status,
       cm.state_reason,
       cm.state_version_no,
       cm.state_created_at::text as state_created_at,
       cm.state_created_by_member_id,
       cm.applied_at::text as applied_at,
       cm.application_submitted_at::text as application_submitted_at,
       cm.application_name,
       cm.application_email,
       cm.application_socials,
       cm.application_text,
       cm.proof_kind,
       cm.submission_path,
       cm.generated_profile_draft,
       cm.sponsor_member_id,
       sponsor.public_name as sponsor_public_name,
       cm.invitation_id,
       i.reason as invitation_reason,
       coalesce(ss.active_sponsored_count, 0) as sponsor_active_sponsored_count,
       coalesce(ss.sponsored_this_month_count, 0) as sponsor_sponsored_this_month_count
     from current_club_memberships cm
     join members m on m.id = cm.member_id
     join clubs c on c.id = cm.club_id and c.archived_at is null
     left join members sponsor on sponsor.id = cm.sponsor_member_id
     left join invitations i on i.id = cm.invitation_id
     left join members owner on owner.id = c.owner_member_id
     left join sponsor_stats ss on ss.sponsor_member_id = cm.sponsor_member_id and ss.club_id = cm.club_id
     where cm.club_id = $1
       and cm.left_at is null
       and ($3::membership_state[] is null or cm.status = any($3))
       and cm.status = any(array['applying','submitted','interview_scheduled','interview_completed','payment_pending']::membership_state[])
       and ($4::timestamptz is null
         or cm.state_created_at < $4
         or (cm.state_created_at = $4 and cm.id < $5))
     order by cm.state_created_at desc, cm.id desc
     limit $2`,
    [input.clubId, fetchLimit, input.statuses ?? null, cursorStateCreatedAt, cursorMembershipId],
  );

  const rows = result.rows.map(mapAdminApplicationRow);
  const hasMore = rows.length > input.limit;
  if (hasMore) rows.pop();
  const last = rows[rows.length - 1];
  const nextCursor = last ? encodeCursor([last.state.createdAt, last.membershipId]) : null;
  return { results: rows, hasMore, nextCursor };
}

export async function getAdminApplication(pool: Pool, input: {
  clubId: string;
  membershipId: string;
}): Promise<{
  club: {
    clubId: string;
    slug: string;
    name: string;
    summary: string | null;
    admissionPolicy: string | null;
    ownerName: string | null;
    priceUsd: number | null;
  };
  application: AdminApplicationSummary;
} | null> {
  const result = await pool.query<AdminApplicationRow>(
    `with sponsor_stats as (
       select
         sponsored.sponsor_member_id,
         sponsored.club_id,
         count(*) filter (where sponsored.status = 'active')::int as active_sponsored_count,
         count(*) filter (
           where sponsored.joined_at is not null
             and date_trunc('month', sponsored.joined_at) = date_trunc('month', now())
         )::int as sponsored_this_month_count
       from current_club_memberships sponsored
       where sponsored.club_id = $1
         and sponsored.sponsor_member_id is not null
       group by sponsored.sponsor_member_id, sponsored.club_id
     )
     select
       cm.id as membership_id,
       cm.club_id,
       c.slug as club_slug,
       c.name as club_name,
       c.summary as club_summary,
       c.admission_policy,
       owner.public_name as owner_name,
       c.membership_price_amount::text as membership_price_amount,
       c.membership_price_currency,
       cm.member_id,
       m.public_name,
       m.display_name,
       cm.status,
       cm.state_reason,
       cm.state_version_no,
       cm.state_created_at::text as state_created_at,
       cm.state_created_by_member_id,
       cm.applied_at::text as applied_at,
       cm.application_submitted_at::text as application_submitted_at,
       cm.application_name,
       cm.application_email,
       cm.application_socials,
       cm.application_text,
       cm.proof_kind,
       cm.submission_path,
       cm.generated_profile_draft,
       cm.sponsor_member_id,
       sponsor.public_name as sponsor_public_name,
       cm.invitation_id,
       i.reason as invitation_reason,
       coalesce(ss.active_sponsored_count, 0) as sponsor_active_sponsored_count,
       coalesce(ss.sponsored_this_month_count, 0) as sponsor_sponsored_this_month_count
     from current_club_memberships cm
     join members m on m.id = cm.member_id
     join clubs c on c.id = cm.club_id and c.archived_at is null
     left join members sponsor on sponsor.id = cm.sponsor_member_id
     left join invitations i on i.id = cm.invitation_id
     left join members owner on owner.id = c.owner_member_id
     left join sponsor_stats ss on ss.sponsor_member_id = cm.sponsor_member_id and ss.club_id = cm.club_id
     where cm.club_id = $1
       and cm.id = $2
       and cm.left_at is null
       and cm.status = any(array['applying','submitted','interview_scheduled','interview_completed','payment_pending']::membership_state[])
     limit 1`,
    [input.clubId, input.membershipId],
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    club: {
      clubId: row.club_id,
      slug: row.club_slug,
      name: row.club_name,
      summary: row.club_summary,
      admissionPolicy: row.admission_policy,
      ownerName: row.owner_name,
      priceUsd: row.membership_price_currency === 'USD' && row.membership_price_amount !== null
        ? Number(row.membership_price_amount)
        : null,
    },
    application: mapAdminApplicationRow(row),
  };
}

export async function createMembership(pool: Pool, input: CreateMembershipInput): Promise<MembershipAdminSummary | null> {
  return withTransaction(pool, async (client) => {
    if (!input.skipClubAdminCheck && !(await isClubAdmin(client, input.actorMemberId, input.clubId))) return null;

    // Verify sponsor exists in club.
    // When the club admin check is skipped (superadmin path), always validate —
    // the actor may not be a member of this club at all.
    if (input.sponsorMemberId && (input.skipClubAdminCheck || input.sponsorMemberId !== input.actorMemberId)) {
      const sponsorCheck = await client.query<{ id: string }>(
        `select cnm.id from current_club_memberships cnm
         where cnm.club_id = $1 and cnm.member_id = $2 and cnm.status = 'active' limit 1`,
        [input.clubId, input.sponsorMemberId],
      );
      if (!sponsorCheck.rows[0]) return null;
    }

    let membershipId = await reuseOrRejectExistingMembership(client, {
      clubId: input.clubId,
      memberId: input.memberId,
      sponsorMemberId: input.sponsorMemberId ?? null,
      role: input.role,
      initialStatus: input.initialStatus,
      reason: input.reason ?? null,
      metadata: input.metadata ?? {},
      actorMemberId: input.actorMemberId,
    });

    if (!membershipId) {
      const membershipResult = await client.query<{ id: string }>(
        `insert into club_memberships (club_id, member_id, sponsor_member_id, role, status, joined_at, metadata)
         select $1::short_id, $6::short_id, $2::short_id, $3::membership_role, $4::membership_state,
                case when $4::membership_state = 'active' then now() else null end,
                $5::jsonb
         where exists (select 1 from members where id = $6::short_id and state = 'active')
         returning id`,
        [input.clubId, input.sponsorMemberId, input.role, input.initialStatus, JSON.stringify(input.metadata ?? {}), input.memberId],
      );

      membershipId = membershipResult.rows[0]?.id ?? null;
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
          createdByMemberId: input.actorMemberId,
          generationSource: input.initialProfile.generationSource,
        });
      }
    }

    if (input.initialStatus === 'active') {
      await setComped(client, membershipId, input.actorMemberId);
    }

    return readMembershipSummary(client, membershipId);
  });
}

export async function transitionMembershipState(pool: Pool, input: TransitionMembershipInput): Promise<MembershipAdminSummary | null> {
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

    if (membership.member_id === input.actorMemberId && input.nextStatus !== 'active' && input.nextStatus !== membership.current_status) {
      throw new AppError(403, 'forbidden', 'Admins may not self-revoke or self-reject through this surface');
    }

    assertAdminTransitionAllowed(membership.current_status, input.nextStatus);

    await client.query(
      `insert into club_membership_state_versions
       (membership_id, status, reason, version_no, supersedes_state_version_id, created_by_member_id)
       values ($1, $2, $3, $4, $5, $6)`,
      [membership.membership_id, input.nextStatus, input.reason ?? null,
       Number(membership.current_version_no) + 1, membership.current_state_version_id, input.actorMemberId],
    );

    if (input.nextStatus === 'active') {
      await applyActivationFanout(client, membership.membership_id, {
        wasFirstActivation: membership.current_joined_at === null,
      });
      await ensureProfileVersionForActiveMembership(client, {
        membershipId: membership.membership_id,
        memberId: membership.member_id,
        clubId: membership.club_id,
        createdByMemberId: input.actorMemberId,
      });
      if (!(await hasLiveAccess(client, membership.membership_id))) {
        await setComped(client, membership.membership_id, input.actorMemberId);
      }
    }

    if (input.nextStatus === 'removed' || input.nextStatus === 'banned' || input.nextStatus === 'expired') {
      await client.query(
        `update invitations
         set revoked_at = coalesce(revoked_at, now())
         where sponsor_member_id = $1
           and club_id = $2
           and revoked_at is null
           and used_at is null`,
        [membership.member_id, membership.club_id],
      );
    }

    return readMembershipSummary(client, membership.membership_id);
  });
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
      await client.query(`update club_memberships set role = 'clubadmin' where id = $1`, [membership.id]);
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
      throw new AppError(403, 'forbidden', 'Cannot demote the club owner');
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
      await client.query(`update club_memberships set role = 'member' where id = $1`, [membership.id]);
    }
    const summary = await readMembershipSummary(client, membership.id);
    if (!summary) return null;
    return { membership: summary, changed };
  });
}

export { setComped };
export { hasLiveAccess };
export { applyActivationFanout };

/**
 * Create a member record directly (superadmin bypass, no application flow).
 * Returns the new member ID and a bearer token.
 */
export async function createMemberDirect(pool: Pool, input: {
  actorMemberId: string;
  publicName: string;
  email?: string | null;
}): Promise<{ memberId: string; publicName: string; bearerToken: string }> {
  const { buildBearerToken } = await import('../token.ts');

  return withTransaction(pool, async (client) => {
    const memberResult = await client.query<{ id: string }>(
      `insert into members (public_name, display_name, state, onboarded_at)
       values ($1, $2, 'active', now())
       returning id`,
      [input.publicName, input.publicName],
    );
    const row = memberResult.rows[0];
    if (!row) throw new AppError(500, 'member_creation_failed', 'Failed to create member');

    const memberId = row.id;

    // Store private contact email
    if (input.email) {
      await client.query(
        `insert into member_private_contacts (member_id, email) values ($1, $2)`,
        [memberId, input.email],
      );
    }

    // Issue bearer token
    const token = buildBearerToken();
    await client.query(
      `insert into member_bearer_tokens (id, member_id, label, token_hash, metadata)
       values ($1, $2, $3, $4, '{}'::jsonb)`,
      [token.tokenId, memberId, 'superadmin-issued', token.tokenHash],
    );

    return {
      memberId,
      publicName: input.publicName,
      bearerToken: token.bearerToken,
    };
  });
}

/**
 * Create a membership as superadmin (bypasses club admin check).
 * Sponsor is optional under the unified join model.
 */
export async function createMembershipAsSuperadmin(pool: Pool, input: {
  actorMemberId: string;
  clubId: string;
  memberId: string;
  role: 'member' | 'clubadmin';
  sponsorMemberId?: string | null;
  initialStatus: Extract<MembershipState, 'applying' | 'submitted' | 'active' | 'payment_pending'>;
  reason?: string | null;
  initialProfile: {
    fields: ClubProfileFields;
    generationSource: 'membership_seed' | 'application_generated';
  };
}): Promise<MembershipAdminSummary | null> {
  return withTransaction(pool, async (client) => {
    const clubResult = await client.query<{ owner_member_id: string }>(
      `select owner_member_id from clubs where id = $1 and archived_at is null limit 1`,
      [input.clubId],
    );
    if (!clubResult.rows[0]) {
      throw new AppError(404, 'not_found', 'Club not found or archived');
    }

    // Validate explicit sponsor exists and has an active membership in the club
    if (input.sponsorMemberId) {
      const sponsorCheck = await client.query<{ id: string }>(
        `select cnm.id from current_club_memberships cnm
         where cnm.club_id = $1 and cnm.member_id = $2 and cnm.status = 'active' limit 1`,
        [input.clubId, input.sponsorMemberId],
      );
      if (!sponsorCheck.rows[0]) {
        throw new AppError(404, 'sponsor_not_found', 'Sponsor not found or does not have an active membership in this club');
      }
    }

    let membershipId = await reuseOrRejectExistingMembership(client, {
      clubId: input.clubId,
      memberId: input.memberId,
      sponsorMemberId: input.role === 'clubadmin' ? null : (input.sponsorMemberId ?? null),
      role: input.role,
      initialStatus: input.initialStatus,
      reason: input.reason ?? null,
      metadata: {},
      actorMemberId: input.actorMemberId,
    });

    if (!membershipId) {
      const membershipResult = await client.query<{ id: string }>(
        `insert into club_memberships (club_id, member_id, sponsor_member_id, role, status, joined_at, metadata)
         select $1::short_id, $2::short_id, $3::short_id, $4::membership_role, $5::membership_state,
                case when $5::membership_state = 'active' then now() else null end,
                '{}'::jsonb
         where exists (select 1 from members where id = $2::short_id and state = 'active')
         returning id`,
        [input.clubId, input.memberId, input.role === 'clubadmin' ? null : (input.sponsorMemberId ?? null), input.role, input.initialStatus],
      );

      membershipId = membershipResult.rows[0]?.id ?? null;
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
          createdByMemberId: input.actorMemberId,
          generationSource: input.initialProfile.generationSource,
        });
      }
    }

    if (input.initialStatus === 'active') {
      await setComped(client, membershipId, input.actorMemberId);
    }

    return readMembershipSummary(client, membershipId);
  });
}
