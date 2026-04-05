/**
 * Embedding repository: job enqueuing, semantic search, full-text search.
 */
import type { Pool } from 'pg';
import type { EntitySummary, MemberSearchResult, Repository } from '../contract.ts';
import { EMBEDDING_PROFILES } from '../ai.ts';
import type { DbClient, WithActorContext } from './helpers.ts';

// ── Job enqueue (called inside write transactions) ──────

type SubjectKind = 'member_profile' | 'entity';

const SUBJECT_KIND_MAP: Record<SubjectKind, { dbKind: string; profileKey: keyof typeof EMBEDDING_PROFILES }> = {
  member_profile: { dbKind: 'member_profile_version', profileKey: 'member_profile' },
  entity: { dbKind: 'entity_version', profileKey: 'entity' },
};

export async function enqueueEmbeddingJob(client: DbClient, kind: SubjectKind, versionId: string): Promise<void> {
  const { dbKind, profileKey } = SUBJECT_KIND_MAP[kind];
  const profile = EMBEDDING_PROFILES[profileKey];
  await client.query(
    `SELECT app.embeddings_enqueue_job($1, $2, $3, $4, $5)`,
    [dbKind, versionId, profile.model, profile.dimensions, profile.sourceVersion],
  );
}

// ── Shared search row mapper ───────────────────────────

type MemberSearchRow = {
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
  shared_clubs: Array<{ id: string; slug: string; name: string }> | null;
};

function mapMemberSearchRow(row: MemberSearchRow): MemberSearchResult {
  return {
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
    sharedClubs: row.shared_clubs ?? [],
  };
}

// ── Entity search row mapper ───────────────────────────

