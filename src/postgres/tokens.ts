import type { Pool } from 'pg';
import {
  AppError,
  type BearerTokenSummary,
  type CreateBearerTokenInput,
  type CreatedBearerToken,
  type Repository,
  type RevokeBearerTokenInput,
} from '../contract.ts';
import { requireReturnedRow } from './query-guards.ts';
import { buildBearerToken } from '../token.ts';
import type { WithActorContext } from './helpers.ts';

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

function mapBearerTokenRow(row: BearerTokenRow): BearerTokenSummary {
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

export function buildTokenRepository({
  pool,
  withActorContext,
}: {
  pool: Pool;
  withActorContext: WithActorContext;
}): Pick<
  Repository,
  | 'listBearerTokens'
  | 'createBearerToken'
  | 'revokeBearerToken'
> {
  return {
    async listBearerTokens({ actorMemberId }: { actorMemberId: string }): Promise<BearerTokenSummary[]> {
      return withActorContext(pool, actorMemberId, [], async (client) => {
        const result = await client.query<BearerTokenRow>(
          `
            select
              mbt.id as token_id,
              mbt.member_id,
              mbt.label,
              mbt.created_at::text as created_at,
              mbt.last_used_at::text as last_used_at,
              mbt.revoked_at::text as revoked_at,
              mbt.expires_at::text as expires_at,
              mbt.metadata
            from app.member_bearer_tokens mbt
            where mbt.member_id = $1
            order by mbt.created_at desc, mbt.id desc
          `,
          [actorMemberId],
        );

        return result.rows.map(mapBearerTokenRow);
      });
    },

    async createBearerToken(input: CreateBearerTokenInput): Promise<CreatedBearerToken> {
      const token = buildBearerToken();
      return withActorContext(pool, input.actorMemberId, [], async (client) => {
        const countResult = await client.query<{ count: string }>(
          `select count(*)::text as count from app.member_bearer_tokens where member_id = $1 and revoked_at is null`,
          [input.actorMemberId],
        );
        if (Number(countResult.rows[0]?.count ?? 0) >= MAX_ACTIVE_TOKENS) {
          throw new AppError(429, 'quota_exceeded', `Maximum ${MAX_ACTIVE_TOKENS} active tokens per member. Revoke unused tokens before creating new ones.`);
        }

        const result = await client.query<BearerTokenRow>(
          `
            insert into app.member_bearer_tokens (id, member_id, label, token_hash, expires_at, metadata)
            values ($1, $2, $3, $4, $5::timestamptz, $6::jsonb)
            returning
              id as token_id,
              member_id,
              label,
              created_at::text as created_at,
              last_used_at::text as last_used_at,
              revoked_at::text as revoked_at,
              expires_at::text as expires_at,
              metadata
          `,
          [token.tokenId, input.actorMemberId, input.label ?? null, token.tokenHash, input.expiresAt ?? null, JSON.stringify(input.metadata ?? {})],
        );

        return {
          token: mapBearerTokenRow(requireReturnedRow(result.rows[0], 'Created bearer token row was not returned')),
          bearerToken: token.bearerToken,
        };
      });
    },

    async revokeBearerToken(input: RevokeBearerTokenInput): Promise<BearerTokenSummary | null> {
      return withActorContext(pool, input.actorMemberId, [], async (client) => {
        const result = await client.query<BearerTokenRow>(
          `
            update app.member_bearer_tokens mbt
            set revoked_at = coalesce(mbt.revoked_at, now())
            where mbt.id = $1
              and mbt.member_id = $2
            returning
              mbt.id as token_id,
              mbt.member_id,
              mbt.label,
              mbt.created_at::text as created_at,
              mbt.last_used_at::text as last_used_at,
              mbt.revoked_at::text as revoked_at,
              mbt.expires_at::text as expires_at,
              mbt.metadata
          `,
          [input.tokenId, input.actorMemberId],
        );

        return result.rows[0] ? mapBearerTokenRow(result.rows[0]) : null;
      });
    },
  };
}
