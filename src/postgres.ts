import { Pool, type PoolClient } from 'pg';
import { AppError, type AcknowledgeDeliveryInput, type ActorContext, type ApplicationStatus, type ApplicationSummary, type ArchiveNetworkInput, type AssignNetworkOwnerInput, type AuthResult, type BearerTokenSummary, type ClaimDeliveryInput, type ClaimedDelivery, type CompleteDeliveryAttemptInput, type CreateApplicationInput, type CreateBearerTokenInput, type CreateDeliveryEndpointInput, type CreateEntityInput, type CreateEventInput, type CreateMembershipInput, type CreateNetworkInput, type CreatedBearerToken, type DeliveryAcknowledgement, type DeliveryAttemptInspection, type DeliveryAttemptSummary, type DeliveryEndpointState, type DeliveryEndpointSummary, type DeliverySummary, type DeliveryWorkerAuthResult, type DirectMessageInboxSummary, type DirectMessageReceipt, type DirectMessageSummary, type DirectMessageThreadSummary, type DirectMessageTranscriptEntry, type EmbeddingProjectionSummary, type EntitySummary, type EventRsvpState, type EventSummary, type FailDeliveryAttemptInput, type ListDeliveriesInput, type ListDeliveryAttemptsInput, type ListEventsInput, type MemberProfile, type MemberSearchResult, type MembershipAdminSummary, type MembershipReviewSummary, type MembershipState, type MembershipSummary, type MembershipVouchSummary, type NetworkMemberSummary, type NetworkSummary, type PendingDelivery, type Repository, type RetryDeliveryInput, type RevokeBearerTokenInput, type RevokeDeliveryEndpointInput, type RsvpEventInput, type SendDirectMessageInput, type TransitionApplicationInput, type TransitionMembershipInput, type UpdateDeliveryEndpointInput, type UpdateEntityInput, type UpdateOwnProfileInput } from './app.ts';
import { hashTokenSecret, parseBearerToken } from './token.ts';
import { buildAdmissionsRepository } from './postgres/admissions.ts';
import { buildContentRepository } from './postgres/content.ts';
import { buildDeliveryRepository, listPendingDeliveries } from './postgres/deliveries.ts';
import { buildMessagesRepository } from './postgres/messages.ts';
import { buildProfileRepository } from './postgres/profile.ts';

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

  };
}
