import type { CoreMessage, LanguageModel, OpenAIProvider } from 'ai';
import { generateClawClubChatText, type ClawClubAiRuntime } from './ai.ts';
import { createPostgresRepository } from './postgres.ts';
import { Pool } from 'pg';

export type ClawClubOperatorTurnOptions = {
  runtime: ClawClubAiRuntime;
  prompt: string;
  system?: string;
  context?: CoreMessage[];
  provider?: OpenAIProvider;
  model?: LanguageModel;
  maxSteps?: number;
};

export type ClawClubOperatorTurnResult = {
  prompt: string;
  text: string;
  messages: CoreMessage[];
};

export async function runClawClubOperatorTurn(options: ClawClubOperatorTurnOptions): Promise<ClawClubOperatorTurnResult> {
  const prompt = options.prompt.trim();
  if (prompt.length === 0) {
    throw new Error('prompt is required');
  }

  const messages: CoreMessage[] = [
    ...(options.context ?? []),
    { role: 'user', content: prompt },
  ];

  const result = await generateClawClubChatText({
    runtime: options.runtime,
    system: options.system,
    messages,
    provider: options.provider,
    model: options.model,
    maxSteps: options.maxSteps ?? 8,
  });

  return {
    prompt,
    text: result.text,
    messages,
  };
}

type CliFlags = {
  bearerToken?: string;
  prompt?: string;
  system?: string;
  maxSteps?: number;
};

function usage(): never {
  console.error(`usage:
  node --experimental-strip-types src/ai-operator.ts --token <bearer_token> --prompt <text> [--system <text>] [--max-steps <n>]

env fallback:
  CLAWCLUB_BEARER_TOKEN can be used instead of --token`);
  process.exit(1);
}

function parseFlags(argv: string[]): CliFlags {
  const flags: CliFlags = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    switch (arg) {
      case '--token':
        flags.bearerToken = next;
        index += 1;
        break;
      case '--prompt':
        flags.prompt = next;
        index += 1;
        break;
      case '--system':
        flags.system = next;
        index += 1;
        break;
      case '--max-steps': {
        const parsed = Number(next);
        if (!Number.isInteger(parsed) || parsed < 1) {
          console.error('--max-steps must be a positive integer');
          process.exit(1);
        }
        flags.maxSteps = parsed;
        index += 1;
        break;
      }
      default:
        usage();
    }
  }

  return flags;
}

function requireBearerToken(flags: CliFlags): string {
  const token = flags.bearerToken ?? process.env.CLAWCLUB_BEARER_TOKEN;
  if (!token) {
    console.error('A bearer token is required via --token or CLAWCLUB_BEARER_TOKEN');
    process.exit(1);
  }
  return token;
}

function requirePrompt(flags: CliFlags): string {
  if (!flags.prompt || flags.prompt.trim().length === 0) {
    console.error('A non-empty --prompt is required');
    process.exit(1);
  }
  return flags.prompt;
}

function requireDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL must be set for this command');
    process.exit(1);
  }
  return databaseUrl;
}

export async function main(argv = process.argv.slice(2)) {
  const flags = parseFlags(argv);
  const pool = new Pool({ connectionString: requireDatabaseUrl() });

  try {
    const result = await runClawClubOperatorTurn({
      runtime: {
        repository: createPostgresRepository({ pool }),
        bearerToken: requireBearerToken(flags),
      },
      prompt: requirePrompt(flags),
      system: flags.system,
      maxSteps: flags.maxSteps,
    });

    console.log(JSON.stringify(result, null, 2));
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
