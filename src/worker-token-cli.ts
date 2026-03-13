import { Pool } from 'pg';
import { buildBearerToken } from './token.ts';

function parsePostgresTextArray(value: string[] | string | null | undefined): string[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value !== 'string') {
    return [];
  }

  const trimmed = value.trim();
  if (trimmed === '' || trimmed === '{}') {
    return [];
  }

  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return [trimmed];
  }

  return trimmed.slice(1, -1).split(',').filter(Boolean);
}

function usage(): never {
  console.error(`usage:
  node --experimental-strip-types src/worker-token-cli.ts create --member <member_id> --networks <network_id[,network_id...]> [--label <label>] [--metadata '{"key":"value"}']
`);
  process.exit(1);
}

function parseFlags(argv: string[]) {
  const flags: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case 'create':
        flags.command = 'create';
        break;
      case '--member':
      case '--networks':
      case '--label':
      case '--metadata':
        flags[arg.slice(2)] = next;
        index += 1;
        break;
      default:
        usage();
    }
  }
  return flags;
}

function requireDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_MIGRATOR_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL or DATABASE_MIGRATOR_URL must be set for this command');
    process.exit(1);
  }
  return databaseUrl;
}

async function main(argv = process.argv.slice(2)) {
  const flags = parseFlags(argv);
  if (flags.command !== 'create' || !flags.member || !flags.networks) {
    usage();
  }

  const metadata = flags.metadata ? JSON.parse(flags.metadata) : {};
  const allowedNetworkIds = flags.networks.split(',').map((value) => value.trim()).filter(Boolean);
  if (allowedNetworkIds.length === 0) {
    console.error('--networks must include at least one network id');
    process.exit(1);
  }

  const token = buildBearerToken();
  const pool = new Pool({ connectionString: requireDatabaseUrl() });
  try {
    const result = await pool.query(
      `
        insert into app.delivery_worker_tokens (id, actor_member_id, label, token_hash, allowed_network_ids, metadata)
        values ($1, $2, $3, $4, $5::app.short_id[], $6::jsonb)
        returning id, actor_member_id, label, allowed_network_ids, metadata, created_at::text as created_at
      `,
      [token.tokenId, flags.member, flags.label ?? null, token.tokenHash, allowedNetworkIds, JSON.stringify(metadata)],
    );
    const returnedNetworkIds = parsePostgresTextArray(result.rows[0]?.allowed_network_ids);

    console.log(JSON.stringify({
      tokenId: result.rows[0]?.id,
      actorMemberId: result.rows[0]?.actor_member_id,
      label: result.rows[0]?.label ?? null,
      allowedNetworkIds: returnedNetworkIds.length > 0 ? returnedNetworkIds : allowedNetworkIds,
      createdAt: result.rows[0]?.created_at,
      metadata: result.rows[0]?.metadata ?? metadata,
      bearerToken: token.bearerToken,
    }, null, 2));
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
