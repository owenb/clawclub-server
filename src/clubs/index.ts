/**
 * Clubs domain — entities, events, admissions, activity, vouches, quotas, LLM, embeddings.
 */

import type { Pool } from 'pg';
import type {
  CreateEntityInput,
  EntitySummary,
  ListEntitiesInput,
  MemberAdmissionRecord,
  SetEntityLoopInput,
  UpdateEntityInput,
  MembershipVouchSummary,
  QuotaAllowance,
  LogLlmUsageInput,
  AdmissionSummary,
  AdmissionStatus,
  CreateAdmissionSponsorInput,
  CreateAdmissionChallengeInput,
  AdmissionChallengeResult,
  SolveAdmissionChallengeInput,
  AdmissionApplyResult,
  TransitionAdmissionInput,
} from '../contract.ts';
import { AppError } from '../contract.ts';
import { withTransaction, type DbClient } from '../db.ts';
import { encodeCursor } from '../schemas/fields.ts';
import * as admissionsModule from './admissions.ts';
import * as entities from './entities.ts';
import * as events from './events.ts';

export { appendClubActivity } from './entities.ts';

// ── Vouches ─────────────────────────────────────────────────

export async function createVouch(pool: Pool, input: {
  actorMemberId: string; clubId: string; targetMemberId: string; reason: string; clientKey?: string | null;
}): Promise<{ edgeId: string; fromMemberId: string; fromPublicName: string; fromHandle: string | null; reason: string; metadata: Record<string, unknown>; createdAt: string; createdByMemberId: string | null } | null> {
  // Membership verification happens in the composition layer (postgres.ts).
  // The DB has a CHECK constraint preventing self-vouches.

  // If clientKey provided, check for replay/conflict first
  if (input.clientKey) {
    const existing = await pool.query<{
      id: string; from_member_id: string; to_member_id: string; club_id: string;
      reason: string; metadata: Record<string, unknown>; created_at: string; created_by_member_id: string | null;
      from_public_name: string | null; from_handle: string | null;
    }>(
      `select e.id, e.from_member_id, e.to_member_id, e.club_id, e.reason, e.metadata,
              e.created_at::text as created_at, e.created_by_member_id,
              m.public_name as from_public_name, m.handle as from_handle
       from club_edges e
       join members m on m.id = e.from_member_id
       where e.created_by_member_id = $1 and e.client_key = $2`,
      [input.actorMemberId, input.clientKey],
    );
    if (existing.rows[0]) {
      const orig = existing.rows[0];
      if (orig.club_id !== input.clubId || orig.to_member_id !== input.targetMemberId || orig.reason !== input.reason) {
        throw new AppError(409, 'client_key_conflict',
          'This clientKey was already used with a different payload. Use a unique key per vouch.');
      }
      return {
        edgeId: orig.id,
        fromMemberId: orig.from_member_id,
        fromPublicName: orig.from_public_name ?? 'Unknown',
        fromHandle: orig.from_handle,
        reason: orig.reason,
        metadata: orig.metadata,
        createdAt: orig.created_at,
        createdByMemberId: orig.created_by_member_id,
      };
    }
  }

  try {
    const result = await pool.query<{
      id: string; from_member_id: string; from_public_name: string; from_handle: string | null;
      reason: string; metadata: Record<string, unknown>; created_at: string; created_by_member_id: string | null;
    }>(
      `insert into club_edges (club_id, kind, from_member_id, to_member_id, reason, created_by_member_id, client_key)
       values ($1::text, 'vouched_for', $2::text, $3::text, $4, $2::text, $5)
       returning id, from_member_id,
         (select public_name from members where id = from_member_id) as from_public_name,
         (select handle from members where id = from_member_id) as from_handle,
         reason, metadata, created_at::text as created_at, created_by_member_id`,
      [input.clubId, input.actorMemberId, input.targetMemberId, input.reason, input.clientKey ?? null],
    );

    const row = result.rows[0];
    if (!row) return null;
    return {
      edgeId: row.id,
      fromMemberId: row.from_member_id,
      fromPublicName: row.from_public_name ?? 'Unknown',
      fromHandle: row.from_handle,
      reason: row.reason,
      metadata: row.metadata,
      createdAt: row.created_at,
      createdByMemberId: row.created_by_member_id,
    };
  } catch (err: unknown) {
    // Distinguish duplicate active vouch from other constraint violations
    const pgErr = err as { code?: string; constraint?: string };
    if (pgErr.code === '23505' && pgErr.constraint === 'club_edges_unique_active_vouch') {
      throw new AppError(409, 'duplicate_vouch', 'You have already vouched for this member in this club');
    }
    throw err;
  }
}

