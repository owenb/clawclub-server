/**
 * Clubs domain — contents, events, activity, vouches, quotas, LLM, embeddings.
 */

import type { Pool } from 'pg';
import type {
  ContentSearchResult,
  CreateContentInput,
  ContentForGate,
  Content,
  IncludedBundle,
  ListContentInput,
  ReadContentThreadInput,
  ReadContentInput,
  SetContentLoopInput,
  UpdateContentInput,
  MembershipVouchSummary,
  QuotaAllowance,
  LogApiRequestInput,
  LogLlmUsageInput,
  WithIncluded,
} from '../repository.ts';
import { AppError } from '../repository.ts';
import { withTransaction, type DbClient } from '../db.ts';
import { withIdempotency } from '../idempotency.ts';
import {
  CLUB_SPEND_USAGE_KINDS,
  finalizeClubSpendBudget,
  releaseClubSpendBudget,
  reserveClubSpendBudget,
} from '../club-spend.ts';
import {
  enforceActionQuota,
  enforceEmbeddingQueryQuota,
  finalizeLlmOutputBudget,
  getQuotaStatus as getQuotaStatusFromEngine,
  reserveLlmOutputBudget,
  QUOTA_ACTIONS,
} from '../quotas.ts';
import { encodeCursor } from '../schemas/fields.ts';
import { emptyIncludedBundle } from '../mentions.ts';
import * as contents from './content.ts';
import * as events from './events.ts';

export { appendClubActivity } from './content.ts';

// ── Vouches ─────────────────────────────────────────────────

export async function checkVouchTargetAccessible(
  db: Pool | DbClient,
  input: { actorMemberId: string; clubId: string; targetMemberId: string },
): Promise<{ vouchable: boolean }> {
  const result = await db.query<{ ok: boolean }>(
    `select exists(
       select 1
       from accessible_club_memberships actor
       join accessible_club_memberships target
         on target.club_id = actor.club_id
       where actor.member_id = $1
         and actor.club_id = $2
         and target.member_id = $3
         and target.member_id <> $1
     ) as ok`,
    [input.actorMemberId, input.clubId, input.targetMemberId],
  );
  return { vouchable: result.rows[0]?.ok === true };
}

