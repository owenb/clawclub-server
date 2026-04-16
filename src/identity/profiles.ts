/**
 * Identity domain — club-scoped member profiles and search.
 */

import type { Pool } from 'pg';
import { generateObject } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import {
  AppError,
  type ActorContext,
  type ClubProfile,
  type ClubProfileFields,
  type ClubProfileLink,
  type MemberIdentity,
  type MemberProfileEnvelope,
  type MemberSearchResult,
  type ProfileForGate,
  type UpdateClubProfileInput,
  type UpdateMemberIdentityInput,
} from '../contract.ts';
import { CLAWCLUB_OPENAI_MODEL, EMBEDDING_PROFILES } from '../ai.ts';
import { withTransaction, type DbClient } from '../db.ts';
import { encodeCursor } from '../schemas/fields.ts';

const clubProfileFieldsSchema = z.object({
  tagline: z.string().trim().min(1).nullable(),
  summary: z.string().trim().min(1).nullable(),
  whatIDo: z.string().trim().min(1).nullable(),
  knownFor: z.string().trim().min(1).nullable(),
  servicesSummary: z.string().trim().min(1).nullable(),
  websiteUrl: z.string().trim().min(1).nullable(),
  links: z.array(z.object({
    url: z.string().trim().url().max(500),
    label: z.string().trim().max(100).transform((value) => value === '' ? null : value).nullable(),
  })).max(20),
});

type MemberIdentityRow = {
  member_id: string;
  public_name: string;
  display_name: string;
};

type ClubProfileRow = {
  club_id: string;
  club_slug: string;
  club_name: string;
  tagline: string | null;
  summary: string | null;
  what_i_do: string | null;
  known_for: string | null;
  services_summary: string | null;
  website_url: string | null;
  links: ClubProfileLink[] | null;
  version_id: string;
  version_no: number;
  version_created_at: string;
  version_created_by_member_id: string | null;
};

type CurrentClubProfileRow = {
  membership_id: string;
  version_no: number;
  tagline: string | null;
  summary: string | null;
  what_i_do: string | null;
  known_for: string | null;
  services_summary: string | null;
  website_url: string | null;
  links: ClubProfileLink[] | null;
};

type SeedSourceRow = {
  tagline: string | null;
  summary: string | null;
  what_i_do: string | null;
  known_for: string | null;
  services_summary: string | null;
  website_url: string | null;
  links: ClubProfileLink[] | null;
};

type MemberSearchRow = {
  member_id: string;
  public_name: string;
  display_name: string;
  tagline: string | null;
  summary: string | null;
  what_i_do: string | null;
  known_for: string | null;
  services_summary: string | null;
  website_url: string | null;
  shared_clubs: Array<{ clubId: string; slug: string; name: string }> | null;
};

type MembershipRow = {
  membership_id: string;
  member_id: string;
  club_id: string;
};

function mapIdentityRow(row: MemberIdentityRow): MemberIdentity {
  return {
    memberId: row.member_id,
    publicName: row.public_name,
    displayName: row.display_name,
  };
}

export function emptyClubProfileFields(): ClubProfileFields {
  return {
    tagline: null,
    summary: null,
    whatIDo: null,
    knownFor: null,
    servicesSummary: null,
    websiteUrl: null,
    links: [],
  };
}

export function normalizeClubProfileFields(input: Partial<ClubProfileFields> | null | undefined): ClubProfileFields {
  const base = emptyClubProfileFields();
  if (!input) return base;
  return clubProfileFieldsSchema.parse({
    tagline: input.tagline ?? base.tagline,
    summary: input.summary ?? base.summary,
    whatIDo: input.whatIDo ?? base.whatIDo,
    knownFor: input.knownFor ?? base.knownFor,
    servicesSummary: input.servicesSummary ?? base.servicesSummary,
    websiteUrl: input.websiteUrl ?? base.websiteUrl,
    links: input.links ?? base.links,
  });
}

function mapClubProfileRow(row: ClubProfileRow): ClubProfile {
  return {
    club: {
      clubId: row.club_id,
      slug: row.club_slug,
      name: row.club_name,
    },
    tagline: row.tagline,
    summary: row.summary,
    whatIDo: row.what_i_do,
    knownFor: row.known_for,
    servicesSummary: row.services_summary,
    websiteUrl: row.website_url,
    links: row.links ?? [],
    version: {
      id: row.version_id,
      versionNo: Number(row.version_no),
      createdAt: row.version_created_at,
      createdByMemberId: row.version_created_by_member_id,
    },
  };
}