type VouchEntry = { edgeId: string; fromMemberId: string; fromPublicName: string; fromHandle: string | null; reason: string; metadata: Record<string, unknown>; createdAt: string; createdByMemberId: string | null };
export type PaginatedVouches = { results: VouchEntry[]; hasMore: boolean; nextCursor: string | null };

export async function listVouches(pool: Pool, input: {
  clubIds: string[]; targetMemberId: string; limit: number;
  cursor?: { createdAt: string; edgeId: string } | null;
}): Promise<PaginatedVouches> {
  const fetchLimit = input.limit + 1;
  const cursorCreatedAt = input.cursor?.createdAt ?? null;
  const cursorEdgeId = input.cursor?.edgeId ?? null;

  const result = await pool.query<{
    id: string; from_member_id: string; from_public_name: string; from_handle: string | null;
    reason: string; metadata: Record<string, unknown>; created_at: string; created_by_member_id: string | null;
  }>(
    `select e.id, e.from_member_id, m.public_name as from_public_name, m.handle as from_handle,
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
    fromHandle: row.from_handle,
    reason: row.reason,
    metadata: row.metadata,
    createdAt: row.created_at,
    createdByMemberId: row.created_by_member_id,
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
    from_public_name: string; from_handle: string | null;
    reason: string; metadata: Record<string, unknown>;
    created_at: string; created_by_member_id: string | null;
    _rn: number;
  }>(
    `select e.id, e.to_member_id, e.from_member_id,
            m.public_name as from_public_name, m.handle as from_handle,
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
      fromHandle: row.from_handle,
      reason: row.reason,
      metadata: row.metadata,
      createdAt: row.created_at,
      createdByMemberId: row.created_by_member_id,
    });
  }

  return grouped;
}

// ── Quotas ──────────────────────────────────────────────────

/**
 * Mapping from quota action name to the entity kinds it covers.
 * This is the single source of truth for both enforcement and reporting.
 * Actions not in this map are not supported for quota counting.
 */
const QUOTA_ENTITY_KINDS: Record<string, string[]> = {
  'content.create': ['post', 'opportunity', 'service', 'ask', 'gift'],
  'events.create': ['event'],
};

function getQuotaKindFilter(action: string): string[] | null {
  return QUOTA_ENTITY_KINDS[action] ?? null;
}

/**
 * Role multiplier for quota enforcement.
 * - normal member: 1x
 * - clubadmin: 3x
 * - club owner: 3x
 */
const ROLE_MULTIPLIER_ADMIN = 3;

export type QuotaActorInfo = {
  role: 'member' | 'clubadmin';
  isOwner: boolean;
};

function effectiveMultiplier(actor: QuotaActorInfo): number {
  if (actor.isOwner || actor.role === 'clubadmin') return ROLE_MULTIPLIER_ADMIN;
  return 1;
}

/**
 * Resolve the base quota for a given club+action.
 * Checks for a club-specific override first, then falls back to the global default.
 * Returns null only if no policy exists at all (schema/bootstrap bug).
 */
async function resolveBaseQuota(client: DbClient, clubId: string, action: string): Promise<number | null> {
  // Try club-specific override first
  const clubResult = await client.query<{ max_per_day: number }>(
    `select max_per_day from quota_policies where scope = 'club' and club_id = $1 and action_name = $2`,
    [clubId, action],
  );
  if (clubResult.rows[0]) return clubResult.rows[0].max_per_day;

  // Fall back to global default
  const globalResult = await client.query<{ max_per_day: number }>(
    `select max_per_day from quota_policies where scope = 'global' and action_name = $1`,
    [action],
  );
  if (globalResult.rows[0]) return globalResult.rows[0].max_per_day;

  return null; // No policy at all — bootstrap bug
}

