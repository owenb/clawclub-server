import type { Actor, AuthResult, AuthenticatedActor } from './actors.ts';
import type {
  ClubProfileLink,
  ContentKind,
  ContentState,
  EventRsvpState,
  MembershipState,
  UpdateReceiptState,
} from './schemas/fields.ts';
import type {
  ActivityEvent,
  AdminClubStats,
  AdminContentSummary,
  AdminDiagnostics,
  AdminMemberSummary,
  AdminOverview,
  AdminThreadSummary,
  BearerTokenSummary,
  ClubLlmOutputUsageWindow,
  ClubProfile,
  ClubSpendWindow,
  ClubSummary,
  Content,
  ContentSearchResult,
  ContentThread,
  CreatedNotificationProducer,
  CreatedBearerToken,
  DirectMessageEntry,
  DirectMessageInboxSummary,
  DirectMessageSummary,
  DirectMessageThreadSummary,
  EventRsvpAttendee,
  IncludedBundle,
  IncludedMember,
  InlineMembershipVouchSummary,
  InvitationSummary,
  MemberIdentity,
  MemberProfileEnvelope,
  MemberRef,
  MemberSearchResult,
  MembershipAdminSummary,
  MembershipSummary,
  MembershipVouchSummary,
  MentionSpan,
  MessageRemovalResult,
  NotificationItem,
  NotificationProducerSummary,
  NotificationProducerTopicSummary,
  NotificationReceipt,
  PublicMemberSummary,
  QuotaAllowance,
  RemovedClubSummary,
  RemovedMemberSummary,
  RotatedNotificationProducerSecret,
  SharedClubRef,
  SuperadminClubDetail,
  SuperadminMemberDetail,
  SuperadminMemberSummary,
} from './schemas/responses.ts';

export type { Actor, AuthResult, AuthenticatedActor, RequestScope } from './actors.ts';
export type { ResponseNotice, ResponseNotifications } from './notifications.ts';
export type {
  ClubProfileLink,
  ContentKind,
  ContentState,
  EventRsvpState,
  MembershipState,
  UpdateReceiptState,
} from './schemas/fields.ts';
export type {
  ActivityEvent,
  AdminClubStats,
  AdminContentSummary,
  AdminDiagnostics,
  AdminMemberSummary,
  AdminOverview,
  AdminThreadSummary,
  BearerTokenSummary,
  ClubLlmOutputUsageWindow,
  ClubProfile,
  ClubSpendWindow,
  ClubSummary,
  Content,
  ContentSearchResult,
  ContentThread,
  CreatedNotificationProducer,
  CreatedBearerToken,
  DirectMessageEntry,
  DirectMessageInboxSummary,
  DirectMessageSummary,
  DirectMessageThreadSummary,
  EventRsvpAttendee,
  IncludedBundle,
  IncludedMember,
  InlineMembershipVouchSummary,
  InvitationSummary,
  MemberIdentity,
  MemberProfileEnvelope,
  MemberRef,
  MemberSearchResult,
  MembershipAdminSummary,
  MembershipSummary,
  MembershipVouchSummary,
  MentionSpan,
  MessageRemovalResult,
  NotificationItem,
  NotificationProducerSummary,
  NotificationProducerTopicSummary,
  NotificationReceipt,
  PublicMemberSummary,
  QuotaAllowance,
  RemovedClubSummary,
  RemovedMemberSummary,
  RotatedNotificationProducerSecret,
  SharedClubRef,
  SuperadminClubDetail,
  SuperadminMemberDetail,
  SuperadminMemberSummary,
} from './schemas/responses.ts';

export type Paginated<T> = { results: T[]; hasMore: boolean; nextCursor: string | null };
export { AppError } from './errors.ts';

export type CreateMembershipInput = {
  actorMemberId: string;
  clubId: string;
  memberId: string;
  sponsorId?: string | null;
  role: 'member';
  initialStatus: 'active';
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
  actorIsSuperadmin?: boolean;
  actorMemberships?: Array<{ clubId: string; slug: string; name: string }>;
  membershipId: string;
  nextStatus: MembershipState;
  reason?: string | null;
  accessibleClubIds: string[];
  skipClubAdminCheck?: boolean;
};

