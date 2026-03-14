import { Pool, type PoolClient } from 'pg';
import {
  AppError,
  type ApplicationStatus,
  type ApplicationSummary,
  type CreateApplicationInput,
  type CreateMembershipInput,
  type MemberSearchResult,
  type MembershipAdminSummary,
  type MembershipReviewSummary,
  type MembershipState,
  type MembershipSummary,
  type MembershipVouchSummary,
  type NetworkMemberSummary,
  type Repository,
  type TransitionApplicationInput,
  type TransitionMembershipInput,
} from '../app.ts';

type DbClient = Pool | PoolClient;

type ApplyActorContext = (
  client: DbClient,
  actorMemberId: string,
  networkIds: string[],
  options?: { deliveryWorkerScope?: boolean },
) => Promise<void>;

type WithActorContext = <T>(
  pool: Pool,
  actorMemberId: string,
  networkIds: string[],
  fn: (client: PoolClient) => Promise<T>,
) => Promise<T>;

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
  shared_networks: Array<{ id: string; slug: string; name: string }> | null;
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
  network_id: string;
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

type ApplicationRow = {
  application_id: string;
  network_id: string;
  applicant_member_id: string;
  applicant_public_name: string;
  applicant_handle: string | null;
  sponsor_member_id: string | null;
  sponsor_public_name: string | null;
  sponsor_handle: string | null;
  membership_id: string | null;
  linked_membership_status: MembershipState | null;
  linked_membership_accepted_covenant_at: string | null;
  path: 'sponsored' | 'outside';
  intake_kind: 'fit_check' | 'advice_call' | 'other';
  intake_price_amount: string | number | null;
  intake_price_currency: string | null;
  intake_booking_url: string | null;
  intake_booked_at: string | null;
  intake_completed_at: string | null;
  status: ApplicationStatus;
  notes: string | null;
  version_no: number;
  version_created_at: string;
  version_created_by_member_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
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
    networkId: row.network_id,
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

function mapApplicationRow(row: ApplicationRow): ApplicationSummary {
  return {
    applicationId: row.application_id,
    networkId: row.network_id,
    applicant: {
      memberId: row.applicant_member_id,
      publicName: row.applicant_public_name,
      handle: row.applicant_handle,
    },
    sponsor: row.sponsor_member_id
      ? {
          memberId: row.sponsor_member_id,
          publicName: row.sponsor_public_name ?? 'Unknown sponsor',
          handle: row.sponsor_handle,
        }
      : null,
    membershipId: row.membership_id,
    activation: {
      linkedMembershipId: row.membership_id,
      membershipStatus: row.linked_membership_status,
      acceptedCovenantAt: row.linked_membership_accepted_covenant_at,
      readyForActivation: row.status === 'accepted' && row.membership_id !== null && row.linked_membership_status === 'pending_review',
    },
    path: row.path,
    intake: {
      kind: row.intake_kind,
      price: {
        amount: row.intake_price_amount === null ? null : Number(row.intake_price_amount),
        currency: row.intake_price_currency,
      },
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
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
  };
}

function mapMemberListRow(row: MemberListRow): NetworkMemberSummary {
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
        cnm.network_id,
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
      from app.current_network_memberships cnm
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
  networkIds: string[];
  limit: number;
  status?: MembershipState;
}): Promise<MembershipAdminSummary[]> {
  if (input.networkIds.length === 0) {
    return [];
  }

  const result = await client.query<MembershipAdminRow>(
    `
      select
        cnm.id as membership_id,
        cnm.network_id,
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
      from app.current_network_memberships cnm
      join app.members m on m.id = cnm.member_id
      left join app.members sponsor on sponsor.id = cnm.sponsor_member_id
      where cnm.network_id = any($1::app.short_id[])
        and ($2::app.membership_state is null or cnm.status = $2)
      order by cnm.network_id asc, cnm.state_created_at desc, cnm.id asc
      limit $3
    `,
    [input.networkIds, input.status ?? null, input.limit],
  );

  return result.rows.map(mapMembershipAdminRow);
}

async function readMembershipReviews(client: DbClient, input: {
  networkIds: string[];
  limit: number;
  statuses: MembershipState[];
}): Promise<MembershipReviewSummary[]> {
  if (input.networkIds.length === 0 || input.statuses.length === 0) {
    return [];
  }

  const result = await client.query<MembershipReviewRow>(
    `
      select
        cnm.id as membership_id,
        cnm.network_id,
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
      from app.current_network_memberships cnm
      join app.members m on m.id = cnm.member_id
      left join app.members sponsor on sponsor.id = cnm.sponsor_member_id
      left join lateral (
        select
          count(*) filter (where sponsored.status = 'active')::int as active_sponsored_count,
          count(*) filter (where date_trunc('month', sponsored.joined_at) = date_trunc('month', now()))::int as sponsored_this_month_count
        from app.current_network_memberships sponsored
        where sponsored.network_id = cnm.network_id
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
        where e.network_id = cnm.network_id
          and e.kind = 'vouched_for'
          and e.to_member_id = cnm.member_id
          and e.archived_at is null
      ) vouches on true
      where cnm.network_id = any($1::app.short_id[])
        and cnm.status = any($2::app.membership_state[])
      order by cnm.network_id asc, cnm.state_created_at desc, cnm.id asc
      limit $3
    `,
    [input.networkIds, input.statuses, input.limit],
  );

  return result.rows.map(mapMembershipReviewRow);
}

async function readApplications(client: DbClient, input: {
  networkIds: string[];
  limit: number;
  statuses?: ApplicationStatus[];
}): Promise<ApplicationSummary[]> {
  if (input.networkIds.length === 0) {
    return [];
  }

  const result = await client.query<ApplicationRow>(
    `
      select
        ca.id as application_id,
        ca.network_id,
        ca.applicant_member_id,
        applicant.public_name as applicant_public_name,
        applicant.handle as applicant_handle,
        ca.sponsor_member_id,
        sponsor.public_name as sponsor_public_name,
        sponsor.handle as sponsor_handle,
        ca.membership_id,
        cnm.status as linked_membership_status,
        cnm.accepted_covenant_at::text as linked_membership_accepted_covenant_at,
        ca.path,
        ca.intake_kind,
        ca.intake_price_amount,
        ca.intake_price_currency,
        ca.intake_booking_url,
        ca.intake_booked_at::text as intake_booked_at,
        ca.intake_completed_at::text as intake_completed_at,
        ca.status,
        ca.notes,
        ca.version_no,
        ca.version_created_at::text as version_created_at,
        ca.version_created_by_member_id,
        ca.metadata,
        ca.created_at::text as created_at
      from app.current_applications ca
      join app.members applicant on applicant.id = ca.applicant_member_id
      left join app.members sponsor on sponsor.id = ca.sponsor_member_id
      left join app.current_network_memberships cnm on cnm.id = ca.membership_id
      where ca.network_id = any($1::app.short_id[])
        and ($2::app.application_status[] is null or ca.status = any($2::app.application_status[]))
      order by ca.version_created_at desc, ca.id asc
      limit $3
    `,
    [input.networkIds, input.statuses ?? null, input.limit],
  );

  return result.rows.map(mapApplicationRow);
}

async function readApplicationSummary(client: DbClient, applicationId: string): Promise<ApplicationSummary | null> {
  const result = await client.query<ApplicationRow>(
    `
      select
        ca.id as application_id,
        ca.network_id,
        ca.applicant_member_id,
        applicant.public_name as applicant_public_name,
        applicant.handle as applicant_handle,
        ca.sponsor_member_id,
        sponsor.public_name as sponsor_public_name,
        sponsor.handle as sponsor_handle,
        ca.membership_id,
        cnm.status as linked_membership_status,
        cnm.accepted_covenant_at::text as linked_membership_accepted_covenant_at,
        ca.path,
        ca.intake_kind,
        ca.intake_price_amount,
        ca.intake_price_currency,
        ca.intake_booking_url,
        ca.intake_booked_at::text as intake_booked_at,
        ca.intake_completed_at::text as intake_completed_at,
        ca.status,
        ca.notes,
        ca.version_no,
        ca.version_created_at::text as version_created_at,
        ca.version_created_by_member_id,
        ca.metadata,
        ca.created_at::text as created_at
      from app.current_applications ca
      join app.members applicant on applicant.id = ca.applicant_member_id
      left join app.members sponsor on sponsor.id = ca.sponsor_member_id
      left join app.current_network_memberships cnm on cnm.id = ca.membership_id
      where ca.id = $1
      limit 1
    `,
    [applicationId],
  );

  return result.rows[0] ? mapApplicationRow(result.rows[0]) : null;
}

async function readMemberSearch(client: DbClient, input: {
  networkIds: string[];
  query: string;
  limit: number;
}): Promise<MemberSearchResult[]> {
  if (input.networkIds.length === 0) {
    return [];
  }

  const trimmedQuery = input.query.trim();
  const tokens = tokenizeSearchQuery(trimmedQuery);
  const likePattern = `%${trimmedQuery}%`;
  const candidateLimit = Math.min(Math.max(input.limit * 5, 25), 100);

  const result = await client.query<SearchRow>(
    `
      with scope as (
        select unnest($1::text[])::app.short_id as network_id
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
          filter (where n.id is not null) as shared_networks
      from scope s
      join app.accessible_network_memberships anm on anm.network_id = s.network_id
      join app.members m on m.id = anm.member_id and m.state = 'active'
      left join app.current_member_profiles cmp on cmp.member_id = m.id
      join app.networks n on n.id = anm.network_id and n.archived_at is null
      where (
        m.public_name ilike $2
        or coalesce(cmp.display_name, '') ilike $2
        or coalesce(m.handle, '') ilike $2
        or coalesce(cmp.tagline, '') ilike $2
        or coalesce(cmp.summary, '') ilike $2
        or coalesce(cmp.what_i_do, '') ilike $2
        or coalesce(cmp.known_for, '') ilike $2
        or coalesce(cmp.services_summary, '') ilike $2
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
    [input.networkIds, likePattern, tokens, candidateLimit],
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
      sharedNetworks: row.shared_networks ?? [],
    }));
}

async function readMembers(client: DbClient, input: {
  networkIds: string[];
  limit: number;
}): Promise<NetworkMemberSummary[]> {
  if (input.networkIds.length === 0) {
    return [];
  }

  const result = await client.query<MemberListRow>(
    `
      with scope as (
        select unnest($1::text[])::app.short_id as network_id
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
            'networkId', anm.network_id,
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
      join app.accessible_network_memberships anm on anm.network_id = s.network_id
      join app.members m on m.id = anm.member_id and m.state = 'active'
      join app.networks n on n.id = anm.network_id and n.archived_at is null
      left join app.current_member_profiles cmp on cmp.member_id = m.id
      group by
        m.id, m.public_name, cmp.display_name, m.handle, cmp.tagline, cmp.summary,
        cmp.what_i_do, cmp.known_for, cmp.services_summary, cmp.website_url
      order by min(n.name) asc, display_name asc, m.id asc
      limit $2
    `,
    [input.networkIds, input.limit],
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
> {
  return {
    async listMemberships({ actorMemberId, networkIds, limit, status }) {
      return withActorContext(pool, actorMemberId, networkIds, (client) => readMemberships(client, { networkIds, limit, status }));
    },

    async listApplications({ actorMemberId, networkIds, limit, statuses }) {
      return withActorContext(pool, actorMemberId, networkIds, (client) => readApplications(client, { networkIds, limit, statuses }));
    },

    async listMembershipReviews({ actorMemberId, networkIds, limit, statuses }) {
      return withActorContext(pool, actorMemberId, networkIds, (client) => readMembershipReviews(client, { networkIds, limit, statuses }));
    },

    async createApplication(input: CreateApplicationInput): Promise<ApplicationSummary | null> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await applyActorContext(client, input.actorMemberId, [input.networkId]);

        const ownerScopeResult = await client.query<{ membership_id: string }>(
          `
            select anm.id as membership_id
            from app.accessible_network_memberships anm
            where anm.member_id = $1
              and anm.network_id = $2
              and anm.role = 'owner'
            limit 1
          `,
          [input.actorMemberId, input.networkId],
        );

        if (!ownerScopeResult.rows[0]) {
          await client.query('rollback');
          return null;
        }

        const path = input.path;
        if (path === 'sponsored' && !input.sponsorMemberId) {
          throw new AppError(400, 'invalid_application', 'Sponsored applications require sponsorMemberId');
        }

        const sponsorResult = input.sponsorMemberId
          ? await client.query<{ member_id: string }>(
              `
                select cnm.member_id
                from app.current_network_memberships cnm
                where cnm.network_id = $1
                  and cnm.member_id = $2
                  and cnm.status = 'active'
                limit 1
              `,
              [input.networkId, input.sponsorMemberId],
            )
          : { rows: [] };

        if (input.sponsorMemberId && !sponsorResult.rows[0]) {
          await client.query('rollback');
          return null;
        }

        const membershipResult = input.membershipId
          ? await client.query<{ membership_id: string }>(
              `
                select cnm.id as membership_id
                from app.current_network_memberships cnm
                where cnm.id = $1
                  and cnm.network_id = $2
                  and cnm.member_id = $3
                limit 1
              `,
              [input.membershipId, input.networkId, input.applicantMemberId],
            )
          : { rows: [] };

        if (input.membershipId && !membershipResult.rows[0]) {
          await client.query('rollback');
          return null;
        }

        const applicationResult = await client.query<{ application_id: string }>(
          `
            with inserted as (
              insert into app.applications (
                network_id,
                applicant_member_id,
                sponsor_member_id,
                membership_id,
                path,
                metadata
              )
              select $1, $2, $3, $4, $5, $6::jsonb
              where app.member_is_active($2)
              returning id as application_id
            ), version_insert as (
              insert into app.application_versions (
                application_id,
                status,
                notes,
                intake_kind,
                intake_price_amount,
                intake_price_currency,
                intake_booking_url,
                intake_booked_at,
                intake_completed_at,
                version_no,
                created_by_member_id
              )
              select
                application_id,
                $7,
                $8,
                $9,
                $10,
                $11,
                $12,
                $13,
                $14,
                1,
                $15
              from inserted
            )
            select application_id
            from inserted
          `,
          [
            input.networkId,
            input.applicantMemberId,
            input.sponsorMemberId ?? null,
            input.membershipId ?? null,
            input.path,
            JSON.stringify(input.metadata ?? {}),
            input.initialStatus,
            input.notes ?? null,
            input.intake.kind ?? (path === 'sponsored' ? 'fit_check' : 'advice_call'),
            input.intake.price?.amount ?? null,
            input.intake.price?.currency ?? 'GBP',
            input.intake.bookingUrl ?? null,
            input.intake.bookedAt ?? null,
            input.intake.completedAt ?? null,
            input.actorMemberId,
          ],
        );

        const applicationId = applicationResult.rows[0]?.application_id;
        if (!applicationId) {
          await client.query('rollback');
          return null;
        }

        await client.query('commit');
        return await withActorContext(pool, input.actorMemberId, [input.networkId], (scopedClient) => readApplicationSummary(scopedClient, applicationId));
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async createMembership(input: CreateMembershipInput): Promise<MembershipAdminSummary | null> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await applyActorContext(client, input.actorMemberId, [input.networkId]);

        const adminScopeResult = await client.query<{ role: MembershipSummary['role'] }>(
          `
            select anm.role
            from app.accessible_network_memberships anm
            where anm.member_id = $1
              and anm.network_id = $2
              and anm.role = 'owner'
            limit 1
          `,
          [input.actorMemberId, input.networkId],
        );

        if (!adminScopeResult.rows[0]) {
          await client.query('rollback');
          return null;
        }

        const actorIsSponsor = input.sponsorMemberId === input.actorMemberId;
        const sponsorScopeResult = await client.query<{ membership_id: string }>(
          `
            select cnm.id as membership_id
            from app.current_network_memberships cnm
            where cnm.network_id = $1
              and cnm.member_id = $2
              and cnm.status = 'active'
            limit 1
          `,
          [input.networkId, input.sponsorMemberId],
        );

        if (!sponsorScopeResult.rows[0] || (!actorIsSponsor && adminScopeResult.rows[0].role !== 'owner')) {
          await client.query('rollback');
          return null;
        }

        const existingResult = await client.query<{ id: string }>(
          `
            select nm.id
            from app.network_memberships nm
            where nm.network_id = $1
              and nm.member_id = $2
            limit 1
          `,
          [input.networkId, input.memberId],
        );

        if (existingResult.rows[0]) {
          throw new AppError(409, 'membership_exists', 'This member already has a membership record in the network');
        }

        const membershipResult = await client.query<{ id: string }>(
          `
            insert into app.network_memberships (
              network_id,
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
            input.networkId,
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
            insert into app.network_membership_state_versions (
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
        return await withActorContext(pool, input.actorMemberId, [input.networkId], (scopedClient) => readMembershipAdminSummary(scopedClient, membershipId));
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
        await applyActorContext(client, input.actorMemberId, input.accessibleNetworkIds);

        const membershipResult = await client.query<{
          membership_id: string;
          network_id: string;
          member_id: string;
          current_status: MembershipState;
          current_version_no: number;
          current_state_version_id: string;
        }>(
          `
            select
              cnm.id as membership_id,
              cnm.network_id,
              cnm.member_id,
              cnm.status as current_status,
              cnm.state_version_no as current_version_no,
              cnm.state_version_id as current_state_version_id
            from app.current_network_memberships cnm
            join app.accessible_network_memberships owner_scope
              on owner_scope.network_id = cnm.network_id
             and owner_scope.member_id = $1
             and owner_scope.role = 'owner'
            where cnm.id = $2
              and cnm.network_id = any($3::app.short_id[])
            limit 1
          `,
          [input.actorMemberId, input.membershipId, input.accessibleNetworkIds],
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
            insert into app.network_membership_state_versions (
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
        return await withActorContext(pool, input.actorMemberId, input.accessibleNetworkIds, (scopedClient) =>
          readMembershipAdminSummary(scopedClient, membership.membership_id),
        );
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async transitionApplication(input: TransitionApplicationInput): Promise<ApplicationSummary | null> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await applyActorContext(client, input.actorMemberId, input.accessibleNetworkIds);

        const applicationResult = await client.query<{
          application_id: string;
          network_id: string;
          applicant_member_id: string;
          current_status: ApplicationStatus;
          current_version_no: number;
          current_version_id: string;
          current_metadata: Record<string, unknown> | null;
          current_intake_kind: 'fit_check' | 'advice_call' | 'other';
          current_intake_price_amount: string | number | null;
          current_intake_price_currency: string | null;
          current_intake_booking_url: string | null;
          current_intake_booked_at: string | null;
          current_intake_completed_at: string | null;
          current_membership_id: string | null;
        }>(
          `
            select
              ca.id as application_id,
              ca.network_id,
              ca.applicant_member_id,
              ca.status as current_status,
              ca.version_no as current_version_no,
              ca.version_id as current_version_id,
              ca.metadata as current_metadata,
              ca.intake_kind as current_intake_kind,
              ca.intake_price_amount as current_intake_price_amount,
              ca.intake_price_currency as current_intake_price_currency,
              ca.intake_booking_url as current_intake_booking_url,
              ca.intake_booked_at::text as current_intake_booked_at,
              ca.intake_completed_at::text as current_intake_completed_at,
              ca.membership_id as current_membership_id
            from app.current_applications ca
            join app.accessible_network_memberships owner_scope
              on owner_scope.network_id = ca.network_id
             and owner_scope.member_id = $1
             and owner_scope.role = 'owner'
            where ca.id = $2
              and ca.network_id = any($3::app.short_id[])
            limit 1
          `,
          [input.actorMemberId, input.applicationId, input.accessibleNetworkIds],
        );

        const application = applicationResult.rows[0];
        if (!application) {
          await client.query('rollback');
          return null;
        }

        if (input.membershipId !== undefined && input.membershipId !== null) {
          const membershipResult = await client.query<{ membership_id: string }>(
            `
              select cnm.id as membership_id
              from app.current_network_memberships cnm
              where cnm.id = $1
                and cnm.network_id = $2
                and cnm.member_id = $3
              limit 1
            `,
            [input.membershipId, application.network_id, application.applicant_member_id],
          );

          if (!membershipResult.rows[0]) {
            await client.query('rollback');
            return null;
          }
        }

        const mergedMetadata = {
          ...(application.current_metadata ?? {}),
          ...(input.metadataPatch ?? {}),
        };

        const resolvedMembershipId = input.membershipId === undefined ? application.current_membership_id : input.membershipId;
        const resolvedCompletedAt = input.intake?.completedAt === undefined ? application.current_intake_completed_at : input.intake.completedAt;

        if (input.activateMembership) {
          if (input.nextStatus !== 'accepted') {
            throw new AppError(409, 'activation_requires_accepted_application', 'Membership activation requires the application status to be accepted');
          }

          if (!resolvedMembershipId) {
            throw new AppError(409, 'activation_requires_membership', 'Membership activation requires a linked membership');
          }

          if (!resolvedCompletedAt) {
            throw new AppError(409, 'activation_requires_completed_interview', 'Membership activation requires interview completion metadata');
          }
        }

        await client.query(
          `
            update app.applications a
            set membership_id = $2,
                metadata = $3::jsonb
            where a.id = $1
          `,
          [application.application_id, resolvedMembershipId, JSON.stringify(mergedMetadata)],
        );

        await client.query(
          `
            insert into app.application_versions (
              application_id,
              status,
              notes,
              intake_kind,
              intake_price_amount,
              intake_price_currency,
              intake_booking_url,
              intake_booked_at,
              intake_completed_at,
              version_no,
              supersedes_version_id,
              created_by_member_id
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          `,
          [
            application.application_id,
            input.nextStatus,
            input.notes ?? null,
            input.intake?.kind ?? application.current_intake_kind,
            input.intake?.price?.amount === undefined ? application.current_intake_price_amount : input.intake.price.amount,
            input.intake?.price?.currency === undefined ? application.current_intake_price_currency : input.intake.price.currency,
            input.intake?.bookingUrl === undefined ? application.current_intake_booking_url : input.intake.bookingUrl,
            input.intake?.bookedAt === undefined ? application.current_intake_booked_at : input.intake.bookedAt,
            resolvedCompletedAt,
            Number(application.current_version_no) + 1,
            application.current_version_id,
            input.actorMemberId,
          ],
        );

        if (input.activateMembership) {
          const membershipResult = await client.query<{
            membership_id: string;
            current_status: MembershipState;
            current_version_no: number;
            current_state_version_id: string;
          }>(
            `
              select
                cnm.id as membership_id,
                cnm.status as current_status,
                cnm.state_version_no as current_version_no,
                cnm.state_version_id as current_state_version_id
              from app.current_network_memberships cnm
              join app.accessible_network_memberships owner_scope
                on owner_scope.network_id = cnm.network_id
               and owner_scope.member_id = $1
               and owner_scope.role = 'owner'
              where cnm.id = $2
                and cnm.network_id = any($3::app.short_id[])
              limit 1
            `,
            [input.actorMemberId, resolvedMembershipId, input.accessibleNetworkIds],
          );

          const membership = membershipResult.rows[0];
          if (!membership) {
            await client.query('rollback');
            return null;
          }

          if (membership.current_status !== 'pending_review') {
            throw new AppError(409, 'membership_not_ready_for_activation', 'Only pending-review memberships can be activated through this flow');
          }

          await client.query(
            `
              insert into app.network_membership_state_versions (
                membership_id,
                status,
                reason,
                version_no,
                supersedes_state_version_id,
                created_by_member_id
              )
              values ($1, 'active', $2, $3, $4, $5)
            `,
            [
              membership.membership_id,
              input.activationReason ?? input.notes ?? 'Activated from accepted application',
              Number(membership.current_version_no) + 1,
              membership.current_state_version_id,
              input.actorMemberId,
            ],
          );
        }

        await client.query('commit');
        return await withActorContext(pool, input.actorMemberId, input.accessibleNetworkIds, (scopedClient) => readApplicationSummary(scopedClient, application.application_id));
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async searchMembers({ actorMemberId, networkIds, query, limit }): Promise<MemberSearchResult[]> {
      return withActorContext(pool, actorMemberId, networkIds, (client) => readMemberSearch(client, { networkIds, query, limit }));
    },

    async listMembers({ actorMemberId, networkIds, limit }) {
      return withActorContext(pool, actorMemberId, networkIds, (client) => readMembers(client, { networkIds, limit }));
    },
  };
}
