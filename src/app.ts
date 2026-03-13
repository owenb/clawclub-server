import { signClawClubDelivery } from './delivery-signing.ts';

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

export type PendingDelivery = {
  deliveryId: string;
  networkId: string;
  entityId: string | null;
  entityVersionId: string | null;
  transcriptMessageId: string | null;
  topic: string;
  payload: Record<string, unknown>;
  createdAt: string;
  sentAt: string | null;
};

export type SharedResponseContext = {
  pendingDeliveries: PendingDelivery[];
};

export type AuthResult = {
  actor: ActorContext;
  requestScope: RequestScope;
  sharedContext: SharedResponseContext;
};

export type DeliveryWorkerAuthResult = {
  tokenId: string;
  label: string | null;
  actorMemberId: string;
  allowedNetworkIds: string[];
  metadata: Record<string, unknown>;
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
    state: 'published';
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
  networkIds: string[];
  kinds: EntityKind[];
  limit: number;
  query?: string;
};

export type DeliveryAckState = 'shown' | 'suppressed';

export type DeliveryEndpointChannel = 'openclaw_webhook';
export type DeliveryEndpointState = 'active' | 'disabled' | 'failing';

export type DeliveryEndpointSummary = {
  endpointId: string;
  memberId: string;
  channel: DeliveryEndpointChannel;
  label: string | null;
  endpointUrl: string;
  sharedSecretRef: string | null;
  state: DeliveryEndpointState;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  health: {
    pendingCount: number;
    processingCount: number;
    sentCount: number;
    failedCount: number;
    canceledCount: number;
    lastDeliveryAt: string | null;
  };
  metadata: Record<string, unknown>;
  createdAt: string;
  disabledAt: string | null;
};

export type CreateDeliveryEndpointInput = {
  actorMemberId: string;
  channel?: DeliveryEndpointChannel;
  label?: string | null;
  endpointUrl: string;
  sharedSecretRef?: string | null;
  metadata?: Record<string, unknown>;
};

export type UpdateDeliveryEndpointInput = {
  actorMemberId: string;
  endpointId: string;
  patch: {
    label?: string | null;
    endpointUrl?: string;
    sharedSecretRef?: string | null;
    state?: DeliveryEndpointState;
    metadata?: Record<string, unknown>;
  };
};

export type RevokeDeliveryEndpointInput = {
  actorMemberId: string;
  endpointId: string;
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

export type AcknowledgeDeliveryInput = {
  actorMemberId: string;
  accessibleNetworkIds: string[];
  deliveryId: string;
  state: DeliveryAckState;
  suppressionReason?: string | null;
};

export type DeliveryAcknowledgement = {
  acknowledgementId: string;
  deliveryId: string;
  networkId: string;
  recipientMemberId: string;
  state: DeliveryAckState;
  suppressionReason: string | null;
  versionNo: number;
  supersedesAcknowledgementId: string | null;
  createdAt: string;
  createdByMemberId: string | null;
};

export type DeliverySummary = {
  deliveryId: string;
  networkId: string;
  recipientMemberId: string;
  endpointId: string;
  topic: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'processing' | 'sent' | 'failed' | 'canceled';
  attemptCount: number;
  entityId: string | null;
  entityVersionId: string | null;
  transcriptMessageId: string | null;
  scheduledAt: string;
  sentAt: string | null;
  failedAt: string | null;
  lastError: string | null;
  createdAt: string;
  acknowledgement: {
    acknowledgementId: string;
    state: DeliveryAckState;
    suppressionReason: string | null;
    versionNo: number;
    createdAt: string;
    createdByMemberId: string | null;
  } | null;
};

export type ListDeliveriesInput = {
  actorMemberId: string;
  networkIds: string[];
  limit: number;
  pendingOnly: boolean;
};

export type ListDeliveryAttemptsInput = {
  actorMemberId: string;
  networkIds: string[];
  limit: number;
  endpointId?: string;
  recipientMemberId?: string;
  status?: DeliveryAttemptSummary['status'];
};

export type DeliveryAttemptInspection = {
  attempt: DeliveryAttemptSummary;
  delivery: Pick<DeliverySummary, 'networkId' | 'recipientMemberId' | 'endpointId' | 'topic' | 'status' | 'attemptCount' | 'scheduledAt' | 'sentAt' | 'failedAt' | 'lastError' | 'createdAt'> & {
    deliveryId: string;
    recipient: {
      memberId: string;
      publicName: string;
      handle: string | null;
    };
  };
};

export type RetryDeliveryInput = {
  actorMemberId: string;
  accessibleNetworkIds: string[];
  deliveryId: string;
};

export type ClaimDeliveryInput = {
  actorMemberId: string;
  accessibleNetworkIds: string[];
  workerKey?: string | null;
};

export type CompleteDeliveryAttemptInput = {
  actorMemberId: string;
  accessibleNetworkIds: string[];
  deliveryId: string;
  responseStatusCode?: number | null;
  responseBody?: string | null;
};

export type FailDeliveryAttemptInput = {
  actorMemberId: string;
  accessibleNetworkIds: string[];
  deliveryId: string;
  errorMessage: string;
  responseStatusCode?: number | null;
  responseBody?: string | null;
};

export type DeliveryAttemptSummary = {
  attemptId: string;
  deliveryId: string;
  networkId: string | null;
  endpointId: string;
  workerKey: string | null;
  status: 'processing' | 'sent' | 'failed' | 'canceled';
  attemptNo: number;
  responseStatusCode: number | null;
  responseBody: string | null;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
  createdByMemberId: string | null;
};

export type ClaimedDelivery = {
  delivery: DeliverySummary;
  attempt: DeliveryAttemptSummary;
  endpoint: DeliveryEndpointSummary;
};

export type DeliveryExecutionResult = {
  outcome: 'idle' | 'sent' | 'failed';
  claimed: ClaimedDelivery | null;
};

const DELIVERY_WORKER_ACTIONS = new Set(['deliveries.claim', 'deliveries.execute', 'deliveries.complete', 'deliveries.fail']);

export type DeliverySecretResolver = (input: {
  sharedSecretRef: string;
  endpoint: DeliveryEndpointSummary;
  delivery: DeliverySummary;
  attempt: DeliveryAttemptSummary;
}) => Promise<string | null> | string | null;

export type DirectMessageSummary = {
  threadId: string;
  networkId: string;
  senderMemberId: string;
  recipientMemberId: string;
  messageId: string;
  messageText: string;
  createdAt: string;
  deliveryCount: number;
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
    unreadDeliveryCount: number;
    latestUnreadMessageCreatedAt: string | null;
  };
};