export async function createVouch(db: Pool | DbClient, input: {
  actorMemberId: string; clubId: string; targetMemberId: string; reason: string; clientKey?: string | null;
}): Promise<{ edgeId: string; fromMemberId: string; fromPublicName: string; reason: string; metadata: Record<string, unknown>; createdAt: string; creatorMemberId: string | null } | null> {
  const performCreate = async (): Promise<{
    edgeId: string;
    fromMemberId: string;
    fromPublicName: string;
    reason: string;
    metadata: Record<string, unknown>;
    createdAt: string;
    creatorMemberId: string | null;
  } | null> => {
  // Membership verification happens in the composition layer (postgres.ts).
  // The DB has a CHECK constraint preventing self-vouches.

  // If clientKey provided, check for replay/conflict first
  if (input.clientKey) {
    const existing = await db.query<{
      id: string; from_member_id: string; to_member_id: string; club_id: string;
      reason: string; metadata: Record<string, unknown>; created_at: string; created_by_member_id: string | null;
      from_public_name: string | null;
    }>(
      `select e.id, e.from_member_id, e.to_member_id, e.club_id, e.reason, e.metadata,
              e.created_at::text as created_at, e.created_by_member_id,
              m.public_name as from_public_name
       from club_edges e
       join members m on m.id = e.from_member_id
       where e.created_by_member_id = $1 and e.client_key = $2`,
      [input.actorMemberId, input.clientKey],
    );
    if (existing.rows[0]) {
      const orig = existing.rows[0];
      if (orig.club_id !== input.clubId || orig.to_member_id !== input.targetMemberId || orig.reason !== input.reason) {
        throw new AppError('client_key_conflict',
          'This clientKey was already used with a different payload. Use a unique key per vouch.');
      }
      if (!orig.from_public_name) {
        throw new AppError('invalid_data', 'Missing public name for existing vouch author');
      }
      return {
        edgeId: orig.id,
        fromMemberId: orig.from_member_id,
        fromPublicName: orig.from_public_name,
        reason: orig.reason,
        metadata: orig.metadata,
        createdAt: orig.created_at,
        creatorMemberId: orig.created_by_member_id,
      };
    }
  }

  try {
      const result = await db.query<{
      id: string; from_member_id: string; from_public_name: string;
      reason: string; metadata: Record<string, unknown>; created_at: string; created_by_member_id: string | null;
    }>(
      `insert into club_edges (club_id, kind, from_member_id, to_member_id, reason, created_by_member_id, client_key)
       values ($1::text, 'vouched_for', $2::text, $3::text, $4, $2::text, $5)
       returning id, from_member_id,
         (select public_name from members where id = from_member_id) as from_public_name,
         reason, metadata, created_at::text as created_at, created_by_member_id`,
      [input.clubId, input.actorMemberId, input.targetMemberId, input.reason, input.clientKey ?? null],
    );

    const row = result.rows[0];
    if (!row) return null;
    if (!row.from_public_name) {
      throw new AppError('invalid_data', 'Missing public name for vouch author');
    }
    return {
      edgeId: row.id,
      fromMemberId: row.from_member_id,
      fromPublicName: row.from_public_name,
      reason: row.reason,
      metadata: row.metadata,
      createdAt: row.created_at,
      creatorMemberId: row.created_by_member_id,
    };
  } catch (err: unknown) {
    // Distinguish duplicate active vouch from other constraint violations
    const pgErr = err as { code?: string; constraint?: string };
    if (pgErr.code === '23505' && pgErr.constraint === 'club_edges_unique_active_vouch') {
      throw new AppError('duplicate_vouch', 'You have already vouched for this member in this club');
    }
    throw err;
  }
  };

  if (!input.clientKey) {
    return performCreate();
  }

  return withIdempotency(db, {
    clientKey: input.clientKey,
    actorContext: `member:${input.actorMemberId}:vouches.create`,
    requestValue: {
      clubId: input.clubId,
      targetMemberId: input.targetMemberId,
      reason: input.reason,
    },
    execute: async () => ({ responseValue: await performCreate() }),
  });
}

type VouchEntry = { edgeId: string; fromMemberId: string; fromPublicName: string; reason: string; metadata: Record<string, unknown>; createdAt: string; creatorMemberId: string | null };
export type PaginatedVouches = { results: VouchEntry[]; hasMore: boolean; nextCursor: string | null };

export async function listVouches(pool: Pool, input: {
  clubIds: string[]; targetMemberId: string; limit: number;
  cursor?: { createdAt: string; edgeId: string } | null;
}): Promise<PaginatedVouches> {
  const fetchLimit = input.limit + 1;
  const cursorCreatedAt = input.cursor?.createdAt ?? null;
  const cursorEdgeId = input.cursor?.edgeId ?? null;

  const result = await pool.query<{
    id: string; from_member_id: string; from_public_name: string;
    reason: string; metadata: Record<string, unknown>; created_at: string; created_by_member_id: string | null;
  }>(
    `select e.id, e.from_member_id, m.public_name as from_public_name,
            e.reason, e.metadata,
            e.created_at::text as created_at, e.created_by_member_id
     from club_edges e
     join members m on m.id = e.from_member_id
     where e.club_id = any($1::text[]) and e.kind = 'vouched_for'
       and e.to_member_id = $2 and e.archived_at is null
       and ($4::timestamptz is null
         or e.created_at < $4
         or (e.created_at = $4 and e.id < $5))
     order by e.created_at desc, e.id desc limit $3`,
    [input.clubIds, input.targetMemberId, fetchLimit, cursorCreatedAt, cursorEdgeId],
  );

  const rows: VouchEntry[] = result.rows.map((row) => ({
    edgeId: row.id,
    fromMemberId: row.from_member_id,
    fromPublicName: row.from_public_name,
    reason: row.reason,
    metadata: row.metadata,
    createdAt: row.created_at,
    creatorMemberId: row.created_by_member_id,
  }));

  const hasMore = rows.length > input.limit;
  if (hasMore) rows.pop();
  const last = rows[rows.length - 1];
  const nextCursor = last ? encodeCursor([last.createdAt, last.edgeId]) : null;

  return { results: rows, hasMore, nextCursor };
}

