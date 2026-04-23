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
  profileLink,
  timestampString,
  paginatedOutput,
  contentKind, contentState, membershipState, membershipRole,
  eventRsvpState, messageRole,
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

const versionBase = z.object({
  no: z.number(),
  status: z.string(),
  reason: z.string().nullable(),
  createdAt: timestampString,
  createdByMember: memberRef.nullable(),
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
  status: z.literal('active'),
  sponsor: memberRef.nullable(),
  joinedAt: timestampString,
});

export const membershipAdminSummary = z.object({
  membershipId: z.string(),
  clubId: z.string(),
  member: memberRef,
  sponsor: memberRef.nullable(),
  role: membershipRole,
  isOwner: z.boolean(),
  version: versionBase.extend({
    status: membershipState,
  }),
  joinedAt: timestampString.nullable(),
  acceptedCovenantAt: timestampString.nullable(),
  metadata: z.record(z.string(), z.unknown()),
});

export const vouchSummary = z.object({
  edgeId: z.string(),
  fromMember: memberRef,
  reason: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: timestampString,
  createdByMember: memberRef.nullable(),
});

export const inlineVouchSummary = z.object({
  edgeId: z.string(),
  voucher: memberRef,
  reason: z.string(),
  createdAt: timestampString,
});

export const invitationSummary = z.object({
  invitationId: z.string(),
  clubId: z.string(),
  candidateName: z.string(),
  candidateEmail: z.string(),
  candidateMemberId: z.string().nullable().describe('Resolved member id when the sponsor explicitly targeted an existing member by candidateMemberId. Null for email-addressed invitations, even when the server routed the invite internally.'),
  deliveryKind: z.enum(['notification', 'code']).describe('How the server delivered this invitation: in-app notification for an existing registered member, or a redeemable code for an external email target.'),
  code: z.string().nullable().describe('Sponsor-visible invitation code (XXXX-XXXX). Null when a clubadmin views another sponsor’s invitation.'),
  sponsor: memberRef,
  reason: z.string(),
  status: z.enum(['open', 'used', 'revoked', 'expired']),
  quotaState: z.enum(['counted', 'free']),
  expiresAt: timestampString.nullable(),
  createdAt: timestampString,
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
  joinedAt: timestampString,
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
  acceptedCovenantAt: timestampString.nullable(),
  leftAt: timestampString.nullable(),
  version: versionBase.extend({
    status: membershipState,
  }),
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
    no: z.number(),
    createdAt: timestampString,
    createdByMember: memberRef.nullable(),
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

// ── Content ─────────────────────────────────────────────

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
  createdAt: timestampString,
});

