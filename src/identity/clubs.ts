/**
 * Identity domain — club management.
 */

import type { Pool } from 'pg';
import type {
  ArchiveClubInput,
  AssignClubOwnerInput,
  ClubForGate,
  ClubSummary,
  CreateClubInput,
  Paginated,
  RemoveClubInput,
  RemovedClubSummary,
  RestoreRemovedClubInput,
  UpdateClubInput,
} from '../repository.ts';
import { AppError } from '../repository.ts';
import { withTransaction, type DbClient } from '../db.ts';
import { getConfig } from '../config/index.ts';
import { withIdempotency } from '../idempotency.ts';
import { encodeCursor } from '../schemas/fields.ts';
import {
  createInitialClubProfileVersion,
  emptyClubProfileFields,
} from './profiles.ts';
import { assertClubHasCapacity, syncMembershipRole } from './memberships.ts';

type ClubRow = {
  club_id: string;
  slug: string;
  name: string;
  summary: string | null;
  admission_policy: string | null;
  uses_free_allowance: boolean;
  member_cap: number | null;
  archived_at: string | null;
  owner_member_id: string;
  owner_public_name: string;
  owner_email: string | null;
  version_no: number;
  version_created_at: string;
  version_created_by_member_id: string | null;
  version_created_by_member_public_name: string | null;
};

type PublicClubRow = {
  slug: string;
  name: string;
  summary: string | null;
  admission_policy: string | null;
};

type RemovedClubRow = {
  archive_id: string;
  club_id: string;
  club_slug: string;
  removed_at: string;
  retained_until: string;
  is_expired: boolean;
  removed_by_member_id: string | null;
  removed_by_member_public_name: string | null;
  reason: string;
};

type ArchiveRow = {
  id: string;
  club_id: string;
  club_slug: string;
  removed_at: string;
  removed_by_member_id: string | null;
  reason: string;
  retained_until: string;
  payload: unknown;
};

type ArchivePayload = {
  schema_version: number;
  club: Record<string, unknown>[];
  club_versions: Record<string, unknown>[];
  club_memberships: Record<string, unknown>[];
  club_membership_state_versions: Record<string, unknown>[];
  member_club_profile_versions: Record<string, unknown>[];
  member_profile_embeddings: Record<string, unknown>[];
  invitations: Record<string, unknown>[];
  club_applications: Record<string, unknown>[];
  club_application_revisions: Record<string, unknown>[];
  club_applicant_blocks: Record<string, unknown>[];
  club_edges: Record<string, unknown>[];
  club_subscriptions: Record<string, unknown>[];
  content_threads: Record<string, unknown>[];
  contents: Record<string, unknown>[];
  content_versions: Record<string, unknown>[];
  content_version_mentions: Record<string, unknown>[];
  content_embeddings: Record<string, unknown>[];
  event_version_details: Record<string, unknown>[];
  event_rsvps: Record<string, unknown>[];
  club_activity: Record<string, unknown>[];
  club_activity_cursors: Record<string, unknown>[];
  member_notifications: Record<string, unknown>[];
  consumed_pow_challenges: Record<string, unknown>[];
  ai_llm_quota_reservations: Record<string, unknown>[];
  ai_club_spend_reservations: Record<string, unknown>[];
  dm_thread_subject_nullifications: Array<{ thread_id: string; subject_content_id: string }>;
  ai_llm_usage_log_detachments: Array<{ log_id: string; requested_club_id: string }>;
};

type RestoreTableSpec = {
  payloadKey: keyof ArchivePayload;
  tableName: string;
  omitColumns?: string[];
  overridingSystemValue?: boolean;
};

const RESTORE_TABLES: RestoreTableSpec[] = [
  { payloadKey: 'club', tableName: 'clubs' },
  { payloadKey: 'club_versions', tableName: 'club_versions' },
  { payloadKey: 'content_threads', tableName: 'content_threads' },
  { payloadKey: 'contents', tableName: 'contents' },
  { payloadKey: 'content_versions', tableName: 'content_versions' },
  { payloadKey: 'content_version_mentions', tableName: 'content_version_mentions' },
  { payloadKey: 'content_embeddings', tableName: 'content_embeddings' },
  { payloadKey: 'event_version_details', tableName: 'event_version_details' },
  { payloadKey: 'club_memberships', tableName: 'club_memberships' },
  { payloadKey: 'club_membership_state_versions', tableName: 'club_membership_state_versions' },
  { payloadKey: 'member_club_profile_versions', tableName: 'member_club_profile_versions' },
  { payloadKey: 'member_profile_embeddings', tableName: 'member_profile_embeddings' },
  { payloadKey: 'club_subscriptions', tableName: 'club_subscriptions' },
  { payloadKey: 'invitations', tableName: 'invite_requests', omitColumns: ['candidate_email_normalized', 'code'] },
  { payloadKey: 'club_applications', tableName: 'club_applications' },
  { payloadKey: 'club_application_revisions', tableName: 'club_application_revisions' },
  { payloadKey: 'club_applicant_blocks', tableName: 'club_applicant_blocks' },
  { payloadKey: 'club_edges', tableName: 'club_edges' },
  { payloadKey: 'consumed_pow_challenges', tableName: 'consumed_pow_challenges' },
  { payloadKey: 'club_activity', tableName: 'club_activity', overridingSystemValue: true },
  { payloadKey: 'club_activity_cursors', tableName: 'club_activity_cursors' },
  { payloadKey: 'member_notifications', tableName: 'member_notifications', overridingSystemValue: true },
  { payloadKey: 'ai_llm_quota_reservations', tableName: 'ai_llm_quota_reservations' },
  { payloadKey: 'ai_club_spend_reservations', tableName: 'ai_club_spend_reservations' },
];

