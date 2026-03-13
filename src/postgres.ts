import { Pool, type PoolClient } from 'pg';
import { AppError, type AcknowledgeDeliveryInput, type ActorContext, type ApplicationStatus, type ApplicationSummary, type ArchiveNetworkInput, type AssignNetworkOwnerInput, type AuthResult, type BearerTokenSummary, type ClaimDeliveryInput, type ClaimedDelivery, type CompleteDeliveryAttemptInput, type CreateApplicationInput, type CreateBearerTokenInput, type CreateDeliveryEndpointInput, type CreateEntityInput, type CreateEventInput, type CreateMembershipInput, type CreateNetworkInput, type CreatedBearerToken, type DeliveryAcknowledgement, type DeliveryAttemptInspection, type DeliveryAttemptSummary, type DeliveryEndpointState, type DeliveryEndpointSummary, type DeliverySummary, type DeliveryWorkerAuthResult, type DirectMessageInboxSummary, type DirectMessageReceipt, type DirectMessageSummary, type DirectMessageThreadSummary, type DirectMessageTranscriptEntry, type EmbeddingProjectionSummary, type EntitySummary, type EventRsvpState, type EventSummary, type FailDeliveryAttemptInput, type ListDeliveriesInput, type ListDeliveryAttemptsInput, type ListEventsInput, type MemberProfile, type MemberSearchResult, type MembershipAdminSummary, type MembershipReviewSummary, type MembershipState, type MembershipSummary, type MembershipVouchSummary, type NetworkMemberSummary, type NetworkSummary, type PendingDelivery, type Repository, type RetryDeliveryInput, type RevokeBearerTokenInput, type RevokeDeliveryEndpointInput, type RsvpEventInput, type SendDirectMessageInput, type TransitionApplicationInput, type TransitionMembershipInput, type UpdateDeliveryEndpointInput, type UpdateEntityInput, type UpdateOwnProfileInput } from './app.ts';
import { buildBearerToken, hashTokenSecret, parseBearerToken } from './token.ts';

type ActorRow = {
  member_id: string;
  handle: string | null;
  public_name: string;
  global_roles: Array<'superadmin'> | null;
  membership_id: string | null;
  network_id: string | null;
  slug: string | null;
  network_name: string | null;
  network_summary: string | null;
  manifesto_markdown: string | null;
  role: MembershipSummary['role'] | null;
  status: MembershipSummary['status'] | null;
  sponsor_member_id: string | null;
  joined_at: string | null;
};

type NetworkRow = {
  network_id: string;
  slug: string;
  name: string;
  summary: string | null;
  manifesto_markdown: string | null;
  archived_at: string | null;
  owner_member_id: string;
  owner_public_name: string;
  owner_handle: string | null;
  owner_version_no: number;
  owner_created_at: string;
  owner_created_by_member_id: string | null;
};

type SearchRow = {
  member_id: string;
  public_name: string;
  display_name: string;
  handle: string | null;
  tagline: string | null;
  summary: string | null;
  what_i_do: string | null;
  known_for: string | null;
  services_summary: string | null;
  website_url: string | null;
  shared_networks: Array<{ id: string; slug: string; name: string }> | null;
};

function normalizeSearchText(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function tokenizeSearchQuery(query: string): string[] {
  return [...new Set(
    normalizeSearchText(query)
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 0),
  )];
}

function scoreMemberSearchRow(row: SearchRow, query: string, tokens: string[]): number {
  const normalizedQuery = normalizeSearchText(query);
  const publicName = normalizeSearchText(row.public_name);
  const displayName = normalizeSearchText(row.display_name);
  const handle = normalizeSearchText(row.handle);
  const tagline = normalizeSearchText(row.tagline);
  const summary = normalizeSearchText(row.summary);
  const whatIDo = normalizeSearchText(row.what_i_do);
  const knownFor = normalizeSearchText(row.known_for);
  const servicesSummary = normalizeSearchText(row.services_summary);

  const primaryFields = [displayName, publicName, handle];
  const secondaryFields = [tagline, whatIDo, knownFor, servicesSummary, summary];

  let score = 0;

  for (const field of primaryFields) {
    if (!field) continue;
    if (field === normalizedQuery) score += 120;
    else if (field.startsWith(normalizedQuery)) score += 80;
    else if (field.includes(normalizedQuery)) score += 40;
  }

  for (const field of secondaryFields) {
    if (!field) continue;
    if (field === normalizedQuery) score += 40;
    else if (field.startsWith(normalizedQuery)) score += 24;
    else if (field.includes(normalizedQuery)) score += 12;
  }

  for (const token of tokens) {
    for (const field of primaryFields) {
      if (!field) continue;
      if (field === token) score += 36;
      else if (field.startsWith(token)) score += 20;
      else if (field.includes(token)) score += 10;
    }

    for (const field of secondaryFields) {
      if (!field) continue;
      if (field === token) score += 12;
      else if (field.startsWith(token)) score += 8;
      else if (field.includes(token)) score += 4;
    }
  }

  return score;
}

type MembershipVouchRow = {
  edge_id: string;
  from_member_id: string;
  from_public_name: string;
  from_handle: string | null;
  reason: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
  created_by_member_id: string | null;
};

type MembershipReviewRow = MembershipAdminRow & {
  sponsor_active_sponsored_count: number;
  sponsor_sponsored_this_month_count: number;
  vouches: MembershipVouchRow[] | null;
};

type MembershipAdminRow = {
  membership_id: string;
  network_id: string;
  member_id: string;
  public_name: string;
  handle: string | null;
  sponsor_member_id: string | null;
  sponsor_public_name: string | null;
  sponsor_handle: string | null;
  role: MembershipSummary['role'];
  status: MembershipState;
  state_reason: string | null;
  state_version_no: number;
  state_created_at: string;
  state_created_by_member_id: string | null;
  joined_at: string;
  accepted_covenant_at: string | null;
  metadata: Record<string, unknown> | null;
};

