/**
 * Zod schemas for all API response types.
 *
 * These define the shape of data returned in the `data` field of success
 * responses. Used for:
 *   - wire.output schemas in action contracts (schema endpoint / docs)
 *   - test-time validation (parse every integration test response)
 *   - z.infer<> to derive TypeScript types
 *
 * Production handlers are NOT required to parse through these at runtime.
 * TypeScript compilation + test-time validation provides the safety net.
 */
import { z } from 'zod';
import {
  entityKind, entityState, membershipState, membershipRole,
  admissionStatus, admissionOrigin, eventRsvpState, updateReceiptState,
  messageRole, intakeKind,
} from './fields.ts';

// ── Small shared shapes ──────────────────────────────────

export const memberRef = z.object({
  memberId: z.string(),
  publicName: z.string(),
  handle: z.string().nullable(),
});

export const sharedClubRef = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
});

export const embeddingProjectionSummary = z.object({
  embeddingId: z.string(),
  model: z.string(),
  dimensions: z.number(),
  sourceText: z.string(),
  metadata: z.record(z.unknown()),
  createdAt: z.string(),
});

// ── Membership ───────────────────────────────────────────

export const membershipSummary = z.object({
  membershipId: z.string(),
  clubId: z.string(),
  slug: z.string(),
  name: z.string(),
  summary: z.string().nullable(),
  role: membershipRole,
  status: z.literal('active'),
  sponsorMemberId: z.string().nullable(),
  joinedAt: z.string(),
});

export const membershipAdminSummary = z.object({
  membershipId: z.string(),
  clubId: z.string(),
  member: memberRef,
  sponsor: memberRef.nullable(),
  role: membershipRole,
  state: z.object({
    status: membershipState,
    reason: z.string().nullable(),
    versionNo: z.number(),
    createdAt: z.string(),
    createdByMemberId: z.string().nullable(),
  }),
  joinedAt: z.string(),
  acceptedCovenantAt: z.string().nullable(),
  metadata: z.record(z.unknown()),
});

export const vouchSummary = z.object({
  edgeId: z.string(),
  fromMember: memberRef,
  reason: z.string(),
  metadata: z.record(z.unknown()),
  createdAt: z.string(),
  createdByMemberId: z.string().nullable(),
});

export const membershipReviewSummary = membershipAdminSummary.extend({
  sponsorStats: z.object({
    activeSponsoredCount: z.number(),
    sponsoredThisMonthCount: z.number(),
  }),
  vouches: z.array(vouchSummary),
});

// ── Admissions ───────────────────────────────────────────

export const admissionSummary = z.object({
  admissionId: z.string(),
  clubId: z.string(),
  applicant: z.object({
    memberId: z.string().nullable(),
    publicName: z.string(),
    handle: z.string().nullable(),
    email: z.string().nullable(),
  }),
  sponsor: memberRef.nullable(),
  membershipId: z.string().nullable(),
  origin: admissionOrigin,
  intake: z.object({
    kind: intakeKind,
    price: z.object({
      amount: z.number().nullable(),
      currency: z.string().nullable(),
    }),
    bookingUrl: z.string().nullable(),
    bookedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
  }),
  state: z.object({
    status: admissionStatus,
    notes: z.string().nullable(),
    versionNo: z.number(),
    createdAt: z.string(),
    createdByMemberId: z.string().nullable(),
  }),
  admissionDetails: z.record(z.unknown()),
  metadata: z.record(z.unknown()),
  createdAt: z.string(),
});

export const admissionChallengeResult = z.object({
  challengeId: z.string(),
  difficulty: z.number(),
  expiresAt: z.string(),
  clubs: z.array(z.object({
    slug: z.string(),
    name: z.string(),
    summary: z.string().nullable(),
    ownerName: z.string(),
    ownerEmail: z.string().nullable(),
  })),
});

// ── Members ──────────────────────────────────────────────

export const memberSearchResult = z.object({
  memberId: z.string(),
  publicName: z.string(),
  displayName: z.string(),
  handle: z.string().nullable(),
  tagline: z.string().nullable(),
  summary: z.string().nullable(),
  whatIDo: z.string().nullable(),
  knownFor: z.string().nullable(),
  servicesSummary: z.string().nullable(),
  websiteUrl: z.string().nullable(),
  sharedClubs: z.array(sharedClubRef),
});

export const clubMemberSummary = z.object({
  memberId: z.string(),
  publicName: z.string(),
  displayName: z.string(),
  handle: z.string().nullable(),
  tagline: z.string().nullable(),
  summary: z.string().nullable(),
  whatIDo: z.string().nullable(),
  knownFor: z.string().nullable(),
  servicesSummary: z.string().nullable(),
  websiteUrl: z.string().nullable(),
  memberships: z.array(membershipSummary),
});