export type DirectMessageReceipt = {
  deliveryId: string;
  recipientMemberId: string;
  status: 'pending' | 'processing' | 'sent' | 'failed' | 'canceled';
  scheduledAt: string;
  sentAt: string | null;
  failedAt: string | null;
  createdAt: string;
  acknowledgement: {
    acknowledgementId: string;
    state: DeliveryAckState;
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
  deliveryReceipts: DirectMessageReceipt[];
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
  authenticateDeliveryWorkerToken?(bearerToken: string): Promise<DeliveryWorkerAuthResult | null>;
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
  listDeliveryEndpoints(input: { actorMemberId: string }): Promise<DeliveryEndpointSummary[]>;
  createDeliveryEndpoint(input: CreateDeliveryEndpointInput): Promise<DeliveryEndpointSummary>;
  updateDeliveryEndpoint(input: UpdateDeliveryEndpointInput): Promise<DeliveryEndpointSummary | null>;
  revokeDeliveryEndpoint(input: RevokeDeliveryEndpointInput): Promise<DeliveryEndpointSummary | null>;
  searchMembers(input: {
    networkIds: string[];
    query: string;
    limit: number;
  }): Promise<MemberSearchResult[]>;
  listMembers(input: {
    networkIds: string[];
    limit: number;
  }): Promise<NetworkMemberSummary[]>;
  getMemberProfile(input: { actorMemberId: string; targetMemberId: string }): Promise<MemberProfile | null>;
  updateOwnProfile(input: { actor: ActorContext; patch: UpdateOwnProfileInput }): Promise<MemberProfile>;
  createEntity(input: CreateEntityInput): Promise<EntitySummary>;
  updateEntity(input: UpdateEntityInput): Promise<EntitySummary | null>;
  listEntities(input: ListEntitiesInput): Promise<EntitySummary[]>;
  createEvent(input: CreateEventInput): Promise<EventSummary>;
  listEvents(input: ListEventsInput): Promise<EventSummary[]>;
  rsvpEvent(input: RsvpEventInput): Promise<EventSummary | null>;
  listBearerTokens(input: { actorMemberId: string }): Promise<BearerTokenSummary[]>;
  createBearerToken(input: CreateBearerTokenInput): Promise<CreatedBearerToken>;
  revokeBearerToken(input: RevokeBearerTokenInput): Promise<BearerTokenSummary | null>;
  acknowledgeDelivery(input: AcknowledgeDeliveryInput): Promise<DeliveryAcknowledgement | null>;
  listDeliveries(input: ListDeliveriesInput): Promise<DeliverySummary[]>;
  listDeliveryAttempts(input: ListDeliveryAttemptsInput): Promise<DeliveryAttemptInspection[]>;
  retryDelivery(input: RetryDeliveryInput): Promise<DeliverySummary | null>;
  claimNextDelivery(input: ClaimDeliveryInput): Promise<ClaimedDelivery | null>;
  completeDeliveryAttempt(input: CompleteDeliveryAttemptInput): Promise<ClaimedDelivery | null>;
  failDeliveryAttempt(input: FailDeliveryAttemptInput): Promise<ClaimedDelivery | null>;
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

export class AppError extends Error {
  statusCode: number;
  code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AppError(400, 'invalid_input', `${field} must be a non-empty string`);
  }

  return value.trim();
}

function normalizeLimit(value: unknown): number {
  if (value === undefined) {
    return 8;
  }

  if (!Number.isInteger(value)) {
    throw new AppError(400, 'invalid_input', 'limit must be an integer');
  }

  return Math.min(Math.max(Number(value), 1), 20);
}

function requireInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value)) {
    throw new AppError(400, 'invalid_input', `${field} must be an integer`);
  }

  return Number(value);
}

function normalizeOptionalString(value: unknown, field: string): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new AppError(400, 'invalid_input', `${field} must be a string or null`);
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function normalizeHandle(value: unknown): string | null | undefined {
  const normalized = normalizeOptionalString(value, 'handle');

  if (normalized === undefined || normalized === null) {
    return normalized;
  }

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized)) {
    throw new AppError(400, 'invalid_input', 'handle must use lowercase letters, numbers, and single hyphens');
  }

  return normalized;
}

function normalizeOptionalStringArray(value: unknown, field: string): unknown[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new AppError(400, 'invalid_input', `${field} must be an array`);
  }

  return value;
}

function normalizeOptionalRecord(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new AppError(400, 'invalid_input', `${field} must be an object`);
  }

  return value as Record<string, unknown>;
}

function normalizeProfilePatch(payload: Record<string, unknown>): UpdateOwnProfileInput {
  return {
    handle: normalizeHandle(payload.handle),
    displayName: payload.displayName === undefined ? undefined : requireNonEmptyString(payload.displayName, 'displayName'),
    tagline: normalizeOptionalString(payload.tagline, 'tagline'),
    summary: normalizeOptionalString(payload.summary, 'summary'),
    whatIDo: normalizeOptionalString(payload.whatIDo, 'whatIDo'),
    knownFor: normalizeOptionalString(payload.knownFor, 'knownFor'),
    servicesSummary: normalizeOptionalString(payload.servicesSummary, 'servicesSummary'),
    websiteUrl: normalizeOptionalString(payload.websiteUrl, 'websiteUrl'),
    links: normalizeOptionalStringArray(payload.links, 'links'),
    profile: normalizeOptionalRecord(payload.profile, 'profile'),
  };
}

function requireAccessibleNetwork(actor: ActorContext, networkIdValue: unknown): MembershipSummary {
  const networkId = requireNonEmptyString(networkIdValue, 'networkId');
  const allowed = actor.memberships.find((network) => network.networkId === networkId);

  if (!allowed) {
    throw new AppError(403, 'forbidden', 'Requested network is outside the actor scope');
  }

  return allowed;
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new AppError(400, 'invalid_input', `${field} must be a JSON object`);
  }

  return value as Record<string, unknown>;
}

function isEntityKind(value: unknown): value is EntityKind {
  return value === 'post' || value === 'opportunity' || value === 'service' || value === 'ask';
}

function requireEntityKind(value: unknown, field: string): EntityKind {
  if (!isEntityKind(value)) {
    throw new AppError(400, 'invalid_input', `${field} must be one of: post, opportunity, service, ask`);
  }

  return value;
}

function normalizeEntityKinds(value: unknown): EntityKind[] {
  if (value === undefined) {
    return ['post', 'opportunity', 'service', 'ask'];
  }

  if (!Array.isArray(value) || value.length === 0) {
    throw new AppError(400, 'invalid_input', 'kinds must be a non-empty array when provided');
  }

  const kinds = value.map((item) => requireEntityKind(item, 'kinds[]'));
  return [...new Set(kinds)];
}

function isMembershipState(value: unknown): value is MembershipState {
  return value === 'invited' || value === 'pending_review' || value === 'active' || value === 'paused' || value === 'revoked' || value === 'rejected';
}

function requireMembershipState(value: unknown, field: string): MembershipState {
  if (!isMembershipState(value)) {
    throw new AppError(400, 'invalid_input', `${field} must be one of: invited, pending_review, active, paused, revoked, rejected`);
  }

  return value;
}

function isApplicationStatus(value: unknown): value is ApplicationStatus {
  return value === 'draft'
    || value === 'submitted'
    || value === 'interview_scheduled'
    || value === 'interview_completed'
    || value === 'accepted'
    || value === 'declined'
    || value === 'withdrawn';
}

function requireApplicationStatus(value: unknown, field: string): ApplicationStatus {
  if (!isApplicationStatus(value)) {
    throw new AppError(400, 'invalid_input', `${field} must be one of: draft, submitted, interview_scheduled, interview_completed, accepted, declined, withdrawn`);
  }

  return value;
}

function requireMembershipOwner(actor: ActorContext, networkIdValue: unknown): MembershipSummary {
  const membership = requireAccessibleNetwork(actor, networkIdValue);

  if (membership.role !== 'owner') {
    throw new AppError(403, 'forbidden', 'This action requires owner membership in the requested network');
  }

  return membership;
}

function requireSuperadmin(actor: ActorContext): void {
  if (!actor.globalRoles.includes('superadmin')) {
    throw new AppError(403, 'forbidden', 'This action requires superadmin role');
  }
}

function normalizeEntityPatch(payload: Record<string, unknown>): UpdateEntityInput['patch'] {
  const patch = {
    title: normalizeOptionalString(payload.title, 'title'),
    summary: normalizeOptionalString(payload.summary, 'summary'),
    body: normalizeOptionalString(payload.body, 'body'),
    expiresAt: normalizeOptionalString(payload.expiresAt, 'expiresAt'),
    content: payload.content === undefined ? undefined : requireObject(payload.content, 'content'),
  };

  if (Object.values(patch).every((value) => value === undefined)) {
    throw new AppError(400, 'invalid_input', 'entities.update requires at least one field to change');
  }

  return patch;
}

function isDeliveryAttemptStatus(value: unknown): value is DeliveryAttemptSummary['status'] {
  return value === 'processing' || value === 'sent' || value === 'failed' || value === 'canceled';
}