function buildEnvelope(identity: MemberIdentityRow, profiles: ClubProfileRow[]): MemberProfileEnvelope {
  return {
    ...mapIdentityRow(identity),
    profiles: profiles.map(mapClubProfileRow),
  };
}

async function enqueueEmbeddingJob(client: DbClient, subjectVersionId: string): Promise<void> {
  const profile = EMBEDDING_PROFILES.member_profile;
  await client.query(
    `insert into ai_embedding_jobs (subject_kind, subject_version_id, model, dimensions, source_version)
     values ('member_club_profile_version', $1, $2, $3, $4)
     on conflict (subject_kind, subject_version_id, model, dimensions, source_version) do nothing`,
    [subjectVersionId, profile.model, profile.dimensions, profile.sourceVersion],
  );
}

async function readMemberIdentity(client: DbClient, memberId: string): Promise<MemberIdentityRow | null> {
  const result = await client.query<MemberIdentityRow>(
    `select id as member_id, public_name, display_name
     from members
     where id = $1 and state = 'active'
     limit 1`,
    [memberId],
  );
  return result.rows[0] ?? null;
}

async function listVisibleClubs(
  client: DbClient,
  actorMemberId: string,
  targetMemberId: string,
  actorClubIds: string[],
  clubId?: string,
): Promise<Array<{ club_id: string; club_slug: string; club_name: string }>> {
  if (actorMemberId === targetMemberId) {
    const params: unknown[] = [targetMemberId];
    let clubFilterSql = '';
    if (clubId) {
      params.push(clubId);
      clubFilterSql = ` and cm.club_id = $${params.length}`;
    }

    const result = await client.query<{ club_id: string; club_slug: string; club_name: string }>(
      `select c.id as club_id, c.slug as club_slug, c.name as club_name
       from current_club_memberships cm
       join clubs c on c.id = cm.club_id and c.archived_at is null
       where cm.member_id = $1
         and cm.left_at is null${clubFilterSql}
       order by c.name asc, c.id asc`,
      params,
    );
    return result.rows;
  }

  if (clubId && !actorClubIds.includes(clubId)) return [];
  const scopedClubIds = clubId ? [clubId] : actorClubIds;
  if (scopedClubIds.length === 0) return [];

  const result = await client.query<{ club_id: string; club_slug: string; club_name: string }>(
    `select distinct c.id as club_id, c.slug as club_slug, c.name as club_name
     from accessible_club_memberships acm
     join clubs c on c.id = acm.club_id and c.archived_at is null
     where acm.member_id = $1
       and acm.club_id = any($2::text[])
     order by c.name asc, c.id asc`,
    [targetMemberId, scopedClubIds],
  );
  return result.rows;
}

async function readClubProfiles(client: DbClient, memberId: string, clubIds: string[]): Promise<ClubProfileRow[]> {
  if (clubIds.length === 0) return [];

  const result = await client.query<ClubProfileRow>(
    `select
       c.id as club_id,
       c.slug as club_slug,
       c.name as club_name,
       cmp.tagline,
       cmp.summary,
       cmp.what_i_do,
       cmp.known_for,
       cmp.services_summary,
       cmp.website_url,
       cmp.links,
       cmp.id as version_id,
       cmp.version_no,
       cmp.created_at::text as version_created_at,
       cmp.created_by_member_id as version_created_by_member_id
     from current_member_club_profiles cmp
     join clubs c on c.id = cmp.club_id and c.archived_at is null
     where cmp.member_id = $1
       and cmp.club_id = any($2::text[])
     order by c.name asc, c.id asc`,
    [memberId, clubIds],
  );
  return result.rows;
}