export type UpdateMembershipInput = {
  actorMemberId: string;
  actorIsSuperadmin?: boolean;
  actorMemberships?: Array<{ clubId: string; slug: string; name: string }>;
  clubId: string;
  memberId: string;
  patch: {
    role?: 'clubadmin' | 'member';
    status?: MembershipState;
    reason?: string | null;
  };
  skipClubAdminCheck?: boolean;
};

export type InvitationStatus = 'open' | 'used' | 'revoked' | 'expired';
export type InvitationQuotaState = 'counted' | 'free';

export type ResolveInvitationTargetInput = {
  candidateMemberId?: string;
  candidateEmail?: string;
  candidateName?: string | null;
};

export type ResolvedInvitationTarget =
  | {
    kind: 'member';
    memberId: string;
    publicName: string;
    email: string;
    source: 'member_id' | 'email';
    sponsorLabel: string;
  }
  | {
    kind: 'external_email';
    email: string;
    nameHint: string;
    source: 'email';
    sponsorLabel: string;
  };

export type IssueInvitationInput = {
  actorMemberId: string;
  idempotencyActorContext?: string;
  idempotencyRequestValue?: unknown;
  clubId: string;
  reason: string;
  clientKey?: string | null;
  target: ResolvedInvitationTarget;
};

export type CreateClubInput = {
  actorMemberId: string;
  idempotencyActorContext?: string;
  idempotencyRequestValue?: unknown;
  slug: string;
  name: string;
  summary: string;
  admissionPolicy?: string | null;
  ownerMemberId: string;
  usesFreeAllowance: boolean;
  memberCap: number | null;
  clientKey?: string | null;
  enforceFreeClubLimit?: boolean;
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
  idempotencyActorContext?: string;
  idempotencyRequestValue?: unknown;
  clientKey?: string | null;
  patch: {
    name?: string;
    summary?: string | null;
    admissionPolicy?: string | null;
    usesFreeAllowance?: boolean;
    memberCap?: number | null;
  };
};

export type ClubForGate = {
  clubId: string;
  name: string;
  summary: string | null;
  admissionPolicy: string | null;
  usesFreeAllowance: boolean;
  memberCap: number | null;
};

export type RemoveClubInput = {
  actorMemberId: string;
  idempotencyActorContext?: string;
  idempotencyRequestValue?: unknown;
  clubId: string;
  confirmSlug: string;
  reason: string;
  clientKey?: string | null;
};

export type RemoveMemberInput = {
  actorMemberId: string;
  idempotencyActorContext?: string;
  idempotencyRequestValue?: unknown;
  memberId: string;
  confirmPublicName: string;
  reason: string;
  clientKey?: string | null;
};

