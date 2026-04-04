import type { Pool } from 'pg';
import type {
  AdminContentSummary,
  EntityKind,
  Repository,
} from '../contract.ts';
import type { ApplyActorContext, WithActorContext } from './helpers.ts';

export function buildAdminRepository({
  pool,
  applyActorContext,
  withActorContext,
}: {
  pool: Pool;
  applyActorContext: ApplyActorContext;
  withActorContext: WithActorContext;
}): Pick<
  Repository,
  | 'adminGetOverview'
  | 'adminListMembers'
  | 'adminGetMember'
  | 'adminGetClubStats'
  | 'adminListContent'
  | 'adminArchiveEntity'
  | 'adminListThreads'
  | 'adminReadThread'
  | 'adminListMemberTokens'
  | 'adminRevokeMemberToken'
  | 'adminGetDiagnostics'
> {
  return {
    async adminGetOverview({ actorMemberId }) {
      return withActorContext(pool, actorMemberId, [], async (client) => {
        const result = await client.query<{
          total_members: string;
          total_clubs: string;
          total_entities: string;
          total_messages: string;
          total_admissions: string;
          recent_members: Array<{
            memberId: string;
            publicName: string;
            handle: string | null;
            createdAt: string;
          }>;
        }>(`
          select
            (select count(*) from app.members where state = 'active')::text as total_members,
            (select count(*) from app.clubs where archived_at is null)::text as total_clubs,
            (select count(*) from app.entities)::text as total_entities,
            (select count(*) from app.dm_messages)::text as total_messages,
            (select count(*) from app.admissions)::text as total_admissions,
            coalesce((
              select jsonb_agg(jsonb_build_object(
                'memberId', m.id,
                'publicName', m.public_name,
                'handle', m.handle,
                'createdAt', m.created_at::text
              ) order by m.created_at desc)
              from (
                select id, public_name, handle, created_at
                from app.members
                where state = 'active'
                order by created_at desc
                limit 10
              ) m
            ), '[]'::jsonb) as recent_members
        `);

        const row = result.rows[0];
        return {
          totalMembers: Number(row.total_members),
          totalClubs: Number(row.total_clubs),
          totalEntities: Number(row.total_entities),
          totalMessages: Number(row.total_messages),
          totalAdmissions: Number(row.total_admissions),
          recentMembers: row.recent_members,
        };
      });
    },

    async adminListMembers({ actorMemberId, limit, cursor }) {
      return withActorContext(pool, actorMemberId, [], async (client) => {
        const result = await client.query<{
          member_id: string;
          public_name: string;
          handle: string | null;
          state: string;
          created_at: string;
          membership_count: string;
          token_count: string;
        }>(
          `
            select
              m.id as member_id,
              m.public_name,
              m.handle,
              m.state::text,
              m.created_at::text as created_at,
              (select count(*) from app.club_memberships nm where nm.member_id = m.id)::text as membership_count,
              (select count(*) from app.member_bearer_tokens mbt where mbt.member_id = m.id and mbt.revoked_at is null)::text as token_count
            from app.members m
            where ($2::timestamptz is null or (m.created_at, m.id) < ($2::timestamptz, $3::text))
            order by m.created_at desc, m.id desc
            limit $1
          `,
          [limit, cursor?.createdAt ?? null, cursor?.id ?? null],
        );

        return result.rows.map((row) => ({
          memberId: row.member_id,
          publicName: row.public_name,
          handle: row.handle,
          state: row.state,
          createdAt: row.created_at,
          membershipCount: Number(row.membership_count),
          tokenCount: Number(row.token_count),
        }));
      });
    },

    async adminGetMember({ actorMemberId, memberId }) {
      return withActorContext(pool, actorMemberId, [], async (client) => {
        const memberResult = await client.query<{
          member_id: string;
          public_name: string;
          handle: string | null;
          state: string;
          created_at: string;
          token_count: string;
        }>(
          `
            select
              m.id as member_id,
              m.public_name,
              m.handle,
              m.state::text,
              m.created_at::text as created_at,
              (select count(*) from app.member_bearer_tokens mbt where mbt.member_id = m.id and mbt.revoked_at is null)::text as token_count
            from app.members m
            where m.id = $1
            limit 1
          `,
          [memberId],
        );

        const member = memberResult.rows[0];
        if (!member) {
          return null;
        }

        const membershipsResult = await client.query<{
          membership_id: string;
          club_id: string;
          club_name: string;
          club_slug: string;
          role: string;
          status: string;
          joined_at: string;
        }>(
          `
            select
              nm.id as membership_id,
              nm.club_id,
              n.name as club_name,
              n.slug as club_slug,
              nm.role::text,
              nm.status::text,
              nm.joined_at::text as joined_at
            from app.club_memberships nm
            join app.clubs n on n.id = nm.club_id
            where nm.member_id = $1
            order by nm.joined_at desc
          `,
          [memberId],
        );

        return {
          memberId: member.member_id,
          publicName: member.public_name,
          handle: member.handle,
          state: member.state,
          createdAt: member.created_at,
          memberships: membershipsResult.rows.map((row) => ({
            membershipId: row.membership_id,
            clubId: row.club_id,
            clubName: row.club_name,
            clubSlug: row.club_slug,
            role: row.role,
            status: row.status,
            joinedAt: row.joined_at,
          })),
          tokenCount: Number(member.token_count),
          profile: null,
        };
      });
    },

    async adminGetClubStats({ actorMemberId, clubId }) {
      return withActorContext(pool, actorMemberId, [], async (client) => {
        const result = await client.query<{
          club_id: string;
          slug: string;
          name: string;
          archived_at: string | null;
          member_counts: Record<string, number>;
          entity_count: string;
          message_count: string;
          admission_counts: Record<string, number>;
        }>(
          `
            select
              n.id as club_id,
              n.slug,
              n.name,
              n.archived_at::text,
              coalesce((
                select jsonb_object_agg(status::text, cnt)
                from (
                  select nm.status, count(*)::int as cnt
                  from app.club_memberships nm
                  where nm.club_id = n.id
                  group by nm.status
                ) s
              ), '{}'::jsonb) as member_counts,
              (select count(*) from app.entities e where e.club_id = n.id)::text as entity_count,
              (
                select count(*)
                from app.dm_messages tm
                join app.dm_threads tt on tt.id = tm.thread_id
                where tt.club_id = n.id
              )::text as message_count,
              coalesce((
                select jsonb_object_agg(status::text, cnt)
                from (
                  select av.status, count(*)::int as cnt
                  from app.admissions a
                  join app.current_admission_versions av on av.admission_id = a.id
                  where a.club_id = n.id
                  group by av.status
                ) s
              ), '{}'::jsonb) as admission_counts
            from app.clubs n
            where n.id = $1
            limit 1
          `,
          [clubId],
        );

        const row = result.rows[0];
        if (!row) {
          return null;
        }

        return {
          clubId: row.club_id,
          slug: row.slug,
          name: row.name,
          archivedAt: row.archived_at,
          memberCounts: row.member_counts,
          entityCount: Number(row.entity_count),
          messageCount: Number(row.message_count),
          admissionCounts: row.admission_counts,
        };
      });
    },

    async adminListContent({ actorMemberId, clubId, kind, limit, cursor }) {
      return withActorContext(pool, actorMemberId, [], async (client) => {
        const result = await client.query<{
          entity_id: string;
          club_id: string;
          club_name: string;
          kind: EntityKind;
          author_member_id: string;
          author_public_name: string;
          author_handle: string | null;
          title: string | null;
          state: string;
          created_at: string;
        }>(
          `
            select
              e.id as entity_id,
              e.club_id,
              n.name as club_name,
              e.kind::text as kind,
              e.author_member_id,
              m.public_name as author_public_name,
              m.handle as author_handle,
              ev.title,
              ev.state::text,
              e.created_at::text as created_at
            from app.entities e
            join app.clubs n on n.id = e.club_id
            join app.members m on m.id = e.author_member_id
            join app.current_entity_versions ev on ev.entity_id = e.id
            where ($1::app.short_id is null or e.club_id = $1)
              and ($2::app.entity_kind is null or e.kind = $2)
              and ($4::timestamptz is null or (e.created_at, e.id) < ($4::timestamptz, $5::text))
            order by e.created_at desc, e.id desc
            limit $3
          `,
          [clubId ?? null, kind ?? null, limit, cursor?.createdAt ?? null, cursor?.id ?? null],
        );

        return result.rows.map((row) => ({
          entityId: row.entity_id,
          clubId: row.club_id,
          clubName: row.club_name,
          kind: row.kind,
          author: {
            memberId: row.author_member_id,
            publicName: row.author_public_name,
            handle: row.author_handle,
          },
          title: row.title,
          state: row.state as AdminContentSummary['state'],
          createdAt: row.created_at,
        }));
      });
    },

    async adminArchiveEntity({ actorMemberId, entityId }) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await applyActorContext(client, actorMemberId, []);

        const currentResult = await client.query<{
          entity_id: string;
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
              ev.entity_id,
              ev.id as version_id,
              ev.version_no,
              ev.title,
              ev.summary,
              ev.body,
              ev.expires_at::text,
              ev.content
            from app.current_entity_versions ev
            where ev.entity_id = $1
              and ev.state != 'archived'
            limit 1
          `,
          [entityId],
        );

        const current = currentResult.rows[0];
        if (!current) {
          await client.query('rollback');
          return null;
        }

        const archiveClockResult = await client.query<{ archived_at: string }>(`select now()::text as archived_at`);
        const archivedAt = archiveClockResult.rows[0].archived_at;

        await client.query(
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
            actorMemberId,
          ],
        );

        await client.query('commit');
        return { entityId };
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async adminListThreads({ actorMemberId, clubId, limit, cursor }) {
      return withActorContext(pool, actorMemberId, [], async (client) => {
        const result = await client.query<{
          thread_id: string;
          club_id: string;
          club_name: string;
          participants: Array<{ memberId: string; publicName: string; handle: string | null }>;
          message_count: string;
          latest_message_at: string;
        }>(
          `
            with thread_activity as (
              select
                tt.id,
                tt.club_id,
                (select max(tm.created_at) from app.dm_messages tm where tm.thread_id = tt.id) as latest_message_at,
                (select count(*) from app.dm_messages tm where tm.thread_id = tt.id)::text as message_count
              from app.dm_threads tt
              where ($1::app.short_id is null or tt.club_id = $1)
            )
            select
              ta.id as thread_id,
              ta.club_id,
              n.name as club_name,
              coalesce((
                select jsonb_agg(jsonb_build_object(
                  'memberId', m.id,
                  'publicName', m.public_name,
                  'handle', m.handle
                ))
                from (
                  select distinct on (p.participant_member_id)
                    p.participant_member_id
                  from app.current_dm_thread_participants p
                  where p.thread_id = ta.id
                ) dp
                join app.members m on m.id = dp.participant_member_id
              ), '[]'::jsonb) as participants,
              ta.message_count,
              ta.latest_message_at::text as latest_message_at
            from thread_activity ta
            join app.clubs n on n.id = ta.club_id
            where ($3::timestamptz is null or (ta.latest_message_at, ta.id) < ($3::timestamptz, $4::text))
            order by ta.latest_message_at desc nulls last, ta.id desc
            limit $2
          `,
          [clubId ?? null, limit, cursor?.createdAt ?? null, cursor?.id ?? null],
        );

        return result.rows.map((row) => ({
          threadId: row.thread_id,
          clubId: row.club_id,
          clubName: row.club_name,
          participants: row.participants,
          messageCount: Number(row.message_count),
          latestMessageAt: row.latest_message_at,
        }));
      });
    },

    async adminReadThread({ actorMemberId, threadId, limit }) {
      return withActorContext(pool, actorMemberId, [], async (client) => {
        const threadResult = await client.query<{
          thread_id: string;
          club_id: string;
          club_name: string;
          participants: Array<{ memberId: string; publicName: string; handle: string | null }>;
          message_count: string;
          latest_message_at: string;
        }>(
          `
            select
              tt.id as thread_id,
              tt.club_id,
              n.name as club_name,
              coalesce((
                select jsonb_agg(jsonb_build_object(
                  'memberId', m.id,
                  'publicName', m.public_name,
                  'handle', m.handle
                ))
                from (
                  select distinct on (p.participant_member_id)
                    p.participant_member_id
                  from app.current_dm_thread_participants p
                  where p.thread_id = tt.id
                ) dp
                join app.members m on m.id = dp.participant_member_id
              ), '[]'::jsonb) as participants,
              (select count(*) from app.dm_messages tm where tm.thread_id = tt.id)::text as message_count,
              (select max(tm.created_at)::text from app.dm_messages tm where tm.thread_id = tt.id) as latest_message_at
            from app.dm_threads tt
            join app.clubs n on n.id = tt.club_id
            where tt.id = $1
            limit 1
          `,
          [threadId],
        );

        const thread = threadResult.rows[0];
        if (!thread) {
          return null;
        }

        const messagesResult = await client.query<{
          message_id: string;
          thread_id: string;
          sender_member_id: string | null;
          role: 'member' | 'agent' | 'system';
          message_text: string | null;
          payload: Record<string, unknown> | null;
          created_at: string;
          in_reply_to_message_id: string | null;
        }>(
          `
            select
              tm.id as message_id,
              tm.thread_id,
              tm.sender_member_id,
              tm.role::text as role,
              tm.message_text,
              tm.payload,
              tm.created_at::text as created_at,
              tm.in_reply_to_message_id
            from app.dm_messages tm
            where tm.thread_id = $1
            order by tm.created_at desc, tm.id desc
            limit $2
          `,
          [threadId, limit],
        );

        return {
          thread: {
            threadId: thread.thread_id,
            clubId: thread.club_id,
            clubName: thread.club_name,
            participants: thread.participants,
            messageCount: Number(thread.message_count),
            latestMessageAt: thread.latest_message_at,
          },
          messages: messagesResult.rows.map((row) => ({
            messageId: row.message_id,
            threadId: row.thread_id,
            senderMemberId: row.sender_member_id,
            role: row.role,
            messageText: row.message_text,
            payload: row.payload ?? {},
            createdAt: row.created_at,
            inReplyToMessageId: row.in_reply_to_message_id,
            updateReceipts: [],
          })).reverse(),
        };
      });
    },

    async adminListMemberTokens({ actorMemberId, memberId }) {
      return withActorContext(pool, actorMemberId, [], async (client) => {
        const result = await client.query<{
          token_id: string;
          member_id: string;
          label: string | null;
          created_at: string;
          last_used_at: string | null;
          revoked_at: string | null;
          expires_at: string | null;
          metadata: Record<string, unknown> | null;
        }>(
          `
            select
              mbt.id as token_id,
              mbt.member_id,
              mbt.label,
              mbt.created_at::text as created_at,
              mbt.last_used_at::text as last_used_at,
              mbt.revoked_at::text as revoked_at,
              mbt.expires_at::text as expires_at,
              mbt.metadata
            from app.member_bearer_tokens mbt
            where mbt.member_id = $1
            order by mbt.created_at desc, mbt.id desc
          `,
          [memberId],
        );

        return result.rows.map((row) => ({
          tokenId: row.token_id,
          memberId: row.member_id,
          label: row.label,
          createdAt: row.created_at,
          lastUsedAt: row.last_used_at,
          revokedAt: row.revoked_at,
          expiresAt: row.expires_at,
          metadata: row.metadata ?? {},
        }));
      });
    },

    async adminRevokeMemberToken({ actorMemberId, memberId, tokenId }) {
      return withActorContext(pool, actorMemberId, [], async (client) => {
        const result = await client.query<{
          token_id: string;
          member_id: string;
          label: string | null;
          created_at: string;
          last_used_at: string | null;
          revoked_at: string | null;
          expires_at: string | null;
          metadata: Record<string, unknown> | null;
        }>(
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
              mbt.expires_at::text as expires_at,
              mbt.metadata
          `,
          [tokenId, memberId],
        );

        const row = result.rows[0];
        return row ? {
          tokenId: row.token_id,
          memberId: row.member_id,
          label: row.label,
          createdAt: row.created_at,
          lastUsedAt: row.last_used_at,
          revokedAt: row.revoked_at,
          expiresAt: row.expires_at,
          metadata: row.metadata ?? {},
        } : null;
      });
    },

    async adminGetDiagnostics({ actorMemberId }) {
      return withActorContext(pool, actorMemberId, [], async (client) => {
        const result = await client.query<{
          migration_count: string;
          latest_migration: string | null;
          member_count: string;
          club_count: string;
          tables_with_rls: string;
          total_app_tables: string;
          database_size: string;
        }>(`
          select
            (select count(*) from public.schema_migrations)::text as migration_count,
            (select max(filename) from public.schema_migrations) as latest_migration,
            (select count(*) from app.members where state = 'active')::text as member_count,
            (select count(*) from app.clubs where archived_at is null)::text as club_count,
            (
              select count(distinct tablename)::text
              from pg_policies
              where schemaname = 'app'
            ) as tables_with_rls,
            (
              select count(*)::text
              from information_schema.tables
              where table_schema = 'app'
                and table_type = 'BASE TABLE'
            ) as total_app_tables,
            pg_size_pretty(pg_database_size(current_database())) as database_size
        `);

        const row = result.rows[0];
        return {
          migrationCount: Number(row.migration_count),
          latestMigration: row.latest_migration,
          memberCount: Number(row.member_count),
          clubCount: Number(row.club_count),
          tablesWithRls: Number(row.tables_with_rls),
          totalAppTables: Number(row.total_app_tables),
          databaseSize: row.database_size,
        };
      });
    },
  };
}
