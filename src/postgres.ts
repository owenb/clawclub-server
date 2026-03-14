import { Pool, type PoolClient } from 'pg';
import { AppError, type AcknowledgeDeliveryInput, type ActorContext, type ApplicationStatus, type ApplicationSummary, type ArchiveNetworkInput, type AssignNetworkOwnerInput, type AuthResult, type BearerTokenSummary, type ClaimDeliveryInput, type ClaimedDelivery, type CompleteDeliveryAttemptInput, type CreateApplicationInput, type CreateBearerTokenInput, type CreateDeliveryEndpointInput, type CreateEntityInput, type CreateEventInput, type CreateMembershipInput, type CreateNetworkInput, type CreatedBearerToken, type DeliveryAcknowledgement, type DeliveryAttemptInspection, type DeliveryAttemptSummary, type DeliveryEndpointState, type DeliveryEndpointSummary, type DeliverySummary, type DeliveryWorkerAuthResult, type DirectMessageInboxSummary, type DirectMessageReceipt, type DirectMessageSummary, type DirectMessageThreadSummary, type DirectMessageTranscriptEntry, type EmbeddingProjectionSummary, type EntitySummary, type EventRsvpState, type EventSummary, type FailDeliveryAttemptInput, type ListDeliveriesInput, type ListDeliveryAttemptsInput, type ListEventsInput, type MemberProfile, type MemberSearchResult, type MembershipAdminSummary, type MembershipReviewSummary, type MembershipState, type MembershipSummary, type MembershipVouchSummary, type NetworkMemberSummary, type NetworkSummary, type PendingDelivery, type Repository, type RetryDeliveryInput, type RevokeBearerTokenInput, type RevokeDeliveryEndpointInput, type RsvpEventInput, type SendDirectMessageInput, type TransitionApplicationInput, type TransitionMembershipInput, type UpdateDeliveryEndpointInput, type UpdateEntityInput, type UpdateOwnProfileInput } from './app.ts';
import { hashTokenSecret, parseBearerToken } from './token.ts';
import { buildAdmissionsRepository } from './postgres/admissions.ts';
import { buildContentRepository } from './postgres/content.ts';
import { buildDeliveryRepository, listPendingDeliveries } from './postgres/deliveries.ts';
import { buildMessagesRepository } from './postgres/messages.ts';
import { buildProfileRepository } from './postgres/profile.ts';
import { buildSystemRepository } from './postgres/system.ts';

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

type DeliveryWorkerTokenRow = {
  token_id: string;
  actor_member_id: string;
  label: string | null;
  allowed_network_ids: string[] | string | null;
  metadata: Record<string, unknown> | null;
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

    ...buildAdmissionsRepository({ pool, applyActorContext, withActorContext }),
    ...buildProfileRepository({ pool, applyActorContext, withActorContext }),
    ...buildContentRepository({ pool, applyActorContext, withActorContext }),
    ...buildDeliveryRepository({ pool, applyActorContext, withActorContext }),
    ...buildMessagesRepository({ pool, applyActorContext, withActorContext }),
    ...buildSystemRepository({ pool, applyActorContext, withActorContext }),

  };
}
