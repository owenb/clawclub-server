import { signClawClubDelivery } from './delivery-signing.ts';
import { handleAdmissionsAction } from './app-admissions.ts';
import { handleContentAction } from './app-content.ts';
import { handleDeliveryAction } from './app-deliveries.ts';
import { handleMessageAction } from './app-messages.ts';
import { handleProfileAction } from './app-profile.ts';
import { handleSystemAction } from './app-system.ts';

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

export type MemberUpdates = {
  deliveries: PendingDelivery[];
  posts: EntitySummary[];
  polledAt: string;
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
  actorMemberId: string;
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
  listEntities(input: ListEntitiesInput): Promise<EntitySummary[]>;
  createEvent(input: CreateEventInput): Promise<EventSummary>;
  listEvents(input: ListEventsInput): Promise<EventSummary[]>;
  rsvpEvent(input: RsvpEventInput): Promise<EventSummary | null>;
  listBearerTokens(input: { actorMemberId: string }): Promise<BearerTokenSummary[]>;
  createBearerToken(input: CreateBearerTokenInput): Promise<CreatedBearerToken>;
  revokeBearerToken(input: RevokeBearerTokenInput): Promise<BearerTokenSummary | null>;
  pollUpdates?(input: {
    actorMemberId: string;
    accessibleNetworkIds: string[];
    limit: number;
  }): Promise<MemberUpdates>;
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
      globalRoles: input.actor.globalRoles,
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

      const deliveryResponse = await handleDeliveryAction({
        action,
        payload,
        actor,
        workerAuth,
        sharedContext,
        repository,
        fetchImpl,
        resolveDeliverySecret,
        buildSuccessResponse,
        createAppError: (status, code, message) => new AppError(status, code, message),
        normalizeLimit,
        normalizeOptionalDeliveryAttemptStatus,
        normalizeOptionalString,
        requireAccessibleNetwork,
        requireInteger,
        requireNonEmptyString,
        normalizeCreateDeliveryEndpointInput,
        normalizeUpdateDeliveryEndpointPatch,
        buildSignedDeliveryHeaders,
        readExecutionResponseBody,
      });
      if (deliveryResponse) {
        return deliveryResponse;
      }

      const admissionsResponse = await handleAdmissionsAction({
        action,
        payload,
        actor,
        sharedContext,
        repository,
        buildSuccessResponse,
        createAppError: (status, code, message) => new AppError(status, code, message),
        normalizeLimit,
        normalizeOptionalString,
        requireAccessibleNetwork,
        requireMembershipOwner,
        requireMembershipState,
        requireApplicationStatus,
        requireApplicationPath,
        normalizeApplicationIntake,
        normalizeApplicationMetadataPatch,
        requireNonEmptyString,
        requireObject,
      });
      if (admissionsResponse) {
        return admissionsResponse;
      }

      const profileResponse = await handleProfileAction({
        action,
        payload,
        actor,
        requestScope: auth.requestScope,
        sharedContext,
        repository,
        buildSuccessResponse,
        createAppError: (status, code, message) => new AppError(status, code, message),
        normalizeProfilePatch,
        requireNonEmptyString,
      });
      if (profileResponse) {
        return profileResponse;
      }

      const contentResponse = await handleContentAction({
        action,
        payload,
        actor,
        sharedContext,
        repository,
        buildSuccessResponse,
        createAppError: (status, code, message) => new AppError(status, code, message),
        normalizeLimit,
        normalizeOptionalInteger,
        normalizeOptionalString,
        normalizeEntityKinds,
        normalizeEntityPatch,
        requireAccessibleNetwork,
        requireEntityKind,
        requireEventRsvpState,
        requireNonEmptyString,
        requireObject,
      });
      if (contentResponse) {
        return contentResponse;
      }

      const messageResponse = await handleMessageAction({
        action,
        payload,
        actor,
        sharedContext,
        repository,
        buildSuccessResponse,
        createAppError: (status, code, message) => new AppError(status, code, message),
        normalizeLimit,
        requireAccessibleNetwork,
        requireNonEmptyString,
      });
      if (messageResponse) {
        return messageResponse;
      }

      const systemResponse = await handleSystemAction({
        action,
        payload,
        actor,
        requestScope: auth.requestScope,
        sharedContext,
        repository,
        buildSuccessResponse,
        createAppError: (status, code, message) => new AppError(status, code, message),
        normalizeOptionalString,
        normalizeTokenCreateInput,
        requireNonEmptyString,
        requireSuperadmin,
      });
      if (systemResponse) {
        return systemResponse;
      }

      throw new AppError(400, 'unknown_action', `Unsupported action: ${action}`);
    },
  };
}