export const content = z.object({
  id: z.string(),
  threadId: z.string(),
  clubId: z.string(),
  kind: contentKind,
  openLoop: z.boolean().nullable(),
  author: contentAuthorRef,
  version: z.object({
    no: z.number(),
    status: contentState,
    reason: z.string().nullable(),
    title: z.string().nullable(),
    summary: z.string().nullable(),
    body: z.string().nullable(),
    effectiveAt: timestampString,
    expiresAt: timestampString.nullable(),
    createdAt: timestampString,
    createdByMember: memberRef.nullable(),
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
    startsAt: timestampString.nullable(),
    endsAt: timestampString.nullable(),
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
  createdAt: timestampString,
});

export const contentSearchResult = content.extend({
  score: z.number(),
});

export const contentThread = z.object({
  id: z.string(),
  clubId: z.string(),
  firstContent: content,
  contentCount: z.number(),
  latestActivityAt: timestampString,
});

// ── Messages ─────────────────────────────────────────────

export const directMessageSummary = z.object({
  threadId: z.string(),
  sharedClubs: z.array(sharedClubRef),
  senderMemberId: z.string(),
  recipientMemberId: z.string(),
  messageId: z.string(),
  messageText: z.string(),
  mentions: z.array(mentionSpan),
  createdAt: timestampString,
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
    createdAt: timestampString,
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
  createdAt: timestampString,
  inReplyToMessageId: z.string().nullable(),
});

export const directMessageInboxSummary = directMessageThreadSummary.extend({
  unread: z.object({
    hasUnread: z.boolean(),
    unreadMessageCount: z.number(),
    unreadUpdateCount: z.number(),
    latestUnreadMessageCreatedAt: timestampString.nullable(),
  }),
});

// ── Tokens ───────────────────────────────────────────────

export const bearerTokenSummary = z.object({
  tokenId: z.string(),
  memberId: z.string(),
  label: z.string().nullable(),
  createdAt: timestampString,
  lastUsedAt: timestampString.nullable(),
  revokedAt: timestampString.nullable(),
  expiresAt: timestampString.nullable(),
  metadata: z.record(z.string(), z.unknown()),
});

export const createdBearerToken = z.object({
  token: bearerTokenSummary,
  bearerToken: z.string(),
});

export const notificationProducerStatus = z.enum(['active', 'disabled']);
export const notificationTopicStatus = z.enum(['active', 'disabled']);
export const notificationDeliveryClass = z.enum(['transactional', 'informational', 'suggestion']);

export const notificationProducerTopicSummary = z.object({
  producerId: z.string(),
  topic: z.string(),
  deliveryClass: notificationDeliveryClass,
  status: notificationTopicStatus,
  createdAt: timestampString,
});

export const notificationProducerSummary = z.object({
  producerId: z.string(),
  namespacePrefix: z.string(),
  burstLimit: z.number().int().nullable(),
  hourlyLimit: z.number().int().nullable(),
  dailyLimit: z.number().int().nullable(),
  status: notificationProducerStatus,
  createdAt: timestampString,
  rotatedAt: timestampString.nullable(),
});

export const createdNotificationProducer = z.object({
  producer: notificationProducerSummary,
  topics: z.array(notificationProducerTopicSummary),
  secret: z.string(),
});

export const rotatedNotificationProducerSecret = z.object({
  producer: notificationProducerSummary,
  secret: z.string(),
});

// ── Quotas ───────────────────────────────────────────────

export const quotaAllowance = z.object({
  action: z.string(),
  metric: z.enum(['requests', 'output_tokens']),
  scope: z.enum(['per_club_member', 'per_member_global']),
  clubId: z.string().nullable(),
  windows: z.array(z.object({
    window: z.enum(['day', 'week', 'month']),
    max: z.number(),
    used: z.number(),
    remaining: z.number(),
  })),
});

// ── Activity / Notifications ─────────────────────────────

export const activityEvent = z.object({
  activityId: z.string(),
  seq: z.number().describe('Opaque resume cursor for the club activity stream. Gaps are expected because audience filtering happens after the global sequence is assigned.'),
  clubId: z.string(),
  topic: z.string(),
  payload: z.record(z.string(), z.unknown()),
  contentId: z.string().nullable(),
  contentVersionId: z.string().nullable(),
  audience: z.enum(['members', 'clubadmins', 'owners']),
  createdAt: timestampString,
  createdByMember: memberRef.nullable(),
});

export const notificationRef = z.object({
  role: z.string(),
  kind: z.enum(['member', 'club', 'content', 'dm_thread', 'membership', 'application', 'invitation', 'subscription', 'support_request']),
  id: z.string(),
});

export const notificationItem = z.object({
  notificationId: z.string(),
  seq: z.number().describe('Opaque resume cursor for the member notification stream. Gaps are expected because the global sequence is assigned before any recipient-specific filtering.'),
  cursor: z.string(),
  producerId: z.string(),
  topic: z.string(),
  clubId: z.string().nullable(),
  payloadVersion: z.number(),
  payload: z.record(z.string(), z.unknown()),
  refs: z.array(notificationRef),
  createdAt: timestampString,
  expiresAt: timestampString.nullable(),
});

export const notificationReceipt = z.object({
  notificationId: z.string(),
  acknowledgedAt: timestampString,
});

// ── Clubs ────────────────────────────────────────────────

export const clubSummary = z.object({
  clubId: z.string(),
  slug: z.string(),
  name: z.string(),
  summary: z.string().nullable(),
  admissionPolicy: z.string().nullable(),
  usesFreeAllowance: z.boolean(),
  memberCap: z.number().nullable(),
  archivedAt: timestampString.nullable(),
  owner: z.object({
    memberId: z.string(),
    publicName: z.string(),
      email: z.string().nullable(),
  }),
  version: versionBase.extend({
    status: z.enum(['active', 'archived']),
  }),
});

// ── Removals ────────────────────────────────────────────

export const messageRemovalResult = z.object({
  messageId: z.string(),
  removedByMemberId: z.string(),
  reason: z.string().nullable(),
  removedAt: timestampString,
});

export const removedClubSummary = z.object({
  archiveId: z.string(),
  clubId: z.string(),
  clubSlug: z.string(),
  removedAt: timestampString,
  retainedUntil: timestampString,
  isExpired: z.boolean(),
  removedByMember: memberRef.nullable(),
  reason: z.string(),
});

export const removedMemberSummary = z.object({
  memberId: z.string(),
  publicName: z.string(),
  removedAt: timestampString,
  removedByMember: memberRef,
  reason: z.string(),
  deleted: z.object({
    applications: z.number(),
    memberships: z.number(),
    accessTokens: z.number(),
    contents: z.number(),
    directMessageThreads: z.number(),
    directMessages: z.number(),
    notifications: z.number(),
    clubEdges: z.number(),
    globalRoleVersions: z.number(),
    quotaEventLogEntries: z.number(),
  }),
  detached: z.object({
    membershipSponsors: z.number(),
    membershipStateVersions: z.number(),
    clubActivities: z.number(),
    clubVersions: z.number(),
    contentVersions: z.number(),
    profileVersions: z.number(),
    contentThreads: z.number(),
    llmOutputReservations: z.number(),
    spendReservations: z.number(),
    llmUsageLogEntries: z.number(),
    roleVersionCreators: z.number(),
    eventRsvps: z.number(),
    sponsoredInvitations: z.number(),
  }),
});

// ── Admin ────────────────────────────────────────────────

export const adminOverview = z.object({
  totalMembers: z.number(),
  activeMembers: z.number(),
  totalClubs: z.number(),
  totalContent: z.number(),
  totalMessages: z.number(),
  pendingApplications: z.number(),
  recentMembers: z.array(z.object({
    memberId: z.string(),
    publicName: z.string(),
      createdAt: timestampString,
  })),
});

export const superadminMemberSummary = z.object({
  memberId: z.string(),
  publicName: z.string(),
  state: z.string(),
  createdAt: timestampString,
  membershipCount: z.number(),
  tokenCount: z.number(),
});

export const superadminMemberDetail = z.object({
  memberId: z.string(),
  publicName: z.string(),
  displayName: z.string(),
  state: z.string(),
  createdAt: timestampString,
  memberships: z.array(z.object({
    membershipId: z.string(),
    clubId: z.string(),
    clubName: z.string(),
    clubSlug: z.string(),
    role: z.string(),
    status: z.string(),
    joinedAt: timestampString,
  })),
  tokenCount: z.number(),
  profiles: z.array(clubProfile),
});

export const adminClubStats = z.object({
  clubId: z.string(),
  slug: z.string(),
  name: z.string(),
  archivedAt: timestampString.nullable(),
  memberCounts: z.record(z.string(), z.number()),
  contentCount: z.number(),
  messageCount: z.number(),
});

export const clubSpendWindow = z.object({
  window: z.enum(['day', 'week', 'month']),
  usedMicroCents: z.number(),
  remainingMicroCents: z.number(),
});

export const clubLlmOutputUsageWindow = z.object({
  window: z.enum(['day', 'week', 'month']),
  usedTokens: z.number(),
});

export const superadminClubDetail = z.object({
  club: clubSummary,
  memberCounts: z.record(z.string(), z.number()),
  contentCount: z.number(),
  messageCount: z.number(),
  aiSpend: z.object({
    budget: z.object({
      dailyMaxCents: z.number(),
      weeklyMaxCents: z.number(),
      monthlyMaxCents: z.number(),
    }),
    usage: z.array(clubSpendWindow),
  }),
  llmOutputTokens: z.object({
    scope: z.literal('per_club_member'),
    perMemberBudget: z.object({
      dailyMax: z.number(),
      weeklyMax: z.number(),
      monthlyMax: z.number(),
    }),
    usage: z.array(clubLlmOutputUsageWindow),
  }),
});

export const adminContentSummary = z.object({
  id: z.string(),
  threadId: z.string(),
  clubId: z.string(),
  clubName: z.string(),
  kind: contentKind,
  author: memberRef,
  version: z.object({
    no: z.number(),
    status: contentState,
    reason: z.string().nullable(),
    title: z.string().nullable(),
    titleMentions: z.array(mentionSpan),
    createdAt: timestampString,
    createdByMember: memberRef.nullable(),
  }),
});

export const adminThreadSummary = z.object({
  threadId: z.string(),
  sharedClubs: z.array(sharedClubRef),
  participants: z.array(memberRef),
  messageCount: z.number(),
  latestActivityAt: timestampString,
});

export const adminDiagnostics = z.object({
  migrationCount: z.number(),
  latestMigration: z.string().nullable(),
  memberCount: z.number(),
  clubCount: z.number(),
  totalAppTables: z.number(),
  databaseSize: z.string(),
  workers: z.object({
    embedding: z.object({
      queue: z.object({
        claimable: z.number(),
        scheduledFuture: z.number(),
        atOrOverMaxAttempts: z.number(),
      }),
      failedEmbeddingJobs: z.number(),
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
        subjectKind: z.enum(['member_club_profile_version', 'content_version']),
        model: z.string(),
        attemptCount: z.number(),
        lastError: z.string(),
        nextAttemptAt: timestampString,
      })),
    }),
  }),
  collectedAt: timestampString,
});

