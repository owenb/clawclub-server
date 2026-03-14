import { Pool, type PoolClient } from 'pg';
import type { EntitySummary, MemberUpdates, PendingDelivery, Repository } from '../app.ts';
import { mapEmbeddingProjectionRow } from './projections.ts';
import { listPendingDeliveries } from './deliveries.ts';

type DbClient = Pool | PoolClient;

type ApplyActorContext = (
  client: DbClient,
  actorMemberId: string,
  networkIds: string[],
  options?: { deliveryWorkerScope?: boolean },
) => Promise<void>;

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

async function listUnseenPostUpdates(
  client: DbClient,
  actorMemberId: string,
  accessibleNetworkIds: string[],
  excludedEntityVersionIds: string[],
  limit: number,
): Promise<EntitySummary[]> {
  if (accessibleNetworkIds.length === 0 || limit <= 0) {
    return [];
  }

  const result = await client.query<EntityRow>(
    `
      with scope as (
        select anm.network_id, anm.joined_at
        from app.accessible_network_memberships anm
        where anm.member_id = $1
          and anm.network_id = any($2::app.short_id[])
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
      join app.members m on m.id = le.author_member_id
      left join app.current_entity_version_embeddings ceve on ceve.entity_version_id = le.entity_version_id
      left join app.member_entity_update_receipts meur
        on meur.member_id = $1
       and meur.entity_version_id = le.entity_version_id
      where le.kind = 'post'
        and le.author_member_id <> $1
        and meur.id is null
        and le.effective_at >= s.joined_at
        and not (le.entity_version_id = any($3::app.short_id[]))
      order by le.effective_at asc, le.entity_id asc
      limit $4
    `,
    [actorMemberId, accessibleNetworkIds, excludedEntityVersionIds, limit],
  );

  return result.rows.map(mapEntityRow);
}

async function markDeliveriesShown(
  client: DbClient,
  actorMemberId: string,
  accessibleNetworkIds: string[],
  deliveries: PendingDelivery[],
): Promise<void> {
  const deliveryIds = deliveries.map((delivery) => delivery.deliveryId);
  if (deliveryIds.length === 0) {
    return;
  }

  await client.query(
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
      select
        d.id,
        d.recipient_member_id,
        d.network_id,
        'shown'::app.delivery_ack_state,
        null,
        coalesce(cda.version_no, 0) + 1,
        cda.id,
        $2
      from app.pending_deliveries d
      left join app.current_delivery_acknowledgements cda
        on cda.delivery_id = d.id
       and cda.recipient_member_id = d.recipient_member_id
      where d.id = any($1::app.short_id[])
        and d.recipient_member_id = $2
        and d.network_id = any($3::app.short_id[])
    `,
    [deliveryIds, actorMemberId, accessibleNetworkIds],
  );
}

async function markPostsSeen(client: DbClient, actorMemberId: string, posts: EntitySummary[]): Promise<void> {
  for (const post of posts) {
    await client.query(
      `
        insert into app.member_entity_update_receipts (
          member_id,
          network_id,
          entity_id,
          entity_version_id,
          created_by_member_id
        )
        values ($1, $2, $3, $4, $5)
        on conflict (member_id, entity_version_id) do nothing
      `,
      [actorMemberId, post.networkId, post.entityId, post.entityVersionId, actorMemberId],
    );
  }
}

export function buildUpdatesRepository({
  pool,
  applyActorContext,
}: {
  pool: Pool;
  applyActorContext: ApplyActorContext;
}): Pick<Repository, 'pollUpdates'> {
  return {
    async pollUpdates({ actorMemberId, accessibleNetworkIds, limit }): Promise<MemberUpdates> {
      const client = await pool.connect();

      try {
        await client.query('begin');
        await applyActorContext(client, actorMemberId, accessibleNetworkIds);

        const deliveries = (await listPendingDeliveries(client, actorMemberId, accessibleNetworkIds)).slice(0, limit);
        const excludedEntityVersionIds = deliveries
          .map((delivery) => delivery.entityVersionId)
          .filter((entityVersionId): entityVersionId is string => Boolean(entityVersionId));
        const posts = await listUnseenPostUpdates(client, actorMemberId, accessibleNetworkIds, excludedEntityVersionIds, limit);

        await markDeliveriesShown(client, actorMemberId, accessibleNetworkIds, deliveries);
        await markPostsSeen(client, actorMemberId, posts);

        const polledAtResult = await client.query<{ polled_at: string }>(`select now()::text as polled_at`);
        await client.query('commit');

        return {
          deliveries,
          posts,
          polledAt: polledAtResult.rows[0]?.polled_at ?? new Date().toISOString(),
        };
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
