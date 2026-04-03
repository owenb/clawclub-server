import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import {
  AppError,
  type AdmissionStatus,
  type AdmissionSummary,
  type AdmissionChallengeResult,
  type CreateAdmissionNominationInput,
  type CreateAdmissionSponsorInput,
  type IssueAdmissionAccessInput,
  type IssueAdmissionAccessResult,
  type MembershipState,
  type Repository,
  type SolveAdmissionChallengeInput,
  type TransitionAdmissionInput,
} from '../app.ts';
import { buildBearerToken } from '../token.ts';
import { requireReturnedRow } from './query-guards.ts';
import type { ApplyActorContext, DbClient, WithActorContext } from './shared.ts';

const COLD_APPLICATION_DIFFICULTY = 7;
const COLD_APPLICATION_CHALLENGE_TTL_MS = 60 * 60 * 1000;

type AdmissionRow = {
  admission_id: string;
  club_id: string;
  applicant_member_id: string | null;
  applicant_public_name: string | null;
  applicant_handle: string | null;
  applicant_email: string | null;
  applicant_name: string | null;
  sponsor_member_id: string | null;
  sponsor_public_name: string | null;
  sponsor_handle: string | null;
  membership_id: string | null;
  linked_membership_status: MembershipState | null;
  linked_membership_accepted_covenant_at: string | null;
  origin: 'self_applied' | 'member_sponsored' | 'owner_nominated';
  intake_kind: 'fit_check' | 'advice_call' | 'other';
  intake_price_amount: string | number | null;
  intake_price_currency: string | null;
  intake_booking_url: string | null;
  intake_booked_at: string | null;
  intake_completed_at: string | null;
  status: AdmissionStatus;
  notes: string | null;
  version_no: number;
  version_created_at: string;
  version_created_by_member_id: string | null;
  admission_details: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

function mapAdmissionRow(row: AdmissionRow): AdmissionSummary {
  return {
    admissionId: row.admission_id,
    clubId: row.club_id,
    applicant: {
      memberId: row.applicant_member_id,
      publicName: row.applicant_public_name ?? row.applicant_name ?? 'Unknown applicant',
      handle: row.applicant_handle,
      email: row.applicant_email,
    },
    sponsor: row.sponsor_member_id
      ? {
          memberId: row.sponsor_member_id,
          publicName: row.sponsor_public_name ?? 'Unknown sponsor',
          handle: row.sponsor_handle,
        }
      : null,
    membershipId: row.membership_id,
    origin: row.origin,
    intake: {
      kind: row.intake_kind,
      price: {
        amount: row.intake_price_amount === null ? null : Number(row.intake_price_amount),
        currency: row.intake_price_currency,
      },
      bookingUrl: row.intake_booking_url,
      bookedAt: row.intake_booked_at,
      completedAt: row.intake_completed_at,
    },
    state: {
      status: row.status,
      notes: row.notes,
      versionNo: Number(row.version_no),
      createdAt: row.version_created_at,
      createdByMemberId: row.version_created_by_member_id,
    },
    admissionDetails: row.admission_details ?? {},
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
  };
}

async function readAdmissions(client: DbClient, input: {
  clubIds: string[];
  limit: number;
  statuses?: AdmissionStatus[];
}): Promise<AdmissionSummary[]> {
  if (input.clubIds.length === 0) {
    return [];
  }

  const result = await client.query<AdmissionRow>(
    `
      select
        ca.id as admission_id,
        ca.club_id,
        ca.applicant_member_id,
        ca.applicant_email,
        ca.applicant_name,
        applicant.public_name as applicant_public_name,
        applicant.handle as applicant_handle,
        ca.sponsor_member_id,
        sponsor.public_name as sponsor_public_name,
        sponsor.handle as sponsor_handle,
        ca.membership_id,
        cnm.status as linked_membership_status,
        cnm.accepted_covenant_at::text as linked_membership_accepted_covenant_at,
        ca.origin,
        ca.intake_kind,
        ca.intake_price_amount,
        ca.intake_price_currency,
        ca.intake_booking_url,
        ca.intake_booked_at::text as intake_booked_at,
        ca.intake_completed_at::text as intake_completed_at,
        ca.status,
        ca.notes,
        ca.version_no,
        ca.version_created_at::text as version_created_at,
        ca.version_created_by_member_id,
        ca.admission_details,
        ca.metadata,
        ca.created_at::text as created_at
      from app.current_admissions ca
      left join app.members applicant on applicant.id = ca.applicant_member_id
      left join app.members sponsor on sponsor.id = ca.sponsor_member_id
      left join app.current_club_memberships cnm on cnm.id = ca.membership_id
      where ca.club_id = any($1::app.short_id[])
        and ($2::app.application_status[] is null or ca.status = any($2::app.application_status[]))
      order by ca.version_created_at desc, ca.id asc
      limit $3
    `,
    [input.clubIds, input.statuses ?? null, input.limit],
  );

  return result.rows.map(mapAdmissionRow);
}

async function readAdmissionSummary(client: DbClient, admissionId: string): Promise<AdmissionSummary | null> {
  const result = await client.query<AdmissionRow>(
    `
      select
        ca.id as admission_id,
        ca.club_id,
        ca.applicant_member_id,
        ca.applicant_email,
        ca.applicant_name,
        applicant.public_name as applicant_public_name,
        applicant.handle as applicant_handle,
        ca.sponsor_member_id,
        sponsor.public_name as sponsor_public_name,
        sponsor.handle as sponsor_handle,
        ca.membership_id,
        cnm.status as linked_membership_status,
        cnm.accepted_covenant_at::text as linked_membership_accepted_covenant_at,
        ca.origin,
        ca.intake_kind,
        ca.intake_price_amount,
        ca.intake_price_currency,
        ca.intake_booking_url,
        ca.intake_booked_at::text as intake_booked_at,
        ca.intake_completed_at::text as intake_completed_at,
        ca.status,
        ca.notes,
        ca.version_no,
        ca.version_created_at::text as version_created_at,
        ca.version_created_by_member_id,
        ca.admission_details,
        ca.metadata,
        ca.created_at::text as created_at
      from app.current_admissions ca
      left join app.members applicant on applicant.id = ca.applicant_member_id
      left join app.members sponsor on sponsor.id = ca.sponsor_member_id
      left join app.current_club_memberships cnm on cnm.id = ca.membership_id
      where ca.id = $1
      limit 1
    `,
    [admissionId],
  );

  return result.rows[0] ? mapAdmissionRow(result.rows[0]) : null;
}

export function buildAdmissionsRepository({
  pool,
  applyActorContext,
  withActorContext,
}: {
  pool: Pool;
  applyActorContext: ApplyActorContext;
  withActorContext: WithActorContext;
}): Pick<
  Repository,
  | 'listAdmissions'
  | 'createAdmission'
  | 'transitionAdmission'
  | 'createAdmissionChallenge'
  | 'solveAdmissionChallenge'
  | 'issueAdmissionAccess'
  | 'createAdmissionSponsorship'
> {
  return {
    async listAdmissions({ actorMemberId, clubIds, limit, statuses }) {
      return withActorContext(pool, actorMemberId, clubIds, (client) => readAdmissions(client, { clubIds, limit, statuses }));
    },

    async createAdmission(input: CreateAdmissionNominationInput): Promise<AdmissionSummary | null> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await applyActorContext(client, input.actorMemberId, [input.clubId]);

        const ownerScopeResult = await client.query<{ membership_id: string }>(
          `
            select anm.id as membership_id
            from app.accessible_club_memberships anm
            where anm.member_id = $1
              and anm.club_id = $2
              and anm.role = 'owner'
            limit 1
          `,
          [input.actorMemberId, input.clubId],
        );

        if (!ownerScopeResult.rows[0]) {
          await client.query('rollback');
          return null;
        }

        const sponsorResult = input.sponsorMemberId
          ? await client.query<{ member_id: string }>(
              `
                select cnm.member_id
                from app.current_club_memberships cnm
                where cnm.club_id = $1
                  and cnm.member_id = $2
                  and cnm.status = 'active'
                limit 1
              `,
              [input.clubId, input.sponsorMemberId],
            )
          : { rows: [] };

        if (input.sponsorMemberId && !sponsorResult.rows[0]) {
          await client.query('rollback');
          return null;
        }

        const admissionResult = await client.query<{ admission_id: string }>(
          `
            with inserted as (
              insert into app.admissions (
                club_id,
                applicant_member_id,
                sponsor_member_id,
                origin,
                metadata
              )
              select $1, $2, $3, 'owner_nominated'::text, $4::jsonb
              where app.member_is_active($2)
              returning id as admission_id
            ), version_insert as (
              insert into app.admission_versions (
                admission_id,
                status,
                notes,
                intake_kind,
                intake_price_amount,
                intake_price_currency,
                intake_booking_url,
                intake_booked_at,
                intake_completed_at,
                version_no,
                created_by_member_id
              )
              select
                admission_id,
                $5,
                $6,
                $7,
                $8,
                $9,
                $10,
                $11,
                $12,
                1,
                $13
              from inserted
            )
            select admission_id
            from inserted
          `,
          [
            input.clubId,
            input.applicantMemberId,
            input.sponsorMemberId ?? null,
            JSON.stringify(input.metadata ?? {}),
            input.initialStatus,
            input.notes ?? null,
            input.intake.kind ?? 'fit_check',
            input.intake.price?.amount ?? null,
            input.intake.price?.currency ?? 'GBP',
            input.intake.bookingUrl ?? null,
            input.intake.bookedAt ?? null,
            input.intake.completedAt ?? null,
            input.actorMemberId,
          ],
        );

        const admissionId = admissionResult.rows[0]?.admission_id;
        if (!admissionId) {
          await client.query('rollback');
          return null;
        }

        await client.query('commit');
        return await withActorContext(pool, input.actorMemberId, [input.clubId], (scopedClient) => readAdmissionSummary(scopedClient, admissionId));
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async transitionAdmission(input: TransitionAdmissionInput): Promise<AdmissionSummary | null> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await applyActorContext(client, input.actorMemberId, input.accessibleClubIds);

        const admissionResult = await client.query<{
          admission_id: string;
          club_id: string;
          applicant_member_id: string | null;
          applicant_name: string | null;
          applicant_email: string | null;
          current_status: AdmissionStatus;
          current_version_no: number;
          current_version_id: string;
          current_metadata: Record<string, unknown> | null;
          current_admission_details: Record<string, unknown> | null;
          current_intake_kind: 'fit_check' | 'advice_call' | 'other';
          current_intake_price_amount: string | number | null;
          current_intake_price_currency: string | null;
          current_intake_booking_url: string | null;
          current_intake_booked_at: string | null;
          current_intake_completed_at: string | null;
          current_membership_id: string | null;
          sponsor_member_id: string | null;
        }>(
          `
            select
              ca.id as admission_id,
              ca.club_id,
              ca.applicant_member_id,
              ca.applicant_name,
              ca.applicant_email,
              ca.status as current_status,
              ca.version_no as current_version_no,
              ca.version_id as current_version_id,
              ca.metadata as current_metadata,
              ca.admission_details as current_admission_details,
              ca.intake_kind as current_intake_kind,
              ca.intake_price_amount as current_intake_price_amount,
              ca.intake_price_currency as current_intake_price_currency,
              ca.intake_booking_url as current_intake_booking_url,
              ca.intake_booked_at::text as current_intake_booked_at,
              ca.intake_completed_at::text as current_intake_completed_at,
              ca.membership_id as current_membership_id,
              ca.sponsor_member_id
            from app.current_admissions ca
            join app.accessible_club_memberships owner_scope
              on owner_scope.club_id = ca.club_id
             and owner_scope.member_id = $1
             and owner_scope.role = 'owner'
            where ca.id = $2
              and ca.club_id = any($3::app.short_id[])
            limit 1
          `,
          [input.actorMemberId, input.admissionId, input.accessibleClubIds],
        );

        const admission = admissionResult.rows[0];
        if (!admission) {
          await client.query('rollback');
          return null;
        }

        const mergedMetadata = {
          ...(admission.current_metadata ?? {}),
          ...(input.metadataPatch ?? {}),
        };

        const resolvedCompletedAt = input.intake?.completedAt === undefined ? admission.current_intake_completed_at : input.intake.completedAt;

        // Update admission metadata
        await client.query(
          `
            update app.admissions a
            set metadata = $2::jsonb
            where a.id = $1
          `,
          [admission.admission_id, JSON.stringify(mergedMetadata)],
        );

        // Insert new admission version
        await client.query(
          `
            insert into app.admission_versions (
              admission_id,
              status,
              notes,
              intake_kind,
              intake_price_amount,
              intake_price_currency,
              intake_booking_url,
              intake_booked_at,
              intake_completed_at,
              version_no,
              supersedes_version_id,
              created_by_member_id
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          `,
          [
            admission.admission_id,
            input.nextStatus,
            input.notes ?? null,
            input.intake?.kind ?? admission.current_intake_kind,
            input.intake?.price?.amount === undefined ? admission.current_intake_price_amount : input.intake.price.amount,
            input.intake?.price?.currency === undefined ? admission.current_intake_price_currency : input.intake.price.currency,
            input.intake?.bookingUrl === undefined ? admission.current_intake_booking_url : input.intake.bookingUrl,
            input.intake?.bookedAt === undefined ? admission.current_intake_booked_at : input.intake.bookedAt,
            resolvedCompletedAt,
            Number(admission.current_version_no) + 1,
            admission.current_version_id,
            input.actorMemberId,
          ],
        );

        // Handle acceptance: finalize membership for the applicant
        if (input.nextStatus === 'accepted') {
          const isOutsider = admission.applicant_member_id === null;

          if (isOutsider) {
            // Outsider admission: create a member from the admission data via security definer
            const displayName = admission.applicant_name ?? 'New Member';
            const email = admission.applicant_email;
            if (!email) {
              throw new AppError(409, 'admission_missing_email', 'Cannot accept an outsider admission without an email address');
            }

            const memberResult = await client.query<{ member_id: string }>(
              `select member_id from app.create_member_from_admission($1, $2, $3, $4::jsonb)`,
              [
                admission.applicant_name ?? displayName,
                email,
                displayName,
                JSON.stringify(admission.current_admission_details ?? {}),
              ],
            );

            const newMemberId = memberResult.rows[0]?.member_id;
            if (!newMemberId) {
              throw new AppError(500, 'member_creation_failed', 'Failed to create member from admission');
            }

            // Create membership for the new member
            // For self-applied outsiders with no sponsor, use the accepting owner as sponsor
            const sponsorId = admission.sponsor_member_id ?? input.actorMemberId;
            const membershipResult = await client.query<{ id: string }>(
              `
                insert into app.club_memberships (club_id, member_id, sponsor_member_id, role, status)
                values ($1, $2, $3, 'member', 'active')
                returning id
              `,
              [admission.club_id, newMemberId, sponsorId],
            );

            const newMembershipId = membershipResult.rows[0]?.id;
            if (!newMembershipId) {
              throw new AppError(500, 'membership_creation_failed', 'Failed to create membership for admitted member');
            }

            // Create membership state version
            await client.query(
              `
                insert into app.club_membership_state_versions (
                  membership_id,
                  status,
                  reason,
                  version_no,
                  created_by_member_id
                )
                values ($1, 'active', 'Admitted from accepted admission', 1, $2)
              `,
              [newMembershipId, input.actorMemberId],
            );

            // Link admission to the new member and membership
            await client.query(
              `
                update app.admissions
                set applicant_member_id = $2,
                    membership_id = $3
                where id = $1
              `,
              [admission.admission_id, newMemberId, newMembershipId],
            );
          } else {
            // Existing member admission: create membership if not already linked
            let membershipId = admission.current_membership_id;

            if (!membershipId) {
              const existingSponsorId = admission.sponsor_member_id ?? input.actorMemberId;
              const membershipResult = await client.query<{ id: string }>(
                `
                  insert into app.club_memberships (club_id, member_id, sponsor_member_id, role, status)
                  values ($1, $2, $3, 'member', 'active')
                  returning id
                `,
                [admission.club_id, admission.applicant_member_id, existingSponsorId],
              );

              membershipId = membershipResult.rows[0]?.id ?? null;
              if (!membershipId) {
                throw new AppError(500, 'membership_creation_failed', 'Failed to create membership for admitted member');
              }

              // Create membership state version
              await client.query(
                `
                  insert into app.club_membership_state_versions (
                    membership_id,
                    status,
                    reason,
                    version_no,
                    created_by_member_id
                  )
                  values ($1, 'active', 'Admitted from accepted admission', 1, $2)
                `,
                [membershipId, input.actorMemberId],
              );

              // Link admission to the membership
              await client.query(
                `
                  update app.admissions
                  set membership_id = $2
                  where id = $1
                `,
                [admission.admission_id, membershipId],
              );
            } else {
              // Membership already linked — activate it if pending
              const membershipCheck = await client.query<{
                membership_id: string;
                current_status: MembershipState;
                current_version_no: number;
                current_state_version_id: string;
              }>(
                `
                  select
                    cnm.id as membership_id,
                    cnm.status as current_status,
                    cnm.state_version_no as current_version_no,
                    cnm.state_version_id as current_state_version_id
                  from app.current_club_memberships cnm
                  where cnm.id = $1
                  limit 1
                `,
                [membershipId],
              );

              const membership = membershipCheck.rows[0];
              if (membership && membership.current_status !== 'active') {
                await client.query(
                  `
                    insert into app.club_membership_state_versions (
                      membership_id,
                      status,
                      reason,
                      version_no,
                      supersedes_state_version_id,
                      created_by_member_id
                    )
                    values ($1, 'active', 'Admitted from accepted admission', $2, $3, $4)
                  `,
                  [
                    membership.membership_id,
                    Number(membership.current_version_no) + 1,
                    membership.current_state_version_id,
                    input.actorMemberId,
                  ],
                );
              }
            }
          }
        }

        await client.query('commit');
        return await withActorContext(pool, input.actorMemberId, input.accessibleClubIds, (scopedClient) =>
          readAdmissionSummary(scopedClient, admission.admission_id),
        );
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async createAdmissionChallenge(): Promise<AdmissionChallengeResult> {
      const challengeResult = await pool.query<{ challenge_id: string; expires_at: string }>(
        `select challenge_id, expires_at from app.create_admission_challenge($1, $2)`,
        [COLD_APPLICATION_DIFFICULTY, COLD_APPLICATION_CHALLENGE_TTL_MS],
      );
      const challenge = requireReturnedRow(challengeResult.rows[0], 'Admission challenge was not created');

      const expiresAt = Date.parse(challenge.expires_at);
      if (!Number.isFinite(expiresAt)) {
        throw new AppError(500, 'invalid_data', 'Admission challenge expiry was not returned');
      }

      const clubsResult = await pool.query<{ slug: string; name: string; summary: string | null; owner_name: string; owner_email: string | null }>(
        `select slug, name, summary, owner_name, owner_email from app.list_publicly_listed_clubs()`,
      );

      return {
        challengeId: challenge.challenge_id,
        difficulty: COLD_APPLICATION_DIFFICULTY,
        expiresAt: new Date(expiresAt).toISOString(),
        clubs: clubsResult.rows.map((r) => ({ slug: r.slug, name: r.name, summary: r.summary, ownerName: r.owner_name, ownerEmail: r.owner_email })),
      };
    },

    async solveAdmissionChallenge(
      input: SolveAdmissionChallengeInput,
    ): Promise<{ success: boolean } | null> {
      const client = await pool.connect();

      try {
        await client.query('begin');

        const challengeResult = await client.query<{ challenge_id: string; difficulty: number; expires_at: string }>(
          `select challenge_id, difficulty, expires_at from app.get_admission_challenge($1)`,
          [input.challengeId],
        );

        const challenge = challengeResult.rows[0];
        if (!challenge) {
          await client.query('rollback');
          return null;
        }

        const expiresAt = Date.parse(challenge.expires_at);
        if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) {
          await client.query(
            `select app.delete_admission_challenge($1)`,
            [input.challengeId],
          );
          await client.query('commit');
          throw new AppError(410, 'challenge_expired', 'This challenge has expired');
        }

        const hash = createHash('sha256')
          .update(`${input.challengeId}:${input.nonce}`, 'utf8')
          .digest('hex');
        if (!hash.endsWith('0'.repeat(challenge.difficulty))) {
          throw new AppError(400, 'invalid_proof', 'The submitted proof does not meet the difficulty requirement');
        }

        const admissionDetails = JSON.stringify({
          socials: input.socials,
          reason: input.reason,
        });

        const admissionResult = await client.query<{ admission_id: string }>(
          `select admission_id from app.consume_admission_challenge($1, $2, $3, $4, $5::jsonb)`,
          [input.challengeId, input.clubSlug, input.name, input.email, admissionDetails],
        );

        if (!admissionResult.rows[0]) {
          await client.query('rollback');
          return null;
        }

        await client.query('commit');
        return { success: true };
      } catch (error) {
        await client.query('rollback');
        if (error && typeof error === 'object' && 'code' in error && error.code === '23514') {
          return null;
        }
        throw error;
      } finally {
        client.release();
      }
    },

    async issueAdmissionAccess(input: IssueAdmissionAccessInput): Promise<IssueAdmissionAccessResult | null> {
      return withActorContext(pool, input.actorMemberId, input.accessibleClubIds, async (client) => {
        // Look up the accepted admission within owner scope
        const admissionResult = await client.query<{
          admission_id: string;
          applicant_member_id: string | null;
          status: AdmissionStatus;
        }>(
          `
            select
              ca.id as admission_id,
              ca.applicant_member_id,
              ca.status
            from app.current_admissions ca
            join app.accessible_club_memberships owner_scope
              on owner_scope.club_id = ca.club_id
             and owner_scope.member_id = $1
             and owner_scope.role = 'owner'
            where ca.id = $2
              and ca.club_id = any($3::app.short_id[])
            limit 1
          `,
          [input.actorMemberId, input.admissionId, input.accessibleClubIds],
        );

        const admission = admissionResult.rows[0];
        if (!admission) {
          return null;
        }

        if (admission.status !== 'accepted') {
          throw new AppError(409, 'admission_not_accepted', 'Access can only be issued for accepted admissions');
        }

        if (!admission.applicant_member_id) {
          throw new AppError(409, 'admission_not_finalized', 'Admission has no linked member — acceptance may not have completed');
        }

        // Create a bearer token for the accepted member via security definer (bypasses self-insert RLS)
        const token = buildBearerToken();
        await client.query(
          `select app.issue_admission_access($1, $2, $3, $4, $5::jsonb)`,
          [
            token.tokenId,
            admission.applicant_member_id,
            input.label ?? 'Issued from admission acceptance',
            token.tokenHash,
            JSON.stringify({ source: 'admission', admissionId: input.admissionId }),
          ],
        );

        // Read the full admission summary for the response
        const summary = await readAdmissionSummary(client, input.admissionId);
        if (!summary) {
          return null;
        }

        return {
          admission: summary,
          bearerToken: token.bearerToken,
        };
      });
    },

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
          throw new AppError(500, 'invalid_data', 'Admission row was not returned after insert');
        }

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