export function withIncluded<T extends z.ZodRawShape>(shape: T) {
  return z.object(shape).extend({ included: includedBundle });
}

export function paginatedOutputWithIncluded<T extends z.ZodTypeAny, U extends z.ZodRawShape = {}>(
  itemSchema: T,
  extension?: U,
) {
  const output = extension
    ? paginatedOutput(itemSchema).extend(extension)
    : paginatedOutput(itemSchema);
  return output.extend({ included: includedBundle });
}

export const contentWithIncluded = withIncluded({ content });
export const eventWithIncluded = withIncluded({ event: content });
export const directMessageWithIncluded = withIncluded({ message: directMessageSummary });

export type MemberRef = z.infer<typeof memberRef>;
export type SharedClubRef = z.infer<typeof sharedClubRef>;
export type MentionSpan = z.infer<typeof mentionSpan>;
export type IncludedMember = z.infer<typeof includedMember>;
export type IncludedBundle = z.infer<typeof includedBundle>;
export type MembershipSummary = z.infer<typeof membershipSummary>;
export type MembershipAdminSummary = z.infer<typeof membershipAdminSummary>;
export type MembershipVouchSummary = z.infer<typeof vouchSummary>;
export type InlineMembershipVouchSummary = z.infer<typeof inlineVouchSummary>;
export type InvitationSummary = z.infer<typeof invitationSummary>;
export type PublicMemberSummary = z.infer<typeof publicMemberSummary>;
export type MemberSearchResult = z.infer<typeof memberSearchResult>;
export type AdminMemberSummary = z.infer<typeof adminMemberSummary>;
export type ClubProfile = z.infer<typeof clubProfile>;
export type MemberIdentity = z.infer<typeof memberIdentity>;
export type MemberProfileEnvelope = z.infer<typeof memberProfileEnvelope>;
export type ContentAuthorRef = z.infer<typeof contentAuthorRef>;
export type EventRsvpAttendee = z.infer<typeof eventRsvpAttendee>;
export type Content = z.infer<typeof content>;
export type ContentWithIncluded = z.infer<typeof contentWithIncluded>;
export type EventWithIncluded = z.infer<typeof eventWithIncluded>;
export type ContentSearchResult = z.infer<typeof contentSearchResult>;
export type ContentThread = z.infer<typeof contentThread>;
export type DirectMessageSummary = z.infer<typeof directMessageSummary>;
export type DirectMessageThreadSummary = z.infer<typeof directMessageThreadSummary>;
export type DirectMessageEntry = z.infer<typeof directMessageEntry>;
export type DirectMessageInboxSummary = z.infer<typeof directMessageInboxSummary>;
export type DirectMessageWithIncluded = z.infer<typeof directMessageWithIncluded>;
export type BearerTokenSummary = z.infer<typeof bearerTokenSummary>;
export type CreatedBearerToken = z.infer<typeof createdBearerToken>;
export type NotificationProducerSummary = z.infer<typeof notificationProducerSummary>;
export type NotificationProducerTopicSummary = z.infer<typeof notificationProducerTopicSummary>;
export type CreatedNotificationProducer = z.infer<typeof createdNotificationProducer>;
export type RotatedNotificationProducerSecret = z.infer<typeof rotatedNotificationProducerSecret>;
export type QuotaAllowance = z.infer<typeof quotaAllowance>;
export type ActivityEvent = z.infer<typeof activityEvent>;
export type NotificationItem = z.infer<typeof notificationItem>;
export type NotificationReceipt = z.infer<typeof notificationReceipt>;
export type ClubSummary = z.infer<typeof clubSummary>;
export type MessageRemovalResult = z.infer<typeof messageRemovalResult>;
export type RemovedClubSummary = z.infer<typeof removedClubSummary>;
export type RemovedMemberSummary = z.infer<typeof removedMemberSummary>;
export type AdminOverview = z.infer<typeof adminOverview>;
export type SuperadminMemberSummary = z.infer<typeof superadminMemberSummary>;
export type SuperadminMemberDetail = z.infer<typeof superadminMemberDetail>;
export type AdminClubStats = z.infer<typeof adminClubStats>;
export type ClubSpendWindow = z.infer<typeof clubSpendWindow>;
export type ClubLlmOutputUsageWindow = z.infer<typeof clubLlmOutputUsageWindow>;
export type SuperadminClubDetail = z.infer<typeof superadminClubDetail>;
export type AdminContentSummary = z.infer<typeof adminContentSummary>;
export type AdminThreadSummary = z.infer<typeof adminThreadSummary>;
export type AdminDiagnostics = z.infer<typeof adminDiagnostics>;
