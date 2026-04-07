/**
 * Transport-level envelope schemas.
 *
 * These define the HTTP response shapes that wrap action-specific data.
 * Two success envelopes:
 *   - Authenticated: includes actor context (member, roles, memberships, scope)
 *   - Unauthenticated: bare action + data (cold admissions only)
 *
 * Plus the error envelope and polling/SSE response shapes.
 */
import { z } from 'zod';
import { membershipSummary, pendingUpdate, memberUpdates } from './responses.ts';

// ── Actor envelope ───────────────────────────────────────

export const requestScope = z.object({
  requestedClubId: z.string().nullable(),
  activeClubIds: z.array(z.string()),
});

export const sharedContext = z.object({
  pendingUpdates: z.array(pendingUpdate),
});

export const actorEnvelope = z.object({
  member: z.object({
    id: z.string(),
    handle: z.string().nullable(),
    publicName: z.string(),
  }),
  globalRoles: z.array(z.string()),
  activeMemberships: z.array(membershipSummary),
  requestScope,
  sharedContext,
});

// ── Notices ──────────────────────────────────────────────

export const responseNotice = z.object({
  code: z.string(),
  message: z.string(),
});

// ── Success envelopes ────────────────────────────────────

export const authenticatedSuccessEnvelope = z.object({
  ok: z.literal(true),
  action: z.string(),
  actor: actorEnvelope,
  data: z.unknown(),
  notices: z.array(responseNotice).optional(),
});

export const unauthenticatedSuccessEnvelope = z.object({
  ok: z.literal(true),
  action: z.string(),
  data: z.unknown(),
  notices: z.array(responseNotice).optional(),
});

// ── Error envelope ───────────────────────────────────────

export const errorEnvelope = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestTemplate: z.unknown().optional(),
  }),
});

// ── Polling response (GET /updates) ──────────────────────

export const pollingResponse = z.object({
  ok: z.literal(true),
  member: z.object({
    id: z.string(),
    handle: z.string().nullable(),
    publicName: z.string(),
  }),
  requestScope,
  updates: memberUpdates,
});

// ── SSE events (GET /updates/stream) ─────────────────────

export const sseReadyEvent = z.object({
  member: z.object({
    id: z.string(),
    handle: z.string().nullable(),
    publicName: z.string(),
  }),
  requestScope,
  nextAfter: z.string().nullable(),
  latestCursor: z.string().nullable(),
});

// sseUpdateEvent is just a PendingUpdate — already defined in responses.ts
