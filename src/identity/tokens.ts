/**
 * Identity domain — bearer token management.
 */

import type { Pool } from 'pg';
import { AppError, type BearerTokenSummary, type CreateBearerTokenInput, type CreatedBearerToken, type RevokeBearerTokenInput } from '../repository.ts';
import { getConfig } from '../config/index.ts';
import { buildBearerToken } from '../token.ts';
import { withTransaction, type DbClient } from '../db.ts';

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

export async function createBearerTokenInDb(client: DbClient, input: {
  memberId: string;
  label?: string | null;
  expiresAt?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<CreatedBearerToken> {
  const token = buildBearerToken();
  const result = await client.query<BearerTokenRow>(
    `insert into member_bearer_tokens (id, member_id, label, token_hash, expires_at, metadata)
     values ($1, $2, $3, $4, $5::timestamptz, $6::jsonb)
     returning ${SELECT_COLS}`,
    [
      token.tokenId,
      input.memberId,
      input.label ?? null,
      token.tokenHash,
      input.expiresAt ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  );

  const row = result.rows[0];
  if (!row) {
    throw new AppError('missing_row', 'Created bearer token row was not returned');
  }

  return { token: mapRow(row), bearerToken: token.bearerToken };
}

export async function createBearerToken(pool: Pool, input: CreateBearerTokenInput): Promise<CreatedBearerToken> {
  return withTransaction(pool, async (client) => {
    const maxActiveTokens = getConfig().policy.accessTokens.maxActivePerMember;
    const countResult = await client.query<{ count: string }>(
      `select count(*)::text as count
       from member_bearer_tokens
       where member_id = $1
         and revoked_at is null
         and (expires_at is null or expires_at > now())`,
      [input.actorMemberId],
    );
    if (Number(countResult.rows[0]?.count ?? 0) >= maxActiveTokens) {
      throw new AppError('quota_exceeded', `Maximum ${maxActiveTokens} active tokens per member. Revoke unused tokens before creating new ones.`);
    }
    return createBearerTokenInDb(client, {
      memberId: input.actorMemberId,
      label: input.label ?? null,
      expiresAt: input.expiresAt ?? null,
      metadata: input.metadata ?? {},
    });
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
  input: {
    memberId: string;
    label: string;
    metadata: Record<string, unknown>;
    expiresAt?: string | null;
  },
): Promise<{ bearerToken: string }> {
  return withTransaction(pool, async (client) => {
    const created = await createBearerTokenInDb(client, input);
    return { bearerToken: created.bearerToken };
  });
}

/**
 * Superadmin-initiated token minting for an existing member.
 *
 * Used by `superadmin.accessTokens.create` as a recovery/ops path: a
 * superadmin mints a fresh bearer token for an existing active member
 * (typically because the original registration token was lost, or for any
 * other out-of-band operator recovery scenario).
 *
 * Authorization MUST be enforced by the caller — this helper only performs
 * the data-layer operation and does not check for superadmin status. The
 * handler in src/schemas/superadmin.ts calls ctx.requireSuperadmin() first.
 *
 * Safety invariants:
 *   - the target member must exist and have `state = 'active'`, otherwise
 *     returns null and the caller maps that to 404 not_found. Minting
 *     tokens for suspended or removed members is rejected because those
 *     tokens could never authenticate (see readActor in auth.ts).
 *   - every minted token's metadata records the acting superadmin's id,
 *     the reason (if provided), and a `mintedAt` timestamp so any future
 *     audit of `member_bearer_tokens` can reconstruct who issued what.
 *   - the per-member 10-token self-service quota is intentionally NOT
 *     enforced here. This is an ops/recovery path and must not be blocked
 *     by a self-service safety net. The quota is still enforced on the
 *     regular `accessTokens.create` surface.
 */
export async function createBearerTokenAsSuperadmin(
  pool: Pool,
  input: {
    actorMemberId: string;
    memberId: string;
    label?: string | null;
    expiresAt?: string | null;
    reason?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<CreatedBearerToken | null> {
  return withTransaction(pool, async (client) => {
    const existing = await client.query<{ id: string }>(
      `select id from members where id = $1 and state = 'active'`,
      [input.memberId],
    );
    if (existing.rows.length === 0) {
      return null;
    }

    const auditMetadata: Record<string, unknown> = {
      ...(input.metadata ?? {}),
      mintedBy: input.actorMemberId,
      mintedAt: new Date().toISOString(),
      mintedVia: 'superadmin.accessTokens.create',
    };
    if (input.reason !== undefined && input.reason !== null) {
      auditMetadata.reason = input.reason;
    }

    return createBearerTokenInDb(client, {
      memberId: input.memberId,
      label: input.label ?? 'admin-minted',
      expiresAt: input.expiresAt ?? null,
      metadata: auditMetadata,
    });
  });
}
