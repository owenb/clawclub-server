export type Paginated<T> = { results: T[]; hasMore: boolean; nextCursor: string | null };

export class AppError extends Error {
  statusCode: number;
  code: string;
  requestTemplate?: unknown;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export type MembershipState =
  | 'applying'
  | 'submitted'
  | 'interview_scheduled'
  | 'interview_completed'
  | 'payment_pending'
  | 'active'
  | 'renewal_pending'
  | 'cancelled'
  | 'expired'
  | 'removed'
  | 'banned'
  | 'declined'
  | 'withdrawn';

export type MembershipSummary = {
  membershipId: string;
  clubId: string;
  slug: string;
  name: string;
  summary: string | null;
  role: 'clubadmin' | 'member';
  isOwner: boolean;
  status: 'active' | 'renewal_pending' | 'cancelled';
  sponsorMemberId: string | null;
  joinedAt: string;
};

export type MemberRef = {
  memberId: string;
  publicName: string;
};

export type MembershipVouchSummary = {
  edgeId: string;
  fromMember: MemberRef;
  reason: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  createdByMemberId: string | null;
};

export type InlineMembershipVouchSummary = {
  edgeId: string;
  voucher: MemberRef;
  reason: string;
  createdAt: string;
};

export type MembershipAdminSummary = {
  membershipId: string;
  clubId: string;
  member: MemberRef;
  sponsor: MemberRef | null;
  role: 'clubadmin' | 'member';
  isOwner: boolean;
  state: {
    status: MembershipState;
    reason: string | null;
    versionNo: number;
    createdAt: string;
    createdByMemberId: string | null;
  };
  joinedAt: string | null;
  acceptedCovenantAt: string | null;
  metadata: Record<string, unknown>;
};

export type CreateMembershipInput = {
  actorMemberId: string;
  clubId: string;
  memberId: string;
  sponsorMemberId?: string | null;
  role: 'member';
  initialStatus: Extract<MembershipState, 'applying' | 'submitted' | 'active' | 'payment_pending'>;
  reason?: string | null;
  metadata: Record<string, unknown>;
  skipClubAdminCheck?: boolean;
  initialProfile: {
    fields: ClubProfileFields;
    generationSource: 'application_generated' | 'membership_seed';
  };
};

export type TransitionMembershipInput = {
  actorMemberId: string;
  membershipId: string;
  nextStatus: MembershipState;
  reason?: string | null;
  accessibleClubIds: string[];
  skipClubAdminCheck?: boolean;
};

export type InvitationStatus = 'open' | 'used' | 'revoked' | 'expired';

export type JoinClubInput = {
  actorMemberId: string | null;
  clubSlug: string;
  email?: string;
  invitationCode?: string;
};

export type JoinClubResult = {
  memberToken: string | null;
  clubId: string;
  membershipId: string;
  proof:
    | { kind: 'pow'; challengeId: string; difficulty: number; expiresAt: string; maxAttempts: number }
    | { kind: 'none' };
  club: {
    name: string;
    summary: string | null;
    ownerName: string;
    admissionPolicy: string | null;
    priceUsd?: number | null;
  };
};

export type SubmitClubApplicationInput = {
  actorMemberId: string;
  membershipId: string;
  nonce?: string;
  name: string;
  socials: string;
  application: string;
};

export type SubmitClubApplicationResult =
  | {
      status: 'submitted';
      membershipId: string;
      applicationSubmittedAt: string;
    }
  | {
      status: 'needs_revision';
      feedback: string;
      attemptsRemaining: number;
    }
    | {
      status: 'attempts_exhausted';
      message: string;
    };

export type OnboardingWelcome = {
  greeting: string;
  preamble: string;
  capabilities: string[];
  closing: string;
};

export type ClubsOnboardResult =
  | { alreadyOnboarded: true }
  | { alreadyOnboarded: false; orphaned: true }
  | {
      alreadyOnboarded: false;
      member: {
        id: string;
        displayName: string;
      };
      club: {
        id: string;
        slug: string;
        name: string;
        summary: string | null;
      };
      welcome: OnboardingWelcome;
    };

export type ApplicationSummary = {
  membershipId: string;
  clubId: string;
  clubSlug: string;
  clubName: string;
  state: MembershipState;
  submissionPath: 'cold' | 'invitation' | 'cross_apply' | 'owner_nominated';
  appliedAt: string;
  submittedAt: string | null;
  decidedAt: string | null;
  applicationName: string | null;
  applicationEmail: string | null;
  applicationSocials: string | null;
  applicationText: string | null;
  billing: {
    required: boolean;
    membershipState: MembershipState;
    accessible: boolean;
  };
};

export type PublicMemberSummary = {
  membershipId: string;
  memberId: string;
  publicName: string;
  displayName: string;
  tagline: string | null;
  summary: string | null;
  whatIDo: string | null;
  knownFor: string | null;
  servicesSummary: string | null;
  websiteUrl: string | null;
  links: ClubProfileLink[];
  role: 'clubadmin' | 'member';
  isOwner: boolean;
  joinedAt: string;
  sponsor: MemberRef | null;
  vouches: InlineMembershipVouchSummary[];
};

export type AdminMemberSummary = PublicMemberSummary & {
  isComped: boolean;
  compedAt: string | null;
  compedByMemberId: string | null;
  approvedPriceAmount: number | null;
  approvedPriceCurrency: string | null;
  subscription: {
    status: 'trialing' | 'active' | 'past_due' | 'cancelled' | 'ended';
    currentPeriodEnd: string | null;
    endedAt: string | null;
  } | null;
  acceptedCovenantAt: string | null;
  leftAt: string | null;
  state: {
    status: MembershipState;
    reason: string | null;
    versionNo: number;
    createdAt: string;
    createdByMemberId: string | null;
  };
};

export type AdminApplicationSummary = {
  membershipId: string;
  memberId: string;
  publicName: string;
  displayName: string | null;
  state: {
    status: Extract<MembershipState, 'applying' | 'submitted' | 'interview_scheduled' | 'interview_completed' | 'payment_pending'>;
    reason: string | null;
    versionNo: number;
    createdAt: string;
    createdByMemberId: string | null;
  };
  appliedAt: string | null;
  submittedAt: string | null;
  applicationName: string | null;
  applicationEmail: string | null;
  applicationSocials: string | null;
  applicationText: string | null;
  proofKind: 'pow' | 'invitation' | 'none' | null;
  submissionPath: 'cold' | 'invitation' | 'cross_apply' | 'owner_nominated' | null;
  generatedProfileDraft: ClubProfileFields | null;
  sponsor: MemberRef | null;
  invitation: {
    id: string;
    reason: string | null;
  } | null;
  sponsorStats: {
    activeSponsoredCount: number;
    sponsoredThisMonthCount: number;
  } | null;
};

export type IssueInvitationInput = {
  actorMemberId: string;
  clubId: string;
  candidateName: string;
  candidateEmail: string;
  reason: string;
};

export type InvitationSummary = {
  invitationId: string;
  clubId: string;
  candidateName: string;
  candidateEmail: string;
  sponsor: {
    memberId: string;
    publicName: string;
  };
  reason: string;
  status: InvitationStatus;
  expiresAt: string | null;
  createdAt: string;
};

export type ClubSummary = {
  clubId: string;
  slug: string;
  name: string;
  summary: string | null;
  admissionPolicy: string | null;
  archivedAt: string | null;
  owner: {
    memberId: string;
    publicName: string;
    email: string | null;
  };
  version: {
    versionNo: number;
    createdAt: string;
    createdByMemberId: string | null;
  };
};

export type CreateClubInput = {
  actorMemberId: string;
  slug: string;
  name: string;
  summary: string;
  ownerMemberId: string;
};

export type ArchiveClubInput = {
  actorMemberId: string;
  clubId: string;
};

export type AssignClubOwnerInput = {
  actorMemberId: string;
  clubId: string;
  ownerMemberId: string;
};

export type UpdateClubInput = {
  actorMemberId: string;
  clubId: string;
  patch: {
    name?: string;
    summary?: string | null;
    admissionPolicy?: string | null;
  };
};

export type MemberActor = {
  id: string;
  publicName: string;
  onboardedAt: string | null;
};

export type ActorContext = {
  member: MemberActor;
  memberships: MembershipSummary[];
  globalRoles: Array<'superadmin'>;
};

export type MaybeMemberActorContext = {
  member: MemberActor | null;
  memberships: MembershipSummary[];
  globalRoles: Array<'superadmin'>;
};

export type RequestScope = {
  requestedClubId: string | null;
  activeClubIds: string[];
};

export type ActivityEvent = {
  activityId: string;
  seq: number;
  clubId: string;
  topic: string;
  payload: Record<string, unknown>;
  entityId: string | null;
  entityVersionId: string | null;
  audience: 'members' | 'clubadmins' | 'owners';
  createdAt: string;
  createdByMemberId: string | null;
};

export type NotificationItem = {
  notificationId: string;
  cursor: string;
  kind: string;
  clubId: string | null;
  ref: {
    membershipId?: string;
    matchId?: string;
    entityId?: string;
  };
  payload: Record<string, unknown>;
  createdAt: string;
  acknowledgeable: boolean;
  acknowledgedState: UpdateReceiptState | null;
};

export type NotificationReceipt = {
  notificationId: string;
  recipientMemberId: string;
  entityId: string | null;
  clubId: string | null;
  state: UpdateReceiptState;
  suppressionReason: string | null;
  versionNo: number;
  createdAt: string;
  createdByMemberId: string | null;
};

export type SharedResponseContext = {
  notifications: NotificationItem[];
  notificationsTruncated: boolean;
};

export type AuthResult = {
  actor: ActorContext;
  requestScope: RequestScope;
  sharedContext: SharedResponseContext;
};

export type UpdateReceiptState = 'processed' | 'suppressed';

export type MemberSearchResult = {
  memberId: string;
  publicName: string;
  displayName: string;
  tagline: string | null;
  summary: string | null;
  whatIDo: string | null;
  knownFor: string | null;
  servicesSummary: string | null;
  websiteUrl: string | null;
  sharedClubs: SharedClubRef[];
};

export type ClubProfile = {
  club: SharedClubRef;
  tagline: string | null;
  summary: string | null;
  whatIDo: string | null;
  knownFor: string | null;
  servicesSummary: string | null;
  websiteUrl: string | null;
  links: ClubProfileLink[];
  version: {
    id: string;
    versionNo: number;
    createdAt: string;
    createdByMemberId: string | null;
  };
};

export type ClubProfileLink = {
  url: string;
  label: string | null;
};

export type ClubProfileFields = {
  tagline: string | null;
  summary: string | null;
  whatIDo: string | null;
  knownFor: string | null;
  servicesSummary: string | null;
  websiteUrl: string | null;
  links: ClubProfileLink[];
};

export type MemberIdentity = {
  memberId: string;
  publicName: string;
  displayName: string;
};

export type MemberProfileEnvelope = {
  memberId: string;
  publicName: string;
  displayName: string;
  profiles: ClubProfile[];
};

export type UpdateMemberIdentityInput = {
  displayName?: string;
};

export type UpdateClubProfileInput = {
  clubId: string;
  tagline?: string | null;
  summary?: string | null;
  whatIDo?: string | null;
  knownFor?: string | null;
  servicesSummary?: string | null;
  websiteUrl?: string | null;
  links?: ClubProfileLink[];
};

export type ProfileForGate = {
  tagline: string | null;
  summary: string | null;
  whatIDo: string | null;
  knownFor: string | null;
  servicesSummary: string | null;
  websiteUrl: string | null;
  links: ClubProfileLink[];
};

export type EntityKind = 'post' | 'opportunity' | 'service' | 'ask' | 'gift' | 'event';
export type EntityState = 'draft' | 'published' | 'removed';

export type EventFields = {
  location: string | null;
  startsAt: string | null;
  endsAt: string | null;
  timezone: string | null;
  recurrenceRule: string | null;
  capacity: number | null;
};

export type EventRsvpState = 'yes' | 'maybe' | 'no' | 'waitlist';

export type EventRsvpAttendee = {
  membershipId: string;
  memberId: string;
  publicName: string;
  response: EventRsvpState;
  note: string | null;
  createdAt: string;
};

export type EventRsvpSummary = {
  viewerResponse: EventRsvpState | null;
  counts: Record<EventRsvpState, number>;
  attendees: EventRsvpAttendee[];
};

export type ContentEntity = {
  entityId: string;
  contentThreadId: string;
  clubId: string;
  kind: EntityKind;
  openLoop: boolean | null;
  author: {
    memberId: string;
    publicName: string;
    displayName: string;
  };
  version: {
    versionNo: number;
    state: EntityState;
    title: string | null;
    summary: string | null;
    body: string | null;
    effectiveAt: string;
    expiresAt: string | null;
    createdAt: string;
    mentions: {
      title: MentionSpan[];
      summary: MentionSpan[];
      body: MentionSpan[];
    };
  };
  event: EventFields | null;
  rsvps: EventRsvpSummary | null;
  createdAt: string;
};

export type ContentEntitySearchResult = ContentEntity & {
  score: number;
};

export type EntitySummary = ContentEntity;
export type EventSummary = ContentEntity;

export type ContentThreadSummary = {
  threadId: string;
  clubId: string;
  firstEntity: ContentEntity;
  thread: {
    entityCount: number;
    lastActivityAt: string;
  };
};

export type ContentThread = {
  threadId: string;
  clubId: string;
  entities: ContentEntity[];
  entityCount: number;
  lastActivityAt: string;
  hasMore: boolean;
  nextCursor: string | null;
};

export type CreateEntityInput = {
  authorMemberId: string;
  clubId?: string;
  threadId?: string;
  kind: EntityKind;
  title: string | null;
  summary: string | null;
  body: string | null;
  expiresAt: string | null;
  clientKey?: string | null;
  event?: EventFields | null;
};

export type ListEventsInput = {
  actorMemberId: string;
  clubIds: string[];
  limit: number;
  query?: string;
  cursor?: { startsAt: string; entityId: string } | null;
};

export type RsvpEventInput = {
  actorMemberId: string;
  eventEntityId: string;
  response: EventRsvpState;
  note?: string | null;
  clientKey?: string | null;
  accessibleMemberships: Array<{
    membershipId: string;
    clubId: string;
  }>;
};

export type ListEntitiesInput = {
  actorMemberId: string;
  clubIds: string[];
  kinds: EntityKind[];
  limit: number;
  query?: string;
  includeClosed: boolean;
  cursor?: { lastActivityAt: string; threadId: string } | null;
};

export type ReadContentThreadInput = {
  actorMemberId: string;
  accessibleMemberships: Array<{
    membershipId: string;
    clubId: string;
  }>;
  accessibleClubIds: string[];
  entityId?: string;
  threadId?: string;
  includeClosed: boolean;
  limit: number;
  cursor?: { createdAt: string; entityId: string } | null;
};

export type RemoveEntityInput = {
  actorMemberId: string;
  accessibleClubIds: string[];
  entityId: string;
  reason?: string | null;
  skipAuthCheck?: boolean;
  skipNotification?: boolean;
};

export type RemoveMessageInput = {
  actorMemberId: string;
  accessibleClubIds: string[];
  messageId: string;
  reason?: string | null;
  skipAuthCheck?: boolean;
  skipNotification?: boolean;
};

export type SharedClubRef = {
  clubId: string;
  slug: string;
  name: string;
};

export type MentionSpan = {
  memberId: string;
  authoredLabel: string;
  start: number;
  end: number;
};

export type IncludedMember = {
  memberId: string;
  publicName: string;
  displayName: string;
};

export type IncludedBundle = {
  membersById: Record<string, IncludedMember>;
};

export type WithIncluded<T> = T & {
  included: IncludedBundle;
};

export type MessageRemovalResult = {
  messageId: string;
  removedByMemberId: string;
  reason: string | null;
  removedAt: string;
};

export type BearerTokenSummary = {
  tokenId: string;
  memberId: string;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  expiresAt: string | null;
  metadata: Record<string, unknown>;
};

export type CreateBearerTokenInput = {
  actorMemberId: string;
  label?: string | null;
  expiresAt?: string | null;
  metadata?: Record<string, unknown>;
};

export type CreatedBearerToken = {
  token: BearerTokenSummary;
  bearerToken: string;
};

export type RevokeBearerTokenInput = {
  actorMemberId: string;
  tokenId: string;
};

export type DirectMessageSummary = {
  threadId: string;
  sharedClubs: SharedClubRef[];
  senderMemberId: string;
  recipientMemberId: string;
  messageId: string;
  messageText: string;
  mentions: MentionSpan[];
  createdAt: string;
  updateCount: number;
};

export type DirectMessageThreadSummary = {
  threadId: string;
  sharedClubs: SharedClubRef[];
  counterpartMemberId: string;
  counterpartPublicName: string;
  latestMessage: {
    messageId: string;
    senderMemberId: string | null;
    role: 'member' | 'agent' | 'system';
    messageText: string | null;
    mentions: MentionSpan[];
    createdAt: string;
  };
  messageCount: number;
};

export type DirectMessageInboxSummary = DirectMessageThreadSummary & {
  unread: {
    hasUnread: boolean;
    unreadMessageCount: number;
    unreadUpdateCount: number;
    latestUnreadMessageCreatedAt: string | null;
  };
};

export type DirectMessageEntry = {
  messageId: string;
  threadId: string;
  senderMemberId: string | null;
  role: 'member' | 'agent' | 'system';
  messageText: string | null;
  mentions: MentionSpan[];
  payload: Record<string, unknown>;
  createdAt: string;
  inReplyToMessageId: string | null;
};

export type MessageFramePayload = {
  thread: DirectMessageThreadSummary;
  messages: DirectMessageEntry[];
  included: IncludedBundle;
};

export type MessageFramePage = {
  frames: MessageFramePayload[];
  nextAfter: string | null;
};

export type SendDirectMessageInput = {
  actorMemberId: string;
  accessibleClubIds: string[];
  recipientMemberId: string;
  messageText: string;
  clientKey?: string | null;
};

export type UpdateEntityInput = {
  actorMemberId: string;
  accessibleClubIds: string[];
  entityId: string;
  patch: {
    title?: string | null;
    summary?: string | null;
    body?: string | null;
    expiresAt?: string | null;
    event?: Partial<EventFields> | null;
  };
};

export type EntityForGate = {
  entityKind: 'post' | 'ask' | 'gift' | 'service' | 'opportunity' | 'event';
  isReply: boolean;
  title: string | null;
  summary: string | null;
  body: string | null;
  event: {
    location: string;
    startsAt: string;
    endsAt: string | null;
    timezone: string | null;
  } | null;
};

export type SetEntityLoopInput = {
  actorMemberId: string;
  accessibleClubIds: string[];
  entityId: string;
};

export type CreateVouchInput = {
  actorMemberId: string;
  clubId: string;
  targetMemberId: string;
  reason: string;
  clientKey?: string | null;
};

export type QuotaAllowance = {
  action: string;
  clubId: string;
  maxPerDay: number;
  usedToday: number;
  remaining: number;
};

export type AdminOverview = {
  totalMembers: number;
  activeMembers: number;
  totalClubs: number;
  totalEntities: number;
  totalMessages: number;
  pendingApplications: number;
  recentMembers: Array<{
    memberId: string;
    publicName: string;
    createdAt: string;
  }>;
};

export type SuperadminMemberSummary = {
  memberId: string;
  publicName: string;
  state: string;
  createdAt: string;
  membershipCount: number;
  tokenCount: number;
};

export type SuperadminMemberDetail = {
  memberId: string;
  publicName: string;
  displayName: string;
  state: string;
  createdAt: string;
  memberships: Array<{
    membershipId: string;
    clubId: string;
    clubName: string;
    clubSlug: string;
    role: string;
    status: string;
    joinedAt: string;
  }>;
  tokenCount: number;
  profiles: ClubProfile[];
};

export type AdminClubStats = {
  clubId: string;
  slug: string;
  name: string;
  archivedAt: string | null;
  memberCounts: Record<string, number>;
  entityCount: number;
  messageCount: number;
};

export type AdminContentSummary = {
  entityId: string;
  contentThreadId: string;
  clubId: string;
  clubName: string;
  kind: EntityKind;
  author: {
    memberId: string;
    publicName: string;
  };
  title: string | null;
  titleMentions: MentionSpan[];
  state: EntityState;
  createdAt: string;
};

export type AdminThreadSummary = {
  threadId: string;
  sharedClubs: SharedClubRef[];
  participants: Array<{
    memberId: string;
    publicName: string;
  }>;
  messageCount: number;
  latestMessageAt: string;
};

export type AdminDiagnostics = {
  migrationCount: number;
  latestMigration: string | null;
  memberCount: number;
  clubCount: number;
  tablesWithRls: number;
  totalAppTables: number;
  databaseSize: string;
};

export type Repository = {
  authenticateBearerToken(bearerToken: string): Promise<AuthResult | null>;
  validateBearerTokenPassive?(bearerToken: string): Promise<AuthResult | null>;
  joinClub?(input: JoinClubInput): Promise<JoinClubResult>;
  onboardMember?(input: { actorMemberId: string }): Promise<ClubsOnboardResult>;
  submitClubApplication?(input: SubmitClubApplicationInput): Promise<SubmitClubApplicationResult>;
  getClubApplication?(input: {
    actorMemberId: string;
    membershipId: string;
  }): Promise<ApplicationSummary | null>;
  listClubApplications?(input: {
    actorMemberId: string;
    clubId?: string;
    statuses?: MembershipState[];
  }): Promise<ApplicationSummary[]>;
  startMembershipCheckout?(input: {
    actorMemberId: string;
    clubId: string;
  }): Promise<{ checkoutUrl: string } | null>;
  issueInvitation?(input: IssueInvitationInput): Promise<{ invitation: InvitationSummary; invitationCode: string } | null>;
  listIssuedInvitations?(input: {
    actorMemberId: string;
    clubId?: string;
    status?: InvitationStatus;
  }): Promise<InvitationSummary[]>;
  revokeInvitation?(input: {
    actorMemberId: string;
    invitationId: string;
    adminClubIds?: string[];
  }): Promise<InvitationSummary | null>;
  listClubs?(input: { actorMemberId: string; includeArchived: boolean }): Promise<ClubSummary[]>;
  createClub?(input: CreateClubInput): Promise<ClubSummary | null>;
  archiveClub?(input: ArchiveClubInput): Promise<ClubSummary | null>;
  assignClubOwner?(input: AssignClubOwnerInput): Promise<ClubSummary | null>;
  updateClub?(input: UpdateClubInput): Promise<ClubSummary | null>;
  createMembership(input: CreateMembershipInput): Promise<MembershipAdminSummary | null>;
  transitionMembershipState(input: TransitionMembershipInput): Promise<MembershipAdminSummary | null>;
  listMembers(input: {
    actorMemberId: string;
    clubId: string;
    limit: number;
    cursor?: { joinedAt: string; membershipId: string } | null;
  }): Promise<Paginated<PublicMemberSummary>>;
  getMember(input: {
    actorMemberId: string;
    clubId: string;
    memberId: string;
  }): Promise<PublicMemberSummary | null>;
  listAdminMembers(input: {
    actorMemberId: string;
    clubId: string;
    limit: number;
    statuses?: Extract<MembershipState, 'active' | 'renewal_pending' | 'cancelled'>[] | null;
    roles?: Array<'clubadmin' | 'member'> | null;
    cursor?: { joinedAt: string; membershipId: string } | null;
  }): Promise<Paginated<AdminMemberSummary>>;
  getAdminMember(input: {
    actorMemberId: string;
    clubId: string;
    membershipId: string;
  }): Promise<AdminMemberSummary | null>;
  listAdminApplications?(input: {
    actorMemberId: string;
    clubId: string;
    limit: number;
    statuses?: Extract<MembershipState, 'applying' | 'submitted' | 'interview_scheduled' | 'interview_completed' | 'payment_pending'>[] | null;
    cursor?: { stateCreatedAt: string; membershipId: string } | null;
  }): Promise<Paginated<AdminApplicationSummary>>;
  getAdminApplication?(input: {
    actorMemberId: string;
    clubId: string;
    membershipId: string;
  }): Promise<{
    club: {
      clubId: string;
      slug: string;
      name: string;
      summary: string | null;
      admissionPolicy: string | null;
      ownerName: string | null;
      priceUsd: number | null;
    };
    application: AdminApplicationSummary;
  } | null>;
  buildMembershipSeedProfile?(input: {
    memberId: string;
    clubId: string;
  }): Promise<ClubProfileFields>;
  listMemberProfiles(input: {
    actorMemberId: string;
    targetMemberId: string;
    actorClubIds: string[];
    clubId?: string;
  }): Promise<MemberProfileEnvelope | null>;
  updateMemberIdentity?(input: { actor: ActorContext; patch: UpdateMemberIdentityInput }): Promise<MemberIdentity>;
  updateClubProfile?(input: { actor: ActorContext; patch: UpdateClubProfileInput }): Promise<MemberProfileEnvelope>;
  loadProfileForGate?(input: {
    actorMemberId: string;
    clubId: string;
  }): Promise<ProfileForGate | null>;
  preflightCreateEntityMentions?(input: {
    actorMemberId: string;
    actorClubIds: string[];
    clubId?: string;
    threadId?: string;
    title: string | null;
    summary: string | null;
    body: string | null;
    clientKey?: string | null;
  }): Promise<void>;
  preflightUpdateEntityMentions?(input: {
    actorMemberId: string;
    actorClubIds: string[];
    entityId: string;
    patch: {
      title?: string | null;
      summary?: string | null;
      body?: string | null;
    };
  }): Promise<void>;
  createEntity(input: CreateEntityInput): Promise<WithIncluded<{ entity: ContentEntity }>>;
  updateEntity(input: UpdateEntityInput): Promise<WithIncluded<{ entity: ContentEntity }> | null>;
  loadEntityForGate?(input: {
    actorMemberId: string;
    entityId: string;
    accessibleClubIds: string[];
  }): Promise<EntityForGate | null>;
  closeEntityLoop(input: SetEntityLoopInput): Promise<WithIncluded<{ entity: ContentEntity }> | null>;
  reopenEntityLoop(input: SetEntityLoopInput): Promise<WithIncluded<{ entity: ContentEntity }> | null>;
  removeEntity?(input: RemoveEntityInput): Promise<WithIncluded<{ entity: ContentEntity }> | null>;
  listEntities(input: ListEntitiesInput): Promise<WithIncluded<Paginated<ContentThreadSummary>>>;
  readContentThread(input: ReadContentThreadInput): Promise<WithIncluded<{ thread: ContentThreadSummary; entities: ContentEntity[]; hasMore: boolean; nextCursor: string | null }> | null>;
  listEvents(input: ListEventsInput): Promise<WithIncluded<Paginated<ContentEntity>>>;
  rsvpEvent(input: RsvpEventInput): Promise<WithIncluded<{ entity: ContentEntity }> | null>;
  cancelEventRsvp(input: { actorMemberId: string; eventEntityId: string; accessibleMemberships: Array<{ membershipId: string; clubId: string }> }): Promise<WithIncluded<{ entity: ContentEntity }> | null>;
  listBearerTokens(input: { actorMemberId: string }): Promise<BearerTokenSummary[]>;
  createBearerToken(input: CreateBearerTokenInput): Promise<CreatedBearerToken>;
  revokeBearerToken(input: RevokeBearerTokenInput): Promise<BearerTokenSummary | null>;
  listClubActivity(input: {
    actorMemberId: string;
    clubIds: string[];
    adminClubIds: string[];
    ownerClubIds: string[];
    limit: number;
    afterSeq?: number | null;
  }): Promise<{ items: ActivityEvent[]; nextAfterSeq: number | null }>;
  listNotifications(input: {
    actorMemberId: string;
    accessibleClubIds: string[];
    adminClubIds: string[];
    limit: number;
    after: string | null;
  }): Promise<{ items: NotificationItem[]; nextAfter: string | null }>;
  acknowledgeNotifications(input: {
    actorMemberId: string;
    notificationIds: string[];
    state: UpdateReceiptState;
    suppressionReason?: string | null;
  }): Promise<NotificationReceipt[]>;
  sendDirectMessage(input: SendDirectMessageInput): Promise<WithIncluded<{ message: DirectMessageSummary }> | null>;
  listDirectMessageThreads(input: { actorMemberId: string; limit: number }): Promise<DirectMessageThreadSummary[]>;
  listDirectMessageInbox(input: {
    actorMemberId: string;
    limit: number;
    unreadOnly: boolean;
    cursor?: { latestActivityAt: string; threadId: string } | null;
  }): Promise<WithIncluded<Paginated<DirectMessageInboxSummary>>>;
  readDirectMessageThread(input: {
    actorMemberId: string;
    threadId: string;
    limit: number;
    cursor?: { createdAt: string; messageId: string } | null;
  }): Promise<WithIncluded<{ thread: DirectMessageThreadSummary; messages: DirectMessageEntry[]; hasMore: boolean; nextCursor: string | null }> | null>;
  listInboxSince(input: {
    actorMemberId: string;
    after: string | null;
    limit: number;
  }): Promise<MessageFramePage>;
  acknowledgeDirectMessageInbox(input: {
    actorMemberId: string;
    threadId: string;
  }): Promise<{ threadId: string; acknowledgedCount: number } | null>;

  createVouch(input: CreateVouchInput): Promise<MembershipVouchSummary | null>;
  listVouches(input: { actorMemberId: string; clubIds: string[]; targetMemberId: string; limit: number; cursor?: { createdAt: string; edgeId: string } | null }): Promise<Paginated<MembershipVouchSummary>>;
  promoteMemberToAdmin?(input: { actorMemberId: string; clubId: string; memberId: string }): Promise<{ membership: MembershipAdminSummary; changed: boolean } | null>;
  demoteMemberFromAdmin?(input: { actorMemberId: string; clubId: string; memberId: string }): Promise<{ membership: MembershipAdminSummary; changed: boolean } | null>;
  getQuotaStatus(input: { actorMemberId: string; clubIds: string[]; memberships?: Array<{ clubId: string; role: 'member' | 'clubadmin'; isOwner: boolean }> }): Promise<QuotaAllowance[]>;

  removeMessage?(input: RemoveMessageInput): Promise<MessageRemovalResult | null>;

  adminCreateMember?(input: { actorMemberId: string; publicName: string; email?: string | null }): Promise<{ memberId: string; publicName: string; bearerToken: string }>;
  adminCreateMembership?(input: {
    actorMemberId: string;
    clubId: string;
    memberId: string;
    role: 'member' | 'clubadmin';
    sponsorMemberId?: string | null;
    initialStatus: Extract<MembershipState, 'applying' | 'submitted' | 'active' | 'payment_pending'>;
    reason?: string | null;
    initialProfile: {
      fields: ClubProfileFields;
      generationSource: 'membership_seed' | 'application_generated';
    };
  }): Promise<MembershipAdminSummary | null>;
  adminGetOverview?(input: { actorMemberId: string }): Promise<AdminOverview>;
  adminListMembers?(input: { actorMemberId: string; limit: number; cursor?: { createdAt: string; id: string } | null }): Promise<Paginated<SuperadminMemberSummary>>;
  adminGetMember?(input: { actorMemberId: string; memberId: string }): Promise<SuperadminMemberDetail | null>;
  adminGetClubStats?(input: { actorMemberId: string; clubId: string }): Promise<AdminClubStats | null>;
  adminListContent?(input: { actorMemberId: string; clubId?: string; kind?: EntityKind; limit: number; cursor?: { createdAt: string; id: string } | null }): Promise<WithIncluded<Paginated<AdminContentSummary>>>;
  adminListThreads?(input: { actorMemberId: string; limit: number; cursor?: { createdAt: string; id: string } | null }): Promise<Paginated<AdminThreadSummary>>;
  adminReadThread?(input: { actorMemberId: string; threadId: string; limit: number }): Promise<WithIncluded<{ thread: AdminThreadSummary; messages: DirectMessageEntry[] }> | null>;
  adminListMemberTokens?(input: { actorMemberId: string; memberId: string }): Promise<BearerTokenSummary[]>;
  adminRevokeMemberToken?(input: { actorMemberId: string; memberId: string; tokenId: string }): Promise<BearerTokenSummary | null>;
  adminCreateAccessToken?(input: {
    actorMemberId: string;
    memberId: string;
    label?: string | null;
    expiresAt?: string | null;
    reason?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<CreatedBearerToken | null>;
  adminGetDiagnostics?(input: { actorMemberId: string }): Promise<AdminDiagnostics>;

  // ── Billing helpers ────────────────────────────────────
  isPaidClub?(clubId: string): Promise<boolean>;
  getBillingStatus?(input: { memberId: string; clubId: string }): Promise<{
    membershipId: string;
    state: string;
    isComped: boolean;
    paidThrough: string | null;
    approvedPrice: { amount: number | null; currency: string | null };
  } | null>;

  // ── Billing sync ───────────────────────────────────────
  billingActivateMembership?(input: { membershipId: string; paidThrough: string }): Promise<void>;
  billingRenewMembership?(input: { membershipId: string; newPaidThrough: string }): Promise<void>;
  billingMarkRenewalPending?(input: { membershipId: string }): Promise<void>;
  billingExpireMembership?(input: { membershipId: string }): Promise<void>;
  billingCancelAtPeriodEnd?(input: { membershipId: string }): Promise<void>;
  billingBanMember?(input: { memberId: string; reason: string }): Promise<void>;
  billingSetClubPrice?(input: { clubId: string; amount: number | null; currency: string }): Promise<void>;
  billingArchiveClub?(input: { clubId: string }): Promise<void>;

  logLlmUsage?(input: LogLlmUsageInput): Promise<void>;

  fullTextSearchMembers(input: {
    actorMemberId: string;
    clubId: string;
    query: string;
    limit: number;
    cursor?: { rank: string; memberId: string } | null;
  }): Promise<Paginated<MemberSearchResult>>;

  findMembersViaEmbedding(input: {
    actorMemberId: string;
    clubId: string;
    queryEmbedding: string;
    limit: number;
    cursor?: { distance: string; memberId: string } | null;
  }): Promise<Paginated<MemberSearchResult>>;

  findEntitiesViaEmbedding(input: {
    actorMemberId: string;
    clubIds: string[];
    queryEmbedding: string;
    kinds?: string[];
    limit: number;
    cursor?: { distance: string; entityId: string } | null;
  }): Promise<WithIncluded<Paginated<ContentEntitySearchResult>>>;
};

export type LogLlmUsageInput = {
  memberId: string | null;
  requestedClubId: string | null;
  actionName: string;
  artifactKind: string | null;
  provider: string;
  model: string;
  gateStatus:
    | 'passed'
    | 'rejected_illegal'
    | 'rejected_quality'
    | 'rejected_malformed'
    | 'skipped'
    | 'failed';
  skipReason: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  providerErrorCode: string | null;
  feedback: string | null;
};

export type ResponseNotice = {
  code: string;
  message: string;
};
