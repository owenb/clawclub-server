import type { Pool } from 'pg';
import type {
  ArchiveClubInput,
  AssignClubOwnerInput,
  CreateClubInput,
  UpdateClubInput,
  ClubSummary,
  Repository,
} from '../contract.ts';
import type { ApplyActorContext, DbClient, WithActorContext } from './helpers.ts';

type ClubRow = {
  club_id: string;
  slug: string;
  name: string;
  summary: string | null;
  admission_policy: string | null;
  archived_at: string | null;
  owner_member_id: string;
  owner_public_name: string;
  owner_handle: string | null;
  owner_email: string | null;
  version_no: number;
  version_created_at: string;
  version_created_by_member_id: string | null;
};

function mapClubRow(row: ClubRow): ClubSummary {
  return {
    clubId: row.club_id,
    slug: row.slug,
    name: row.name,
    summary: row.summary,
    admissionPolicy: row.admission_policy,
    archivedAt: row.archived_at,
    owner: {
      memberId: row.owner_member_id,
      publicName: row.owner_public_name,
      handle: row.owner_handle,
      email: row.owner_email,
    },
    version: {
      versionNo: Number(row.version_no),
      createdAt: row.version_created_at,
      createdByMemberId: row.version_created_by_member_id,
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
        n.admission_policy,
        n.archived_at::text,
        cv.owner_member_id as owner_member_id,
        m.public_name as owner_public_name,
        m.handle as owner_handle,
        mpc.email as owner_email,
        cv.version_no,
        cv.created_at::text as version_created_at,
        cv.created_by_member_id as version_created_by_member_id
      from app.clubs n
      join app.current_club_versions cv on cv.club_id = n.id
      join app.members m on m.id = cv.owner_member_id
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
        n.admission_policy,
        n.archived_at::text,
        cv.owner_member_id as owner_member_id,
        m.public_name as owner_public_name,
        m.handle as owner_handle,
        mpc.email as owner_email,
        cv.version_no,
        cv.created_at::text as version_created_at,
        cv.created_by_member_id as version_created_by_member_id
      from app.clubs n
      join app.current_club_versions cv on cv.club_id = n.id
      join app.members m on m.id = cv.owner_member_id
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
}): Pick<Repository, 'listClubs' | 'createClub' | 'archiveClub' | 'assignClubOwner' | 'updateClub'> {
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
            ), club_version as (
              insert into app.club_versions (
                club_id,
                owner_member_id,
                name,
                summary,
                admission_policy,
                version_no,
                created_by_member_id
              )
              select club_id, $4, $2, $3, null, 1, $5
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
          current_version_id: string;
          current_version_no: number;
          current_owner_member_id: string;
          name: string;
          summary: string | null;
          admission_policy: string | null;
        }>(
          `
            select
              n.id as club_id,
              cv.id as current_version_id,
              cv.version_no as current_version_no,
              cv.owner_member_id as current_owner_member_id,
              cv.name,
              cv.summary,
              cv.admission_policy
            from app.clubs n
            join app.current_club_versions cv on cv.club_id = n.id
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

        // 1. Write new club version with updated owner (triggers clubs sync)
        await client.query(
          `
            insert into app.club_versions (
              club_id,
              owner_member_id,
              name,
              summary,
              admission_policy,
              version_no,
              supersedes_version_id,
              created_by_member_id
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8)
          `,
          [
            input.clubId,
            input.ownerMemberId,
            current.name,
            current.summary,
            current.admission_policy,
            Number(current.current_version_no) + 1,
            current.current_version_id,
            input.actorMemberId,
          ],
        );

        // 2. Ensure new owner has a membership with role='clubadmin'
        //    The network_memberships_check constraint requires:
        //    - owners: sponsor_member_id IS NULL
        //    - non-owners: sponsor_member_id IS NOT NULL
        //    Bypass the trigger guard (sponsor_member_id is normally immutable)
        await client.query(`select set_config('app.allow_club_membership_state_sync', '1', true)`);
        await client.query(
          `
            insert into app.club_memberships (club_id, member_id, role, sponsor_member_id)
            values ($1::app.short_id, $2::app.short_id, 'clubadmin', null)
            on conflict (club_id, member_id) do update
              set role = 'clubadmin', sponsor_member_id = null
          `,
          [input.clubId, input.ownerMemberId],
        );

        // 3. Ensure active membership state for the new owner
        //    Note: the sync trigger on club_membership_state_versions resets
        //    allow_club_membership_state_sync to '', so we re-enable before step 4.
        const newMsRows = await client.query<{ id: string }>(
          `select id from app.club_memberships where club_id = $1 and member_id = $2`,
          [input.clubId, input.ownerMemberId],
        );
        await client.query(
          `
            insert into app.club_membership_state_versions (
              membership_id, status, reason, version_no, created_by_member_id
            )
            select $1::app.short_id, 'active', 'owner_assignment',
                   coalesce(max(version_no), 0) + 1, $2::app.short_id
            from app.club_membership_state_versions where membership_id = $1::app.short_id
          `,
          [newMsRows.rows[0]!.id, input.actorMemberId],
        );

        // 4. Demote old owner to 'member' role (skip if reassigning to same person)
        //    Re-enable bypass since step 3's trigger reset it
        if (current.current_owner_member_id !== input.ownerMemberId) {
          await client.query(`select set_config('app.allow_club_membership_state_sync', '1', true)`);
          await client.query(
            `
              update app.club_memberships
              set role = 'member', sponsor_member_id = $3
              where club_id = $1 and member_id = $2 and role = 'clubadmin'
            `,
            [input.clubId, current.current_owner_member_id, input.ownerMemberId],
          );
          await client.query(`select set_config('app.allow_club_membership_state_sync', '', true)`);

          // 5. Create comped subscription for the demoted owner so they retain
          //    club access (accessible_club_memberships requires a live subscription
          //    for non-owner members).
          const oldMsRows = await client.query<{ id: string }>(
            `select id from app.club_memberships where club_id = $1 and member_id = $2`,
            [input.clubId, current.current_owner_member_id],
          );
          if (oldMsRows.rows[0]) {
            await client.query(
              `
                insert into app.subscriptions (membership_id, payer_member_id, status, amount)
                values ($1, $2, 'active', 0)
                on conflict do nothing
              `,
              [oldMsRows.rows[0].id, input.ownerMemberId],
            );
          }
        } else {
          await client.query(`select set_config('app.allow_club_membership_state_sync', '', true)`);
        }

        await client.query('commit');
        return withActorContext(pool, input.actorMemberId, [], (scopedClient) => readClubSummary(scopedClient, input.clubId));
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async updateClub(input: UpdateClubInput): Promise<ClubSummary | null> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await applyActorContext(client, input.actorMemberId, []);

        const currentResult = await client.query<{
          club_id: string;
          current_version_id: string;
          current_version_no: number;
          owner_member_id: string;
          name: string;
          summary: string | null;
          admission_policy: string | null;
        }>(
          `
            select
              n.id as club_id,
              cv.id as current_version_id,
              cv.version_no as current_version_no,
              cv.owner_member_id,
              cv.name,
              cv.summary,
              cv.admission_policy
            from app.clubs n
            join app.current_club_versions cv on cv.club_id = n.id
            where n.id = $1
            limit 1
          `,
          [input.clubId],
        );

        const current = currentResult.rows[0];
        if (!current) {
          await client.query('rollback');
          return null;
        }

        const { patch } = input;
        const merged = {
          name: patch.name !== undefined ? patch.name : current.name,
          summary: patch.summary !== undefined ? patch.summary : current.summary,
          admissionPolicy: patch.admissionPolicy !== undefined ? patch.admissionPolicy : current.admission_policy,
        };

        await client.query(
          `
            insert into app.club_versions (
              club_id,
              owner_member_id,
              name,
              summary,
              admission_policy,
              version_no,
              supersedes_version_id,
              created_by_member_id
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8)
          `,
          [
            input.clubId,
            current.owner_member_id,
            merged.name,
            merged.summary,
            merged.admissionPolicy,
            Number(current.current_version_no) + 1,
            current.current_version_id,
            input.actorMemberId,
          ],
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
