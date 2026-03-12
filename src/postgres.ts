import { Pool } from 'pg';
import type { ActorContext, MemberSearchResult, MembershipSummary, Repository } from './app.ts';

type ActorRow = {
  member_id: string;
  auth_subject: string;
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
  rank_bucket: number;
};

export function createPostgresRepository({ pool }: { pool: Pool }): Repository {
  return {
    async getActorContextByAuthSubject(authSubject: string): Promise<ActorContext | null> {
      const result = await pool.query<ActorRow>(
        `
          select
            m.id as member_id,
            m.auth_subject,
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
          where m.auth_subject = $1
            and m.state = 'active'
          order by n.name asc nulls last
        `,
        [authSubject],
      );

      if (result.rowCount === 0) {
        return null;
      }

      const [first] = result.rows;

      return {
        member: {
          id: first.member_id,
          authSubject: first.auth_subject,
          handle: first.handle,
          publicName: first.public_name,
        },
        networks: result.rows
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
            jsonb_agg(
              distinct jsonb_build_object(
                'id', n.id,
                'slug', n.slug,
                'name', n.name
              )
            ) filter (where n.id is not null) as shared_networks,
            min(
              case
                when lower(coalesce(cmp.display_name, m.public_name)) = lower($2)
                  or lower(m.public_name) = lower($2)
                  or lower(coalesce(m.handle, '')) = lower($2)
                then 0
                when lower(coalesce(cmp.display_name, m.public_name)) like lower($3)
                  or lower(m.public_name) like lower($3)
                  or lower(coalesce(m.handle, '')) like lower($3)
                then 1
                else 2
              end
            ) as rank_bucket
          from scope s
          join app.accessible_network_memberships anm
            on anm.network_id = s.network_id
          join app.members m
            on m.id = anm.member_id
           and m.state = 'active'
          left join app.current_member_profiles cmp
            on cmp.member_id = m.id
          join app.networks n
            on n.id = anm.network_id
           and n.archived_at is null
          where (
            m.public_name ilike $4
            or coalesce(cmp.display_name, '') ilike $4
            or coalesce(m.handle, '') ilike $4
            or coalesce(cmp.what_i_do, '') ilike $4
            or coalesce(cmp.known_for, '') ilike $4
            or coalesce(cmp.services_summary, '') ilike $4
          )
          group by
            m.id,
            m.public_name,
            cmp.display_name,
            m.handle,
            cmp.tagline,
            cmp.summary,
            cmp.what_i_do,
            cmp.known_for,
            cmp.services_summary,
            cmp.website_url
          order by rank_bucket asc, display_name asc, m.id asc
          limit $5
        `,
        [networkIds, trimmedQuery, prefixPattern, likePattern, limit],
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
  };
}
