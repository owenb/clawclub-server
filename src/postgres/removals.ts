import type { Pool } from 'pg';
import {
  AppError,
  type EntitySummary,
  type EventSummary,
  type MessageRemovalResult,
  type RemoveEntityInput,
  type RemoveMessageInput,
  type Repository,
} from '../contract.ts';
import { requireReturnedRow } from './query-guards.ts';
import { appendClubActivity } from './updates.ts';
import { mapEntityRow, buildEntityUpdatePayload } from './entities.ts';
import type { ApplyActorContext, DbClient } from './helpers.ts';

type CurrentVersionRow = {
  entity_id: string;
  club_id: string;
  kind: string;
  author_member_id: string;
  author_public_name: string;
  author_handle: string | null;
  entity_created_at: string;
  version_id: string;
  version_no: number;
  state: string;
  title: string | null;
  summary: string | null;
  body: string | null;
  effective_at: string;
  expires_at: string | null;
  content: Record<string, unknown> | null;
  location: string | null;
  starts_at: string | null;
  ends_at: string | null;
  timezone: string | null;
  recurrence_rule: string | null;
  capacity: number | null;
};

async function lookupCurrentVersion(
  client: DbClient,
  entityId: string,
  accessibleClubIds: string[],
  kindFilter: string[] | null,
): Promise<CurrentVersionRow | null> {
  const result = await client.query<CurrentVersionRow>(
    `
      select
        e.id as entity_id,
        e.club_id,
        e.kind,
        e.author_member_id,
        m.public_name as author_public_name,
        m.handle as author_handle,
        e.created_at::text as entity_created_at,
        cev.id as version_id,
        cev.version_no,
        cev.state,
        cev.title,
        cev.summary,
        cev.body,
        cev.effective_at::text as effective_at,
        cev.expires_at::text as expires_at,
        cev.content,
        cev.location,
        cev.starts_at::text as starts_at,
        cev.ends_at::text as ends_at,
        cev.timezone,
        cev.recurrence_rule,
        cev.capacity
      from app.entities e
      join app.current_entity_versions cev on cev.entity_id = e.id
      join app.members m on m.id = e.author_member_id
      where e.id = $1
        and e.club_id = any($2::app.short_id[])
        and e.deleted_at is null
        and ($3::app.entity_kind[] is null or e.kind = any($3::app.entity_kind[]))
      limit 1
    `,
    [entityId, accessibleClubIds, kindFilter],
  );
  return result.rows[0] ?? null;
}

