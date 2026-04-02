import type { Pool } from 'pg';
import {
  AppError,
  type CreateMembershipInput,
  type CreateVouchInput,
  type MemberSearchResult,
  type MembershipAdminSummary,
  type MembershipReviewSummary,
  type MembershipState,
  type MembershipSummary,
  type MembershipVouchSummary,
  type ClubMemberSummary,
  type Repository,
  type TransitionMembershipInput,
} from '../app.ts';
import { buildApplicationsRepository } from './applications.ts';
import { buildContainsLikePattern, normalizeSearchQuery } from './search.ts';
import type { ApplyActorContext, DbClient, WithActorContext } from './shared.ts';

type SearchRow = {
  member_id: string;
  public_name: string;
  display_name: string;
  handle: string | null;
  tagline: string | null;
  summary: string | null;
  what_i_do: string | null;
  known_for: string | null;
  services_summary: string | null;
  website_url: string | null;
  shared_clubs: Array<{ id: string; slug: string; name: string }> | null;
};

type MembershipVouchRow = {
  edge_id: string;
  from_member_id: string;
  from_public_name: string;
  from_handle: string | null;
  reason: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
  created_by_member_id: string | null;
};

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
  status: MembershipState;
  state_reason: string | null;
  state_version_no: number;
  state_created_at: string;
  state_created_by_member_id: string | null;
  joined_at: string;
  accepted_covenant_at: string | null;
  metadata: Record<string, unknown> | null;
};

type MembershipReviewRow = MembershipAdminRow & {
  sponsor_active_sponsored_count: number;
  sponsor_sponsored_this_month_count: number;
  vouches: MembershipVouchRow[] | null;
};

type MemberListRow = {
  member_id: string;
  public_name: string;
  display_name: string;
  handle: string | null;
  tagline: string | null;
  summary: string | null;
  what_i_do: string | null;
  known_for: string | null;
  services_summary: string | null;
  website_url: string | null;
  memberships: MembershipSummary[] | null;
};

function normalizeSearchText(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function tokenizeSearchQuery(query: string): string[] {
  return [...new Set(
    normalizeSearchText(query)
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 0),
  )];
}

function scoreMemberSearchRow(row: SearchRow, query: string, tokens: string[]): number {
  const normalizedQuery = normalizeSearchText(query);
  const publicName = normalizeSearchText(row.public_name);
  const displayName = normalizeSearchText(row.display_name);
  const handle = normalizeSearchText(row.handle);
  const tagline = normalizeSearchText(row.tagline);
  const summary = normalizeSearchText(row.summary);
  const whatIDo = normalizeSearchText(row.what_i_do);
  const knownFor = normalizeSearchText(row.known_for);
  const servicesSummary = normalizeSearchText(row.services_summary);

  const primaryFields = [displayName, publicName, handle];
  const secondaryFields = [tagline, whatIDo, knownFor, servicesSummary, summary];

  let score = 0;

  for (const field of primaryFields) {
    if (!field) continue;
    if (field === normalizedQuery) score += 120;
    else if (field.startsWith(normalizedQuery)) score += 80;
    else if (field.includes(normalizedQuery)) score += 40;
  }

  for (const field of secondaryFields) {
    if (!field) continue;
    if (field === normalizedQuery) score += 40;
    else if (field.startsWith(normalizedQuery)) score += 24;
    else if (field.includes(normalizedQuery)) score += 12;
  }

  for (const token of tokens) {
    for (const field of primaryFields) {
      if (!field) continue;
      if (field === token) score += 36;
      else if (field.startsWith(token)) score += 20;
      else if (field.includes(token)) score += 10;
    }

    for (const field of secondaryFields) {
      if (!field) continue;
      if (field === token) score += 12;
      else if (field.startsWith(token)) score += 8;
      else if (field.includes(token)) score += 4;
    }
  }

  return score;
}

function mapMembershipVouchRow(row: MembershipVouchRow): MembershipVouchSummary {
  return {
    edgeId: row.edge_id,
    fromMember: {
      memberId: row.from_member_id,
      publicName: row.from_public_name,
      handle: row.from_handle,
    },
    reason: row.reason,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    createdByMemberId: row.created_by_member_id,
  };
}