// ── Profile ──────────────────────────────────────────────

export const memberProfile = z.object({
  memberId: z.string(),
  publicName: z.string(),
  handle: z.string().nullable(),
  displayName: z.string(),
  tagline: z.string().nullable(),
  summary: z.string().nullable(),
  whatIDo: z.string().nullable(),
  knownFor: z.string().nullable(),
  servicesSummary: z.string().nullable(),
  websiteUrl: z.string().nullable(),
  links: z.array(z.unknown()),
  profile: z.record(z.unknown()),
  version: z.object({
    id: z.string().nullable(),
    versionNo: z.number().nullable(),
    createdAt: z.string().nullable(),
    createdByMemberId: z.string().nullable(),
    embedding: embeddingProjectionSummary.nullable(),
  }),
  sharedClubs: z.array(sharedClubRef),
});

// ── Entities ─────────────────────────────────────────────

export const entitySummary = z.object({
  entityId: z.string(),
  entityVersionId: z.string(),
  clubId: z.string(),
  kind: entityKind,
  author: memberRef,
  version: z.object({
    versionNo: z.number(),
    state: entityState,
    title: z.string().nullable(),
    summary: z.string().nullable(),
    body: z.string().nullable(),
    effectiveAt: z.string(),
    expiresAt: z.string().nullable(),
    createdAt: z.string(),
    content: z.record(z.unknown()),
    embedding: embeddingProjectionSummary.nullable(),
  }),
  createdAt: z.string(),
});

// ── Events ───────────────────────────────────────────────

export const eventRsvpAttendee = z.object({
  membershipId: z.string(),
  memberId: z.string(),
  publicName: z.string(),
  handle: z.string().nullable(),
  response: eventRsvpState,
  note: z.string().nullable(),
  createdAt: z.string(),
});

export const eventSummary = z.object({
  entityId: z.string(),
  entityVersionId: z.string(),
  clubId: z.string(),
  author: memberRef,
  version: z.object({
    versionNo: z.number(),
    state: z.literal('published'),
    title: z.string().nullable(),
    summary: z.string().nullable(),
    body: z.string().nullable(),
    startsAt: z.string().nullable(),
    endsAt: z.string().nullable(),
    timezone: z.string().nullable(),
    recurrenceRule: z.string().nullable(),
    capacity: z.number().nullable(),
    effectiveAt: z.string(),
    expiresAt: z.string().nullable(),
    createdAt: z.string(),
    content: z.record(z.unknown()),
  }),
  rsvps: z.object({
    viewerResponse: eventRsvpState.nullable(),
    counts: z.record(eventRsvpState, z.number()),
    attendees: z.array(eventRsvpAttendee),
  }),
  createdAt: z.string(),
});

// ── Messages ─────────────────────────────────────────────

export const directMessageSummary = z.object({
  threadId: z.string(),
  clubId: z.string(),
  senderMemberId: z.string(),
  recipientMemberId: z.string(),
  messageId: z.string(),
  messageText: z.string(),
  createdAt: z.string(),
  updateCount: z.number(),
});

export const directMessageThreadSummary = z.object({
  threadId: z.string(),
  clubId: z.string(),
  counterpartMemberId: z.string(),
  counterpartPublicName: z.string(),
  counterpartHandle: z.string().nullable(),
  latestMessage: z.object({
    messageId: z.string(),
    senderMemberId: z.string(),
    role: messageRole,
    messageText: z.string().nullable(),
    createdAt: z.string(),
  }),
  messageCount: z.number(),
});

export const directMessageUpdateReceipt = z.object({
  updateId: z.string(),
  recipientMemberId: z.string(),
  topic: z.string(),
  createdAt: z.string(),
  receipt: z.object({
    receiptId: z.string(),
    state: updateReceiptState,
    suppressionReason: z.string().nullable(),
    versionNo: z.number(),
    createdAt: z.string(),
    createdByMemberId: z.string().nullable(),
  }).nullable(),
});

export const directMessageEntry = z.object({
  messageId: z.string(),
  threadId: z.string(),
  senderMemberId: z.string().nullable(),
  role: messageRole,
  messageText: z.string().nullable(),
  payload: z.record(z.unknown()),
  createdAt: z.string(),
  inReplyToMessageId: z.string().nullable(),
  updateReceipts: z.array(directMessageUpdateReceipt),
});

export const directMessageInboxSummary = directMessageThreadSummary.extend({
  unread: z.object({
    hasUnread: z.boolean(),
    unreadMessageCount: z.number(),
    unreadUpdateCount: z.number(),
    latestUnreadMessageCreatedAt: z.string().nullable(),
  }),
});