/**
 * Batch-load vouches for multiple target members in a single query.
 * Returns a Map keyed by target member ID → vouch array (newest-first, capped at perTargetLimit).
 */
export async function batchListVouches(pool: Pool, input: {
  clubId: string; targetMemberIds: string[]; perTargetLimit: number;
}): Promise<Map<string, VouchEntry[]>> {
  if (input.targetMemberIds.length === 0) return new Map();

  const result = await pool.query<{
    id: string; to_member_id: string; from_member_id: string;
    from_public_name: string;
    reason: string; metadata: Record<string, unknown>;
    created_at: string; created_by_member_id: string | null;
    _rn: number;
  }>(
    `select e.id, e.to_member_id, e.from_member_id,
            m.public_name as from_public_name,
            e.reason, e.metadata,
            e.created_at::text as created_at, e.created_by_member_id,
            row_number() over (partition by e.to_member_id order by e.created_at desc, e.id desc)::int as _rn
     from club_edges e
     join members m on m.id = e.from_member_id
     where e.club_id = $1 and e.kind = 'vouched_for'
       and e.to_member_id = any($2::text[]) and e.archived_at is null
     order by e.to_member_id, e.created_at desc, e.id desc`,
    [input.clubId, input.targetMemberIds],
  );

  const grouped = new Map<string, VouchEntry[]>();
  for (const row of result.rows) {
    if (row._rn > input.perTargetLimit) continue;
    let list = grouped.get(row.to_member_id);
    if (!list) { list = []; grouped.set(row.to_member_id, list); }
    list.push({
      edgeId: row.id,
      fromMemberId: row.from_member_id,
      fromPublicName: row.from_public_name,
      reason: row.reason,
      metadata: row.metadata,
      createdAt: row.created_at,
      creatorMemberId: row.created_by_member_id,
    });
  }

  return grouped;
}

// ── LLM usage logging ───────────────────────────────────────