function mapMembershipAdminRow(row: MembershipAdminRow): MembershipAdminSummary {
  return {
    membershipId: row.membership_id,
    clubId: row.club_id,
    member: {
      memberId: row.member_id,
      publicName: row.public_name,
      handle: row.handle,
    },
    sponsor: row.sponsor_member_id
      ? {
          memberId: row.sponsor_member_id,
          publicName: row.sponsor_public_name ?? 'Unknown sponsor',
          handle: row.sponsor_handle,
        }
      : null,
    role: row.role,
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

function mapMembershipReviewRow(row: MembershipReviewRow): MembershipReviewSummary {
  return {
    ...mapMembershipAdminRow(row),
    sponsorStats: {
      activeSponsoredCount: Number(row.sponsor_active_sponsored_count ?? 0),
      sponsoredThisMonthCount: Number(row.sponsor_sponsored_this_month_count ?? 0),
    },
    vouches: (row.vouches ?? []).map(mapMembershipVouchRow),
  };
}

function mapMemberListRow(row: MemberListRow): ClubMemberSummary {
  return {
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
  };
}

async function readMembershipAdminSummary(client: DbClient, membershipId: string): Promise<MembershipAdminSummary | null> {
  const result = await client.query<MembershipAdminRow>(
    `
      select
        cnm.id as membership_id,
        cnm.club_id,
        cnm.member_id,
        m.public_name,
        m.handle,
        cnm.sponsor_member_id,
        sponsor.public_name as sponsor_public_name,
        sponsor.handle as sponsor_handle,
        cnm.role,
        cnm.status,
        cnm.state_reason,
        cnm.state_version_no,
        cnm.state_created_at::text as state_created_at,
        cnm.state_created_by_member_id,
        cnm.joined_at::text as joined_at,
        cnm.accepted_covenant_at::text as accepted_covenant_at,
        cnm.metadata
      from app.current_club_memberships cnm
      join app.members m on m.id = cnm.member_id
      left join app.members sponsor on sponsor.id = cnm.sponsor_member_id
      where cnm.id = $1
      limit 1
    `,
    [membershipId],
  );

  return result.rows[0] ? mapMembershipAdminRow(result.rows[0]) : null;
}

async function readMemberships(client: DbClient, input: {
  clubIds: string[];
  limit: number;
  status?: MembershipState;
}): Promise<MembershipAdminSummary[]> {
  if (input.clubIds.length === 0) {
    return [];
  }

  const result = await client.query<MembershipAdminRow>(
    `
      select
        cnm.id as membership_id,
        cnm.club_id,
        cnm.member_id,
        m.public_name,
        m.handle,
        cnm.sponsor_member_id,
        sponsor.public_name as sponsor_public_name,
        sponsor.handle as sponsor_handle,
        cnm.role,
        cnm.status,
        cnm.state_reason,
        cnm.state_version_no,
        cnm.state_created_at::text as state_created_at,
        cnm.state_created_by_member_id,
        cnm.joined_at::text as joined_at,
        cnm.accepted_covenant_at::text as accepted_covenant_at,
        cnm.metadata
      from app.current_club_memberships cnm
      join app.members m on m.id = cnm.member_id
      left join app.members sponsor on sponsor.id = cnm.sponsor_member_id
      where cnm.club_id = any($1::app.short_id[])
        and ($2::app.membership_state is null or cnm.status = $2)
      order by cnm.club_id asc, cnm.state_created_at desc, cnm.id asc
      limit $3
    `,
    [input.clubIds, input.status ?? null, input.limit],
  );

  return result.rows.map(mapMembershipAdminRow);
}

async function readMembershipReviews(client: DbClient, input: {
  clubIds: string[];
  limit: number;
  statuses: MembershipState[];
}): Promise<MembershipReviewSummary[]> {
  if (input.clubIds.length === 0 || input.statuses.length === 0) {
    return [];
  }

  const result = await client.query<MembershipReviewRow>(
    `
      select
        cnm.id as membership_id,
        cnm.club_id,
        cnm.member_id,
        m.public_name,
        m.handle,
        cnm.sponsor_member_id,
        sponsor.public_name as sponsor_public_name,
        sponsor.handle as sponsor_handle,
        cnm.role,
        cnm.status,
        cnm.state_reason,
        cnm.state_version_no,
        cnm.state_created_at::text as state_created_at,
        cnm.state_created_by_member_id,
        cnm.joined_at::text as joined_at,
        cnm.accepted_covenant_at::text as accepted_covenant_at,
        cnm.metadata,
        coalesce(sponsor_stats.active_sponsored_count, 0) as sponsor_active_sponsored_count,
        coalesce(sponsor_stats.sponsored_this_month_count, 0) as sponsor_sponsored_this_month_count,
        coalesce(vouches.vouches, '[]'::jsonb) as vouches
      from app.current_club_memberships cnm
      join app.members m on m.id = cnm.member_id
      left join app.members sponsor on sponsor.id = cnm.sponsor_member_id
      left join lateral (
        select
          count(*) filter (where sponsored.status = 'active')::int as active_sponsored_count,
          count(*) filter (where date_trunc('month', sponsored.joined_at) = date_trunc('month', now()))::int as sponsored_this_month_count
        from app.current_club_memberships sponsored
        where sponsored.club_id = cnm.club_id
          and sponsored.sponsor_member_id = cnm.sponsor_member_id
      ) sponsor_stats on cnm.sponsor_member_id is not null
      left join lateral (
        select jsonb_agg(
          jsonb_build_object(
            'edge_id', e.id,
            'from_member_id', fm.id,
            'from_public_name', fm.public_name,
            'from_handle', fm.handle,
            'reason', e.reason,
            'metadata', e.metadata,
            'created_at', e.created_at::text,
            'created_by_member_id', e.created_by_member_id
          )
          order by e.created_at desc, e.id desc
        ) as vouches
        from app.edges e
        join app.members fm on fm.id = e.from_member_id
        where e.club_id = cnm.club_id
          and e.kind = 'vouched_for'
          and e.to_member_id = cnm.member_id
          and e.archived_at is null
      ) vouches on true
      where cnm.club_id = any($1::app.short_id[])
        and cnm.status = any($2::app.membership_state[])
      order by cnm.club_id asc, cnm.state_created_at desc, cnm.id asc
      limit $3
    `,
    [input.clubIds, input.statuses, input.limit],
  );

  return result.rows.map(mapMembershipReviewRow);
}

async function readMemberSearch(client: DbClient, input: {
  clubIds: string[];
  query: string;
  limit: number;
}): Promise<MemberSearchResult[]> {
  if (input.clubIds.length === 0) {
    return [];
  }

  const trimmedQuery = normalizeSearchQuery(input.query);
  if (trimmedQuery === null) {
    throw new AppError(400, 'invalid_input', 'query must be a non-empty string');
  }
  const tokens = tokenizeSearchQuery(trimmedQuery);
  const likePattern = buildContainsLikePattern(trimmedQuery);
  const candidateLimit = Math.min(Math.max(input.limit * 5, 25), 100);

  const result = await client.query<SearchRow>(
    `
      with scope as (
        select unnest($1::text[])::app.short_id as club_id
      ),
      tokens as (
        select unnest($3::text[]) as token
      )
      select
        m.id as member_id,
        m.public_name,
        coalesce(cmp.display_name, m.public_name) as display_name,
        m.handle,
        cmp.tagline,
        cmp.summary,
        cmp.what_i_do,
        cmp.known_for,
        cmp.services_summary,
        cmp.website_url,
        jsonb_agg(distinct jsonb_build_object('id', n.id, 'slug', n.slug, 'name', n.name))
          filter (where n.id is not null) as shared_clubs
      from scope s
      join app.accessible_club_memberships anm on anm.club_id = s.club_id
      join app.members m on m.id = anm.member_id and m.state = 'active'
      left join app.current_member_profiles cmp on cmp.member_id = m.id
      join app.clubs n on n.id = anm.club_id and n.archived_at is null
      where (
        m.public_name ilike $2 escape '\\'
        or coalesce(cmp.display_name, '') ilike $2 escape '\\'
        or coalesce(m.handle, '') ilike $2 escape '\\'
        or coalesce(cmp.tagline, '') ilike $2 escape '\\'
        or coalesce(cmp.summary, '') ilike $2 escape '\\'
        or coalesce(cmp.what_i_do, '') ilike $2 escape '\\'
        or coalesce(cmp.known_for, '') ilike $2 escape '\\'
        or coalesce(cmp.services_summary, '') ilike $2 escape '\\'
      )
        and not exists (
          select 1
          from tokens t
          where not (
            m.public_name ilike '%' || t.token || '%'
            or coalesce(cmp.display_name, '') ilike '%' || t.token || '%'
            or coalesce(m.handle, '') ilike '%' || t.token || '%'
            or coalesce(cmp.tagline, '') ilike '%' || t.token || '%'
            or coalesce(cmp.summary, '') ilike '%' || t.token || '%'
            or coalesce(cmp.what_i_do, '') ilike '%' || t.token || '%'
            or coalesce(cmp.known_for, '') ilike '%' || t.token || '%'
            or coalesce(cmp.services_summary, '') ilike '%' || t.token || '%'
          )
        )
      group by
        m.id, m.public_name, cmp.display_name, m.handle, cmp.tagline, cmp.summary,
        cmp.what_i_do, cmp.known_for, cmp.services_summary, cmp.website_url
      order by display_name asc, m.id asc
      limit $4
    `,
    [input.clubIds, likePattern, tokens, candidateLimit],
  );

  return result.rows
    .map((row) => ({ row, score: scoreMemberSearchRow(row, trimmedQuery, tokens) }))
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      const displayNameComparison = left.row.display_name.localeCompare(right.row.display_name, 'en', { sensitivity: 'base' });
      if (displayNameComparison !== 0) {
        return displayNameComparison;
      }

      return left.row.member_id.localeCompare(right.row.member_id, 'en', { sensitivity: 'base' });
    })
    .slice(0, input.limit)
    .map(({ row }) => ({
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
      sharedClubs: row.shared_clubs ?? [],
    }));
}

