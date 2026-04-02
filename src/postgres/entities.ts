import type { Pool } from 'pg';
import type {
  ArchiveEntityInput,
  CreateEntityInput,
  EmbeddingProjectionRow,
  EntitySummary,
  ListEntitiesInput,
  Repository,
  UpdateEntityInput,
} from '../app.ts';
import { enforceQuota } from './quotas.ts';
import { mapEmbeddingProjectionRow } from './projections.ts';
import { requireReturnedRow } from './query-guards.ts';
import { buildContainsLikePattern, buildPrefixLikePattern, normalizeSearchQuery } from './search.ts';
import { appendEntityVersionUpdates } from './updates.ts';
import type { ApplyActorContext, DbClient, WithActorContext } from './shared.ts';

type EntityRow = EmbeddingProjectionRow & {
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

type CurrentEntityRow = {
  entity_id: string;
  network_id: string;
  kind: EntitySummary['kind'];
  author_member_id: string;
  author_public_name: string;
  author_handle: string | null;
  entity_created_at: string;
  version_id: string;
  version_no: number;
  title: string | null;
  summary: string | null;
  body: string | null;
  expires_at: string | null;
  content: Record<string, unknown> | null;
};

export function mapEntityRow(row: EntityRow): EntitySummary {
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

export function buildEntityUpdatePayload(input: {
  entityId: string;
  entityVersionId: string;
  networkId: string;
  kind: EntitySummary['kind'] | 'event';
  state: 'published' | 'archived';
  author: {
    memberId: string;
    publicName: string;
    handle: string | null;
  };
  title: string | null;
  summary: string | null;
  body: string | null;
  effectiveAt: string;
  expiresAt: string | null;
  content: Record<string, unknown>;
  startsAt?: string | null;
  endsAt?: string | null;
  timezone?: string | null;
  recurrenceRule?: string | null;
  capacity?: number | null;
}) {
  return {
    kind: 'entity',
    entityId: input.entityId,
    entityVersionId: input.entityVersionId,
    networkId: input.networkId,
    entityKind: input.kind,
    state: input.state,
    author: input.author,
    title: input.title,
    summary: input.summary,
    body: input.body,
    effectiveAt: input.effectiveAt,
    expiresAt: input.expiresAt,
    content: input.content,
    startsAt: input.startsAt ?? null,
    endsAt: input.endsAt ?? null,
    timezone: input.timezone ?? null,
    recurrenceRule: input.recurrenceRule ?? null,
    capacity: input.capacity ?? null,
  };
}

export async function readEntitySummary(client: DbClient, entityId: string, entityVersionId?: string): Promise<EntitySummary | null> {
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
        and e.deleted_at is null
        and cev.state = 'published'
        and ($2::app.short_id is null or cev.id = $2)
    `,
    [entityId, entityVersionId ?? null],
  );

  return result.rows[0] ? mapEntityRow(result.rows[0]) : null;
}

export function buildEntitiesRepository({
  pool,
  applyActorContext,
  withActorContext,
}: {
  pool: Pool;
  applyActorContext: ApplyActorContext;
  withActorContext: WithActorContext;
}): Pick<
  Repository,
  'createEntity' | 'updateEntity' | 'archiveEntity' | 'listEntities'
> {
  return {
    async createEntity(input: CreateEntityInput): Promise<EntitySummary> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await applyActorContext(client, input.authorMemberId, [input.networkId]);
        await enforceQuota(client, input.authorMemberId, input.networkId, 'entities.create');
        const entityResult = await client.query<{ id: string; created_at: string }>(
          `insert into app.entities (network_id, kind, author_member_id) values ($1, $2, $3) returning id, created_at::text`,
          [input.networkId, input.kind, input.authorMemberId],
        );
        const entity = requireReturnedRow(entityResult.rows[0], 'Created entity row was not returned');
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
        const createdVersion = requireReturnedRow(versionResult.rows[0], 'Created entity version row was not returned');
        const summary = requireReturnedRow(
          await readEntitySummary(client, entity.id, createdVersion.id),
          'Created entity could not be reloaded',
        );
        await appendEntityVersionUpdates(client, {
          networkId: summary.networkId,
          entityId: summary.entityId,
          entityVersionId: summary.entityVersionId,
          topic: 'entity.version.published',
          createdByMemberId: input.authorMemberId,
          payload: buildEntityUpdatePayload({
            entityId: summary.entityId,
            entityVersionId: summary.entityVersionId,
            networkId: summary.networkId,
            kind: summary.kind,
            state: summary.version.state as 'published' | 'archived',
            author: summary.author,
            title: summary.version.title,
            summary: summary.version.summary,
            body: summary.version.body,
            effectiveAt: summary.version.effectiveAt,
            expiresAt: summary.version.expiresAt,
            content: summary.version.content,
          }),
        });
        await client.query('commit');
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
              and e.author_member_id = $3
              and e.deleted_at is null
              and cev.state = 'published'
          `,
          [input.entityId, input.accessibleNetworkIds, input.actorMemberId],
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
        const nextVersion = requireReturnedRow(nextVersionResult.rows[0], 'Updated entity version row was not returned');
        const summary = requireReturnedRow(
          await readEntitySummary(client, current.entity_id, nextVersion.id),
          'Updated entity could not be reloaded',
        );
        await appendEntityVersionUpdates(client, {
          networkId: summary.networkId,
          entityId: summary.entityId,
          entityVersionId: summary.entityVersionId,
          topic: 'entity.version.published',
          createdByMemberId: input.actorMemberId,
          payload: buildEntityUpdatePayload({
            entityId: summary.entityId,
            entityVersionId: summary.entityVersionId,
            networkId: summary.networkId,
            kind: summary.kind,
            state: summary.version.state as 'published' | 'archived',
            author: summary.author,
            title: summary.version.title,
            summary: summary.version.summary,
            body: summary.version.body,
            effectiveAt: summary.version.effectiveAt,
            expiresAt: summary.version.expiresAt,
            content: summary.version.content,
          }),
        });
        await client.query('commit');
        return summary;
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async archiveEntity(input: ArchiveEntityInput): Promise<EntitySummary | null> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await applyActorContext(client, input.actorMemberId, input.accessibleNetworkIds);

        const currentResult = await client.query<CurrentEntityRow>(
          `
            select
              e.id as entity_id,
              e.network_id,
              e.kind,
              e.author_member_id,
              m.public_name as author_public_name,
              m.handle as author_handle,
              e.created_at::text as entity_created_at,
              cev.id as version_id,
              cev.version_no,
              cev.title,
              cev.summary,
              cev.body,
              cev.expires_at::text as expires_at,
              cev.content
            from app.entities e
            join app.current_entity_versions cev on cev.entity_id = e.id
            join app.members m on m.id = e.author_member_id
            where e.id = $1
              and e.network_id = any($2::app.short_id[])
              and e.author_member_id = $3
              and e.kind = any(array['post', 'opportunity', 'service', 'ask']::app.entity_kind[])
              and e.deleted_at is null
              and cev.state = 'published'
            limit 1
          `,
          [input.entityId, input.accessibleNetworkIds, input.actorMemberId],
        );

        const current = currentResult.rows[0];
        if (!current) {
          await client.query('rollback');
          return null;
        }

        const archiveClockResult = await client.query<{ archived_at: string }>(`select now()::text as archived_at`);
        const archiveClock = requireReturnedRow(archiveClockResult.rows[0], 'Archive timestamp could not be resolved');
        const archivedAt = archiveClock.archived_at;

        const archivedVersionResult = await client.query<{ id: string }>(
          `
            insert into app.entity_versions (
              entity_id,
              version_no,
              state,
              title,
              summary,
              body,
              effective_at,
              expires_at,
              content,
              supersedes_version_id,
              created_by_member_id
            )
            values ($1, $2, 'archived', $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
            returning id
          `,
          [
            current.entity_id,
            current.version_no + 1,
            current.title,
            current.summary,
            current.body,
            archivedAt,
            current.expires_at,
            JSON.stringify(current.content ?? {}),
            current.version_id,
            input.actorMemberId,
          ],
        );
        const archivedVersion = requireReturnedRow(archivedVersionResult.rows[0], 'Archived entity version row was not returned');

        const summary: EntitySummary = {
          entityId: current.entity_id,
          entityVersionId: archivedVersion.id,
          networkId: current.network_id,
          kind: current.kind,
          author: {
            memberId: current.author_member_id,
            publicName: current.author_public_name,
            handle: current.author_handle,
          },
          version: {
            versionNo: current.version_no + 1,
            state: 'archived',
            title: current.title,
            summary: current.summary,
            body: current.body,
            effectiveAt: archivedAt,
            expiresAt: current.expires_at,
            createdAt: archivedAt,
            content: current.content ?? {},
            embedding: null,
          },
          createdAt: current.entity_created_at,
        };
        await appendEntityVersionUpdates(client, {
          networkId: summary.networkId,
          entityId: summary.entityId,
          entityVersionId: summary.entityVersionId,
          topic: 'entity.version.archived',
          createdByMemberId: input.actorMemberId,
          payload: buildEntityUpdatePayload({
            entityId: summary.entityId,
            entityVersionId: summary.entityVersionId,
            networkId: summary.networkId,
            kind: summary.kind,
            state: summary.version.state as 'published' | 'archived',
            author: summary.author,
            title: summary.version.title,
            summary: summary.version.summary,
            body: summary.version.body,
            effectiveAt: summary.version.effectiveAt,
            expiresAt: summary.version.expiresAt,
            content: summary.version.content,
          }),
        });
        await client.query('commit');
        return summary;
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async listEntities({ actorMemberId, networkIds, kinds, limit, query }: ListEntitiesInput): Promise<EntitySummary[]> {
      return withActorContext(pool, actorMemberId, networkIds, async (client) => {
        const trimmedQuery = normalizeSearchQuery(query);
        const likePattern = buildContainsLikePattern(trimmedQuery);
        const prefixPattern = buildPrefixLikePattern(trimmedQuery);

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
                or coalesce(le.title, '') ilike $4 escape '\\'
                or coalesce(le.summary, '') ilike $4 escape '\\'
                or coalesce(le.body, '') ilike $4 escape '\\'
              )
            order by
              case
                when $3::text is null then 0
                when lower(coalesce(le.title, '')) = lower($3::text) then 400
                when lower(coalesce(le.title, '')) like lower($5::text) escape '\\' then 250
                when lower(coalesce(le.summary, '')) like lower($5::text) escape '\\' then 175
                when lower(coalesce(le.body, '')) like lower($5::text) escape '\\' then 120
                when coalesce(le.title, '') ilike $4 escape '\\' then 90
                when coalesce(le.summary, '') ilike $4 escape '\\' then 60
                when coalesce(le.body, '') ilike $4 escape '\\' then 30
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