export async function listMemberProfiles(pool: Pool, input: {
  actorMemberId: string;
  targetMemberId: string;
  actorClubIds: string[];
  clubId?: string;
}): Promise<MemberProfileEnvelope | null> {
  const identity = await readMemberIdentity(pool, input.targetMemberId);
  if (!identity) return null;

  const visibleClubs = await listVisibleClubs(
    pool,
    input.actorMemberId,
    input.targetMemberId,
    input.actorClubIds,
    input.clubId,
  );

  if (input.actorMemberId !== input.targetMemberId && visibleClubs.length === 0) {
    return null;
  }

  const profiles = await readClubProfiles(pool, input.targetMemberId, visibleClubs.map((club) => club.club_id));
  return buildEnvelope(identity, profiles);
}

async function readMembership(client: DbClient, memberId: string, clubId: string): Promise<MembershipRow | null> {
  const result = await client.query<MembershipRow>(
    `select id as membership_id, member_id, club_id
     from current_club_memberships
     where member_id = $1
       and club_id = $2
       and left_at is null
     limit 1`,
    [memberId, clubId],
  );
  return result.rows[0] ?? null;
}

async function readCurrentClubProfile(client: DbClient, memberId: string, clubId: string): Promise<CurrentClubProfileRow | null> {
  const result = await client.query<CurrentClubProfileRow>(
    `select membership_id, version_no, tagline, summary, what_i_do, known_for,
            services_summary, website_url, links
     from current_member_club_profiles
     where member_id = $1 and club_id = $2
     limit 1`,
    [memberId, clubId],
  );
  return result.rows[0] ?? null;
}

function mergeClubProfilePatch(
  current: CurrentClubProfileRow,
  patch: UpdateClubProfileInput,
): ClubProfileFields {
  return normalizeClubProfileFields({
    tagline: patch.tagline !== undefined ? patch.tagline : current.tagline,
    summary: patch.summary !== undefined ? patch.summary : current.summary,
    whatIDo: patch.whatIDo !== undefined ? patch.whatIDo : current.what_i_do,
    knownFor: patch.knownFor !== undefined ? patch.knownFor : current.known_for,
    servicesSummary: patch.servicesSummary !== undefined ? patch.servicesSummary : current.services_summary,
    websiteUrl: patch.websiteUrl !== undefined ? patch.websiteUrl : current.website_url,
    links: patch.links !== undefined ? patch.links : current.links ?? [],
  });
}

async function insertClubProfileVersion(client: DbClient, input: {
  membershipId: string;
  memberId: string;
  clubId: string;
  fields: ClubProfileFields;
  createdByMemberId: string | null;
  generationSource: 'manual' | 'migration_backfill' | 'application_generated' | 'membership_seed';
  versionNo?: number;
}): Promise<string> {
  const result = await client.query<{ id: string }>(
    `insert into member_club_profile_versions (
       membership_id, member_id, club_id, version_no,
       tagline, summary, what_i_do, known_for, services_summary,
       website_url, links, created_by_member_id, generation_source
     )
     values (
       $1::short_id,
       $2::short_id,
       $3::short_id,
       coalesce(
         $4::integer,
         (
           select coalesce(max(version_no), 0) + 1
           from member_club_profile_versions
           where member_id = $2::short_id and club_id = $3::short_id
         )
       ),
       $5, $6, $7, $8, $9, $10, $11::jsonb, $12::short_id, $13
     )
     returning id`,
    [
      input.membershipId,
      input.memberId,
      input.clubId,
      input.versionNo ?? null,
      input.fields.tagline,
      input.fields.summary,
      input.fields.whatIDo,
      input.fields.knownFor,
      input.fields.servicesSummary,
      input.fields.websiteUrl,
      JSON.stringify(input.fields.links),
      input.createdByMemberId,
      input.generationSource,
    ],
  );
  return result.rows[0]!.id;
}

export async function createInitialClubProfileVersion(client: DbClient, input: {
  membershipId: string;
  memberId: string;
  clubId: string;
  fields: ClubProfileFields;
  createdByMemberId: string | null;
  generationSource: 'application_generated' | 'membership_seed' | 'migration_backfill';
}): Promise<string> {
  const versionId = await insertClubProfileVersion(client, {
    ...input,
    versionNo: 1,
  });
  await enqueueEmbeddingJob(client, versionId);
  return versionId;
}