async function readMembers(client: DbClient, input: {
  clubIds: string[];
  limit: number;
}): Promise<ClubMemberSummary[]> {
  if (input.clubIds.length === 0) {
    return [];
  }

  const result = await client.query<MemberListRow>(
    `
      with scope as (
        select unnest($1::text[])::app.short_id as club_id
      )
      select
        m.id as member_id,
        m.public_name,
        coalesce(cmp.display_name, m.public_name) as display_name,
        m.handle,
        cmp.tagline,
        cmp.summary,
        cmp.what_i_do,
        cmp.known_for,
        cmp.services_summary,
        cmp.website_url,
        jsonb_agg(
          distinct jsonb_build_object(
            'membershipId', anm.id,
            'clubId', anm.club_id,
            'slug', n.slug,
            'name', n.name,
            'summary', n.summary,
            'manifestoMarkdown', n.manifesto_markdown,
            'role', anm.role,
            'status', anm.status,
            'sponsorMemberId', anm.sponsor_member_id,
            'joinedAt', anm.joined_at::text
          )
        ) filter (where anm.id is not null) as memberships
      from scope s
      join app.accessible_club_memberships anm on anm.club_id = s.club_id
      join app.members m on m.id = anm.member_id and m.state = 'active'
      join app.clubs n on n.id = anm.club_id and n.archived_at is null
      left join app.current_member_profiles cmp on cmp.member_id = m.id
      group by
        m.id, m.public_name, cmp.display_name, m.handle, cmp.tagline, cmp.summary,
        cmp.what_i_do, cmp.known_for, cmp.services_summary, cmp.website_url
      order by min(n.name) asc, display_name asc, m.id asc
      limit $2
    `,
    [input.clubIds, input.limit],
  );

  return result.rows.map(mapMemberListRow);
}

