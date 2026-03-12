import { Pool, type PoolClient } from 'pg';
import { AppError, type AcknowledgeDeliveryInput, type ActorContext, type AuthResult, type CreateEntityInput, type CreateEventInput, type DeliveryAcknowledgement, type DeliverySummary, type DirectMessageSummary, type DirectMessageThreadSummary, type DirectMessageTranscriptEntry, type EntitySummary, type EventRsvpState, type EventSummary, type ListDeliveriesInput, type ListEventsInput, type MemberProfile, type MemberSearchResult, type MembershipSummary, type PendingDelivery, type Repository, type RsvpEventInput, type SendDirectMessageInput, type UpdateEntityInput, type UpdateOwnProfileInput } from './app.ts';
import { hashTokenSecret, parseBearerToken } from './token.ts';

type ActorRow = {
  member_id: string;
  handle: string | null;
  public_name: string;
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
  topic: string;
  payload: Record<string, unknown> | null;
  status: 'pending' | 'processing' | 'sent' | 'failed' | 'canceled';
  entity_id: string | null;
  entity_version_id: string | null;
  transcript_message_id: string | null;
  scheduled_at: string;
  sent_at: string | null;
  failed_at: string | null;
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

type DirectMessageTranscriptRow = {
  message_id: string;
  thread_id: string;
  sender_member_id: string | null;
  role: DirectMessageTranscriptEntry['role'];
  message_text: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
  in_reply_to_message_id: string | null;
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
    topic: row.topic,
    payload: row.payload ?? {},
    status: row.status,
    entityId: row.entity_id,
    entityVersionId: row.entity_version_id,
    transcriptMessageId: row.transcript_message_id,
    scheduledAt: row.scheduled_at,
    sentAt: row.sent_at,
    failedAt: row.failed_at,
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
        cdr.topic,
        cdr.payload,
        cdr.status,
        cdr.entity_id,
        cdr.entity_version_id,
        cdr.transcript_message_id,
        cdr.scheduled_at::text as scheduled_at,
        cdr.sent_at::text as sent_at,
        cdr.failed_at::text as failed_at,
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
        jsonb_agg(distinct jsonb_build_object('id', n.id, 'slug', n.slug, 'name', n.name))
          filter (where n.id is not null) as shared_networks
      from app.members m
      left join app.current_member_profiles cmp on cmp.member_id = m.id
      join target_scope ts on true
      join app.networks n on n.id = ts.network_id and n.archived_at is null
      where m.id = $2
        and m.state = 'active'
      group by
        m.id, m.public_name, m.handle,
        cmp.display_name, cmp.tagline, cmp.summary, cmp.what_i_do, cmp.known_for,
        cmp.services_summary, cmp.website_url, cmp.links, cmp.profile,
        cmp.id, cmp.version_no, cmp.created_at, cmp.created_by_member_id
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
        e.created_at::text as entity_created_at
      from app.entities e
      join app.current_entity_versions cev on cev.entity_id = e.id
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
        tm.in_reply_to_message_id
      from app.transcript_messages tm
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

    async searchMembers({ networkIds, query, limit }): Promise<MemberSearchResult[]> {
      const trimmedQuery = query.trim();
      const likePattern = `%${trimmedQuery}%`;
      const prefixPattern = `${trimmedQuery}%`;

      const result = await pool.query<SearchRow>(
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
            or coalesce(cmp.what_i_do, '') ilike $2
            or coalesce(cmp.known_for, '') ilike $2
            or coalesce(cmp.services_summary, '') ilike $2
          )
          group by
            m.id, m.public_name, cmp.display_name, m.handle, cmp.tagline, cmp.summary,
            cmp.what_i_do, cmp.known_for, cmp.services_summary, cmp.website_url
          order by
            min(
              case
                when lower(coalesce(cmp.display_name, m.public_name)) = lower($3)
                  or lower(m.public_name) = lower($3)
                  or lower(coalesce(m.handle, '')) = lower($3) then 0
                when lower(coalesce(cmp.display_name, m.public_name)) like lower($4)
                  or lower(m.public_name) like lower($4)
                  or lower(coalesce(m.handle, '')) like lower($4) then 1
                else 2
              end
            ) asc,
            display_name asc,
            m.id asc
          limit $5
        `,
        [networkIds, likePattern, trimmedQuery, prefixPattern, limit],
      );

      return result.rows.map((row) => ({
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

    async listEvents({ actorMemberId, networkIds, limit }: ListEventsInput): Promise<EventSummary[]> {
      return withActorContext(pool, actorMemberId, networkIds, async (client) => {
        const result = await client.query<{ entity_id: string }>(
        `
          with scope as (
            select unnest($1::text[])::app.short_id as network_id
          )
          select le.entity_id
          from scope s
          join app.live_entities le on le.network_id = s.network_id
          where le.kind = 'event'
          order by coalesce(le.starts_at, le.effective_at) asc, le.entity_id asc
          limit $2
        `,
        [networkIds, limit],
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


    async listDeliveries(input: ListDeliveriesInput): Promise<DeliverySummary[]> {
      return withActorContext(pool, input.actorMemberId, input.networkIds, (client) => listDeliveries(client, input));
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

    async readDirectMessageThread({ actorMemberId, accessibleNetworkIds, threadId, limit }) {
      return withActorContext(pool, actorMemberId, accessibleNetworkIds, (client) =>
        readDirectMessageThread(client, actorMemberId, accessibleNetworkIds, threadId, limit),
      );
    },

    async listEntities({ networkIds, kinds, limit }) {
      return withActorContext(pool, '', networkIds, async (client) => {
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
            le.entity_created_at::text as entity_created_at
          from scope s
          join app.live_entities le on le.network_id = s.network_id
          join app.members m on m.id = le.author_member_id
          where le.kind = any($2::app.entity_kind[])
          order by le.effective_at desc, le.entity_id desc
          limit $3
        `,
        [networkIds, kinds, limit],
      );
        return result.rows.map(mapEntityRow);
      });
    },
  };
}