export async function buildMembershipSeedProfile(client: DbClient, input: {
  memberId: string;
  clubId: string;
}): Promise<ClubProfileFields> {
  const result = await client.query<SeedSourceRow>(
    `select tagline, summary, what_i_do, known_for, services_summary, website_url, links
     from current_member_club_profiles
     where member_id = $1
       and club_id <> $2
     order by created_at desc, version_no desc
     limit 1`,
    [input.memberId, input.clubId],
  );
  const row = result.rows[0];
  if (!row) return emptyClubProfileFields();
  return normalizeClubProfileFields({
    tagline: row.tagline,
    summary: row.summary,
    whatIDo: row.what_i_do,
    knownFor: row.known_for,
    servicesSummary: row.services_summary,
    websiteUrl: row.website_url,
    links: row.links ?? [],
  });
}

export async function updateMemberIdentity(
  pool: Pool,
  actor: ActorContext,
  patch: UpdateMemberIdentityInput,
): Promise<MemberIdentity> {
  return withTransaction(pool, async (client) => {
    if (patch.displayName !== undefined) {
      await client.query(`update members set display_name = $2 where id = $1`, [actor.member.id, patch.displayName]);
    }

    const identity = await readMemberIdentity(client, actor.member.id);
    if (!identity) {
      throw new AppError(500, 'missing_row', 'Updated identity could not be reloaded');
    }
    return mapIdentityRow(identity);
  });
}

export async function updateClubProfile(
  pool: Pool,
  actor: ActorContext,
  patch: UpdateClubProfileInput,
): Promise<MemberProfileEnvelope> {
  await withTransaction(pool, async (client) => {
    const current = await readCurrentClubProfile(client, actor.member.id, patch.clubId);
    if (!current) {
      throw new AppError(404, 'not_found', 'Club profile not found for this membership');
    }

    const fields = mergeClubProfilePatch(current, patch);
    const versionId = await insertClubProfileVersion(client, {
      membershipId: current.membership_id,
      memberId: actor.member.id,
      clubId: patch.clubId,
      fields,
      createdByMemberId: actor.member.id,
      generationSource: 'manual',
    });
    await enqueueEmbeddingJob(client, versionId);
  });

  const updated = await listMemberProfiles(pool, {
    actorMemberId: actor.member.id,
    targetMemberId: actor.member.id,
    actorClubIds: actor.memberships.map((membership) => membership.clubId),
  });
  if (!updated) {
    throw new AppError(500, 'missing_row', 'Updated profile could not be reloaded');
  }
  return updated;
}

export async function loadProfileForGate(pool: Pool, input: {
  actorMemberId: string;
  clubId: string;
}): Promise<ProfileForGate | null> {
  const current = await readCurrentClubProfile(pool, input.actorMemberId, input.clubId);
  if (!current) return null;
  return normalizeClubProfileFields({
    tagline: current.tagline,
    summary: current.summary,
    whatIDo: current.what_i_do,
    knownFor: current.known_for,
    servicesSummary: current.services_summary,
    websiteUrl: current.website_url,
    links: current.links ?? [],
  });
}

function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s<>"')]+/gi) ?? [];
  return [...new Set(matches.map((url) => url.replace(/[),.;!?]+$/, '')))].slice(0, 10);
}

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

function scrubPrivateContactText(value: string | null | undefined): string | null {
  if (!value) return null;
  const scrubbed = value
    .replace(/mailto:/gi, '')
    .replace(EMAIL_PATTERN, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\[\s*\]/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;!?])/g, '$1')
    .trim();
  return scrubbed.length > 0 ? scrubbed : null;
}