function normalizeOptionalDeliveryAttemptStatus(value: unknown): DeliveryAttemptSummary['status'] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isDeliveryAttemptStatus(value)) {
    throw new AppError(400, 'invalid_input', 'status must be one of: processing, sent, failed, canceled');
  }

  return value;
}

function normalizeOptionalInteger(value: unknown, field: string): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (!Number.isInteger(value)) {
    throw new AppError(400, 'invalid_input', `${field} must be an integer or null`);
  }

  const number = Number(value);
  if (number <= 0) {
    throw new AppError(400, 'invalid_input', `${field} must be greater than zero when provided`);
  }

  return number;
}

function isEventRsvpState(value: unknown): value is EventRsvpState {
  return value === 'yes' || value === 'maybe' || value === 'no' || value === 'waitlist';
}

function requireEventRsvpState(value: unknown, field: string): EventRsvpState {
  if (!isEventRsvpState(value)) {
    throw new AppError(400, 'invalid_input', `${field} must be one of: yes, maybe, no, waitlist`);
  }

  return value;
}

function normalizeTokenCreateInput(payload: Record<string, unknown>): { label: string | null; metadata: Record<string, unknown> } {
  return {
    label: normalizeOptionalString(payload.label, 'label') ?? null,
    metadata: payload.metadata === undefined ? {} : requireObject(payload.metadata, 'metadata'),
  };
}

function requireApplicationPath(value: unknown, field: string): 'sponsored' | 'outside' {
  if (value !== 'sponsored' && value !== 'outside') {
    throw new AppError(400, 'invalid_input', `${field} must be one of: sponsored, outside`);
  }

  return value;
}

function requireApplicationIntakeKind(value: unknown, field: string): 'fit_check' | 'advice_call' | 'other' {
  if (value !== 'fit_check' && value !== 'advice_call' && value !== 'other') {
    throw new AppError(400, 'invalid_input', `${field} must be one of: fit_check, advice_call, other`);
  }

  return value;
}

function normalizeOptionalCurrencyCode(value: unknown, field: string): string | null | undefined {
  const normalized = normalizeOptionalString(value, field);
  if (normalized === undefined || normalized === null) {
    return normalized;
  }

  const upper = normalized.toUpperCase();
  if (!/^[A-Z]{3}$/.test(upper)) {
    throw new AppError(400, 'invalid_input', `${field} must be a 3-letter ISO currency code`);
  }

  return upper;
}

function normalizeOptionalMoneyAmount(value: unknown, field: string): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new AppError(400, 'invalid_input', `${field} must be a non-negative number or null`);
  }

  return Number(value);
}

function normalizeApplicationIntake(value: unknown, field: string): CreateApplicationInput['intake'] {
  const payload = value === undefined ? {} : requireObject(value, field);
  const priceValue = payload.price === undefined ? undefined : requireObject(payload.price, `${field}.price`);

  return {
    kind: payload.kind === undefined ? undefined : requireApplicationIntakeKind(payload.kind, `${field}.kind`),
    price: priceValue === undefined
      ? undefined
      : {
          amount: normalizeOptionalMoneyAmount(priceValue.amount, `${field}.price.amount`),
          currency: normalizeOptionalCurrencyCode(priceValue.currency, `${field}.price.currency`),
        },
    bookingUrl: normalizeOptionalString(payload.bookingUrl, `${field}.bookingUrl`),
    bookedAt: normalizeOptionalString(payload.bookedAt, `${field}.bookedAt`),
    completedAt: normalizeOptionalString(payload.completedAt, `${field}.completedAt`),
  };
}

function normalizeApplicationMetadataPatch(value: unknown, field: string): Record<string, unknown> | undefined {
  return value === undefined ? undefined : requireObject(value, field);
}

function requireDeliveryEndpointChannel(value: unknown, field: string): DeliveryEndpointChannel {
  if (value !== 'openclaw_webhook') {
    throw new AppError(400, 'invalid_input', `${field} must be openclaw_webhook`);
  }

  return value;
}

function requireDeliveryEndpointState(value: unknown, field: string): DeliveryEndpointState {
  if (value !== 'active' && value !== 'disabled' && value !== 'failing') {
    throw new AppError(400, 'invalid_input', `${field} must be one of: active, disabled, failing`);
  }

  return value;
}

function normalizeCreateDeliveryEndpointInput(payload: Record<string, unknown>): Omit<CreateDeliveryEndpointInput, 'actorMemberId'> {
  return {
    channel: payload.channel === undefined ? 'openclaw_webhook' : requireDeliveryEndpointChannel(payload.channel, 'channel'),
    label: normalizeOptionalString(payload.label, 'label') ?? null,
    endpointUrl: requireNonEmptyString(payload.endpointUrl, 'endpointUrl'),
    sharedSecretRef: normalizeOptionalString(payload.sharedSecretRef, 'sharedSecretRef') ?? null,
    metadata: payload.metadata === undefined ? {} : requireObject(payload.metadata, 'metadata'),
  };
}

function normalizeUpdateDeliveryEndpointPatch(payload: Record<string, unknown>): UpdateDeliveryEndpointInput['patch'] {
  const endpointUrl = payload.endpointUrl === undefined ? undefined : requireNonEmptyString(payload.endpointUrl, 'endpointUrl');
  const patch = {
    label: normalizeOptionalString(payload.label, 'label'),
    endpointUrl,
    sharedSecretRef: normalizeOptionalString(payload.sharedSecretRef, 'sharedSecretRef'),
    state: payload.state === undefined ? undefined : requireDeliveryEndpointState(payload.state, 'state'),
    metadata: payload.metadata === undefined ? undefined : requireObject(payload.metadata, 'metadata'),
  };

  if (Object.values(patch).every((value) => value === undefined)) {
    throw new AppError(400, 'invalid_input', 'deliveries.endpoints.update requires at least one field to change');
  }

  return patch;
}

function buildSuccessResponse(input: {
  action: string;
  actor: ActorContext;
  requestScope: RequestScope;
  sharedContext: SharedResponseContext;
  data: unknown;
}) {
  return {
    action: input.action,
    actor: {
      member: input.actor.member,
      activeMemberships: input.actor.memberships,
      requestScope: input.requestScope,
      sharedContext: input.sharedContext,
    },
    data: input.data,
  };
}

async function readExecutionResponseBody(response: Response): Promise<string | null> {
  const body = await response.text();
  if (body.length === 0) {
    return null;
  }

  return body.length > 4000 ? `${body.slice(0, 4000)}…` : body;
}

async function buildSignedDeliveryHeaders(input: {
  endpoint: DeliveryEndpointSummary;
  delivery: DeliverySummary;
  attempt: DeliveryAttemptSummary;
  body: string;
  resolveDeliverySecret?: DeliverySecretResolver;
}): Promise<Record<string, string>> {
  const sharedSecretRef = input.endpoint.sharedSecretRef?.trim() ?? null;

  if (!sharedSecretRef) {
    return {};
  }

  if (!input.resolveDeliverySecret) {
    throw new Error(`Delivery endpoint ${input.endpoint.endpointId} requires secret resolution before execution`);
  }

  const secret = await input.resolveDeliverySecret({
    sharedSecretRef,
    endpoint: input.endpoint,
    delivery: input.delivery,
    attempt: input.attempt,
  });

  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error(`Delivery endpoint ${input.endpoint.endpointId} secret could not be resolved`);
  }

  return signClawClubDelivery({ secret, body: input.body });
}