export async function logLlmUsage(pool: Pool, input: LogLlmUsageInput): Promise<void> {
  await pool.query(
    `insert into ai_llm_usage_log (
       member_id, requested_club_id, action_name, artifact_kind, provider, model,
       gate_status, skip_reason, prompt_tokens, completion_tokens, provider_error_code, feedback
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      input.memberId, input.requestedClubId, input.actionName, input.artifactKind,
      input.provider, input.model, input.gateStatus, input.skipReason,
      input.promptTokens, input.completionTokens, input.providerErrorCode ?? null, input.feedback,
    ],
  );
}

export async function logApiRequest(pool: Pick<Pool, 'query'>, input: LogApiRequestInput): Promise<void> {
  await pool.query(
    `insert into api_request_log (
       member_id, action_name, ip_address
     ) values ($1, $2, $3)`,
    [input.memberId, input.actionName, input.ipAddress],
  );
}

// ── Club activity / updates ─────────────────────────────────

function parseActivitySeq(value: string): number {
  const seq = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new Error(`Invalid club activity seq: ${value}`);
  }
  return seq;
}

export async function listClubActivity(pool: Pool, input: {
  memberId: string; clubIds: string[]; limit: number; afterSeq?: number | null;
  /** Club IDs where the actor is a clubadmin or owner. Used for audience filtering. */
  adminClubIds?: string[];
  /** Club IDs where the actor is the owner. Used for audience filtering. */
  ownerClubIds?: string[];
}): Promise<{ items: Array<{
  activityId: string;
  seq: number;
  clubId: string;
  contentId: string | null;
  contentVersionId: string | null;
  topic: string;
  payload: Record<string, unknown>;
  createdByMember: { memberId: string; publicName: string } | null;
  createdAt: string;
  audience: 'members' | 'clubadmins' | 'owners';
}>; highWaterMark: number; hasMore: boolean }> {
  if (input.afterSeq == null) {
    const seedResult = await pool.query<{ max_seq: string }>(
      `select coalesce(max(seq), 0)::text as max_seq from club_activity`,
    );
    return {
      items: [],
      highWaterMark: parseActivitySeq(seedResult.rows[0]?.max_seq ?? '0'),
      hasMore: false,
    };
  }

  if (input.clubIds.length === 0) {
    return { items: [], highWaterMark: input.afterSeq, hasMore: false };
  }

  const adminClubIds = input.adminClubIds ?? [];
  const ownerClubIds = input.ownerClubIds ?? [];
  const fetchLimit = input.limit + 1;

  const result = await pool.query<{
    id: string; seq: string; club_id: string; content_id: string | null; content_version_id: string | null;
    topic: string; payload: Record<string, unknown>; created_by_member_id: string | null;
    created_by_member_public_name: string | null;
    created_at: string; audience: string;
  }>(
    `select ca.id, ca.seq::text as seq, ca.club_id, ca.content_id, ca.content_version_id, ca.topic, ca.payload,
            ca.created_by_member_id,
            creator.public_name as created_by_member_public_name,
            ca.created_at::text as created_at, ca.audience
     from club_activity ca
     left join members creator on creator.id = ca.created_by_member_id
     where ca.club_id = any($1::text[]) and ca.seq > $2
       and (
         ca.audience = 'members'
         or (ca.audience = 'clubadmins' and ca.club_id = any($4::text[]))
         or (ca.audience = 'owners' and ca.club_id = any($5::text[]))
       )
       and (
         ca.content_id is null
         or ca.topic = 'content.removed'
         or not exists (
           select 1 from current_content_versions cev
           where cev.content_id = ca.content_id and cev.state = 'removed'
         )
       )
     order by ca.seq asc limit $3`,
    [input.clubIds, input.afterSeq, fetchLimit, adminClubIds, ownerClubIds],
  );

  const pageRows = result.rows.slice(0, input.limit);
  const items = pageRows.map((row) => ({
    activityId: row.id,
    seq: parseActivitySeq(row.seq),
    clubId: row.club_id,
    contentId: row.content_id,
    contentVersionId: row.content_version_id,
    topic: row.topic,
    payload: row.payload,
    createdByMember: row.created_by_member_id
      ? {
        memberId: row.created_by_member_id,
        publicName: row.created_by_member_public_name as string,
      }
      : null,
    createdAt: row.created_at,
    audience: row.audience as 'members' | 'clubadmins' | 'owners',
  }));

  return {
    items,
    highWaterMark: items.length > 0 ? items[items.length - 1].seq : input.afterSeq,
    hasMore: result.rows.length > input.limit,
  };
}

// ── Content embedding search ────────────────────────────────

export type PaginatedContentSearch = {
  results: ContentSearchResult[];
  hasMore: boolean;
  nextCursor: string | null;
  included: IncludedBundle;
};

export async function findContentViaEmbedding(pool: Pool, input: {
  actorMemberId: string; clubIds: string[]; queryEmbedding: string; kinds?: string[]; limit: number;
  cursor?: { distance: string; contentId: string } | null;
}): Promise<PaginatedContentSearch> {
  if (input.clubIds.length === 0) {
    return { results: [], hasMore: false, nextCursor: null, included: emptyIncludedBundle() };
  }

  const fetchLimit = input.limit + 1;
  const cursorDist = input.cursor ? parseFloat(input.cursor.distance) : null;
  const cursorId = input.cursor?.contentId ?? null;

  const result = await pool.query<{ content_id: string; _distance: number }>(
    `select e.id as content_id,
            embedding_distance.distance as _distance
     from contents e
     join current_content_versions cev on cev.content_id = e.id
     join lateral (
       select min(eea.embedding <=> $2::vector) as distance
       from content_embeddings eea
       where eea.content_id = e.id
         and eea.content_version_id = cev.id
     ) embedding_distance on true
     where e.club_id = any($1::text[])
       and e.archived_at is null
       and e.deleted_at is null
       and cev.state = 'published'
       and (e.open_loop is null or e.open_loop = true)
       and (cev.expires_at is null or cev.expires_at > now())
       and ($3::text[] is null or e.kind::text = any($3))
       and embedding_distance.distance is not null
       and ($5::float8 is null
         or embedding_distance.distance > $5
         or (embedding_distance.distance = $5 and e.id > $6))
     order by embedding_distance.distance asc, e.id asc
     limit $4`,
    [input.clubIds, input.queryEmbedding, input.kinds ?? null, fetchLimit, cursorDist, cursorId],
  );

  const hasMore = result.rows.length > input.limit;
  const pageRows = hasMore ? result.rows.slice(0, input.limit) : result.rows;

  const contentRows = await withTransaction(pool, async (client) => {
    const viewerMembershipIds = await client.query<{ membership_id: string }>(
      `select id as membership_id
       from accessible_club_memberships
       where member_id = $1
         and club_id = any($2::text[])`,
      [input.actorMemberId, input.clubIds],
    );
    return contents.readContentsBundleByIds(
      client,
      pageRows.map(row => row.content_id),
      viewerMembershipIds.rows.map(row => row.membership_id),
      { memberId: input.actorMemberId },
      { includeExpired: false },
    );
  });

  const scoreByContentId = new Map(pageRows.map((row) => [row.content_id, row._distance]));
  const rows = contentRows.contents.map((content) => ({
    ...content,
    score: scoreByContentId.get(content.id) ?? Number.POSITIVE_INFINITY,
  }));

  const lastRow = pageRows.length > 0 ? pageRows[pageRows.length - 1] : null;
  const nextCursor = hasMore && lastRow
    ? encodeCursor([String(lastRow._distance), lastRow.content_id])
    : null;

  return { results: rows, hasMore, nextCursor, included: contentRows.included };
}

// ── Clubs Repository type ───────────────────────────────────

export type ClubsRepository = {
  createContent(input: CreateContentInput): Promise<WithIncluded<{ content: Content }>>;
  readContent(input: ReadContentInput): Promise<WithIncluded<{ content: Content }> | null>;
  updateContent(input: UpdateContentInput): Promise<WithIncluded<{ content: Content }> | null>;
  loadContentForGate(input: { actorMemberId: string; id: string; accessibleClubIds: string[] }): Promise<ContentForGate | null>;
  resolveContentThreadClubIdForGate(input: { actorMemberId: string; threadId: string; accessibleClubIds: string[] }): Promise<string | null>;
  resolveContentClubIdForGate(input: { actorMemberId: string; contentId: string; accessibleClubIds: string[] }): Promise<string | null>;
  closeContentLoop(input: SetContentLoopInput): Promise<WithIncluded<{ content: Content }> | null>;
  reopenContentLoop(input: SetContentLoopInput): Promise<WithIncluded<{ content: Content }> | null>;
  removeContent(input: {
    id: string;
    accessibleClubIds: string[];
    actorMemberId: string;
    reason?: string | null;
    moderatorRemoval?: { restrictToClubId: string } | null;
  }): Promise<WithIncluded<{ content: Content }> | null>;
  listContent(input: ListContentInput): Promise<import('./content.ts').PaginatedThreads>;
  readContentThread(input: ReadContentThreadInput): Promise<WithIncluded<{ thread: import('../repository.ts').ContentThreadSummary; contents: import('../repository.ts').Content[]; hasMore: boolean; nextCursor: string | null }> | null>;

  checkVouchTargetAccessible(input: { actorMemberId: string; clubId: string; targetMemberId: string }): Promise<{ vouchable: boolean }>;
  createVouch(input: { actorMemberId: string; clubId: string; targetMemberId: string; reason: string; clientKey?: string | null }): Promise<{ edgeId: string; fromMemberId: string; fromPublicName: string; reason: string; metadata: Record<string, unknown>; createdAt: string; creatorMemberId: string | null } | null>;
  listVouches(input: { clubIds: string[]; targetMemberId: string; limit: number; cursor?: { createdAt: string; edgeId: string } | null }): Promise<PaginatedVouches>;

  getQuotaStatus(input: { actorMemberId: string; clubIds: string[]; memberships: Array<{ clubId: string; role: 'member' | 'clubadmin'; isOwner: boolean }> }): Promise<QuotaAllowance[]>;
  logApiRequest(input: LogApiRequestInput): Promise<void>;
  logLlmUsage(input: LogLlmUsageInput): Promise<void>;
  reserveLlmOutputBudget(input: {
    memberId: string;
    clubId: string;
    actionName: string;
    provider: string;
    model: string;
    maxOutputTokens: number;
  }): Promise<{ reservationId: string; quota: QuotaAllowance }>;
  finalizeLlmOutputBudget(input: {
    reservationId: string;
    actualOutputTokens: number;
  }): Promise<void>;
  reserveClubSpendBudget(input: {
    clubId: string;
    memberId: string | null;
    actionName: string;
    usageKind: 'gate' | 'embedding';
    provider: string;
    model: string;
    reservedMicroCents: number;
    reservedInputTokensEstimate: number;
    reservedOutputTokens: number;
  }): Promise<{ reservationId: string }>;
  finalizeClubSpendBudget(input:
    | {
      reservationId: string;
      usageKind: 'gate';
      actualPromptTokens: number;
      actualCompletionTokens: number;
    }
    | {
      reservationId: string;
      usageKind: 'embedding';
      actualEmbeddingTokens: number;
    }
  ): Promise<void>;
  releaseClubSpendBudget(input: {
    reservationId: string;
  }): Promise<void>;
  enforceClubsCreateQuota(input: { memberId: string }): Promise<QuotaAllowance>;
  enforceEmbeddingQueryQuota(input: { memberId: string }): Promise<QuotaAllowance>;

  listClubActivity(input: { memberId: string; clubIds: string[]; limit: number; afterSeq?: number | null; adminClubIds?: string[]; ownerClubIds?: string[] }): Promise<{ items: Array<{
    activityId: string;
    seq: number;
    clubId: string;
    contentId: string | null;
    contentVersionId: string | null;
    topic: string;
    payload: Record<string, unknown>;
    createdByMember: { memberId: string; publicName: string } | null;
    createdAt: string;
    audience: 'members' | 'clubadmins' | 'owners';
  }>; highWaterMark: number; hasMore: boolean }>;

  findContentViaEmbedding(input: { actorMemberId: string; clubIds: string[]; queryEmbedding: string; kinds?: string[]; limit: number; cursor?: { distance: string; contentId: string } | null }): Promise<PaginatedContentSearch>;

  listEvents(input: { actorMemberId: string; clubIds: string[]; limit: number; query?: string; cursor?: { startsAt: string; contentId: string } | null }): Promise<WithIncluded<{ results: import('../repository.ts').ContentThread[]; hasMore: boolean; nextCursor: string | null }>>;
  rsvpEvent(input: { actorMemberId: string; eventId: string; response: import('../repository.ts').EventRsvpState; note?: string | null; accessibleMemberships: Array<{ membershipId: string; clubId: string }> }): Promise<WithIncluded<{ content: import('../repository.ts').Content }> | null>;
  cancelEventRsvp(input: { actorMemberId: string; eventId: string; accessibleMemberships: Array<{ membershipId: string; clubId: string }> }): Promise<WithIncluded<{ content: import('../repository.ts').Content }> | null>;
};

export function createClubsRepository(pool: Pool): ClubsRepository {
  return {
    createContent: (input) => contents.createContent(pool, input),
    readContent: (input) => contents.readContent(pool, input),
    updateContent: (input) => contents.updateContent(pool, input),
    loadContentForGate: (input) => contents.loadContentForGate(pool, input),
    resolveContentThreadClubIdForGate: (input) => contents.resolveContentThreadClubIdForGate(pool, input),
    resolveContentClubIdForGate: (input) => contents.resolveContentClubIdForGate(pool, input),
    closeContentLoop: (input) => contents.closeContentLoop(pool, input),
    reopenContentLoop: (input) => contents.reopenContentLoop(pool, input),
    removeContent: (input) => contents.removeContent(pool, input),
    listContent: (input) => contents.listContent(pool, input),
    readContentThread: (input) => contents.readContentThread(pool, input),

    checkVouchTargetAccessible: (input) => checkVouchTargetAccessible(pool, input),
    createVouch: (input) => createVouch(pool, input),
    listVouches: (input) => listVouches(pool, input),

    getQuotaStatus: (input) => getQuotaStatusFromEngine(pool, input),
    logApiRequest: (input) => logApiRequest(pool, input),
    logLlmUsage: (input) => logLlmUsage(pool, input),
    reserveLlmOutputBudget: (input) => reserveLlmOutputBudget(pool, input),
    finalizeLlmOutputBudget: (input) => finalizeLlmOutputBudget(pool, input),
    reserveClubSpendBudget: (input) => {
      const estimate = input.usageKind === CLUB_SPEND_USAGE_KINDS.gate
        ? {
            usageKind: CLUB_SPEND_USAGE_KINDS.gate,
            reservedMicroCents: input.reservedMicroCents,
            reservedInputTokensEstimate: input.reservedInputTokensEstimate,
            reservedOutputTokens: input.reservedOutputTokens,
          }
        : {
            usageKind: CLUB_SPEND_USAGE_KINDS.embedding,
            reservedMicroCents: input.reservedMicroCents,
            reservedInputTokensEstimate: input.reservedInputTokensEstimate,
            reservedOutputTokens: 0 as const,
          };
      return reserveClubSpendBudget(pool, {
        clubId: input.clubId,
        memberId: input.memberId,
        actionName: input.actionName,
        usageKind: input.usageKind,
        provider: input.provider,
        model: input.model,
        estimate,
      }).then(({ reservationId }) => ({ reservationId }));
    },
    finalizeClubSpendBudget: (input) => finalizeClubSpendBudget(pool, input),
    releaseClubSpendBudget: (input) => releaseClubSpendBudget(pool, input),
    enforceClubsCreateQuota: (input) => withTransaction(pool, async (client) => enforceActionQuota(client, {
      action: QUOTA_ACTIONS.clubsCreate,
      memberId: input.memberId,
    })),
    enforceEmbeddingQueryQuota: (input) => enforceEmbeddingQueryQuota(pool, input.memberId),

    listClubActivity: (input) => listClubActivity(pool, input),

    findContentViaEmbedding: (input) => findContentViaEmbedding(pool, input),

    // Events
    listEvents: (input) => events.listEvents(pool, input),
    rsvpEvent: (input) => events.rsvpEvent(pool, input),
    cancelEventRsvp: (input) => events.cancelEventRsvp(pool, input),
  };
}
