export type MembershipState = 'invited' | 'pending_review' | 'active' | 'paused' | 'revoked' | 'rejected';

export type MembershipSummary = {
  membershipId: string;
  clubId: string;
  slug: string;
  name: string;
  summary: string | null;
  role: 'owner' | 'admin' | 'member';
  status: 'active';
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
  role: 'owner' | 'admin' | 'member';
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
  role: 'admin' | 'member';
  initialStatus: Extract<MembershipState, 'invited' | 'pending_review' | 'active'>;
  reason?: string | null;
  metadata: Record<string, unknown>;
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

export type SolveAdmissionChallengeInput = {
  challengeId: string;
  nonce: string;
  clubSlug: string;
  name: string;
  email: string;
  socials: string;
  reason: string;
};

export type AdmissionChallengeResult = {
  challengeId: string;
  difficulty: number;
  expiresAt: string;
  clubs: Array<{ slug: string; name: string; summary: string | null; ownerName: string; ownerEmail: string | null }>;
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
};

export type ClubSummary = {
  clubId: string;
  slug: string;
  name: string;
  summary: string | null;
  archivedAt: string | null;
  owner: {
    memberId: string;
    publicName: string;
    handle: string | null;
    email: string | null;
  };
  ownerVersion: {
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
  recipientMemberId: string;
  clubId: string;
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
  nextAfter: number | null;
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
  clubId: string;
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
  sharedClubs: Array<{ id: string; slug: string; name: string }>;
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

export type EmbeddingProjectionSummary = {
  embeddingId: string;
  model: string;
  dimensions: number;
  sourceText: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type EmbeddingProjectionRow = {
  embedding_id: string | null;
  embedding_model: string | null;
  embedding_dimensions: number | null;
  embedding_source_text: string | null;
  embedding_metadata: Record<string, unknown> | null;
  embedding_created_at: string | null;
};

export type MemberProfile = {
  memberId: string;
  publicName: string;
  handle: string | null;
  displayName: string;
  tagline: string | null;
  summary: string | null;
  whatIDo: string | null;
  knownFor: string | null;
  servicesSummary: string | null;
  websiteUrl: string | null;
  links: unknown[];
  profile: Record<string, unknown>;
  version: {
    id: string | null;
    versionNo: number | null;
    createdAt: string | null;
    createdByMemberId: string | null;
    embedding: EmbeddingProjectionSummary | null;
  };
  sharedClubs: Array<{ id: string; slug: string; name: string }>;
};

export type UpdateOwnProfileInput = {
  handle?: string | null;
  displayName?: string;
  tagline?: string | null;
  summary?: string | null;
  whatIDo?: string | null;
  knownFor?: string | null;
  servicesSummary?: string | null;
  websiteUrl?: string | null;
  links?: unknown;
  profile?: unknown;
};

export type EntityKind = 'post' | 'opportunity' | 'service' | 'ask';
export type EntityState = 'draft' | 'published' | 'archived';

export type EntitySummary = {
  entityId: string;
  entityVersionId: string;
  clubId: string;
  kind: EntityKind;
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
    embedding: EmbeddingProjectionSummary | null;
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
};

export type ArchiveEntityInput = {
  actorMemberId: string;
  accessibleClubIds: string[];
  entityId: string;
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
    state: 'published';
    title: string | null;
    summary: string | null;
    body: string | null;
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
  title: string | null;
  summary: string | null;
  body: string | null;
  startsAt: string | null;
  endsAt: string | null;
  timezone: string | null;
  recurrenceRule: string | null;
  capacity: number | null;
  expiresAt: string | null;
  content: Record<string, unknown>;
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
  clubId: string;
  senderMemberId: string;
  recipientMemberId: string;
  messageId: string;
  messageText: string;
  createdAt: string;
  updateCount: number;
};

export type DirectMessageThreadSummary = {
  threadId: string;
  clubId: string;
  counterpartMemberId: string;
  counterpartPublicName: string;
  counterpartHandle: string | null;
  latestMessage: {
    messageId: string;
    senderMemberId: string;
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
  clubId?: string;
  messageText: string;
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

export type CreateVouchInput = {
  actorMemberId: string;
  clubId: string;
  targetMemberId: string;
  reason: string;
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

export type RedactionResult = {
  redactionId: string;
  targetKind: 'dm_message' | 'entity';
  targetId: string;
  clubId: string;
  createdByMemberId: string;
  createdAt: string;
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
  profile: MemberProfile | null;
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
  clubId: string;
  clubName: string;
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
  listClubs?(input: { actorMemberId: string; includeArchived: boolean }): Promise<ClubSummary[]>;
  createClub?(input: CreateClubInput): Promise<ClubSummary | null>;
  archiveClub?(input: ArchiveClubInput): Promise<ClubSummary | null>;
  assignClubOwner?(input: AssignClubOwnerInput): Promise<ClubSummary | null>;
  listMemberships(input: {
    actorMemberId: string;
    clubIds: string[];
    limit: number;
    status?: MembershipState;
  }): Promise<MembershipAdminSummary[]>;
  listAdmissions?(input: {
    actorMemberId: string;
    clubIds: string[];
    limit: number;
    statuses?: AdmissionStatus[];
  }): Promise<AdmissionSummary[]>;
  transitionAdmission?(input: TransitionAdmissionInput): Promise<AdmissionSummary | null>;
  createAdmissionChallenge?(): Promise<AdmissionChallengeResult>;
  solveAdmissionChallenge?(input: SolveAdmissionChallengeInput): Promise<{ success: boolean } | null>;
  createMembership(input: CreateMembershipInput): Promise<MembershipAdminSummary | null>;
  transitionMembershipState(input: TransitionMembershipInput): Promise<MembershipAdminSummary | null>;
  listMembershipReviews(input: {
    actorMemberId: string;
    clubIds: string[];
    limit: number;
    statuses: MembershipState[];
  }): Promise<MembershipReviewSummary[]>;
  searchMembers(input: {
    actorMemberId: string;
    clubIds: string[];
    query: string;
    limit: number;
  }): Promise<MemberSearchResult[]>;
  listMembers(input: {
    actorMemberId: string;
    clubIds: string[];
    limit: number;
  }): Promise<ClubMemberSummary[]>;
  getMemberProfile(input: { actorMemberId: string; targetMemberId: string }): Promise<MemberProfile | null>;
  updateOwnProfile(input: { actor: ActorContext; patch: UpdateOwnProfileInput }): Promise<MemberProfile>;
  createEntity(input: CreateEntityInput): Promise<EntitySummary>;
  updateEntity(input: UpdateEntityInput): Promise<EntitySummary | null>;
  archiveEntity?(input: ArchiveEntityInput): Promise<EntitySummary | null>;
  listEntities(input: ListEntitiesInput): Promise<EntitySummary[]>;
  createEvent(input: CreateEventInput): Promise<EventSummary>;
  listEvents(input: ListEventsInput): Promise<EventSummary[]>;
  rsvpEvent(input: RsvpEventInput): Promise<EventSummary | null>;
  listBearerTokens(input: { actorMemberId: string }): Promise<BearerTokenSummary[]>;
  createBearerToken(input: CreateBearerTokenInput): Promise<CreatedBearerToken>;
  revokeBearerToken(input: RevokeBearerTokenInput): Promise<BearerTokenSummary | null>;
  listMemberUpdates?(input: {
    actorMemberId: string;
    limit: number;
    after?: number | null;
  }): Promise<MemberUpdates>;
  getLatestStreamSeq?(input: { actorMemberId: string }): Promise<number | null>;
  acknowledgeUpdates?(input: AcknowledgeUpdatesInput): Promise<UpdateReceipt[]>;
  sendDirectMessage(input: SendDirectMessageInput): Promise<DirectMessageSummary | null>;
  listDirectMessageThreads(input: { actorMemberId: string; clubIds: string[]; limit: number }): Promise<DirectMessageThreadSummary[]>;
  listDirectMessageInbox(input: {
    actorMemberId: string;
    clubIds: string[];
    limit: number;
    unreadOnly: boolean;
  }): Promise<DirectMessageInboxSummary[]>;
  readDirectMessageThread(input: {
    actorMemberId: string;
    accessibleClubIds: string[];
    threadId: string;
    limit: number;
  }): Promise<{ thread: DirectMessageThreadSummary; messages: DirectMessageEntry[] } | null>;

  createVouch(input: CreateVouchInput): Promise<MembershipVouchSummary | null>;
  listVouches(input: { actorMemberId: string; clubIds: string[]; targetMemberId: string; limit: number }): Promise<MembershipVouchSummary[]>;
  createAdmissionSponsorship(input: CreateAdmissionSponsorInput): Promise<AdmissionSummary>;
  issueAdmissionAccess?(input: IssueAdmissionAccessInput): Promise<IssueAdmissionAccessResult | null>;
  getQuotaStatus(input: { actorMemberId: string; clubIds: string[] }): Promise<QuotaAllowance[]>;

  redactMessage?(input: { actorMemberId: string; accessibleClubIds: string[]; messageId: string; reason?: string | null; skipNotification?: boolean }): Promise<{ redaction: RedactionResult; senderMemberId: string | null } | null>;
  redactEntity?(input: { actorMemberId: string; accessibleClubIds: string[]; entityId: string; reason?: string | null; skipNotification?: boolean }): Promise<{ redaction: RedactionResult; authorMemberId: string } | null>;

  adminGetOverview?(input: { actorMemberId: string }): Promise<AdminOverview>;
  adminListMembers?(input: { actorMemberId: string; limit: number; offset: number }): Promise<AdminMemberSummary[]>;
  adminGetMember?(input: { actorMemberId: string; memberId: string }): Promise<AdminMemberDetail | null>;
  adminGetClubStats?(input: { actorMemberId: string; clubId: string }): Promise<AdminClubStats | null>;
  adminListContent?(input: { actorMemberId: string; clubId?: string; kind?: EntityKind; limit: number; offset: number }): Promise<AdminContentSummary[]>;
  adminArchiveEntity?(input: { actorMemberId: string; entityId: string }): Promise<{ entityId: string } | null>;
  adminListThreads?(input: { actorMemberId: string; clubId?: string; limit: number; offset: number }): Promise<AdminThreadSummary[]>;
  adminReadThread?(input: { actorMemberId: string; threadId: string; limit: number }): Promise<{ thread: AdminThreadSummary; messages: DirectMessageEntry[] } | null>;
  adminListMemberTokens?(input: { actorMemberId: string; memberId: string }): Promise<BearerTokenSummary[]>;
  adminRevokeMemberToken?(input: { actorMemberId: string; memberId: string; tokenId: string }): Promise<BearerTokenSummary | null>;
  adminGetDiagnostics?(input: { actorMemberId: string }): Promise<AdminDiagnostics>;
};