export function buildApp({ repository, fetchImpl = globalThis.fetch, resolveDeliverySecret }: { repository: Repository; fetchImpl?: typeof fetch; resolveDeliverySecret?: DeliverySecretResolver }) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch implementation is required');
  }
  return {
    async handleAction(input: {
      bearerToken: string | null;
      action: unknown;
      payload?: unknown;
    }) {
      const bearerToken = requireNonEmptyString(input.bearerToken, 'Authorization bearer token');
      const action = requireNonEmptyString(input.action, 'action');
      const payload = (input.payload ?? {}) as Record<string, unknown>;

      const requiresWorkerAuth = DELIVERY_WORKER_ACTIONS.has(action);
      const workerAuth = requiresWorkerAuth
        ? await repository.authenticateDeliveryWorkerToken?.(bearerToken) ?? null
        : null;
      const auth = requiresWorkerAuth ? null : await repository.authenticateBearerToken(bearerToken);

      if (!auth && !workerAuth) {
        throw new AppError(401, 'unauthorized', 'Unknown bearer token');
      }

      const actor = auth?.actor ?? {
        member: {
          id: workerAuth!.actorMemberId,
          handle: null,
          publicName: workerAuth!.label ?? 'Delivery worker',
        },
        memberships: [],
        globalRoles: [],
      };
      const sharedContext = auth?.sharedContext ?? { pendingDeliveries: [] };

      switch (action) {
        case 'session.describe':
          return buildSuccessResponse({
            action,
            actor,
            requestScope: auth.requestScope,
            sharedContext,
            data: {
              member: actor.member,
              globalRoles: actor.globalRoles,
              accessibleNetworks: actor.memberships,
            },
          });

        case 'networks.list': {
          requireSuperadmin(actor);
          const includeArchived = payload.includeArchived === true;
          const networks = await repository.listNetworks?.({
            actorMemberId: actor.member.id,
            includeArchived,
          });

          return buildSuccessResponse({
            action,
            actor,
            requestScope: auth.requestScope,
            sharedContext,
            data: {
              includeArchived,
              networks: networks ?? [],
            },
          });
        }

        case 'networks.create': {
          requireSuperadmin(actor);
          const network = await repository.createNetwork?.({
            actorMemberId: actor.member.id,
            slug: requireNonEmptyString(payload.slug, 'slug'),
            name: requireNonEmptyString(payload.name, 'name'),
            summary: normalizeOptionalString(payload.summary, 'summary'),
            manifestoMarkdown: normalizeOptionalString(payload.manifestoMarkdown, 'manifestoMarkdown'),
            ownerMemberId: requireNonEmptyString(payload.ownerMemberId, 'ownerMemberId'),
          });

          if (!network) {
            throw new AppError(404, 'not_found', 'Owner member not found for network create');
          }

          return buildSuccessResponse({
            action,
            actor,
            requestScope: {
              requestedNetworkId: network.networkId,
              activeNetworkIds: [network.networkId],
            },
            sharedContext,
            data: { network },
          });
        }

        case 'networks.archive': {
          requireSuperadmin(actor);
          const network = await repository.archiveNetwork?.({
            actorMemberId: actor.member.id,
            networkId: requireNonEmptyString(payload.networkId, 'networkId'),
          });

          if (!network) {
            throw new AppError(404, 'not_found', 'Network not found for archive');
          }

          return buildSuccessResponse({
            action,
            actor,
            requestScope: {
              requestedNetworkId: network.networkId,
              activeNetworkIds: [network.networkId],
            },
            sharedContext,
            data: { network },
          });
        }

        case 'networks.assignOwner': {
          requireSuperadmin(actor);
          const network = await repository.assignNetworkOwner?.({
            actorMemberId: actor.member.id,
            networkId: requireNonEmptyString(payload.networkId, 'networkId'),
            ownerMemberId: requireNonEmptyString(payload.ownerMemberId, 'ownerMemberId'),
          });

          if (!network) {
            throw new AppError(404, 'not_found', 'Network or owner member not found for owner assignment');
          }

          return buildSuccessResponse({
            action,
            actor,
            requestScope: {
              requestedNetworkId: network.networkId,
              activeNetworkIds: [network.networkId],
            },
            sharedContext,
            data: { network },
          });
        }

        case 'memberships.list': {
          const limit = normalizeLimit(payload.limit);
          let networkScope = actor.memberships.filter((membership) => membership.role === 'owner');

          if (payload.networkId !== undefined) {
            networkScope = [requireMembershipOwner(actor, payload.networkId)];
          }

          if (networkScope.length === 0) {
            throw new AppError(403, 'forbidden', 'This member does not currently own any networks');
          }

          const status = payload.status === undefined ? undefined : requireMembershipState(payload.status, 'status');
          const networkIds = networkScope.map((network) => network.networkId);
          const results = await repository.listMemberships({
            actorMemberId: actor.member.id,
            networkIds,
            limit,
            status,
          });

          return buildSuccessResponse({
            action,
            actor,
            requestScope: {
              requestedNetworkId:
                typeof payload.networkId === 'string' && payload.networkId.trim().length > 0 ? payload.networkId.trim() : null,
              activeNetworkIds: networkIds,
            },
            sharedContext,
            data: {
              limit,
              status: status ?? null,
              networkScope,
              results,
            },
          });
        }

        case 'memberships.review': {
          const limit = normalizeLimit(payload.limit);
          let networkScope = actor.memberships.filter((membership) => membership.role === 'owner');

          if (payload.networkId !== undefined) {
            networkScope = [requireMembershipOwner(actor, payload.networkId)];
          }

          if (networkScope.length === 0) {
            throw new AppError(403, 'forbidden', 'This member does not currently own any networks');
          }

          const statuses = payload.statuses === undefined
            ? ['invited', 'pending_review']
            : (() => {
                if (!Array.isArray(payload.statuses) || payload.statuses.length === 0) {
                  throw new AppError(400, 'invalid_input', 'statuses must be a non-empty array when provided');
                }

                return [...new Set(payload.statuses.map((status) => requireMembershipState(status, 'statuses[]')))];
              })();

          const networkIds = networkScope.map((network) => network.networkId);
          const results = await repository.listMembershipReviews({
            actorMemberId: actor.member.id,
            networkIds,
            limit,
            statuses,
          });

          return buildSuccessResponse({
            action,
            actor,
            requestScope: {
              requestedNetworkId:
                typeof payload.networkId === 'string' && payload.networkId.trim().length > 0 ? payload.networkId.trim() : null,
              activeNetworkIds: networkIds,
            },
            sharedContext,
            data: {
              limit,
              statuses,
              networkScope,
              results,
            },
          });
        }

        case 'memberships.create': {
          const network = requireMembershipOwner(actor, payload.networkId);
          const membership = await repository.createMembership({
            actorMemberId: actor.member.id,
            networkId: network.networkId,
            memberId: requireNonEmptyString(payload.memberId, 'memberId'),
            sponsorMemberId: requireNonEmptyString(payload.sponsorMemberId, 'sponsorMemberId'),
            role: payload.role === undefined ? 'member' : payload.role === 'member' || payload.role === 'admin' ? payload.role : (() => { throw new AppError(400, 'invalid_input', 'role must be member or admin'); })(),
            initialStatus: payload.initialStatus === undefined
              ? 'invited'
              : payload.initialStatus === 'invited' || payload.initialStatus === 'pending_review' || payload.initialStatus === 'active'
                ? payload.initialStatus
                : (() => { throw new AppError(400, 'invalid_input', 'initialStatus must be one of: invited, pending_review, active'); })(),
            reason: normalizeOptionalString(payload.reason, 'reason'),
            metadata: payload.metadata === undefined ? {} : requireObject(payload.metadata, 'metadata'),
          });

          if (!membership) {
            throw new AppError(404, 'not_found', 'Member or sponsor not found inside the owner scope');
          }

          return buildSuccessResponse({
            action,
            actor,
            requestScope: {
              requestedNetworkId: membership.networkId,
              activeNetworkIds: [membership.networkId],
            },
            sharedContext,
            data: { membership },
          });
        }

        case 'memberships.transition': {
          const membershipId = requireNonEmptyString(payload.membershipId, 'membershipId');
          const membership = await repository.transitionMembershipState({
            actorMemberId: actor.member.id,
            membershipId,
            nextStatus: requireMembershipState(payload.status, 'status'),
            reason: normalizeOptionalString(payload.reason, 'reason'),
            accessibleNetworkIds: actor.memberships.filter((item) => item.role === 'owner').map((item) => item.networkId),
          });

          if (!membership) {
            throw new AppError(404, 'not_found', 'Membership not found inside the owner scope');
          }

          return buildSuccessResponse({
            action,
            actor,
            requestScope: {
              requestedNetworkId: membership.networkId,
              activeNetworkIds: [membership.networkId],
            },
            sharedContext,
            data: { membership },
          });
        }

        case 'applications.list': {
          const limit = normalizeLimit(payload.limit);
          let networkScope = actor.memberships.filter((membership) => membership.role === 'owner');

          if (payload.networkId !== undefined) {
            networkScope = [requireMembershipOwner(actor, payload.networkId)];
          }

          if (networkScope.length === 0) {
            throw new AppError(403, 'forbidden', 'This member does not currently own any networks');
          }

          const statuses = payload.statuses === undefined
            ? undefined
            : (() => {
                if (!Array.isArray(payload.statuses) || payload.statuses.length === 0) {
                  throw new AppError(400, 'invalid_input', 'statuses must be a non-empty array when provided');
                }

                return [...new Set(payload.statuses.map((status) => requireApplicationStatus(status, 'statuses[]')))];
              })();

          const networkIds = networkScope.map((network) => network.networkId);
          const results = await repository.listApplications?.({
            actorMemberId: actor.member.id,
            networkIds,
            limit,
            statuses,
          });

          if (!results) {
            throw new AppError(501, 'not_implemented', 'applications.list is not implemented');
          }

          return buildSuccessResponse({
            action,
            actor,
            requestScope: {
              requestedNetworkId:
                typeof payload.networkId === 'string' && payload.networkId.trim().length > 0 ? payload.networkId.trim() : null,
              activeNetworkIds: networkIds,
            },
            sharedContext,
            data: {
              limit,
              statuses: statuses ?? null,
              networkScope,
              results,
            },
          });
        }

        case 'applications.create': {
          const network = requireMembershipOwner(actor, payload.networkId);
          const application = await repository.createApplication?.({
            actorMemberId: actor.member.id,
            networkId: network.networkId,
            applicantMemberId: requireNonEmptyString(payload.applicantMemberId, 'applicantMemberId'),
            sponsorMemberId: normalizeOptionalString(payload.sponsorMemberId, 'sponsorMemberId'),
            membershipId: normalizeOptionalString(payload.membershipId, 'membershipId'),
            path: requireApplicationPath(payload.path, 'path'),
            initialStatus: payload.initialStatus === undefined
              ? 'submitted'
              : (() => {
                  const status = requireApplicationStatus(payload.initialStatus, 'initialStatus');
                  if (status !== 'draft' && status !== 'submitted' && status !== 'interview_scheduled') {
                    throw new AppError(400, 'invalid_input', 'initialStatus must be one of: draft, submitted, interview_scheduled');
                  }
                  return status;
                })(),
            notes: normalizeOptionalString(payload.notes, 'notes'),
            intake: normalizeApplicationIntake(payload.intake, 'intake'),
            metadata: payload.metadata === undefined ? {} : requireObject(payload.metadata, 'metadata'),
          });

          if (application === undefined) {
            throw new AppError(501, 'not_implemented', 'applications.create is not implemented');
          }

          if (!application) {
            throw new AppError(404, 'not_found', 'Applicant, sponsor, or membership not found inside the owner scope');
          }

          return buildSuccessResponse({
            action,
            actor,
            requestScope: {
              requestedNetworkId: application.networkId,
              activeNetworkIds: [application.networkId],
            },
            sharedContext,
            data: { application },
          });
        }

        case 'applications.transition': {
          const applicationId = requireNonEmptyString(payload.applicationId, 'applicationId');
          const application = await repository.transitionApplication?.({
            actorMemberId: actor.member.id,
            applicationId,
            nextStatus: requireApplicationStatus(payload.status, 'status'),
            notes: normalizeOptionalString(payload.notes, 'notes'),
            accessibleNetworkIds: actor.memberships.filter((item) => item.role === 'owner').map((item) => item.networkId),
            intake: payload.intake === undefined ? undefined : normalizeApplicationIntake(payload.intake, 'intake'),
            membershipId: payload.membershipId === undefined ? undefined : normalizeOptionalString(payload.membershipId, 'membershipId'),
            activateMembership: payload.activateMembership === true,
            activationReason: normalizeOptionalString(payload.activationReason, 'activationReason'),
            metadataPatch: normalizeApplicationMetadataPatch(payload.metadata, 'metadata'),
          });

          if (application === undefined) {
            throw new AppError(501, 'not_implemented', 'applications.transition is not implemented');
          }

          if (!application) {
            throw new AppError(404, 'not_found', 'Application not found inside the owner scope');
          }

          return buildSuccessResponse({
            action,
            actor,
            requestScope: {
              requestedNetworkId: application.networkId,
              activeNetworkIds: [application.networkId],
            },
            sharedContext,
            data: { application },
          });
        }

        case 'members.search': {
          const query = requireNonEmptyString(payload.query, 'query');
          const limit = normalizeLimit(payload.limit);
          const requestedNetworkId = payload.networkId;

          let networkIds = actor.memberships.map((network) => network.networkId);

          if (requestedNetworkId !== undefined) {
            networkIds = [requireAccessibleNetwork(actor, requestedNetworkId).networkId];
          }

          if (networkIds.length === 0) {
            throw new AppError(403, 'forbidden', 'This member does not currently have access to any networks');
          }

          const requestScope: RequestScope = {
            requestedNetworkId:
              typeof requestedNetworkId === 'string' && requestedNetworkId.trim().length > 0
                ? requestedNetworkId.trim()
                : null,
            activeNetworkIds: networkIds,
          };

          const results = await repository.searchMembers({
            networkIds,
            query,
            limit,
          });

          return buildSuccessResponse({
            action,
            actor,
            requestScope,
            sharedContext,
            data: {
              query,
              limit,
              networkScope: actor.memberships.filter((network) => networkIds.includes(network.networkId)),
              results,
            },
          });
        }

        case 'members.list': {
          const limit = normalizeLimit(payload.limit);
          let networkScope = actor.memberships;

          if (payload.networkId !== undefined) {
            networkScope = [requireAccessibleNetwork(actor, payload.networkId)];
          }

          if (networkScope.length === 0) {
            throw new AppError(403, 'forbidden', 'This member does not currently have access to any networks');
          }

          const networkIds = networkScope.map((network) => network.networkId);
          const results = await repository.listMembers({
            networkIds,
            limit,
          });

          return buildSuccessResponse({
            action,
            actor,
            requestScope: {
              requestedNetworkId:
                typeof payload.networkId === 'string' && payload.networkId.trim().length > 0 ? payload.networkId.trim() : null,
              activeNetworkIds: networkIds,
            },
            sharedContext,
            data: {
              limit,
              networkScope,
              results,
            },
          });
        }

        case 'profile.get': {
          const targetMemberId = payload.memberId === undefined ? actor.member.id : requireNonEmptyString(payload.memberId, 'memberId');
          const profile = await repository.getMemberProfile({
            actorMemberId: actor.member.id,
            targetMemberId,
          });

          if (!profile) {
            throw new AppError(404, 'not_found', 'Member profile not found inside the actor scope');
          }

          return buildSuccessResponse({
            action,
            actor,
            requestScope: auth.requestScope,
            sharedContext,
            data: profile,
          });
        }

        case 'profile.update': {
          const patch = normalizeProfilePatch(payload);
          const updatedProfile = await repository.updateOwnProfile({ actor, patch });

          return buildSuccessResponse({
            action,
            actor: {
              member: {
                id: updatedProfile.memberId,
                handle: updatedProfile.handle,
                publicName: updatedProfile.publicName,
              },
              memberships: actor.memberships,
            },
            requestScope: auth.requestScope,
            sharedContext,
            data: updatedProfile,
          });
        }

        case 'entities.create': {
          const network = requireAccessibleNetwork(actor, payload.networkId);
          const entity = await repository.createEntity({
            authorMemberId: actor.member.id,
            networkId: network.networkId,
            kind: requireEntityKind(payload.kind, 'kind'),
            title: normalizeOptionalString(payload.title, 'title') ?? null,
            summary: normalizeOptionalString(payload.summary, 'summary') ?? null,
            body: normalizeOptionalString(payload.body, 'body') ?? null,
            expiresAt: normalizeOptionalString(payload.expiresAt, 'expiresAt') ?? null,
            content: payload.content === undefined ? {} : requireObject(payload.content, 'content'),
          });

          return buildSuccessResponse({
            action,
            actor,
            requestScope: {
              requestedNetworkId: network.networkId,
              activeNetworkIds: [network.networkId],
            },
            sharedContext,
            data: { entity },
          });
        }

        case 'entities.update': {
          const entityId = requireNonEmptyString(payload.entityId, 'entityId');
          const entity = await repository.updateEntity({
            actorMemberId: actor.member.id,
            accessibleNetworkIds: actor.memberships.map((network) => network.networkId),
            entityId,
            patch: normalizeEntityPatch(payload),
          });

          if (!entity) {
            throw new AppError(404, 'not_found', 'Entity not found inside the actor scope');
          }

          if (entity.author.memberId !== actor.member.id) {
            throw new AppError(403, 'forbidden', 'Only the author may update this entity');
          }

          return buildSuccessResponse({
            action,
            actor,
            requestScope: {
              requestedNetworkId: entity.networkId,
              activeNetworkIds: [entity.networkId],
            },
            sharedContext,
            data: { entity },
          });
        }

        case 'events.create': {
          const network = requireAccessibleNetwork(actor, payload.networkId);
          const event = await repository.createEvent({
            authorMemberId: actor.member.id,
            networkId: network.networkId,
            title: normalizeOptionalString(payload.title, 'title') ?? null,
            summary: normalizeOptionalString(payload.summary, 'summary') ?? null,
            body: normalizeOptionalString(payload.body, 'body') ?? null,
            startsAt: normalizeOptionalString(payload.startsAt, 'startsAt') ?? null,
            endsAt: normalizeOptionalString(payload.endsAt, 'endsAt') ?? null,
            timezone: normalizeOptionalString(payload.timezone, 'timezone') ?? null,
            recurrenceRule: normalizeOptionalString(payload.recurrenceRule, 'recurrenceRule') ?? null,
            capacity: normalizeOptionalInteger(payload.capacity, 'capacity') ?? null,
            expiresAt: normalizeOptionalString(payload.expiresAt, 'expiresAt') ?? null,
            content: payload.content === undefined ? {} : requireObject(payload.content, 'content'),
          });

          return buildSuccessResponse({
            action,
            actor,
            requestScope: {
              requestedNetworkId: network.networkId,
              activeNetworkIds: [network.networkId],
            },
            sharedContext,
            data: { event },
          });
        }

        case 'events.list': {
          const limit = normalizeLimit(payload.limit);
          let networkScope = actor.memberships;

          if (payload.networkId !== undefined) {
            networkScope = [requireAccessibleNetwork(actor, payload.networkId)];
          }

          if (networkScope.length === 0) {
            throw new AppError(403, 'forbidden', 'This member does not currently have access to any networks');
          }

          const networkIds = networkScope.map((network) => network.networkId);
          const query = normalizeOptionalString(payload.query, 'query') ?? undefined;
          const results = await repository.listEvents({
            actorMemberId: actor.member.id,
            networkIds,
            limit,
            query,
          });

          return buildSuccessResponse({
            action,
            actor,
            requestScope: {
              requestedNetworkId:
                typeof payload.networkId === 'string' && payload.networkId.trim().length > 0 ? payload.networkId.trim() : null,
              activeNetworkIds: networkIds,
            },
            sharedContext,
            data: {
              query: query ?? null,
              limit,
              networkScope,
              results,
            },
          });
        }

        case 'events.rsvp': {
          const eventEntityId = requireNonEmptyString(payload.eventEntityId, 'eventEntityId');
          const event = await repository.rsvpEvent({
            actorMemberId: actor.member.id,
            eventEntityId,
            response: requireEventRsvpState(payload.response, 'response'),
            note: normalizeOptionalString(payload.note, 'note'),
            accessibleMemberships: actor.memberships.map((membership) => ({
              membershipId: membership.membershipId,
              networkId: membership.networkId,
            })),
          });

          if (!event) {
            throw new AppError(404, 'not_found', 'Event not found inside the actor scope');
          }

          return buildSuccessResponse({
            action,
            actor,
            requestScope: {
              requestedNetworkId: event.networkId,
              activeNetworkIds: [event.networkId],
            },
            sharedContext,
            data: { event },
          });
        }


        case 'deliveries.endpoints.list': {
          const endpoints = await repository.listDeliveryEndpoints({
            actorMemberId: actor.member.id,
          });

          return buildSuccessResponse({
            action,
            actor,
            requestScope: auth.requestScope,
            sharedContext,
            data: { endpoints },
          });
        }

        case 'deliveries.endpoints.create': {
          const endpoint = await repository.createDeliveryEndpoint({
            actorMemberId: actor.member.id,
            ...normalizeCreateDeliveryEndpointInput(payload),
          });

          return buildSuccessResponse({
            action,
            actor,
            requestScope: auth.requestScope,
            sharedContext,
            data: { endpoint },
          });
        }

        case 'deliveries.endpoints.update': {
          const endpointId = requireNonEmptyString(payload.endpointId, 'endpointId');
          const endpoint = await repository.updateDeliveryEndpoint({
            actorMemberId: actor.member.id,
            endpointId,
            patch: normalizeUpdateDeliveryEndpointPatch(payload),
          });

          if (!endpoint) {
            throw new AppError(404, 'not_found', 'Endpoint not found inside the actor scope');
          }

          return buildSuccessResponse({
            action,
            actor,
            requestScope: auth.requestScope,
            sharedContext,
            data: { endpoint },
          });
        }

        case 'deliveries.endpoints.revoke': {
          const endpointId = requireNonEmptyString(payload.endpointId, 'endpointId');
          const endpoint = await repository.revokeDeliveryEndpoint({
            actorMemberId: actor.member.id,
            endpointId,
          });

          if (!endpoint) {
            throw new AppError(404, 'not_found', 'Endpoint not found inside the actor scope');
          }

          return buildSuccessResponse({
            action,
            actor,
            requestScope: auth.requestScope,
            sharedContext,
            data: { endpoint },
          });
        }

        case 'tokens.list': {
          const tokens = await repository.listBearerTokens({
            actorMemberId: actor.member.id,
          });

          return buildSuccessResponse({
            action,
            actor,
            requestScope: auth.requestScope,
            sharedContext,
            data: { tokens },
          });
        }

        case 'tokens.create': {
          const { label, metadata } = normalizeTokenCreateInput(payload);
          const created = await repository.createBearerToken({
            actorMemberId: actor.member.id,
            label,
            metadata,
          });

          return buildSuccessResponse({
            action,
            actor,
            requestScope: auth.requestScope,
            sharedContext,
            data: created,
          });
        }

        case 'tokens.revoke': {
          const tokenId = requireNonEmptyString(payload.tokenId, 'tokenId');
          const token = await repository.revokeBearerToken({
            actorMemberId: actor.member.id,
            tokenId,
          });

          if (!token) {
            throw new AppError(404, 'not_found', 'Token not found inside the actor scope');
          }

          return buildSuccessResponse({
            action,
            actor,
            requestScope: auth.requestScope,
            sharedContext,
            data: { token },
          });
        }

        case 'deliveries.list': {
          const limit = normalizeLimit(payload.limit);
          let networkScope = actor.memberships;

          if (payload.networkId !== undefined) {
            networkScope = [requireAccessibleNetwork(actor, payload.networkId)];
          }

          if (networkScope.length === 0) {
            throw new AppError(403, 'forbidden', 'This member does not currently have access to any networks');
          }

          const networkIds = networkScope.map((network) => network.networkId);
          const pendingOnly = payload.pendingOnly === true;
          const results = await repository.listDeliveries({
            actorMemberId: actor.member.id,
            networkIds,
            limit,
            pendingOnly,
          });

          return buildSuccessResponse({
            action,
            actor,
            requestScope: {
              requestedNetworkId:
                typeof payload.networkId === 'string' && payload.networkId.trim().length > 0 ? payload.networkId.trim() : null,
              activeNetworkIds: networkIds,
            },
            sharedContext,
            data: {
              limit,
              pendingOnly,
              networkScope,
              results,
            },
          });
        }

        case 'deliveries.attempts': {
          const limit = normalizeLimit(payload.limit);
          let networkScope = actor.memberships;

          if (payload.networkId !== undefined) {
            networkScope = [requireAccessibleNetwork(actor, payload.networkId)];
          }

          if (networkScope.length === 0) {
            throw new AppError(403, 'forbidden', 'This member does not currently have access to any networks');
          }

          const networkIds = networkScope.map((network) => network.networkId);
          const endpointId = payload.endpointId === undefined ? undefined : requireNonEmptyString(payload.endpointId, 'endpointId');
          const recipientMemberId =
            payload.recipientMemberId === undefined ? undefined : requireNonEmptyString(payload.recipientMemberId, 'recipientMemberId');
          const status = normalizeOptionalDeliveryAttemptStatus(payload.status);
          const results = await repository.listDeliveryAttempts({
            actorMemberId: actor.member.id,
            networkIds,
            limit,
            endpointId,
            recipientMemberId,
            status,
          });

          return buildSuccessResponse({
            action,
            actor,
            requestScope: {
              requestedNetworkId:
                typeof payload.networkId === 'string' && payload.networkId.trim().length > 0 ? payload.networkId.trim() : null,
              activeNetworkIds: networkIds,
            },
            sharedContext,
            data: {
              limit,
              filters: {
                endpointId: endpointId ?? null,
                recipientMemberId: recipientMemberId ?? null,
                status: status ?? null,
              },
              networkScope,
              results,
            },
          });
        }

        case 'deliveries.acknowledge': {
          const deliveryId = requireNonEmptyString(payload.deliveryId, 'deliveryId');
          const state = payload.state === 'shown' || payload.state === 'suppressed' ? payload.state : null;

          if (!state) {
            throw new AppError(400, 'invalid_input', 'state must be one of: shown, suppressed');
          }

          const acknowledgement = await repository.acknowledgeDelivery({
            actorMemberId: actor.member.id,
            accessibleNetworkIds: actor.memberships.map((network) => network.networkId),
            deliveryId,
            state,
            suppressionReason: normalizeOptionalString(payload.suppressionReason, 'suppressionReason'),
          });

          if (!acknowledgement) {
            throw new AppError(404, 'not_found', 'Delivery not found inside the actor scope');
          }

          const remainingPendingDeliveries = sharedContext.pendingDeliveries.filter((delivery) => delivery.deliveryId !== acknowledgement.deliveryId);

          return buildSuccessResponse({
            action,
            actor,
            requestScope: {
              requestedNetworkId: acknowledgement.networkId,
              activeNetworkIds: [acknowledgement.networkId],
            },
            sharedContext: {
              pendingDeliveries: remainingPendingDeliveries,
            },
            data: { acknowledgement },
          });
        }

        case 'deliveries.retry': {
          const deliveryId = requireNonEmptyString(payload.deliveryId, 'deliveryId');
          const delivery = await repository.retryDelivery({
            actorMemberId: actor.member.id,
            accessibleNetworkIds: actor.memberships.map((network) => network.networkId),
            deliveryId,
          });

          if (!delivery) {
            throw new AppError(404, 'not_found', 'Delivery not found inside the actor scope');
          }

          return buildSuccessResponse({
            action,
            actor,
            requestScope: {
              requestedNetworkId: delivery.networkId,
              activeNetworkIds: [delivery.networkId],
            },
            sharedContext,
            data: { delivery },
          });
        }

        case 'deliveries.claim': {
          const accessibleNetworkIds = workerAuth?.allowedNetworkIds ?? actor.memberships.map((network) => network.networkId);
          const claimed = await repository.claimNextDelivery({
            actorMemberId: actor.member.id,
            accessibleNetworkIds,
            workerKey: normalizeOptionalString(payload.workerKey, 'workerKey'),
          });

          return buildSuccessResponse({
            action,
            actor,
            requestScope: {
              requestedNetworkId: claimed?.delivery.networkId ?? null,
              activeNetworkIds: claimed ? [claimed.delivery.networkId] : accessibleNetworkIds,
            },
            sharedContext,
            data: { claimed },
          });
        }

        case 'deliveries.complete': {
          const accessibleNetworkIds = workerAuth?.allowedNetworkIds ?? actor.memberships.map((network) => network.networkId);
          const deliveryId = requireNonEmptyString(payload.deliveryId, 'deliveryId');
          const responseStatusCode = payload.responseStatusCode === undefined || payload.responseStatusCode === null ? null : requireInteger(payload.responseStatusCode, 'responseStatusCode');
          const claimed = await repository.completeDeliveryAttempt({
            actorMemberId: actor.member.id,
            accessibleNetworkIds,
            deliveryId,
            responseStatusCode,
            responseBody: normalizeOptionalString(payload.responseBody, 'responseBody'),
          });

          if (!claimed) {
            throw new AppError(404, 'not_found', 'Processing delivery not found inside the actor scope');
          }

          return buildSuccessResponse({
            action,
            actor,
            requestScope: {
              requestedNetworkId: claimed.delivery.networkId,
              activeNetworkIds: [claimed.delivery.networkId],
            },
            sharedContext,
            data: claimed,
          });
        }

        case 'deliveries.fail': {
          const accessibleNetworkIds = workerAuth?.allowedNetworkIds ?? actor.memberships.map((network) => network.networkId);
          const deliveryId = requireNonEmptyString(payload.deliveryId, 'deliveryId');
          const responseStatusCode = payload.responseStatusCode === undefined || payload.responseStatusCode === null ? null : requireInteger(payload.responseStatusCode, 'responseStatusCode');
          const claimed = await repository.failDeliveryAttempt({
            actorMemberId: actor.member.id,
            accessibleNetworkIds,
            deliveryId,
            errorMessage: requireNonEmptyString(payload.errorMessage, 'errorMessage'),
            responseStatusCode,
            responseBody: normalizeOptionalString(payload.responseBody, 'responseBody'),
          });

          if (!claimed) {
            throw new AppError(404, 'not_found', 'Processing delivery not found inside the actor scope');
          }

          return buildSuccessResponse({
            action,
            actor,
            requestScope: {
              requestedNetworkId: claimed.delivery.networkId,
              activeNetworkIds: [claimed.delivery.networkId],
            },
            sharedContext,
            data: claimed,
          });
        }

        case 'deliveries.execute': {
          const accessibleNetworkIds = workerAuth?.allowedNetworkIds ?? actor.memberships.map((network) => network.networkId);
          const claimed = await repository.claimNextDelivery({
            actorMemberId: actor.member.id,
            accessibleNetworkIds,
            workerKey: normalizeOptionalString(payload.workerKey, 'workerKey'),
          });

          if (!claimed) {
            return buildSuccessResponse({
              action,
              actor,
              requestScope: {
                requestedNetworkId: null,
                activeNetworkIds: accessibleNetworkIds,
              },
              sharedContext,
              data: { execution: { outcome: 'idle', claimed: null } satisfies DeliveryExecutionResult },
            });
          }

          try {
            const requestBody = JSON.stringify({
              deliveryId: claimed.delivery.deliveryId,
              networkId: claimed.delivery.networkId,
              recipientMemberId: claimed.delivery.recipientMemberId,
              topic: claimed.delivery.topic,
              payload: claimed.delivery.payload,
              entityId: claimed.delivery.entityId,
              entityVersionId: claimed.delivery.entityVersionId,
              transcriptMessageId: claimed.delivery.transcriptMessageId,
              attempt: {
                attemptId: claimed.attempt.attemptId,
                attemptNo: claimed.attempt.attemptNo,
                workerKey: claimed.attempt.workerKey,
                startedAt: claimed.attempt.startedAt,
              },
            });
            const signedHeaders = await buildSignedDeliveryHeaders({
              endpoint: claimed.endpoint,
              delivery: claimed.delivery,
              attempt: claimed.attempt,
              body: requestBody,
              resolveDeliverySecret,
            });
            const response = await fetchImpl(claimed.endpoint.endpointUrl, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'user-agent': 'clawclub-delivery-executor/0.1',
                'x-clawclub-delivery-id': claimed.delivery.deliveryId,
                'x-clawclub-attempt-id': claimed.attempt.attemptId,
                'x-clawclub-topic': claimed.delivery.topic,
                ...signedHeaders,
              },
              body: requestBody,
            });

            const responseBody = await readExecutionResponseBody(response);
            const result = response.ok
              ? await repository.completeDeliveryAttempt({
                  actorMemberId: actor.member.id,
                  accessibleNetworkIds: [claimed.delivery.networkId],
                  deliveryId: claimed.delivery.deliveryId,
                  responseStatusCode: response.status,
                  responseBody,
                })
              : await repository.failDeliveryAttempt({
                  actorMemberId: actor.member.id,
                  accessibleNetworkIds: [claimed.delivery.networkId],
                  deliveryId: claimed.delivery.deliveryId,
                  errorMessage: `HTTP ${response.status}`,
                  responseStatusCode: response.status,
                  responseBody,
                });

            if (!result) {
              throw new AppError(409, 'delivery_execution_conflict', 'Claimed delivery could not be finalized');
            }

            return buildSuccessResponse({
              action,
              actor,
              requestScope: {
                requestedNetworkId: result.delivery.networkId,
                activeNetworkIds: [result.delivery.networkId],
              },
              sharedContext,
              data: { execution: { outcome: response.ok ? 'sent' : 'failed', claimed: result } satisfies DeliveryExecutionResult },
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown delivery execution error';
            const failed = await repository.failDeliveryAttempt({
              actorMemberId: actor.member.id,
              accessibleNetworkIds: [claimed.delivery.networkId],
              deliveryId: claimed.delivery.deliveryId,
              errorMessage: message,
            });

            if (!failed) {
              throw error;
            }

            return buildSuccessResponse({
              action,
              actor,
              requestScope: {
                requestedNetworkId: failed.delivery.networkId,
                activeNetworkIds: [failed.delivery.networkId],
              },
              sharedContext,
              data: { execution: { outcome: 'failed', claimed: failed } satisfies DeliveryExecutionResult },
            });
          }
        }

        case 'messages.send': {
          const recipientMemberId = requireNonEmptyString(payload.recipientMemberId, 'recipientMemberId');
          const message = await repository.sendDirectMessage({
            actorMemberId: actor.member.id,
            accessibleNetworkIds: actor.memberships.map((network) => network.networkId),
            recipientMemberId,
            networkId: payload.networkId === undefined ? undefined : requireAccessibleNetwork(actor, payload.networkId).networkId,
            messageText: requireNonEmptyString(payload.messageText, 'messageText'),
          });

          if (!message) {
            throw new AppError(404, 'not_found', 'Recipient not found inside the actor scope');
          }

          return buildSuccessResponse({
            action,
            actor,
            requestScope: {
              requestedNetworkId: message.networkId,
              activeNetworkIds: [message.networkId],
            },
            sharedContext,
            data: { message },
          });
        }

        case 'messages.list': {
          const limit = normalizeLimit(payload.limit);
          let networkScope = actor.memberships;

          if (payload.networkId !== undefined) {
            networkScope = [requireAccessibleNetwork(actor, payload.networkId)];
          }

          if (networkScope.length === 0) {
            throw new AppError(403, 'forbidden', 'This member does not currently have access to any networks');
          }

          const networkIds = networkScope.map((network) => network.networkId);
          const results = await repository.listDirectMessageThreads({
            actorMemberId: actor.member.id,
            networkIds,
            limit,
          });

          return buildSuccessResponse({
            action,
            actor,
            requestScope: {
              requestedNetworkId:
                typeof payload.networkId === 'string' && payload.networkId.trim().length > 0 ? payload.networkId.trim() : null,
              activeNetworkIds: networkIds,
            },
            sharedContext,
            data: {
              limit,
              networkScope,
              results,
            },
          });
        }

        case 'messages.read': {
          const threadId = requireNonEmptyString(payload.threadId, 'threadId');
          const transcript = await repository.readDirectMessageThread({
            actorMemberId: actor.member.id,
            accessibleNetworkIds: actor.memberships.map((network) => network.networkId),
            threadId,
            limit: normalizeLimit(payload.limit),
          });

          if (!transcript) {
            throw new AppError(404, 'not_found', 'Thread not found inside the actor scope');
          }

          return buildSuccessResponse({
            action,
            actor,
            requestScope: {
              requestedNetworkId: transcript.thread.networkId,
              activeNetworkIds: [transcript.thread.networkId],
            },
            sharedContext,
            data: transcript,
          });
        }

        case 'messages.inbox': {
          const limit = normalizeLimit(payload.limit);
          let networkScope = actor.memberships;

          if (payload.networkId !== undefined) {
            networkScope = [requireAccessibleNetwork(actor, payload.networkId)];
          }

          if (networkScope.length === 0) {
            throw new AppError(403, 'forbidden', 'This member does not currently have access to any networks');
          }

          const networkIds = networkScope.map((network) => network.networkId);
          const unreadOnly = payload.unreadOnly === true;
          const results = await repository.listDirectMessageInbox({
            actorMemberId: actor.member.id,
            networkIds,
            limit,
            unreadOnly,
          });

          return buildSuccessResponse({
            action,
            actor,
            requestScope: {
              requestedNetworkId:
                typeof payload.networkId === 'string' && payload.networkId.trim().length > 0 ? payload.networkId.trim() : null,
              activeNetworkIds: networkIds,
            },
            sharedContext,
            data: {
              limit,
              unreadOnly,
              networkScope,
              results,
            },
          });
        }

        case 'entities.list': {
          const limit = normalizeLimit(payload.limit);
          const kinds = normalizeEntityKinds(payload.kinds);
          let networkScope = actor.memberships;

          if (payload.networkId !== undefined) {
            networkScope = [requireAccessibleNetwork(actor, payload.networkId)];
          }

          if (networkScope.length === 0) {
            throw new AppError(403, 'forbidden', 'This member does not currently have access to any networks');
          }

          const networkIds = networkScope.map((network) => network.networkId);
          const query = normalizeOptionalString(payload.query, 'query') ?? undefined;
          const results = await repository.listEntities({
            networkIds,
            kinds,
            limit,
            query,
          });

          return buildSuccessResponse({
            action,
            actor,
            requestScope: {
              requestedNetworkId:
                typeof payload.networkId === 'string' && payload.networkId.trim().length > 0 ? payload.networkId.trim() : null,
              activeNetworkIds: networkIds,
            },
            sharedContext,
            data: {
              query: query ?? null,
              kinds,
              limit,
              networkScope,
              results,
            },
          });
        }

        default:
          throw new AppError(400, 'unknown_action', `Unsupported action: ${action}`);
      }
    },
  };
}