function sanitizeClubApplicationLinks(links: ClubProfileLink[] | null | undefined): ClubProfileLink[] {
  if (!Array.isArray(links)) return [];

  return links.flatMap((link) => {
    const url = scrubPrivateContactText(link.url);
    if (!url || !/^https?:\/\//i.test(url)) return [];

    return [{
      url,
      label: scrubPrivateContactText(link.label),
    }];
  });
}

function sanitizeClubApplicationProfile(fields: Partial<ClubProfileFields>): ClubProfileFields {
  const websiteUrl = scrubPrivateContactText(fields.websiteUrl ?? null);
  return normalizeClubProfileFields({
    tagline: scrubPrivateContactText(fields.tagline ?? null),
    summary: scrubPrivateContactText(fields.summary ?? null),
    whatIDo: scrubPrivateContactText(fields.whatIDo ?? null),
    knownFor: scrubPrivateContactText(fields.knownFor ?? null),
    servicesSummary: scrubPrivateContactText(fields.servicesSummary ?? null),
    websiteUrl: websiteUrl && /^https?:\/\//i.test(websiteUrl) ? websiteUrl : null,
    links: sanitizeClubApplicationLinks(fields.links),
  });
}

function fallbackClubApplicationProfile(input: {
  application: string;
  socials: string;
}): ClubProfileFields {
  const application = input.application.trim();
  const urls = [
    ...extractUrls(input.application),
    ...extractUrls(input.socials),
  ];
  const websiteUrl = urls[0] ?? null;
  const links = urls
    .slice(0, 5)
    .filter((url) => url !== websiteUrl)
    .map((url) => ({ url, label: null }));

  return sanitizeClubApplicationProfile({
    summary: application.length > 0 ? application : null,
    websiteUrl,
    links,
  });
}

function mergeClubApplicationProfileFallback(
  generated: ClubProfileFields,
  fallback: ClubProfileFields,
): ClubProfileFields {
  return normalizeClubProfileFields({
    ...generated,
    summary: generated.summary ?? fallback.summary,
    websiteUrl: generated.websiteUrl ?? fallback.websiteUrl,
    links: generated.links.length > 0 ? generated.links : fallback.links,
  });
}

export async function generateClubApplicationProfile(input: {
  club: { name: string; summary: string | null; admissionPolicy: string | null };
  applicantName: string;
  application: string;
  socials: string;
}): Promise<ClubProfileFields> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return fallbackClubApplicationProfile(input);
  }

  const provider = createOpenAI({ apiKey });
  const model = provider(CLAWCLUB_OPENAI_MODEL);
  const promptPayload = {
    clubName: input.club.name,
    clubSummary: input.club.summary,
    admissionPolicy: input.club.admissionPolicy,
    applicantName: input.applicantName,
    application: input.application,
    socials: input.socials,
  };
  const fallbackProfile = fallbackClubApplicationProfile(input);

  try {
    const result = await generateObject({
      model,
      schema: clubProfileFieldsSchema,
      system: `You generate public, club-specific member profiles from club applications.

Only use the submitted application text and socials as source material.
Do not invent facts, credentials, achievements, pricing, experience, or contact details.
Do not include email addresses or private contact information.
If the application does not justify a field, leave it null.
      Only output the club-scoped fields defined by the schema.`,
      prompt: JSON.stringify(promptPayload),
    });
    return mergeClubApplicationProfileFallback(
      sanitizeClubApplicationProfile(result.object),
      fallbackProfile,
    );
  } catch (error) {
    console.error('Application profile generation failed:', error);
    throw new AppError(503, 'profile_generation_unavailable', 'Profile generation service is temporarily unavailable');
  }
}

