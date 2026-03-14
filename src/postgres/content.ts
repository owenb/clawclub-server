import { Pool, type PoolClient } from 'pg';
import type {
  ArchiveEntityInput,
  CreateEntityInput,
  CreateEventInput,
  EntitySummary,
  EventRsvpState,
  EventSummary,
  ListEventsInput,
  ListEntitiesInput,
  Repository,
  RsvpEventInput,
  UpdateEntityInput,
} from '../app.ts';
import { mapEmbeddingProjectionRow } from './projections.ts';

type DbClient = Pool | PoolClient;

type ApplyActorContext = (
  client: DbClient,
  actorMemberId: string,
  networkIds: string[],
  options?: { deliveryWorkerScope?: boolean },
) => Promise<void>;

type WithActorContext = <T>(
  pool: Pool,
  actorMemberId: string,
  networkIds: string[],
  fn: (client: PoolClient) => Promise<T>,
) => Promise<T>;

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
        and e.deleted_at is null
        and cev.state = 'published'
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

export function buildContentRepository({
  pool,
  applyActorContext,
  withActorContext,
}: {
  pool: Pool;
  applyActorContext: ApplyActorContext;
  withActorContext: WithActorContext;
}): Pick<
  Repository,
  'createEntity' | 'updateEntity' | 'archiveEntity' | 'listEntities' | 'createEvent' | 'listEvents' | 'rsvpEvent'
> {
  return {
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
        const archivedAt = archiveClockResult.rows[0]?.archived_at;
        if (!archivedAt) {
          throw new Error('Archive timestamp could not be resolved');
        }

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
            values ($1, $2, 'archived', $3, $4, $5, $6, $6, $7::jsonb, $8, $9)
            returning id
          `,
          [
            current.entity_id,
            current.version_no + 1,
            current.title,
            current.summary,
            current.body,
            archivedAt,
            JSON.stringify(current.content ?? {}),
            current.version_id,
            input.actorMemberId,
          ],
        );

        await client.query('commit');

        return {
          entityId: current.entity_id,
          entityVersionId: archivedVersionResult.rows[0]!.id,
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
            expiresAt: archivedAt,
            createdAt: archivedAt,
            content: current.content ?? {},
            embedding: null,
          },
          createdAt: current.entity_created_at,
        };
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

    async listEntities({ actorMemberId, networkIds, kinds, limit, query }: ListEntitiesInput): Promise<EntitySummary[]> {
      return withActorContext(pool, actorMemberId, networkIds, async (client) => {
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
