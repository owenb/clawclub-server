export type MembershipState = 'invited' | 'pending_review' | 'active' | 'paused' | 'revoked' | 'rejected';

export type MembershipSummary = {
  membershipId: string;
  networkId: string;
  slug: string;
  name: string;
  summary: string | null;
  manifestoMarkdown: string | null;
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
  networkId: string;
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
  networkId: string;
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

export type ApplicationStatus =
  | 'draft'
  | 'submitted'
  | 'interview_scheduled'
  | 'interview_completed'
  | 'accepted'
  | 'declined'
  | 'withdrawn';

export type ApplicationSummary = {
  applicationId: string;
  networkId: string;
  applicant: {
    memberId: string;
    publicName: string;
    handle: string | null;
  };
  sponsor: {
    memberId: string;
    publicName: string;
    handle: string | null;
  } | null;
  membershipId: string | null;
  activation: {
    linkedMembershipId: string | null;
    membershipStatus: MembershipState | null;
    acceptedCovenantAt: string | null;
    readyForActivation: boolean;
  };
  path: 'sponsored' | 'outside';
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
    status: ApplicationStatus;
    notes: string | null;
    versionNo: number;
    createdAt: string;
    createdByMemberId: string | null;
  };
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type CreateApplicationInput = {
  actorMemberId: string;
  networkId: string;
  applicantMemberId: string;
  sponsorMemberId?: string | null;
  membershipId?: string | null;
  path: 'sponsored' | 'outside';
  initialStatus: Extract<ApplicationStatus, 'draft' | 'submitted' | 'interview_scheduled'>;
  notes?: string | null;
  intake: {
    kind?: 'fit_check' | 'advice_call' | 'other';
    price?: {
      amount?: number | null;
      currency?: string | null;
    };
    bookingUrl?: string | null;
    bookedAt?: string | null;
    completedAt?: string | null;
  };
  metadata: Record<string, unknown>;
};

export type TransitionApplicationInput = {
  actorMemberId: string;
  applicationId: string;
  nextStatus: ApplicationStatus;
  notes?: string | null;
  accessibleNetworkIds: string[];
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
  membershipId?: string | null;
  activateMembership?: boolean;
  activationReason?: string | null;
  metadataPatch?: Record<string, unknown>;
};

export type TransitionMembershipInput = {
  actorMemberId: string;
  membershipId: string;
  nextStatus: MembershipState;
  reason?: string | null;
  accessibleNetworkIds: string[];
};

export type NetworkSummary = {
  networkId: string;
  slug: string;
  name: string;
  summary: string | null;
  manifestoMarkdown: string | null;
  archivedAt: string | null;
  owner: {
    memberId: string;
    publicName: string;
    handle: string | null;
  };
  ownerVersion: {
    versionNo: number;
    createdAt: string;
    createdByMemberId: string | null;
  };
};

export type CreateNetworkInput = {
  actorMemberId: string;
  slug: string;
  name: string;
  summary?: string | null;
  manifestoMarkdown?: string | null;
  ownerMemberId: string;
};

export type ArchiveNetworkInput = {
  actorMemberId: string;
  networkId: string;
};

export type AssignNetworkOwnerInput = {
  actorMemberId: string;
  networkId: string;
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
  requestedNetworkId: string | null;
  activeNetworkIds: string[];
};

export type PendingUpdate = {
  updateId: string;
  streamSeq: number;
  recipientMemberId: string;
  networkId: string;
  entityId: string | null;
  entityVersionId: string | null;
  transcriptMessageId: string | null;
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
  networkId: string;
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
  sharedNetworks: Array<{ id: string; slug: string; name: string }>;
};

export type NetworkMemberSummary = {
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
  sharedNetworks: Array<{ id: string; slug: string; name: string }>;
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
  networkId: string;
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
  networkId: string;
  kind: EntityKind;
  title: string | null;
  summary: string | null;
  body: string | null;
  expiresAt: string | null;
  content: Record<string, unknown>;
};

export type ArchiveEntityInput = {
  actorMemberId: string;
  accessibleNetworkIds: string[];
  entityId: string;
};

export type EventRsvpState = 'yes' | 'maybe' | 'no' | 'waitlist';

export type EventSummary = {
  entityId: string;
  entityVersionId: string;
  networkId: string;
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
  networkId: string;
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
  networkIds: string[];
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
    networkId: string;
  }>;
};

