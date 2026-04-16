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
import { profileLink } from './fields.ts';
import {
  entityKind, entityState, membershipState, membershipRole,
  eventRsvpState, updateReceiptState, messageRole,
} from './fields.ts';

// ── Small shared shapes ──────────────────────────────────

export const memberRef = z.object({
  memberId: z.string(),
  publicName: z.string(),
});

export const sharedClubRef = z.object({
  clubId: z.string(),
  slug: z.string(),
  name: z.string(),
});

export const mentionSpan = z.object({
  memberId: z.string(),
  authoredLabel: z.string(),
  start: z.number(),
  end: z.number(),
});

export const includedMember = z.object({
  memberId: z.string(),
  publicName: z.string(),
  displayName: z.string(),
});

export const includedBundle = z.object({
  membersById: z.record(z.string(), includedMember),
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
  joinedAt: z.string().nullable(),
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

export const inlineVouchSummary = z.object({
  edgeId: z.string(),
  voucher: memberRef,
  reason: z.string(),
  createdAt: z.string(),
});

export const clubJoinResult = z.object({
  memberToken: z.string().nullable(),
  clubId: z.string(),
  membershipId: z.string(),
  proof: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('pow'),
      challengeId: z.string(),
      difficulty: z.number(),
      expiresAt: z.string(),
      maxAttempts: z.number(),
    }),
    z.object({
      kind: z.literal('none'),
    }),
  ]),
  club: z.object({
    name: z.string(),
    summary: z.string().nullable(),
    ownerName: z.string(),
    admissionPolicy: z.string().nullable(),
    priceUsd: z.number().nullable().optional(),
  }),
});

export const applicationSummary = z.object({
  membershipId: z.string(),
  clubId: z.string(),
  clubSlug: z.string(),
  clubName: z.string(),
  state: membershipState,
  submissionPath: z.enum(['cold', 'invitation', 'cross_apply', 'owner_nominated']),
  appliedAt: z.string(),
  submittedAt: z.string().nullable(),
  decidedAt: z.string().nullable(),
  applicationName: z.string().nullable(),
  applicationEmail: z.string().nullable(),
  applicationSocials: z.string().nullable(),
  applicationText: z.string().nullable(),
  billing: z.object({
    required: z.boolean(),
    membershipState: membershipState,
    accessible: z.boolean(),
  }),
});

export const clubsApplicationsSubmitResult = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('submitted'),
    membershipId: z.string(),
    applicationSubmittedAt: z.string(),
  }),
  z.object({
    status: z.literal('needs_revision'),
    feedback: z.string(),
    attemptsRemaining: z.number(),
  }),
  z.object({
    status: z.literal('attempts_exhausted'),
    message: z.string(),
  }),
]);

export const onboardingWelcome = z.object({
  greeting: z.string(),
  preamble: z.string(),
  capabilities: z.array(z.string()),
  closing: z.string(),
});

export const clubsOnboardResult = z.union([
  z.object({
    alreadyOnboarded: z.literal(true),
  }),
  z.object({
    alreadyOnboarded: z.literal(false),
    orphaned: z.literal(true),
  }),
  z.object({
    alreadyOnboarded: z.literal(false),
    member: z.object({
      id: z.string(),
      displayName: z.string(),
    }),
    club: z.object({
      id: z.string(),
      slug: z.string(),
      name: z.string(),
      summary: z.string().nullable(),
    }),
    welcome: onboardingWelcome,
  }),
]);

export const invitationSummary = z.object({
  invitationId: z.string(),
  clubId: z.string(),
  candidateName: z.string(),
  candidateEmail: z.string(),
  sponsor: memberRef,
  reason: z.string(),
  status: z.enum(['open', 'used', 'revoked', 'expired']),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
});

export const publicMemberSummary = z.object({
  membershipId: z.string(),
  memberId: z.string(),
  publicName: z.string(),
  displayName: z.string(),
  tagline: z.string().nullable(),
  summary: z.string().nullable(),
  whatIDo: z.string().nullable(),
  knownFor: z.string().nullable(),
  servicesSummary: z.string().nullable(),
  websiteUrl: z.string().nullable(),
  links: z.array(profileLink),
  role: membershipRole,
  isOwner: z.boolean(),
  joinedAt: z.string(),
  sponsor: memberRef.nullable(),
  vouches: z.array(inlineVouchSummary),
});

export const memberSearchResult = z.object({
  memberId: z.string(),
  publicName: z.string(),
  displayName: z.string(),
  tagline: z.string().nullable(),
  summary: z.string().nullable(),
  whatIDo: z.string().nullable(),
  knownFor: z.string().nullable(),
  servicesSummary: z.string().nullable(),
  websiteUrl: z.string().nullable(),
  sharedClubs: z.array(sharedClubRef),
});

