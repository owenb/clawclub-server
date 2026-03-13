import { Pool } from 'pg';
import { buildBearerToken } from './token.ts';

type Flags = {
  memberId?: string;
  handle?: string;
  label?: string;
  tokenId?: string;
  metadata?: Record<string, unknown>;
};

function usage(): never {
  console.error(`usage:
  node --experimental-strip-types src/token-cli.ts create --member <member_id> [--label <label>] [--metadata '{"key":"value"}']
  node --experimental-strip-types src/token-cli.ts create --handle <handle> [--label <label>] [--metadata '{"key":"value"}']
  node --experimental-strip-types src/token-cli.ts list --member <member_id>
  node --experimental-strip-types src/token-cli.ts list --handle <handle>
  node --experimental-strip-types src/token-cli.ts revoke --member <member_id> --token <token_id>
  node --experimental-strip-types src/token-cli.ts revoke --handle <handle> --token <token_id>

legacy fallback:
  node --experimental-strip-types src/token-cli.ts <member_id> [label]`);
  process.exit(1);
}

function parseFlags(argv: string[]): { command: string; flags: Flags } {
  if (argv.length === 0) {
    usage();
  }

  if (!['create', 'list', 'revoke'].includes(argv[0] ?? '')) {
    return {
      command: 'legacy-create',
      flags: {
        memberId: argv[0],
        label: argv[1] ?? 'default',
      },
    };
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
      case '--handle':
        flags.handle = next;
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
  const databaseUrl = process.env.DATABASE_MIGRATOR_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL or DATABASE_MIGRATOR_URL must be set for this command');
    process.exit(1);
  }
  return databaseUrl;
}

async function resolveMemberId(pool: Pool, flags: Flags): Promise<string> {
  if (flags.memberId) {
    return flags.memberId;
  }

  if (!flags.handle) {
    usage();
  }

  const result = await pool.query<{ id: string }>(
    `select app.resolve_active_member_id_by_handle($1) as id`,
    [flags.handle],
  );

  const memberId = result.rows[0]?.id;
  if (!memberId) {
    console.error(`No active member found for handle: ${flags.handle}`);
    process.exit(1);
  }

  return memberId;
}

async function createToken(pool: Pool, flags: Flags) {
  const memberId = await resolveMemberId(pool, flags);
  const token = buildBearerToken();

  await pool.query(
    `insert into app.member_bearer_tokens (id, member_id, label, token_hash, metadata)
     values ($1, $2, $3, $4, $5::jsonb)`,
    [token.tokenId, memberId, flags.label ?? 'default', token.tokenHash, JSON.stringify(flags.metadata ?? {})],
  );

  console.log(
    JSON.stringify(
      {
        memberId,
        label: flags.label ?? 'default',
        tokenId: token.tokenId,
        bearerToken: token.bearerToken,
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
    `select id as "tokenId", member_id as "memberId", label, created_at as "createdAt", last_used_at as "lastUsedAt", revoked_at as "revokedAt", metadata
     from app.member_bearer_tokens
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
    `update app.member_bearer_tokens
     set revoked_at = coalesce(revoked_at, now())
     where id = $1 and member_id = $2
     returning id as "tokenId", member_id as "memberId", label, created_at as "createdAt", last_used_at as "lastUsedAt", revoked_at as "revokedAt", metadata`,
    [flags.tokenId, memberId],
  );

  if (!result.rows[0]) {
    console.error(`No token ${flags.tokenId} found for member ${memberId}`);
    process.exit(1);
  }

  console.log(JSON.stringify({ memberId, token: result.rows[0] }, null, 2));
}

async function legacyCreate(memberId?: string, label = 'default') {
  if (!memberId) {
    usage();
  }

  const token = buildBearerToken();
  console.log(
    JSON.stringify(
      {
        memberId,
        label,
        tokenId: token.tokenId,
        bearerToken: token.bearerToken,
        insertSql:
          'insert into app.member_bearer_tokens (id, member_id, label, token_hash) values ' +
          `('${token.tokenId}', '${memberId}', '${label.replace(/'/g, "''")}', '${token.tokenHash}');`,
      },
      null,
      2,
    ),
  );
}

const { command, flags } = parseFlags(process.argv.slice(2));

if (command === 'legacy-create') {
  await legacyCreate(flags.memberId, flags.label);
  process.exit(0);
}

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
