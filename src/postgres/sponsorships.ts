import type { Pool } from 'pg';
import type { CreateSponsorshipInput, Repository, SponsorshipSummary } from '../app-contract.ts';
import type { WithActorContext } from './shared.ts';

type SponsorshipRow = {
  id: string;
  network_id: string;
  sponsor_member_id: string;
  sponsor_public_name: string;
  sponsor_handle: string | null;
  candidate_name: string;
  candidate_email: string;
  candidate_details: Record<string, unknown>;
  reason: string;
  created_at: string;
};

function mapSponsorshipRow(row: SponsorshipRow): SponsorshipSummary {
  return {
    sponsorshipId: row.id,
    networkId: row.network_id,
    sponsor: {
      memberId: row.sponsor_member_id,
      publicName: row.sponsor_public_name,
      handle: row.sponsor_handle,
    },
    candidateName: row.candidate_name,
    candidateEmail: row.candidate_email,
    candidateDetails: row.candidate_details,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

export function buildSponsorshipRepository({
  pool,
  withActorContext,
}: {
  pool: Pool;
  withActorContext: WithActorContext;
}): Pick<Repository, 'createSponsorship' | 'listSponsorships'> {
  return {
    async createSponsorship(input: CreateSponsorshipInput): Promise<SponsorshipSummary> {
      return withActorContext(pool, input.actorMemberId, [input.networkId], async (client) => {
        const result = await client.query<SponsorshipRow>(
          `
            insert into app.sponsorships (network_id, sponsor_member_id, candidate_name, candidate_email, candidate_details, reason)
            values ($1, $2, $3, $4, $5::jsonb, $6)
            returning
              id,
              network_id,
              sponsor_member_id,
              (select public_name from app.members where id = sponsor_member_id) as sponsor_public_name,
              (select handle from app.members where id = sponsor_member_id) as sponsor_handle,
              candidate_name,
              candidate_email,
              candidate_details,
              reason,
              created_at::text as created_at
          `,
          [input.networkId, input.actorMemberId, input.candidateName, input.candidateEmail, JSON.stringify(input.candidateDetails), input.reason],
        );

        const row = result.rows[0];
        if (!row) {
          throw new Error('Sponsorship row was not returned after insert');
        }

        return mapSponsorshipRow(row);
      });
    },

    async listSponsorships(input): Promise<SponsorshipSummary[]> {
      return withActorContext(pool, input.actorMemberId, input.networkIds, async (client) => {
        const result = await client.query<SponsorshipRow>(
          `
            select
              s.id,
              s.network_id,
              s.sponsor_member_id,
              m.public_name as sponsor_public_name,
              m.handle as sponsor_handle,
              s.candidate_name,
              s.candidate_email,
              s.candidate_details,
              s.reason,
              s.created_at::text as created_at
            from app.sponsorships s
            join app.members m on m.id = s.sponsor_member_id
            where s.network_id = any($1::app.short_id[])
            order by s.created_at desc
            limit $2
          `,
          [input.networkIds, input.limit],
        );

        return result.rows.map(mapSponsorshipRow);
      });
    },
  };
}
