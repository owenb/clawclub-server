import { Pool, type PoolClient } from 'pg';
import { AppError, type AcknowledgeDeliveryInput, type ActorContext, type ApplicationStatus, type ApplicationSummary, type ArchiveNetworkInput, type AssignNetworkOwnerInput, type AuthResult, type BearerTokenSummary, type ClaimDeliveryInput, type ClaimedDelivery, type CompleteDeliveryAttemptInput, type CreateApplicationInput, type CreateBearerTokenInput, type CreateDeliveryEndpointInput, type CreateEntityInput, type CreateEventInput, type CreateMembershipInput, type CreateNetworkInput, type CreatedBearerToken, type DeliveryAcknowledgement, type DeliveryAttemptInspection, type DeliveryAttemptSummary, type DeliveryEndpointState, type DeliveryEndpointSummary, type DeliverySummary, type DeliveryWorkerAuthResult, type DirectMessageInboxSummary, type DirectMessageReceipt, type DirectMessageSummary, type DirectMessageThreadSummary, type DirectMessageTranscriptEntry, type EmbeddingProjectionSummary, type EntitySummary, type EventRsvpState, type EventSummary, type FailDeliveryAttemptInput, type ListDeliveriesInput, type ListDeliveryAttemptsInput, type ListEventsInput, type MemberProfile, type MemberSearchResult, type MembershipAdminSummary, type MembershipReviewSummary, type MembershipState, type MembershipSummary, type MembershipVouchSummary, type NetworkMemberSummary, type NetworkSummary, type PendingDelivery, type Repository, type RetryDeliveryInput, type RevokeBearerTokenInput, type RevokeDeliveryEndpointInput, type RsvpEventInput, type SendDirectMessageInput, type TransitionApplicationInput, type TransitionMembershipInput, type UpdateDeliveryEndpointInput, type UpdateEntityInput, type UpdateOwnProfileInput } from './app.ts';
import { hashTokenSecret, parseBearerToken } from './token.ts';
import { buildDeliveryRepository, listPendingDeliveries } from './postgres/deliveries.ts';

type ActorRow = {
  member_id: string;
  handle: string | null;
  public_name: string;
  global_roles: Array<'superadmin'> | string | null;
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

function parsePostgresTextArray(value: string[] | string | null | undefined): string[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value !== 'string') {
    return [];
  }

  const trimmed = value.trim();
  if (trimmed === '' || trimmed === '{}') {
    return [];
  }

  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return [trimmed];
  }

  return trimmed
    .slice(1, -1)
    .split(',')
    .filter((entry) => entry.length > 0)
    .map((entry) => entry.replace(/^"(.*)"$/, '$1').replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
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

type DeliveryWorkerTokenRow = {
  token_id: string;
  actor_member_id: string;
  label: string | null;
  allowed_network_ids: string[] | string | null;
  metadata: Record<string, unknown> | null;
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

// RLS now derives network access from membership state in the database.
async function applyActorContext(
  client: DbClient,
  actorMemberId: string,
  _networkIds: string[],
  options: { deliveryWorkerScope?: boolean } = {},
): Promise<void> {
  await client.query(
    `
      select set_config('app.actor_member_id', $1, true)
    `,
    [actorMemberId],
  );

  if (options.deliveryWorkerScope) {
    await client.query(`select set_config('app.delivery_worker_scope', '1', true)`);
  }
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
    globalRoles: parsePostgresTextArray(first.global_roles) as Array<'superadmin'>,
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

async function readActorByMemberId(client: DbClient, memberId: string): Promise<ActorContext | null> {
  const result = await client.query<ActorRow>(
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

async function getActorByMemberId(pool: Pool, memberId: string): Promise<ActorContext | null> {
  return withActorContext(pool, memberId, [], (client) => readActorByMemberId(client, memberId));
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

async function searchMembers(client: DbClient, input: {
  networkIds: string[];
  query: string;
  limit: number;
}): Promise<MemberSearchResult[]> {
  if (input.networkIds.length === 0) {
    return [];
  }

  const trimmedQuery = input.query.trim();
  const tokens = tokenizeSearchQuery(trimmedQuery);
  const likePattern = `%${trimmedQuery}%`;
  const candidateLimit = Math.min(Math.max(input.limit * 5, 25), 100);

  const result = await client.query<SearchRow>(
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
    [input.networkIds, likePattern, tokens, candidateLimit],
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
    .slice(0, input.limit)
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
}

async function listMembers(client: DbClient, input: {
  networkIds: string[];
  limit: number;
}): Promise<NetworkMemberSummary[]> {
  if (input.networkIds.length === 0) {
    return [];
  }

  const result = await client.query<MemberListRow>(
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
    [input.networkIds, input.limit],
  );

  return result.rows.map(mapMemberListRow);
}

async function readMemberProfile(client: DbClient, targetMemberId: string): Promise<MemberProfile | null> {
  const result = await client.query<ProfileRow>(
    `
      with target_scope as (
        select distinct anm.network_id
        from app.accessible_network_memberships anm
        where anm.member_id = $1
          and app.actor_has_network_access(anm.network_id)
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
      left join target_scope ts on true
      left join app.networks n on n.id = ts.network_id and n.archived_at is null
      where m.id = $1
        and m.state = 'active'
      group by
        m.id, m.public_name, m.handle,
        cmp.display_name, cmp.tagline, cmp.summary, cmp.what_i_do, cmp.known_for,
        cmp.services_summary, cmp.website_url, cmp.links, cmp.profile,
        cmp.id, cmp.version_no, cmp.created_at, cmp.created_by_member_id,
        cpve.id, cpve.model, cpve.dimensions, cpve.source_text, cpve.metadata, cpve.created_at
    `,
    [targetMemberId],
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
          select member_id
          from app.authenticate_member_bearer_token($1, $2)
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
          select
            token_id,
            actor_member_id,
            label,
            allowed_network_ids,
            metadata
          from app.authenticate_delivery_worker_token($1, $2)
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
      const allowedNetworkIds = parsePostgresTextArray(tokenRow.allowed_network_ids).filter((networkId) => currentNetworkIds.has(networkId));
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

    ...buildDeliveryRepository({ pool, applyActorContext, withActorContext }),

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
            with inserted as (
              insert into app.applications (
                network_id,
                applicant_member_id,
                sponsor_member_id,
                membership_id,
                path,
                metadata
              )
              select $1, $2, $3, $4, $5, $6::jsonb
              where app.member_is_active($2)
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
            select $1, $6, $2, $3, $4, now(), $5::jsonb
            where app.member_is_active($6)
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

    async searchMembers({ actorMemberId, networkIds, query, limit }): Promise<MemberSearchResult[]> {
      return withActorContext(pool, actorMemberId, networkIds, (client) => searchMembers(client, { networkIds, query, limit }));
    },

    async listMembers({ actorMemberId, networkIds, limit }) {
      return withActorContext(pool, actorMemberId, networkIds, (client) => listMembers(client, { networkIds, limit }));
    },

    async getMemberProfile({ actorMemberId, targetMemberId }) {
      return withActorContext(pool, actorMemberId, [], (client) => readMemberProfile(client, targetMemberId));
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