export async function enforceQuota(client: DbClient, memberId: string, clubId: string, action: string, actorInfo: QuotaActorInfo): Promise<void> {
  const kinds = getQuotaKindFilter(action);
  if (!kinds) return; // unsupported action for quota counting

  const base = await resolveBaseQuota(client, clubId, action);
  if (base === null) {
    // No policy at all — should not happen with proper bootstrap.
    // Fail closed: treat as exhausted.
    throw new AppError(429, 'quota_exceeded', `No quota policy found for ${action} — contact support`);
  }

  const effectiveMax = base * effectiveMultiplier(actorInfo);

  const countResult = await client.query<{ count: string }>(
    `select count(*)::text as count from entities
     where author_member_id = $1 and club_id = $2
       and kind::text = any($3::text[])
       and created_at >= date_trunc('day', now() at time zone 'UTC')`,
    [memberId, clubId, kinds],
  );
  const used = Number(countResult.rows[0]?.count ?? 0);
  if (used >= effectiveMax) {
    throw new AppError(429, 'quota_exceeded', `Daily quota of ${effectiveMax} ${action} actions reached`);
  }
}

export async function getQuotaStatus(pool: Pool, input: {
  actorMemberId: string; clubIds: string[];
  memberships: Array<{ clubId: string; role: 'member' | 'clubadmin'; isOwner: boolean }>;
}): Promise<QuotaAllowance[]> {
  if (input.clubIds.length === 0) return [];

  // Only report on actions that have quota counting support
  const supportedActions = Object.keys(QUOTA_ENTITY_KINDS);

  // Build a lookup for actor's role per club
  const roleByClub = new Map<string, QuotaActorInfo>();
  for (const m of input.memberships) {
    roleByClub.set(m.clubId, { role: m.role, isOwner: m.isOwner });
  }

  // Load club-specific overrides
  const clubOverrides = await pool.query<{
    action: string; club_id: string; max_per_day: number;
  }>(
    `select qp.action_name as action, qp.club_id, qp.max_per_day
     from quota_policies qp
     where qp.scope = 'club'
       and qp.club_id = any($1::text[])
       and qp.action_name = any($2::text[])`,
    [input.clubIds, supportedActions],
  );

  // Load global defaults
  const globalDefaults = await pool.query<{
    action: string; max_per_day: number;
  }>(
    `select qp.action_name as action, qp.max_per_day
     from quota_policies qp
     where qp.scope = 'global'
       and qp.action_name = any($1::text[])`,
    [supportedActions],
  );

  // Build a map of club overrides keyed by "clubId:action"
  const overrideMap = new Map<string, number>();
  for (const row of clubOverrides.rows) {
    overrideMap.set(`${row.club_id}:${row.action}`, row.max_per_day);
  }

  // Build a map of global defaults keyed by action
  const globalMap = new Map<string, number>();
  for (const row of globalDefaults.rows) {
    globalMap.set(row.action, row.max_per_day);
  }

  // For each club and each supported action, produce a quota row
  const allowances: QuotaAllowance[] = [];
  for (const clubId of input.clubIds) {
    const actorInfo = roleByClub.get(clubId) ?? { role: 'member' as const, isOwner: false };
    const multiplier = effectiveMultiplier(actorInfo);

    for (const action of supportedActions) {
      const base = overrideMap.get(`${clubId}:${action}`) ?? globalMap.get(action);
      if (base === undefined) continue; // no policy at all (bootstrap bug)

      const effectiveMax = base * multiplier;
      const kinds = getQuotaKindFilter(action);
      if (!kinds) continue;

      const countResult = await pool.query<{ count: string }>(
        `select count(*)::text as count from entities
         where author_member_id = $1 and club_id = $2
           and kind::text = any($3::text[])
           and created_at >= date_trunc('day', now() at time zone 'UTC')`,
        [input.actorMemberId, clubId, kinds],
      );
      const usedToday = Number(countResult.rows[0]?.count ?? 0);
      allowances.push({
        action,
        clubId,
        maxPerDay: effectiveMax,
        usedToday,
        remaining: Math.max(0, effectiveMax - usedToday),
      });
    }
  }

  return allowances;
}

