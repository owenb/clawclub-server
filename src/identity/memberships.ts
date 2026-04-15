/**
 * Identity domain — membership management.
 *
 * Club memberships, state transitions, member listings, promote/demote.
 */

import type { Pool } from 'pg';
import {
  AppError,
  type ClubProfileFields,
  type CreateMembershipInput,
  type MembershipAdminSummary,
  type MembershipReviewSummary,
  type MembershipState,
  type MembershipSummary,
  type ClubMemberSummary,
  type TransitionMembershipInput,
} from '../contract.ts';
import { withTransaction, type DbClient } from '../db.ts';
import { encodeCursor } from '../schemas/fields.ts';
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

// ── Exported functions ────────────────────────────────────────

export async function listMemberships(pool: Pool, input: {
  clubIds: string[]; limit: number; status?: MembershipState;
  cursor?: { stateCreatedAt: string; id: string } | null;
}): Promise<{ results: MembershipAdminSummary[]; hasMore: boolean; nextCursor: string | null }> {
  if (input.clubIds.length === 0) return { results: [], hasMore: false, nextCursor: null };
  const fetchLimit = input.limit + 1;
  const cursorStateCreatedAt = input.cursor?.stateCreatedAt ?? null;
  const cursorId = input.cursor?.id ?? null;

  const result = await pool.query<MembershipAdminRow>(
    `select ${MEMBERSHIP_SELECT} ${MEMBERSHIP_FROM}
     where cnm.club_id = any($1::short_id[])
       and ($2::membership_state is null or cnm.status = $2)
       and ($4::timestamptz is null
         or cnm.state_created_at < $4
         or (cnm.state_created_at = $4 and cnm.id < $5))
     order by cnm.state_created_at desc, cnm.id desc
     limit $3`,
    [input.clubIds, input.status ?? null, fetchLimit, cursorStateCreatedAt, cursorId],
  );
  const rows = result.rows.map(mapMembershipRow);
  const hasMore = rows.length > input.limit;
  if (hasMore) rows.pop();
  const last = rows[rows.length - 1];
  const nextCursor = last ? encodeCursor([last.state.createdAt, last.membershipId]) : null;
  return { results: rows, hasMore, nextCursor };
}

/**
 * Returns reviews with sponsorStats but empty vouches array.
 * The composition layer fills in vouches from the clubs module.
 */
export async function listMembershipReviews(pool: Pool, input: {
  clubIds: string[]; limit: number; statuses: MembershipState[];
  cursor?: { stateCreatedAt: string; id: string } | null;
}): Promise<{ results: MembershipReviewSummary[]; hasMore: boolean; nextCursor: string | null }> {
  if (input.clubIds.length === 0 || input.statuses.length === 0) return { results: [], hasMore: false, nextCursor: null };

  const fetchLimit = input.limit + 1;
  const cursorStateCreatedAt = input.cursor?.stateCreatedAt ?? null;
  const cursorId = input.cursor?.id ?? null;

  const result = await pool.query<MembershipAdminRow & {
    sponsor_active_sponsored_count: number;
    sponsor_sponsored_this_month_count: number;
  }>(
    `with sponsor_stats as (
       select
         sponsored.sponsor_member_id, sponsored.club_id,
         count(*) filter (where sponsored.status = 'active')::int as active_sponsored_count,
         count(*) filter (where date_trunc('month', sponsored.joined_at) = date_trunc('month', now()))::int as sponsored_this_month_count
       from current_club_memberships sponsored
       where sponsored.club_id = any($1::short_id[])
         and sponsored.sponsor_member_id is not null
       group by sponsored.sponsor_member_id, sponsored.club_id
     )
     select ${MEMBERSHIP_SELECT},
       coalesce(ss.active_sponsored_count, 0) as sponsor_active_sponsored_count,
       coalesce(ss.sponsored_this_month_count, 0) as sponsor_sponsored_this_month_count
     ${MEMBERSHIP_FROM}
     left join sponsor_stats ss on ss.sponsor_member_id = cnm.sponsor_member_id and ss.club_id = cnm.club_id
     where cnm.club_id = any($1::short_id[])
       and cnm.status = any($2::membership_state[])
       and ($4::timestamptz is null
         or cnm.state_created_at < $4
         or (cnm.state_created_at = $4 and cnm.id < $5))
     order by cnm.state_created_at desc, cnm.id desc
     limit $3`,
    [input.clubIds, input.statuses, fetchLimit, cursorStateCreatedAt, cursorId],
  );

  const rows = result.rows.map((row) => ({
    ...mapMembershipRow(row),
    sponsorStats: {
      activeSponsoredCount: Number(row.sponsor_active_sponsored_count ?? 0),
      sponsoredThisMonthCount: Number(row.sponsor_sponsored_this_month_count ?? 0),
    },
    vouches: [], // filled by composition layer
  }));
  const hasMore = rows.length > input.limit;
  if (hasMore) rows.pop();
  const last = rows[rows.length - 1];
  const nextCursor = last ? encodeCursor([last.state.createdAt, last.membershipId]) : null;
  return { results: rows, hasMore, nextCursor };
}

