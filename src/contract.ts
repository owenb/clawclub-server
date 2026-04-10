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
  | 'invited' | 'pending_review' | 'active' | 'paused' | 'revoked' | 'rejected'
  | 'payment_pending' | 'renewal_pending' | 'cancelled' | 'banned' | 'expired';

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

export type MembershipVouchSummary = {
  edgeId: string;
  fromMember: {
    memberId: string;
    publicName: string;
    handle: string | null;
  };
  reason: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  createdByMemberId: string | null;
};

export type MembershipAdminSummary = {
  membershipId: string;
  clubId: string;
  member: {
    memberId: string;
    publicName: string;
    handle: string | null;
  };
  sponsor: {
    memberId: string;
    publicName: string;
    handle: string | null;
  } | null;
  role: 'clubadmin' | 'member';
  isOwner: boolean;
  state: {
    status: MembershipState;
    reason: string | null;
    versionNo: number;
    createdAt: string;
    createdByMemberId: string | null;
  };
  joinedAt: string;
  acceptedCovenantAt: string | null;
  metadata: Record<string, unknown>;
};

export type CreateMembershipInput = {
  actorMemberId: string;
  clubId: string;
  memberId: string;
  sponsorMemberId: string;
  role: 'member';
  initialStatus: Extract<MembershipState, 'invited' | 'pending_review' | 'active' | 'payment_pending'>;
  reason?: string | null;
  metadata: Record<string, unknown>;
  sourceAdmissionId?: string | null;
  skipClubAdminCheck?: boolean;
  initialProfile: {
    fields: ClubProfileFields;
    generationSource: 'admission_generated' | 'membership_seed';
  };
};

export type MembershipReviewSummary = MembershipAdminSummary & {
  sponsorStats: {
    activeSponsoredCount: number;
    sponsoredThisMonthCount: number;
  };
  vouches: MembershipVouchSummary[];
};

export type AdmissionStatus =
  | 'draft'
  | 'submitted'
  | 'interview_scheduled'
  | 'interview_completed'
  | 'accepted'
  | 'declined'
  | 'withdrawn';

