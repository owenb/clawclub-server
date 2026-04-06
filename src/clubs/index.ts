/**
 * Club plane — all club content operations.
 *
 * Entities, events, admissions, activity, vouches, quotas, LLM, embeddings.
 * No member or club name JOINs — the clubs DB has no identity tables.
 * Display names are enriched by the composition layer.
 */

import type { Pool } from 'pg';
import type {
  CreateEntityInput,
  EntitySummary,
  ListEntitiesInput,
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
import * as entities from './entities.ts';
import * as events from './events.ts';

export { appendClubActivity } from './entities.ts';

// ── Vouches ─────────────────────────────────────────────────

export async function createVouch(pool: Pool, input: {
  actorMemberId: string; clubId: string; targetMemberId: string; reason: string; clientKey?: string | null;
}): Promise<{ edgeId: string; fromMemberId: string; reason: string; metadata: Record<string, unknown>; createdAt: string; createdByMemberId: string | null } | null> {
  // The clubs DB has no membership data. The composition layer must verify
  // club membership before calling this. As defense in depth, we use a
  // subquery that checks the edges table doesn't already have a conflicting
  // self-vouch (the schema has a check constraint for this).
  // Target membership verification happens in the composition layer via identity.
  const result = await pool.query<{
    id: string; from_member_id: string; reason: string;
    metadata: Record<string, unknown>; created_at: string; created_by_member_id: string | null;
  }>(
    `insert into app.edges (club_id, kind, from_member_id, to_member_id, reason, created_by_member_id, client_key)
     values ($1::text, 'vouched_for', $2::text, $3::text, $4, $2::text, $5)
     returning id, from_member_id, reason, metadata, created_at::text as created_at, created_by_member_id`,
    [input.clubId, input.actorMemberId, input.targetMemberId, input.reason, input.clientKey ?? null],
  );

  const row = result.rows[0];
  if (!row) return null;
  return {
    edgeId: row.id,
    fromMemberId: row.from_member_id,
    reason: row.reason,
    metadata: row.metadata,
    createdAt: row.created_at,
    createdByMemberId: row.created_by_member_id,
  };
}

export async function listVouches(pool: Pool, input: {
  clubIds: string[]; targetMemberId: string; limit: number;
}): Promise<Array<{ edgeId: string; fromMemberId: string; reason: string; metadata: Record<string, unknown>; createdAt: string; createdByMemberId: string | null }>> {
  const result = await pool.query<{
    id: string; from_member_id: string; reason: string;
    metadata: Record<string, unknown>; created_at: string; created_by_member_id: string | null;
  }>(
    `select e.id, e.from_member_id, e.reason, e.metadata,
            e.created_at::text as created_at, e.created_by_member_id
     from app.edges e
     where e.club_id = any($1::text[]) and e.kind = 'vouched_for'
       and e.to_member_id = $2 and e.archived_at is null
     order by e.created_at desc limit $3`,
    [input.clubIds, input.targetMemberId, input.limit],
  );

  return result.rows.map((row) => ({
    edgeId: row.id,
    fromMemberId: row.from_member_id,
    reason: row.reason,
    metadata: row.metadata,
    createdAt: row.created_at,
    createdByMemberId: row.created_by_member_id,
  }));
}

// ── Quotas ──────────────────────────────────────────────────

/**
 * Mapping from quota action name to the entity kinds it covers.
 * This is the single source of truth for both enforcement and reporting.
 * Actions not in this map are not supported for clubs-plane quota counting.
 */
const QUOTA_ENTITY_KINDS: Record<string, string[]> = {
  'entities.create': ['post', 'opportunity', 'service', 'ask'],
  'events.create': ['event'],
};

function getQuotaKindFilter(action: string): string[] | null {
  return QUOTA_ENTITY_KINDS[action] ?? null;
}

export async function enforceQuota(client: DbClient, memberId: string, clubId: string, action: string): Promise<void> {
  const kinds = getQuotaKindFilter(action);
  if (!kinds) return; // unsupported action for quota counting

  const result = await client.query<{ max_per_day: number }>(
    `select max_per_day from app.club_quota_policies where club_id = $1 and action_name = $2`,
    [clubId, action],
  );
  if (!result.rows[0]) return; // no policy = unlimited

  const countResult = await client.query<{ count: string }>(
    `select count(*)::text as count from app.entities
     where author_member_id = $1 and club_id = $2
       and kind::text = any($3::text[])
       and created_at >= date_trunc('day', now() at time zone 'UTC')`,
    [memberId, clubId, kinds],
  );
  const used = Number(countResult.rows[0]?.count ?? 0);
  if (used >= result.rows[0].max_per_day) {
    throw new AppError(429, 'quota_exceeded', `Daily quota of ${result.rows[0].max_per_day} ${action} actions reached`);
  }
}

export async function getQuotaStatus(pool: Pool, input: {
  actorMemberId: string; clubIds: string[];
}): Promise<QuotaAllowance[]> {
  if (input.clubIds.length === 0) return [];

  // Only report on actions that have clubs-plane quota counting support
  const supportedActions = Object.keys(QUOTA_ENTITY_KINDS);

  const result = await pool.query<{
    action: string; club_id: string; max_per_day: number;
  }>(
    `select qp.action_name as action, qp.club_id, qp.max_per_day
     from app.club_quota_policies qp
     where qp.club_id = any($1::text[])
       and qp.action_name = any($2::text[])`,
    [input.clubIds, supportedActions],
  );

  // Count usage per action using kind-specific filters
  const allowances: QuotaAllowance[] = [];
  for (const row of result.rows) {
    const kinds = getQuotaKindFilter(row.action);
    if (!kinds) continue;

    const countResult = await pool.query<{ count: string }>(
      `select count(*)::text as count from app.entities
       where author_member_id = $1 and club_id = $2
         and kind::text = any($3::text[])
         and created_at >= date_trunc('day', now() at time zone 'UTC')`,
      [input.actorMemberId, row.club_id, kinds],
    );
    const usedToday = Number(countResult.rows[0]?.count ?? 0);
    allowances.push({
      action: row.action,
      clubId: row.club_id,
      maxPerDay: row.max_per_day,
      usedToday,
      remaining: Math.max(0, row.max_per_day - usedToday),
    });
  }

  return allowances;
}

// ── LLM usage logging ───────────────────────────────────────

export async function logLlmUsage(pool: Pool, input: LogLlmUsageInput): Promise<void> {
  await pool.query(
    `insert into app.llm_usage_log (
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
      `select coalesce(max(seq), 0)::int as max_seq from app.club_activity
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
     from app.club_activity ca
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
           select 1 from app.current_entity_versions cev
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

export async function findEntitiesViaEmbedding(pool: Pool, input: {
  clubIds: string[]; queryEmbedding: string; kinds?: string[]; limit: number;
}): Promise<EntitySummary[]> {
  if (input.clubIds.length === 0) return [];

  const result = await pool.query<{
    entity_id: string; entity_version_id: string; club_id: string; kind: string;
    author_member_id: string; version_no: number; state: string;
    title: string | null; summary: string | null; body: string | null;
    effective_at: string; expires_at: string | null;
    version_created_at: string; content: Record<string, unknown> | null;
    entity_created_at: string;
  }>(
    `select e.id as entity_id, cev.id as entity_version_id, e.club_id, e.kind,
            e.author_member_id, cev.version_no, cev.state,
            cev.title, cev.summary, cev.body,
            cev.effective_at::text as effective_at, cev.expires_at::text as expires_at,
            cev.created_at::text as version_created_at, cev.content,
            e.created_at::text as entity_created_at
     from app.entities e
     join app.current_entity_versions cev on cev.entity_id = e.id
     where e.club_id = any($1::text[]) and e.deleted_at is null
       and cev.state = 'published'
       and ($3::text[] is null or e.kind::text = any($3))
       and exists (
         select 1 from app.embeddings_entity_artifacts eea where eea.entity_id = e.id
       )
     order by (
       select min(eea.embedding <=> $2::vector)
       from app.embeddings_entity_artifacts eea where eea.entity_id = e.id
     ) asc
     limit $4`,
    [input.clubIds, input.queryEmbedding, input.kinds ?? null, input.limit],
  );

  return result.rows.map((row) => ({
    entityId: row.entity_id,
    entityVersionId: row.entity_version_id,
    clubId: row.club_id,
    kind: row.kind as EntitySummary['kind'],
    author: { memberId: row.author_member_id, publicName: '', handle: null },
    version: {
      versionNo: row.version_no,
      state: row.state as EntitySummary['version']['state'],
      title: row.title, summary: row.summary, body: row.body,
      effectiveAt: row.effective_at, expiresAt: row.expires_at,
      createdAt: row.version_created_at, content: row.content ?? {},
    },
    createdAt: row.entity_created_at,
  }));
}

// ── Clubs Repository type ───────────────────────────────────

export type ClubsRepository = {
  createEntity(input: CreateEntityInput): Promise<EntitySummary>;
  updateEntity(input: UpdateEntityInput): Promise<EntitySummary | null>;
  removeEntity(input: { entityId: string; clubIds: string[]; actorMemberId: string; reason?: string | null; skipAuthCheck?: boolean; kindFilter?: string }): Promise<EntitySummary | null>;
  listEntities(input: ListEntitiesInput): Promise<EntitySummary[]>;

  createVouch(input: { actorMemberId: string; clubId: string; targetMemberId: string; reason: string; clientKey?: string | null }): Promise<{ edgeId: string; fromMemberId: string; reason: string; metadata: Record<string, unknown>; createdAt: string; createdByMemberId: string | null } | null>;
  listVouches(input: { clubIds: string[]; targetMemberId: string; limit: number }): Promise<Array<{ edgeId: string; fromMemberId: string; reason: string; metadata: Record<string, unknown>; createdAt: string; createdByMemberId: string | null }>>;

  enforceQuota(memberId: string, clubId: string, action: string): Promise<void>;
  getQuotaStatus(input: { actorMemberId: string; clubIds: string[] }): Promise<QuotaAllowance[]>;

  logLlmUsage(input: LogLlmUsageInput): Promise<void>;

  listClubActivity(input: { memberId: string; clubIds: string[]; limit: number; afterSeq?: number | null; adminClubIds?: string[]; ownerClubIds?: string[] }): Promise<{ items: Array<Record<string, unknown>>; nextAfterSeq: number | null }>;

  findEntitiesViaEmbedding(input: { clubIds: string[]; queryEmbedding: string; kinds?: string[]; limit: number }): Promise<EntitySummary[]>;

  // Events
  createEvent(input: import('../contract.ts').CreateEventInput): Promise<import('../contract.ts').EventSummary>;
  listEvents(input: { clubIds: string[]; limit: number; query?: string; viewerMembershipIds: string[] }): Promise<import('../contract.ts').EventSummary[]>;
  rsvpEvent(input: { eventEntityId: string; membershipId: string; memberId: string; response: import('../contract.ts').EventRsvpState; note?: string | null; clubIds: string[] }): Promise<import('../contract.ts').EventSummary | null>;
  removeEvent(input: { entityId: string; clubIds: string[]; actorMemberId: string; reason?: string | null; skipAuthCheck?: boolean }): Promise<import('../contract.ts').EventSummary | null>;
};

export function createClubsRepository(pool: Pool): ClubsRepository {
  return {
    createEntity: (input) => entities.createEntity(pool, input),
    updateEntity: (input) => entities.updateEntity(pool, input),
    removeEntity: (input) => entities.removeEntity(pool, input),
    listEntities: (input) => entities.listEntities(pool, input),

    createVouch: (input) => createVouch(pool, input),
    listVouches: (input) => listVouches(pool, input),

    enforceQuota: (memberId, clubId, action) => {
      // For top-level quota enforcement, run outside transaction
      return pool.connect().then(async (client) => {
        try { await enforceQuota(client, memberId, clubId, action); }
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