function mapSearchRow(row: MemberSearchRow): MemberSearchResult {
  return {
    memberId: row.member_id,
    publicName: row.public_name,
    displayName: row.display_name,
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
  actorMemberId: string;
  clubId: string;
  query: string;
  limit: number;
  cursor?: { rank: string; memberId: string } | null;
}): Promise<{ results: MemberSearchResult[]; hasMore: boolean; nextCursor: string | null }> {
  const fetchLimit = input.limit + 1;
  const cursorRank = input.cursor ? parseFloat(input.cursor.rank) : null;
  const cursorMemberId = input.cursor?.memberId ?? null;

  const result = await pool.query<MemberSearchRow & { _rank: number }>(
    `with params as (
       select plainto_tsquery('english', $3) as query,
              ('%' || lower($3) || '%') as like_query
     )
     select
       m.id as member_id,
       m.public_name,
       m.display_name,
       cmp.tagline,
       cmp.summary,
       cmp.what_i_do,
       cmp.known_for,
       cmp.services_summary,
       cmp.website_url,
       jsonb_build_array(jsonb_build_object('clubId', c.id, 'slug', c.slug, 'name', c.name)) as shared_clubs,
       case
         when cmp.search_vector @@ params.query then ts_rank(cmp.search_vector, params.query)
         when lower(m.public_name) like params.like_query or lower(m.display_name) like params.like_query then 1.0
         else 0.0
       end as _rank
     from accessible_club_memberships acm
     join members m on m.id = acm.member_id and m.state = 'active'
     join clubs c on c.id = acm.club_id and c.archived_at is null
     join current_member_club_profiles cmp
       on cmp.member_id = m.id and cmp.club_id = acm.club_id
     cross join params
     where acm.club_id = $1
       and acm.member_id <> $2
       and (
         cmp.search_vector @@ params.query
         or lower(m.public_name) like params.like_query
         or lower(m.display_name) like params.like_query
       )
       and (
         $5::float8 is null
         or case
              when cmp.search_vector @@ params.query then ts_rank(cmp.search_vector, params.query)
              when lower(m.public_name) like params.like_query or lower(m.display_name) like params.like_query then 1.0
              else 0.0
            end < $5
         or (
              case
                when cmp.search_vector @@ params.query then ts_rank(cmp.search_vector, params.query)
                when lower(m.public_name) like params.like_query or lower(m.display_name) like params.like_query then 1.0
                else 0.0
              end = $5
              and m.id < $6
            )
       )
     order by _rank desc, m.id desc
     limit $4`,
    [input.clubId, input.actorMemberId, input.query, fetchLimit, cursorRank, cursorMemberId],
  );

  const rows = result.rows.map(mapSearchRow);
  const hasMore = rows.length > input.limit;
  if (hasMore) rows.pop();
  const lastRow = hasMore || rows.length === input.limit ? result.rows[rows.length - 1] : null;
  const nextCursor = lastRow && rows.length > 0
    ? encodeCursor([String(lastRow._rank), lastRow.member_id])
    : null;

  return { results: rows, hasMore, nextCursor };
}

export async function findMembersViaEmbedding(pool: Pool, input: {
  actorMemberId: string;
  clubId: string;
  queryEmbedding: string;
  limit: number;
  cursor?: { distance: string; memberId: string } | null;
}): Promise<{ results: MemberSearchResult[]; hasMore: boolean; nextCursor: string | null }> {
  const fetchLimit = input.limit + 1;
  const cursorDist = input.cursor ? parseFloat(input.cursor.distance) : null;
  const cursorMemberId = input.cursor?.memberId ?? null;

  const result = await pool.query<MemberSearchRow & { _distance: number }>(
    `select
       m.id as member_id,
       m.public_name,
       m.display_name,
       cmp.tagline,
       cmp.summary,
       cmp.what_i_do,
       cmp.known_for,
       cmp.services_summary,
       cmp.website_url,
       jsonb_build_array(jsonb_build_object('clubId', c.id, 'slug', c.slug, 'name', c.name)) as shared_clubs,
       min(empa.embedding <=> $3::vector) as _distance
     from accessible_club_memberships acm
     join members m on m.id = acm.member_id and m.state = 'active'
     join clubs c on c.id = acm.club_id and c.archived_at is null
     join current_member_club_profiles cmp
       on cmp.member_id = m.id and cmp.club_id = acm.club_id
     join member_profile_embeddings empa
       on empa.member_id = m.id
      and empa.club_id = acm.club_id
      and empa.profile_version_id = cmp.id
     where acm.club_id = $1
       and acm.member_id <> $2
       and (
         $5::float8 is null
         or (empa.embedding <=> $3::vector) > $5
         or ((empa.embedding <=> $3::vector) = $5 and m.id < $6)
       )
     group by
       m.id, m.public_name, m.display_name,
       c.id, c.slug, c.name,
       cmp.tagline, cmp.summary, cmp.what_i_do,
       cmp.known_for, cmp.services_summary, cmp.website_url
     order by _distance asc, m.id desc
     limit $4`,
    [input.clubId, input.actorMemberId, input.queryEmbedding, fetchLimit, cursorDist, cursorMemberId],
  );

  const rows = result.rows.map(mapSearchRow);
  const hasMore = rows.length > input.limit;
  if (hasMore) rows.pop();
  const lastRow = hasMore || rows.length === input.limit ? result.rows[rows.length - 1] : null;
  const nextCursor = lastRow && rows.length > 0
    ? encodeCursor([String(lastRow._distance), lastRow.member_id])
    : null;

  return { results: rows, hasMore, nextCursor };
}