export const adminMemberSummary = publicMemberSummary.extend({
  isComped: z.boolean(),
  compedAt: z.string().nullable(),
  compedByMemberId: z.string().nullable(),
  approvedPriceAmount: z.number().nullable(),
  approvedPriceCurrency: z.string().nullable(),
  subscription: z.object({
    status: z.enum(['trialing', 'active', 'past_due', 'cancelled', 'ended']),
    currentPeriodEnd: z.string().nullable(),
    endedAt: z.string().nullable(),
  }).nullable(),
  acceptedCovenantAt: z.string().nullable(),
  leftAt: z.string().nullable(),
  state: z.object({
    status: membershipState,
    reason: z.string().nullable(),
    versionNo: z.number(),
    createdAt: z.string(),
    createdByMemberId: z.string().nullable(),
  }),
});

export const adminApplicationSummary = z.object({
  membershipId: z.string(),
  memberId: z.string(),
  publicName: z.string(),
  displayName: z.string().nullable(),
  state: z.object({
    status: z.enum(['applying', 'submitted', 'interview_scheduled', 'interview_completed', 'payment_pending']),
    reason: z.string().nullable(),
    versionNo: z.number(),
    createdAt: z.string(),
    createdByMemberId: z.string().nullable(),
  }),
  appliedAt: z.string().nullable(),
  submittedAt: z.string().nullable(),
  applicationName: z.string().nullable(),
  applicationEmail: z.string().nullable(),
  applicationSocials: z.string().nullable(),
  applicationText: z.string().nullable(),
  proofKind: z.enum(['pow', 'invitation', 'none']).nullable(),
  submissionPath: z.enum(['cold', 'invitation', 'cross_apply', 'owner_nominated']).nullable(),
  generatedProfileDraft: z.object({
    tagline: z.string().nullable(),
    summary: z.string().nullable(),
    whatIDo: z.string().nullable(),
    knownFor: z.string().nullable(),
    servicesSummary: z.string().nullable(),
    websiteUrl: z.string().nullable(),
    links: z.array(profileLink),
  }).nullable(),
  sponsor: memberRef.nullable(),
  invitation: z.object({
    id: z.string(),
    reason: z.string().nullable(),
  }).nullable(),
  sponsorStats: z.object({
    activeSponsoredCount: z.number(),
    sponsoredThisMonthCount: z.number(),
  }).nullable(),
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
  links: z.array(profileLink),
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
  displayName: z.string(),
});

export const memberProfileEnvelope = z.object({
  memberId: z.string(),
  publicName: z.string(),
  displayName: z.string(),
  profiles: z.array(clubProfile),
});

// ── Entities ─────────────────────────────────────────────

export const contentAuthorRef = z.object({
  memberId: z.string(),
  publicName: z.string(),
  displayName: z.string(),
});

export const eventRsvpAttendee = z.object({
  membershipId: z.string(),
  memberId: z.string(),
  publicName: z.string(),
  response: eventRsvpState,
  note: z.string().nullable(),
  createdAt: z.string(),
});

export const contentEntity = z.object({
  entityId: z.string(),
  contentThreadId: z.string(),
  clubId: z.string(),
  kind: entityKind,
  openLoop: z.boolean().nullable(),
  author: contentAuthorRef,
  version: z.object({
    versionNo: z.number(),
    state: entityState,
    title: z.string().nullable(),
    summary: z.string().nullable(),
    body: z.string().nullable(),
    effectiveAt: z.string(),
    expiresAt: z.string().nullable(),
    createdAt: z.string(),
    mentions: z.object({
      title: z.array(mentionSpan),
      summary: z.array(mentionSpan),
      body: z.array(mentionSpan),
    }),
  }).describe(
    'Body is always present on non-removed content. Title and summary may be null. For a short display label, prefer title, then summary, then a truncated excerpt of body.',
  ),
  event: z.object({
    location: z.string().nullable(),
    startsAt: z.string().nullable(),
    endsAt: z.string().nullable(),
    timezone: z.string().nullable(),
    recurrenceRule: z.string().nullable(),
    capacity: z.number().nullable(),
  }).nullable(),
  rsvps: z.object({
    viewerResponse: eventRsvpState.nullable(),
    counts: z.object({
      yes: z.number(),
      maybe: z.number(),
      no: z.number(),
      waitlist: z.number(),
    }),
    attendees: z.array(eventRsvpAttendee),
  }).nullable(),
  createdAt: z.string(),
});

export const contentEntitySearchResult = contentEntity.extend({
  score: z.number(),
});

export const contentThreadSummary = z.object({
  threadId: z.string(),
  clubId: z.string(),
  firstEntity: contentEntity,
  thread: z.object({
    entityCount: z.number(),
    lastActivityAt: z.string(),
  }),
});

export const contentThread = z.object({
  threadId: z.string(),
  clubId: z.string(),
  entities: z.array(contentEntity),
  entityCount: z.number(),
  lastActivityAt: z.string(),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});

export const entitySummary = contentEntity;
export const eventSummary = contentEntity;

// ── Messages ─────────────────────────────────────────────

