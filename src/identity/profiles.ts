/**
 * Identity domain — member profiles and search.
 */

import type { Pool } from 'pg';
import { AppError, type ActorContext, type MemberProfile, type MemberSearchResult, type UpdateOwnProfileInput } from '../contract.ts';
import { EMBEDDING_PROFILES } from '../ai.ts';
import { withTransaction, type DbClient } from '../db.ts';

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
  shared_clubs: Array<{ clubId: string; slug: string; name: string }> | null;
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
    },
    sharedClubs: row.shared_clubs ?? [],
  };
}

async function enqueueEmbeddingJob(client: DbClient, subjectVersionId: string): Promise<void> {
  const profile = EMBEDDING_PROFILES['member_profile'];
  await client.query(
    `insert into app.embedding_jobs (subject_kind, subject_version_id, model, dimensions, source_version)
     values ('member_profile_version', $1, $2, $3, $4)
     on conflict (subject_kind, subject_version_id, model, dimensions, source_version) do nothing`,
    [subjectVersionId, profile.model, profile.dimensions, profile.sourceVersion],
  );
}

/**
 * Get a member's profile. actorClubIds scopes which shared clubs are visible.
 * Returns null if the actor shares no clubs with the target (access denied).
 * Self-profile always allowed regardless of club membership.
 */
export async function getMemberProfile(pool: Pool, actorMemberId: string, targetMemberId: string, actorClubIds: string[]): Promise<MemberProfile | null> {
  // Self-profile is always accessible
  if (actorMemberId !== targetMemberId) {
    // Access check: actor must share at least one club with the target
    const accessCheck = await pool.query<{ ok: boolean }>(
      `select exists(
         select 1 from app.accessible_memberships
         where member_id = $1 and club_id = any($2::text[])
       ) as ok`,
      [targetMemberId, actorClubIds],
    );
    if (!accessCheck.rows[0]?.ok) return null;
  }

  const result = await pool.query<ProfileRow>(
    `with target_scope as (
       select distinct anm.club_id
       from app.accessible_memberships anm
       where anm.member_id = $1
         and anm.club_id = any($2::text[])
     )
     select
       m.id as member_id, m.public_name, m.handle,
       coalesce(cmp.display_name, m.public_name) as display_name,
       cmp.tagline, cmp.summary, cmp.what_i_do, cmp.known_for,
       cmp.services_summary, cmp.website_url, cmp.links, cmp.profile,
       cmp.id as version_id, cmp.version_no,
       cmp.created_at::text as version_created_at,
       cmp.created_by_member_id as version_created_by_member_id,
       jsonb_agg(distinct jsonb_build_object('clubId', n.id, 'slug', n.slug, 'name', n.name))
         filter (where n.id is not null) as shared_clubs
     from app.members m
     left join app.current_profiles cmp on cmp.member_id = m.id
     left join target_scope ts on true
     left join app.clubs n on n.id = ts.club_id and n.archived_at is null
     where m.id = $1 and m.state = 'active'
     group by m.id, m.public_name, m.handle, cmp.display_name, cmp.tagline,
              cmp.summary, cmp.what_i_do, cmp.known_for, cmp.services_summary,
              cmp.website_url, cmp.links, cmp.profile, cmp.id, cmp.version_no,
              cmp.created_at, cmp.created_by_member_id`,
    [targetMemberId, actorClubIds],
  );

  return result.rows[0] ? mapProfileRow(result.rows[0]) : null;
}