export function buildRemovalsRepository({
  pool,
  applyActorContext,
}: {
  pool: Pool;
  applyActorContext: ApplyActorContext;
}): Pick<Repository, 'removeEntity' | 'removeEvent' | 'removeMessage'> {
  return {
    async removeEntity(input: RemoveEntityInput): Promise<EntitySummary | null> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await applyActorContext(client, input.actorMemberId, input.accessibleClubIds);

        const current = await lookupCurrentVersion(
          client, input.entityId, input.accessibleClubIds,
          ['post', 'opportunity', 'service', 'ask'],
        );
        if (!current) {
          await client.query('rollback');
          return null;
        }

        // Authorization: author only (unless skipAuthCheck for clubadmin path)
        if (!input.skipAuthCheck && current.author_member_id !== input.actorMemberId) {
          await client.query('rollback');
          throw new AppError(403, 'forbidden', 'Only the author may remove this entity');
        }

        // Idempotent: already removed — return current state directly
        if (current.state === 'removed') {
          await client.query('rollback');
          return {
            entityId: current.entity_id,
            entityVersionId: current.version_id,
            clubId: current.club_id,
            kind: current.kind as EntitySummary['kind'],
            author: {
              memberId: current.author_member_id,
              publicName: current.author_public_name,
              handle: current.author_handle,
            },
            version: {
              versionNo: current.version_no,
              state: 'removed',
              title: current.title,
              summary: current.summary,
              body: current.body,
              effectiveAt: current.effective_at ?? '',
              expiresAt: current.expires_at,
              createdAt: current.entity_created_at,
              content: current.content ?? {},
            },
            createdAt: current.entity_created_at,
          };
        }

        const clockResult = await client.query<{ now: string }>(`select now()::text as now`);
        const now = requireReturnedRow(clockResult.rows[0], 'Clock query failed').now;

        const versionResult = await client.query<{ id: string }>(
          `
            insert into app.entity_versions (
              entity_id, version_no, state, reason,
              title, summary, body, effective_at, expires_at, content,
              supersedes_version_id, created_by_member_id
            )
            values ($1, $2, 'removed', $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
            returning id
          `,
          [
            current.entity_id,
            current.version_no + 1,
            input.reason ?? null,
            current.title,
            current.summary,
            current.body,
            now,
            current.expires_at,
            JSON.stringify(current.content ?? {}),
            current.version_id,
            input.actorMemberId,
          ],
        );
        const removedVersion = requireReturnedRow(versionResult.rows[0], 'Removed entity version row was not returned');

        const summary: EntitySummary = {
          entityId: current.entity_id,
          entityVersionId: removedVersion.id,
          clubId: current.club_id,
          kind: current.kind as EntitySummary['kind'],
          author: {
            memberId: current.author_member_id,
            publicName: current.author_public_name,
            handle: current.author_handle,
          },
          version: {
            versionNo: current.version_no + 1,
            state: 'removed',
            title: current.title,
            summary: current.summary,
            body: current.body,
            effectiveAt: now,
            expiresAt: current.expires_at,
            createdAt: now,
            content: current.content ?? {},
          },
          createdAt: current.entity_created_at,
        };

        if (!input.skipNotification) {
          await appendClubActivity(client, {
            clubId: summary.clubId,
            entityId: summary.entityId,
            entityVersionId: summary.entityVersionId,
            topic: 'entity.removed',
            createdByMemberId: input.actorMemberId,
            payload: buildEntityUpdatePayload({
              entityId: summary.entityId,
              entityVersionId: summary.entityVersionId,
              clubId: summary.clubId,
              kind: summary.kind,
              state: 'removed',
              author: summary.author,
              title: summary.version.title,
              summary: summary.version.summary,
              body: summary.version.body,
              effectiveAt: summary.version.effectiveAt,
              expiresAt: summary.version.expiresAt,
              content: summary.version.content,
            }),
          });
        }

        await client.query('commit');
        return summary;
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async removeEvent(input: RemoveEntityInput): Promise<EventSummary | null> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await applyActorContext(client, input.actorMemberId, input.accessibleClubIds);

        const current = await lookupCurrentVersion(
          client, input.entityId, input.accessibleClubIds,
          ['event'],
        );
        if (!current) {
          await client.query('rollback');
          return null;
        }

        if (!input.skipAuthCheck && current.author_member_id !== input.actorMemberId) {
          await client.query('rollback');
          throw new AppError(403, 'forbidden', 'Only the author may remove this event');
        }

        // Idempotent: already removed — return current state
        if (current.state === 'removed') {
          await client.query('rollback');
          return {
            entityId: current.entity_id,
            entityVersionId: current.version_id,
            clubId: current.club_id,
            author: {
              memberId: current.author_member_id,
              publicName: current.author_public_name,
              handle: current.author_handle,
            },
            version: {
              versionNo: current.version_no,
              state: 'removed' as const,
              title: current.title,
              summary: current.summary,
              body: current.body,
              location: current.location,
              startsAt: current.starts_at,
              endsAt: current.ends_at,
              timezone: current.timezone,
              recurrenceRule: current.recurrence_rule,
              capacity: current.capacity,
              effectiveAt: current.effective_at ?? '',
              expiresAt: current.expires_at,
              createdAt: current.entity_created_at,
              content: current.content ?? {},
            },
            rsvps: {
              viewerResponse: null,
              counts: { yes: 0, maybe: 0, no: 0, waitlist: 0 },
              attendees: [],
            },
            createdAt: current.entity_created_at,
          };
        }

        const clockResult = await client.query<{ now: string }>(`select now()::text as now`);
        const now = requireReturnedRow(clockResult.rows[0], 'Clock query failed').now;

        const versionResult = await client.query<{ id: string }>(
          `
            insert into app.entity_versions (
              entity_id, version_no, state, reason,
              title, summary, body, location, starts_at, ends_at, timezone,
              recurrence_rule, capacity, effective_at, expires_at, content,
              supersedes_version_id, created_by_member_id
            )
            values ($1, $2, 'removed', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16, $17)
            returning id
          `,
          [
            current.entity_id,
            current.version_no + 1,
            input.reason ?? null,
            current.title,
            current.summary,
            current.body,
            current.location,
            current.starts_at,
            current.ends_at,
            current.timezone,
            current.recurrence_rule,
            current.capacity,
            now,
            current.expires_at,
            JSON.stringify(current.content ?? {}),
            current.version_id,
            input.actorMemberId,
          ],
        );
        const removedVersion = requireReturnedRow(versionResult.rows[0], 'Removed event version row was not returned');

        if (!input.skipNotification) {
          await appendClubActivity(client, {
            clubId: current.club_id,
            entityId: current.entity_id,
            entityVersionId: removedVersion.id,
            topic: 'entity.removed',
            createdByMemberId: input.actorMemberId,
            payload: buildEntityUpdatePayload({
              entityId: current.entity_id,
              entityVersionId: removedVersion.id,
              clubId: current.club_id,
              kind: 'event',
              state: 'removed',
              author: {
                memberId: current.author_member_id,
                publicName: current.author_public_name,
                handle: current.author_handle,
              },
              title: current.title,
              summary: current.summary,
              body: current.body,
              effectiveAt: now,
              expiresAt: current.expires_at,
              content: current.content ?? {},
              location: current.location,
              startsAt: current.starts_at,
              endsAt: current.ends_at,
              timezone: current.timezone,
              recurrenceRule: current.recurrence_rule,
              capacity: current.capacity,
            }),
          });
        }

        await client.query('commit');

        // Build event summary inline (actor context is lost after commit)
        return {
          entityId: current.entity_id,
          entityVersionId: removedVersion.id,
          clubId: current.club_id,
          author: {
            memberId: current.author_member_id,
            publicName: current.author_public_name,
            handle: current.author_handle,
          },
          version: {
            versionNo: current.version_no + 1,
            state: 'removed' as const,
            title: current.title,
            summary: current.summary,
            body: current.body,
            location: current.location,
            startsAt: current.starts_at,
            endsAt: current.ends_at,
            timezone: current.timezone,
            recurrenceRule: current.recurrence_rule,
            capacity: current.capacity,
            effectiveAt: now,
            expiresAt: current.expires_at,
            createdAt: now,
            content: current.content ?? {},
          },
          rsvps: {
            viewerResponse: null,
            counts: { yes: 0, maybe: 0, no: 0, waitlist: 0 },
            attendees: [],
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

    async removeMessage(input: RemoveMessageInput): Promise<MessageRemovalResult | null> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await applyActorContext(client, input.actorMemberId, input.accessibleClubIds);

        // Look up message + club + sender
        const msgResult = await client.query<{
          message_id: string;
          club_id: string;
          sender_member_id: string | null;
          counterpart_member_id: string;
        }>(
          `
            select
              tm.id as message_id,
              tt.club_id,
              tm.sender_member_id,
              case
                when tt.created_by_member_id::text = coalesce(tm.sender_member_id, '')::text
                  then tt.counterpart_member_id
                else tt.created_by_member_id
              end as counterpart_member_id
            from app.dm_messages tm
            join app.dm_threads tt on tt.id = tm.thread_id
            where tm.id = $1
              and tt.club_id = any($2::app.short_id[])
          `,
          [input.messageId, input.accessibleClubIds],
        );
        const msg = msgResult.rows[0];
        if (!msg) {
          await client.query('rollback');
          return null;
        }

        // Authorization: sender only (unless skipAuthCheck for clubadmin path)
        if (!input.skipAuthCheck) {
          const isSender = msg.sender_member_id === input.actorMemberId;
          if (!isSender) {
            await client.query('rollback');
            throw new AppError(403, 'forbidden', 'Only the sender may remove this message');
          }
        }

        // Insert removal (idempotent via ON CONFLICT DO NOTHING)
        const result = await client.query<{
          message_id: string;
          club_id: string;
          removed_by_member_id: string;
          reason: string | null;
          removed_at: string;
        }>(
          `
            insert into app.dm_message_removals (message_id, club_id, removed_by_member_id, reason)
            values ($1, $2, $3, $4)
            on conflict (message_id) do nothing
            returning message_id, club_id, removed_by_member_id, reason, removed_at::text as removed_at
          `,
          [input.messageId, msg.club_id, input.actorMemberId, input.reason ?? null],
        );

        let removal: MessageRemovalResult;

        if (result.rows[0]) {
          // New removal
          removal = {
            messageId: result.rows[0].message_id,
            clubId: result.rows[0].club_id,
            removedByMemberId: result.rows[0].removed_by_member_id,
            reason: result.rows[0].reason,
            removedAt: result.rows[0].removed_at,
          };
        } else {
          // Already removed — reload existing
          const existing = await client.query<{
            message_id: string; club_id: string; removed_by_member_id: string;
            reason: string | null; removed_at: string;
          }>(
            `select message_id, club_id, removed_by_member_id, reason, removed_at::text as removed_at
             from app.dm_message_removals where message_id = $1`,
            [input.messageId],
          );
          const row = requireReturnedRow(existing.rows[0], 'Existing removal not found');
          removal = {
            messageId: row.message_id,
            clubId: row.club_id,
            removedByMemberId: row.removed_by_member_id,
            reason: row.reason,
            removedAt: row.removed_at,
          };
        }

        // Notify participants
        if (!input.skipNotification && result.rows[0]) {
          const recipientIds = [msg.sender_member_id, msg.counterpart_member_id].filter(
            (id): id is string => !!id && id !== input.actorMemberId,
          );
          if (recipientIds.length > 0) {
            await client.query(
              `
                insert into app.member_updates (
                  recipient_member_id, club_id, dm_message_id, topic, payload, created_by_member_id
                )
                select
                  unnest($1::app.short_id[]),
                  $2::app.short_id,
                  $3::app.short_id,
                  'dm.message.removed',
                  $4::jsonb,
                  $5::app.short_id
              `,
              [
                recipientIds,
                msg.club_id,
                input.messageId,
                JSON.stringify({
                  kind: 'message_removal',
                  messageId: input.messageId,
                }),
                input.actorMemberId,
              ],
            );
          }
        }

        await client.query('commit');
        return removal;
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