export const directMessageSummary = z.object({
  threadId: z.string(),
  sharedClubs: z.array(sharedClubRef),
  senderMemberId: z.string(),
  recipientMemberId: z.string(),
  messageId: z.string(),
  messageText: z.string(),
  mentions: z.array(mentionSpan),
  createdAt: z.string(),
  updateCount: z.number(),
});

export const directMessageThreadSummary = z.object({
  threadId: z.string(),
  sharedClubs: z.array(sharedClubRef),
  counterpartMemberId: z.string(),
  counterpartPublicName: z.string(),
  latestMessage: z.object({
    messageId: z.string(),
    senderMemberId: z.string().nullable(),
    role: messageRole,
    messageText: z.string().nullable(),
    mentions: z.array(mentionSpan),
    createdAt: z.string(),
  }),
  messageCount: z.number(),
});

export const directMessageEntry = z.object({
  messageId: z.string(),
  threadId: z.string(),
  senderMemberId: z.string().nullable(),
  role: messageRole,
  messageText: z.string().nullable(),
  mentions: z.array(mentionSpan),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  inReplyToMessageId: z.string().nullable(),
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

// ── Activity / Notifications ─────────────────────────────

export const activityEvent = z.object({
  activityId: z.string(),
  seq: z.number(),
  clubId: z.string(),
  topic: z.string(),
  payload: z.record(z.string(), z.unknown()),
  entityId: z.string().nullable(),
  entityVersionId: z.string().nullable(),
  audience: z.enum(['members', 'clubadmins', 'owners']),
  createdAt: z.string(),
  createdByMemberId: z.string().nullable(),
});

export const notificationItem = z.object({
  notificationId: z.string(),
  cursor: z.string(),
  kind: z.string(),
  clubId: z.string().nullable(),
  ref: z.object({
    membershipId: z.string().optional(),
    matchId: z.string().optional(),
    entityId: z.string().optional(),
  }),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  acknowledgeable: z.boolean(),
  acknowledgedState: updateReceiptState.nullable(),
});

export const notificationReceipt = z.object({
  notificationId: z.string(),
  recipientMemberId: z.string(),
  entityId: z.string().nullable(),
  clubId: z.string().nullable(),
  state: updateReceiptState,
  suppressionReason: z.string().nullable(),
  versionNo: z.number(),
  createdAt: z.string(),
  createdByMemberId: z.string().nullable(),
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
  pendingApplications: z.number(),
  recentMembers: z.array(z.object({
    memberId: z.string(),
    publicName: z.string(),
      createdAt: z.string(),
  })),
});

export const superadminMemberSummary = z.object({
  memberId: z.string(),
  publicName: z.string(),
  state: z.string(),
  createdAt: z.string(),
  membershipCount: z.number(),
  tokenCount: z.number(),
});

export const superadminMemberDetail = z.object({
  memberId: z.string(),
  publicName: z.string(),
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
});

export const adminContentSummary = z.object({
  entityId: z.string(),
  contentThreadId: z.string(),
  clubId: z.string(),
  clubName: z.string(),
  kind: entityKind,
  author: memberRef,
  title: z.string().nullable(),
  titleMentions: z.array(mentionSpan),
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

const adminWorkerCursor = <T extends z.ZodTypeAny>(valueSchema: T) => z.object({
  value: valueSchema.nullable(),
  updatedAt: z.string().nullable(),
  ageSeconds: z.number().nullable(),
});

export const adminDiagnostics = z.object({
  migrationCount: z.number(),
  latestMigration: z.string().nullable(),
  memberCount: z.number(),
  clubCount: z.number(),
  tablesWithRls: z.number(),
  totalAppTables: z.number(),
  databaseSize: z.string(),
  workers: z.object({
    embedding: z.object({
      queue: z.object({
        claimable: z.number(),
        scheduledFuture: z.number(),
        atOrOverMaxAttempts: z.number(),
      }),
      oldestClaimableAgeSeconds: z.number().nullable(),
      byModel: z.array(z.object({
        model: z.string(),
        dimensions: z.number(),
        claimable: z.number(),
        scheduledFuture: z.number(),
        atOrOverMaxAttempts: z.number(),
      })),
      retryErrorSample: z.array(z.object({
        jobId: z.string(),
        subjectKind: z.enum(['member_club_profile_version', 'entity_version']),
        model: z.string(),
        attemptCount: z.number(),
        lastError: z.string(),
        nextAttemptAt: z.string(),
      })),
    }),
    synchronicity: z.object({
      cursors: z.object({
        activitySeq: adminWorkerCursor(z.number()),
        profileArtifactAt: adminWorkerCursor(z.string()),
        membershipScanAt: adminWorkerCursor(z.string()),
        backstopSweepAt: adminWorkerCursor(z.string()),
      }),
      entityPublicationBacklog: z.object({
        pendingCount: z.number().nullable(),
        oldestPendingAgeSeconds: z.number().nullable(),
      }),
      recomputeQueue: z.object({
        readyCount: z.number(),
        inFlightCount: z.number(),
        scheduledCount: z.number(),
      }),
      pendingMatchesCount: z.number(),
    }),
  }),
  collectedAt: z.string(),
});