// ── LLM usage logging ───────────────────────────────────────

export async function logLlmUsage(pool: Pool, input: LogLlmUsageInput): Promise<void> {
  await pool.query(
    `insert into ai_llm_usage_log (
       member_id, requested_club_id, action_name, gate_name, provider, model,
       gate_status, skip_reason, prompt_tokens, completion_tokens, provider_error_code
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      input.memberId, input.requestedClubId, input.actionName, input.gateName ?? 'quality_gate',
      input.provider, input.model, input.gateStatus, input.skipReason,
      input.promptTokens, input.completionTokens, input.providerErrorCode ?? null,
    ],
  );
}

// ── Club activity / updates ─────────────────────────────────

export async function listClubActivity(pool: Pool, input: {
  memberId: string; clubIds: string[]; limit: number; afterSeq?: number | null;
  /** Club IDs where the actor is a clubadmin or owner. Used for audience filtering. */
  adminClubIds?: string[];
  /** Club IDs where the actor is the owner. Used for audience filtering. */
  ownerClubIds?: string[];
}): Promise<{ items: Array<Record<string, unknown>>; nextAfterSeq: number | null }> {
  if (input.clubIds.length === 0) return { items: [], nextAfterSeq: null };

  const adminClubIds = input.adminClubIds ?? [];
  const ownerClubIds = input.ownerClubIds ?? [];

  // Seed cursor if needed
  if (input.afterSeq == null) {
    const seedResult = await pool.query<{ max_seq: number }>(
      `select coalesce(max(seq), 0)::int as max_seq from club_activity
       where club_id = any($1::text[])`,
      [input.clubIds],
    );
    return { items: [], nextAfterSeq: seedResult.rows[0]?.max_seq ?? 0 };
  }

  const result = await pool.query<{
    seq: number; club_id: string; entity_id: string | null; entity_version_id: string | null;
    topic: string; payload: Record<string, unknown>; created_by_member_id: string | null;
    created_at: string; audience: string;
  }>(
    `select seq, club_id, entity_id, entity_version_id, topic, payload,
            created_by_member_id, created_at::text as created_at, audience
     from club_activity ca
     where ca.club_id = any($1::text[]) and ca.seq > $2
       and (
         ca.audience = 'members'
         or (ca.audience = 'clubadmins' and ca.club_id = any($4::text[]))
         or (ca.audience = 'owners' and ca.club_id = any($5::text[]))
       )
       and (
         ca.entity_id is null
         or ca.topic = 'entity.removed'
         or not exists (
           select 1 from current_entity_versions cev
           where cev.entity_id = ca.entity_id and cev.state = 'removed'
         )
       )
     order by ca.seq asc limit $3`,
    [input.clubIds, input.afterSeq, input.limit, adminClubIds, ownerClubIds],
  );

  const items = result.rows.map((row) => ({
    seq: row.seq,
    clubId: row.club_id,
    entityId: row.entity_id,
    entityVersionId: row.entity_version_id,
    topic: row.topic,
    payload: row.payload,
    createdByMemberId: row.created_by_member_id,
    createdAt: row.created_at,
  }));

  const lastSeq = items.length > 0 ? items[items.length - 1].seq : input.afterSeq;
  return { items, nextAfterSeq: lastSeq };
}

// ── Entity embedding search ─────────────────────────────────

export type PaginatedEntitySearch = { results: EntitySummary[]; hasMore: boolean; nextCursor: string | null };

export async function findEntitiesViaEmbedding(pool: Pool, input: {
  actorMemberId: string; clubIds: string[]; queryEmbedding: string; kinds?: string[]; limit: number;
  cursor?: { distance: string; entityId: string } | null;
}): Promise<PaginatedEntitySearch> {
  if (input.clubIds.length === 0) return { results: [], hasMore: false, nextCursor: null };

  const fetchLimit = input.limit + 1;
  const cursorDist = input.cursor ? parseFloat(input.cursor.distance) : null;
  const cursorId = input.cursor?.entityId ?? null;

  const result = await pool.query<{
    entity_id: string; entity_version_id: string; club_id: string; kind: string; open_loop: boolean | null;
    author_member_id: string; author_public_name: string; author_handle: string | null;
    version_no: number; state: string;
    title: string | null; summary: string | null; body: string | null;
    effective_at: string; expires_at: string | null;
    version_created_at: string; content: Record<string, unknown> | null;
    entity_created_at: string;
    _distance: number;
  }>(
    `select e.id as entity_id, cev.id as entity_version_id, e.club_id, e.kind, e.open_loop,
            e.author_member_id, m.public_name as author_public_name, m.handle as author_handle,
            cev.version_no, cev.state,
            cev.title, cev.summary, cev.body,
            cev.effective_at::text as effective_at, cev.expires_at::text as expires_at,
            cev.created_at::text as version_created_at, cev.content,
            e.created_at::text as entity_created_at,
            (select min(eea.embedding <=> $2::vector)
             from entity_embeddings eea
             where eea.entity_id = e.id and eea.entity_version_id = cev.id
            ) as _distance
     from entities e
     join current_entity_versions cev on cev.entity_id = e.id
     join members m on m.id = e.author_member_id
     where e.club_id = any($1::text[]) and e.deleted_at is null
       and cev.state = 'published'
       and (e.open_loop is null or e.open_loop = true)
       and (cev.expires_at is null or cev.expires_at > now())
       and ($3::text[] is null or e.kind::text = any($3))
       and exists (
         select 1 from entity_embeddings eea
         where eea.entity_id = e.id and eea.entity_version_id = cev.id
       )
       and ($5::float8 is null
         or (select min(eea.embedding <=> $2::vector) from entity_embeddings eea where eea.entity_id = e.id and eea.entity_version_id = cev.id) > $5
         or ((select min(eea.embedding <=> $2::vector) from entity_embeddings eea where eea.entity_id = e.id and eea.entity_version_id = cev.id) = $5 and e.id > $6))
     order by _distance asc, e.id asc
     limit $4`,
    [input.clubIds, input.queryEmbedding, input.kinds ?? null, fetchLimit, cursorDist, cursorId],
  );

  const rows: EntitySummary[] = result.rows.map((row) => ({
    entityId: row.entity_id,
    entityVersionId: row.entity_version_id,
    clubId: row.club_id,
    kind: row.kind as EntitySummary['kind'],
    openLoop: row.open_loop,
    author: { memberId: row.author_member_id, publicName: row.author_public_name, handle: row.author_handle },
    version: {
      versionNo: row.version_no,
      state: row.state as EntitySummary['version']['state'],
      title: row.title, summary: row.summary, body: row.body,
      effectiveAt: row.effective_at, expiresAt: row.expires_at,
      createdAt: row.version_created_at, content: row.content ?? {},
    },
    createdAt: row.entity_created_at,
  }));

  const hasMore = rows.length > input.limit;
  if (hasMore) rows.pop();
  const lastRow = hasMore || rows.length === input.limit ? result.rows[rows.length - 1] : null;
  const nextCursor = lastRow && rows.length > 0
    ? encodeCursor([String(lastRow._distance), lastRow.entity_id])
    : null;

  return { results: rows, hasMore, nextCursor };
}

// ── Clubs Repository type ───────────────────────────────────

export type ClubsRepository = {
  createEntity(input: CreateEntityInput): Promise<EntitySummary>;
  updateEntity(input: UpdateEntityInput): Promise<EntitySummary | null>;
  closeEntityLoop(input: SetEntityLoopInput): Promise<EntitySummary | null>;
  reopenEntityLoop(input: SetEntityLoopInput): Promise<EntitySummary | null>;
  removeEntity(input: { entityId: string; clubIds: string[]; actorMemberId: string; reason?: string | null; skipAuthCheck?: boolean; kindFilter?: string }): Promise<EntitySummary | null>;
  listEntities(input: ListEntitiesInput & { rawCursor?: string | null }): Promise<import('./entities.ts').PaginatedEntities>;
  getAdmissionsForMember(input: { memberId: string; clubId?: string }): Promise<MemberAdmissionRecord[]>;

  createVouch(input: { actorMemberId: string; clubId: string; targetMemberId: string; reason: string; clientKey?: string | null }): Promise<{ edgeId: string; fromMemberId: string; fromPublicName: string; fromHandle: string | null; reason: string; metadata: Record<string, unknown>; createdAt: string; createdByMemberId: string | null } | null>;
  listVouches(input: { clubIds: string[]; targetMemberId: string; limit: number; cursor?: { createdAt: string; edgeId: string } | null }): Promise<PaginatedVouches>;

  enforceQuota(memberId: string, clubId: string, action: string, actorInfo: QuotaActorInfo): Promise<void>;
  getQuotaStatus(input: { actorMemberId: string; clubIds: string[]; memberships: Array<{ clubId: string; role: 'member' | 'clubadmin'; isOwner: boolean }> }): Promise<QuotaAllowance[]>;

  logLlmUsage(input: LogLlmUsageInput): Promise<void>;

  listClubActivity(input: { memberId: string; clubIds: string[]; limit: number; afterSeq?: number | null; adminClubIds?: string[]; ownerClubIds?: string[] }): Promise<{ items: Array<Record<string, unknown>>; nextAfterSeq: number | null }>;

  findEntitiesViaEmbedding(input: { actorMemberId: string; clubIds: string[]; queryEmbedding: string; kinds?: string[]; limit: number; cursor?: { distance: string; entityId: string } | null }): Promise<PaginatedEntitySearch>;

  // Events
  createEvent(input: import('../contract.ts').CreateEventInput): Promise<import('../contract.ts').EventSummary>;
  listEvents(input: { clubIds: string[]; limit: number; query?: string; viewerMembershipIds: string[]; cursor?: { effectiveAt: string; entityId: string } | null }): Promise<{ results: import('../contract.ts').EventSummary[]; hasMore: boolean; nextCursor: string | null }>;
  rsvpEvent(input: { eventEntityId: string; membershipId: string; memberId: string; response: import('../contract.ts').EventRsvpState; note?: string | null; clubIds: string[] }): Promise<import('../contract.ts').EventSummary | null>;
  removeEvent(input: { entityId: string; clubIds: string[]; actorMemberId: string; reason?: string | null; skipAuthCheck?: boolean }): Promise<import('../contract.ts').EventSummary | null>;
};

export function createClubsRepository(pool: Pool): ClubsRepository {
  return {
    createEntity: (input) => entities.createEntity(pool, input),
    updateEntity: (input) => entities.updateEntity(pool, input),
    closeEntityLoop: (input) => entities.closeEntityLoop(pool, input),
    reopenEntityLoop: (input) => entities.reopenEntityLoop(pool, input),
    removeEntity: (input) => entities.removeEntity(pool, input),
    listEntities: (input) => entities.listEntities(pool, input),
    getAdmissionsForMember: (input) => admissionsModule.getAdmissionsForMember(pool, input),

    createVouch: (input) => createVouch(pool, input),
    listVouches: (input) => listVouches(pool, input),

    enforceQuota: (memberId, clubId, action, actorInfo) => {
      // For top-level quota enforcement, run outside transaction
      return pool.connect().then(async (client) => {
        try { await enforceQuota(client, memberId, clubId, action, actorInfo); }
        finally { client.release(); }
      });
    },
    getQuotaStatus: (input) => getQuotaStatus(pool, input),

    logLlmUsage: (input) => logLlmUsage(pool, input),

    listClubActivity: (input) => listClubActivity(pool, input),

    findEntitiesViaEmbedding: (input) => findEntitiesViaEmbedding(pool, input),

    // Events
    createEvent: (input) => events.createEvent(pool, input),
    listEvents: (input) => events.listEvents(pool, input),
    rsvpEvent: (input) => events.rsvpEvent(pool, input),
    removeEvent: (input) => events.removeEvent(pool, input),
  };
}
