/**
 * Identity domain — membership management.
 *
 * Club memberships, state transitions, member listings, promote/demote.
 */

import type { Pool } from 'pg';
import {
  AppError,
  type CreateMembershipInput,
  type MembershipAdminSummary,
  type MembershipReviewSummary,
  type MembershipState,
  type MembershipSummary,
  type ClubMemberSummary,
  type TransitionMembershipInput,
} from '../contract.ts';
import { withTransaction, type DbClient } from '../db.ts';

type MembershipAdminRow = {
  membership_id: string;
  club_id: string;
  member_id: string;
  public_name: string;
  handle: string | null;
  sponsor_member_id: string | null;
  sponsor_public_name: string | null;
  sponsor_handle: string | null;
  role: MembershipSummary['role'];
  is_owner: boolean;
  status: MembershipState;
  state_reason: string | null;
  state_version_no: number;
  state_created_at: string;
  state_created_by_member_id: string | null;
  joined_at: string;
  accepted_covenant_at: string | null;
  metadata: Record<string, unknown> | null;
};

function mapMembershipRow(row: MembershipAdminRow): MembershipAdminSummary {
  return {
    membershipId: row.membership_id,
    clubId: row.club_id,
    member: { memberId: row.member_id, publicName: row.public_name, handle: row.handle },
    sponsor: row.sponsor_member_id
      ? { memberId: row.sponsor_member_id, publicName: row.sponsor_public_name ?? 'Unknown sponsor', handle: row.sponsor_handle }
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
  m.public_name, m.handle,
  cnm.sponsor_member_id,
  sponsor.public_name as sponsor_public_name,
  sponsor.handle as sponsor_handle,
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
  from app.current_memberships cnm
  join app.members m on m.id = cnm.member_id
  join app.clubs n on n.id = cnm.club_id
  left join app.members sponsor on sponsor.id = cnm.sponsor_member_id
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
       select 1 from app.current_memberships
       where club_id = $1 and member_id = $2 and role = 'clubadmin'
     ) as ok`,
    [clubId, memberId],
  );
  return result.rows[0]?.ok === true;
}

async function hasLiveAccess(client: DbClient, membershipId: string): Promise<boolean> {
  const result = await client.query<{ has_access: boolean }>(
    `select exists(
       select 1 from app.memberships where id = $1 and is_comped = true
       union all
       select 1 from app.subscriptions
       where membership_id = $1
         and status in ('trialing', 'active', 'past_due')
         and coalesce(ended_at, 'infinity'::timestamptz) > now()
         and coalesce(current_period_end, 'infinity'::timestamptz) > now()
     ) as has_access`,
    [membershipId],
  );
  return result.rows[0]?.has_access === true;
}

async function setComped(client: DbClient, membershipId: string, compedByMemberId: string): Promise<void> {
  await client.query(
    `update app.memberships set is_comped = true, comped_at = now(), comped_by_member_id = $2
     where id = $1 and is_comped = false`,
    [membershipId, compedByMemberId],
  );
}

// ── Exported functions ────────────────────────────────────────

export async function listMemberships(pool: Pool, input: {
  clubIds: string[]; limit: number; status?: MembershipState;
}): Promise<MembershipAdminSummary[]> {
  if (input.clubIds.length === 0) return [];
  const result = await pool.query<MembershipAdminRow>(
    `select ${MEMBERSHIP_SELECT} ${MEMBERSHIP_FROM}
     where cnm.club_id = any($1::app.short_id[])
       and ($2::app.membership_state is null or cnm.status = $2)
     order by cnm.club_id asc, cnm.state_created_at desc, cnm.id asc
     limit $3`,
    [input.clubIds, input.status ?? null, input.limit],
  );
  return result.rows.map(mapMembershipRow);
}

/**
 * Returns reviews with sponsorStats but empty vouches array.
 * The composition layer fills in vouches from the clubs module.
 */
export async function listMembershipReviews(pool: Pool, input: {
  clubIds: string[]; limit: number; statuses: MembershipState[];
}): Promise<MembershipReviewSummary[]> {
  if (input.clubIds.length === 0 || input.statuses.length === 0) return [];

  const result = await pool.query<MembershipAdminRow & {
    sponsor_active_sponsored_count: number;
    sponsor_sponsored_this_month_count: number;
  }>(
    `with sponsor_stats as (
       select
         sponsored.sponsor_member_id, sponsored.club_id,
         count(*) filter (where sponsored.status = 'active')::int as active_sponsored_count,
         count(*) filter (where date_trunc('month', sponsored.joined_at) = date_trunc('month', now()))::int as sponsored_this_month_count
       from app.current_memberships sponsored
       where sponsored.club_id = any($1::app.short_id[])
         and sponsored.sponsor_member_id is not null
       group by sponsored.sponsor_member_id, sponsored.club_id
     )
     select ${MEMBERSHIP_SELECT},
       coalesce(ss.active_sponsored_count, 0) as sponsor_active_sponsored_count,
       coalesce(ss.sponsored_this_month_count, 0) as sponsor_sponsored_this_month_count
     ${MEMBERSHIP_FROM}
     left join sponsor_stats ss on ss.sponsor_member_id = cnm.sponsor_member_id and ss.club_id = cnm.club_id
     where cnm.club_id = any($1::app.short_id[])
       and cnm.status = any($2::app.membership_state[])
     order by cnm.club_id asc, cnm.state_created_at desc, cnm.id asc
     limit $3`,
    [input.clubIds, input.statuses, input.limit],
  );

  return result.rows.map((row) => ({
    ...mapMembershipRow(row),
    sponsorStats: {
      activeSponsoredCount: Number(row.sponsor_active_sponsored_count ?? 0),
      sponsoredThisMonthCount: Number(row.sponsor_sponsored_this_month_count ?? 0),
    },
    vouches: [], // filled by composition layer
  }));
}

export async function listMembers(pool: Pool, input: {
  clubIds: string[]; limit: number;
}): Promise<ClubMemberSummary[]> {
  if (input.clubIds.length === 0) return [];

  const result = await pool.query<{
    member_id: string; public_name: string; display_name: string;
    handle: string | null; tagline: string | null; summary: string | null;
    what_i_do: string | null; known_for: string | null;
    services_summary: string | null; website_url: string | null;
    memberships: MembershipSummary[] | null;
  }>(
    `with scope as (select unnest($1::text[])::app.short_id as club_id)
     select
       m.id as member_id, m.public_name,
       coalesce(cmp.display_name, m.public_name) as display_name,
       m.handle, cmp.tagline, cmp.summary, cmp.what_i_do, cmp.known_for,
       cmp.services_summary, cmp.website_url,
       jsonb_agg(distinct jsonb_build_object(
         'membershipId', anm.id, 'clubId', anm.club_id, 'slug', n.slug,
         'name', n.name, 'summary', n.summary, 'role', anm.role,
         'isOwner', (n.owner_member_id = anm.member_id), 'status', anm.status,
         'sponsorMemberId', anm.sponsor_member_id, 'joinedAt', anm.joined_at::text
       )) filter (where anm.id is not null) as memberships
     from scope s
     join app.accessible_memberships anm on anm.club_id = s.club_id
     join app.members m on m.id = anm.member_id and m.state = 'active'
     join app.clubs n on n.id = anm.club_id and n.archived_at is null
     left join app.current_profiles cmp on cmp.member_id = m.id
     group by m.id, m.public_name, cmp.display_name, m.handle, cmp.tagline,
              cmp.summary, cmp.what_i_do, cmp.known_for, cmp.services_summary, cmp.website_url
     order by min(n.name) asc, display_name asc, m.id asc
     limit $2`,
    [input.clubIds, input.limit],
  );

  return result.rows.map((row) => ({
    memberId: row.member_id,
    publicName: row.public_name,
    displayName: row.display_name,
    handle: row.handle,
    tagline: row.tagline,
    summary: row.summary,
    whatIDo: row.what_i_do,
    knownFor: row.known_for,
    servicesSummary: row.services_summary,
    websiteUrl: row.website_url,
    memberships: row.memberships ?? [],
  }));
}

export async function createMembership(pool: Pool, input: CreateMembershipInput): Promise<MembershipAdminSummary | null> {
  return withTransaction(pool, async (client) => {
    if (!input.skipClubAdminCheck && !(await isClubAdmin(client, input.actorMemberId, input.clubId))) return null;

    // Verify sponsor exists in club.
    // When the club admin check is skipped (superadmin path), always validate —
    // the actor may not be a member of this club at all.
    if (input.skipClubAdminCheck || input.sponsorMemberId !== input.actorMemberId) {
      const sponsorCheck = await client.query<{ id: string }>(
        `select cnm.id from app.current_memberships cnm
         where cnm.club_id = $1 and cnm.member_id = $2 and cnm.status = 'active' limit 1`,
        [input.clubId, input.sponsorMemberId],
      );
      if (!sponsorCheck.rows[0]) return null;
    }

    // Check no existing membership
    const existing = await client.query<{ id: string }>(
      `select id from app.memberships where club_id = $1 and member_id = $2 limit 1`,
      [input.clubId, input.memberId],
    );
    if (existing.rows[0]) {
      throw new AppError(409, 'membership_exists', 'This member already has a membership record in the club');
    }

    // Insert membership (verify target member is active)
    const membershipResult = await client.query<{ id: string }>(
      `insert into app.memberships (club_id, member_id, sponsor_member_id, role, status, joined_at, metadata, source_admission_id)
       select $1::app.short_id, $6::app.short_id, $2::app.short_id, $3::app.membership_role, $4::app.membership_state, now(), $5::jsonb, $7
       where exists (select 1 from app.members where id = $6::app.short_id and state = 'active')
       returning id`,
      [input.clubId, input.sponsorMemberId, input.role, input.initialStatus, JSON.stringify(input.metadata ?? {}), input.memberId, input.sourceAdmissionId ?? null],
    );

    const membershipId = membershipResult.rows[0]?.id;
    if (!membershipId) return null;

    await client.query(
      `insert into app.membership_state_versions (membership_id, status, reason, version_no, created_by_member_id)
       values ($1, $2, $3, 1, $4)`,
      [membershipId, input.initialStatus, input.reason ?? null, input.actorMemberId],
    );

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
       from app.current_memberships cnm
       where cnm.id = $1 and cnm.club_id = any($2::app.short_id[])
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
      `insert into app.membership_state_versions
       (membership_id, status, reason, version_no, supersedes_state_version_id, created_by_member_id)
       values ($1, $2, $3, $4, $5, $6)`,
      [membership.membership_id, input.nextStatus, input.reason ?? null,
       Number(membership.current_version_no) + 1, membership.current_state_version_id, input.actorMemberId],
    );

    if (input.nextStatus === 'active') {
      if (!(await hasLiveAccess(client, membership.membership_id))) {
        await setComped(client, membership.membership_id, input.actorMemberId);
      }
    }

    return readMembershipSummary(client, membership.membership_id);
  });
}

export async function promoteMemberToAdmin(pool: Pool, input: {
  actorMemberId: string; clubId: string; memberId: string;
}): Promise<MembershipAdminSummary | null> {
  return withTransaction(pool, async (client) => {
    const result = await client.query<{ id: string; role: string }>(
      `select cnm.id, cnm.role from app.current_memberships cnm
       where cnm.club_id = $1 and cnm.member_id = $2 and cnm.status = 'active' limit 1`,
      [input.clubId, input.memberId],
    );
    const membership = result.rows[0];
    if (!membership) return null;
    if (membership.role !== 'clubadmin') {
      await client.query(`update app.memberships set role = 'clubadmin' where id = $1`, [membership.id]);
    }
    return readMembershipSummary(client, membership.id);
  });
}

export async function demoteMemberFromAdmin(pool: Pool, input: {
  actorMemberId: string; clubId: string; memberId: string;
}): Promise<MembershipAdminSummary | null> {
  return withTransaction(pool, async (client) => {
    const ownerCheck = await client.query<{ owner_member_id: string }>(
      `select owner_member_id from app.clubs where id = $1 limit 1`,
      [input.clubId],
    );
    if (ownerCheck.rows[0]?.owner_member_id === input.memberId) {
      throw new AppError(403, 'forbidden', 'Cannot demote the club owner');
    }

    const result = await client.query<{ id: string; role: string }>(
      `select cnm.id, cnm.role from app.current_memberships cnm
       where cnm.club_id = $1 and cnm.member_id = $2 and cnm.status = 'active' limit 1`,
      [input.clubId, input.memberId],
    );
    const membership = result.rows[0];
    if (!membership) return null;
    if (membership.role === 'clubadmin') {
      const ownerId = ownerCheck.rows[0]?.owner_member_id ?? null;
      await client.query(
        `update app.memberships set role = 'member', sponsor_member_id = coalesce(sponsor_member_id, $2) where id = $1`,
        [membership.id, ownerId],
      );
    }
    return readMembershipSummary(client, membership.id);
  });
}

export { setComped };
export { hasLiveAccess };

/**
 * Create a member record from an admission (outsider acceptance).
 * Returns the new member ID.
 */
export async function createMemberFromAdmission(pool: Pool, input: {
  name: string; email: string; displayName: string; details: Record<string, unknown>;
  admissionId: string;
}): Promise<string> {
  return withTransaction(pool, async (client) => {
    // Generate a handle from the name
    const baseHandle = input.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 30) || 'member';
    const suffix = Math.random().toString(36).slice(2, 8);
    const handle = `${baseHandle}-${suffix}`;

    // Atomic idempotency via no-op upsert. ON CONFLICT ... DO UPDATE SET id = id
    // is a no-op that makes the conflicting row visible to RETURNING in the same
    // statement, which avoids the snapshot-isolation gap of DO NOTHING + fallback SELECT.
    const memberResult = await client.query<{ id: string; already_existed: boolean }>(
      `insert into app.members (public_name, handle, state, source_admission_id)
       values ($1, $2, 'active', $3)
       on conflict (source_admission_id) where source_admission_id is not null
       do update set id = app.members.id
       returning id, (xmax <> 0) as already_existed`,
      [input.name, handle, input.admissionId],
    );
    const row = memberResult.rows[0];
    if (!row) throw new AppError(500, 'member_creation_failed', 'Failed to create or find member for admission');

    // If this member already existed from a prior attempt, skip profile/contact creation
    if (row.already_existed) {
      return row.id;
    }

    const memberId = row.id;

    // Create initial profile version
    await client.query(
      `insert into app.profile_versions (member_id, version_no, display_name)
       values ($1, 1, $2)`,
      [memberId, input.displayName],
    );

    // Store private contact email
    if (input.email) {
      await client.query(
        `insert into app.private_contacts (member_id, email) values ($1, $2)`,
        [memberId, input.email],
      );
    }

    return memberId;
  });
}

/**
 * Create a member record directly (superadmin bypass, no admission).
 * Returns the new member ID, handle, and a bearer token.
 */
export async function createMemberDirect(pool: Pool, input: {
  actorMemberId: string;
  publicName: string;
  handle?: string | null;
  email?: string | null;
}): Promise<{ memberId: string; publicName: string; handle: string; bearerToken: string }> {
  const { buildBearerToken } = await import('../token.ts');

  return withTransaction(pool, async (client) => {
    // Generate handle if not provided
    const baseHandle = (input.handle ?? input.publicName)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 30) || 'member';
    const suffix = Math.random().toString(36).slice(2, 8);
    const handle = input.handle ?? `${baseHandle}-${suffix}`;

    let memberResult;
    try {
      memberResult = await client.query<{ id: string; handle: string }>(
        `insert into app.members (public_name, handle, state)
         values ($1, $2, 'active')
         returning id, handle`,
        [input.publicName, handle],
      );
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505' &&
          'constraint' in error && typeof error.constraint === 'string' && error.constraint.includes('handle')) {
        throw new AppError(409, 'handle_conflict', 'A member with that handle already exists');
      }
      throw error;
    }
    const row = memberResult.rows[0];
    if (!row) throw new AppError(500, 'member_creation_failed', 'Failed to create member');

    const memberId = row.id;

    // Create initial profile version
    await client.query(
      `insert into app.profile_versions (member_id, version_no, display_name)
       values ($1, 1, $2)`,
      [memberId, input.publicName],
    );

    // Store private contact email
    if (input.email) {
      await client.query(
        `insert into app.private_contacts (member_id, email) values ($1, $2)`,
        [memberId, input.email],
      );
    }

    // Issue bearer token
    const token = buildBearerToken();
    await client.query(
      `insert into app.bearer_tokens (id, member_id, label, token_hash, metadata)
       values ($1, $2, $3, $4, '{}'::jsonb)`,
      [token.tokenId, memberId, 'superadmin-issued', token.tokenHash],
    );

    return {
      memberId,
      publicName: input.publicName,
      handle: row.handle,
      bearerToken: token.bearerToken,
    };
  });
}

/**
 * Create a membership as superadmin (bypasses club admin check).
 * If sponsorMemberId is not provided, falls back to the club owner.
 */
export async function createMembershipAsSuperadmin(pool: Pool, input: {
  actorMemberId: string;
  clubId: string;
  memberId: string;
  role: 'member' | 'clubadmin';
  sponsorMemberId?: string | null;
  initialStatus: Extract<MembershipState, 'invited' | 'pending_review' | 'active' | 'payment_pending'>;
  reason?: string | null;
}): Promise<MembershipAdminSummary | null> {
  return withTransaction(pool, async (client) => {
    // Resolve sponsor: use provided, fall back to club owner
    let sponsorMemberId = input.sponsorMemberId ?? null;
    const clubResult = await client.query<{ owner_member_id: string }>(
      `select owner_member_id from app.clubs where id = $1 and archived_at is null limit 1`,
      [input.clubId],
    );
    if (!clubResult.rows[0]) {
      throw new AppError(404, 'not_found', 'Club not found or archived');
    }
    if (!sponsorMemberId) {
      sponsorMemberId = clubResult.rows[0].owner_member_id;
    }

    // Validate explicit sponsor exists and has an active membership in the club
    if (input.sponsorMemberId) {
      const sponsorCheck = await client.query<{ id: string }>(
        `select cnm.id from app.current_memberships cnm
         where cnm.club_id = $1 and cnm.member_id = $2 and cnm.status = 'active' limit 1`,
        [input.clubId, input.sponsorMemberId],
      );
      if (!sponsorCheck.rows[0]) {
        throw new AppError(404, 'sponsor_not_found', 'Sponsor not found or does not have an active membership in this club');
      }
    }

    // Check no existing membership
    const existing = await client.query<{ id: string }>(
      `select id from app.memberships where club_id = $1 and member_id = $2 limit 1`,
      [input.clubId, input.memberId],
    );
    if (existing.rows[0]) {
      throw new AppError(409, 'membership_exists', 'This member already has a membership record in the club');
    }

    // For clubadmin role, sponsor_member_id can be null
    const effectiveSponsor = input.role === 'clubadmin' ? null : sponsorMemberId;

    // Insert membership (verify target member is active)
    const membershipResult = await client.query<{ id: string }>(
      `insert into app.memberships (club_id, member_id, sponsor_member_id, role, status, joined_at, metadata)
       select $1::app.short_id, $2::app.short_id, $3::app.short_id, $4::app.membership_role, $5::app.membership_state, now(), '{}'::jsonb
       where exists (select 1 from app.members where id = $2::app.short_id and state = 'active')
       returning id`,
      [input.clubId, input.memberId, effectiveSponsor, input.role, input.initialStatus],
    );

    const membershipId = membershipResult.rows[0]?.id;
    if (!membershipId) return null;

    await client.query(
      `insert into app.membership_state_versions (membership_id, status, reason, version_no, created_by_member_id)
       values ($1, $2, $3, 1, $4)`,
      [membershipId, input.initialStatus, input.reason ?? null, input.actorMemberId],
    );

    if (input.initialStatus === 'active') {
      await setComped(client, membershipId, input.actorMemberId);
    }

    return readMembershipSummary(client, membershipId);
  });
}

/**
 * Get member name and email for admission workflow.
 */
export async function getMemberPublicContact(pool: Pool, memberId: string): Promise<{
  memberName: string; email: string | null;
} | null> {
  const result = await pool.query<{ public_name: string; email: string | null }>(
    `select m.public_name, mpc.email
     from app.members m
     left join app.private_contacts mpc on mpc.member_id = m.id
     where m.id = $1 limit 1`,
    [memberId],
  );
  if (!result.rows[0]) return null;
  return { memberName: result.rows[0].public_name, email: result.rows[0].email };
}