type EntitySearchRow = {
  entity_id: string;
  entity_version_id: string;
  club_id: string;
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

function mapEntitySearchRow(row: EntitySearchRow): EntitySummary {
  return {
    entityId: row.entity_id,
    entityVersionId: row.entity_version_id,
    clubId: row.club_id,
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

// ── Repository builder ──────────────────────────────────

export function buildEmbeddingsRepository({
  pool,
  withActorContext,
}: {
  pool: Pool;
  withActorContext: WithActorContext;
}): Pick<Repository, 'fullTextSearchMembers' | 'findMembersViaEmbedding' | 'findEntitiesViaEmbedding'> {
  const memberProfile = EMBEDDING_PROFILES.member_profile;
  const entityProfile = EMBEDDING_PROFILES.entity;

  return {
    async fullTextSearchMembers(input) {
      return withActorContext(pool, input.actorMemberId, input.clubIds, async (client) => {
        // Build tsquery from input. plainto_tsquery handles multi-word input safely.
        // We also do prefix matching on handle/name for exact lookups.
        //
        // We join member_profile_versions directly (via current_member_profiles
        // for the version ID) because search_vector lives on the versions table,
        // not the current_member_profiles view.
        const result = await client.query<MemberSearchRow & { rank: number }>(
          `
            WITH scope AS (
              SELECT unnest($1::text[])::app.short_id AS club_id
            ),
            fts_query AS (
              SELECT plainto_tsquery('english', $2) AS q
            )
            SELECT
              m.id AS member_id,
              m.public_name,
              coalesce(cmp.display_name, m.public_name) AS display_name,
              m.handle,
              cmp.tagline,
              cmp.summary,
              cmp.what_i_do,
              cmp.known_for,
              cmp.services_summary,
              cmp.website_url,
              jsonb_agg(DISTINCT jsonb_build_object('id', n.id, 'slug', n.slug, 'name', n.name))
                FILTER (WHERE n.id IS NOT NULL) AS shared_clubs,
              CASE
                WHEN lower(coalesce(m.handle, '')) = lower($2) THEN 1000
                WHEN lower(coalesce(cmp.display_name, m.public_name)) = lower($2) THEN 900
                WHEN lower(coalesce(m.handle, '')) LIKE lower($2) || '%' THEN 500
                WHEN lower(coalesce(cmp.display_name, m.public_name)) LIKE lower($2) || '%' THEN 400
                ELSE coalesce(ts_rank_cd(mpv.search_vector, (SELECT q FROM fts_query)) * 100, 0)
              END AS rank
            FROM scope s
            JOIN app.accessible_club_memberships anm ON anm.club_id = s.club_id
            JOIN app.members m ON m.id = anm.member_id AND m.state = 'active'
            LEFT JOIN app.current_member_profiles cmp ON cmp.member_id = m.id
            LEFT JOIN app.member_profile_versions mpv ON mpv.id = cmp.id
            JOIN app.clubs n ON n.id = anm.club_id AND n.archived_at IS NULL
            WHERE (
              mpv.search_vector @@ (SELECT q FROM fts_query)
              OR lower(coalesce(m.handle, '')) LIKE lower($2) || '%'
              OR lower(m.public_name) LIKE lower($2) || '%'
              OR lower(coalesce(cmp.display_name, '')) LIKE lower($2) || '%'
            )
            GROUP BY
              m.id, m.public_name, cmp.display_name, m.handle,
              cmp.tagline, cmp.summary, cmp.what_i_do, cmp.known_for,
              cmp.services_summary, cmp.website_url, mpv.search_vector
            ORDER BY rank DESC, display_name ASC, m.id ASC
            LIMIT $3
          `,
          [input.clubIds, input.query, input.limit],
        );

        return result.rows.map(mapMemberSearchRow);
      });
    },

    async findMembersViaEmbedding(input) {
      return withActorContext(pool, input.actorMemberId, input.clubIds, async (client) => {
        const result = await client.query<MemberSearchRow>(
          `
            WITH scope AS (
              SELECT unnest($1::text[])::app.short_id AS club_id
            ),
            query_embedding AS (
              SELECT $2::vector(1536) AS vec
            )
            SELECT
              m.id AS member_id,
              m.public_name,
              coalesce(cmp.display_name, m.public_name) AS display_name,
              m.handle,
              cmp.tagline,
              cmp.summary,
              cmp.what_i_do,
              cmp.known_for,
              cmp.services_summary,
              cmp.website_url,
              jsonb_agg(DISTINCT jsonb_build_object('id', n.id, 'slug', n.slug, 'name', n.name))
                FILTER (WHERE n.id IS NOT NULL) AS shared_clubs
            FROM scope s
            JOIN app.accessible_club_memberships anm ON anm.club_id = s.club_id
            JOIN app.members m ON m.id = anm.member_id AND m.state = 'active'
            LEFT JOIN app.current_member_profiles cmp ON cmp.member_id = m.id
            JOIN app.clubs n ON n.id = anm.club_id AND n.archived_at IS NULL
            WHERE EXISTS (
              SELECT 1
              FROM app.embeddings_member_profile_artifacts a
              WHERE a.member_profile_version_id = cmp.id
                AND a.model = $4
                AND a.dimensions = $5
                AND a.source_version = $6
            )
            GROUP BY
              m.id, m.public_name, cmp.display_name, cmp.id, m.handle,
              cmp.tagline, cmp.summary, cmp.what_i_do, cmp.known_for,
              cmp.services_summary, cmp.website_url
            ORDER BY (
              SELECT MIN(a.embedding_vector <=> (SELECT vec FROM query_embedding))
              FROM app.embeddings_member_profile_artifacts a
              WHERE a.member_profile_version_id = cmp.id
                AND a.model = $4
                AND a.dimensions = $5
                AND a.source_version = $6
            ) ASC
            LIMIT $3
          `,
          [
            input.clubIds,
            input.queryEmbedding,
            input.limit,
            memberProfile.model,
            memberProfile.dimensions,
            memberProfile.sourceVersion,
          ],
        );

        return result.rows.map(mapMemberSearchRow);
      });
    },

    async findEntitiesViaEmbedding(input) {
      return withActorContext(pool, input.actorMemberId, input.clubIds, async (client) => {
        const kindsParam = input.kinds && input.kinds.length > 0 ? input.kinds : null;

        const result = await client.query<EntitySearchRow>(
          `
            WITH scope AS (
              SELECT unnest($1::text[])::app.short_id AS club_id
            ),
            query_embedding AS (
              SELECT $2::vector(1536) AS vec
            )
            SELECT
              e.id AS entity_id,
              cev.id AS entity_version_id,
              e.club_id,
              e.kind,
              m.id AS author_member_id,
              m.public_name AS author_public_name,
              m.handle AS author_handle,
              cev.version_no,
              cev.state,
              cev.title,
              cev.summary,
              cev.body,
              cev.effective_at::text AS effective_at,
              cev.expires_at::text AS expires_at,
              cev.created_at::text AS version_created_at,
              cev.content,
              e.created_at::text AS entity_created_at
            FROM scope s
            JOIN app.entities e ON e.club_id = s.club_id
            JOIN app.current_entity_versions cev ON cev.entity_id = e.id
            JOIN app.members m ON m.id = e.author_member_id
            WHERE e.deleted_at IS NULL
              AND e.archived_at IS NULL
              AND cev.state = 'published'
              AND ($4::text[] IS NULL OR e.kind::text = ANY($4))
              AND EXISTS (
                SELECT 1
                FROM app.embeddings_entity_artifacts a
                WHERE a.entity_version_id = cev.id
                  AND a.model = $5
                  AND a.dimensions = $6
                  AND a.source_version = $7
              )
            ORDER BY (
              SELECT MIN(a.embedding_vector <=> (SELECT vec FROM query_embedding))
              FROM app.embeddings_entity_artifacts a
              WHERE a.entity_version_id = cev.id
                AND a.model = $5
                AND a.dimensions = $6
                AND a.source_version = $7
            ) ASC
            LIMIT $3
          `,
          [
            input.clubIds,
            input.queryEmbedding,
            input.limit,
            kindsParam,
            entityProfile.model,
            entityProfile.dimensions,
            entityProfile.sourceVersion,
          ],
        );

        return result.rows.map(mapEntitySearchRow);
      });
    },
  };
}