export type ListEntitiesInput = {
  actorMemberId: string;
  networkIds: string[];
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
  metadata: Record<string, unknown>;
};

export type CreateBearerTokenInput = {
  actorMemberId: string;
  label?: string | null;
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
  networkId: string;
  senderMemberId: string;
  recipientMemberId: string;
  messageId: string;
  messageText: string;
  createdAt: string;
  updateCount: number;
};

export type DirectMessageThreadSummary = {
  threadId: string;
  networkId: string;
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

export type DirectMessageTranscriptEntry = {
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
  accessibleNetworkIds: string[];
  recipientMemberId: string;
  networkId?: string;
  messageText: string;
};

export type UpdateEntityInput = {
  actorMemberId: string;
  accessibleNetworkIds: string[];
  entityId: string;
  patch: {
    title?: string | null;
    summary?: string | null;
    body?: string | null;
    expiresAt?: string | null;
    content?: Record<string, unknown>;
  };
};

export type Repository = {
  authenticateBearerToken(bearerToken: string): Promise<AuthResult | null>;
  listNetworks?(input: { actorMemberId: string; includeArchived: boolean }): Promise<NetworkSummary[]>;
  createNetwork?(input: CreateNetworkInput): Promise<NetworkSummary | null>;
  archiveNetwork?(input: ArchiveNetworkInput): Promise<NetworkSummary | null>;
  assignNetworkOwner?(input: AssignNetworkOwnerInput): Promise<NetworkSummary | null>;
  listMemberships(input: {
    actorMemberId: string;
    networkIds: string[];
    limit: number;
    status?: MembershipState;
  }): Promise<MembershipAdminSummary[]>;
  listApplications?(input: {
    actorMemberId: string;
    networkIds: string[];
    limit: number;
    statuses?: ApplicationStatus[];
  }): Promise<ApplicationSummary[]>;
  createApplication?(input: CreateApplicationInput): Promise<ApplicationSummary | null>;
  transitionApplication?(input: TransitionApplicationInput): Promise<ApplicationSummary | null>;
  createMembership(input: CreateMembershipInput): Promise<MembershipAdminSummary | null>;
  transitionMembershipState(input: TransitionMembershipInput): Promise<MembershipAdminSummary | null>;
  listMembershipReviews(input: {
    actorMemberId: string;
    networkIds: string[];
    limit: number;
    statuses: MembershipState[];
  }): Promise<MembershipReviewSummary[]>;
  searchMembers(input: {
    actorMemberId: string;
    networkIds: string[];
    query: string;
    limit: number;
  }): Promise<MemberSearchResult[]>;
  listMembers(input: {
    actorMemberId: string;
    networkIds: string[];
    limit: number;
  }): Promise<NetworkMemberSummary[]>;
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
  acknowledgeUpdates?(input: AcknowledgeUpdatesInput): Promise<UpdateReceipt[]>;
  sendDirectMessage(input: SendDirectMessageInput): Promise<DirectMessageSummary | null>;
  listDirectMessageThreads(input: { actorMemberId: string; networkIds: string[]; limit: number }): Promise<DirectMessageThreadSummary[]>;
  listDirectMessageInbox(input: {
    actorMemberId: string;
    networkIds: string[];
    limit: number;
    unreadOnly: boolean;
  }): Promise<DirectMessageInboxSummary[]>;
  readDirectMessageThread(input: {
    actorMemberId: string;
    accessibleNetworkIds: string[];
    threadId: string;
    limit: number;
  }): Promise<{ thread: DirectMessageThreadSummary; messages: DirectMessageTranscriptEntry[] } | null>;
};