export function buildAdmissionsRepository({
  pool,
  applyActorContext,
  withActorContext,
}: {
  pool: Pool;
  applyActorContext: ApplyActorContext;
  withActorContext: WithActorContext;
}): Pick<
  Repository,
  | 'listMemberships'
  | 'listApplications'
  | 'listMembershipReviews'
  | 'createApplication'
  | 'createMembership'
  | 'transitionMembershipState'
  | 'transitionApplication'
  | 'searchMembers'
  | 'listMembers'
  | 'createVouch'
  | 'listVouches'
> {
  const applicationsRepository = buildApplicationsRepository({
    pool,
    applyActorContext,
    withActorContext,
  });

  return {
    ...applicationsRepository,

    async listMemberships({ actorMemberId, clubIds, limit, status }) {
      return withActorContext(pool, actorMemberId, clubIds, (client) => readMemberships(client, { clubIds, limit, status }));
    },

    async listMembershipReviews({ actorMemberId, clubIds, limit, statuses }) {
      return withActorContext(pool, actorMemberId, clubIds, (client) => readMembershipReviews(client, { clubIds, limit, statuses }));
    },

    async createMembership(input: CreateMembershipInput): Promise<MembershipAdminSummary | null> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await applyActorContext(client, input.actorMemberId, [input.clubId]);

        const adminScopeResult = await client.query<{ role: MembershipSummary['role'] }>(
          `
            select anm.role
            from app.accessible_club_memberships anm
            where anm.member_id = $1
              and anm.club_id = $2
              and anm.role = 'owner'
            limit 1
          `,
          [input.actorMemberId, input.clubId],
        );

        if (!adminScopeResult.rows[0]) {
          await client.query('rollback');
          return null;
        }

        const actorIsSponsor = input.sponsorMemberId === input.actorMemberId;
        const sponsorScopeResult = await client.query<{ membership_id: string }>(
          `
            select cnm.id as membership_id
            from app.current_club_memberships cnm
            where cnm.club_id = $1
              and cnm.member_id = $2
              and cnm.status = 'active'
            limit 1
          `,
          [input.clubId, input.sponsorMemberId],
        );

        if (!sponsorScopeResult.rows[0] || (!actorIsSponsor && adminScopeResult.rows[0].role !== 'owner')) {
          await client.query('rollback');
          return null;
        }

        const existingResult = await client.query<{ id: string }>(
          `
            select nm.id
            from app.club_memberships nm
            where nm.club_id = $1
              and nm.member_id = $2
            limit 1
          `,
          [input.clubId, input.memberId],
        );

        if (existingResult.rows[0]) {
          throw new AppError(409, 'membership_exists', 'This member already has a membership record in the club');
        }

        const membershipResult = await client.query<{ id: string }>(
          `
            insert into app.club_memberships (
              club_id,
              member_id,
              sponsor_member_id,
              role,
              status,
              joined_at,
              metadata
            )
            select $1, $6, $2, $3, $4, now(), $5::jsonb
            where app.member_is_active($6)
            returning id
          `,
          [
            input.clubId,
            input.sponsorMemberId,
            input.role,
            input.initialStatus,
            JSON.stringify(input.metadata ?? {}),
            input.memberId,
          ],
        );

        const membershipId = membershipResult.rows[0]?.id;
        if (!membershipId) {
          await client.query('rollback');
          return null;
        }

        await client.query(
          `
            insert into app.club_membership_state_versions (
              membership_id,
              status,
              reason,
              version_no,
              created_by_member_id
            )
            values ($1, $2, $3, 1, $4)
          `,
          [membershipId, input.initialStatus, input.reason ?? null, input.actorMemberId],
        );

        await client.query('commit');
        return await withActorContext(pool, input.actorMemberId, [input.clubId], (scopedClient) => readMembershipAdminSummary(scopedClient, membershipId));
      } catch (error) {
        await client.query('rollback');
        if (error && typeof error === 'object' && 'code' in error && error.code === '23514') {
          throw new AppError(400, 'invalid_membership', 'Membership invariants rejected this create request');
        }
        throw error;
      } finally {
        client.release();
      }
    },

    async transitionMembershipState(input: TransitionMembershipInput): Promise<MembershipAdminSummary | null> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await applyActorContext(client, input.actorMemberId, input.accessibleClubIds);

        const membershipResult = await client.query<{
          membership_id: string;
          club_id: string;
          member_id: string;
          current_status: MembershipState;
          current_version_no: number;
          current_state_version_id: string;
        }>(
          `
            select
              cnm.id as membership_id,
              cnm.club_id,
              cnm.member_id,
              cnm.status as current_status,
              cnm.state_version_no as current_version_no,
              cnm.state_version_id as current_state_version_id
            from app.current_club_memberships cnm
            join app.accessible_club_memberships owner_scope
              on owner_scope.club_id = cnm.club_id
             and owner_scope.member_id = $1
             and owner_scope.role = 'owner'
            where cnm.id = $2
              and cnm.club_id = any($3::app.short_id[])
            limit 1
          `,
          [input.actorMemberId, input.membershipId, input.accessibleClubIds],
        );

        const membership = membershipResult.rows[0];
        if (!membership) {
          await client.query('rollback');
          return null;
        }

        if (membership.member_id === input.actorMemberId && input.nextStatus !== 'active' && input.nextStatus !== membership.current_status) {
          throw new AppError(403, 'forbidden', 'Admins may not self-revoke or self-reject through this surface');
        }

        await client.query(
          `
            insert into app.club_membership_state_versions (
              membership_id,
              status,
              reason,
              version_no,
              supersedes_state_version_id,
              created_by_member_id
            )
            values ($1, $2, $3, $4, $5, $6)
          `,
          [
            membership.membership_id,
            input.nextStatus,
            input.reason ?? null,
            Number(membership.current_version_no) + 1,
            membership.current_state_version_id,
            input.actorMemberId,
          ],
        );

        await client.query('commit');
        return await withActorContext(pool, input.actorMemberId, input.accessibleClubIds, (scopedClient) =>
          readMembershipAdminSummary(scopedClient, membership.membership_id),
        );
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async searchMembers({ actorMemberId, clubIds, query, limit }): Promise<MemberSearchResult[]> {
      return withActorContext(pool, actorMemberId, clubIds, (client) => readMemberSearch(client, { clubIds, query, limit }));
    },

    async listMembers({ actorMemberId, clubIds, limit }) {
      return withActorContext(pool, actorMemberId, clubIds, (client) => readMembers(client, { clubIds, limit }));
    },

    async createVouch(input: CreateVouchInput): Promise<MembershipVouchSummary | null> {
      return withActorContext(pool, input.actorMemberId, [input.clubId], async (client) => {
        const result = await client.query<{
          id: string;
          from_member_id: string;
          from_public_name: string;
          from_handle: string | null;
          reason: string;
          metadata: Record<string, unknown>;
          created_at: string;
          created_by_member_id: string | null;
        }>(
          `
            insert into app.edges (club_id, kind, from_member_id, to_member_id, reason, created_by_member_id)
            select $1, 'vouched_for', $2, $3, $4, $2
            where exists (
              select 1 from app.accessible_club_memberships anm
              where anm.member_id = $3 and anm.club_id = $1
            )
            returning
              id,
              from_member_id,
              (select public_name from app.members where id = from_member_id) as from_public_name,
              (select handle from app.members where id = from_member_id) as from_handle,
              reason,
              metadata,
              created_at::text as created_at,
              created_by_member_id
          `,
          [input.clubId, input.actorMemberId, input.targetMemberId, input.reason],
        );

        const row = result.rows[0];
        if (!row) {
          return null;
        }

        return {
          edgeId: row.id,
          fromMember: {
            memberId: row.from_member_id,
            publicName: row.from_public_name,
            handle: row.from_handle,
          },
          reason: row.reason,
          metadata: row.metadata,
          createdAt: row.created_at,
          createdByMemberId: row.created_by_member_id,
        };
      });
    },

    async listVouches(input): Promise<MembershipVouchSummary[]> {
      return withActorContext(pool, input.actorMemberId, input.clubIds, async (client) => {
        const result = await client.query<{
          id: string;
          from_member_id: string;
          from_public_name: string;
          from_handle: string | null;
          reason: string;
          metadata: Record<string, unknown>;
          created_at: string;
          created_by_member_id: string | null;
        }>(
          `
            select
              e.id,
              e.from_member_id,
              fm.public_name as from_public_name,
              fm.handle as from_handle,
              e.reason,
              e.metadata,
              e.created_at::text as created_at,
              e.created_by_member_id
            from app.edges e
            join app.members fm on fm.id = e.from_member_id
            where e.club_id = any($1::app.short_id[])
              and e.kind = 'vouched_for'
              and e.to_member_id = $2
              and e.archived_at is null
            order by e.created_at desc
            limit $3
          `,
          [input.clubIds, input.targetMemberId, input.limit],
        );

        return result.rows.map((row) => ({
          edgeId: row.id,
          fromMember: {
            memberId: row.from_member_id,
            publicName: row.from_public_name,
            handle: row.from_handle,
          },
          reason: row.reason,
          metadata: row.metadata,
          createdAt: row.created_at,
          createdByMemberId: row.created_by_member_id,
        }));
      });
    },
  };
}
