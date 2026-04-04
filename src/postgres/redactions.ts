import type { Pool } from 'pg';
import { AppError, type RedactionResult, type Repository } from '../contract.ts';
import type { ApplyActorContext, DbClient } from './helpers.ts';

type RedactionRow = {
  id: string;
  target_kind: 'dm_message' | 'entity';
  target_id: string;
  club_id: string;
  created_by_member_id: string;
  created_at: string;
};

function mapRedactionRow(row: RedactionRow): RedactionResult {
  return {
    redactionId: row.id,
    targetKind: row.target_kind,
    targetId: row.target_id,
    clubId: row.club_id,
    createdByMemberId: row.created_by_member_id,
    createdAt: row.created_at,
  };
}

async function appendRedactionUpdate(
  client: DbClient,
  input: {
    clubId: string;
    targetKind: 'dm_message' | 'entity';
    targetId: string;
    redactionId: string;
    createdByMemberId: string;
    recipientMemberIds: string[];
  },
): Promise<void> {
  if (input.recipientMemberIds.length === 0) return;

  const topic = input.targetKind === 'dm_message' ? 'dm.message.redacted' : 'entity.redacted';

  await client.query(
    `
      insert into app.member_updates (
        recipient_member_id,
        club_id,
        topic,
        payload,
        created_by_member_id
      )
      select
        unnest($1::app.short_id[]),
        $2::app.short_id,
        $3,
        $4::jsonb,
        $5::app.short_id
    `,
    [
      input.recipientMemberIds,
      input.clubId,
      topic,
      JSON.stringify({
        kind: 'redaction',
        targetKind: input.targetKind,
        targetId: input.targetId,
        redactionId: input.redactionId,
      }),
      input.createdByMemberId,
    ],
  );
}

export function buildRedactionsRepository({
  pool,
  applyActorContext,
}: {
  pool: Pool;
  applyActorContext: ApplyActorContext;
}): Pick<Repository, 'redactMessage' | 'redactEntity'> {
  return {
    async redactMessage(input): Promise<{ redaction: RedactionResult; senderMemberId: string | null } | null> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await applyActorContext(client, input.actorMemberId, input.accessibleClubIds);

        // Resolve the message's club and sender
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
          `,
          [input.messageId],
        );
        const msg = msgResult.rows[0];
        if (!msg) {
          await client.query('rollback');
          return null;
        }

        // Authorization: sender or club owner (skipped for admin paths)
        if (!input.skipAuthCheck) {
          const isSender = msg.sender_member_id === input.actorMemberId;
          const isOwner = input.ownerClubIds.includes(msg.club_id);
          if (!isSender && !isOwner) {
            await client.query('rollback');
            throw new AppError(403, 'forbidden', 'Only the sender or a club owner may redact this message');
          }
        }

        // Insert redaction (idempotent via ON CONFLICT)
        const result = await client.query<RedactionRow>(
          `
            insert into app.redactions (club_id, target_kind, target_id, reason, created_by_member_id)
            values ($1, 'dm_message', $2, $3, $4)
            on conflict (target_kind, target_id) do update set target_kind = app.redactions.target_kind
            returning id, target_kind, target_id, club_id, created_by_member_id, created_at::text as created_at
          `,
          [msg.club_id, input.messageId, input.reason ?? null, input.actorMemberId],
        );

        const redaction = result.rows[0]!;

        // Notify participants (skipped for admin/superadmin redactions)
        if (!input.skipNotification) await appendRedactionUpdate(client, {
          clubId: msg.club_id,
          targetKind: 'dm_message',
          targetId: input.messageId,
          redactionId: redaction.id,
          createdByMemberId: input.actorMemberId,
          recipientMemberIds: [msg.sender_member_id, msg.counterpart_member_id].filter(
            (id): id is string => !!id && id !== input.actorMemberId,
          ),
        });

        await client.query('commit');
        return { redaction: mapRedactionRow(redaction), senderMemberId: msg.sender_member_id };
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async redactEntity(input): Promise<{ redaction: RedactionResult; authorMemberId: string } | null> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await applyActorContext(client, input.actorMemberId, input.accessibleClubIds);

        // Resolve entity's club and author
        const entityResult = await client.query<{
          entity_id: string;
          club_id: string;
          author_member_id: string;
        }>(
          `
            select e.id as entity_id, e.club_id, e.author_member_id
            from app.entities e
            where e.id = $1 and e.deleted_at is null
          `,
          [input.entityId],
        );
        const entity = entityResult.rows[0];
        if (!entity) {
          await client.query('rollback');
          return null;
        }

        // Authorization: author or club owner (skipped for admin paths)
        if (!input.skipAuthCheck) {
          const isAuthor = entity.author_member_id === input.actorMemberId;
          const isOwner = input.ownerClubIds.includes(entity.club_id);
          if (!isAuthor && !isOwner) {
            await client.query('rollback');
            throw new AppError(403, 'forbidden', 'Only the author or a club owner may redact this entity');
          }
        }

        // Insert redaction (idempotent via ON CONFLICT)
        const result = await client.query<RedactionRow>(
          `
            insert into app.redactions (club_id, target_kind, target_id, reason, created_by_member_id)
            values ($1, 'entity', $2, $3, $4)
            on conflict (target_kind, target_id) do update set target_kind = app.redactions.target_kind
            returning id, target_kind, target_id, club_id, created_by_member_id, created_at::text as created_at
          `,
          [entity.club_id, input.entityId, input.reason ?? null, input.actorMemberId],
        );

        const redaction = result.rows[0]!;

        // Notify all club members except actor (skipped for admin/superadmin redactions)
        if (input.skipNotification) {
          await client.query('commit');
          return { redaction: mapRedactionRow(redaction), authorMemberId: entity.author_member_id };
        }

        const recipientsResult = await client.query<{ member_id: string }>(
          `
            select member_id from app.accessible_club_memberships
            where club_id = $1 and member_id <> $2::text
          `,
          [entity.club_id, input.actorMemberId],
        );

        await appendRedactionUpdate(client, {
          clubId: entity.club_id,
          targetKind: 'entity',
          targetId: input.entityId,
          redactionId: redaction.id,
          createdByMemberId: input.actorMemberId,
          recipientMemberIds: recipientsResult.rows.map((r) => r.member_id),
        });

        await client.query('commit');
        return { redaction: mapRedactionRow(redaction), authorMemberId: entity.author_member_id };
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