// ── Tokens ───────────────────────────────────────────────

export const bearerTokenSummary = z.object({
  tokenId: z.string(),
  memberId: z.string(),
  label: z.string().nullable(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  metadata: z.record(z.unknown()),
});

export const createdBearerToken = z.object({
  token: bearerTokenSummary,
  bearerToken: z.string(),
});

// ── Quotas ───────────────────────────────────────────────

export const quotaAllowance = z.object({
  action: z.string(),
  clubId: z.string(),
  maxPerDay: z.number(),
  usedToday: z.number(),
  remaining: z.number(),
});

// ── Updates ──────────────────────────────────────────────

export const pendingUpdate = z.object({
  updateId: z.string(),
  streamSeq: z.number(),
  recipientMemberId: z.string(),
  clubId: z.string(),
  entityId: z.string().nullable(),
  entityVersionId: z.string().nullable(),
  dmMessageId: z.string().nullable(),
  topic: z.string(),
  payload: z.record(z.unknown()),
  createdAt: z.string(),
  createdByMemberId: z.string().nullable(),
});

export const updateReceipt = z.object({
  receiptId: z.string(),
  updateId: z.string(),
  recipientMemberId: z.string(),
  clubId: z.string(),
  state: updateReceiptState,
  suppressionReason: z.string().nullable(),
  versionNo: z.number(),
  supersedesReceiptId: z.string().nullable(),
  createdAt: z.string(),
  createdByMemberId: z.string().nullable(),
});

export const memberUpdates = z.object({
  items: z.array(pendingUpdate),
  nextAfter: z.number().nullable(),
  polledAt: z.string(),
});

// ── Clubs ────────────────────────────────────────────────

export const clubSummary = z.object({
  clubId: z.string(),
  slug: z.string(),
  name: z.string(),
  summary: z.string().nullable(),
  archivedAt: z.string().nullable(),
  owner: z.object({
    memberId: z.string(),
    publicName: z.string(),
    handle: z.string().nullable(),
    email: z.string().nullable(),
  }),
  ownerVersion: z.object({
    versionNo: z.number(),
    createdAt: z.string(),
    createdByMemberId: z.string().nullable(),
  }),
});

// ── Redactions ───────────────────────────────────────────

export const redactionResult = z.object({
  redactionId: z.string(),
  targetKind: z.enum(['dm_message', 'entity']),
  targetId: z.string(),
  clubId: z.string(),
  createdByMemberId: z.string(),
  createdAt: z.string(),
});

// ── Admin ────────────────────────────────────────────────

export const adminOverview = z.object({
  totalMembers: z.number(),
  totalClubs: z.number(),
  totalEntities: z.number(),
  totalMessages: z.number(),
  totalAdmissions: z.number(),
  recentMembers: z.array(z.object({
    memberId: z.string(),
    publicName: z.string(),
    handle: z.string().nullable(),
    createdAt: z.string(),
  })),
});

export const adminMemberSummary = z.object({
  memberId: z.string(),
  publicName: z.string(),
  handle: z.string().nullable(),
  state: z.string(),
  createdAt: z.string(),
  membershipCount: z.number(),
  tokenCount: z.number(),
});

export const adminMemberDetail = z.object({
  memberId: z.string(),
  publicName: z.string(),
  handle: z.string().nullable(),
  state: z.string(),
  createdAt: z.string(),
  memberships: z.array(z.object({
    membershipId: z.string(),
    clubId: z.string(),
    clubName: z.string(),
    clubSlug: z.string(),
    role: z.string(),
    status: z.string(),
    joinedAt: z.string(),
  })),
  tokenCount: z.number(),
  profile: memberProfile.nullable(),
});

export const adminClubStats = z.object({
  clubId: z.string(),
  slug: z.string(),
  name: z.string(),
  archivedAt: z.string().nullable(),
  memberCounts: z.record(z.number()),
  entityCount: z.number(),
  messageCount: z.number(),
  admissionCounts: z.record(z.number()),
});

export const adminContentSummary = z.object({
  entityId: z.string(),
  clubId: z.string(),
  clubName: z.string(),
  kind: entityKind,
  author: memberRef,
  title: z.string().nullable(),
  state: entityState,
  createdAt: z.string(),
});

export const adminThreadSummary = z.object({
  threadId: z.string(),
  clubId: z.string(),
  clubName: z.string(),
  participants: z.array(memberRef),
  messageCount: z.number(),
  latestMessageAt: z.string(),
});

export const adminDiagnostics = z.object({
  migrationCount: z.number(),
  latestMigration: z.string().nullable(),
  memberCount: z.number(),
  clubCount: z.number(),
  tablesWithRls: z.number(),
  totalAppTables: z.number(),
  databaseSize: z.string(),
});
