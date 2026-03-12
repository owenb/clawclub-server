import { Pool } from 'pg';
import { AppError, type ActorContext, type AuthResult, type CreateEntityInput, type EntitySummary, type MemberProfile, type MemberSearchResult, type MembershipSummary, type Repository, type UpdateOwnProfileInput } from './app.ts';
import { hashTokenSecret, parseBearerToken } from './token.ts';

type ActorRow = {
  member_id: string;
  handle: string | null;
  public_name: string;
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

type SearchRow = {
  member_id: string;
  public_name: string;
  display_name: string;
  handle: string | null;
  tagline: string | null;
  summary: string | null;
  what_i_do: string | null;
  known_for: string | null;
  services_summary: string | null;
  website_url: string | null;
  shared_networks: Array<{ id: string; slug: string; name: string }> | null;
};

type ProfileRow = {
  member_id: string;
  public_name: string;
  handle: string | null;
  display_name: string;
  tagline: string | null;
  summary: string | null;
  what_i_do: string | null;
  known_for: string | null;
  services_summary: string | null;
  website_url: string | null;
  links: unknown[] | null;
  profile: Record<string, unknown> | null;
  version_id: string | null;
  version_no: number | null;
  version_created_at: string | null;
  version_created_by_member_id: string | null;
  shared_networks: Array<{ id: string; slug: string; name: string }> | null;
};

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
  entity_created_at: string;
};

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

function mapProfileRow(row: ProfileRow): MemberProfile {
  return {
    memberId: row.member_id,
    publicName: row.public_name,
    handle: row.handle,
    displayName: row.display_name,
    tagline: row.tagline,
    summary: row.summary,
    whatIDo: row.what_i_do,
    knownFor: row.known_for,
    servicesSummary: row.services_summary,
    websiteUrl: row.website_url,
    links: row.links ?? [],
    profile: row.profile ?? {},
    version: {
      id: row.version_id,
      versionNo: row.version_no,
      createdAt: row.version_created_at,
      createdByMemberId: row.version_created_by_member_id,
    },
    sharedNetworks: row.shared_networks ?? [],
  };
}

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
    },
    createdAt: row.entity_created_at,
  };
}

