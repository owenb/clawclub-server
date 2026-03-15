import { Pool, type PoolClient } from 'pg';
import { AppError, type ActorContext, type MemberProfile, type Repository, type UpdateOwnProfileInput } from '../app.ts';
import { mapEmbeddingProjectionRow } from './projections.ts';

type DbClient = Pool | PoolClient;

type ApplyActorContext = (
  client: DbClient,
  actorMemberId: string,
  networkIds: string[],
  options?: Record<string, never>,
) => Promise<void>;

type WithActorContext = <T>(
  pool: Pool,
  actorMemberId: string,
  networkIds: string[],
  fn: (client: PoolClient) => Promise<T>,
) => Promise<T>;

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
  embedding_id: string | null;
  embedding_model: string | null;
  embedding_dimensions: number | null;
  embedding_source_text: string | null;
  embedding_metadata: Record<string, unknown> | null;
  embedding_created_at: string | null;
  shared_networks: Array<{ id: string; slug: string; name: string }> | null;
};

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
      embedding: mapEmbeddingProjectionRow(row),
    },
    sharedNetworks: row.shared_networks ?? [],
  };
}

async function readMemberProfile(client: DbClient, targetMemberId: string): Promise<MemberProfile | null> {
  const result = await client.query<ProfileRow>(
    `
      with target_scope as (
        select distinct anm.network_id
        from app.accessible_network_memberships anm
        where anm.member_id = $1
          and app.actor_has_network_access(anm.network_id)
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
        cpve.id as embedding_id,
        cpve.model as embedding_model,
        cpve.dimensions as embedding_dimensions,
        cpve.source_text as embedding_source_text,
        cpve.metadata as embedding_metadata,
        cpve.created_at::text as embedding_created_at,
        jsonb_agg(distinct jsonb_build_object('id', n.id, 'slug', n.slug, 'name', n.name))
          filter (where n.id is not null) as shared_networks
      from app.members m
      left join app.current_member_profiles cmp on cmp.member_id = m.id
      left join app.current_profile_version_embeddings cpve on cpve.member_profile_version_id = cmp.id
      left join target_scope ts on true
      left join app.networks n on n.id = ts.network_id and n.archived_at is null
      where m.id = $1
        and m.state = 'active'
      group by
        m.id, m.public_name, m.handle,
        cmp.display_name, cmp.tagline, cmp.summary, cmp.what_i_do, cmp.known_for,
        cmp.services_summary, cmp.website_url, cmp.links, cmp.profile,
        cmp.id, cmp.version_no, cmp.created_at, cmp.created_by_member_id,
        cpve.id, cpve.model, cpve.dimensions, cpve.source_text, cpve.metadata, cpve.created_at
    `,
    [targetMemberId],
  );

  return result.rows[0] ? mapProfileRow(result.rows[0]) : null;
}

export function buildProfileRepository({
  pool,
  applyActorContext,
  withActorContext,
}: {
  pool: Pool;
  applyActorContext: ApplyActorContext;
  withActorContext: WithActorContext;
}): Pick<Repository, 'getMemberProfile' | 'updateOwnProfile'> {
  return {
    async getMemberProfile({ actorMemberId, targetMemberId }) {
      return withActorContext(pool, actorMemberId, [], (client) => readMemberProfile(client, targetMemberId));
    },

    async updateOwnProfile({ actor, patch }: { actor: ActorContext; patch: UpdateOwnProfileInput }): Promise<MemberProfile> {
      const client = await pool.connect();

      try {
        await client.query('begin');
        await applyActorContext(client, actor.member.id, actor.memberships.map((membership) => membership.networkId));

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

      const updated = await withActorContext(
        pool,
        actor.member.id,
        actor.memberships.map((membership) => membership.networkId),
        (scopedClient) => readMemberProfile(scopedClient, actor.member.id),
      );
      if (!updated) {
        throw new Error('Updated profile could not be reloaded');
      }
      return updated;
    },
  };
}