function effectiveMemberCap(usesFreeAllowance: boolean, memberCap: number | null): number | null {
  return usesFreeAllowance
    ? getConfig().policy.clubs.freeClubMemberCap
    : memberCap;
}

function mapRow(row: ClubRow): ClubSummary {
  return {
    clubId: row.club_id,
    slug: row.slug,
    name: row.name,
    summary: row.summary,
    admissionPolicy: row.admission_policy,
    usesFreeAllowance: row.uses_free_allowance,
    memberCap: effectiveMemberCap(row.uses_free_allowance, row.member_cap),
    archivedAt: row.archived_at,
    owner: {
      memberId: row.owner_member_id,
      publicName: row.owner_public_name,
      email: row.owner_email,
    },
    version: {
      no: Number(row.version_no),
      status: row.archived_at === null ? 'active' : 'archived',
      reason: null,
      createdAt: row.version_created_at,
      createdByMember: row.version_created_by_member_id
        ? {
          memberId: row.version_created_by_member_id,
          publicName: row.version_created_by_member_public_name as string,
        }
        : null,
    },
  };
}

function mapRemovedClubRow(row: RemovedClubRow): RemovedClubSummary {
  return {
    archiveId: row.archive_id,
    clubId: row.club_id,
    clubSlug: row.club_slug,
    removedAt: row.removed_at,
    retainedUntil: row.retained_until,
    isExpired: row.is_expired,
    removedByMember: row.removed_by_member_id && row.removed_by_member_public_name
      ? {
        memberId: row.removed_by_member_id,
        publicName: row.removed_by_member_public_name,
      }
      : null,
    reason: row.reason,
  };
}

const SELECT_CLUB = `
  select
    c.id as club_id, c.slug, c.name, c.summary, c.admission_policy,
    c.uses_free_allowance,
    c.member_cap,
    c.archived_at::text as archived_at,
    cv.owner_member_id, m.public_name as owner_public_name,
    m.email as owner_email,
    cv.version_no, cv.created_at::text as version_created_at,
    cv.created_by_member_id as version_created_by_member_id,
    creator.public_name as version_created_by_member_public_name
  from clubs c
  join current_club_versions cv on cv.club_id = c.id
  join members m on m.id = cv.owner_member_id
  left join members creator on creator.id = cv.created_by_member_id
`;

