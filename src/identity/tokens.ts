/**
 * Identity domain — bearer token management.
 */

import type { Pool } from 'pg';
import { AppError, type BearerTokenSummary, type CreateBearerTokenInput, type CreatedBearerToken, type RevokeBearerTokenInput } from '../contract.ts';
import { buildBearerToken } from '../token.ts';
import { withTransaction } from '../db.ts';

const MAX_ACTIVE_TOKENS = 10;

type BearerTokenRow = {
  token_id: string;
  member_id: string;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  expires_at: string | null;
  metadata: Record<string, unknown> | null;
};

function mapRow(row: BearerTokenRow): BearerTokenSummary {
  return {
    tokenId: row.token_id,
    memberId: row.member_id,
    label: row.label,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    expiresAt: row.expires_at,
    metadata: row.metadata ?? {},
  };
}

const SELECT_COLS = `
  id as token_id,
  member_id,
  label,
  created_at::text as created_at,
  last_used_at::text as last_used_at,
  revoked_at::text as revoked_at,
  expires_at::text as expires_at,
  metadata
`;

export async function listBearerTokens(pool: Pool, actorMemberId: string): Promise<BearerTokenSummary[]> {
  const result = await pool.query<BearerTokenRow>(
    `select ${SELECT_COLS} from member_bearer_tokens
     where member_id = $1
     order by created_at desc, id desc`,
    [actorMemberId],
  );
  return result.rows.map(mapRow);
}

export async function createBearerToken(pool: Pool, input: CreateBearerTokenInput): Promise<CreatedBearerToken> {
  const token = buildBearerToken();
  return withTransaction(pool, async (client) => {
    const countResult = await client.query<{ count: string }>(
      `select count(*)::text as count from member_bearer_tokens where member_id = $1 and revoked_at is null`,
      [input.actorMemberId],
    );
    if (Number(countResult.rows[0]?.count ?? 0) >= MAX_ACTIVE_TOKENS) {
      throw new AppError(429, 'quota_exceeded', `Maximum ${MAX_ACTIVE_TOKENS} active tokens per member. Revoke unused tokens before creating new ones.`);
    }

    const result = await client.query<BearerTokenRow>(
      `insert into member_bearer_tokens (id, member_id, label, token_hash, expires_at, metadata)
       values ($1, $2, $3, $4, $5::timestamptz, $6::jsonb)
       returning ${SELECT_COLS}`,
      [token.tokenId, input.actorMemberId, input.label ?? null, token.tokenHash, input.expiresAt ?? null, JSON.stringify(input.metadata ?? {})],
    );

    const row = result.rows[0];
    if (!row) throw new AppError(500, 'missing_row', 'Created bearer token row was not returned');

    return { token: mapRow(row), bearerToken: token.bearerToken };
  });
}

export async function revokeBearerToken(pool: Pool, input: RevokeBearerTokenInput): Promise<BearerTokenSummary | null> {
  const result = await pool.query<BearerTokenRow>(
    `update member_bearer_tokens
     set revoked_at = coalesce(revoked_at, now())
     where id = $1 and member_id = $2
     returning ${SELECT_COLS}`,
    [input.tokenId, input.actorMemberId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

/**
 * Create a bearer token for a member from an internal issuance path.
 * Unlike createBearerToken, this doesn't enforce quotas — it's an internal operation.
 */
export async function issueTokenForMember(
  pool: Pool,
  memberId: string,
  label: string,
  metadata: Record<string, unknown>,
): Promise<{ bearerToken: string }> {
  const token = buildBearerToken();
  await pool.query(
    `insert into member_bearer_tokens (id, member_id, label, token_hash, metadata)
     values ($1, $2, $3, $4, $5::jsonb)`,
    [token.tokenId, memberId, label, token.tokenHash, JSON.stringify(metadata)],
  );
  return { bearerToken: token.bearerToken };
}