async function getActorByMemberId(pool: Pool, memberId: string): Promise<ActorContext | null> {
  const result = await pool.query<ActorRow>(
    `
      select
        m.id as member_id,
        m.handle,
        m.public_name,
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

async function readMemberProfile(pool: Pool, actorMemberId: string, targetMemberId: string): Promise<MemberProfile | null> {
  const result = await pool.query<ProfileRow>(
    `
      with actor_scope as (
        select distinct network_id
        from app.accessible_network_memberships
        where member_id = $1
      ),
      target_scope as (
        select distinct anm.network_id
        from app.accessible_network_memberships anm
        join actor_scope ac on ac.network_id = anm.network_id
        where anm.member_id = $2
      )
      select
        m.id as member_id,
        m.public_name,
        m.handle,
        coalesce(cmp.display_name, m.public_name) as display_name,
        cmp.tagline,
        cmp.summary,
        cmp.what_i_do,
        cmp.known_for,
        cmp.services_summary,
        cmp.website_url,
        cmp.links,
        cmp.profile,
        cmp.id as version_id,
        cmp.version_no,
        cmp.created_at::text as version_created_at,
        cmp.created_by_member_id as version_created_by_member_id,
        jsonb_agg(distinct jsonb_build_object('id', n.id, 'slug', n.slug, 'name', n.name))
          filter (where n.id is not null) as shared_networks
      from app.members m
      left join app.current_member_profiles cmp on cmp.member_id = m.id
      join target_scope ts on true
      join app.networks n on n.id = ts.network_id and n.archived_at is null
      where m.id = $2
        and m.state = 'active'
      group by
        m.id, m.public_name, m.handle,
        cmp.display_name, cmp.tagline, cmp.summary, cmp.what_i_do, cmp.known_for,
        cmp.services_summary, cmp.website_url, cmp.links, cmp.profile,
        cmp.id, cmp.version_no, cmp.created_at, cmp.created_by_member_id
    `,
    [actorMemberId, targetMemberId],
  );

  return result.rows[0] ? mapProfileRow(result.rows[0]) : null;
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
          update app.member_bearer_tokens mbt
          set last_used_at = now()
          where mbt.id = $1
            and mbt.token_hash = $2
            and mbt.revoked_at is null
          returning mbt.member_id
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

      return {
        actor,
        requestScope: {
          requestedNetworkId: null,
          activeNetworkIds: actor.memberships.map((membership) => membership.networkId),
        },
      };
    },

    async searchMembers({ networkIds, query, limit }): Promise<MemberSearchResult[]> {
      const trimmedQuery = query.trim();
      const likePattern = `%${trimmedQuery}%`;
      const prefixPattern = `${trimmedQuery}%`;

      const result = await pool.query<SearchRow>(
        `
          with scope as (
            select unnest($1::text[])::app.short_id as network_id
          )
          select
            m.id as member_id,
            m.public_name,
            coalesce(cmp.display_name, m.public_name) as display_name,
            m.handle,
            cmp.tagline,
            cmp.summary,
            cmp.what_i_do,
            cmp.known_for,
            cmp.services_summary,
            cmp.website_url,
            jsonb_agg(distinct jsonb_build_object('id', n.id, 'slug', n.slug, 'name', n.name))
              filter (where n.id is not null) as shared_networks
          from scope s
          join app.accessible_network_memberships anm on anm.network_id = s.network_id
          join app.members m on m.id = anm.member_id and m.state = 'active'
          left join app.current_member_profiles cmp on cmp.member_id = m.id
          join app.networks n on n.id = anm.network_id and n.archived_at is null
          where (
            m.public_name ilike $2
            or coalesce(cmp.display_name, '') ilike $2
            or coalesce(m.handle, '') ilike $2
            or coalesce(cmp.what_i_do, '') ilike $2
            or coalesce(cmp.known_for, '') ilike $2
            or coalesce(cmp.services_summary, '') ilike $2
          )
          group by
            m.id, m.public_name, cmp.display_name, m.handle, cmp.tagline, cmp.summary,
            cmp.what_i_do, cmp.known_for, cmp.services_summary, cmp.website_url
          order by
            min(
              case
                when lower(coalesce(cmp.display_name, m.public_name)) = lower($3)
                  or lower(m.public_name) = lower($3)
                  or lower(coalesce(m.handle, '')) = lower($3) then 0
                when lower(coalesce(cmp.display_name, m.public_name)) like lower($4)
                  or lower(m.public_name) like lower($4)
                  or lower(coalesce(m.handle, '')) like lower($4) then 1
                else 2
              end
            ) asc,
            display_name asc,
            m.id asc
          limit $5
        `,
        [networkIds, likePattern, trimmedQuery, prefixPattern, limit],
      );

      return result.rows.map((row) => ({
        memberId: row.member_id,
        publicName: row.public_name,
        displayName: row.display_name,
        handle: row.handle,
        tagline: row.tagline,
        summary: row.summary,
        whatIDo: row.what_i_do,
        knownFor: row.known_for,
        servicesSummary: row.services_summary,
        websiteUrl: row.website_url,
        sharedNetworks: row.shared_networks ?? [],
      }));
    },

    async getMemberProfile({ actorMemberId, targetMemberId }) {
      return readMemberProfile(pool, actorMemberId, targetMemberId);
    },

    async updateOwnProfile({ actor, patch }: { actor: ActorContext; patch: UpdateOwnProfileInput }): Promise<MemberProfile> {
      const client = await pool.connect();

      try {
        await client.query('begin');

        if (patch.handle !== undefined) {
          await client.query(`update app.members set handle = $2 where id = $1`, [actor.member.id, patch.handle]);
        }

        const currentResult = await client.query<{
          public_name: string;
          display_name: string | null;
          tagline: string | null;
          summary: string | null;
          what_i_do: string | null;
          known_for: string | null;
          services_summary: string | null;
          website_url: string | null;
          links: unknown[] | null;
          profile: Record<string, unknown> | null;
          version_no: number | null;
        }>(
          `
            select
              m.public_name,
              cmp.display_name,
              cmp.tagline,
              cmp.summary,
              cmp.what_i_do,
              cmp.known_for,
              cmp.services_summary,
              cmp.website_url,
              cmp.links,
              cmp.profile,
              cmp.version_no
            from app.members m
            left join app.current_member_profiles cmp on cmp.member_id = m.id
            where m.id = $1
              and m.state = 'active'
          `,
          [actor.member.id],
        );

        const current = currentResult.rows[0];
        if (!current) {
          throw new Error('Actor member disappeared during profile update');
        }

        await client.query(
          `
            insert into app.member_profile_versions (
              member_id, version_no, display_name, tagline, summary, what_i_do, known_for,
              services_summary, website_url, links, profile, created_by_member_id
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12)
          `,
          [
            actor.member.id,
            (current.version_no ?? 0) + 1,
            patch.displayName ?? current.display_name ?? current.public_name,
            patch.tagline !== undefined ? patch.tagline : current.tagline,
            patch.summary !== undefined ? patch.summary : current.summary,
            patch.whatIDo !== undefined ? patch.whatIDo : current.what_i_do,
            patch.knownFor !== undefined ? patch.knownFor : current.known_for,
            patch.servicesSummary !== undefined ? patch.servicesSummary : current.services_summary,
            patch.websiteUrl !== undefined ? patch.websiteUrl : current.website_url,
            JSON.stringify(patch.links !== undefined ? patch.links : current.links ?? []),
            JSON.stringify(patch.profile !== undefined ? patch.profile : current.profile ?? {}),
            actor.member.id,
          ],
        );

        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        if (
          error && typeof error === 'object' && 'code' in error && error.code === '23505' &&
          'constraint' in error && error.constraint === 'members_handle_key'
        ) {
          throw new AppError(409, 'handle_conflict', 'That handle is already taken');
        }
        throw error;
      } finally {
        client.release();
      }

      const updated = await readMemberProfile(pool, actor.member.id, actor.member.id);
      if (!updated) {
        throw new Error('Updated profile could not be reloaded');
      }
      return updated;
    },

    async createEntity(input: CreateEntityInput): Promise<EntitySummary> {
      const client = await pool.connect();
      try {
        await client.query('begin');
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

        const summary = await pool.query<EntityRow>(
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
              e.created_at::text as entity_created_at
            from app.entities e
            join app.current_entity_versions cev on cev.entity_id = e.id
            join app.members m on m.id = e.author_member_id
            where e.id = $1
              and cev.id = $2
          `,
          [entity.id, versionResult.rows[0]!.id],
        );
        return mapEntityRow(summary.rows[0]!);
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async listEntities({ networkIds, kinds, limit }) {
      const result = await pool.query<EntityRow>(
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
            le.entity_created_at::text as entity_created_at
          from scope s
          join app.live_entities le on le.network_id = s.network_id
          join app.members m on m.id = le.author_member_id
          where le.kind = any($2::app.entity_kind[])
          order by le.effective_at desc, le.entity_id desc
          limit $3
        `,
        [networkIds, kinds, limit],
      );
      return result.rows.map(mapEntityRow);
    },
  };
}