export async function updateOwnProfile(pool: Pool, actor: ActorContext, patch: UpdateOwnProfileInput): Promise<MemberProfile> {
  await withTransaction(pool, async (client) => {
    if (patch.handle !== undefined) {
      await client.query(`update app.members set handle = $2 where id = $1`, [actor.member.id, patch.handle]);
    }

    const currentResult = await client.query<{
      public_name: string; display_name: string | null; tagline: string | null;
      summary: string | null; what_i_do: string | null; known_for: string | null;
      services_summary: string | null; website_url: string | null;
      links: unknown[] | null; profile: Record<string, unknown> | null; version_no: number | null;
    }>(
      `select m.public_name, cmp.display_name, cmp.tagline, cmp.summary,
              cmp.what_i_do, cmp.known_for, cmp.services_summary, cmp.website_url,
              cmp.links, cmp.profile, cmp.version_no
       from app.members m
       left join app.current_profiles cmp on cmp.member_id = m.id
       where m.id = $1 and m.state = 'active'`,
      [actor.member.id],
    );

    const current = currentResult.rows[0];
    if (!current) throw new AppError(500, 'missing_row', 'Actor member row disappeared during profile update');

    const versionResult = await client.query<{ id: string }>(
      `insert into app.profile_versions (
         member_id, version_no, display_name, tagline, summary, what_i_do, known_for,
         services_summary, website_url, links, profile, created_by_member_id
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12)
       returning id`,
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

    if (versionResult.rows[0]) {
      await enqueueEmbeddingJob(client, versionResult.rows[0].id);
    }
  });

  const actorClubIds = actor.memberships.map((m) => m.clubId);
  const updated = await getMemberProfile(pool, actor.member.id, actor.member.id, actorClubIds);
  if (!updated) throw new AppError(500, 'missing_row', 'Updated profile could not be reloaded');
  return updated;
}

// ── Search ──────────────────────────────────────────────────

type MemberSearchRow = {
  member_id: string; public_name: string; display_name: string;
  handle: string | null; tagline: string | null; summary: string | null;
  what_i_do: string | null; known_for: string | null;
  services_summary: string | null; website_url: string | null;
  shared_clubs: Array<{ clubId: string; slug: string; name: string }> | null;
};

function mapSearchRow(row: MemberSearchRow): MemberSearchResult {
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

export async function fullTextSearchMembers(pool: Pool, input: {
  actorMemberId: string; clubIds: string[]; query: string; limit: number;
}): Promise<MemberSearchResult[]> {
  if (input.clubIds.length === 0) return [];

  const result = await pool.query<MemberSearchRow>(
    `with scope as (
       select distinct anm.member_id
       from app.accessible_memberships anm
       where anm.club_id = any($1::text[])
         and anm.member_id <> $2
     )
     select
       m.id as member_id, m.public_name,
       coalesce(cmp.display_name, m.public_name) as display_name,
       m.handle, cmp.tagline, cmp.summary, cmp.what_i_do, cmp.known_for,
       cmp.services_summary, cmp.website_url,
       jsonb_agg(distinct jsonb_build_object('clubId', n.id, 'slug', n.slug, 'name', n.name))
         filter (where n.id is not null) as shared_clubs
     from scope s
     join app.members m on m.id = s.member_id and m.state = 'active'
     left join app.current_profiles cmp on cmp.member_id = m.id
     left join app.profile_versions mpv on mpv.member_id = m.id
       and mpv.version_no = cmp.version_no
     left join app.accessible_memberships anm2 on anm2.member_id = m.id
       and anm2.club_id = any($1::text[])
     left join app.clubs n on n.id = anm2.club_id and n.archived_at is null
     where mpv.search_vector @@ plainto_tsquery('english', $3)
     group by m.id, m.public_name, cmp.display_name, m.handle, cmp.tagline,
              cmp.summary, cmp.what_i_do, cmp.known_for, cmp.services_summary,
              cmp.website_url, mpv.search_vector
     order by ts_rank(mpv.search_vector, plainto_tsquery('english', $3)) desc
     limit $4`,
    [input.clubIds, input.actorMemberId, input.query, input.limit],
  );

  return result.rows.map(mapSearchRow);
}

export async function findMembersViaEmbedding(pool: Pool, input: {
  actorMemberId: string; clubIds: string[]; queryEmbedding: string; limit: number;
}): Promise<MemberSearchResult[]> {
  if (input.clubIds.length === 0) return [];

  const result = await pool.query<MemberSearchRow>(
    `with scope as (
       select distinct anm.member_id
       from app.accessible_memberships anm
       where anm.club_id = any($1::text[])
         and anm.member_id <> $2
     )
     select
       m.id as member_id, m.public_name,
       coalesce(cmp.display_name, m.public_name) as display_name,
       m.handle, cmp.tagline, cmp.summary, cmp.what_i_do, cmp.known_for,
       cmp.services_summary, cmp.website_url,
       jsonb_agg(distinct jsonb_build_object('clubId', n.id, 'slug', n.slug, 'name', n.name))
         filter (where n.id is not null) as shared_clubs
     from scope s
     join app.members m on m.id = s.member_id and m.state = 'active'
     left join app.current_profiles cmp on cmp.member_id = m.id
     left join app.accessible_memberships anm2 on anm2.member_id = m.id
       and anm2.club_id = any($1::text[])
     left join app.clubs n on n.id = anm2.club_id and n.archived_at is null
     where exists (
       select 1 from app.profile_embeddings empa
       where empa.member_id = m.id
     )
     group by m.id, m.public_name, cmp.display_name, m.handle, cmp.tagline,
              cmp.summary, cmp.what_i_do, cmp.known_for, cmp.services_summary,
              cmp.website_url
     order by (
       select min(empa.embedding <=> $3::vector)
       from app.profile_embeddings empa
       where empa.member_id = m.id
     ) asc
     limit $4`,
    [input.clubIds, input.actorMemberId, input.queryEmbedding, input.limit],
  );

  return result.rows.map(mapSearchRow);
}
