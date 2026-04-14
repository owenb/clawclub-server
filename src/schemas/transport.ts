/**
 * Transport-level envelope schemas.
 *
 * These define the HTTP response shapes that wrap action-specific data.
 * Two success envelopes:
 *   - Authenticated: includes actor context (member, roles, memberships, scope)
 *   - Unauthenticated: bare action + data (anonymous clubs.join only)
 *
 * Plus the error envelope and SSE response shapes.
 */
import { z } from 'zod';
import {
  membershipSummary,
  notificationItem,
  activityEvent,
  directMessageThreadSummary,
  directMessageEntry,
  includedBundle,
} from './responses.ts';

// ── Actor envelope ───────────────────────────────────────

export const requestScope = z.object({
  requestedClubId: z.string().nullable(),
  activeClubIds: z.array(z.string()),
});

export const sharedContext = z.object({
  notifications: z.array(notificationItem),
  notificationsTruncated: z.boolean(),
});

export const actorEnvelope = z.object({
  member: z.object({
    id: z.string(),
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

// ── SSE events (GET /stream) ─────────────────────────────

export const sseReadyEvent = z.object({
  member: z.object({
    id: z.string(),
    publicName: z.string(),
  }),
  requestScope,
  notifications: z.array(notificationItem),
  notificationsTruncated: z.boolean(),
  activityCursor: z.string().nullable(),
});

export const sseActivityEvent = activityEvent;

export const sseMessageEvent = z.object({
  thread: directMessageThreadSummary,
  messages: z.array(directMessageEntry),
  included: includedBundle,
});

export const sseNotificationsDirtyEvent = z.object({});