export type RestoreRemovedClubInput = {
  actorMemberId: string;
  idempotencyActorContext?: string;
  idempotencyRequestValue?: unknown;
  archiveId: string;
  clientKey?: string | null;
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

export type UpdateMemberIdentityInput = {
  displayName?: string;
};

export type UpdateClubProfileInput = {
  clubId: string;
  clientKey?: string | null;
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

export type EventFields = {
  location: string | null;
  startsAt: string | null;
  endsAt: string | null;
  timezone: string | null;
  recurrenceRule: string | null;
  capacity: number | null;
};

export type EventRsvpSummary = {
  viewerResponse: EventRsvpState | null;
  counts: Record<EventRsvpState, number>;
  attendees: EventRsvpAttendee[];
};

export type CreateContentInput = {
  authorMemberId: string;
  clubId?: string;
  threadId?: string;
  kind: ContentKind;
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
  cursor?: { startsAt: string; contentId: string } | null;
};

export type RsvpEventInput = {
  actorMemberId: string;
  eventId: string;
  response: EventRsvpState;
  note?: string | null;
  clientKey?: string | null;
  accessibleMemberships: Array<{
    membershipId: string;
    clubId: string;
  }>;
};

export type ListContentInput = {
  actorMemberId: string;
  clubIds: string[];
  kinds: ContentKind[];
  limit: number;
  query?: string;
  includeClosed: boolean;
  cursor?: { latestActivityAt: string; threadId: string } | null;
};

export type ReadContentInput = {
  actorMemberId: string;
  accessibleMemberships: Array<{
    membershipId: string;
    clubId: string;
  }>;
  id: string;
};

export type ReadContentThreadInput = {
  actorMemberId: string;
  accessibleMemberships: Array<{
    membershipId: string;
    clubId: string;
  }>;
  accessibleClubIds: string[];
  contentId?: string;
  threadId?: string;
  includeClosed: boolean;
  limit: number;
  cursor?: { createdAt: string; contentId: string } | null;
};

export type RemoveContentInput = {
  actorMemberId: string;
  accessibleClubIds: string[];
  id: string;
  reason?: string | null;
  moderatorRemoval?: { restrictToClubId: string } | null;
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

export type WithIncluded<T> = T & {
  included: IncludedBundle;
};

export type CreateBearerTokenInput = {
  actorMemberId: string;
  label?: string | null;
  expiresAt?: string | null;
  metadata?: Record<string, unknown>;
};

export type RevokeBearerTokenInput = {
  actorMemberId: string;
  tokenId: string;
};

export type MessageFramePayload = {
  thread: DirectMessageThreadSummary;
  messages: DirectMessageEntry[];
  included: IncludedBundle;
};

export type MessageFramePage = {
  frames: MessageFramePayload[];
  nextCursor: string | null;
};

export type SendDirectMessageInput = {
  actorMemberId: string;
  accessibleClubIds: string[];
  recipientMemberId: string;
  messageText: string;
  clientKey?: string | null;
};

export type UpdateContentInput = {
  actorMemberId: string;
  accessibleClubIds: string[];
  id: string;
  clientKey?: string | null;
  patch: {
    title?: string | null;
    summary?: string | null;
    body?: string | null;
    expiresAt?: string | null;
    event?: Partial<EventFields> | null;
  };
};

export type ContentForGate = {
  contentKind: 'post' | 'ask' | 'gift' | 'service' | 'opportunity' | 'event';
  isReply: boolean;
  title: string | null;
  summary: string | null;
  body: string | null;
  expiresAt: string | null;
  event: {
    location: string;
    startsAt: string;
    endsAt: string | null;
    timezone: string | null;
    recurrenceRule: string | null;
    capacity: number | null;
  } | null;
};

export type SetContentLoopInput = {
  actorMemberId: string;
  accessibleClubIds: string[];
  id: string;
};

export type CreateVouchInput = {
  actorMemberId: string;
  clubId: string;
  targetMemberId: string;
  reason: string;
  clientKey?: string | null;
};

export type CheckVouchTargetAccessibleInput = {
  actorMemberId: string;
  clubId: string;
  targetMemberId: string;
};

export type Repository = {
  authenticateBearerToken(bearerToken: string): Promise<AuthResult | null>;
  validateBearerTokenPassive?(bearerToken: string): Promise<AuthResult | null>;
  registerAccount?(input: {
    clientKey?: string;
    mode: 'discover' | 'submit';
    name?: string;
    email?: string;
    challengeBlob?: string;
    nonce?: string;
  }): Promise<Record<string, unknown>>;
  updateContactEmail?(input: {
    actorMemberId: string;
    newEmail: string;
    clientKey: string;
  }): Promise<Record<string, unknown>>;
  applyToClub?(input: {
    actorMemberId: string;
    clubSlug: string;
    invitationId?: string;
    draft: { name: string; socials: string; application: string };
    clientKey: string;
  }): Promise<Record<string, unknown>>;
  redeemInvitationApplication?(input: {
    actorMemberId: string;
    code: string;
    draft: { name: string; socials: string; application: string };
    clientKey: string;
  }): Promise<Record<string, unknown>>;
  reviseClubApplication?(input: {
    actorMemberId: string;
    applicationId: string;
    draft: { name: string; socials: string; application: string };
    clientKey: string;
  }): Promise<Record<string, unknown>>;
  getMemberApplicationById?(input: {
    actorMemberId: string;
    applicationId: string;
  }): Promise<Record<string, unknown> | null>;
  listMemberApplications?(input: {
    actorMemberId: string;
    phases?: string[] | null;
    limit: number;
    cursor?: { submittedAt: string; applicationId: string } | null;
  }): Promise<{ results: Record<string, unknown>[]; hasMore: boolean; nextCursor: string | null }>;
  withdrawClubApplication?(input: {
    actorMemberId: string;
    applicationId: string;
    clientKey: string;
  }): Promise<Record<string, unknown> | null>;
  listAdminClubApplications?(input: {
    actorMemberId: string;
    clubId: string;
    phases?: string[] | null;
    limit: number;
    cursor?: { submittedAt: string; applicationId: string } | null;
  }): Promise<{ results: Record<string, unknown>[]; hasMore: boolean; nextCursor: string | null }>;
  getAdminClubApplicationById?(input: {
    actorMemberId: string;
    clubId: string;
    applicationId: string;
  }): Promise<Record<string, unknown> | null>;
  decideClubApplication?(input: {
    actorMemberId: string;
    actorPublicName?: string;
    clubId: string;
    applicationId: string;
    decision: 'accept' | 'decline' | 'ban';
    adminNote?: string | null;
    clientKey: string;
  }): Promise<Record<string, unknown> | null>;
  resolveInvitationTarget?(input: ResolveInvitationTargetInput): Promise<ResolvedInvitationTarget>;
  issueInvitation?(input: IssueInvitationInput): Promise<{ invitation: InvitationSummary } | null>;
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
  removeClub?(input: RemoveClubInput): Promise<{
    archiveId: string;
    clubId: string;
    clubSlug: string;
    removedAt: string;
    retainedUntil: string;
  } | null>;
  listRemovedClubs?(input: {
    actorMemberId: string;
    limit: number;
    cursor?: { removedAt: string; archiveId: string } | null;
    clubSlug?: string | null;
  }): Promise<Paginated<RemovedClubSummary>>;
  restoreRemovedClub?(input: RestoreRemovedClubInput): Promise<ClubSummary | null>;
  loadClubForGate?(input: { actorMemberId: string; clubId: string }): Promise<ClubForGate | null>;
  enforceClubsCreateQuota?(input: { memberId: string }): Promise<QuotaAllowance>;
  enforceContentCreateQuota?(input: { memberId: string; clubId: string }): Promise<QuotaAllowance>;
  createMembership(input: CreateMembershipInput): Promise<MembershipAdminSummary | null>;
  transitionMembershipState(input: TransitionMembershipInput): Promise<MembershipAdminSummary | null>;
  updateMembership?(input: UpdateMembershipInput): Promise<{ membership: MembershipAdminSummary; changed: boolean } | null>;
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
    statuses?: Extract<MembershipState, 'active' | 'cancelled'>[] | null;
    roles?: Array<'clubadmin' | 'member'> | null;
    cursor?: { joinedAt: string; membershipId: string } | null;
  }): Promise<Paginated<AdminMemberSummary>>;
  getAdminMember(input: {
    actorMemberId: string;
    clubId: string;
    membershipId: string;
  }): Promise<AdminMemberSummary | null>;
  buildMembershipSeedProfile?(input: {
    memberId: string;
    clubId: string;
  }): Promise<ClubProfileFields>;
  updateMemberIdentity?(input: { actor: AuthenticatedActor; patch: UpdateMemberIdentityInput }): Promise<MemberIdentity>;
  updateClubProfile?(input: { actor: AuthenticatedActor; patch: UpdateClubProfileInput }): Promise<MemberProfileEnvelope>;
  loadProfileForGate?(input: {
    actorMemberId: string;
    clubId: string;
  }): Promise<ProfileForGate | null>;
  preflightCreateContentMentions?(input: {
    actorMemberId: string;
    actorClubIds: string[];
    clubId?: string;
    threadId?: string;
    title: string | null;
    summary: string | null;
    body: string | null;
    clientKey?: string | null;
  }): Promise<void>;
  preflightUpdateContentMentions?(input: {
    actorMemberId: string;
    actorClubIds: string[];
    id: string;
    patch: {
      title?: string | null;
      summary?: string | null;
      body?: string | null;
    };
  }): Promise<void>;
  createContent(input: CreateContentInput): Promise<WithIncluded<{ content: Content }>>;
  readContent?(input: ReadContentInput): Promise<WithIncluded<{ content: Content }> | null>;
  updateContent(input: UpdateContentInput): Promise<WithIncluded<{ content: Content }> | null>;
  loadContentForGate?(input: {
    actorMemberId: string;
    id: string;
    accessibleClubIds: string[];
  }): Promise<ContentForGate | null>;
  resolveContentThreadClubIdForGate?(input: {
    actorMemberId: string;
    threadId: string;
    accessibleClubIds: string[];
  }): Promise<string | null>;
  resolveContentClubIdForGate?(input: {
    actorMemberId: string;
    contentId: string;
    accessibleClubIds: string[];
  }): Promise<string | null>;
  closeContentLoop(input: SetContentLoopInput): Promise<WithIncluded<{ content: Content }> | null>;
  reopenContentLoop(input: SetContentLoopInput): Promise<WithIncluded<{ content: Content }> | null>;
  removeContent?(input: RemoveContentInput): Promise<WithIncluded<{ content: Content }> | null>;
  listContent(input: ListContentInput): Promise<WithIncluded<Paginated<ContentThread>>>;
  readContentThread(input: ReadContentThreadInput): Promise<WithIncluded<{ thread: ContentThread; contents: Content[]; hasMore: boolean; nextCursor: string | null }> | null>;
  listEvents(input: ListEventsInput): Promise<WithIncluded<Paginated<Content>>>;
  rsvpEvent(input: RsvpEventInput): Promise<WithIncluded<{ event: Content }> | null>;
  cancelEventRsvp(input: { actorMemberId: string; eventId: string; accessibleMemberships: Array<{ membershipId: string; clubId: string }> }): Promise<WithIncluded<{ event: Content }> | null>;
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
  }): Promise<{ items: ActivityEvent[]; highWaterMark: number; hasMore: boolean }>;
  listNotifications(input: {
    actorMemberId: string;
    accessibleClubIds: string[];
    adminClubIds: string[];
    limit: number;
    after: string | null;
  }): Promise<{ items: NotificationItem[]; nextCursor: string | null }>;
  acknowledgeNotifications(input: {
    actorMemberId: string;
    notificationIds: string[];
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

  checkVouchTargetAccessible(input: CheckVouchTargetAccessibleInput): Promise<{ vouchable: boolean }>;
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
    sponsorId?: string | null;
    initialStatus: 'active';
    reason?: string | null;
    initialProfile: {
      fields: ClubProfileFields;
      generationSource: 'membership_seed' | 'application_generated';
    };
  }): Promise<MembershipAdminSummary | null>;
  adminGetOverview?(input: { actorMemberId: string }): Promise<AdminOverview>;
  adminListMembers?(input: { actorMemberId: string; limit: number; cursor?: { createdAt: string; id: string } | null }): Promise<Paginated<SuperadminMemberSummary>>;
  adminGetMember?(input: { actorMemberId: string; memberId: string }): Promise<SuperadminMemberDetail | null>;
  adminRemoveMember?(input: RemoveMemberInput): Promise<RemovedMemberSummary | null>;
  adminGetClub?(input: { actorMemberId: string; clubId: string }): Promise<SuperadminClubDetail | null>;
  adminGetClubStats?(input: { actorMemberId: string; clubId: string }): Promise<AdminClubStats | null>;
  adminListContent?(input: { actorMemberId: string; clubId?: string; kind?: ContentKind; limit: number; cursor?: { createdAt: string; id: string } | null }): Promise<WithIncluded<Paginated<AdminContentSummary>>>;
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
  adminCreateNotificationProducer?(input: {
    actorMemberId: string;
    producerId: string;
    namespacePrefix: string;
    burstLimit?: number | null;
    hourlyLimit?: number | null;
    dailyLimit?: number | null;
    topics: Array<{
      topic: string;
      deliveryClass: 'transactional' | 'informational' | 'suggestion';
      status?: 'active' | 'disabled';
    }>;
  }): Promise<CreatedNotificationProducer>;
  adminRotateNotificationProducerSecret?(input: {
    actorMemberId: string;
    producerId: string;
  }): Promise<RotatedNotificationProducerSecret | null>;
  adminUpdateNotificationProducerStatus?(input: {
    actorMemberId: string;
    producerId: string;
    status: 'active' | 'disabled';
  }): Promise<NotificationProducerSummary | null>;
  adminUpdateNotificationProducerTopicStatus?(input: {
    actorMemberId: string;
    producerId: string;
    topic: string;
    status: 'active' | 'disabled';
  }): Promise<NotificationProducerTopicSummary | null>;
  adminGetDiagnostics?(input: { actorMemberId: string }): Promise<AdminDiagnostics>;

  authenticateProducer?(input: {
    producerId: string;
    secret: string;
  }): Promise<{ producerId: string; status: 'active' | 'disabled' } | null>;
  deliverProducerNotifications?(input: {
    producerId: string;
    notifications: Array<{
      topic: string;
      recipientMemberId: string;
      clubId?: string | null;
      payload: Record<string, unknown>;
      payloadVersion: number;
      idempotencyKey?: string | null;
      expiresAt?: string | null;
      refs?: Array<{
        role: string;
        kind: 'member' | 'club' | 'content' | 'dm_thread' | 'membership' | 'application' | 'invitation' | 'subscription' | 'support_request';
        id: string;
      }>;
    }>;
  }): Promise<Array<{
    index: number;
    outcome:
      | 'delivered'
      | 'duplicate'
      | 'idempotency_key_mismatch'
      | 'expired'
      | 'rate_limited'
      | 'producer_disabled'
      | 'topic_disabled'
      | 'topic_not_registered'
      | 'topic_namespace_mismatch'
      | 'recipient_not_found'
      | 'recipient_not_accessible_in_club'
      | 'invalid_ref'
      | 'ref_club_mismatch';
    notificationId: string | null;
  }>>;
  acknowledgeProducerNotifications?(input: {
    producerId: string;
    notificationIds: string[];
  }): Promise<Array<{
    notificationId: string;
    outcome: 'acknowledged' | 'already_acknowledged' | 'not_found' | 'wrong_producer';
    acknowledgedAt: string | null;
  }>>;

  logApiRequest(input: LogApiRequestInput): Promise<void>;
  logLlmUsage?(input: LogLlmUsageInput): Promise<void>;
  reserveLlmOutputBudget?(input: {
    memberId: string;
    clubId: string;
    actionName: string;
    provider: string;
    model: string;
    maxOutputTokens: number;
  }): Promise<{ reservationId: string; quota: QuotaAllowance }>;
  finalizeLlmOutputBudget?(input: {
    reservationId: string;
    actualOutputTokens: number;
  }): Promise<void>;
  reserveClubSpendBudget?(input: {
    clubId: string;
    memberId: string | null;
    actionName: string;
    usageKind: 'gate' | 'embedding';
    provider: string;
    model: string;
    reservedMicroCents: number;
    reservedInputTokensEstimate: number;
    reservedOutputTokens: number;
  }): Promise<{ reservationId: string }>;
  finalizeClubSpendBudget?(input:
    | {
      reservationId: string;
      usageKind: 'gate';
      actualPromptTokens: number;
      actualCompletionTokens: number;
    }
    | {
      reservationId: string;
      usageKind: 'embedding';
      actualEmbeddingTokens: number;
    }
  ): Promise<void>;
  releaseClubSpendBudget?(input: {
    reservationId: string;
  }): Promise<void>;
  peekIdempotencyReplay?(input: {
    clientKey: string;
    actorContext: string;
    requestValue: unknown;
  }): Promise<boolean>;
  withClientKeyBarrier?<T>(input: {
    clientKey: string;
    execute: () => Promise<T>;
  }): Promise<T>;
  enforceEmbeddingQueryQuota?(input: {
    memberId: string;
  }): Promise<QuotaAllowance>;

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

  findContentViaEmbedding(input: {
    actorMemberId: string;
    clubIds: string[];
    queryEmbedding: string;
    kinds?: string[];
    limit: number;
    cursor?: { distance: string; contentId: string } | null;
  }): Promise<WithIncluded<Paginated<ContentSearchResult>>>;
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

export type LogApiRequestInput = {
  memberId: string;
  actionName: string;
  ipAddress: string | null;
};