type ApplicationRow = {
  application_id: string;
  network_id: string;
  applicant_member_id: string;
  applicant_public_name: string;
  applicant_handle: string | null;
  sponsor_member_id: string | null;
  sponsor_public_name: string | null;
  sponsor_handle: string | null;
  membership_id: string | null;
  linked_membership_status: MembershipState | null;
  linked_membership_accepted_covenant_at: string | null;
  path: 'sponsored' | 'outside';
  intake_kind: 'fit_check' | 'advice_call' | 'other';
  intake_price_amount: string | number | null;
  intake_price_currency: string | null;
  intake_booking_url: string | null;
  intake_booked_at: string | null;
  intake_completed_at: string | null;
  status: ApplicationStatus;
  notes: string | null;
  version_no: number;
  version_created_at: string;
  version_created_by_member_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

type MemberListRow = {
  member_id: string;
  public_name: string;
  display_name: string;
  handle: string | null;
  tagline: string | null;
  summary: string | null;
  what_i_do: string | null;
  known_for: string | null;
  services_summary: string | null;
  website_url: string | null;
  memberships: MembershipSummary[] | null;
};

type ProfileRow = {
  member_id: string;
  public_name: string;
  handle: string | null;
  display_name: string;
  tagline: string | null;
  summary: string | null;
  what_i_do: string | null;
  known_for: string | null;
  services_summary: string | null;
  website_url: string | null;
  links: unknown[] | null;
  profile: Record<string, unknown> | null;
  version_id: string | null;
  version_no: number | null;
  version_created_at: string | null;
  version_created_by_member_id: string | null;
  embedding_id: string | null;
  embedding_model: string | null;
  embedding_dimensions: number | null;
  embedding_source_text: string | null;
  embedding_metadata: Record<string, unknown> | null;
  embedding_created_at: string | null;
  shared_networks: Array<{ id: string; slug: string; name: string }> | null;
};

type EntityRow = {
  entity_id: string;
  entity_version_id: string;
  network_id: string;
  kind: EntitySummary['kind'];
  author_member_id: string;
  author_public_name: string;
  author_handle: string | null;
  version_no: number;
  state: 'published';
  title: string | null;
  summary: string | null;
  body: string | null;
  effective_at: string;
  expires_at: string | null;
  version_created_at: string;
  content: Record<string, unknown> | null;
  embedding_id: string | null;
  embedding_model: string | null;
  embedding_dimensions: number | null;
  embedding_source_text: string | null;
  embedding_metadata: Record<string, unknown> | null;
  embedding_created_at: string | null;
  entity_created_at: string;
};

type EventRsvpAttendeeRow = {
  membership_id: string;
  member_id: string;
  public_name: string;
  handle: string | null;
  response: EventRsvpState;
  note: string | null;
  created_at: string;
};

type EventRow = {
  entity_id: string;
  entity_version_id: string;
  network_id: string;
  author_member_id: string;
  author_public_name: string;
  author_handle: string | null;
  version_no: number;
  state: 'published';
  title: string | null;
  summary: string | null;
  body: string | null;
  starts_at: string | null;
  ends_at: string | null;
  timezone: string | null;
  recurrence_rule: string | null;
  capacity: number | null;
  effective_at: string;
  expires_at: string | null;
  version_created_at: string;
  content: Record<string, unknown> | null;
  entity_created_at: string;
  viewer_response: EventRsvpState | null;
  yes_count: number;
  maybe_count: number;
  no_count: number;
  waitlist_count: number;
  attendees: EventRsvpAttendeeRow[] | null;
};

type DeliverySummaryRow = {
  delivery_id: string;
  network_id: string;
  recipient_member_id: string;
  endpoint_id: string;
  topic: string;
  payload: Record<string, unknown> | null;
  status: 'pending' | 'processing' | 'sent' | 'failed' | 'canceled';
  attempt_count: number;
  entity_id: string | null;
  entity_version_id: string | null;
  transcript_message_id: string | null;
  scheduled_at: string;
  sent_at: string | null;
  failed_at: string | null;
  last_error: string | null;
  created_at: string;
  acknowledgement_id: string | null;
  acknowledgement_state: 'shown' | 'suppressed' | null;
  acknowledgement_suppression_reason: string | null;
  acknowledgement_version_no: number | null;
  acknowledgement_created_at: string | null;
  acknowledgement_created_by_member_id: string | null;
};

type PendingDeliveryRow = {
  id: string;
  network_id: string;
  entity_id: string | null;
  entity_version_id: string | null;
  transcript_message_id: string | null;
  topic: string;
  payload: Record<string, unknown> | null;
  created_at: string;
  sent_at: string | null;
};

type DeliveryEndpointRow = {
  endpoint_id: string;
  member_id: string;
  channel: 'openclaw_webhook';
  label: string | null;
  endpoint_url: string;
  shared_secret_ref: string | null;
  state: DeliveryEndpointState;
  last_success_at: string | null;
  last_failure_at: string | null;
  pending_count: number | string | null;
  processing_count: number | string | null;
  sent_count: number | string | null;
  failed_count: number | string | null;
  canceled_count: number | string | null;
  last_delivery_at: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  disabled_at: string | null;
};

type BearerTokenRow = {
  token_id: string;
  member_id: string;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  metadata: Record<string, unknown> | null;
};

type DeliveryWorkerTokenRow = {
  token_id: string;
  actor_member_id: string;
  label: string | null;
  allowed_network_ids: string[];
  metadata: Record<string, unknown> | null;
};

type DeliveryAcknowledgementRow = {
  acknowledgement_id: string;
  delivery_id: string;
  network_id: string;
  recipient_member_id: string;
  state: DeliveryAcknowledgement['state'];
  suppression_reason: string | null;
  version_no: number;
  supersedes_acknowledgement_id: string | null;
  created_at: string;
  created_by_member_id: string | null;
};

type DeliveryAttemptRow = {
  attempt_id: string;
  delivery_id: string;
  network_id: string | null;
  endpoint_id: string;
  worker_key: string | null;
  status: DeliveryAttemptSummary['status'];
  attempt_no: number;
  response_status_code: number | null;
  response_body: string | null;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
  created_by_member_id: string | null;
};

type DeliveryAttemptInspectionRow = DeliveryAttemptRow & {
  delivery_network_id: string;
  delivery_recipient_member_id: string;
  recipient_public_name: string;
  recipient_handle: string | null;
  delivery_topic: string;
  delivery_status: DeliverySummary['status'];
  delivery_attempt_count: number;
  delivery_scheduled_at: string;
  delivery_sent_at: string | null;
  delivery_failed_at: string | null;
  delivery_last_error: string | null;
  delivery_created_at: string;
};

type DirectMessageRow = {
  thread_id: string;
  network_id: string;
  sender_member_id: string;
  recipient_member_id: string;
  message_id: string;
  message_text: string;
  created_at: string;
  delivery_count: number;
};

type DirectMessageThreadRow = {
  thread_id: string;
  network_id: string;
  counterpart_member_id: string;
  counterpart_public_name: string;
  counterpart_handle: string | null;
  latest_message_id: string;
  latest_sender_member_id: string;
  latest_role: DirectMessageThreadSummary['latestMessage']['role'];
  latest_message_text: string | null;
  latest_created_at: string;
  message_count: number;
};

type DirectMessageReceiptRow = {
  deliveryId: string;
  recipientMemberId: string;
  status: DirectMessageReceipt['status'];
  scheduledAt: string;
  sentAt: string | null;
  failedAt: string | null;
  createdAt: string;
  acknowledgement: DirectMessageReceipt['acknowledgement'];
};

type DirectMessageTranscriptRow = {
  message_id: string;
  thread_id: string;
  sender_member_id: string | null;
  role: DirectMessageTranscriptEntry['role'];
  message_text: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
  in_reply_to_message_id: string | null;
  delivery_receipts: DirectMessageReceiptRow[] | null;
};

type DirectMessageInboxRow = {
  thread_id: string;
  network_id: string;
  counterpart_member_id: string;
  counterpart_public_name: string;
  counterpart_handle: string | null;
  latest_message_id: string;
  latest_sender_member_id: string;
  latest_role: DirectMessageThreadSummary['latestMessage']['role'];
  latest_message_text: string | null;
  latest_created_at: string;
  message_count: number;
  unread_message_count: number;
  unread_delivery_count: number;
  latest_unread_message_created_at: string | null;
  has_unread: boolean;
};

type DbClient = Pool | PoolClient;

async function applyActorContext(client: DbClient, actorMemberId: string, networkIds: string[]): Promise<void> {
  await client.query(
    `
      select
        set_config('app.actor_member_id', $1, true),
        set_config('app.actor_network_ids', $2, true)
    `,
    [actorMemberId, networkIds.join(',')],
  );
}

async function withActorContext<T>(pool: Pool, actorMemberId: string, networkIds: string[], fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query('begin');
    await applyActorContext(client, actorMemberId, networkIds);
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

function mapActor(rows: ActorRow[]): ActorContext | null {
  if (rows.length === 0) {
    return null;
  }

  const first = rows[0];

  return {
    member: {
      id: first.member_id,
      handle: first.handle,
      publicName: first.public_name,
    },
    globalRoles: first.global_roles ?? [],
    memberships: rows
      .filter((row) => row.network_id && row.membership_id && row.slug && row.network_name && row.role && row.status && row.joined_at)
      .map((row) => ({
        membershipId: row.membership_id as string,
        networkId: row.network_id as string,
        slug: row.slug as string,
        name: row.network_name as string,
        summary: row.network_summary,
        manifestoMarkdown: row.manifesto_markdown,
        role: row.role as MembershipSummary['role'],
        status: row.status as MembershipSummary['status'],
        sponsorMemberId: row.sponsor_member_id,
        joinedAt: row.joined_at as string,
      })),
  };
}

function mapNetworkRow(row: NetworkRow): NetworkSummary {
  return {
    networkId: row.network_id,
    slug: row.slug,
    name: row.name,
    summary: row.summary,
    manifestoMarkdown: row.manifesto_markdown,
    archivedAt: row.archived_at,
    owner: {
      memberId: row.owner_member_id,
      publicName: row.owner_public_name,
      handle: row.owner_handle,
    },
    ownerVersion: {
      versionNo: Number(row.owner_version_no),
      createdAt: row.owner_created_at,
      createdByMemberId: row.owner_created_by_member_id,
    },
  };
}

function mapEmbeddingProjectionRow(row: {
  embedding_id: string | null;
  embedding_model: string | null;
  embedding_dimensions: number | null;
  embedding_source_text: string | null;
  embedding_metadata: Record<string, unknown> | null;
  embedding_created_at: string | null;
}): EmbeddingProjectionSummary | null {
  if (!row.embedding_id || !row.embedding_model || row.embedding_dimensions === null || !row.embedding_source_text || !row.embedding_created_at) {
    return null;
  }

  return {
    embeddingId: row.embedding_id,
    model: row.embedding_model,
    dimensions: Number(row.embedding_dimensions),
    sourceText: row.embedding_source_text,
    metadata: row.embedding_metadata ?? {},
    createdAt: row.embedding_created_at,
  };
}

function mapProfileRow(row: ProfileRow): MemberProfile {
  return {
    memberId: row.member_id,
    publicName: row.public_name,
    handle: row.handle,
    displayName: row.display_name,
    tagline: row.tagline,
    summary: row.summary,
    whatIDo: row.what_i_do,
    knownFor: row.known_for,
    servicesSummary: row.services_summary,
    websiteUrl: row.website_url,
    links: row.links ?? [],
    profile: row.profile ?? {},
    version: {
      id: row.version_id,
      versionNo: row.version_no,
      createdAt: row.version_created_at,
      createdByMemberId: row.version_created_by_member_id,
      embedding: mapEmbeddingProjectionRow(row),
    },
    sharedNetworks: row.shared_networks ?? [],
  };
}

function mapEntityRow(row: EntityRow): EntitySummary {
  return {
    entityId: row.entity_id,
    entityVersionId: row.entity_version_id,
    networkId: row.network_id,
    kind: row.kind,
    author: {
      memberId: row.author_member_id,
      publicName: row.author_public_name,
      handle: row.author_handle,
    },
    version: {
      versionNo: row.version_no,
      state: row.state,
      title: row.title,
      summary: row.summary,
      body: row.body,
      effectiveAt: row.effective_at,
      expiresAt: row.expires_at,
      createdAt: row.version_created_at,
      content: row.content ?? {},
      embedding: mapEmbeddingProjectionRow(row),
    },
    createdAt: row.entity_created_at,
  };
}

function mapPendingDeliveryRow(row: PendingDeliveryRow): PendingDelivery {
  return {
    deliveryId: row.id,
    networkId: row.network_id,
    entityId: row.entity_id,
    entityVersionId: row.entity_version_id,
    transcriptMessageId: row.transcript_message_id,
    topic: row.topic,
    payload: row.payload ?? {},
    createdAt: row.created_at,
    sentAt: row.sent_at,
  };
}

function mapDeliverySummaryRow(row: DeliverySummaryRow): DeliverySummary {
  return {
    deliveryId: row.delivery_id,
    networkId: row.network_id,
    recipientMemberId: row.recipient_member_id,
    endpointId: row.endpoint_id,
    topic: row.topic,
    payload: row.payload ?? {},
    status: row.status,
    attemptCount: Number(row.attempt_count ?? 0),
    entityId: row.entity_id,
    entityVersionId: row.entity_version_id,
    transcriptMessageId: row.transcript_message_id,
    scheduledAt: row.scheduled_at,
    sentAt: row.sent_at,
    failedAt: row.failed_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    acknowledgement:
      row.acknowledgement_id && row.acknowledgement_state && row.acknowledgement_version_no && row.acknowledgement_created_at
        ? {
            acknowledgementId: row.acknowledgement_id,
            state: row.acknowledgement_state,
            suppressionReason: row.acknowledgement_suppression_reason,
            versionNo: Number(row.acknowledgement_version_no),
            createdAt: row.acknowledgement_created_at,
            createdByMemberId: row.acknowledgement_created_by_member_id,
          }
        : null,
  };
}

function mapDeliveryEndpointRow(row: DeliveryEndpointRow): DeliveryEndpointSummary {
  return {
    endpointId: row.endpoint_id,
    memberId: row.member_id,
    channel: row.channel,
    label: row.label,
    endpointUrl: row.endpoint_url,
    sharedSecretRef: row.shared_secret_ref,
    state: row.state,
    lastSuccessAt: row.last_success_at,
    lastFailureAt: row.last_failure_at,
    health: {
      pendingCount: Number(row.pending_count ?? 0),
      processingCount: Number(row.processing_count ?? 0),
      sentCount: Number(row.sent_count ?? 0),
      failedCount: Number(row.failed_count ?? 0),
      canceledCount: Number(row.canceled_count ?? 0),
      lastDeliveryAt: row.last_delivery_at,
    },
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    disabledAt: row.disabled_at,
  };
}

function mapBearerTokenRow(row: BearerTokenRow): BearerTokenSummary {
  return {
    tokenId: row.token_id,
    memberId: row.member_id,
    label: row.label,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    metadata: row.metadata ?? {},
  };
}

function mapDeliveryAcknowledgementRow(row: DeliveryAcknowledgementRow): DeliveryAcknowledgement {
  return {
    acknowledgementId: row.acknowledgement_id,
    deliveryId: row.delivery_id,
    networkId: row.network_id,
    recipientMemberId: row.recipient_member_id,
    state: row.state,
    suppressionReason: row.suppression_reason,
    versionNo: Number(row.version_no),
    supersedesAcknowledgementId: row.supersedes_acknowledgement_id,
    createdAt: row.created_at,
    createdByMemberId: row.created_by_member_id,
  };
}

function mapDeliveryAttemptRow(row: DeliveryAttemptRow): DeliveryAttemptSummary {
  return {
    attemptId: row.attempt_id,
    deliveryId: row.delivery_id,
    networkId: row.network_id,
    endpointId: row.endpoint_id,
    workerKey: row.worker_key,
    status: row.status,
    attemptNo: Number(row.attempt_no),
    responseStatusCode: row.response_status_code === null ? null : Number(row.response_status_code),
    responseBody: row.response_body,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdByMemberId: row.created_by_member_id,
  };
}

function mapDeliveryAttemptInspectionRow(row: DeliveryAttemptInspectionRow): DeliveryAttemptInspection {
  return {
    attempt: mapDeliveryAttemptRow(row),
    delivery: {
      deliveryId: row.delivery_id,
      networkId: row.delivery_network_id,
      recipientMemberId: row.delivery_recipient_member_id,
      endpointId: row.endpoint_id,
      topic: row.delivery_topic,
      status: row.delivery_status,
      attemptCount: Number(row.delivery_attempt_count),
      scheduledAt: row.delivery_scheduled_at,
      sentAt: row.delivery_sent_at,
      failedAt: row.delivery_failed_at,
      lastError: row.delivery_last_error,
      createdAt: row.delivery_created_at,
      recipient: {
        memberId: row.delivery_recipient_member_id,
        publicName: row.recipient_public_name,
        handle: row.recipient_handle,
      },
    },
  };
}

function mapDirectMessageRow(row: DirectMessageRow): DirectMessageSummary {
  return {
    threadId: row.thread_id,
    networkId: row.network_id,
    senderMemberId: row.sender_member_id,
    recipientMemberId: row.recipient_member_id,
    messageId: row.message_id,
    messageText: row.message_text,
    createdAt: row.created_at,
    deliveryCount: Number(row.delivery_count),
  };
}

function mapDirectMessageThreadRow(row: DirectMessageThreadRow): DirectMessageThreadSummary {
  return {
    threadId: row.thread_id,
    networkId: row.network_id,
    counterpartMemberId: row.counterpart_member_id,
    counterpartPublicName: row.counterpart_public_name,
    counterpartHandle: row.counterpart_handle,
    latestMessage: {
      messageId: row.latest_message_id,
      senderMemberId: row.latest_sender_member_id,
      role: row.latest_role,
      messageText: row.latest_message_text,
      createdAt: row.latest_created_at,
    },
    messageCount: Number(row.message_count),
  };
}

function mapDirectMessageTranscriptRow(row: DirectMessageTranscriptRow): DirectMessageTranscriptEntry {
  return {
    messageId: row.message_id,
    threadId: row.thread_id,
    senderMemberId: row.sender_member_id,
    role: row.role,
    messageText: row.message_text,
    payload: row.payload ?? {},
    createdAt: row.created_at,
    inReplyToMessageId: row.in_reply_to_message_id,
    deliveryReceipts: row.delivery_receipts ?? [],
  };
}

function mapDirectMessageInboxRow(row: DirectMessageInboxRow): DirectMessageInboxSummary {
  return {
    threadId: row.thread_id,
    networkId: row.network_id,
    counterpartMemberId: row.counterpart_member_id,
    counterpartPublicName: row.counterpart_public_name,
    counterpartHandle: row.counterpart_handle,
    latestMessage: {
      messageId: row.latest_message_id,
      senderMemberId: row.latest_sender_member_id,
      role: row.latest_role,
      messageText: row.latest_message_text,
      createdAt: row.latest_created_at,
    },
    messageCount: Number(row.message_count),
    unread: {
      hasUnread: row.has_unread,
      unreadMessageCount: Number(row.unread_message_count),
      unreadDeliveryCount: Number(row.unread_delivery_count),
      latestUnreadMessageCreatedAt: row.latest_unread_message_created_at,
    },
  };
}

async function listPendingDeliveries(client: DbClient, actorMemberId: string, accessibleNetworkIds: string[]): Promise<PendingDelivery[]> {
  if (accessibleNetworkIds.length === 0) {
    return [];
  }

  const result = await client.query<PendingDeliveryRow>(
    `
      select
        pd.id,
        pd.network_id,
        pd.entity_id,
        pd.entity_version_id,
        pd.transcript_message_id,
        pd.topic,
        pd.payload,
        pd.created_at::text as created_at,
        pd.sent_at::text as sent_at
      from app.pending_deliveries pd
      where pd.recipient_member_id = $1
        and pd.network_id = any($2::app.short_id[])
      order by coalesce(pd.sent_at, pd.created_at) asc, pd.id asc
    `,
    [actorMemberId, accessibleNetworkIds],
  );

  return result.rows.map(mapPendingDeliveryRow);
}

async function loadDeliveryEndpoint(client: DbClient, endpointId: string): Promise<DeliveryEndpointSummary | null> {
  const result = await client.query<DeliveryEndpointRow>(
    `
      select
        de.id as endpoint_id,
        de.member_id,
        de.channel,
        de.label,
        de.endpoint_url,
        de.shared_secret_ref,
        de.state,
        de.last_success_at::text,
        de.last_failure_at::text,
        de.metadata,
        de.created_at::text,
        de.disabled_at::text
      from app.delivery_endpoints de
      where de.id = $1
      limit 1
    `,
    [endpointId],
  );

  const row = result.rows[0];
  return row ? mapDeliveryEndpointRow(row) : null;
}

async function loadDeliverySummary(client: DbClient, deliveryId: string): Promise<DeliverySummary | null> {
  const result = await client.query<DeliverySummaryRow>(
    `
      select
        cdr.delivery_id,
        cdr.network_id,
        cdr.recipient_member_id,
        cdr.endpoint_id,
        cdr.topic,
        cdr.payload,
        cdr.status,
        cdr.attempt_count,
        cdr.entity_id,
        cdr.entity_version_id,
        cdr.transcript_message_id,
        cdr.scheduled_at::text as scheduled_at,
        cdr.sent_at::text as sent_at,
        cdr.failed_at::text as failed_at,
        cdr.last_error,
        cdr.created_at::text as created_at,
        cdr.acknowledgement_id,
        cdr.acknowledgement_state,
        cdr.acknowledgement_suppression_reason,
        cdr.acknowledgement_version_no,
        cdr.acknowledgement_created_at::text as acknowledgement_created_at,
        cdr.acknowledgement_created_by_member_id
      from app.current_delivery_receipts cdr
      where cdr.delivery_id = $1
    `,
    [deliveryId],
  );

  return result.rows[0] ? mapDeliverySummaryRow(result.rows[0]) : null;
}

async function loadCurrentDeliveryAttempt(client: DbClient, deliveryId: string): Promise<DeliveryAttemptSummary | null> {
  const result = await client.query<DeliveryAttemptRow>(
    `
      select
        cda.id as attempt_id,
        cda.delivery_id,
        cda.network_id,
        cda.endpoint_id,
        cda.worker_key,
        cda.status,
        cda.attempt_no,
        cda.response_status_code,
        cda.response_body,
        cda.error_message,
        cda.started_at::text as started_at,
        cda.finished_at::text as finished_at,
        cda.created_by_member_id
      from app.current_delivery_attempts cda
      where cda.delivery_id = $1
    `,
    [deliveryId],
  );

  return result.rows[0] ? mapDeliveryAttemptRow(result.rows[0]) : null;
}

async function listDeliveries(client: DbClient, input: ListDeliveriesInput): Promise<DeliverySummary[]> {
  if (input.networkIds.length === 0) {
    return [];
  }

  const result = await client.query<DeliverySummaryRow>(
    `
      select
        cdr.delivery_id,
        cdr.network_id,
        cdr.recipient_member_id,
        cdr.endpoint_id,
        cdr.topic,
        cdr.payload,
        cdr.status,
        cdr.attempt_count,
        cdr.entity_id,
        cdr.entity_version_id,
        cdr.transcript_message_id,
        cdr.scheduled_at::text as scheduled_at,
        cdr.sent_at::text as sent_at,
        cdr.failed_at::text as failed_at,
        cdr.last_error,
        cdr.created_at::text as created_at,
        cdr.acknowledgement_id,
        cdr.acknowledgement_state,
        cdr.acknowledgement_suppression_reason,
        cdr.acknowledgement_version_no,
        cdr.acknowledgement_created_at::text as acknowledgement_created_at,
        cdr.acknowledgement_created_by_member_id
      from app.current_delivery_receipts cdr
      where cdr.recipient_member_id = $1
        and cdr.network_id = any($2::app.short_id[])
        and ($3::boolean = false or cdr.acknowledgement_id is null)
      order by coalesce(cdr.sent_at, cdr.created_at) desc, cdr.delivery_id desc
      limit $4
    `,
    [input.actorMemberId, input.networkIds, input.pendingOnly, input.limit],
  );

  return result.rows.map(mapDeliverySummaryRow);
}

async function listDeliveryAttempts(client: DbClient, input: ListDeliveryAttemptsInput): Promise<DeliveryAttemptInspection[]> {
  if (input.networkIds.length === 0) {
    return [];
  }

  const result = await client.query<DeliveryAttemptInspectionRow>(
    `
      select
        da.id as attempt_id,
        da.delivery_id,
        da.network_id,
        da.endpoint_id,
        da.worker_key,
        da.status,
        da.attempt_no,
        da.response_status_code,
        da.response_body,
        da.error_message,
        da.started_at::text as started_at,
        da.finished_at::text as finished_at,
        da.created_by_member_id,
        d.network_id as delivery_network_id,
        d.recipient_member_id as delivery_recipient_member_id,
        m.public_name as recipient_public_name,
        m.handle as recipient_handle,
        d.topic as delivery_topic,
        d.status as delivery_status,
        d.attempt_count as delivery_attempt_count,
        d.scheduled_at::text as delivery_scheduled_at,
        d.sent_at::text as delivery_sent_at,
        d.failed_at::text as delivery_failed_at,
        d.last_error as delivery_last_error,
        d.created_at::text as delivery_created_at
      from app.delivery_attempts da
      join app.deliveries d on d.id = da.delivery_id
      join app.members m on m.id = d.recipient_member_id
      where d.network_id = any($1::app.short_id[])
        and ($2::app.short_id is null or da.endpoint_id = $2)
        and ($3::app.short_id is null or d.recipient_member_id = $3)
        and ($4::app.delivery_status is null or da.status = $4)
      order by da.started_at desc, da.delivery_id desc, da.attempt_no desc
      limit $5
    `,
    [input.networkIds, input.endpointId ?? null, input.recipientMemberId ?? null, input.status ?? null, input.limit],
  );

  return result.rows.map(mapDeliveryAttemptInspectionRow);
}

function mapEventRow(row: EventRow): EventSummary {
  return {
    entityId: row.entity_id,
    entityVersionId: row.entity_version_id,
    networkId: row.network_id,
    author: {
      memberId: row.author_member_id,
      publicName: row.author_public_name,
      handle: row.author_handle,
    },
    version: {
      versionNo: row.version_no,
      state: row.state,
      title: row.title,
      summary: row.summary,
      body: row.body,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      timezone: row.timezone,
      recurrenceRule: row.recurrence_rule,
      capacity: row.capacity,
      effectiveAt: row.effective_at,
      expiresAt: row.expires_at,
      createdAt: row.version_created_at,
      content: row.content ?? {},
    },
    rsvps: {
      viewerResponse: row.viewer_response,
      counts: {
        yes: Number(row.yes_count ?? 0),
        maybe: Number(row.maybe_count ?? 0),
        no: Number(row.no_count ?? 0),
        waitlist: Number(row.waitlist_count ?? 0),
      },
      attendees: row.attendees ?? [],
    },
    createdAt: row.entity_created_at,
  };
}

async function getActorByMemberId(pool: Pool, memberId: string): Promise<ActorContext | null> {
  const result = await pool.query<ActorRow>(
    `
      select
        m.id as member_id,
        m.handle,
        m.public_name,
        coalesce(gr.global_roles, array[]::app.global_role[]) as global_roles,
        anm.id as membership_id,
        anm.network_id,
        n.slug,
        n.name as network_name,
        n.summary as network_summary,
        n.manifesto_markdown,
        anm.role,
        anm.status,
        anm.sponsor_member_id,
        anm.joined_at::text as joined_at
      from app.members m
      left join lateral (
        select array_agg(cmgr.role order by cmgr.role) as global_roles
        from app.current_member_global_roles cmgr
        where cmgr.member_id = m.id
      ) gr on true
      left join app.accessible_network_memberships anm
        on anm.member_id = m.id
      left join app.networks n
        on n.id = anm.network_id
       and n.archived_at is null
      where m.id = $1
        and m.state = 'active'
      order by n.name asc nulls last
    `,
    [memberId],
  );

  return mapActor(result.rows);
}

function mapMembershipVouchRow(row: MembershipVouchRow): MembershipVouchSummary {
  return {
    edgeId: row.edge_id,
    fromMember: {
      memberId: row.from_member_id,
      publicName: row.from_public_name,
      handle: row.from_handle,
    },
    reason: row.reason,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    createdByMemberId: row.created_by_member_id,
  };
}

function mapMembershipReviewRow(row: MembershipReviewRow): MembershipReviewSummary {
  return {
    ...mapMembershipAdminRow(row),
    sponsorStats: {
      activeSponsoredCount: Number(row.sponsor_active_sponsored_count ?? 0),
      sponsoredThisMonthCount: Number(row.sponsor_sponsored_this_month_count ?? 0),
    },
    vouches: (row.vouches ?? []).map(mapMembershipVouchRow),
  };
}

function mapMembershipAdminRow(row: MembershipAdminRow): MembershipAdminSummary {
  return {
    membershipId: row.membership_id,
    networkId: row.network_id,
    member: {
      memberId: row.member_id,
      publicName: row.public_name,
      handle: row.handle,
    },
    sponsor: row.sponsor_member_id
      ? {
          memberId: row.sponsor_member_id,
          publicName: row.sponsor_public_name ?? 'Unknown sponsor',
          handle: row.sponsor_handle,
        }
      : null,
    role: row.role,
    state: {
      status: row.status,
      reason: row.state_reason,
      versionNo: Number(row.state_version_no),
      createdAt: row.state_created_at,
      createdByMemberId: row.state_created_by_member_id,
    },
    joinedAt: row.joined_at,
    acceptedCovenantAt: row.accepted_covenant_at,
    metadata: row.metadata ?? {},
  };
}

function mapApplicationRow(row: ApplicationRow): ApplicationSummary {
  return {
    applicationId: row.application_id,
    networkId: row.network_id,
    applicant: {
      memberId: row.applicant_member_id,
      publicName: row.applicant_public_name,
      handle: row.applicant_handle,
    },
    sponsor: row.sponsor_member_id
      ? {
          memberId: row.sponsor_member_id,
          publicName: row.sponsor_public_name ?? 'Unknown sponsor',
          handle: row.sponsor_handle,
        }
      : null,
    membershipId: row.membership_id,
    activation: {
      linkedMembershipId: row.membership_id,
      membershipStatus: row.linked_membership_status,
      acceptedCovenantAt: row.linked_membership_accepted_covenant_at,
      readyForActivation: row.status === 'accepted' && row.membership_id !== null && row.linked_membership_status === 'pending_review',
    },
    path: row.path,
    intake: {
      kind: row.intake_kind,
      price: {
        amount: row.intake_price_amount === null ? null : Number(row.intake_price_amount),
        currency: row.intake_price_currency,
      },
      bookingUrl: row.intake_booking_url,
      bookedAt: row.intake_booked_at,
      completedAt: row.intake_completed_at,
    },
    state: {
      status: row.status,
      notes: row.notes,
      versionNo: Number(row.version_no),
      createdAt: row.version_created_at,
      createdByMemberId: row.version_created_by_member_id,
    },
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
  };
}

function mapMemberListRow(row: MemberListRow): NetworkMemberSummary {
  return {
    memberId: row.member_id,
    publicName: row.public_name,
    displayName: row.display_name,
    handle: row.handle,
    tagline: row.tagline,
    summary: row.summary,
    whatIDo: row.what_i_do,
    knownFor: row.known_for,
    servicesSummary: row.services_summary,
    websiteUrl: row.website_url,
    memberships: row.memberships ?? [],
  };
}

async function listNetworks(client: DbClient, includeArchived: boolean): Promise<NetworkSummary[]> {
  const result = await client.query<NetworkRow>(
    `
      select
        n.id as network_id,
        n.slug,
        n.name,
        n.summary,
        n.manifesto_markdown,
        n.archived_at::text,
        owner.member_id as owner_member_id,
        m.public_name as owner_public_name,
        m.handle as owner_handle,
        owner.version_no as owner_version_no,
        owner.created_at::text as owner_created_at,
        owner.created_by_member_id as owner_created_by_member_id
      from app.networks n
      join app.current_network_owners owner on owner.network_id = n.id
      join app.members m on m.id = owner.owner_member_id
      where ($1::boolean = true or n.archived_at is null)
      order by n.archived_at asc nulls first, n.name asc, n.id asc
    `,
    [includeArchived],
  );

  return result.rows.map(mapNetworkRow);
}

async function readNetworkSummary(client: DbClient, networkId: string): Promise<NetworkSummary | null> {
  const result = await client.query<NetworkRow>(
    `
      select
        n.id as network_id,
        n.slug,
        n.name,
        n.summary,
        n.manifesto_markdown,
        n.archived_at::text,
        owner.member_id as owner_member_id,
        m.public_name as owner_public_name,
        m.handle as owner_handle,
        owner.version_no as owner_version_no,
        owner.created_at::text as owner_created_at,
        owner.created_by_member_id as owner_created_by_member_id
      from app.networks n
      join app.current_network_owners owner on owner.network_id = n.id
      join app.members m on m.id = owner.owner_member_id
      where n.id = $1
      limit 1
    `,
    [networkId],
  );

  return result.rows[0] ? mapNetworkRow(result.rows[0]) : null;
}

async function readMembershipAdminSummary(client: DbClient, membershipId: string): Promise<MembershipAdminSummary | null> {
  const result = await client.query<MembershipAdminRow>(
    `
      select
        cnm.id as membership_id,
        cnm.network_id,
        cnm.member_id,
        m.public_name,
        m.handle,
        cnm.sponsor_member_id,
        sponsor.public_name as sponsor_public_name,
        sponsor.handle as sponsor_handle,
        cnm.role,
        cnm.status,
        cnm.state_reason,
        cnm.state_version_no,
        cnm.state_created_at::text as state_created_at,
        cnm.state_created_by_member_id,
        cnm.joined_at::text as joined_at,
        cnm.accepted_covenant_at::text as accepted_covenant_at,
        cnm.metadata
      from app.current_network_memberships cnm
      join app.members m on m.id = cnm.member_id
      left join app.members sponsor on sponsor.id = cnm.sponsor_member_id
      where cnm.id = $1
      limit 1
    `,
    [membershipId],
  );

  return result.rows[0] ? mapMembershipAdminRow(result.rows[0]) : null;
}

async function listMemberships(client: DbClient, input: {
  networkIds: string[];
  limit: number;
  status?: MembershipState;
}): Promise<MembershipAdminSummary[]> {
  if (input.networkIds.length === 0) {
    return [];
  }

  const result = await client.query<MembershipAdminRow>(
    `
      select
        cnm.id as membership_id,
        cnm.network_id,
        cnm.member_id,
        m.public_name,
        m.handle,
        cnm.sponsor_member_id,
        sponsor.public_name as sponsor_public_name,
        sponsor.handle as sponsor_handle,
        cnm.role,
        cnm.status,
        cnm.state_reason,
        cnm.state_version_no,
        cnm.state_created_at::text as state_created_at,
        cnm.state_created_by_member_id,
        cnm.joined_at::text as joined_at,
        cnm.accepted_covenant_at::text as accepted_covenant_at,
        cnm.metadata
      from app.current_network_memberships cnm
      join app.members m on m.id = cnm.member_id
      left join app.members sponsor on sponsor.id = cnm.sponsor_member_id
      where cnm.network_id = any($1::app.short_id[])
        and ($2::app.membership_state is null or cnm.status = $2)
      order by cnm.network_id asc, cnm.state_created_at desc, cnm.id asc
      limit $3
    `,
    [input.networkIds, input.status ?? null, input.limit],
  );

  return result.rows.map(mapMembershipAdminRow);
}

async function listMembershipReviews(client: DbClient, input: {
  networkIds: string[];
  limit: number;
  statuses: MembershipState[];
}): Promise<MembershipReviewSummary[]> {
  if (input.networkIds.length === 0 || input.statuses.length === 0) {
    return [];
  }

  const result = await client.query<MembershipReviewRow>(
    `
      select
        cnm.id as membership_id,
        cnm.network_id,
        cnm.member_id,
        m.public_name,
        m.handle,
        cnm.sponsor_member_id,
        sponsor.public_name as sponsor_public_name,
        sponsor.handle as sponsor_handle,
        cnm.role,
        cnm.status,
        cnm.state_reason,
        cnm.state_version_no,
        cnm.state_created_at::text as state_created_at,
        cnm.state_created_by_member_id,
        cnm.joined_at::text as joined_at,
        cnm.accepted_covenant_at::text as accepted_covenant_at,
        cnm.metadata,
        coalesce(sponsor_stats.active_sponsored_count, 0) as sponsor_active_sponsored_count,
        coalesce(sponsor_stats.sponsored_this_month_count, 0) as sponsor_sponsored_this_month_count,
        coalesce(vouches.vouches, '[]'::jsonb) as vouches
      from app.current_network_memberships cnm
      join app.members m on m.id = cnm.member_id
      left join app.members sponsor on sponsor.id = cnm.sponsor_member_id
      left join lateral (
        select
          count(*) filter (where sponsored.status = 'active')::int as active_sponsored_count,
          count(*) filter (where date_trunc('month', sponsored.joined_at) = date_trunc('month', now()))::int as sponsored_this_month_count
        from app.current_network_memberships sponsored
        where sponsored.network_id = cnm.network_id
          and sponsored.sponsor_member_id = cnm.sponsor_member_id
      ) sponsor_stats on cnm.sponsor_member_id is not null
      left join lateral (
        select jsonb_agg(
          jsonb_build_object(
            'edge_id', e.id,
            'from_member_id', fm.id,
            'from_public_name', fm.public_name,
            'from_handle', fm.handle,
            'reason', e.reason,
            'metadata', e.metadata,
            'created_at', e.created_at::text,
            'created_by_member_id', e.created_by_member_id
          )
          order by e.created_at desc, e.id desc
        ) as vouches
        from app.edges e
        join app.members fm on fm.id = e.from_member_id
        where e.network_id = cnm.network_id
          and e.kind = 'vouched_for'
          and e.to_member_id = cnm.member_id
          and e.archived_at is null
      ) vouches on true
      where cnm.network_id = any($1::app.short_id[])
        and cnm.status = any($2::app.membership_state[])
      order by cnm.network_id asc, cnm.state_created_at desc, cnm.id asc
      limit $3
    `,
    [input.networkIds, input.statuses, input.limit],
  );

  return result.rows.map(mapMembershipReviewRow);
}

async function listApplications(client: DbClient, input: {
  networkIds: string[];
  limit: number;
  statuses?: ApplicationStatus[];
}): Promise<ApplicationSummary[]> {
  if (input.networkIds.length === 0) {
    return [];
  }

  const result = await client.query<ApplicationRow>(
    `
      select
        ca.id as application_id,
        ca.network_id,
        ca.applicant_member_id,
        applicant.public_name as applicant_public_name,
        applicant.handle as applicant_handle,
        ca.sponsor_member_id,
        sponsor.public_name as sponsor_public_name,
        sponsor.handle as sponsor_handle,
        ca.membership_id,
        cnm.status as linked_membership_status,
        cnm.accepted_covenant_at::text as linked_membership_accepted_covenant_at,
        ca.path,
        ca.intake_kind,
        ca.intake_price_amount,
        ca.intake_price_currency,
        ca.intake_booking_url,
        ca.intake_booked_at::text as intake_booked_at,
        ca.intake_completed_at::text as intake_completed_at,
        ca.status,
        ca.notes,
        ca.version_no,
        ca.version_created_at::text as version_created_at,
        ca.version_created_by_member_id,
        ca.metadata,
        ca.created_at::text as created_at
      from app.current_applications ca
      join app.members applicant on applicant.id = ca.applicant_member_id
      left join app.members sponsor on sponsor.id = ca.sponsor_member_id
      left join app.current_network_memberships cnm on cnm.id = ca.membership_id
      where ca.network_id = any($1::app.short_id[])
        and ($2::app.application_status[] is null or ca.status = any($2::app.application_status[]))
      order by ca.version_created_at desc, ca.id asc
      limit $3
    `,
    [input.networkIds, input.statuses ?? null, input.limit],
  );

  return result.rows.map(mapApplicationRow);
}

async function readApplicationSummary(client: DbClient, applicationId: string): Promise<ApplicationSummary | null> {
  const result = await client.query<ApplicationRow>(
    `
      select
        ca.id as application_id,
        ca.network_id,
        ca.applicant_member_id,
        applicant.public_name as applicant_public_name,
        applicant.handle as applicant_handle,
        ca.sponsor_member_id,
        sponsor.public_name as sponsor_public_name,
        sponsor.handle as sponsor_handle,
        ca.membership_id,
        cnm.status as linked_membership_status,
        cnm.accepted_covenant_at::text as linked_membership_accepted_covenant_at,
        ca.path,
        ca.intake_kind,
        ca.intake_price_amount,
        ca.intake_price_currency,
        ca.intake_booking_url,
        ca.intake_booked_at::text as intake_booked_at,
        ca.intake_completed_at::text as intake_completed_at,
        ca.status,
        ca.notes,
        ca.version_no,
        ca.version_created_at::text as version_created_at,
        ca.version_created_by_member_id,
        ca.metadata,
        ca.created_at::text as created_at
      from app.current_applications ca
      join app.members applicant on applicant.id = ca.applicant_member_id
      left join app.members sponsor on sponsor.id = ca.sponsor_member_id
      left join app.current_network_memberships cnm on cnm.id = ca.membership_id
      where ca.id = $1
      limit 1
    `,
    [applicationId],
  );

  return result.rows[0] ? mapApplicationRow(result.rows[0]) : null;
}

async function readMemberProfile(client: DbClient, actorMemberId: string, targetMemberId: string): Promise<MemberProfile | null> {
  const result = await client.query<ProfileRow>(
    `
      with actor_scope as (
        select distinct network_id
        from app.accessible_network_memberships
        where member_id = $1
      ),
      target_scope as (
        select distinct anm.network_id
        from app.accessible_network_memberships anm
        join actor_scope ac on ac.network_id = anm.network_id
        where anm.member_id = $2
      )
      select
        m.id as member_id,
        m.public_name,
        m.handle,
        coalesce(cmp.display_name, m.public_name) as display_name,
        cmp.tagline,
        cmp.summary,
        cmp.what_i_do,
        cmp.known_for,
        cmp.services_summary,
        cmp.website_url,
        cmp.links,
        cmp.profile,
        cmp.id as version_id,
        cmp.version_no,
        cmp.created_at::text as version_created_at,
        cmp.created_by_member_id as version_created_by_member_id,
        cpve.id as embedding_id,
        cpve.model as embedding_model,
        cpve.dimensions as embedding_dimensions,
        cpve.source_text as embedding_source_text,
        cpve.metadata as embedding_metadata,
        cpve.created_at::text as embedding_created_at,
        jsonb_agg(distinct jsonb_build_object('id', n.id, 'slug', n.slug, 'name', n.name))
          filter (where n.id is not null) as shared_networks
      from app.members m
      left join app.current_member_profiles cmp on cmp.member_id = m.id
      left join app.current_profile_version_embeddings cpve on cpve.member_profile_version_id = cmp.id
      join target_scope ts on true
      join app.networks n on n.id = ts.network_id and n.archived_at is null
      where m.id = $2
        and m.state = 'active'
      group by
        m.id, m.public_name, m.handle,
        cmp.display_name, cmp.tagline, cmp.summary, cmp.what_i_do, cmp.known_for,
        cmp.services_summary, cmp.website_url, cmp.links, cmp.profile,
        cmp.id, cmp.version_no, cmp.created_at, cmp.created_by_member_id,
        cpve.id, cpve.model, cpve.dimensions, cpve.source_text, cpve.metadata, cpve.created_at
    `,
    [actorMemberId, targetMemberId],
  );

  return result.rows[0] ? mapProfileRow(result.rows[0]) : null;
}

async function readEntitySummary(client: DbClient, entityId: string, entityVersionId?: string): Promise<EntitySummary | null> {
  const result = await client.query<EntityRow>(
    `
      select
        e.id as entity_id,
        cev.id as entity_version_id,
        e.network_id,
        e.kind,
        m.id as author_member_id,
        m.public_name as author_public_name,
        m.handle as author_handle,
        cev.version_no,
        cev.state,
        cev.title,
        cev.summary,
        cev.body,
        cev.effective_at::text as effective_at,
        cev.expires_at::text as expires_at,
        cev.created_at::text as version_created_at,
        cev.content,
        ceve.id as embedding_id,
        ceve.model as embedding_model,
        ceve.dimensions as embedding_dimensions,
        ceve.source_text as embedding_source_text,
        ceve.metadata as embedding_metadata,
        ceve.created_at::text as embedding_created_at,
        e.created_at::text as entity_created_at
      from app.entities e
      join app.current_entity_versions cev on cev.entity_id = e.id
      left join app.current_entity_version_embeddings ceve on ceve.entity_version_id = cev.id
      join app.members m on m.id = e.author_member_id
      where e.id = $1
        and e.archived_at is null
        and e.deleted_at is null
        and ($2::app.short_id is null or cev.id = $2)
    `,
    [entityId, entityVersionId ?? null],
  );

  return result.rows[0] ? mapEntityRow(result.rows[0]) : null;
}

async function readEventSummary(client: DbClient, actorMemberId: string, entityId: string, entityVersionId?: string): Promise<EventSummary | null> {
  const result = await client.query<EventRow>(
    `
      with actor_scope as (
        select distinct network_id
        from app.accessible_network_memberships
        where member_id = $1
      ),
      event_base as (
        select
          e.id as entity_id,
          cev.id as entity_version_id,
          e.network_id,
          e.author_member_id,
          m.public_name as author_public_name,
          m.handle as author_handle,
          cev.version_no,
          cev.state,
          cev.title,
          cev.summary,
          cev.body,
          cev.starts_at::text as starts_at,
          cev.ends_at::text as ends_at,
          cev.timezone,
          cev.recurrence_rule,
          cev.capacity,
          cev.effective_at::text as effective_at,
          cev.expires_at::text as expires_at,
          cev.created_at::text as version_created_at,
          cev.content,
          e.created_at::text as entity_created_at
        from app.entities e
        join actor_scope ac on ac.network_id = e.network_id
        join app.current_entity_versions cev on cev.entity_id = e.id
        join app.members m on m.id = e.author_member_id
        where e.id = $2
          and e.kind = 'event'
          and e.archived_at is null
          and e.deleted_at is null
          and ($3::app.short_id is null or cev.id = $3)
      ),
      attendee_rows as (
        select
          cer.event_entity_id,
          cer.membership_id,
          nm.member_id,
          mem.public_name,
          mem.handle,
          cer.response,
          cer.note,
          cer.created_at::text as created_at
        from app.current_event_rsvps cer
        join app.network_memberships nm on nm.id = cer.membership_id
        join app.members mem on mem.id = nm.member_id
        join event_base eb on eb.entity_id = cer.event_entity_id
      ),
      attendee_agg as (
        select
          event_entity_id,
          jsonb_agg(
            jsonb_build_object(
              'membershipId', membership_id,
              'memberId', member_id,
              'publicName', public_name,
              'handle', handle,
              'response', response,
              'note', note,
              'createdAt', created_at
            )
            order by created_at asc
          ) as attendees,
          count(*) filter (where response = 'yes')::int as yes_count,
          count(*) filter (where response = 'maybe')::int as maybe_count,
          count(*) filter (where response = 'no')::int as no_count,
          count(*) filter (where response = 'waitlist')::int as waitlist_count
        from attendee_rows
        group by event_entity_id
      ),
      viewer_rsvp as (
        select cer.event_entity_id, cer.response
        from app.current_event_rsvps cer
        join app.network_memberships nm on nm.id = cer.membership_id
        where nm.member_id = $1
      )
      select
        eb.*, 
        vr.response as viewer_response,
        coalesce(aa.yes_count, 0) as yes_count,
        coalesce(aa.maybe_count, 0) as maybe_count,
        coalesce(aa.no_count, 0) as no_count,
        coalesce(aa.waitlist_count, 0) as waitlist_count,
        aa.attendees
      from event_base eb
      left join attendee_agg aa on aa.event_entity_id = eb.entity_id
      left join viewer_rsvp vr on vr.event_entity_id = eb.entity_id
    `,
    [actorMemberId, entityId, entityVersionId ?? null],
  );

  return result.rows[0] ? mapEventRow(result.rows[0]) : null;
}

async function listDirectMessageThreads(client: DbClient, actorMemberId: string, networkIds: string[], limit: number): Promise<DirectMessageThreadSummary[]> {
  const result = await client.query<DirectMessageThreadRow>(
    `
      with scope as (
        select unnest($2::text[])::app.short_id as network_id
      ),
      thread_scope as (
        select
          tt.id as thread_id,
          tt.network_id,
          case
            when tt.created_by_member_id = $1 then tt.counterpart_member_id
            else tt.created_by_member_id
          end as counterpart_member_id
        from app.transcript_threads tt
        join scope s on s.network_id = tt.network_id
        where tt.kind = 'dm'
          and tt.archived_at is null
          and $1 in (tt.created_by_member_id, tt.counterpart_member_id)
      ),
      message_ranked as (
        select
          ts.thread_id,
          ts.network_id,
          ts.counterpart_member_id,
          tm.id as latest_message_id,
          tm.sender_member_id as latest_sender_member_id,
          tm.role as latest_role,
          tm.message_text as latest_message_text,
          tm.created_at::text as latest_created_at,
          count(*) over (partition by ts.thread_id)::int as message_count,
          row_number() over (partition by ts.thread_id order by tm.created_at desc, tm.id desc) as row_no
        from thread_scope ts
        join app.transcript_messages tm on tm.thread_id = ts.thread_id
      )
      select
        mr.thread_id,
        mr.network_id,
        mr.counterpart_member_id,
        m.public_name as counterpart_public_name,
        m.handle as counterpart_handle,
        mr.latest_message_id,
        mr.latest_sender_member_id,
        mr.latest_role,
        mr.latest_message_text,
        mr.latest_created_at,
        mr.message_count
      from message_ranked mr
      join app.members m on m.id = mr.counterpart_member_id and m.state = 'active'
      where mr.row_no = 1
      order by mr.latest_created_at desc, mr.thread_id desc
      limit $3
    `,
    [actorMemberId, networkIds, limit],
  );

  return result.rows.map(mapDirectMessageThreadRow);
}

async function listDirectMessageInbox(
  client: DbClient,
  actorMemberId: string,
  networkIds: string[],
  limit: number,
  unreadOnly: boolean,
): Promise<DirectMessageInboxSummary[]> {
  const result = await client.query<DirectMessageInboxRow>(
    `
      with thread_message_counts as (
        select tm.thread_id, count(*)::int as message_count
        from app.transcript_messages tm
        group by tm.thread_id
      )
      select
        inbox.thread_id,
        inbox.network_id,
        inbox.counterpart_member_id,
        m.public_name as counterpart_public_name,
        m.handle as counterpart_handle,
        inbox.latest_message_id,
        inbox.latest_sender_member_id,
        inbox.latest_role,
        inbox.latest_message_text,
        inbox.latest_created_at::text as latest_created_at,
        coalesce(tmc.message_count, 0) as message_count,
        inbox.unread_message_count,
        inbox.unread_delivery_count,
        inbox.latest_unread_message_created_at::text as latest_unread_message_created_at,
        inbox.has_unread
      from app.current_dm_inbox_threads inbox
      join app.members m on m.id = inbox.counterpart_member_id and m.state = 'active'
      left join thread_message_counts tmc on tmc.thread_id = inbox.thread_id
      where inbox.recipient_member_id = $1
        and inbox.network_id = any($2::app.short_id[])
        and ($3::boolean = false or inbox.has_unread)
      order by
        inbox.has_unread desc,
        coalesce(inbox.latest_unread_message_created_at, inbox.latest_created_at) desc,
        inbox.thread_id desc
      limit $4
    `,
    [actorMemberId, networkIds, unreadOnly, limit],
  );

  return result.rows.map(mapDirectMessageInboxRow);
}

async function readDirectMessageThread(
  client: DbClient,
  actorMemberId: string,
  accessibleNetworkIds: string[],
  threadId: string,
  limit: number,
): Promise<{ thread: DirectMessageThreadSummary; messages: DirectMessageTranscriptEntry[] } | null> {
  const threadResult = await client.query<DirectMessageThreadRow>(
    `
      with thread_scope as (
        select
          tt.id as thread_id,
          tt.network_id,
          case
            when tt.created_by_member_id = $1 then tt.counterpart_member_id
            else tt.created_by_member_id
          end as counterpart_member_id
        from app.transcript_threads tt
        where tt.id = $2
          and tt.kind = 'dm'
          and tt.archived_at is null
          and tt.network_id = any($3::app.short_id[])
          and $1 in (tt.created_by_member_id, tt.counterpart_member_id)
      ),
      message_ranked as (
        select
          ts.thread_id,
          ts.network_id,
          ts.counterpart_member_id,
          tm.id as latest_message_id,
          tm.sender_member_id as latest_sender_member_id,
          tm.role as latest_role,
          tm.message_text as latest_message_text,
          tm.created_at::text as latest_created_at,
          count(*) over (partition by ts.thread_id)::int as message_count,
          row_number() over (partition by ts.thread_id order by tm.created_at desc, tm.id desc) as row_no
        from thread_scope ts
        join app.transcript_messages tm on tm.thread_id = ts.thread_id
      )
      select
        mr.thread_id,
        mr.network_id,
        mr.counterpart_member_id,
        m.public_name as counterpart_public_name,
        m.handle as counterpart_handle,
        mr.latest_message_id,
        mr.latest_sender_member_id,
        mr.latest_role,
        mr.latest_message_text,
        mr.latest_created_at,
        mr.message_count
      from message_ranked mr
      join app.members m on m.id = mr.counterpart_member_id and m.state = 'active'
      where mr.row_no = 1
    `,
    [actorMemberId, threadId, accessibleNetworkIds],
  );

  const thread = threadResult.rows[0];
  if (!thread) {
    return null;
  }

  const messagesResult = await client.query<DirectMessageTranscriptRow>(
    `
      select
        tm.id as message_id,
        tm.thread_id,
        tm.sender_member_id,
        tm.role,
        tm.message_text,
        tm.payload,
        tm.created_at::text as created_at,
        tm.in_reply_to_message_id,
        coalesce(receipts.delivery_receipts, '[]'::jsonb) as delivery_receipts
      from app.transcript_messages tm
      left join lateral (
        select jsonb_agg(
          jsonb_build_object(
            'deliveryId', cdr.delivery_id,
            'recipientMemberId', cdr.recipient_member_id,
            'status', cdr.status,
            'scheduledAt', cdr.scheduled_at::text,
            'sentAt', cdr.sent_at::text,
            'failedAt', cdr.failed_at::text,
            'createdAt', cdr.created_at::text,
            'acknowledgement',
              case
                when cdr.acknowledgement_id is null then null
                else jsonb_build_object(
                  'acknowledgementId', cdr.acknowledgement_id,
                  'state', cdr.acknowledgement_state,
                  'suppressionReason', cdr.acknowledgement_suppression_reason,
                  'versionNo', cdr.acknowledgement_version_no,
                  'createdAt', cdr.acknowledgement_created_at::text,
                  'createdByMemberId', cdr.acknowledgement_created_by_member_id
                )
              end
          )
          order by cdr.created_at asc, cdr.delivery_id asc
        ) as delivery_receipts
        from app.current_delivery_receipts cdr
        where cdr.transcript_message_id = tm.id
      ) receipts on true
      where tm.thread_id = $1
      order by tm.created_at desc, tm.id desc
      limit $2
    `,
    [threadId, limit],
  );

  return {
    thread: mapDirectMessageThreadRow(thread),
    messages: messagesResult.rows.map(mapDirectMessageTranscriptRow).reverse(),
  };
}

export function createPostgresRepository({ pool }: { pool: Pool }): Repository {
  return {
    async authenticateBearerToken(bearerToken: string): Promise<AuthResult | null> {
      const parsed = parseBearerToken(bearerToken);
      if (!parsed) {
        return null;
      }

      const tokenResult = await pool.query<{ member_id: string }>(
        `
          update app.member_bearer_tokens mbt
          set last_used_at = now()
          where mbt.id = $1
            and mbt.token_hash = $2
            and mbt.revoked_at is null
          returning mbt.member_id
        `,
        [parsed.tokenId, hashTokenSecret(parsed.secret)],
      );

      const tokenRow = tokenResult.rows[0];
      if (!tokenRow) {
        return null;
      }

      const actor = await getActorByMemberId(pool, tokenRow.member_id);
      if (!actor) {
        return null;
      }

      const activeNetworkIds = actor.memberships.map((membership) => membership.networkId);
      const pendingDeliveries = await withActorContext(pool, actor.member.id, activeNetworkIds, (client) =>
        listPendingDeliveries(client, actor.member.id, activeNetworkIds),
      );

      return {
        actor,
        requestScope: {
          requestedNetworkId: null,
          activeNetworkIds,
        },
        sharedContext: {
          pendingDeliveries,
        },
      };
    },

    async authenticateDeliveryWorkerToken(bearerToken: string): Promise<DeliveryWorkerAuthResult | null> {
      const parsed = parseBearerToken(bearerToken);
      if (!parsed) {
        return null;
      }

      const tokenResult = await pool.query<DeliveryWorkerTokenRow>(
        `
          update app.delivery_worker_tokens dwt
          set last_used_at = now()
          where dwt.id = $1
            and dwt.token_hash = $2
            and dwt.revoked_at is null
          returning
            dwt.id as token_id,
            dwt.actor_member_id,
            dwt.label,
            dwt.allowed_network_ids,
            dwt.metadata
        `,
        [parsed.tokenId, hashTokenSecret(parsed.secret)],
      );

      const tokenRow = tokenResult.rows[0];
      if (!tokenRow) {
        return null;
      }

      const actor = await getActorByMemberId(pool, tokenRow.actor_member_id);
      if (!actor) {
        return null;
      }

      const currentNetworkIds = new Set(actor.memberships.map((membership) => membership.networkId));
      const allowedNetworkIds = (tokenRow.allowed_network_ids ?? []).filter((networkId) => currentNetworkIds.has(networkId));
      if (allowedNetworkIds.length === 0) {
        return null;
      }

      return {
        tokenId: tokenRow.token_id,
        actorMemberId: tokenRow.actor_member_id,
        label: tokenRow.label,
        allowedNetworkIds,
        metadata: tokenRow.metadata ?? {},
      };
    },

    async listNetworks({ actorMemberId, includeArchived }) {
      return withActorContext(pool, actorMemberId, [], (client) => listNetworks(client, includeArchived));
    },

    async createNetwork(input: CreateNetworkInput): Promise<NetworkSummary | null> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await applyActorContext(client, input.actorMemberId, []);

        const networkResult = await client.query<{ network_id: string }>(
          `
            with owner_member as (
              select m.id
              from app.members m
              where m.id = $4
                and m.state = 'active'
            ), inserted_network as (
              insert into app.networks (
                slug,
                name,
                summary,
                owner_member_id,
                manifesto_markdown
              )
              select $1, $2, $3, om.id, $5
              from owner_member om
              returning id as network_id
            ), owner_version as (
              insert into app.network_owner_versions (
                network_id,
                owner_member_id,
                version_no,
                created_by_member_id
              )
              select network_id, $4, 1, $6
              from inserted_network
            )
            select network_id
            from inserted_network
          `,
          [input.slug, input.name, input.summary ?? null, input.ownerMemberId, input.manifestoMarkdown ?? null, input.actorMemberId],
        );

        const networkId = networkResult.rows[0]?.network_id;
        if (!networkId) {
          await client.query('rollback');
          return null;
        }

        await client.query('commit');
        return withActorContext(pool, input.actorMemberId, [], (scopedClient) => readNetworkSummary(scopedClient, networkId));
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async archiveNetwork(input: ArchiveNetworkInput): Promise<NetworkSummary | null> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await applyActorContext(client, input.actorMemberId, []);
        const result = await client.query<{ network_id: string }>(
          `
            update app.networks n
            set archived_at = coalesce(n.archived_at, now())
            where n.id = $1
            returning n.id as network_id
          `,
          [input.networkId],
        );

        const networkId = result.rows[0]?.network_id;
        if (!networkId) {
          await client.query('rollback');
          return null;
        }

        await client.query('commit');
        return withActorContext(pool, input.actorMemberId, [], (scopedClient) => readNetworkSummary(scopedClient, networkId));
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async assignNetworkOwner(input: AssignNetworkOwnerInput): Promise<NetworkSummary | null> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await applyActorContext(client, input.actorMemberId, []);

        const currentResult = await client.query<{ network_id: string; current_owner_version_id: string; current_version_no: number }>(
          `
            select
              n.id as network_id,
              cno.id as current_owner_version_id,
              cno.version_no as current_version_no
            from app.networks n
            join app.current_network_owners cno on cno.network_id = n.id
            join app.members m on m.id = $2 and m.state = 'active'
            where n.id = $1
            limit 1
          `,
          [input.networkId, input.ownerMemberId],
        );

        const current = currentResult.rows[0];
        if (!current) {
          await client.query('rollback');
          return null;
        }

        await client.query(
          `
            insert into app.network_owner_versions (
              network_id,
              owner_member_id,
              version_no,
              supersedes_owner_version_id,
              created_by_member_id
            )
            values ($1, $2, $3, $4, $5)
          `,
          [input.networkId, input.ownerMemberId, Number(current.current_version_no) + 1, current.current_owner_version_id, input.actorMemberId],
        );

        await client.query(
          `update app.networks set owner_member_id = $2 where id = $1`,
          [input.networkId, input.ownerMemberId],
        );

        await client.query('commit');
        return withActorContext(pool, input.actorMemberId, [], (scopedClient) => readNetworkSummary(scopedClient, input.networkId));
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async listMemberships({ actorMemberId, networkIds, limit, status }) {
      return withActorContext(pool, actorMemberId, networkIds, (client) => listMemberships(client, { networkIds, limit, status }));
    },

    async listApplications({ actorMemberId, networkIds, limit, statuses }) {
      return withActorContext(pool, actorMemberId, networkIds, (client) => listApplications(client, { networkIds, limit, statuses }));
    },

    async listMembershipReviews({ actorMemberId, networkIds, limit, statuses }) {
      return withActorContext(pool, actorMemberId, networkIds, (client) => listMembershipReviews(client, { networkIds, limit, statuses }));
    },

    async createApplication(input: CreateApplicationInput): Promise<ApplicationSummary | null> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await applyActorContext(client, input.actorMemberId, [input.networkId]);

        const ownerScopeResult = await client.query<{ membership_id: string }>(
          `
            select anm.id as membership_id
            from app.accessible_network_memberships anm
            where anm.member_id = $1
              and anm.network_id = $2
              and anm.role = 'owner'
            limit 1
          `,
          [input.actorMemberId, input.networkId],
        );

        if (!ownerScopeResult.rows[0]) {
          await client.query('rollback');
          return null;
        }

        const path = input.path;
        if (path === 'sponsored' && !input.sponsorMemberId) {
          throw new AppError(400, 'invalid_application', 'Sponsored applications require sponsorMemberId');
        }

        const sponsorResult = input.sponsorMemberId
          ? await client.query<{ member_id: string }>(
              `
                select cnm.member_id
                from app.current_network_memberships cnm
                where cnm.network_id = $1
                  and cnm.member_id = $2
                  and cnm.status = 'active'
                limit 1
              `,
              [input.networkId, input.sponsorMemberId],
            )
          : { rows: [] };

        if (input.sponsorMemberId && !sponsorResult.rows[0]) {
          await client.query('rollback');
          return null;
        }

        const membershipResult = input.membershipId
          ? await client.query<{ membership_id: string }>(
              `
                select cnm.id as membership_id
                from app.current_network_memberships cnm
                where cnm.id = $1
                  and cnm.network_id = $2
                  and cnm.member_id = $3
                limit 1
              `,
              [input.membershipId, input.networkId, input.applicantMemberId],
            )
          : { rows: [] };

        if (input.membershipId && !membershipResult.rows[0]) {
          await client.query('rollback');
          return null;
        }

        const applicationResult = await client.query<{ application_id: string }>(
          `
            with applicant as (
              select m.id
              from app.members m
              where m.id = $2
                and m.state = 'active'
            ), inserted as (
              insert into app.applications (
                network_id,
                applicant_member_id,
                sponsor_member_id,
                membership_id,
                path,
                metadata
              )
              select $1, applicant.id, $3, $4, $5, $6::jsonb
              from applicant
              returning id as application_id
            ), version_insert as (
              insert into app.application_versions (
                application_id,
                status,
                notes,
                intake_kind,
                intake_price_amount,
                intake_price_currency,
                intake_booking_url,
                intake_booked_at,
                intake_completed_at,
                version_no,
                created_by_member_id
              )
              select
                application_id,
                $7,
                $8,
                $9,
                $10,
                $11,
                $12,
                $13,
                $14,
                1,
                $15
              from inserted
            )
            select application_id
            from inserted
          `,
          [
            input.networkId,
            input.applicantMemberId,
            input.sponsorMemberId ?? null,
            input.membershipId ?? null,
            input.path,
            JSON.stringify(input.metadata ?? {}),
            input.initialStatus,
            input.notes ?? null,
            input.intake.kind ?? (path === 'sponsored' ? 'fit_check' : 'advice_call'),
            input.intake.price?.amount ?? null,
            input.intake.price?.currency ?? (path === 'sponsored' ? 'GBP' : 'GBP'),
            input.intake.bookingUrl ?? null,
            input.intake.bookedAt ?? null,
            input.intake.completedAt ?? null,
            input.actorMemberId,
          ],
        );

        const applicationId = applicationResult.rows[0]?.application_id;
        if (!applicationId) {
          await client.query('rollback');
          return null;
        }

        await client.query('commit');
        return await withActorContext(pool, input.actorMemberId, [input.networkId], (scopedClient) => readApplicationSummary(scopedClient, applicationId));
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async createMembership(input: CreateMembershipInput): Promise<MembershipAdminSummary | null> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await applyActorContext(client, input.actorMemberId, [input.networkId]);

        const adminScopeResult = await client.query<{ role: MembershipSummary['role'] }>(
          `
            select anm.role
            from app.accessible_network_memberships anm
            where anm.member_id = $1
              and anm.network_id = $2
              and anm.role = 'owner'
            limit 1
          `,
          [input.actorMemberId, input.networkId],
        );

        if (!adminScopeResult.rows[0]) {
          await client.query('rollback');
          return null;
        }

        const actorIsSponsor = input.sponsorMemberId === input.actorMemberId;
        const sponsorScopeResult = await client.query<{ membership_id: string }>(
          `
            select cnm.id as membership_id
            from app.current_network_memberships cnm
            where cnm.network_id = $1
              and cnm.member_id = $2
              and cnm.status = 'active'
            limit 1
          `,
          [input.networkId, input.sponsorMemberId],
        );

        if (!sponsorScopeResult.rows[0] || (!actorIsSponsor && adminScopeResult.rows[0].role !== 'owner')) {
          await client.query('rollback');
          return null;
        }

        const existingResult = await client.query<{ id: string }>(
          `
            select nm.id
            from app.network_memberships nm
            where nm.network_id = $1
              and nm.member_id = $2
            limit 1
          `,
          [input.networkId, input.memberId],
        );

        if (existingResult.rows[0]) {
          throw new AppError(409, 'membership_exists', 'This member already has a membership record in the network');
        }

        const membershipResult = await client.query<{ id: string }>(
          `
            insert into app.network_memberships (
              network_id,
              member_id,
              sponsor_member_id,
              role,
              status,
              joined_at,
              metadata
            )
            select $1, m.id, $2, $3, $4, now(), $5::jsonb
            from app.members m
            where m.id = $6
              and m.state = 'active'
            returning id
          `,
          [
            input.networkId,
            input.sponsorMemberId,
            input.role,
            input.initialStatus,
            JSON.stringify(input.metadata ?? {}),
            input.memberId,
          ],
        );

        const membershipId = membershipResult.rows[0]?.id;
        if (!membershipId) {
          await client.query('rollback');
          return null;
        }

        await client.query(
          `
            insert into app.network_membership_state_versions (
              membership_id,
              status,
              reason,
              version_no,
              created_by_member_id
            )
            values ($1, $2, $3, 1, $4)
          `,
          [membershipId, input.initialStatus, input.reason ?? null, input.actorMemberId],
        );

        await client.query('commit');
        return await withActorContext(pool, input.actorMemberId, [input.networkId], (scopedClient) => readMembershipAdminSummary(scopedClient, membershipId));
      } catch (error) {
        await client.query('rollback');
        if (error && typeof error === 'object' && 'code' in error && error.code === '23514') {
          throw new AppError(400, 'invalid_membership', 'Membership invariants rejected this create request');
        }
        throw error;
      } finally {
        client.release();
      }
    },

    async transitionMembershipState(input: TransitionMembershipInput): Promise<MembershipAdminSummary | null> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await applyActorContext(client, input.actorMemberId, input.accessibleNetworkIds);

        const membershipResult = await client.query<{
          membership_id: string;
          network_id: string;
          member_id: string;
          current_status: MembershipState;
          current_version_no: number;
          current_state_version_id: string;
        }>(
          `
            select
              cnm.id as membership_id,
              cnm.network_id,
              cnm.member_id,
              cnm.status as current_status,
              cnm.state_version_no as current_version_no,
              cnm.state_version_id as current_state_version_id
            from app.current_network_memberships cnm
            join app.accessible_network_memberships owner_scope
              on owner_scope.network_id = cnm.network_id
             and owner_scope.member_id = $1
             and owner_scope.role = 'owner'
            where cnm.id = $2
              and cnm.network_id = any($3::app.short_id[])
            limit 1
          `,
          [input.actorMemberId, input.membershipId, input.accessibleNetworkIds],
        );

        const membership = membershipResult.rows[0];
        if (!membership) {
          await client.query('rollback');
          return null;
        }

        if (membership.member_id === input.actorMemberId && input.nextStatus !== 'active' && input.nextStatus !== membership.current_status) {
          throw new AppError(403, 'forbidden', 'Admins may not self-revoke or self-reject through this surface');
        }

        await client.query(
          `
            insert into app.network_membership_state_versions (
              membership_id,
              status,
              reason,
              version_no,
              supersedes_state_version_id,
              created_by_member_id
            )
            values ($1, $2, $3, $4, $5, $6)
          `,
          [
            membership.membership_id,
            input.nextStatus,
            input.reason ?? null,
            Number(membership.current_version_no) + 1,
            membership.current_state_version_id,
            input.actorMemberId,
          ],
        );

        await client.query('commit');
        return await withActorContext(pool, input.actorMemberId, input.accessibleNetworkIds, (scopedClient) =>
          readMembershipAdminSummary(scopedClient, membership.membership_id),
        );
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async transitionApplication(input: TransitionApplicationInput): Promise<ApplicationSummary | null> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await applyActorContext(client, input.actorMemberId, input.accessibleNetworkIds);

        const applicationResult = await client.query<{
          application_id: string;
          network_id: string;
          applicant_member_id: string;
          current_status: ApplicationStatus;
          current_version_no: number;
          current_version_id: string;
          current_metadata: Record<string, unknown> | null;
          current_intake_kind: 'fit_check' | 'advice_call' | 'other';
          current_intake_price_amount: string | number | null;
          current_intake_price_currency: string | null;
          current_intake_booking_url: string | null;
          current_intake_booked_at: string | null;
          current_intake_completed_at: string | null;
          current_membership_id: string | null;
        }>(
          `
            select
              ca.id as application_id,
              ca.network_id,
              ca.applicant_member_id,
              ca.status as current_status,
              ca.version_no as current_version_no,
              ca.version_id as current_version_id,
              ca.metadata as current_metadata,
              ca.intake_kind as current_intake_kind,
              ca.intake_price_amount as current_intake_price_amount,
              ca.intake_price_currency as current_intake_price_currency,
              ca.intake_booking_url as current_intake_booking_url,
              ca.intake_booked_at::text as current_intake_booked_at,
              ca.intake_completed_at::text as current_intake_completed_at,
              ca.membership_id as current_membership_id
            from app.current_applications ca
            join app.accessible_network_memberships owner_scope
              on owner_scope.network_id = ca.network_id
             and owner_scope.member_id = $1
             and owner_scope.role = 'owner'
            where ca.id = $2
              and ca.network_id = any($3::app.short_id[])
            limit 1
          `,
          [input.actorMemberId, input.applicationId, input.accessibleNetworkIds],
        );

        const application = applicationResult.rows[0];
        if (!application) {
          await client.query('rollback');
          return null;
        }

        if (input.membershipId !== undefined && input.membershipId !== null) {
          const membershipResult = await client.query<{ membership_id: string }>(
            `
              select cnm.id as membership_id
              from app.current_network_memberships cnm
              where cnm.id = $1
                and cnm.network_id = $2
                and cnm.member_id = $3
              limit 1
            `,
            [input.membershipId, application.network_id, application.applicant_member_id],
          );

          if (!membershipResult.rows[0]) {
            await client.query('rollback');
            return null;
          }
        }

        const mergedMetadata = {
          ...(application.current_metadata ?? {}),
          ...(input.metadataPatch ?? {}),
        };

        const resolvedMembershipId = input.membershipId === undefined ? application.current_membership_id : input.membershipId;
        const resolvedCompletedAt = input.intake?.completedAt === undefined ? application.current_intake_completed_at : input.intake.completedAt;

        if (input.activateMembership) {
          if (input.nextStatus !== 'accepted') {
            throw new AppError(409, 'activation_requires_accepted_application', 'Membership activation requires the application status to be accepted');
          }

          if (!resolvedMembershipId) {
            throw new AppError(409, 'activation_requires_membership', 'Membership activation requires a linked membership');
          }

          if (!resolvedCompletedAt) {
            throw new AppError(409, 'activation_requires_completed_interview', 'Membership activation requires interview completion metadata');
          }
        }

        await client.query(
          `
            update app.applications a
            set membership_id = $2,
                metadata = $3::jsonb
            where a.id = $1
          `,
          [application.application_id, resolvedMembershipId, JSON.stringify(mergedMetadata)],
        );

        await client.query(
          `
            insert into app.application_versions (
              application_id,
              status,
              notes,
              intake_kind,
              intake_price_amount,
              intake_price_currency,
              intake_booking_url,
              intake_booked_at,
              intake_completed_at,
              version_no,
              supersedes_version_id,
              created_by_member_id
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          `,
          [
            application.application_id,
            input.nextStatus,
            input.notes ?? null,
            input.intake?.kind ?? application.current_intake_kind,
            input.intake?.price?.amount === undefined ? application.current_intake_price_amount : input.intake.price.amount,
            input.intake?.price?.currency === undefined ? application.current_intake_price_currency : input.intake.price.currency,
            input.intake?.bookingUrl === undefined ? application.current_intake_booking_url : input.intake.bookingUrl,
            input.intake?.bookedAt === undefined ? application.current_intake_booked_at : input.intake.bookedAt,
            resolvedCompletedAt,
            Number(application.current_version_no) + 1,
            application.current_version_id,
            input.actorMemberId,
          ],
        );

        if (input.activateMembership) {
          const membershipResult = await client.query<{
            membership_id: string;
            current_status: MembershipState;
            current_version_no: number;
            current_state_version_id: string;
          }>(
            `
              select
                cnm.id as membership_id,
                cnm.status as current_status,
                cnm.state_version_no as current_version_no,
                cnm.state_version_id as current_state_version_id
              from app.current_network_memberships cnm
              join app.accessible_network_memberships owner_scope
                on owner_scope.network_id = cnm.network_id
               and owner_scope.member_id = $1
               and owner_scope.role = 'owner'
              where cnm.id = $2
                and cnm.network_id = any($3::app.short_id[])
              limit 1
            `,
            [input.actorMemberId, resolvedMembershipId, input.accessibleNetworkIds],
          );

          const membership = membershipResult.rows[0];
          if (!membership) {
            await client.query('rollback');
            return null;
          }

          if (membership.current_status !== 'pending_review') {
            throw new AppError(409, 'membership_not_ready_for_activation', 'Only pending-review memberships can be activated through this flow');
          }

          await client.query(
            `
              insert into app.network_membership_state_versions (
                membership_id,
                status,
                reason,
                version_no,
                supersedes_state_version_id,
                created_by_member_id
              )
              values ($1, 'active', $2, $3, $4, $5)
            `,
            [
              membership.membership_id,
              input.activationReason ?? input.notes ?? 'Activated from accepted application',
              Number(membership.current_version_no) + 1,
              membership.current_state_version_id,
              input.actorMemberId,
            ],
          );
        }

        await client.query('commit');
        return await withActorContext(pool, input.actorMemberId, input.accessibleNetworkIds, (scopedClient) => readApplicationSummary(scopedClient, application.application_id));
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async searchMembers({ networkIds, query, limit }): Promise<MemberSearchResult[]> {
      const trimmedQuery = query.trim();
      const tokens = tokenizeSearchQuery(trimmedQuery);
      const likePattern = `%${trimmedQuery}%`;
      const candidateLimit = Math.min(Math.max(limit * 5, 25), 100);

      const result = await pool.query<SearchRow>(
        `
          with scope as (
            select unnest($1::text[])::app.short_id as network_id
          ),
          tokens as (
            select unnest($3::text[]) as token
          )
          select
            m.id as member_id,
            m.public_name,
            coalesce(cmp.display_name, m.public_name) as display_name,
            m.handle,
            cmp.tagline,
            cmp.summary,
            cmp.what_i_do,
            cmp.known_for,
            cmp.services_summary,
            cmp.website_url,
            jsonb_agg(distinct jsonb_build_object('id', n.id, 'slug', n.slug, 'name', n.name))
              filter (where n.id is not null) as shared_networks
          from scope s
          join app.accessible_network_memberships anm on anm.network_id = s.network_id
          join app.members m on m.id = anm.member_id and m.state = 'active'
          left join app.current_member_profiles cmp on cmp.member_id = m.id
          join app.networks n on n.id = anm.network_id and n.archived_at is null
          where (
            m.public_name ilike $2
            or coalesce(cmp.display_name, '') ilike $2
            or coalesce(m.handle, '') ilike $2
            or coalesce(cmp.tagline, '') ilike $2
            or coalesce(cmp.summary, '') ilike $2
            or coalesce(cmp.what_i_do, '') ilike $2
            or coalesce(cmp.known_for, '') ilike $2
            or coalesce(cmp.services_summary, '') ilike $2
          )
            and not exists (
              select 1
              from tokens t
              where not (
                m.public_name ilike '%' || t.token || '%'
                or coalesce(cmp.display_name, '') ilike '%' || t.token || '%'
                or coalesce(m.handle, '') ilike '%' || t.token || '%'
                or coalesce(cmp.tagline, '') ilike '%' || t.token || '%'
                or coalesce(cmp.summary, '') ilike '%' || t.token || '%'
                or coalesce(cmp.what_i_do, '') ilike '%' || t.token || '%'
                or coalesce(cmp.known_for, '') ilike '%' || t.token || '%'
                or coalesce(cmp.services_summary, '') ilike '%' || t.token || '%'
              )
            )
          group by
            m.id, m.public_name, cmp.display_name, m.handle, cmp.tagline, cmp.summary,
            cmp.what_i_do, cmp.known_for, cmp.services_summary, cmp.website_url
          order by display_name asc, m.id asc
          limit $4
        `,
        [networkIds, likePattern, tokens, candidateLimit],
      );

      return result.rows
        .map((row) => ({ row, score: scoreMemberSearchRow(row, trimmedQuery, tokens) }))
        .sort((left, right) => {
          if (right.score !== left.score) {
            return right.score - left.score;
          }

          const displayNameComparison = left.row.display_name.localeCompare(right.row.display_name, 'en', { sensitivity: 'base' });
          if (displayNameComparison !== 0) {
            return displayNameComparison;
          }

          return left.row.member_id.localeCompare(right.row.member_id, 'en', { sensitivity: 'base' });
        })
        .slice(0, limit)
        .map(({ row }) => ({
          memberId: row.member_id,
          publicName: row.public_name,
          displayName: row.display_name,
          handle: row.handle,
          tagline: row.tagline,
          summary: row.summary,
          whatIDo: row.what_i_do,
          knownFor: row.known_for,
          servicesSummary: row.services_summary,
          websiteUrl: row.website_url,
          sharedNetworks: row.shared_networks ?? [],
        }));
    },

    async listMembers({ networkIds, limit }) {
      const result = await pool.query<MemberListRow>(
        `
          with scope as (
            select unnest($1::text[])::app.short_id as network_id
          )
          select
            m.id as member_id,
            m.public_name,
            coalesce(cmp.display_name, m.public_name) as display_name,
            m.handle,
            cmp.tagline,
            cmp.summary,
            cmp.what_i_do,
            cmp.known_for,
            cmp.services_summary,
            cmp.website_url,
            jsonb_agg(
              distinct jsonb_build_object(
                'membershipId', anm.id,
                'networkId', anm.network_id,
                'slug', n.slug,
                'name', n.name,
                'summary', n.summary,
                'manifestoMarkdown', n.manifesto_markdown,
                'role', anm.role,
                'status', anm.status,
                'sponsorMemberId', anm.sponsor_member_id,
                'joinedAt', anm.joined_at::text
              )
            ) filter (where anm.id is not null) as memberships
          from scope s
          join app.accessible_network_memberships anm on anm.network_id = s.network_id
          join app.members m on m.id = anm.member_id and m.state = 'active'
          join app.networks n on n.id = anm.network_id and n.archived_at is null
          left join app.current_member_profiles cmp on cmp.member_id = m.id
          group by
            m.id, m.public_name, cmp.display_name, m.handle, cmp.tagline, cmp.summary,
            cmp.what_i_do, cmp.known_for, cmp.services_summary, cmp.website_url
          order by min(n.name) asc, display_name asc, m.id asc
          limit $2
        `,
        [networkIds, limit],
      );

      return result.rows.map(mapMemberListRow);
    },

    async getMemberProfile({ actorMemberId, targetMemberId }) {
      const actor = await getActorByMemberId(pool, actorMemberId);
      const networkIds = actor?.memberships.map((membership) => membership.networkId) ?? [];
      return withActorContext(pool, actorMemberId, networkIds, (client) => readMemberProfile(client, actorMemberId, targetMemberId));
    },

    async updateOwnProfile({ actor, patch }: { actor: ActorContext; patch: UpdateOwnProfileInput }): Promise<MemberProfile> {
      const client = await pool.connect();

      try {
        await client.query('begin');
        await applyActorContext(client, actor.member.id, actor.memberships.map((membership) => membership.networkId));

        if (patch.handle !== undefined) {
          await client.query(`update app.members set handle = $2 where id = $1`, [actor.member.id, patch.handle]);
        }

        const currentResult = await client.query<{
          public_name: string;
          display_name: string | null;
          tagline: string | null;
          summary: string | null;
          what_i_do: string | null;
          known_for: string | null;
          services_summary: string | null;
          website_url: string | null;
          links: unknown[] | null;
          profile: Record<string, unknown> | null;
          version_no: number | null;
        }>(
          `
            select
              m.public_name,
              cmp.display_name,
              cmp.tagline,
              cmp.summary,
              cmp.what_i_do,
              cmp.known_for,
              cmp.services_summary,
              cmp.website_url,
              cmp.links,
              cmp.profile,
              cmp.version_no
            from app.members m
            left join app.current_member_profiles cmp on cmp.member_id = m.id
            where m.id = $1
              and m.state = 'active'
          `,
          [actor.member.id],
        );

        const current = currentResult.rows[0];
        if (!current) {
          throw new Error('Actor member disappeared during profile update');
        }

        await client.query(
          `
            insert into app.member_profile_versions (
              member_id, version_no, display_name, tagline, summary, what_i_do, known_for,
              services_summary, website_url, links, profile, created_by_member_id
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12)
          `,
          [
            actor.member.id,
            (current.version_no ?? 0) + 1,
            patch.displayName ?? current.display_name ?? current.public_name,
            patch.tagline !== undefined ? patch.tagline : current.tagline,
            patch.summary !== undefined ? patch.summary : current.summary,
            patch.whatIDo !== undefined ? patch.whatIDo : current.what_i_do,
            patch.knownFor !== undefined ? patch.knownFor : current.known_for,
            patch.servicesSummary !== undefined ? patch.servicesSummary : current.services_summary,
            patch.websiteUrl !== undefined ? patch.websiteUrl : current.website_url,
            JSON.stringify(patch.links !== undefined ? patch.links : current.links ?? []),
            JSON.stringify(patch.profile !== undefined ? patch.profile : current.profile ?? {}),
            actor.member.id,
          ],
        );

        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        if (
          error && typeof error === 'object' && 'code' in error && error.code === '23505' &&
          'constraint' in error && error.constraint === 'members_handle_key'
        ) {
          throw new AppError(409, 'handle_conflict', 'That handle is already taken');
        }
        throw error;
      } finally {
        client.release();
      }

      const updated = await withActorContext(
        pool,
        actor.member.id,
        actor.memberships.map((membership) => membership.networkId),
        (scopedClient) => readMemberProfile(scopedClient, actor.member.id, actor.member.id),
      );
      if (!updated) {
        throw new Error('Updated profile could not be reloaded');
      }
      return updated;
    },

    async createEntity(input: CreateEntityInput): Promise<EntitySummary> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await applyActorContext(client, input.authorMemberId, [input.networkId]);
        const entityResult = await client.query<{ id: string; created_at: string }>(
          `insert into app.entities (network_id, kind, author_member_id) values ($1, $2, $3) returning id, created_at::text`,
          [input.networkId, input.kind, input.authorMemberId],
        );
        const entity = entityResult.rows[0]!;
        const versionResult = await client.query<{ id: string }>(
          `
            insert into app.entity_versions (
              entity_id, version_no, state, title, summary, body, expires_at, content, created_by_member_id
            )
            values ($1, 1, 'published', $2, $3, $4, $5, $6::jsonb, $7)
            returning id
          `,
          [entity.id, input.title, input.summary, input.body, input.expiresAt, JSON.stringify(input.content), input.authorMemberId],
        );
        await client.query('commit');

        const summary = await withActorContext(pool, input.authorMemberId, [input.networkId], (scopedClient) =>
          readEntitySummary(scopedClient, entity.id, versionResult.rows[0]!.id),
        );
        if (!summary) {
          throw new Error('Created entity could not be reloaded');
        }
        return summary;
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async updateEntity(input: UpdateEntityInput): Promise<EntitySummary | null> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await applyActorContext(client, input.actorMemberId, input.accessibleNetworkIds);

        const currentResult = await client.query<{
          entity_id: string;
          network_id: string;
          author_member_id: string;
          version_id: string;
          version_no: number;
          title: string | null;
          summary: string | null;
          body: string | null;
          expires_at: string | null;
          content: Record<string, unknown> | null;
        }>(
          `
            select
              e.id as entity_id,
              e.network_id,
              e.author_member_id,
              cev.id as version_id,
              cev.version_no,
              cev.title,
              cev.summary,
              cev.body,
              cev.expires_at::text as expires_at,
              cev.content
            from app.entities e
            join app.current_entity_versions cev on cev.entity_id = e.id
            where e.id = $1
              and e.network_id = any($2::app.short_id[])
              and e.archived_at is null
              and e.deleted_at is null
          `,
          [input.entityId, input.accessibleNetworkIds],
        );

        const current = currentResult.rows[0];
        if (!current) {
          await client.query('rollback');
          return null;
        }

        const nextVersionResult = await client.query<{ id: string }>(
          `
            insert into app.entity_versions (
              entity_id,
              version_no,
              state,
              title,
              summary,
              body,
              expires_at,
              content,
              supersedes_version_id,
              created_by_member_id
            )
            values ($1, $2, 'published', $3, $4, $5, $6, $7::jsonb, $8, $9)
            returning id
          `,
          [
            current.entity_id,
            current.version_no + 1,
            input.patch.title !== undefined ? input.patch.title : current.title,
            input.patch.summary !== undefined ? input.patch.summary : current.summary,
            input.patch.body !== undefined ? input.patch.body : current.body,
            input.patch.expiresAt !== undefined ? input.patch.expiresAt : current.expires_at,
            JSON.stringify(input.patch.content !== undefined ? input.patch.content : current.content ?? {}),
            current.version_id,
            input.actorMemberId,
          ],
        );

        await client.query('commit');

        const summary = await withActorContext(pool, input.actorMemberId, input.accessibleNetworkIds, (scopedClient) =>
          readEntitySummary(scopedClient, current.entity_id, nextVersionResult.rows[0]!.id),
        );
        if (!summary) {
          throw new Error('Updated entity could not be reloaded');
        }
        return summary;
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async createEvent(input: CreateEventInput): Promise<EventSummary> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await applyActorContext(client, input.authorMemberId, [input.networkId]);
        const entityResult = await client.query<{ id: string }>(
          `insert into app.entities (network_id, kind, author_member_id) values ($1, 'event', $2) returning id`,
          [input.networkId, input.authorMemberId],
        );
        const entityId = entityResult.rows[0]!.id;
        const versionResult = await client.query<{ id: string }>(
          `
            insert into app.entity_versions (
              entity_id, version_no, state, title, summary, body, starts_at, ends_at, timezone,
              recurrence_rule, capacity, expires_at, content, created_by_member_id
            )
            values ($1, 1, 'published', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
            returning id
          `,
          [
            entityId,
            input.title,
            input.summary,
            input.body,
            input.startsAt,
            input.endsAt,
            input.timezone,
            input.recurrenceRule,
            input.capacity,
            input.expiresAt,
            JSON.stringify(input.content),
            input.authorMemberId,
          ],
        );
        await client.query('commit');

        const event = await withActorContext(pool, input.authorMemberId, [input.networkId], (scopedClient) =>
          readEventSummary(scopedClient, input.authorMemberId, entityId, versionResult.rows[0]!.id),
        );
        if (!event) {
          throw new Error('Created event could not be reloaded');
        }
        return event;
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async listEvents({ actorMemberId, networkIds, limit, query }: ListEventsInput): Promise<EventSummary[]> {
      return withActorContext(pool, actorMemberId, networkIds, async (client) => {
        const trimmedQuery = query?.trim();
        const likePattern = trimmedQuery ? `%${trimmedQuery}%` : null;
        const prefixPattern = trimmedQuery ? `${trimmedQuery}%` : null;

        const result = await client.query<{ entity_id: string }>(
        `
          with scope as (
            select unnest($1::text[])::app.short_id as network_id
          )
          select le.entity_id
          from scope s
          join app.live_entities le on le.network_id = s.network_id
          where le.kind = 'event'
            and (
              $3::text is null
              or coalesce(le.title, '') ilike $3
              or coalesce(le.summary, '') ilike $3
              or coalesce(le.body, '') ilike $3
            )
          order by
            case
              when $2::text is null then 0
              when lower(coalesce(le.title, '')) = lower($2::text) then 400
              when lower(coalesce(le.title, '')) like lower($4::text) then 250
              when lower(coalesce(le.summary, '')) like lower($4::text) then 175
              when lower(coalesce(le.body, '')) like lower($4::text) then 120
              when coalesce(le.title, '') ilike $3 then 90
              when coalesce(le.summary, '') ilike $3 then 60
              when coalesce(le.body, '') ilike $3 then 30
              else 0
            end desc,
            coalesce(le.starts_at, le.effective_at) asc,
            le.entity_id asc
          limit $5
        `,
        [networkIds, trimmedQuery ?? null, likePattern, prefixPattern, limit],
      );

        const events = await Promise.all(result.rows.map((row) => readEventSummary(client, actorMemberId, row.entity_id)));
        return events.filter((event): event is EventSummary => event !== null);
      });
    },

    async rsvpEvent(input: RsvpEventInput): Promise<EventSummary | null> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await applyActorContext(client, input.actorMemberId, input.accessibleMemberships.map((membership) => membership.networkId));
        const eventResult = await client.query<{ entity_id: string; network_id: string }>(
          `
            select e.id as entity_id, e.network_id
            from app.entities e
            where e.id = $1
              and e.kind = 'event'
              and e.archived_at is null
              and e.deleted_at is null
          `,
          [input.eventEntityId],
        );
        const eventRow = eventResult.rows[0];
        if (!eventRow) {
          await client.query('rollback');
          return null;
        }

        const membership = input.accessibleMemberships.find((item) => item.networkId === eventRow.network_id);
        if (!membership) {
          await client.query('rollback');
          return null;
        }

        const currentResult = await client.query<{ id: string; version_no: number }>(
          `
            select id, version_no
            from app.current_event_rsvps
            where event_entity_id = $1
              and membership_id = $2
          `,
          [input.eventEntityId, membership.membershipId],
        );

        const current = currentResult.rows[0];
        await client.query(
          `
            insert into app.event_rsvps (
              event_entity_id, membership_id, response, note, version_no, supersedes_rsvp_id, created_by_member_id
            )
            values ($1, $2, $3, $4, $5, $6, $7)
          `,
          [
            input.eventEntityId,
            membership.membershipId,
            input.response,
            input.note ?? null,
            (current?.version_no ?? 0) + 1,
            current?.id ?? null,
            input.actorMemberId,
          ],
        );

        await client.query('commit');
        return await withActorContext(
          pool,
          input.actorMemberId,
          input.accessibleMemberships.map((membership) => membership.networkId),
          (scopedClient) => readEventSummary(scopedClient, input.actorMemberId, input.eventEntityId),
        );
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },


    async listDeliveryEndpoints({ actorMemberId }: { actorMemberId: string }): Promise<DeliveryEndpointSummary[]> {
      const result = await pool.query<DeliveryEndpointRow>(
        `
          select
            dep.id as endpoint_id,
            dep.member_id,
            dep.channel,
            dep.label,
            dep.endpoint_url,
            dep.shared_secret_ref,
            dep.state,
            dep.last_success_at::text as last_success_at,
            dep.last_failure_at::text as last_failure_at,
            coalesce(count(*) filter (where d.status = 'pending'), 0) as pending_count,
            coalesce(count(*) filter (where d.status = 'processing'), 0) as processing_count,
            coalesce(count(*) filter (where d.status = 'sent'), 0) as sent_count,
            coalesce(count(*) filter (where d.status = 'failed'), 0) as failed_count,
            coalesce(count(*) filter (where d.status = 'canceled'), 0) as canceled_count,
            max(d.created_at)::text as last_delivery_at,
            dep.metadata,
            dep.created_at::text as created_at,
            dep.disabled_at::text as disabled_at
          from app.delivery_endpoints dep
          left join app.deliveries d on d.endpoint_id = dep.id
          where dep.member_id = $1
          group by
            dep.id,
            dep.member_id,
            dep.channel,
            dep.label,
            dep.endpoint_url,
            dep.shared_secret_ref,
            dep.state,
            dep.last_success_at,
            dep.last_failure_at,
            dep.metadata,
            dep.created_at,
            dep.disabled_at
          order by dep.created_at desc, dep.id desc
        `,
        [actorMemberId],
      );

      return result.rows.map(mapDeliveryEndpointRow);
    },

    async createDeliveryEndpoint(input: CreateDeliveryEndpointInput): Promise<DeliveryEndpointSummary> {
      const result = await pool.query<DeliveryEndpointRow>(
        `
          insert into app.delivery_endpoints (
            member_id,
            channel,
            label,
            endpoint_url,
            shared_secret_ref,
            metadata
          )
          values ($1, $2, $3, $4, $5, $6::jsonb)
          returning
            id as endpoint_id,
            member_id,
            channel,
            label,
            endpoint_url,
            shared_secret_ref,
            state,
            last_success_at::text as last_success_at,
            last_failure_at::text as last_failure_at,
            0 as pending_count,
            0 as processing_count,
            0 as sent_count,
            0 as failed_count,
            0 as canceled_count,
            null::text as last_delivery_at,
            metadata,
            created_at::text as created_at,
            disabled_at::text as disabled_at
        `,
        [
          input.actorMemberId,
          input.channel ?? 'openclaw_webhook',
          input.label ?? null,
          input.endpointUrl,
          input.sharedSecretRef ?? null,
          JSON.stringify(input.metadata ?? {}),
        ],
      );

      return mapDeliveryEndpointRow(result.rows[0]!);
    },

    async updateDeliveryEndpoint(input: UpdateDeliveryEndpointInput): Promise<DeliveryEndpointSummary | null> {
      const fields: string[] = [];
      const params: unknown[] = [input.endpointId, input.actorMemberId];
      let nextIndex = params.length + 1;

      if (input.patch.label !== undefined) {
        fields.push(`label = $${nextIndex++}`);
        params.push(input.patch.label);
      }

      if (input.patch.endpointUrl !== undefined) {
        fields.push(`endpoint_url = $${nextIndex++}`);
        params.push(input.patch.endpointUrl);
      }

      if (input.patch.sharedSecretRef !== undefined) {
        fields.push(`shared_secret_ref = $${nextIndex++}`);
        params.push(input.patch.sharedSecretRef);
      }

      if (input.patch.state !== undefined) {
        fields.push(`state = $${nextIndex++}`);
        params.push(input.patch.state);
        fields.push(`disabled_at = ${input.patch.state === 'disabled' ? 'coalesce(disabled_at, now())' : 'null'}`);
      }

      if (input.patch.metadata !== undefined) {
        fields.push(`metadata = $${nextIndex++}::jsonb`);
        params.push(JSON.stringify(input.patch.metadata));
      }

      const result = await pool.query<DeliveryEndpointRow>(
        `
          update app.delivery_endpoints dep
          set ${fields.join(', ')}
          where dep.id = $1
            and dep.member_id = $2
          returning
            dep.id as endpoint_id,
            dep.member_id,
            dep.channel,
            dep.label,
            dep.endpoint_url,
            dep.shared_secret_ref,
            dep.state,
            dep.last_success_at::text as last_success_at,
            dep.last_failure_at::text as last_failure_at,
            0 as pending_count,
            0 as processing_count,
            0 as sent_count,
            0 as failed_count,
            0 as canceled_count,
            null::text as last_delivery_at,
            dep.metadata,
            dep.created_at::text as created_at,
            dep.disabled_at::text as disabled_at
        `,
        params,
      );

      return result.rows[0] ? mapDeliveryEndpointRow(result.rows[0]) : null;
    },

    async revokeDeliveryEndpoint(input: RevokeDeliveryEndpointInput): Promise<DeliveryEndpointSummary | null> {
      const result = await pool.query<DeliveryEndpointRow>(
        `
          update app.delivery_endpoints dep
          set state = 'disabled',
              disabled_at = coalesce(dep.disabled_at, now())
          where dep.id = $1
            and dep.member_id = $2
          returning
            dep.id as endpoint_id,
            dep.member_id,
            dep.channel,
            dep.label,
            dep.endpoint_url,
            dep.shared_secret_ref,
            dep.state,
            dep.last_success_at::text as last_success_at,
            dep.last_failure_at::text as last_failure_at,
            0 as pending_count,
            0 as processing_count,
            0 as sent_count,
            0 as failed_count,
            0 as canceled_count,
            null::text as last_delivery_at,
            dep.metadata,
            dep.created_at::text as created_at,
            dep.disabled_at::text as disabled_at
        `,
        [input.endpointId, input.actorMemberId],
      );

      return result.rows[0] ? mapDeliveryEndpointRow(result.rows[0]) : null;
    },

    async listBearerTokens({ actorMemberId }: { actorMemberId: string }): Promise<BearerTokenSummary[]> {
      const result = await pool.query<BearerTokenRow>(
        `
          select
            mbt.id as token_id,
            mbt.member_id,
            mbt.label,
            mbt.created_at::text as created_at,
            mbt.last_used_at::text as last_used_at,
            mbt.revoked_at::text as revoked_at,
            mbt.metadata
          from app.member_bearer_tokens mbt
          where mbt.member_id = $1
          order by mbt.created_at desc, mbt.id desc
        `,
        [actorMemberId],
      );

      return result.rows.map(mapBearerTokenRow);
    },

    async createBearerToken(input: CreateBearerTokenInput): Promise<CreatedBearerToken> {
      const token = buildBearerToken();
      const result = await pool.query<BearerTokenRow>(
        `
          insert into app.member_bearer_tokens (id, member_id, label, token_hash, metadata)
          values ($1, $2, $3, $4, $5::jsonb)
          returning
            id as token_id,
            member_id,
            label,
            created_at::text as created_at,
            last_used_at::text as last_used_at,
            revoked_at::text as revoked_at,
            metadata
        `,
        [token.tokenId, input.actorMemberId, input.label ?? null, token.tokenHash, JSON.stringify(input.metadata ?? {})],
      );

      return {
        token: mapBearerTokenRow(result.rows[0]!),
        bearerToken: token.bearerToken,
      };
    },

    async revokeBearerToken(input: RevokeBearerTokenInput): Promise<BearerTokenSummary | null> {
      const result = await pool.query<BearerTokenRow>(
        `
          update app.member_bearer_tokens mbt
          set revoked_at = coalesce(mbt.revoked_at, now())
          where mbt.id = $1
            and mbt.member_id = $2
          returning
            mbt.id as token_id,
            mbt.member_id,
            mbt.label,
            mbt.created_at::text as created_at,
            mbt.last_used_at::text as last_used_at,
            mbt.revoked_at::text as revoked_at,
            mbt.metadata
        `,
        [input.tokenId, input.actorMemberId],
      );

      return result.rows[0] ? mapBearerTokenRow(result.rows[0]) : null;
    },

    async listDeliveries(input: ListDeliveriesInput): Promise<DeliverySummary[]> {
      return withActorContext(pool, input.actorMemberId, input.networkIds, (client) => listDeliveries(client, input));
    },

    async listDeliveryAttempts(input: ListDeliveryAttemptsInput): Promise<DeliveryAttemptInspection[]> {
      return withActorContext(pool, input.actorMemberId, input.networkIds, (client) => listDeliveryAttempts(client, input));
    },

    async retryDelivery(input: RetryDeliveryInput): Promise<DeliverySummary | null> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await applyActorContext(client, input.actorMemberId, input.accessibleNetworkIds);

        const currentResult = await client.query<{
          delivery_id: string;
          network_id: string;
          recipient_member_id: string;
          endpoint_id: string;
          entity_id: string | null;
          entity_version_id: string | null;
          transcript_message_id: string | null;
          topic: string;
          payload: Record<string, unknown> | null;
          status: DeliverySummary['status'];
        }>(
          `
            select
              cdr.delivery_id,
              cdr.network_id,
              cdr.recipient_member_id,
              cdr.endpoint_id,
              cdr.entity_id,
              cdr.entity_version_id,
              cdr.transcript_message_id,
              cdr.topic,
              cdr.payload,
              cdr.status
            from app.current_delivery_receipts cdr
            where cdr.delivery_id = $1
              and cdr.recipient_member_id = $2
              and cdr.network_id = any($3::app.short_id[])
          `,
          [input.deliveryId, input.actorMemberId, input.accessibleNetworkIds],
        );

        const current = currentResult.rows[0];
        if (!current) {
          await client.query('rollback');
          return null;
        }

        if (current.status !== 'failed' && current.status !== 'canceled') {
          throw new AppError(409, 'delivery_not_retryable', 'Only failed or canceled deliveries can be retried');
        }

        const insertedResult = await client.query<{ delivery_id: string }>(
          `
            insert into app.deliveries (
              network_id,
              recipient_member_id,
              endpoint_id,
              entity_id,
              entity_version_id,
              transcript_message_id,
              topic,
              payload,
              status,
              scheduled_at,
              attempt_count,
              last_error,
              sent_at,
              failed_at,
              dedupe_key
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'pending', now(), 0, null, null, null, null)
            returning id as delivery_id
          `,
          [
            current.network_id,
            current.recipient_member_id,
            current.endpoint_id,
            current.entity_id,
            current.entity_version_id,
            current.transcript_message_id,
            current.topic,
            JSON.stringify(current.payload ?? {}),
          ],
        );

        const retriedDeliveryId = insertedResult.rows[0]?.delivery_id;
        if (!retriedDeliveryId) {
          throw new Error('Retried delivery id missing after insert');
        }

        const reloadedResult = await client.query<DeliverySummaryRow>(
          `
            select
              cdr.delivery_id,
              cdr.network_id,
              cdr.recipient_member_id,
              cdr.endpoint_id,
              cdr.topic,
              cdr.payload,
              cdr.status,
              cdr.attempt_count,
              cdr.entity_id,
              cdr.entity_version_id,
              cdr.transcript_message_id,
              cdr.scheduled_at::text as scheduled_at,
              cdr.sent_at::text as sent_at,
              cdr.failed_at::text as failed_at,
              cdr.last_error,
              cdr.created_at::text as created_at,
              cdr.acknowledgement_id,
              cdr.acknowledgement_state,
              cdr.acknowledgement_suppression_reason,
              cdr.acknowledgement_version_no,
              cdr.acknowledgement_created_at::text as acknowledgement_created_at,
              cdr.acknowledgement_created_by_member_id
            from app.current_delivery_receipts cdr
            where cdr.delivery_id = $1
          `,
          [retriedDeliveryId],
        );

        await client.query('commit');
        return reloadedResult.rows[0] ? mapDeliverySummaryRow(reloadedResult.rows[0]) : null;
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async acknowledgeDelivery(input: AcknowledgeDeliveryInput): Promise<DeliveryAcknowledgement | null> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await applyActorContext(client, input.actorMemberId, input.accessibleNetworkIds);

        const deliveryResult = await client.query<{ id: string; network_id: string; recipient_member_id: string }>(
          `
            select d.id, d.network_id, d.recipient_member_id
            from app.pending_deliveries d
            where d.id = $1
              and d.recipient_member_id = $2
              and d.network_id = any($3::app.short_id[])
          `,
          [input.deliveryId, input.actorMemberId, input.accessibleNetworkIds],
        );

        const delivery = deliveryResult.rows[0];
        if (!delivery) {
          await client.query('rollback');
          return null;
        }

        const currentAckResult = await client.query<{ acknowledgement_id: string; version_no: number }>(
          `
            select id as acknowledgement_id, version_no
            from app.current_delivery_acknowledgements
            where delivery_id = $1
              and recipient_member_id = $2
          `,
          [delivery.id, delivery.recipient_member_id],
        );

        const currentAck = currentAckResult.rows[0];
        const ackResult = await client.query<DeliveryAcknowledgementRow>(
          `
            insert into app.delivery_acknowledgements (
              delivery_id,
              recipient_member_id,
              network_id,
              state,
              suppression_reason,
              version_no,
              supersedes_acknowledgement_id,
              created_by_member_id
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8)
            returning
              id as acknowledgement_id,
              delivery_id,
              network_id,
              recipient_member_id,
              state,
              suppression_reason,
              version_no,
              supersedes_acknowledgement_id,
              created_at::text,
              created_by_member_id
          `,
          [
            delivery.id,
            delivery.recipient_member_id,
            delivery.network_id,
            input.state,
            input.state === 'suppressed' ? input.suppressionReason ?? null : null,
            (currentAck?.version_no ?? 0) + 1,
            currentAck?.acknowledgement_id ?? null,
            input.actorMemberId,
          ],
        );

        await client.query('commit');
        return ackResult.rows[0] ? mapDeliveryAcknowledgementRow(ackResult.rows[0]) : null;
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async claimNextDelivery(input: ClaimDeliveryInput): Promise<ClaimedDelivery | null> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await applyActorContext(client, input.actorMemberId, input.accessibleNetworkIds);

        const claimResult = await client.query<{ delivery_id: string }>(
          `
            with next_delivery as (
              select d.id
              from app.deliveries d
              join app.delivery_endpoints de on de.id = d.endpoint_id
              where d.status = 'pending'
                and d.network_id = any($2::app.short_id[])
                and d.scheduled_at <= now()
                and de.state = 'active'
                and de.disabled_at is null
              order by d.scheduled_at asc, d.created_at asc, d.id asc
              for update of d skip locked
              limit 1
            ), updated as (
              update app.deliveries d
              set status = 'processing',
                  attempt_count = d.attempt_count + 1,
                  last_error = null,
                  failed_at = null
              from next_delivery nd
              where d.id = nd.id
              returning d.id, d.network_id, d.endpoint_id, d.attempt_count
            ), inserted as (
              insert into app.delivery_attempts (
                delivery_id,
                network_id,
                endpoint_id,
                worker_key,
                status,
                attempt_no,
                created_by_member_id
              )
              select
                u.id,
                u.network_id,
                u.endpoint_id,
                $3,
                'processing',
                u.attempt_count,
                $1
              from updated u
              returning delivery_id
            )
            select delivery_id
            from inserted
          `,
          [input.actorMemberId, input.accessibleNetworkIds, input.workerKey ?? null],
        );

        const deliveryId = claimResult.rows[0]?.delivery_id;
        if (!deliveryId) {
          await client.query('commit');
          return null;
        }

        const delivery = await loadDeliverySummary(client, deliveryId);
        const attempt = await loadCurrentDeliveryAttempt(client, deliveryId);
        const endpoint = delivery ? await loadDeliveryEndpoint(client, delivery.endpointId) : null;
        await client.query('commit');

        return delivery && attempt && endpoint ? { delivery, attempt, endpoint } : null;
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async completeDeliveryAttempt(input: CompleteDeliveryAttemptInput): Promise<ClaimedDelivery | null> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await applyActorContext(client, input.actorMemberId, input.accessibleNetworkIds);

        const updateResult = await client.query<{ delivery_id: string }>(
          `
            with current_attempt as (
              select cda.id, cda.delivery_id, cda.endpoint_id
              from app.current_delivery_attempts cda
              join app.deliveries d on d.id = cda.delivery_id
              where cda.delivery_id = $2
                and cda.status = 'processing'
                and d.status = 'processing'
                and d.network_id = any($3::app.short_id[])
              for update of d skip locked
            ), finished_attempt as (
              update app.delivery_attempts da
              set status = 'sent',
                  response_status_code = $4,
                  response_body = $5,
                  error_message = null,
                  finished_at = now()
              from current_attempt ca
              where da.id = ca.id
              returning da.delivery_id, da.endpoint_id
            ), finished_delivery as (
              update app.deliveries d
              set status = 'sent',
                  sent_at = now(),
                  failed_at = null,
                  last_error = null
              from finished_attempt fa
              where d.id = fa.delivery_id
              returning d.id as delivery_id, fa.endpoint_id
            ), endpoint_touch as (
              update app.delivery_endpoints dep
              set last_success_at = now()
              from finished_delivery fd
              where dep.id = fd.endpoint_id
              returning fd.delivery_id
            )
            select delivery_id
            from endpoint_touch
          `,
          [input.actorMemberId, input.deliveryId, input.accessibleNetworkIds, input.responseStatusCode ?? null, input.responseBody ?? null],
        );

        const deliveryId = updateResult.rows[0]?.delivery_id;
        if (!deliveryId) {
          await client.query('rollback');
          return null;
        }

        const delivery = await loadDeliverySummary(client, deliveryId);
        const attempt = await loadCurrentDeliveryAttempt(client, deliveryId);
        const endpoint = delivery ? await loadDeliveryEndpoint(client, delivery.endpointId) : null;
        await client.query('commit');

        return delivery && attempt && endpoint ? { delivery, attempt, endpoint } : null;
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async failDeliveryAttempt(input: FailDeliveryAttemptInput): Promise<ClaimedDelivery | null> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await applyActorContext(client, input.actorMemberId, input.accessibleNetworkIds);

        const updateResult = await client.query<{ delivery_id: string }>(
          `
            with current_attempt as (
              select cda.id, cda.delivery_id, cda.endpoint_id
              from app.current_delivery_attempts cda
              join app.deliveries d on d.id = cda.delivery_id
              where cda.delivery_id = $2
                and cda.status = 'processing'
                and d.status = 'processing'
                and d.network_id = any($3::app.short_id[])
              for update of d skip locked
            ), finished_attempt as (
              update app.delivery_attempts da
              set status = 'failed',
                  response_status_code = $5,
                  response_body = $6,
                  error_message = $4,
                  finished_at = now()
              from current_attempt ca
              where da.id = ca.id
              returning da.delivery_id, da.endpoint_id
            ), finished_delivery as (
              update app.deliveries d
              set status = 'failed',
                  failed_at = now(),
                  last_error = $4
              from finished_attempt fa
              where d.id = fa.delivery_id
              returning d.id as delivery_id, fa.endpoint_id
            ), endpoint_touch as (
              update app.delivery_endpoints dep
              set last_failure_at = now()
              from finished_delivery fd
              where dep.id = fd.endpoint_id
              returning fd.delivery_id
            )
            select delivery_id
            from endpoint_touch
          `,
          [input.actorMemberId, input.deliveryId, input.accessibleNetworkIds, input.errorMessage, input.responseStatusCode ?? null, input.responseBody ?? null],
        );

        const deliveryId = updateResult.rows[0]?.delivery_id;
        if (!deliveryId) {
          await client.query('rollback');
          return null;
        }

        const delivery = await loadDeliverySummary(client, deliveryId);
        const attempt = await loadCurrentDeliveryAttempt(client, deliveryId);
        const endpoint = delivery ? await loadDeliveryEndpoint(client, delivery.endpointId) : null;
        await client.query('commit');

        return delivery && attempt && endpoint ? { delivery, attempt, endpoint } : null;
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async sendDirectMessage(input: SendDirectMessageInput): Promise<DirectMessageSummary | null> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await applyActorContext(client, input.actorMemberId, input.accessibleNetworkIds);

        const scopeResult = await client.query<{ network_id: string }>(
          `
            with actor_scope as (
              select distinct network_id
              from app.accessible_network_memberships
              where member_id = $1
                and network_id = any($2::app.short_id[])
            ),
            shared_scope as (
              select actor_scope.network_id
              from actor_scope
              join app.accessible_network_memberships recipient_scope
                on recipient_scope.network_id = actor_scope.network_id
             where recipient_scope.member_id = $3
            )
            select network_id
            from shared_scope
            where ($4::app.short_id is null or network_id = $4)
            order by network_id asc
            limit 1
          `,
          [input.actorMemberId, input.accessibleNetworkIds, input.recipientMemberId, input.networkId ?? null],
        );

        const networkId = scopeResult.rows[0]?.network_id;
        if (!networkId) {
          await client.query('rollback');
          return null;
        }

        const threadResult = await client.query<{ id: string }>(
          `
            select tt.id
            from app.transcript_threads tt
            where tt.kind = 'dm'
              and tt.archived_at is null
              and tt.network_id = $1
              and (
                (tt.created_by_member_id = $2 and tt.counterpart_member_id = $3)
                or (tt.created_by_member_id = $3 and tt.counterpart_member_id = $2)
              )
            order by tt.created_at asc, tt.id asc
            limit 1
          `,
          [networkId, input.actorMemberId, input.recipientMemberId],
        );

        let threadId = threadResult.rows[0]?.id;
        if (!threadId) {
          const insertedThread = await client.query<{ id: string }>(
            `
              insert into app.transcript_threads (network_id, kind, created_by_member_id, counterpart_member_id)
              values ($1, 'dm', $2, $3)
              returning id
            `,
            [networkId, input.actorMemberId, input.recipientMemberId],
          );
          threadId = insertedThread.rows[0]!.id;
        }

        const messageResult = await client.query<{ id: string; created_at: string }>(
          `
            insert into app.transcript_messages (thread_id, sender_member_id, role, message_text)
            values ($1, $2, 'member', $3)
            returning id, created_at::text
          `,
          [threadId, input.actorMemberId, input.messageText],
        );
        const message = messageResult.rows[0]!;

        const deliveryResult = await client.query(
          `
            insert into app.deliveries (
              network_id,
              recipient_member_id,
              endpoint_id,
              transcript_message_id,
              topic,
              payload,
              status,
              scheduled_at,
              sent_at
            )
            select
              $1,
              dep.member_id,
              dep.id,
              $2,
              'transcript.message.created',
              jsonb_build_object(
                'threadId', $3,
                'messageId', $2,
                'senderMemberId', $4,
                'recipientMemberId', $5,
                'messageText', $6,
                'kind', 'dm'
              ),
              'sent'::app.delivery_status,
              now(),
              now()
            from app.delivery_endpoints dep
            where dep.member_id = $5
              and dep.state = 'active'
              and dep.disabled_at is null
          `,
          [networkId, message.id, threadId, input.actorMemberId, input.recipientMemberId, input.messageText],
        );

        await client.query('commit');
        return mapDirectMessageRow({
          thread_id: threadId,
          network_id: networkId,
          sender_member_id: input.actorMemberId,
          recipient_member_id: input.recipientMemberId,
          message_id: message.id,
          message_text: input.messageText,
          created_at: message.created_at,
          delivery_count: deliveryResult.rowCount ?? 0,
        });
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async listDirectMessageThreads({ actorMemberId, networkIds, limit }) {
      return withActorContext(pool, actorMemberId, networkIds, (client) =>
        listDirectMessageThreads(client, actorMemberId, networkIds, limit),
      );
    },

    async listDirectMessageInbox({ actorMemberId, networkIds, limit, unreadOnly }) {
      return withActorContext(pool, actorMemberId, networkIds, (client) =>
        listDirectMessageInbox(client, actorMemberId, networkIds, limit, unreadOnly),
      );
    },

    async readDirectMessageThread({ actorMemberId, accessibleNetworkIds, threadId, limit }) {
      return withActorContext(pool, actorMemberId, accessibleNetworkIds, (client) =>
        readDirectMessageThread(client, actorMemberId, accessibleNetworkIds, threadId, limit),
      );
    },

    async listEntities({ networkIds, kinds, limit, query }) {
      return withActorContext(pool, '', networkIds, async (client) => {
        const trimmedQuery = query?.trim();
        const likePattern = trimmedQuery ? `%${trimmedQuery}%` : null;
        const prefixPattern = trimmedQuery ? `${trimmedQuery}%` : null;

        const result = await client.query<EntityRow>(
        `
          with scope as (
            select unnest($1::text[])::app.short_id as network_id
          )
          select
            le.entity_id,
            le.entity_version_id,
            le.network_id,
            le.kind,
            m.id as author_member_id,
            m.public_name as author_public_name,
            m.handle as author_handle,
            le.version_no,
            le.state,
            le.title,
            le.summary,
            le.body,
            le.effective_at::text as effective_at,
            le.expires_at::text as expires_at,
            le.version_created_at::text as version_created_at,
            le.content,
            ceve.id as embedding_id,
            ceve.model as embedding_model,
            ceve.dimensions as embedding_dimensions,
            ceve.source_text as embedding_source_text,
            ceve.metadata as embedding_metadata,
            ceve.created_at::text as embedding_created_at,
            le.entity_created_at::text as entity_created_at
          from scope s
          join app.live_entities le on le.network_id = s.network_id
          left join app.current_entity_version_embeddings ceve on ceve.entity_version_id = le.entity_version_id
          join app.members m on m.id = le.author_member_id
          where le.kind = any($2::app.entity_kind[])
            and (
              $4::text is null
              or coalesce(le.title, '') ilike $4
              or coalesce(le.summary, '') ilike $4
              or coalesce(le.body, '') ilike $4
            )
          order by
            case
              when $3::text is null then 0
              when lower(coalesce(le.title, '')) = lower($3::text) then 400
              when lower(coalesce(le.title, '')) like lower($5::text) then 250
              when lower(coalesce(le.summary, '')) like lower($5::text) then 175
              when lower(coalesce(le.body, '')) like lower($5::text) then 120
              when coalesce(le.title, '') ilike $4 then 90
              when coalesce(le.summary, '') ilike $4 then 60
              when coalesce(le.body, '') ilike $4 then 30
              else 0
            end desc,
            le.effective_at desc,
            le.entity_id desc
          limit $6
        `,
        [networkIds, kinds, trimmedQuery ?? null, likePattern, prefixPattern, limit],
      );
        return result.rows.map(mapEntityRow);
      });
    },
  };
}