async function readClub(client: DbClient, clubId: string): Promise<ClubSummary | null> {
  const result = await client.query<ClubRow>(`${SELECT_CLUB} where c.id = $1 limit 1`, [clubId]);
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

async function countOwnedClubs(client: DbClient, ownerMemberId: string): Promise<number> {
  const result = await client.query<{ owned_count: number }>(
    `select count(*)::int as owned_count
     from clubs
     where owner_member_id = $1
       and archived_at is null`,
    [ownerMemberId],
  );
  return result.rows[0]?.owned_count ?? 0;
}

async function loadActiveClubCount(client: DbClient, clubId: string): Promise<number> {
  const result = await client.query<{ active_count: number }>(
    `select count(*)::int as active_count
     from current_club_memberships
     where club_id = $1
       and status = 'active'
       and left_at is null`,
    [clubId],
  );
  return result.rows[0]?.active_count ?? 0;
}

async function loadJsonRows(client: DbClient, sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
  const result = await client.query<{ row: Record<string, unknown> }>(
    `select to_jsonb(t) as row from (${sql}) t`,
    params,
  );
  return result.rows.map((row) => row.row);
}

async function insertJsonRows(client: DbClient, spec: RestoreTableSpec, rows: Record<string, unknown>[]): Promise<void> {
  const omit = new Set(spec.omitColumns ?? []);
  for (const row of rows) {
    const entries = Object.entries(row).filter(([key]) => !omit.has(key));
    if (entries.length === 0) {
      continue;
    }
    const columns = entries.map(([key]) => `"${key}"`).join(', ');
    const placeholders = entries.map((_, index) => `$${index + 1}`).join(', ');
    const values = entries.map(([, value]) => value);
    const overriding = spec.overridingSystemValue ? ' overriding system value' : '';
    await client.query(
      `insert into public.${spec.tableName} (${columns})${overriding} values (${placeholders})`,
      values,
    );
  }
}

function coerceArchivePayload(payload: unknown): ArchivePayload {
  if (!payload || typeof payload !== 'object') {
    throw new AppError('invalid_data', 'Removed club archive payload was malformed.');
  }
  return payload as ArchivePayload;
}

export async function findClubBySlug(pool: Pool, slug: string): Promise<ClubSummary | null> {
  const result = await pool.query<ClubRow>(
    `${SELECT_CLUB}
     where c.slug = $1
     limit 1`,
    [slug],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function listClubs(pool: Pool, input: {
  includeArchived: boolean;
  limit: number;
  cursor?: { archivedAt: string; name: string; clubId: string } | null;
}): Promise<Paginated<ClubSummary>> {
  const fetchLimit = input.limit + 1;
  const result = await pool.query<ClubRow>(
    `${SELECT_CLUB}
     where ($1::boolean = true or c.archived_at is null)
       and (
         $2::text is null
         or coalesce(c.archived_at::text, '') > $2
         or (
           coalesce(c.archived_at::text, '') = $2
           and (
             c.name > $3
             or (c.name = $3 and c.id > $4)
           )
         )
       )
     order by c.archived_at asc nulls first, c.name asc, c.id asc
     limit $5`,
    [
      input.includeArchived,
      input.cursor?.archivedAt ?? null,
      input.cursor?.name ?? null,
      input.cursor?.clubId ?? null,
      fetchLimit,
    ],
  );
  const hasMore = result.rows.length > input.limit;
  const rows = hasMore ? result.rows.slice(0, input.limit) : result.rows;
  const last = rows[rows.length - 1];
  return {
    results: rows.map(mapRow),
    hasMore,
    nextCursor: hasMore && last ? encodeCursor([last.archived_at ?? '', last.name, last.club_id]) : null,
  };
}

export async function loadClubForGate(pool: Pool, input: { clubId: string }): Promise<ClubForGate | null> {
  const result = await pool.query<{
    club_id: string;
    name: string;
    summary: string | null;
    admission_policy: string | null;
    uses_free_allowance: boolean;
    member_cap: number | null;
    archived_at: string | null;
  }>(
    `select
        id as club_id,
        name,
        summary,
        admission_policy,
        uses_free_allowance,
        member_cap,
        archived_at::text as archived_at
     from clubs
     where id = $1
     limit 1`,
    [input.clubId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    clubId: row.club_id,
    name: row.name,
    summary: row.summary,
    admissionPolicy: row.admission_policy,
    usesFreeAllowance: row.uses_free_allowance,
    memberCap: row.member_cap,
    archivedAt: row.archived_at,
  };
}

export async function createClub(pool: Pool, input: CreateClubInput): Promise<ClubSummary | null> {
  const performCreate = async (client: DbClient): Promise<ClubSummary | null> => {
    await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [`clubs.create:owner:${input.ownerMemberId}`]);

    if (input.enforceFreeClubLimit) {
      const ownedClubs = await countOwnedClubs(client, input.ownerMemberId);
      if (ownedClubs >= getConfig().policy.clubs.maxClubsPerMember) {
        throw new AppError('owner_club_limit_reached', 'This member already owns the maximum number of clubs they may create themselves.');
      }
    }

    const slugCheck = await client.query<{ ok: boolean }>(
      `select exists(select 1 from clubs where slug = $1) as ok`,
      [input.slug],
    );
    if (slugCheck.rows[0]?.ok) {
      throw new AppError('slug_conflict', 'A club with that slug already exists');
    }

    const clubResult = await client.query<{ club_id: string }>(
      `with owner_member as (
         select m.id from members m where m.id = $5 and m.state = 'active'
       ), inserted_club as (
         insert into clubs (
           slug,
           name,
           summary,
           owner_member_id,
           admission_policy,
           uses_free_allowance,
           member_cap
         )
         select $1, $2, $3, om.id, $4, $6, $7 from owner_member om
         returning id as club_id
       ), club_version as (
         insert into club_versions (
           club_id,
           owner_member_id,
           name,
           summary,
           admission_policy,
           uses_free_allowance,
           member_cap,
           version_no,
           created_by_member_id
         )
         select club_id, $5, $2, $3, $4, $6, $7, 1, $8 from inserted_club
       )
       select club_id from inserted_club`,
      [
        input.slug,
        input.name,
        input.summary,
        input.admissionPolicy ?? null,
        input.ownerMemberId,
        input.usesFreeAllowance,
        input.memberCap,
        input.actorMemberId,
      ],
    );

    const clubId = clubResult.rows[0]?.club_id;
    if (!clubId) return null;

    await assertClubHasCapacity(client, { clubId });

    const ownerMsResult = await client.query<{ id: string }>(
      `insert into club_memberships (club_id, member_id, role, status, joined_at, metadata)
       values ($1::short_id, $2::short_id, 'clubadmin', 'active', now(), '{}'::jsonb)
       returning id`,
      [clubId, input.ownerMemberId],
    );
    const ownerMsId = ownerMsResult.rows[0]!.id;
    await client.query(
      `insert into club_membership_state_versions (membership_id, status, reason, version_no, created_by_member_id)
       values ($1::short_id, 'active', 'club_created', 1, $2::short_id)`,
      [ownerMsId, input.actorMemberId],
    );
    await client.query(
      `update club_memberships set is_comped = true, comped_at = now(), comped_by_member_id = null
       where id = $1 and is_comped = false`,
      [ownerMsId],
    );

    await createInitialClubProfileVersion(client, {
      membershipId: ownerMsId,
      memberId: input.ownerMemberId,
      clubId,
      fields: emptyClubProfileFields(),
      creatorMemberId: input.actorMemberId,
      generationSource: 'membership_seed',
    });

    return readClub(client, clubId);
  };

  if (!input.clientKey) {
    return withTransaction(pool, performCreate);
  }

  return withTransaction(pool, async (client) => withIdempotency(client, {
    clientKey: input.clientKey!,
    actorContext: input.idempotencyActorContext ?? `member:${input.actorMemberId}:clubs.create`,
    requestValue: input.idempotencyRequestValue ?? {
      slug: input.slug,
      name: input.name,
      summary: input.summary,
      admissionPolicy: input.admissionPolicy ?? null,
      ownerMemberId: input.ownerMemberId,
      usesFreeAllowance: input.usesFreeAllowance,
      memberCap: input.memberCap,
      enforceFreeClubLimit: input.enforceFreeClubLimit ?? false,
    },
    execute: async () => {
      const club = await performCreate(client);
      return { responseValue: club };
    },
  }));
}

export async function archiveClub(pool: Pool, input: ArchiveClubInput): Promise<ClubSummary | null> {
  return withTransaction(pool, async (client) => {
    const result = await client.query<{ archived_at: string | null }>(
      `select archived_at::text as archived_at
       from clubs
       where id = $1
       for update`,
      [input.clubId],
    );
    if (!result.rows[0]) return null;
    if (result.rows[0].archived_at !== null) {
      throw new AppError('club_archived', 'Club is already archived.');
    }
    await client.query(`update clubs set archived_at = now() where id = $1`, [input.clubId]);
    return readClub(client, input.clubId);
  });
}

export async function assignClubOwner(pool: Pool, input: AssignClubOwnerInput): Promise<ClubSummary | null> {
  return withTransaction(pool, async (client) => {
    const currentResult = await client.query<{
      club_id: string;
      current_version_id: string;
      current_version_no: number;
      current_owner_member_id: string;
      name: string;
      summary: string | null;
      admission_policy: string | null;
      uses_free_allowance: boolean;
      member_cap: number | null;
    }>(
      `select
          c.id as club_id,
          cv.id as current_version_id,
          cv.version_no as current_version_no,
          cv.owner_member_id as current_owner_member_id,
          cv.name,
          cv.summary,
          cv.admission_policy,
          cv.uses_free_allowance,
          cv.member_cap
       from clubs c
       join current_club_versions cv on cv.club_id = c.id
       where c.id = $1
         and c.archived_at is null
       for update of c
       limit 1`,
      [input.clubId],
    );

    const current = currentResult.rows[0];
    if (!current) return null;

    const targetMembershipResult = await client.query<{ id: string }>(
      `select cm.id
         from club_memberships cm
         join current_club_memberships cnm on cnm.id = cm.id
        where cnm.club_id = $1
          and cnm.member_id = $2
          and cnm.status = 'active'
          and cnm.left_at is null
        order by cnm.state_created_at desc, cnm.id desc
        limit 1
        for update of cm`,
      [input.clubId, input.ownerMemberId],
    );
    const targetMembershipId = targetMembershipResult.rows[0]?.id ?? null;
    if (!targetMembershipId) {
      throw new AppError('member_not_found', 'Owner member not found or not active in this club');
    }

    await client.query(
      `insert into club_versions (
         club_id,
         owner_member_id,
         name,
         summary,
         admission_policy,
         uses_free_allowance,
         member_cap,
         version_no,
         supersedes_version_id,
         created_by_member_id
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        input.clubId,
        input.ownerMemberId,
        current.name,
        current.summary,
        current.admission_policy,
        current.uses_free_allowance,
        current.member_cap,
        Number(current.current_version_no) + 1,
        current.current_version_id,
        input.actorMemberId,
      ],
    );

    await syncMembershipRole(client, targetMembershipId, 'clubadmin');
    await client.query(
      `insert into club_membership_state_versions (membership_id, status, reason, version_no, created_by_member_id)
       select $1::short_id, 'active', 'owner_assignment',
              coalesce(max(version_no), 0) + 1, $2::short_id
       from club_membership_state_versions where membership_id = $1::short_id`,
      [targetMembershipId, input.actorMemberId],
    );

    await client.query(
      `update club_memberships set is_comped = true, comped_at = now(), comped_by_member_id = null
       where id = $1 and is_comped = false`,
      [targetMembershipId],
    );

    if (current.current_owner_member_id !== input.ownerMemberId) {
      const oldOwnerMembershipResult = await client.query<{ id: string }>(
        `select id
         from current_club_memberships
         where club_id = $1 and member_id = $2 and role = 'clubadmin' and left_at is null
         order by state_created_at desc, id desc
         limit 1`,
        [input.clubId, current.current_owner_member_id],
      );
      if (oldOwnerMembershipResult.rows[0]) {
        const oldOwnerMembershipId = oldOwnerMembershipResult.rows[0].id;
        await syncMembershipRole(client, oldOwnerMembershipId, 'member');
        await client.query(
          `update club_memberships
              set is_comped = false,
                  comped_at = null
            where id = $1
              and is_comped = true
              and comped_by_member_id is null`,
          [oldOwnerMembershipId],
        );
      }
    }

    return readClub(client, input.clubId);
  });
}

export async function updateClub(pool: Pool, input: UpdateClubInput): Promise<ClubSummary | null> {
  const performUpdate = async (client: DbClient): Promise<ClubSummary | null> => {
    if (input.patch.usesFreeAllowance !== undefined || input.patch.memberCap !== undefined) {
      await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [`club-capacity:${input.clubId}`]);
    }

    const currentResult = await client.query<{
      club_id: string;
      current_version_id: string;
      current_version_no: number;
      owner_member_id: string;
      name: string;
      summary: string | null;
      admission_policy: string | null;
      uses_free_allowance: boolean;
      member_cap: number | null;
      archived_at: string | null;
    }>(
      `select
          c.id as club_id,
          c.archived_at::text as archived_at,
          cv.id as current_version_id,
          cv.version_no as current_version_no,
          cv.owner_member_id,
          cv.name,
          cv.summary,
          cv.admission_policy,
          cv.uses_free_allowance,
          cv.member_cap
       from clubs c
       join current_club_versions cv on cv.club_id = c.id
       where c.id = $1
       for update of c
       limit 1`,
      [input.clubId],
    );

    const current = currentResult.rows[0];
    if (!current) return null;
    if (current.archived_at !== null) {
      throw new AppError('club_archived', 'Club is archived.');
    }

    const { patch } = input;
    const merged = {
      name: patch.name !== undefined ? patch.name : current.name,
      summary: patch.summary !== undefined ? patch.summary : current.summary,
      admissionPolicy: patch.admissionPolicy !== undefined ? patch.admissionPolicy : current.admission_policy,
      usesFreeAllowance: patch.usesFreeAllowance !== undefined ? patch.usesFreeAllowance : current.uses_free_allowance,
      memberCap: patch.usesFreeAllowance === true
        ? null
        : (patch.memberCap !== undefined ? patch.memberCap : current.member_cap),
    };

    const versionedUnchanged = merged.name === current.name
      && merged.summary === current.summary
      && merged.admissionPolicy === current.admission_policy
      && merged.usesFreeAllowance === current.uses_free_allowance
      && merged.memberCap === current.member_cap;
    if (versionedUnchanged) {
      return readClub(client, input.clubId);
    }

    const activeCount = await loadActiveClubCount(client, input.clubId);
    const mergedEffectiveCap = effectiveMemberCap(merged.usesFreeAllowance, merged.memberCap);
    if (mergedEffectiveCap !== null && activeCount > mergedEffectiveCap) {
      throw new AppError('member_cap_below_current_count', 'The requested member cap is below the club’s current active membership count.');
    }

    await client.query(
      `insert into club_versions (
         club_id,
         owner_member_id,
         name,
         summary,
         admission_policy,
         uses_free_allowance,
         member_cap,
         version_no,
         supersedes_version_id,
         created_by_member_id
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        input.clubId,
        current.owner_member_id,
        merged.name,
        merged.summary,
        merged.admissionPolicy,
        merged.usesFreeAllowance,
        merged.memberCap,
        Number(current.current_version_no) + 1,
        current.current_version_id,
        input.actorMemberId,
      ],
    );

    return readClub(client, input.clubId);
  };

  if (!input.clientKey) {
    return withTransaction(pool, performUpdate);
  }

  return withTransaction(pool, async (client) => withIdempotency(client, {
    clientKey: input.clientKey!,
    actorContext: input.idempotencyActorContext ?? `member:${input.actorMemberId}:clubs.update:${input.clubId}`,
    requestValue: input.idempotencyRequestValue ?? {
      clubId: input.clubId,
      patch: input.patch,
    },
    execute: async () => ({ responseValue: await performUpdate(client) }),
  }));
}

export async function listRemovedClubs(pool: Pool, input: {
  limit: number;
  cursor?: { removedAt: string; archiveId: string } | null;
  clubSlug?: string | null;
}): Promise<{ results: RemovedClubSummary[]; hasMore: boolean; nextCursor: string | null }> {
  const fetchLimit = input.limit + 1;
  const result = await pool.query<RemovedClubRow>(
    `select
        cra.id as archive_id,
        cra.club_id,
        cra.club_slug,
        cra.removed_at::text as removed_at,
        cra.retained_until::text as retained_until,
        (cra.retained_until < now()) as is_expired,
        cra.removed_by_member_id,
        m.public_name as removed_by_member_public_name,
        cra.reason
     from club_removal_archives cra
     left join members m on m.id = cra.removed_by_member_id
     where ($1::text is null or cra.club_slug = $1)
       and (
         $2::timestamptz is null
         or cra.removed_at < $2
         or (cra.removed_at = $2 and cra.id < $3)
       )
     order by cra.removed_at desc, cra.id desc
     limit $4`,
    [input.clubSlug ?? null, input.cursor?.removedAt ?? null, input.cursor?.archiveId ?? null, fetchLimit],
  );
  const rows = result.rows.map(mapRemovedClubRow);
  const hasMore = rows.length > input.limit;
  if (hasMore) rows.pop();
  const last = rows[rows.length - 1];
  const nextCursor = last ? encodeCursor([last.removedAt, last.archiveId]) : null;
  return { results: rows, hasMore, nextCursor };
}

async function buildRemovalPayload(client: DbClient, clubId: string): Promise<ArchivePayload> {
  return {
    schema_version: 1,
    club: await loadJsonRows(client, `select * from clubs where id = $1`, [clubId]),
    club_versions: await loadJsonRows(client, `select * from club_versions where club_id = $1 order by version_no asc, created_at asc`, [clubId]),
    club_memberships: await loadJsonRows(client, `select * from club_memberships where club_id = $1 order by joined_at asc, id asc`, [clubId]),
    club_membership_state_versions: await loadJsonRows(client, `select cmsv.* from club_membership_state_versions cmsv join club_memberships cm on cm.id = cmsv.membership_id where cm.club_id = $1 order by cmsv.version_no asc, cmsv.created_at asc, cmsv.id asc`, [clubId]),
    member_club_profile_versions: await loadJsonRows(client, `select * from member_club_profile_versions where club_id = $1 order by version_no asc, created_at asc, id asc`, [clubId]),
    member_profile_embeddings: await loadJsonRows(client, `select * from member_profile_embeddings where club_id = $1 order by id asc`, [clubId]),
    invitations: await loadJsonRows(
      client,
      `select
          ir.*,
          ic.code
       from invite_requests ir
       left join invite_codes ic on ic.invite_request_id = ir.id
       where ir.club_id = $1
       order by ir.created_at asc, ir.id asc`,
      [clubId],
    ),
    club_applications: await loadJsonRows(client, `select * from club_applications where club_id = $1 order by created_at asc, id asc`, [clubId]),
    club_application_revisions: await loadJsonRows(client, `select car.* from club_application_revisions car join club_applications ca on ca.id = car.application_id where ca.club_id = $1 order by car.version_no asc, car.created_at asc, car.id asc`, [clubId]),
    club_applicant_blocks: await loadJsonRows(client, `select * from club_applicant_blocks where club_id = $1 order by created_at asc, id asc`, [clubId]),
    club_edges: await loadJsonRows(client, `select * from club_edges where club_id = $1 order by created_at asc, id asc`, [clubId]),
    club_subscriptions: await loadJsonRows(client, `select cs.* from club_subscriptions cs join club_memberships cm on cm.id = cs.membership_id where cm.club_id = $1 order by cs.started_at asc, cs.id asc`, [clubId]),
    content_threads: await loadJsonRows(client, `select * from content_threads where club_id = $1 order by created_at asc, id asc`, [clubId]),
    contents: await loadJsonRows(client, `select * from contents where club_id = $1 order by created_at asc, id asc`, [clubId]),
    content_versions: await loadJsonRows(client, `select cv.* from content_versions cv join contents c on c.id = cv.content_id where c.club_id = $1 order by cv.version_no asc, cv.created_at asc, cv.id asc`, [clubId]),
    content_version_mentions: await loadJsonRows(client, `select cvm.* from content_version_mentions cvm join content_versions cv on cv.id = cvm.content_version_id join contents c on c.id = cv.content_id where c.club_id = $1 order by cvm.content_version_id asc, cvm.start_offset asc`, [clubId]),
    content_embeddings: await loadJsonRows(client, `select ce.* from content_embeddings ce join contents c on c.id = ce.content_id where c.club_id = $1 order by ce.id asc`, [clubId]),
    event_version_details: await loadJsonRows(client, `select evd.* from event_version_details evd join content_versions cv on cv.id = evd.content_version_id join contents c on c.id = cv.content_id where c.club_id = $1 order by evd.content_version_id asc`, [clubId]),
    event_rsvps: await loadJsonRows(client, `select er.* from event_rsvps er join contents c on c.id = er.event_content_id where c.club_id = $1 order by er.created_at asc, er.membership_id asc`, [clubId]),
    club_activity: await loadJsonRows(client, `select * from club_activity where club_id = $1 order by seq asc`, [clubId]),
    club_activity_cursors: await loadJsonRows(client, `select * from club_activity_cursors where club_id = $1 order by member_id asc, club_id asc`, [clubId]),
    member_notifications: await loadJsonRows(client, `select * from member_notifications where club_id = $1 order by created_at asc, id asc`, [clubId]),
    consumed_pow_challenges: await loadJsonRows(client, `select * from consumed_pow_challenges where club_id = $1 order by consumed_at asc, challenge_id asc`, [clubId]),
    ai_llm_quota_reservations: await loadJsonRows(client, `select * from ai_llm_quota_reservations where club_id = $1 order by created_at asc, id asc`, [clubId]),
    ai_club_spend_reservations: await loadJsonRows(client, `select * from ai_club_spend_reservations where club_id = $1 order by created_at asc, id asc`, [clubId]),
    dm_thread_subject_nullifications: await client.query<{ thread_id: string; subject_content_id: string }>(
      `select id as thread_id, subject_content_id
       from dm_threads
       where subject_content_id in (select id from contents where club_id = $1)`,
      [clubId],
    ).then((r) => r.rows),
    ai_llm_usage_log_detachments: await client.query<{ log_id: string; requested_club_id: string }>(
      `select id as log_id, requested_club_id
       from ai_llm_usage_log
       where requested_club_id = $1`,
      [clubId],
    ).then((r) => r.rows),
  };
}

export async function removeClub(pool: Pool, input: RemoveClubInput): Promise<{
  archiveId: string;
  clubId: string;
  clubSlug: string;
  removedAt: string;
  retainedUntil: string;
} | null> {
  const performRemove = async (client: DbClient): Promise<{
    archiveId: string;
    clubId: string;
    clubSlug: string;
    removedAt: string;
    retainedUntil: string;
  } | null> => {
    if (input.reason.trim().length === 0) {
      throw new AppError('invalid_input', 'Removal reason must not be empty.');
    }

    const clubResult = await client.query<{ club_id: string; slug: string; archived_at: string | null }>(
      `select id as club_id, slug, archived_at::text as archived_at
       from clubs
       where id = $1
       for update
       limit 1`,
      [input.clubId],
    );
    const club = clubResult.rows[0];
    if (!club) {
      throw new AppError('club_not_found', 'Club not found.');
    }
    if (club.slug !== input.confirmSlug) {
      throw new AppError('invalid_input', 'confirmSlug must match the current club slug exactly.');
    }
    if (club.archived_at === null) {
      throw new AppError('remove_requires_archived', 'A club must be archived before it can be removed.');
    }

    const payload = await buildRemovalPayload(client, input.clubId);
    const archiveResult = await client.query<{
      archive_id: string;
      club_id: string;
      club_slug: string;
      removed_at: string;
      retained_until: string;
    }>(
      `insert into club_removal_archives (
         club_id,
         club_slug,
         removed_by_member_id,
         reason,
         retained_until,
         payload
       )
       values (
         $1,
         $2,
         $3,
         $4,
         now() + make_interval(days => $5),
         $6::jsonb
       )
       returning
         id as archive_id,
         club_id,
         club_slug,
         removed_at::text as removed_at,
         retained_until::text as retained_until`,
      [
        club.club_id,
        club.slug,
        input.actorMemberId,
        input.reason,
        getConfig().policy.clubs.removedClubRetentionDays,
        JSON.stringify(payload),
      ],
    );
    const archive = archiveResult.rows[0];
    if (!archive) {
      throw new AppError('missing_row', 'Club removal archive row was not returned.');
    }

    await client.query(`set local app.allow_delete_club_application_revisions = '1'`);
    await client.query(`set local app.allow_delete_club_membership_state_versions = '1'`);
    await client.query(`set local app.allow_delete_content_versions = '1'`);
    await client.query(`set local app.allow_delete_member_club_profile_versions = '1'`);
    await client.query(`delete from clubs where id = $1`, [input.clubId]);

    return {
      archiveId: archive.archive_id,
      clubId: archive.club_id,
      clubSlug: archive.club_slug,
      removedAt: archive.removed_at,
      retainedUntil: archive.retained_until,
    };
  };

  if (!input.clientKey) {
    return withTransaction(pool, performRemove);
  }

  return withTransaction(pool, async (client) => withIdempotency(client, {
    clientKey: input.clientKey!,
    actorContext: input.idempotencyActorContext ?? `superadmin:${input.actorMemberId}:clubs.remove:${input.clubId}`,
    requestValue: input.idempotencyRequestValue ?? {
      clubId: input.clubId,
      confirmSlug: input.confirmSlug,
      reason: input.reason,
    },
    execute: async () => ({ responseValue: await performRemove(client) }),
  }));
}

export async function restoreRemovedClub(pool: Pool, input: RestoreRemovedClubInput): Promise<ClubSummary | null> {
  const performRestore = async (client: DbClient): Promise<ClubSummary | null> => {
    const archiveResult = await client.query<ArchiveRow>(
      `select
          id,
          club_id,
          club_slug,
          removed_at::text as removed_at,
          removed_by_member_id,
          reason,
          retained_until::text as retained_until,
          payload
       from club_removal_archives
       where id = $1
       for update
       limit 1`,
      [input.archiveId],
    );
    const archive = archiveResult.rows[0];
    if (!archive) {
      throw new AppError('club_archive_not_found', 'Removed club archive not found.');
    }
    if (new Date(archive.retained_until).getTime() < Date.now()) {
      throw new AppError('club_archive_expired', 'Removed club archive is no longer restorable.');
    }
    const existingClub = await client.query<{ ok: boolean }>(
      `select exists(select 1 from clubs where id = $1) as ok`,
      [archive.club_id],
    );
    if (existingClub.rows[0]?.ok) {
      throw new AppError('club_already_exists', 'A club with that id already exists.');
    }

    const payload = coerceArchivePayload(archive.payload);
    if (payload.schema_version !== 1) {
      throw new AppError('invalid_data', 'Removed club archive schema version is not supported.');
    }

    // Break the invitation<->membership cycle by restoring invitation requests first
    // without used_membership_id, then patching it back after memberships exist.
    const invitations = (payload.invitations ?? []).map((row) => ({
      ...row,
      used_membership_id: null,
    }));

    for (const spec of RESTORE_TABLES) {
      if (spec.payloadKey === 'invitations') {
        await insertJsonRows(client, spec, invitations);
        continue;
      }
      await insertJsonRows(client, spec, payload[spec.payloadKey] as Record<string, unknown>[] ?? []);
    }

    for (const row of payload.invitations ?? []) {
      if (row.id && row.code) {
        await client.query(
          `insert into invite_codes (invite_request_id, code)
           values ($1, $2)
           on conflict (invite_request_id) do nothing`,
          [row.id, row.code],
        );
      }
      if (row.id && row.used_membership_id) {
        await client.query(
          `update invite_requests
           set used_membership_id = $2
           where id = $1`,
          [row.id, row.used_membership_id],
        );
      }
    }

    for (const detachment of payload.dm_thread_subject_nullifications ?? []) {
      await client.query(
        `update dm_threads
         set subject_content_id = $2
         where id = $1
           and subject_content_id is null`,
        [detachment.thread_id, detachment.subject_content_id],
      );
    }

    for (const detachment of payload.ai_llm_usage_log_detachments ?? []) {
      await client.query(
        `update ai_llm_usage_log
         set requested_club_id = $2
         where id = $1
           and requested_club_id is null`,
        [detachment.log_id, detachment.requested_club_id],
      );
    }

    await client.query(
      `update clubs
       set archived_at = null
       where id = $1`,
      [archive.club_id],
    );

    await client.query(`delete from club_removal_archives where id = $1`, [input.archiveId]);
    return readClub(client, archive.club_id);
  };

  if (!input.clientKey) {
    return withTransaction(pool, performRestore);
  }

  return withTransaction(pool, async (client) => withIdempotency(client, {
    clientKey: input.clientKey!,
    actorContext: input.idempotencyActorContext ?? `superadmin:${input.actorMemberId}:removedClubs.restore:${input.archiveId}`,
    requestValue: input.idempotencyRequestValue ?? { archiveId: input.archiveId },
    execute: async () => ({ responseValue: await performRestore(client) }),
  }));
}
