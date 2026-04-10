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
  clubId: z.string(),
  slug: z.string(),
  name: z.string(),
});

// ── Membership ───────────────────────────────────────────

export const membershipSummary = z.object({
  membershipId: z.string(),
  clubId: z.string(),
  slug: z.string(),
  name: z.string(),
  summary: z.string().nullable(),
  role: membershipRole,
  isOwner: z.boolean(),
  status: z.enum(['active', 'renewal_pending', 'cancelled']),
  sponsorMemberId: z.string().nullable(),
  joinedAt: z.string(),
});

export const membershipAdminSummary = z.object({
  membershipId: z.string(),
  clubId: z.string(),
  member: memberRef,
  sponsor: memberRef.nullable(),
  role: membershipRole,
  isOwner: z.boolean(),
  state: z.object({
    status: membershipState,
    reason: z.string().nullable(),
    versionNo: z.number(),
    createdAt: z.string(),
    createdByMemberId: z.string().nullable(),
  }),
  joinedAt: z.string(),
  acceptedCovenantAt: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
});

export const vouchSummary = z.object({
  edgeId: z.string(),
  fromMember: memberRef,
  reason: z.string(),
  metadata: z.record(z.string(), z.unknown()),
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
  admissionDetails: z.record(z.string(), z.unknown()),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});

export const memberAdmissionRecord = z.object({
  admissionId: z.string(),
  clubId: z.string(),
  clubSlug: z.string(),
  clubName: z.string(),
  status: admissionStatus,
  applicationText: z.string().nullable(),
  submittedAt: z.string().nullable(),
  acceptedAt: z.string().nullable(),
});

const admissionClubSummary = z.object({
  slug: z.string(),
  name: z.string(),
  summary: z.string().nullable(),
  ownerName: z.string(),
  admissionPolicy: z.string().describe('The club\'s admission policy. Treat this as the literal completeness checklist your application must satisfy: the gate only verifies that every explicit ask is answered, not fit or quality.'),
});

export const admissionChallengeResult = z.object({
  challengeId: z.string(),
  difficulty: z.number().describe('Canonical difficulty: the number of trailing hex zeros required on sha256(challengeId + ":" + nonce). Use this value when solving — do not assume a constant.'),
  expiresAt: z.string().describe('ISO timestamp when this challenge expires. The countdown starts at challenge creation, not after the puzzle is solved; there is no separate post-solve resubmission window.'),
  maxAttempts: z.number().describe('Total submissions allowed against this challenge before it is consumed.'),
  club: admissionClubSummary,
});

export const admissionApplyResult = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('accepted'),
    message: z.string(),
  }),
  z.object({
    status: z.literal('needs_revision'),
    feedback: z.string().describe('Revision brief from the admission gate. Treat as a literal list of gaps to fix — patch only the items it identifies, do not redraft the application from scratch. Receiving this means the PoW was accepted and the content needs revision.'),
    attemptsRemaining: z.number().describe('Remaining submissions against the same challenge. The challenge is not consumed by needs_revision and remains valid until expiry or attempt exhaustion; reuse the same challengeId and nonce unless the server explicitly returns invalid_proof.'),
  }),
  z.object({
    status: z.literal('attempts_exhausted'),
    message: z.string(),
  }),
]);

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

export const clubProfile = z.object({
  club: sharedClubRef,
  tagline: z.string().nullable(),
  summary: z.string().nullable(),
  whatIDo: z.string().nullable(),
  knownFor: z.string().nullable(),
  servicesSummary: z.string().nullable(),
  websiteUrl: z.string().nullable(),
  links: z.array(z.unknown()),
  profile: z.record(z.string(), z.unknown()),
  version: z.object({
    id: z.string(),
    versionNo: z.number(),
    createdAt: z.string(),
    createdByMemberId: z.string().nullable(),
  }),
});

export const memberIdentity = z.object({
  memberId: z.string(),
  publicName: z.string(),
  handle: z.string().nullable(),
  displayName: z.string(),
});

