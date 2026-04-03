import type { Pool } from 'pg';
import type { CreateAdmissionSponsorInput, Repository, AdmissionSummary } from '../app-contract.ts';
import type { WithActorContext } from './shared.ts';

export function buildAdmissionSponsorRepository({
  pool,
  withActorContext,
}: {
  pool: Pool;
  withActorContext: WithActorContext;
}): Pick<Repository, 'createAdmissionSponsorship'> {
  return {
    async createAdmissionSponsorship(input: CreateAdmissionSponsorInput): Promise<AdmissionSummary> {
      return withActorContext(pool, input.actorMemberId, [input.clubId], async (client) => {
        const result = await client.query<{
          admission_id: string;
          club_id: string;
          sponsor_member_id: string;
          sponsor_public_name: string;
          sponsor_handle: string | null;
          created_at: string;
        }>(
          `
            with inserted_admission as (
              insert into app.admissions (club_id, sponsor_member_id, origin, applicant_email, applicant_name, admission_details)
              values ($1, $2, 'member_sponsored', $3, $4, $5::jsonb)
              returning id, club_id, sponsor_member_id, created_at
            )
            select
              ia.id as admission_id,
              ia.club_id,
              ia.sponsor_member_id,
              m.public_name as sponsor_public_name,
              m.handle as sponsor_handle,
              ia.created_at::text as created_at
            from inserted_admission ia
            join app.members m on m.id = ia.sponsor_member_id
          `,
          [input.clubId, input.actorMemberId, input.candidateEmail, input.candidateName, JSON.stringify({ ...input.candidateDetails, reason: input.reason })],
        );

        const row = result.rows[0];
        if (!row) {
          throw new Error('Admission row was not returned after insert');
        }

        // Create the initial version
        await client.query(
          `
            insert into app.admission_versions (admission_id, status, notes, version_no, created_by_member_id)
            values ($1, 'submitted', 'Sponsored admission created by member', 1, $2)
          `,
          [row.admission_id, input.actorMemberId],
        );

        return {
          admissionId: row.admission_id,
          clubId: row.club_id,
          applicant: {
            memberId: null,
            publicName: input.candidateName,
            handle: null,
            email: input.candidateEmail,
          },
          sponsor: {
            memberId: row.sponsor_member_id,
            publicName: row.sponsor_public_name,
            handle: row.sponsor_handle,
          },
          membershipId: null,
          origin: 'member_sponsored',
          intake: {
            kind: 'other',
            price: { amount: null, currency: null },
            bookingUrl: null,
            bookedAt: null,
            completedAt: null,
          },
          state: {
            status: 'submitted',
            notes: 'Sponsored admission created by member',
            versionNo: 1,
            createdAt: row.created_at,
            createdByMemberId: input.actorMemberId,
          },
          admissionDetails: { ...input.candidateDetails, reason: input.reason },
          metadata: {},
          createdAt: row.created_at,
        };
      });
    },
  };
}
