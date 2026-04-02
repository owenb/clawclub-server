import { Pool, type PoolClient } from 'pg';
import { type ActorContext, type AuthResult, type MembershipSummary, type Repository } from './app.ts';
import { hashTokenSecret, parseBearerToken } from './token.ts';
import { buildAdminRepository } from './postgres/admin.ts';
import { buildAdmissionsRepository } from './postgres/admissions.ts';
import { buildContentRepository } from './postgres/content.ts';
import { buildMessagesRepository } from './postgres/messages.ts';
import { buildProfileRepository } from './postgres/profile.ts';
import { buildPlatformRepository } from './postgres/platform.ts';
import { buildTokenRepository } from './postgres/tokens.ts';
import { buildQuotaRepository } from './postgres/quotas.ts';
import { buildSponsorshipRepository } from './postgres/sponsorships.ts';
import { buildUpdatesRepository } from './postgres/updates.ts';
import type { DbClient } from './postgres/shared.ts';

type ActorRow = {
  member_id: string;
  handle: string | null;
  public_name: string;
  global_roles: Array<'superadmin'> | string | null;
  membership_id: string | null;
  network_id: string | null;
  slug: string | null;
  network_name: string | null;
  network_summary: string | null;
  manifesto_markdown: string | null;
  role: MembershipSummary['role'] | null;
  status: MembershipSummary['status'] | null;
  sponsor_member_id: string | null;
  joined_at: string | null;
};

function parsePostgresTextArray(value: string[] | string | null | undefined): string[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value !== 'string') {
    return [];
  }

  const trimmed = value.trim();
  if (trimmed === '' || trimmed === '{}') {
    return [];
  }

  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return [trimmed];
  }

  return trimmed
    .slice(1, -1)
    .split(',')
    .filter((entry) => entry.length > 0)
    .map((entry) => entry.replace(/^"(.*)"$/, '$1').replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
}

// RLS now derives network access from membership state in the database.
async function applyActorContext(
  client: DbClient,
  actorMemberId: string,
  _networkIds: string[],
  _options: Record<string, never> = {},
): Promise<void> {
  await client.query(
    `
      select set_config('app.actor_member_id', $1, true)
    `,
    [actorMemberId],
  );
}

async function withActorContext<T>(pool: Pool, actorMemberId: string, networkIds: string[], fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query('begin');
    await applyActorContext(client, actorMemberId, networkIds);
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

function mapActor(rows: ActorRow[]): ActorContext | null {
  if (rows.length === 0) {
    return null;
  }

  const first = rows[0];

  return {
    member: {
      id: first.member_id,
      handle: first.handle,
      publicName: first.public_name,
    },
    globalRoles: parsePostgresTextArray(first.global_roles) as Array<'superadmin'>,
    memberships: rows
      .filter((row) => row.network_id && row.membership_id && row.slug && row.network_name && row.role && row.status && row.joined_at)
      .map((row) => ({
        membershipId: row.membership_id as string,
        networkId: row.network_id as string,
        slug: row.slug as string,
        name: row.network_name as string,
        summary: row.network_summary,
        manifestoMarkdown: row.manifesto_markdown,
        role: row.role as MembershipSummary['role'],
        status: row.status as MembershipSummary['status'],
        sponsorMemberId: row.sponsor_member_id,
        joinedAt: row.joined_at as string,
      })),
  };
}

async function readActorByMemberId(client: DbClient, memberId: string): Promise<ActorContext | null> {
  const result = await client.query<ActorRow>(
    `
      select
        m.id as member_id,
        m.handle,
        m.public_name,
        coalesce(gr.global_roles, array[]::app.global_role[]) as global_roles,
        anm.id as membership_id,
        anm.network_id,
        n.slug,
        n.name as network_name,
        n.summary as network_summary,
        n.manifesto_markdown,
        anm.role,
        anm.status,
        anm.sponsor_member_id,
        anm.joined_at::text as joined_at
      from app.members m
      left join lateral (
        select array_agg(cmgr.role order by cmgr.role) as global_roles
        from app.current_member_global_roles cmgr
        where cmgr.member_id = m.id
      ) gr on true
      left join app.accessible_network_memberships anm
        on anm.member_id = m.id
      left join app.networks n
        on n.id = anm.network_id
       and n.archived_at is null
      where m.id = $1
        and m.state = 'active'
      order by n.name asc nulls last
    `,
    [memberId],
  );

  return mapActor(result.rows);
}

async function getActorByMemberId(pool: Pool, memberId: string): Promise<ActorContext | null> {
  return withActorContext(pool, memberId, [], (client) => readActorByMemberId(client, memberId));
}

export function createPostgresRepository({ pool }: { pool: Pool }): Repository {
  return {
    async authenticateBearerToken(bearerToken: string): Promise<AuthResult | null> {
      const parsed = parseBearerToken(bearerToken);
      if (!parsed) {
        return null;
      }

      const tokenResult = await pool.query<{ member_id: string }>(
        `
          select member_id
          from app.authenticate_member_bearer_token($1, $2)
        `,
        [parsed.tokenId, hashTokenSecret(parsed.secret)],
      );

      const tokenRow = tokenResult.rows[0];
      if (!tokenRow) {
        return null;
      }

      const actor = await getActorByMemberId(pool, tokenRow.member_id);
      if (!actor) {
        return null;
      }

      const activeNetworkIds = actor.memberships.map((membership) => membership.networkId);

      return {
        actor,
        requestScope: {
          requestedNetworkId: null,
          activeNetworkIds,
        },
        sharedContext: {
          pendingUpdates: [],
        },
      };
    },

    ...buildAdmissionsRepository({ pool, applyActorContext, withActorContext }),
    ...buildProfileRepository({ pool, applyActorContext, withActorContext }),
    ...buildContentRepository({ pool, applyActorContext, withActorContext }),
    ...buildTokenRepository({ pool, withActorContext }),
    ...buildMessagesRepository({ pool, applyActorContext, withActorContext }),
    ...buildPlatformRepository({ pool, applyActorContext, withActorContext }),
    ...buildSponsorshipRepository({ pool, withActorContext }),
    ...buildQuotaRepository({ pool, withActorContext }),
    ...buildUpdatesRepository({ pool, applyActorContext }),
    ...buildAdminRepository({ pool, applyActorContext, withActorContext }),

  };
}
