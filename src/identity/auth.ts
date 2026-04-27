/**
 * Identity domain — authentication and actor resolution.
 */

import type { Pool } from 'pg';
import { membershipScopes, type AuthResult, type AuthenticatedActor } from '../actors.ts';
import type { MembershipSummary } from '../repository.ts';
import { hashTokenSecret, parseBearerToken } from '../token.ts';

type ActorRow = {
  member_id: string;
  public_name: string;
  global_roles: string[] | null;
  membership_id: string | null;
  club_id: string | null;
  slug: string | null;
  club_name: string | null;
  club_summary: string | null;
  role: MembershipSummary['role'] | null;
  is_owner: boolean | null;
  status: MembershipSummary['status'] | null;
  sponsor_member_id: string | null;
  sponsor_public_name: string | null;
  joined_at: string | null;
};

function mapActor(rows: ActorRow[]): AuthenticatedActor | null {
  if (rows.length === 0) return null;
  const first = rows[0];
  return {
    kind: 'authenticated',
    member: {
      id: first.member_id,
      publicName: first.public_name,
    },
    globalRoles: (first.global_roles ?? []).filter((role): role is 'superadmin' => role === 'superadmin'),
    memberships: rows
      .filter((row) => row.club_id && row.membership_id && row.slug && row.club_name && row.role && row.status && row.joined_at)
      .map((row) => ({
        membershipId: row.membership_id as string,
        clubId: row.club_id as string,
        slug: row.slug as string,
        name: row.club_name as string,
        summary: row.club_summary ?? null,
        role: row.role as MembershipSummary['role'],
        isOwner: row.is_owner === true,
        status: row.status as MembershipSummary['status'],
        sponsor: row.sponsor_member_id
          ? { memberId: row.sponsor_member_id, publicName: row.sponsor_public_name as string }
          : null,
        joinedAt: row.joined_at as string,
      })),
  };
}

export async function readActor(pool: Pool, memberId: string): Promise<AuthenticatedActor | null> {
  const result = await pool.query<ActorRow>(
    `
      select
        m.id as member_id,
        m.public_name,
        coalesce(to_jsonb(gr.global_roles), '[]'::jsonb) as global_roles,
        anm.id as membership_id,
        anm.club_id,
        n.slug,
        n.name as club_name,
        n.summary as club_summary,
        anm.role,
        (n.owner_member_id = anm.member_id) as is_owner,
        anm.status,
        anm.sponsor_member_id,
        sponsor.public_name as sponsor_public_name,
        anm.joined_at::text as joined_at
      from members m
      left join lateral (
        select array_agg(cmgr.role order by cmgr.role) as global_roles
        from current_member_global_roles cmgr
        where cmgr.member_id = m.id
      ) gr on true
      left join accessible_club_memberships anm
        on anm.member_id = m.id
      left join clubs n
        on n.id = anm.club_id
       and n.archived_at is null
      left join members sponsor
        on sponsor.id = anm.sponsor_member_id
      where m.id = $1
        and m.state = 'active'
      order by n.name asc nulls last
    `,
    [memberId],
  );

  return mapActor(result.rows);
}

/**
 * Read-only token validation for long-lived streams.
 * Same as authenticateBearerToken but does not update last_used_at.
 */
export async function validateBearerTokenPassive(pool: Pool, bearerToken: string): Promise<AuthResult | null> {
  const parsed = parseBearerToken(bearerToken);
  if (!parsed) return null;

  const tokenResult = await pool.query<{ member_id: string }>(
    `
      select member_id from member_bearer_tokens
      where id = $1
        and token_hash = $2
        and revoked_at is null
        and (expires_at is null or expires_at > now())
    `,
    [parsed.tokenId, hashTokenSecret(parsed.secret)],
  );

  const tokenRow = tokenResult.rows[0];
  if (!tokenRow) return null;

  const actor = await readActor(pool, tokenRow.member_id);
  if (!actor) return null;

  const { clubIds: activeClubIds } = membershipScopes(actor.memberships);

  return {
    actor,
    requestScope: { requestedClubId: null, activeClubIds },
    sharedContext: { notifications: [], notificationsTruncated: false },
  };
}

export async function authenticateBearerToken(pool: Pool, bearerToken: string): Promise<AuthResult | null> {
  const parsed = parseBearerToken(bearerToken);
  if (!parsed) return null;

  // Validate the token every time, but only rewrite last_used_at when it is stale.
  // Avoiding a hot-row UPDATE on every request keeps chatty agents from generating
  // unnecessary WAL and dead tuples.
  const tokenResult = await pool.query<{ member_id: string }>(
    `
      with matched as (
        select id, member_id, last_used_at
        from member_bearer_tokens
        where id = $1
          and token_hash = $2
          and revoked_at is null
          and (expires_at is null or expires_at > now())
      ), touched as (
        update member_bearer_tokens token
           set last_used_at = now()
          from matched
         where token.id = matched.id
           and (
             matched.last_used_at is null
             or matched.last_used_at < now() - interval '1 minute'
           )
        returning token.member_id
      )
      select member_id from matched
    `,
    [parsed.tokenId, hashTokenSecret(parsed.secret)],
  );

  const tokenRow = tokenResult.rows[0];
  if (!tokenRow) return null;

  const actor = await readActor(pool, tokenRow.member_id);
  if (!actor) return null;

  const { clubIds: activeClubIds } = membershipScopes(actor.memberships);

  return {
    actor,
    requestScope: { requestedClubId: null, activeClubIds },
    sharedContext: { notifications: [], notificationsTruncated: false },
  };
}
