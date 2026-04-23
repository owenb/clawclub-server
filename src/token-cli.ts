import { Pool } from 'pg';
import { createBearerTokenInDb } from './identity/tokens.ts';
import { withTransaction } from './db.ts';
import { toIsoFromMillis } from './timestamps.ts';

type Flags = {
  memberId?: string;
  name?: string;
  label?: string;
  tokenId?: string;
  expiresIn?: string;
  metadata?: Record<string, unknown>;
};

function usage(): never {
  console.error(`usage:
  node --experimental-strip-types src/token-cli.ts create --member <member_id> [--label <label>] [--expires-in <duration>] [--metadata '{"key":"value"}']
  node --experimental-strip-types src/token-cli.ts create --name <public_name> [--label <label>] [--expires-in <duration>] [--metadata '{"key":"value"}']
  node --experimental-strip-types src/token-cli.ts list --member <member_id>
  node --experimental-strip-types src/token-cli.ts list --name <public_name>
  node --experimental-strip-types src/token-cli.ts revoke --member <member_id> --token <token_id>
  node --experimental-strip-types src/token-cli.ts revoke --name <public_name> --token <token_id>`);
  process.exit(1);
}

function parseFlags(argv: string[]): { command: string; flags: Flags } {
  if (argv.length === 0) {
    usage();
  }

  if (!['create', 'list', 'revoke'].includes(argv[0] ?? '')) {
    usage();
  }

  const command = argv[0]!;
  const flags: Flags = {};

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    switch (arg) {
      case '--member':
        flags.memberId = next;
        index += 1;
        break;
      case '--name':
        flags.name = next;
        index += 1;
        break;
      case '--label':
        flags.label = next;
        index += 1;
        break;
      case '--token':
        flags.tokenId = next;
        index += 1;
        break;
      case '--expires-in':
        flags.expiresIn = next;
        index += 1;
        break;
      case '--metadata':
        if (!next) {
          usage();
        }
        try {
          const parsed = JSON.parse(next);
          if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
            throw new Error('metadata must be a JSON object');
          }
          flags.metadata = parsed as Record<string, unknown>;
        } catch (error) {
          console.error(error instanceof Error ? error.message : 'metadata must be valid JSON');
          process.exit(1);
        }
        index += 1;
        break;
      default:
        usage();
    }
  }

  return { command, flags };
}

function requireDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL must be set for this command');
    process.exit(1);
  }
  return databaseUrl;
}

async function resolveMemberId(pool: Pool, flags: Flags): Promise<string> {
  if (flags.memberId) {
    return flags.memberId;
  }

  if (!flags.name) {
    usage();
  }

  const result = await pool.query<{ id: string }>(
    `select id from members where public_name = $1 and state = 'active'`,
    [flags.name],
  );

  if (result.rows.length === 0) {
    console.error(`No active member found with public_name: ${flags.name}`);
    process.exit(1);
  }
  if (result.rows.length > 1) {
    console.error(
      `Multiple active members found with public_name "${flags.name}". ` +
      `public_name is not unique — pass --member <id> instead.`,
    );
    process.exit(1);
  }

  return result.rows[0]!.id;
}

function parseDurationMs(duration: string): number {
  const match = duration.match(/^(\d+)(h|d|m)$/);
  if (!match) {
    console.error('--expires-in must be a duration like 24h, 30d, or 60m');
    process.exit(1);
  }

  const value = Number(match[1]);
  const unit = match[2];
  if (unit === 'm') return value * 60 * 1000;
  if (unit === 'h') return value * 60 * 60 * 1000;
  return value * 24 * 60 * 60 * 1000;
}

async function createToken(pool: Pool, flags: Flags) {
  const memberId = await resolveMemberId(pool, flags);
  const expiresAt = flags.expiresIn
    ? toIsoFromMillis(Date.now() + parseDurationMs(flags.expiresIn))
    : null;
  const token = await withTransaction(pool, (client) => createBearerTokenInDb(client, {
    memberId,
    label: flags.label ?? 'default',
    metadata: flags.metadata ?? {},
    expiresAt,
  }));

  console.log(
    JSON.stringify(
        {
          memberId,
          label: flags.label ?? 'default',
          tokenId: token.token.tokenId,
          bearerToken: token.bearerToken,
        expiresAt,
        metadata: flags.metadata ?? {},
      },
      null,
      2,
    ),
  );
}

async function listTokens(pool: Pool, flags: Flags) {
  const memberId = await resolveMemberId(pool, flags);
  const result = await pool.query(
    `select id as "tokenId", member_id as "memberId", label, created_at as "createdAt", last_used_at as "lastUsedAt", revoked_at as "revokedAt", expires_at as "expiresAt", metadata
     from member_bearer_tokens
     where member_id = $1
     order by created_at desc, id desc`,
    [memberId],
  );

  console.log(JSON.stringify({ memberId, tokens: result.rows }, null, 2));
}

async function revokeToken(pool: Pool, flags: Flags) {
  if (!flags.tokenId) {
    usage();
  }

  const memberId = await resolveMemberId(pool, flags);
  const result = await pool.query(
    `update member_bearer_tokens
     set revoked_at = coalesce(revoked_at, now())
     where id = $1 and member_id = $2
     returning id as "tokenId", member_id as "memberId", label, created_at as "createdAt", last_used_at as "lastUsedAt", revoked_at as "revokedAt", expires_at as "expiresAt", metadata`,
    [flags.tokenId, memberId],
  );

  if (!result.rows[0]) {
    console.error(`No token ${flags.tokenId} found for member ${memberId}`);
    process.exit(1);
  }

  console.log(JSON.stringify({ memberId, token: result.rows[0] }, null, 2));
}

const { command, flags } = parseFlags(process.argv.slice(2));

const pool = new Pool({ connectionString: requireDatabaseUrl() });

try {
  if (command === 'create') {
    await createToken(pool, flags);
  } else if (command === 'list') {
    await listTokens(pool, flags);
  } else if (command === 'revoke') {
    await revokeToken(pool, flags);
  } else {
    usage();
  }
} finally {
  await pool.end();
}
