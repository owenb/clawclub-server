import type { DbClient } from './db.ts';
import { AppError } from './errors.ts';

export type ApplicantBlockKind = 'declined' | 'banned' | 'removed';

type ExistingMembershipRow = {
  membership_id: string;
  club_id: string;
  member_id: string;
  role: string;
  status: string;
  joined_at: string | null;
};

type ApplicantBlockRow = {
  block_kind: ApplicantBlockKind;
  expires_at: string | null;
};

function membershipConflictDetails(membership: ExistingMembershipRow): Record<string, unknown> {
  return {
    membership: {
      membershipId: membership.membership_id,
      clubId: membership.club_id,
      memberId: membership.member_id,
      role: membership.role,
      status: membership.status,
      joinedAt: membership.joined_at,
    },
  };
}

async function readExistingMembershipForApplication(
  client: DbClient,
  input: { clubId: string; memberId: string },
): Promise<ExistingMembershipRow | null> {
  const result = await client.query<ExistingMembershipRow>(
    `select id as membership_id,
            club_id,
            member_id,
            role::text,
            status::text,
            joined_at::text
       from current_club_memberships
      where club_id = $1
        and member_id = $2
        and status in ('active', 'cancelled')
      limit 1`,
    [input.clubId, input.memberId],
  );
  return result.rows[0] ?? null;
}

async function readActiveApplicantBlock(
  client: DbClient,
  input: { clubId: string; memberId: string },
): Promise<ApplicantBlockRow | null> {
  const result = await client.query<ApplicantBlockRow>(
    `select block_kind,
            expires_at::text
       from club_applicant_blocks
      where club_id = $1
        and member_id = $2
        and (expires_at is null or expires_at > now())
      order by created_at desc, id desc
      limit 1`,
    [input.clubId, input.memberId],
  );
  return result.rows[0] ?? null;
}

function formatApplicationBlockExpiresAt(expiresAt: string): string {
  const parsed = new Date(expiresAt);
  if (Number.isNaN(parsed.getTime())) return expiresAt;
  return parsed.toISOString();
}

export async function assertCanApplyToClub(
  client: DbClient,
  input: { clubId: string; memberId: string },
): Promise<void> {
  const membership = await readExistingMembershipForApplication(client, input);
  if (membership?.status === 'active') {
    throw new AppError('member_already_active', 'This member already has an active membership in the club.', {
      details: membershipConflictDetails(membership),
    });
  }

  const block = await readActiveApplicantBlock(client, input);
  if (!block) return;

  const duration = block.expires_at ? ` until ${formatApplicationBlockExpiresAt(block.expires_at)}` : '';
  throw new AppError('application_blocked', `You cannot apply to this club after being ${block.block_kind}${duration}.`);
}

export async function writeApplicantBlock(client: DbClient, input: {
  clubId: string;
  memberId: string;
  blockKind: ApplicantBlockKind;
  source: string;
  expiresInDays?: number | null;
  creatorMemberId?: string | null;
  reason?: string | null;
}): Promise<void> {
  await client.query(
    `insert into club_applicant_blocks (
       club_id,
       member_id,
       block_kind,
       expires_at,
       source,
       created_by_member_id,
       reason
     )
     values (
       $1,
       $2,
       $3,
       case when $4::int is null then null else now() + ($4::int * interval '1 day') end,
       $5,
       $6,
       $7
     )
     on conflict (club_id, member_id, block_kind) do update
       set created_at = now(),
           expires_at = excluded.expires_at,
           source = excluded.source,
           created_by_member_id = excluded.created_by_member_id,
           reason = excluded.reason`,
    [
      input.clubId,
      input.memberId,
      input.blockKind,
      input.expiresInDays ?? null,
      input.source,
      input.creatorMemberId ?? null,
      input.reason ?? null,
    ],
  );
}