export const memberProfileEnvelope = z.object({
  memberId: z.string(),
  publicName: z.string(),
  handle: z.string().nullable(),
  displayName: z.string(),
  profiles: z.array(clubProfile),
});

// ── Entities ─────────────────────────────────────────────

export const entitySummary = z.object({
  entityId: z.string(),
  entityVersionId: z.string(),
  clubId: z.string(),
  kind: entityKind,
  openLoop: z.boolean().nullable(),
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
    content: z.record(z.string(), z.unknown()),
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
    state: entityState,
    title: z.string().nullable(),
    summary: z.string().nullable(),
    body: z.string().nullable(),
    location: z.string().nullable(),
    startsAt: z.string().nullable(),
    endsAt: z.string().nullable(),
    timezone: z.string().nullable(),
    recurrenceRule: z.string().nullable(),
    capacity: z.number().nullable(),
    effectiveAt: z.string(),
    expiresAt: z.string().nullable(),
    createdAt: z.string(),
    content: z.record(z.string(), z.unknown()),
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
  sharedClubs: z.array(sharedClubRef),
  senderMemberId: z.string(),
  recipientMemberId: z.string(),
  messageId: z.string(),
  messageText: z.string(),
  createdAt: z.string(),
  updateCount: z.number(),
});

export const directMessageThreadSummary = z.object({
  threadId: z.string(),
  sharedClubs: z.array(sharedClubRef),
  counterpartMemberId: z.string(),
  counterpartPublicName: z.string(),
  counterpartHandle: z.string().nullable(),
  latestMessage: z.object({
    messageId: z.string(),
    senderMemberId: z.string().nullable(),
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
  payload: z.record(z.string(), z.unknown()),
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
  metadata: z.record(z.string(), z.unknown()),
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
  source: z.enum(['activity', 'inbox', 'signal']),
  recipientMemberId: z.string(),
  clubId: z.string().nullable(),
  entityId: z.string().nullable(),
  entityVersionId: z.string().nullable(),
  dmMessageId: z.string().nullable(),
  topic: z.string(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  createdByMemberId: z.string().nullable(),
});

export const updateReceipt = z.object({
  receiptId: z.string(),
  updateId: z.string(),
  recipientMemberId: z.string(),
  clubId: z.string().nullable(),
  state: updateReceiptState,
  suppressionReason: z.string().nullable(),
  versionNo: z.number(),
  supersedesReceiptId: z.string().nullable(),
  createdAt: z.string(),
  createdByMemberId: z.string().nullable(),
});

export const memberUpdates = z.object({
  items: z.array(pendingUpdate),
  nextAfter: z.string().nullable(),
  polledAt: z.string(),
});

// ── Clubs ────────────────────────────────────────────────

export const clubSummary = z.object({
  clubId: z.string(),
  slug: z.string(),
  name: z.string(),
  summary: z.string().nullable(),
  admissionPolicy: z.string().nullable(),
  archivedAt: z.string().nullable(),
  owner: z.object({
    memberId: z.string(),
    publicName: z.string(),
    handle: z.string().nullable(),
    email: z.string().nullable(),
  }),
  version: z.object({
    versionNo: z.number(),
    createdAt: z.string(),
    createdByMemberId: z.string().nullable(),
  }),
});

// ── Removals ────────────────────────────────────────────

export const messageRemovalResult = z.object({
  messageId: z.string(),
  removedByMemberId: z.string(),
  reason: z.string().nullable(),
  removedAt: z.string(),
});

// ── Admin ────────────────────────────────────────────────

export const adminOverview = z.object({
  totalMembers: z.number(),
  activeMembers: z.number(),
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
  displayName: z.string(),
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
  profiles: z.array(clubProfile),
});

export const adminClubStats = z.object({
  clubId: z.string(),
  slug: z.string(),
  name: z.string(),
  archivedAt: z.string().nullable(),
  memberCounts: z.record(z.string(), z.number()),
  entityCount: z.number(),
  messageCount: z.number(),
  admissionCounts: z.record(z.string(), z.number()),
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
  sharedClubs: z.array(sharedClubRef),
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