export async function listMembers(pool: Pool, input: {
  clubId: string; limit: number;
  cursor?: { joinedAt: string; memberId: string } | null;
}): Promise<{ results: ClubMemberSummary[]; hasMore: boolean; nextCursor: string | null }> {
  const fetchLimit = input.limit + 1;
  const cursorJoinedAt = input.cursor?.joinedAt ?? null;
  const cursorMemberId = input.cursor?.memberId ?? null;

  const result = await pool.query<{
    member_id: string; public_name: string; display_name: string;
    tagline: string | null; summary: string | null;
    what_i_do: string | null; known_for: string | null;
    services_summary: string | null; website_url: string | null;
    memberships: MembershipSummary[] | null;
    _latest_joined_at: string;
  }>(
    `select
       m.id as member_id, m.public_name,
       m.display_name,
       cmp.tagline, cmp.summary, cmp.what_i_do, cmp.known_for,
       cmp.services_summary, cmp.website_url,
       jsonb_agg(distinct jsonb_build_object(
         'membershipId', anm.id, 'clubId', anm.club_id, 'slug', n.slug,
         'name', n.name, 'summary', n.summary, 'role', anm.role,
         'isOwner', (n.owner_member_id = anm.member_id), 'status', anm.status,
         'sponsorMemberId', anm.sponsor_member_id, 'joinedAt', anm.joined_at::text
       )) filter (where anm.id is not null) as memberships,
       max(anm.joined_at)::text as _latest_joined_at
     from accessible_club_memberships anm
     join members m on m.id = anm.member_id and m.state = 'active'
     join clubs n on n.id = anm.club_id and n.archived_at is null
     join current_member_club_profiles cmp
       on cmp.member_id = m.id and cmp.club_id = anm.club_id
     where anm.club_id = $1
     group by m.id, m.public_name, m.display_name, cmp.tagline,
              cmp.summary, cmp.what_i_do, cmp.known_for, cmp.services_summary, cmp.website_url
     having ($3::timestamptz is null
       or max(anm.joined_at) < $3
       or (max(anm.joined_at) = $3 and m.id < $4))
     order by max(anm.joined_at) desc, m.id desc
     limit $2`,
    [input.clubId, fetchLimit, cursorJoinedAt, cursorMemberId],
  );

  const rows: ClubMemberSummary[] = result.rows.map((row) => ({
    memberId: row.member_id,
    publicName: row.public_name,
    displayName: row.display_name,
    tagline: row.tagline,
    summary: row.summary,
    whatIDo: row.what_i_do,
    knownFor: row.known_for,
    servicesSummary: row.services_summary,
    websiteUrl: row.website_url,
    memberships: row.memberships ?? [],
  }));

  const hasMore = rows.length > input.limit;
  if (hasMore) rows.pop();
  const lastRow = rows.length > 0 ? result.rows[rows.length - 1] : null;
  const nextCursor = lastRow ? encodeCursor([lastRow._latest_joined_at, lastRow.member_id]) : null;
  return { results: rows, hasMore, nextCursor };
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
      current_status: MembershipState; current_version_no: number; current_state_version_id: string;
    }>(
      `select cnm.id as membership_id, cnm.club_id, cnm.member_id,
              cnm.status as current_status, cnm.state_version_no as current_version_no,
              cnm.state_version_id as current_state_version_id
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

    await client.query(
      `insert into club_membership_state_versions
       (membership_id, status, reason, version_no, supersedes_state_version_id, created_by_member_id)
       values ($1, $2, $3, $4, $5, $6)`,
      [membership.membership_id, input.nextStatus, input.reason ?? null,
       Number(membership.current_version_no) + 1, membership.current_state_version_id, input.actorMemberId],
    );

    if (input.nextStatus === 'active') {
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
      `insert into members (public_name, display_name, state)
       values ($1, $2, 'active')
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