export type AdmissionSummary = {
  admissionId: string;
  clubId: string;
  applicant: {
    memberId: string | null;
    publicName: string;
    handle: string | null;
    email: string | null;
  };
  sponsor: {
    memberId: string;
    publicName: string;
    handle: string | null;
  } | null;
  membershipId: string | null;
  origin: 'self_applied' | 'member_sponsored' | 'owner_nominated';
  intake: {
    kind: 'fit_check' | 'advice_call' | 'other';
    price: {
      amount: number | null;
      currency: string | null;
    };
    bookingUrl: string | null;
    bookedAt: string | null;
    completedAt: string | null;
  };
  state: {
    status: AdmissionStatus;
    notes: string | null;
    versionNo: number;
    createdAt: string;
    createdByMemberId: string | null;
  };
  admissionDetails: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type CreateAdmissionSponsorInput = {
  actorMemberId: string;
  clubId: string;
  candidateName: string;
  candidateEmail: string;
  candidateDetails: Record<string, unknown>;
  reason: string;
};

export type AdmissionClubSummary = {
  slug: string;
  name: string;
  summary: string | null;
  ownerName: string;
  admissionPolicy: string;
};

export type CreateAdmissionChallengeInput = {
  clubSlug: string;
};

export type AdmissionChallengeResult = {
  challengeId: string;
  difficulty: number;
  expiresAt: string;
  maxAttempts: number;
  club: AdmissionClubSummary;
};

export type SolveAdmissionChallengeInput = {
  challengeId: string;
  nonce: string;
  name: string;
  email: string;
  socials: string;
  application: string;
};

export type AdmissionApplyResult =
  | { status: 'accepted'; message: string }
  | { status: 'needs_revision'; feedback: string; attemptsRemaining: number }
  | { status: 'attempts_exhausted'; message: string };

export type AdmissionApplyOutcome =
  | AdmissionApplyResult
  | { result: AdmissionApplyResult; notices?: ResponseNotice[] };

export type CreateCrossAdmissionChallengeInput = {
  actorMemberId: string;
  clubSlug: string;
};

export type SolveCrossAdmissionChallengeInput = {
  actorMemberId: string;
  challengeId: string;
  nonce: string;
  socials: string;
  application: string;
};

export type TransitionAdmissionInput = {
  actorMemberId: string;
  admissionId: string;
  nextStatus: AdmissionStatus;
  notes?: string | null;
  accessibleClubIds: string[];
  intake?: {
    kind?: 'fit_check' | 'advice_call' | 'other';
    price?: {
      amount?: number | null;
      currency?: string | null;
    };
    bookingUrl?: string | null;
    bookedAt?: string | null;
    completedAt?: string | null;
  };
  metadataPatch?: Record<string, unknown>;
};

export type TransitionMembershipInput = {
  actorMemberId: string;
  membershipId: string;
  nextStatus: MembershipState;
  reason?: string | null;
  accessibleClubIds: string[];
  skipClubAdminCheck?: boolean;
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
    handle: string | null;
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

export type ActorContext = {
  member: {
    id: string;
    handle: string | null;
    publicName: string;
  };
  memberships: MembershipSummary[];
  globalRoles: Array<'superadmin'>;
};

export type RequestScope = {
  requestedClubId: string | null;
  activeClubIds: string[];
};

export type PendingUpdate = {
  updateId: string;
  streamSeq: number;
  source: 'activity' | 'inbox' | 'signal';
  recipientMemberId: string;
  clubId: string | null;
  entityId: string | null;
  entityVersionId: string | null;
  dmMessageId: string | null;
  topic: string;
  payload: Record<string, unknown>;
  createdAt: string;
  createdByMemberId: string | null;
};

export type SharedResponseContext = {
  pendingUpdates: PendingUpdate[];
};

export type MemberUpdates = {
  items: PendingUpdate[];
  nextAfter: string | null;
  polledAt: string;
};

export type AuthResult = {
  actor: ActorContext;
  requestScope: RequestScope;
  sharedContext: SharedResponseContext;
};

export type UpdateReceiptState = 'processed' | 'suppressed';

export type UpdateReceipt = {
  receiptId: string;
  updateId: string;
  recipientMemberId: string;
  clubId: string | null;
  state: UpdateReceiptState;
  suppressionReason: string | null;
  versionNo: number;
  supersedesReceiptId: string | null;
  createdAt: string;
  createdByMemberId: string | null;
};

export type AcknowledgeUpdatesInput = {
  actorMemberId: string;
  updateIds: string[];
  state: UpdateReceiptState;
  suppressionReason?: string | null;
};

export type MemberSearchResult = {
  memberId: string;
  publicName: string;
  displayName: string;
  handle: string | null;
  tagline: string | null;
  summary: string | null;
  whatIDo: string | null;
  knownFor: string | null;
  servicesSummary: string | null;
  websiteUrl: string | null;
  sharedClubs: SharedClubRef[];
};

export type ClubMemberSummary = {
  memberId: string;
  publicName: string;
  displayName: string;
  handle: string | null;
  tagline: string | null;
  summary: string | null;
  whatIDo: string | null;
  knownFor: string | null;
  servicesSummary: string | null;
  websiteUrl: string | null;
  memberships: MembershipSummary[];
};

export type ClubProfile = {
  club: SharedClubRef;
  tagline: string | null;
  summary: string | null;
  whatIDo: string | null;
  knownFor: string | null;
  servicesSummary: string | null;
  websiteUrl: string | null;
  links: unknown[];
  profile: Record<string, unknown>;
  version: {
    id: string;
    versionNo: number;
    createdAt: string;
    createdByMemberId: string | null;
  };
};

export type ClubProfileFields = {
  tagline: string | null;
  summary: string | null;
  whatIDo: string | null;
  knownFor: string | null;
  servicesSummary: string | null;
  websiteUrl: string | null;
  links: unknown[];
  profile: Record<string, unknown>;
};

export type MemberIdentity = {
  memberId: string;
  publicName: string;
  handle: string | null;
  displayName: string;
};

export type MemberProfileEnvelope = {
  memberId: string;
  publicName: string;
  handle: string | null;
  displayName: string;
  profiles: ClubProfile[];
};

export type UpdateMemberIdentityInput = {
  handle?: string | null;
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
  links?: unknown;
  profile?: unknown;
};

export type EntityKind = 'post' | 'opportunity' | 'service' | 'ask' | 'gift';
export type EntityState = 'draft' | 'published' | 'removed';

export type EntitySummary = {
  entityId: string;
  entityVersionId: string;
  clubId: string;
  kind: EntityKind;
  openLoop: boolean | null;
  author: {
    memberId: string;
    publicName: string;
    handle: string | null;
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
    content: Record<string, unknown>;
  };
  createdAt: string;
};

export type CreateEntityInput = {
  authorMemberId: string;
  clubId: string;
  kind: EntityKind;
  title: string | null;
  summary: string | null;
  body: string | null;
  expiresAt: string | null;
  content: Record<string, unknown>;
  clientKey?: string | null;
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

export type MessageRemovalResult = {
  messageId: string;
  removedByMemberId: string;
  reason: string | null;
  removedAt: string;
};

export type EventRsvpState = 'yes' | 'maybe' | 'no' | 'waitlist';

export type EventSummary = {
  entityId: string;
  entityVersionId: string;
  clubId: string;
  author: {
    memberId: string;
    publicName: string;
    handle: string | null;
  };
  version: {
    versionNo: number;
    state: EntityState;
    title: string | null;
    summary: string | null;
    body: string | null;
    location: string | null;
    startsAt: string | null;
    endsAt: string | null;
    timezone: string | null;
    recurrenceRule: string | null;
    capacity: number | null;
    effectiveAt: string;
    expiresAt: string | null;
    createdAt: string;
    content: Record<string, unknown>;
  };
  rsvps: {
    viewerResponse: EventRsvpState | null;
    counts: Record<EventRsvpState, number>;
    attendees: Array<{
      membershipId: string;
      memberId: string;
      publicName: string;
      handle: string | null;
      response: EventRsvpState;
      note: string | null;
      createdAt: string;
    }>;
  };
  createdAt: string;
};

export type CreateEventInput = {
  authorMemberId: string;
  clubId: string;
  title: string;
  summary: string;
  location: string;
  body: string | null;
  startsAt: string;
  endsAt: string | null;
  timezone: string | null;
  recurrenceRule: string | null;
  capacity: number | null;
  expiresAt: string | null;
  content: Record<string, unknown>;
  clientKey?: string | null;
};

export type ListEventsInput = {
  actorMemberId: string;
  clubIds: string[];
  limit: number;
  query?: string;
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
  createdAt: string;
  updateCount: number;
};

export type DirectMessageThreadSummary = {
  threadId: string;
  sharedClubs: SharedClubRef[];
  counterpartMemberId: string;
  counterpartPublicName: string;
  counterpartHandle: string | null;
  latestMessage: {
    messageId: string;
    senderMemberId: string | null;
    role: 'member' | 'agent' | 'system';
    messageText: string | null;
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

export type DirectMessageUpdateReceipt = {
  updateId: string;
  recipientMemberId: string;
  topic: string;
  createdAt: string;
  receipt: {
    receiptId: string;
    state: UpdateReceiptState;
    suppressionReason: string | null;
    versionNo: number;
    createdAt: string;
    createdByMemberId: string | null;
  } | null;
};

export type DirectMessageEntry = {
  messageId: string;
  threadId: string;
  senderMemberId: string | null;
  role: 'member' | 'agent' | 'system';
  messageText: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
  inReplyToMessageId: string | null;
  updateReceipts: DirectMessageUpdateReceipt[];
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
    content?: Record<string, unknown>;
  };
};

export type SetEntityLoopInput = {
  actorMemberId: string;
  accessibleClubIds: string[];
  entityId: string;
};

export type MemberAdmissionRecord = {
  admissionId: string;
  clubId: string;
  clubSlug: string;
  clubName: string;
  status: AdmissionStatus;
  applicationText: string | null;
  submittedAt: string | null;
  acceptedAt: string | null;
};

export type CreateVouchInput = {
  actorMemberId: string;
  clubId: string;
  targetMemberId: string;
  reason: string;
  clientKey?: string | null;
};

export type IssueAdmissionAccessInput = {
  actorMemberId: string;
  admissionId: string;
  accessibleClubIds: string[];
  label?: string | null;
};

export type IssueAdmissionAccessResult = {
  admission: AdmissionSummary;
  bearerToken: string;
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
  totalAdmissions: number;
  recentMembers: Array<{
    memberId: string;
    publicName: string;
    handle: string | null;
    createdAt: string;
  }>;
};

export type AdminMemberSummary = {
  memberId: string;
  publicName: string;
  handle: string | null;
  state: string;
  createdAt: string;
  membershipCount: number;
  tokenCount: number;
};

export type AdminMemberDetail = {
  memberId: string;
  publicName: string;
  handle: string | null;
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
  admissionCounts: Record<string, number>;
};

export type AdminContentSummary = {
  entityId: string;
  clubId: string;
  clubName: string;
  kind: EntityKind;
  author: {
    memberId: string;
    publicName: string;
    handle: string | null;
  };
  title: string | null;
  state: EntityState;
  createdAt: string;
};

export type AdminThreadSummary = {
  threadId: string;
  sharedClubs: SharedClubRef[];
  participants: Array<{
    memberId: string;
    publicName: string;
    handle: string | null;
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
  listClubs?(input: { actorMemberId: string; includeArchived: boolean }): Promise<ClubSummary[]>;
  createClub?(input: CreateClubInput): Promise<ClubSummary | null>;
  archiveClub?(input: ArchiveClubInput): Promise<ClubSummary | null>;
  assignClubOwner?(input: AssignClubOwnerInput): Promise<ClubSummary | null>;
  updateClub?(input: UpdateClubInput): Promise<ClubSummary | null>;
  listMemberships(input: {
    actorMemberId: string;
    clubIds: string[];
    limit: number;
    status?: MembershipState;
    cursor?: { stateCreatedAt: string; id: string } | null;
  }): Promise<Paginated<MembershipAdminSummary>>;
  listAdmissions?(input: {
    actorMemberId: string;
    clubIds: string[];
    limit: number;
    statuses?: AdmissionStatus[];
    cursor?: { versionCreatedAt: string; id: string } | null;
  }): Promise<Paginated<AdmissionSummary>>;
  getAdmissionsForMember(input: {
    memberId: string;
    clubId?: string;
  }): Promise<MemberAdmissionRecord[]>;
  transitionAdmission?(input: TransitionAdmissionInput): Promise<AdmissionSummary | null>;
  createAdmissionChallenge?(input: CreateAdmissionChallengeInput): Promise<AdmissionChallengeResult>;
  solveAdmissionChallenge?(input: SolveAdmissionChallengeInput): Promise<AdmissionApplyOutcome>;
  createCrossAdmissionChallenge?(input: CreateCrossAdmissionChallengeInput): Promise<AdmissionChallengeResult>;
  solveCrossAdmissionChallenge?(input: SolveCrossAdmissionChallengeInput): Promise<AdmissionApplyOutcome>;
  createMembership(input: CreateMembershipInput): Promise<MembershipAdminSummary | null>;
  transitionMembershipState(input: TransitionMembershipInput): Promise<MembershipAdminSummary | null>;
  listMembershipReviews(input: {
    actorMemberId: string;
    clubIds: string[];
    limit: number;
    statuses: MembershipState[];
    cursor?: { stateCreatedAt: string; id: string } | null;
  }): Promise<Paginated<MembershipReviewSummary>>;
  listMembers(input: {
    actorMemberId: string;
    clubId: string;
    limit: number;
    cursor?: { joinedAt: string; memberId: string } | null;
  }): Promise<Paginated<ClubMemberSummary>>;
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
  // Internal entity methods back the public `content.*` API. Events use the same
  // underlying entity/version tables but have separate event-specific methods below.
  createEntity(input: CreateEntityInput): Promise<EntitySummary>;
  updateEntity(input: UpdateEntityInput): Promise<EntitySummary | null>;
  closeEntityLoop(input: SetEntityLoopInput): Promise<EntitySummary | null>;
  reopenEntityLoop(input: SetEntityLoopInput): Promise<EntitySummary | null>;
  removeEntity?(input: RemoveEntityInput): Promise<EntitySummary | null>;
  listEntities(input: ListEntitiesInput & { rawCursor?: string | null }): Promise<Paginated<EntitySummary>>;
  createEvent(input: CreateEventInput): Promise<EventSummary>;
  listEvents(input: ListEventsInput & { cursor?: { effectiveAt: string; entityId: string } | null }): Promise<Paginated<EventSummary>>;
  rsvpEvent(input: RsvpEventInput): Promise<EventSummary | null>;
  removeEvent?(input: RemoveEntityInput): Promise<EventSummary | null>;
  listBearerTokens(input: { actorMemberId: string }): Promise<BearerTokenSummary[]>;
  createBearerToken(input: CreateBearerTokenInput): Promise<CreatedBearerToken>;
  revokeBearerToken(input: RevokeBearerTokenInput): Promise<BearerTokenSummary | null>;
  listMemberUpdates?(input: {
    actorMemberId: string;
    clubIds: string[];
    limit: number;
    after?: string | null;
  }): Promise<MemberUpdates>;
  getLatestCursor?(input: { actorMemberId: string; clubIds: string[] }): Promise<string | null>;
  acknowledgeUpdates?(input: AcknowledgeUpdatesInput): Promise<UpdateReceipt[]>;
  sendDirectMessage(input: SendDirectMessageInput): Promise<DirectMessageSummary | null>;
  listDirectMessageThreads(input: { actorMemberId: string; limit: number }): Promise<DirectMessageThreadSummary[]>;
  listDirectMessageInbox(input: {
    actorMemberId: string;
    limit: number;
    unreadOnly: boolean;
    cursor?: { latestActivityAt: string; threadId: string } | null;
  }): Promise<Paginated<DirectMessageInboxSummary>>;
  readDirectMessageThread(input: {
    actorMemberId: string;
    threadId: string;
    limit: number;
    cursor?: { createdAt: string; messageId: string } | null;
  }): Promise<{ thread: DirectMessageThreadSummary; messages: DirectMessageEntry[]; hasMore: boolean; nextCursor: string | null } | null>;

  createVouch(input: CreateVouchInput): Promise<MembershipVouchSummary | null>;
  listVouches(input: { actorMemberId: string; clubIds: string[]; targetMemberId: string; limit: number; cursor?: { createdAt: string; edgeId: string } | null }): Promise<Paginated<MembershipVouchSummary>>;
  promoteMemberToAdmin?(input: { actorMemberId: string; clubId: string; memberId: string }): Promise<{ membership: MembershipAdminSummary; changed: boolean } | null>;
  demoteMemberFromAdmin?(input: { actorMemberId: string; clubId: string; memberId: string }): Promise<{ membership: MembershipAdminSummary; changed: boolean } | null>;
  createAdmissionSponsorship(input: CreateAdmissionSponsorInput): Promise<AdmissionSummary>;
  issueAdmissionAccess?(input: IssueAdmissionAccessInput): Promise<IssueAdmissionAccessResult | null>;
  getQuotaStatus(input: { actorMemberId: string; clubIds: string[]; memberships?: Array<{ clubId: string; role: 'member' | 'clubadmin'; isOwner: boolean }> }): Promise<QuotaAllowance[]>;

  removeMessage?(input: RemoveMessageInput): Promise<MessageRemovalResult | null>;

  adminCreateMember?(input: { actorMemberId: string; publicName: string; handle?: string | null; email?: string | null }): Promise<{ memberId: string; publicName: string; handle: string; bearerToken: string }>;
  adminCreateMembership?(input: {
    actorMemberId: string;
    clubId: string;
    memberId: string;
    role: 'member' | 'clubadmin';
    sponsorMemberId?: string | null;
    initialStatus: Extract<MembershipState, 'invited' | 'pending_review' | 'active' | 'payment_pending'>;
    reason?: string | null;
    initialProfile: {
      fields: ClubProfileFields;
      generationSource: 'membership_seed' | 'admission_generated';
    };
  }): Promise<MembershipAdminSummary | null>;
  adminGetOverview?(input: { actorMemberId: string }): Promise<AdminOverview>;
  adminListMembers?(input: { actorMemberId: string; limit: number; cursor?: { createdAt: string; id: string } | null }): Promise<Paginated<AdminMemberSummary>>;
  adminGetMember?(input: { actorMemberId: string; memberId: string }): Promise<AdminMemberDetail | null>;
  adminGetClubStats?(input: { actorMemberId: string; clubId: string }): Promise<AdminClubStats | null>;
  adminListContent?(input: { actorMemberId: string; clubId?: string; kind?: EntityKind; limit: number; cursor?: { createdAt: string; id: string } | null }): Promise<Paginated<AdminContentSummary>>;
  adminListThreads?(input: { actorMemberId: string; limit: number; cursor?: { createdAt: string; id: string } | null }): Promise<Paginated<AdminThreadSummary>>;
  adminReadThread?(input: { actorMemberId: string; threadId: string; limit: number }): Promise<{ thread: AdminThreadSummary; messages: DirectMessageEntry[] } | null>;
  adminListMemberTokens?(input: { actorMemberId: string; memberId: string }): Promise<BearerTokenSummary[]>;
  adminRevokeMemberToken?(input: { actorMemberId: string; memberId: string; tokenId: string }): Promise<BearerTokenSummary | null>;
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
  }): Promise<Paginated<EntitySummary>>;
};

export type LogLlmUsageInput = {
  memberId: string | null;
  requestedClubId: string | null;
  actionName: string;
  gateName?: string;
  provider: string;
  model: string;
  gateStatus: 'passed' | 'rejected' | 'rejected_illegal' | 'skipped';
  skipReason: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  providerErrorCode: string | null;
};

export type ResponseNotice = {
  code: string;
  message: string;
};
