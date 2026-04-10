/**
 * Identity domain — club management.
 */

import type { Pool } from 'pg';
import type { ArchiveClubInput, AssignClubOwnerInput, ClubSummary, CreateClubInput, UpdateClubInput } from '../contract.ts';
import { withTransaction, type DbClient } from '../db.ts';
import {
  buildMembershipSeedProfile,
  createInitialClubProfileVersion,
  emptyClubProfileFields,
} from './profiles.ts';

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

function mapRow(row: ClubRow): ClubSummary {
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

const SELECT_CLUB = `
  select
    n.id as club_id, n.slug, n.name, n.summary, n.admission_policy,
    n.archived_at::text as archived_at,
    cv.owner_member_id, m.public_name as owner_public_name,
    m.handle as owner_handle, mpc.email as owner_email,
    cv.version_no, cv.created_at::text as version_created_at,
    cv.created_by_member_id as version_created_by_member_id
  from clubs n
  join current_club_versions cv on cv.club_id = n.id
  join members m on m.id = cv.owner_member_id
  left join member_private_contacts mpc on mpc.member_id = m.id
`;

async function readClub(client: DbClient, clubId: string): Promise<ClubSummary | null> {
  const result = await client.query<ClubRow>(`${SELECT_CLUB} where n.id = $1 limit 1`, [clubId]);
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function listClubs(pool: Pool, includeArchived: boolean): Promise<ClubSummary[]> {
  const result = await pool.query<ClubRow>(
    `${SELECT_CLUB}
     where ($1::boolean = true or n.archived_at is null)
     order by n.archived_at asc nulls first, n.name asc, n.id asc`,
    [includeArchived],
  );
  return result.rows.map(mapRow);
}

export async function createClub(pool: Pool, input: CreateClubInput): Promise<ClubSummary | null> {
  return withTransaction(pool, async (client) => {
    const clubResult = await client.query<{ club_id: string }>(
      `with owner_member as (
         select m.id from members m where m.id = $4 and m.state = 'active'
       ), inserted_club as (
         insert into clubs (slug, name, summary, owner_member_id)
         select $1, $2, $3, om.id from owner_member om
         returning id as club_id
       ), club_version as (
         insert into club_versions (club_id, owner_member_id, name, summary, admission_policy, version_no, created_by_member_id)
         select club_id, $4, $2, $3, null, 1, $5 from inserted_club
       )
       select club_id from inserted_club`,
      [input.slug, input.name, input.summary, input.ownerMemberId, input.actorMemberId],
    );

    const clubId = clubResult.rows[0]?.club_id;
    if (!clubId) return null;

    // Create owner's clubadmin membership + active state + comp
    await client.query(`select set_config('app.allow_membership_state_sync', '1', true)`);
    const ownerMsResult = await client.query<{ id: string }>(
      `insert into club_memberships (club_id, member_id, role, sponsor_member_id)
       values ($1::short_id, $2::short_id, 'clubadmin', null)
       returning id`,
      [clubId, input.ownerMemberId],
    );
    const ownerMsId = ownerMsResult.rows[0]!.id;
    await client.query(
      `insert into club_membership_state_versions (membership_id, status, reason, version_no, created_by_member_id)
       values ($1::short_id, 'active', 'club_created', 1, $2::short_id)`,
      [ownerMsId, input.actorMemberId],
    );
    await client.query(
      `update club_memberships set is_comped = true, comped_at = now(), comped_by_member_id = $2
       where id = $1 and is_comped = false`,
      [ownerMsId, input.actorMemberId],
    );
    await client.query(`select set_config('app.allow_membership_state_sync', '', true)`);

    await createInitialClubProfileVersion(client, {
      membershipId: ownerMsId,
      memberId: input.ownerMemberId,
      clubId,
      fields: emptyClubProfileFields(),
      createdByMemberId: input.actorMemberId,
      generationSource: 'membership_seed',
    });

    return readClub(client, clubId);
  });
}

export async function archiveClub(pool: Pool, input: ArchiveClubInput): Promise<ClubSummary | null> {
  return withTransaction(pool, async (client) => {
    const result = await client.query<{ club_id: string }>(
      `update clubs set archived_at = coalesce(archived_at, now()) where id = $1 returning id as club_id`,
      [input.clubId],
    );
    if (!result.rows[0]) return null;
    return readClub(client, input.clubId);
  });
}

export async function assignClubOwner(pool: Pool, input: AssignClubOwnerInput): Promise<ClubSummary | null> {
  return withTransaction(pool, async (client) => {
    const currentResult = await client.query<{
      club_id: string; current_version_id: string; current_version_no: number;
      current_owner_member_id: string; name: string; summary: string | null;
      admission_policy: string | null;
    }>(
      `select n.id as club_id, cv.id as current_version_id, cv.version_no as current_version_no,
              cv.owner_member_id as current_owner_member_id, cv.name, cv.summary, cv.admission_policy
       from clubs n
       join current_club_versions cv on cv.club_id = n.id
       join members m on m.id = $2 and m.state = 'active'
       where n.id = $1 limit 1`,
      [input.clubId, input.ownerMemberId],
    );

    const current = currentResult.rows[0];
    if (!current) return null;

    // 1. New club version with updated owner
    await client.query(
      `insert into club_versions (club_id, owner_member_id, name, summary, admission_policy, version_no, supersedes_version_id, created_by_member_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [input.clubId, input.ownerMemberId, current.name, current.summary, current.admission_policy,
       Number(current.current_version_no) + 1, current.current_version_id, input.actorMemberId],
    );

    // 2. Ensure new owner has clubadmin membership
    const existingMs = await client.query<{ id: string }>(
      `select id from club_memberships where club_id = $1 and member_id = $2 limit 1`,
      [input.clubId, input.ownerMemberId],
    );
    const existingMembershipId = existingMs.rows[0]?.id ?? null;

    await client.query(`select set_config('app.allow_membership_state_sync', '1', true)`);
    let newMembershipId = existingMembershipId;
    if (!newMembershipId) {
      const insertResult = await client.query<{ id: string }>(
        `insert into club_memberships (club_id, member_id, role, sponsor_member_id)
         values ($1::short_id, $2::short_id, 'clubadmin', null)
         returning id`,
        [input.clubId, input.ownerMemberId],
      );
      newMembershipId = insertResult.rows[0]!.id;
    } else {
      await client.query(
        `update club_memberships set role = 'clubadmin', sponsor_member_id = null
         where id = $1`,
        [newMembershipId],
      );
    }

    // 3. Ensure active membership state for new owner
    await client.query(
      `insert into club_membership_state_versions (membership_id, status, reason, version_no, created_by_member_id)
       select $1::short_id, 'active', 'owner_assignment',
              coalesce(max(version_no), 0) + 1, $2::short_id
       from club_membership_state_versions where membership_id = $1::short_id`,
      [newMembershipId, input.actorMemberId],
    );
    if (!existingMembershipId) {
      const seedFields = await buildMembershipSeedProfile(client, {
        memberId: input.ownerMemberId,
        clubId: input.clubId,
      });
      await createInitialClubProfileVersion(client, {
        membershipId: newMembershipId,
        memberId: input.ownerMemberId,
        clubId: input.clubId,
        fields: seedFields,
        createdByMemberId: input.actorMemberId,
        generationSource: 'membership_seed',
      });
    }

    // 4. Demote old owner to 'member' role
    if (current.current_owner_member_id !== input.ownerMemberId) {
      await client.query(`select set_config('app.allow_membership_state_sync', '1', true)`);
      await client.query(
        `update club_memberships set role = 'member', sponsor_member_id = $3
         where club_id = $1 and member_id = $2 and role = 'clubadmin'`,
        [input.clubId, current.current_owner_member_id, input.ownerMemberId],
      );
      await client.query(`select set_config('app.allow_membership_state_sync', '', true)`);

      // 5. Comp demoted owner to retain access
      const oldMsRows = await client.query<{ id: string }>(
        `select id from club_memberships where club_id = $1 and member_id = $2`,
        [input.clubId, current.current_owner_member_id],
      );
      if (oldMsRows.rows[0]) {
        await client.query(
          `update club_memberships set is_comped = true, comped_at = now(), comped_by_member_id = $2
           where id = $1 and is_comped = false`,
          [oldMsRows.rows[0].id, input.ownerMemberId],
        );
      }
    } else {
      await client.query(`select set_config('app.allow_membership_state_sync', '', true)`);
    }

    return readClub(client, input.clubId);
  });
}

export async function updateClub(pool: Pool, input: UpdateClubInput): Promise<ClubSummary | null> {
  return withTransaction(pool, async (client) => {
    const currentResult = await client.query<{
      club_id: string; current_version_id: string; current_version_no: number;
      owner_member_id: string; name: string; summary: string | null; admission_policy: string | null;
    }>(
      `select n.id as club_id, cv.id as current_version_id, cv.version_no as current_version_no,
              cv.owner_member_id, cv.name, cv.summary, cv.admission_policy
       from clubs n
       join current_club_versions cv on cv.club_id = n.id
       where n.id = $1 limit 1`,
      [input.clubId],
    );

    const current = currentResult.rows[0];
    if (!current) return null;

    const { patch } = input;
    const merged = {
      name: patch.name !== undefined ? patch.name : current.name,
      summary: patch.summary !== undefined ? patch.summary : current.summary,
      admissionPolicy: patch.admissionPolicy !== undefined ? patch.admissionPolicy : current.admission_policy,
    };

    await client.query(
      `insert into club_versions (club_id, owner_member_id, name, summary, admission_policy, version_no, supersedes_version_id, created_by_member_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [input.clubId, current.owner_member_id, merged.name, merged.summary, merged.admissionPolicy,
       Number(current.current_version_no) + 1, current.current_version_id, input.actorMemberId],
    );

    return readClub(client, input.clubId);
  });
}
