import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import {
  AppError,
  type ApplicationStatus,
  type ApplicationSummary,
  type ColdApplicationChallengeResult,
  type CreateApplicationInput,
  type MembershipState,
  type Repository,
  type SolveColdApplicationChallengeInput,
  type TransitionApplicationInput,
} from '../app.ts';
import { requireReturnedRow } from './query-guards.ts';
import type { ApplyActorContext, DbClient, WithActorContext } from './shared.ts';

const COLD_APPLICATION_DIFFICULTY = 7;
const COLD_APPLICATION_CHALLENGE_TTL_MS = 60 * 60 * 1000;

type ApplicationRow = {
  application_id: string;
  network_id: string;
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
  path: 'sponsored' | 'outside' | 'cold';
  intake_kind: 'fit_check' | 'advice_call' | 'other';
  intake_price_amount: string | number | null;
  intake_price_currency: string | null;
  intake_booking_url: string | null;
  intake_booked_at: string | null;
  intake_completed_at: string | null;
  status: ApplicationStatus;
  notes: string | null;
  version_no: number;
  version_created_at: string;
  version_created_by_member_id: string | null;
  application_details: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

function mapApplicationRow(row: ApplicationRow): ApplicationSummary {
  return {
    applicationId: row.application_id,
    networkId: row.network_id,
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
    activation: {
      linkedMembershipId: row.membership_id,
      membershipStatus: row.linked_membership_status,
      acceptedCovenantAt: row.linked_membership_accepted_covenant_at,
      readyForActivation: row.status === 'accepted' && row.membership_id !== null && row.linked_membership_status === 'pending_review',
    },
    path: row.path,
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
    applicationDetails: row.application_details ?? {},
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
  };
}

async function readApplications(client: DbClient, input: {
  networkIds: string[];
  limit: number;
  statuses?: ApplicationStatus[];
}): Promise<ApplicationSummary[]> {
  if (input.networkIds.length === 0) {
    return [];
  }

  const result = await client.query<ApplicationRow>(
    `
      select
        ca.id as application_id,
        ca.network_id,
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
        ca.path,
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
        ca.application_details,
        ca.metadata,
        ca.created_at::text as created_at
      from app.current_applications ca
      left join app.members applicant on applicant.id = ca.applicant_member_id
      left join app.members sponsor on sponsor.id = ca.sponsor_member_id
      left join app.current_network_memberships cnm on cnm.id = ca.membership_id
      where ca.network_id = any($1::app.short_id[])
        and ($2::app.application_status[] is null or ca.status = any($2::app.application_status[]))
      order by ca.version_created_at desc, ca.id asc
      limit $3
    `,
    [input.networkIds, input.statuses ?? null, input.limit],
  );

  return result.rows.map(mapApplicationRow);
}

async function readApplicationSummary(client: DbClient, applicationId: string): Promise<ApplicationSummary | null> {
  const result = await client.query<ApplicationRow>(
    `
      select
        ca.id as application_id,
        ca.network_id,
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
        ca.path,
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
        ca.application_details,
        ca.metadata,
        ca.created_at::text as created_at
      from app.current_applications ca
      left join app.members applicant on applicant.id = ca.applicant_member_id
      left join app.members sponsor on sponsor.id = ca.sponsor_member_id
      left join app.current_network_memberships cnm on cnm.id = ca.membership_id
      where ca.id = $1
      limit 1
    `,
    [applicationId],
  );

  return result.rows[0] ? mapApplicationRow(result.rows[0]) : null;
}

export function buildApplicationsRepository({
  pool,
  applyActorContext,
  withActorContext,
}: {
  pool: Pool;
  applyActorContext: ApplyActorContext;
  withActorContext: WithActorContext;
}): Pick<
  Repository,
  | 'listApplications'
  | 'createApplication'
  | 'transitionApplication'
  | 'createColdApplicationChallenge'
  | 'solveColdApplicationChallenge'
> {
  return {
    async listApplications({ actorMemberId, networkIds, limit, statuses }) {
      return withActorContext(pool, actorMemberId, networkIds, (client) => readApplications(client, { networkIds, limit, statuses }));
    },

    async createApplication(input: CreateApplicationInput): Promise<ApplicationSummary | null> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await applyActorContext(client, input.actorMemberId, [input.networkId]);

        const ownerScopeResult = await client.query<{ membership_id: string }>(
          `
            select anm.id as membership_id
            from app.accessible_network_memberships anm
            where anm.member_id = $1
              and anm.network_id = $2
              and anm.role = 'owner'
            limit 1
          `,
          [input.actorMemberId, input.networkId],
        );

        if (!ownerScopeResult.rows[0]) {
          await client.query('rollback');
          return null;
        }

        const path = input.path;
        if (path === 'sponsored' && !input.sponsorMemberId) {
          throw new AppError(400, 'invalid_application', 'Sponsored applications require sponsorMemberId');
        }

        const sponsorResult = input.sponsorMemberId
          ? await client.query<{ member_id: string }>(
              `
                select cnm.member_id
                from app.current_network_memberships cnm
                where cnm.network_id = $1
                  and cnm.member_id = $2
                  and cnm.status = 'active'
                limit 1
              `,
              [input.networkId, input.sponsorMemberId],
            )
          : { rows: [] };

        if (input.sponsorMemberId && !sponsorResult.rows[0]) {
          await client.query('rollback');
          return null;
        }

        const membershipResult = input.membershipId
          ? await client.query<{ membership_id: string }>(
              `
                select cnm.id as membership_id
                from app.current_network_memberships cnm
                where cnm.id = $1
                  and cnm.network_id = $2
                  and cnm.member_id = $3
                limit 1
              `,
              [input.membershipId, input.networkId, input.applicantMemberId],
            )
          : { rows: [] };

        if (input.membershipId && !membershipResult.rows[0]) {
          await client.query('rollback');
          return null;
        }

        const applicationResult = await client.query<{ application_id: string }>(
          `
            with inserted as (
              insert into app.applications (
                network_id,
                applicant_member_id,
                sponsor_member_id,
                membership_id,
                path,
                metadata
              )
              select $1, $2, $3, $4, $5, $6::jsonb
              where app.member_is_active($2)
              returning id as application_id
            ), version_insert as (
              insert into app.application_versions (
                application_id,
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
                application_id,
                $7,
                $8,
                $9,
                $10,
                $11,
                $12,
                $13,
                $14,
                1,
                $15
              from inserted
            )
            select application_id
            from inserted
          `,
          [
            input.networkId,
            input.applicantMemberId,
            input.sponsorMemberId ?? null,
            input.membershipId ?? null,
            input.path,
            JSON.stringify(input.metadata ?? {}),
            input.initialStatus,
            input.notes ?? null,
            input.intake.kind ?? (path === 'sponsored' ? 'fit_check' : 'advice_call'),
            input.intake.price?.amount ?? null,
            input.intake.price?.currency ?? 'GBP',
            input.intake.bookingUrl ?? null,
            input.intake.bookedAt ?? null,
            input.intake.completedAt ?? null,
            input.actorMemberId,
          ],
        );

        const applicationId = applicationResult.rows[0]?.application_id;
        if (!applicationId) {
          await client.query('rollback');
          return null;
        }

        await client.query('commit');
        return await withActorContext(pool, input.actorMemberId, [input.networkId], (scopedClient) => readApplicationSummary(scopedClient, applicationId));
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async transitionApplication(input: TransitionApplicationInput): Promise<ApplicationSummary | null> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await applyActorContext(client, input.actorMemberId, input.accessibleNetworkIds);

        const applicationResult = await client.query<{
          application_id: string;
          network_id: string;
          applicant_member_id: string | null;
          current_status: ApplicationStatus;
          current_version_no: number;
          current_version_id: string;
          current_metadata: Record<string, unknown> | null;
          current_intake_kind: 'fit_check' | 'advice_call' | 'other';
          current_intake_price_amount: string | number | null;
          current_intake_price_currency: string | null;
          current_intake_booking_url: string | null;
          current_intake_booked_at: string | null;
          current_intake_completed_at: string | null;
          current_membership_id: string | null;
        }>(
          `
            select
              ca.id as application_id,
              ca.network_id,
              ca.applicant_member_id,
              ca.status as current_status,
              ca.version_no as current_version_no,
              ca.version_id as current_version_id,
              ca.metadata as current_metadata,
              ca.intake_kind as current_intake_kind,
              ca.intake_price_amount as current_intake_price_amount,
              ca.intake_price_currency as current_intake_price_currency,
              ca.intake_booking_url as current_intake_booking_url,
              ca.intake_booked_at::text as current_intake_booked_at,
              ca.intake_completed_at::text as current_intake_completed_at,
              ca.membership_id as current_membership_id
            from app.current_applications ca
            join app.accessible_network_memberships owner_scope
              on owner_scope.network_id = ca.network_id
             and owner_scope.member_id = $1
             and owner_scope.role = 'owner'
            where ca.id = $2
              and ca.network_id = any($3::app.short_id[])
            limit 1
          `,
          [input.actorMemberId, input.applicationId, input.accessibleNetworkIds],
        );

        const application = applicationResult.rows[0];
        if (!application) {
          await client.query('rollback');
          return null;
        }

        if (input.membershipId !== undefined && input.membershipId !== null) {
          const membershipResult = await client.query<{ membership_id: string }>(
            `
              select cnm.id as membership_id
              from app.current_network_memberships cnm
              where cnm.id = $1
                and cnm.network_id = $2
                and cnm.member_id = $3
              limit 1
            `,
            [input.membershipId, application.network_id, application.applicant_member_id],
          );

          if (!membershipResult.rows[0]) {
            await client.query('rollback');
            return null;
          }
        }

        const mergedMetadata = {
          ...(application.current_metadata ?? {}),
          ...(input.metadataPatch ?? {}),
        };

        const resolvedMembershipId = input.membershipId === undefined ? application.current_membership_id : input.membershipId;
        const resolvedCompletedAt = input.intake?.completedAt === undefined ? application.current_intake_completed_at : input.intake.completedAt;

        if (input.activateMembership) {
          if (input.nextStatus !== 'accepted') {
            throw new AppError(409, 'activation_requires_accepted_application', 'Membership activation requires the application status to be accepted');
          }

          if (!resolvedMembershipId) {
            throw new AppError(409, 'activation_requires_membership', 'Membership activation requires a linked membership');
          }

          if (!resolvedCompletedAt) {
            throw new AppError(409, 'activation_requires_completed_interview', 'Membership activation requires interview completion metadata');
          }
        }

        await client.query(
          `
            update app.applications a
            set membership_id = $2,
                metadata = $3::jsonb
            where a.id = $1
          `,
          [application.application_id, resolvedMembershipId, JSON.stringify(mergedMetadata)],
        );

        await client.query(
          `
            insert into app.application_versions (
              application_id,
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
            application.application_id,
            input.nextStatus,
            input.notes ?? null,
            input.intake?.kind ?? application.current_intake_kind,
            input.intake?.price?.amount === undefined ? application.current_intake_price_amount : input.intake.price.amount,
            input.intake?.price?.currency === undefined ? application.current_intake_price_currency : input.intake.price.currency,
            input.intake?.bookingUrl === undefined ? application.current_intake_booking_url : input.intake.bookingUrl,
            input.intake?.bookedAt === undefined ? application.current_intake_booked_at : input.intake.bookedAt,
            resolvedCompletedAt,
            Number(application.current_version_no) + 1,
            application.current_version_id,
            input.actorMemberId,
          ],
        );

        if (input.activateMembership) {
          const membershipResult = await client.query<{
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
              from app.current_network_memberships cnm
              join app.accessible_network_memberships owner_scope
                on owner_scope.network_id = cnm.network_id
               and owner_scope.member_id = $1
               and owner_scope.role = 'owner'
              where cnm.id = $2
                and cnm.network_id = any($3::app.short_id[])
              limit 1
            `,
            [input.actorMemberId, resolvedMembershipId, input.accessibleNetworkIds],
          );

          const membership = membershipResult.rows[0];
          if (!membership) {
            await client.query('rollback');
            return null;
          }

          if (membership.current_status !== 'pending_review') {
            throw new AppError(409, 'membership_not_ready_for_activation', 'Only pending-review memberships can be activated through this flow');
          }

          await client.query(
            `
              insert into app.network_membership_state_versions (
                membership_id,
                status,
                reason,
                version_no,
                supersedes_state_version_id,
                created_by_member_id
              )
              values ($1, 'active', $2, $3, $4, $5)
            `,
            [
              membership.membership_id,
              input.activationReason ?? input.notes ?? 'Activated from accepted application',
              Number(membership.current_version_no) + 1,
              membership.current_state_version_id,
              input.actorMemberId,
            ],
          );
        }

        await client.query('commit');
        return await withActorContext(pool, input.actorMemberId, input.accessibleNetworkIds, (scopedClient) =>
          readApplicationSummary(scopedClient, application.application_id),
        );
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async createColdApplicationChallenge(): Promise<ColdApplicationChallengeResult> {
      const challengeResult = await pool.query<{ challenge_id: string; expires_at: string }>(
        `select challenge_id, expires_at from app.create_cold_application_challenge($1, $2)`,
        [COLD_APPLICATION_DIFFICULTY, COLD_APPLICATION_CHALLENGE_TTL_MS],
      );
      const challenge = requireReturnedRow(challengeResult.rows[0], 'Cold application challenge was not created');

      const expiresAt = Date.parse(challenge.expires_at);
      if (!Number.isFinite(expiresAt)) {
        throw new AppError(500, 'invalid_data', 'Cold application challenge expiry was not returned');
      }

      const networksResult = await pool.query<{ slug: string; name: string; summary: string | null }>(
        `select slug, name, summary from app.list_publicly_listed_networks()`,
      );

      return {
        challengeId: challenge.challenge_id,
        difficulty: COLD_APPLICATION_DIFFICULTY,
        expiresAt: new Date(expiresAt).toISOString(),
        networks: networksResult.rows,
      };
    },

    async solveColdApplicationChallenge(
      input: SolveColdApplicationChallengeInput,
    ): Promise<{ success: boolean } | null> {
      const client = await pool.connect();

      try {
        await client.query('begin');

        const challengeResult = await client.query<{ challenge_id: string; difficulty: number; expires_at: string }>(
          `select challenge_id, difficulty, expires_at from app.get_cold_application_challenge($1)`,
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
            `select app.delete_cold_application_challenge($1)`,
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

        const applicationDetails = JSON.stringify({
          socials: input.socials,
          reason: input.reason,
        });

        const applicationResult = await client.query<{ application_id: string }>(
          `select application_id from app.consume_cold_application_challenge($1, $2, $3, $4, $5::jsonb)`,
          [input.challengeId, input.networkSlug, input.name, input.email, applicationDetails],
        );

        if (!applicationResult.rows[0]) {
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
  };
}
