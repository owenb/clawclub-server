import type { Pool } from 'pg';
import type {
  ArchiveClubInput,
  AssignClubOwnerInput,
  CreateClubInput,
  ClubSummary,
  Repository,
} from '../app.ts';
import type { ApplyActorContext, DbClient, WithActorContext } from './shared.ts';

type ClubRow = {
  club_id: string;
  slug: string;
  name: string;
  summary: string | null;
  archived_at: string | null;
  owner_member_id: string;
  owner_public_name: string;
  owner_handle: string | null;
  owner_email: string | null;
  owner_version_no: number;
  owner_created_at: string;
  owner_created_by_member_id: string | null;
};

function mapClubRow(row: ClubRow): ClubSummary {
  return {
    clubId: row.club_id,
    slug: row.slug,
    name: row.name,
    summary: row.summary,
    archivedAt: row.archived_at,
    owner: {
      memberId: row.owner_member_id,
      publicName: row.owner_public_name,
      handle: row.owner_handle,
      email: row.owner_email,
    },
    ownerVersion: {
      versionNo: Number(row.owner_version_no),
      createdAt: row.owner_created_at,
      createdByMemberId: row.owner_created_by_member_id,
    },
  };
}

async function listClubs(client: DbClient, includeArchived: boolean): Promise<ClubSummary[]> {
  const result = await client.query<ClubRow>(
    `
      select
        n.id as club_id,
        n.slug,
        n.name,
        n.summary,
        n.archived_at::text,
        owner.owner_member_id as owner_member_id,
        m.public_name as owner_public_name,
        m.handle as owner_handle,
        mpc.email as owner_email,
        owner.version_no as owner_version_no,
        owner.created_at::text as owner_created_at,
        owner.created_by_member_id as owner_created_by_member_id
      from app.clubs n
      join app.current_club_owners owner on owner.club_id = n.id
      join app.members m on m.id = owner.owner_member_id
      left join app.member_private_contacts mpc on mpc.member_id = m.id
      where ($1::boolean = true or n.archived_at is null)
      order by n.archived_at asc nulls first, n.name asc, n.id asc
    `,
    [includeArchived],
  );

  return result.rows.map(mapClubRow);
}

async function readClubSummary(client: DbClient, clubId: string): Promise<ClubSummary | null> {
  const result = await client.query<ClubRow>(
    `
      select
        n.id as club_id,
        n.slug,
        n.name,
        n.summary,
        n.archived_at::text,
        owner.owner_member_id as owner_member_id,
        m.public_name as owner_public_name,
        m.handle as owner_handle,
        mpc.email as owner_email,
        owner.version_no as owner_version_no,
        owner.created_at::text as owner_created_at,
        owner.created_by_member_id as owner_created_by_member_id
      from app.clubs n
      join app.current_club_owners owner on owner.club_id = n.id
      join app.members m on m.id = owner.owner_member_id
      left join app.member_private_contacts mpc on mpc.member_id = m.id
      where n.id = $1
      limit 1
    `,
    [clubId],
  );

  return result.rows[0] ? mapClubRow(result.rows[0]) : null;
}

export function buildPlatformRepository({
  pool,
  applyActorContext,
  withActorContext,
}: {
  pool: Pool;
  applyActorContext: ApplyActorContext;
  withActorContext: WithActorContext;
}): Pick<Repository, 'listClubs' | 'createClub' | 'archiveClub' | 'assignClubOwner'> {
  return {
    async listClubs({ actorMemberId, includeArchived }) {
      return withActorContext(pool, actorMemberId, [], (client) => listClubs(client, includeArchived));
    },

    async createClub(input: CreateClubInput): Promise<ClubSummary | null> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await applyActorContext(client, input.actorMemberId, []);

        const clubResult = await client.query<{ club_id: string }>(
          `
            with owner_member as (
              select m.id
              from app.members m
              where m.id = $4
                and m.state = 'active'
            ), inserted_club as (
              insert into app.clubs (
                slug,
                name,
                summary,
                owner_member_id
              )
              select $1, $2, $3, om.id
              from owner_member om
              returning id as club_id
            ), owner_version as (
              insert into app.club_owner_versions (
                club_id,
                owner_member_id,
                version_no,
                created_by_member_id
              )
              select club_id, $4, 1, $5
              from inserted_club
            )
            select club_id
            from inserted_club
          `,
          [input.slug, input.name, input.summary, input.ownerMemberId, input.actorMemberId],
        );

        const clubId = clubResult.rows[0]?.club_id;
        if (!clubId) {
          await client.query('rollback');
          return null;
        }

        await client.query('commit');
        return withActorContext(pool, input.actorMemberId, [], (scopedClient) => readClubSummary(scopedClient, clubId));
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async archiveClub(input: ArchiveClubInput): Promise<ClubSummary | null> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await applyActorContext(client, input.actorMemberId, []);
        const result = await client.query<{ club_id: string }>(
          `
            update app.clubs n
            set archived_at = coalesce(n.archived_at, now())
            where n.id = $1
            returning n.id as club_id
          `,
          [input.clubId],
        );

        const clubId = result.rows[0]?.club_id;
        if (!clubId) {
          await client.query('rollback');
          return null;
        }

        await client.query('commit');
        return withActorContext(pool, input.actorMemberId, [], (scopedClient) => readClubSummary(scopedClient, clubId));
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async assignClubOwner(input: AssignClubOwnerInput): Promise<ClubSummary | null> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await applyActorContext(client, input.actorMemberId, []);

        const currentResult = await client.query<{
          club_id: string;
          current_owner_version_id: string;
          current_version_no: number;
        }>(
          `
            select
              n.id as club_id,
              cno.id as current_owner_version_id,
              cno.version_no as current_version_no
            from app.clubs n
            join app.current_club_owners cno on cno.club_id = n.id
            join app.members m on m.id = $2 and m.state = 'active'
            where n.id = $1
            limit 1
          `,
          [input.clubId, input.ownerMemberId],
        );

        const current = currentResult.rows[0];
        if (!current) {
          await client.query('rollback');
          return null;
        }

        await client.query(
          `
            insert into app.club_owner_versions (
              club_id,
              owner_member_id,
              version_no,
              supersedes_owner_version_id,
              created_by_member_id
            )
            values ($1, $2, $3, $4, $5)
          `,
          [input.clubId, input.ownerMemberId, Number(current.current_version_no) + 1, current.current_owner_version_id, input.actorMemberId],
        );

        await client.query('commit');
        return withActorContext(pool, input.actorMemberId, [], (scopedClient) => readClubSummary(scopedClient, input.clubId));
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
