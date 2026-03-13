import { tool, generateText, streamText, type CoreMessage, type ToolSet } from 'ai';
import { createOpenAI, type OpenAIProvider } from '@ai-sdk/openai';
import { z } from 'zod';
import { buildApp, type Repository } from './app.ts';

export const CLAWCLUB_OPENAI_MODEL = 'gpt-5.4';

export type ClawClubAiRuntime = {
  repository: Repository;
  bearerToken: string;
};

export type ClawClubChatOptions = {
  runtime: ClawClubAiRuntime;
  system?: string;
  messages: CoreMessage[];
  provider?: OpenAIProvider;
  maxSteps?: number;
};

function nonEmptyString(label: string) {
  return z.string().trim().min(1, `${label} is required`);
}

const canonicalToolSpecs = {
  session_describe: {
    description: 'Resolve the current member session, accessible networks, and any pending delivery context before doing other work.',
    inputSchema: z.object({}),
    action: 'session.describe',
  },
  members_search: {
    description: 'Search for relevant members by name, skill, city, interests, or semantic fit inside the current accessible network scope.',
    inputSchema: z.object({
      query: nonEmptyString('query'),
      networkId: z.string().trim().min(1).optional(),
      limit: z.number().int().min(1).max(20).optional(),
    }),
    action: 'members.search',
  },
  profile_get: {
    description: 'Read a member profile in the shared network scope. Omit memberId to read the current actor profile.',
    inputSchema: z.object({
      memberId: z.string().trim().min(1).optional(),
    }),
    action: 'profile.get',
  },
  profile_update: {
    description: 'Update the current actor profile with a small targeted patch.',
    inputSchema: z.object({
      handle: z.string().trim().min(1).optional().nullable(),
      displayName: z.string().trim().min(1).optional(),
      tagline: z.string().optional().nullable(),
      summary: z.string().optional().nullable(),
      whatIDo: z.string().optional().nullable(),
      knownFor: z.string().optional().nullable(),
      servicesSummary: z.string().optional().nullable(),
      websiteUrl: z.string().optional().nullable(),
      links: z.array(z.unknown()).optional(),
      profile: z.record(z.string(), z.unknown()).optional(),
    }).refine((value) => Object.keys(value).length > 0, 'At least one profile field must be provided'),
    action: 'profile.update',
  },
  entities_list: {
    description: 'List recent posts, asks, opportunities, or services within accessible network scope.',
    inputSchema: z.object({
      networkId: z.string().trim().min(1).optional(),
      kinds: z.array(z.enum(['post', 'opportunity', 'service', 'ask'])).min(1).optional(),
      limit: z.number().int().min(1).max(20).optional(),
    }),
    action: 'entities.list',
  },
  entities_create: {
    description: 'Create a new post, ask, opportunity, or service in one network.',
    inputSchema: z.object({
      networkId: nonEmptyString('networkId'),
      kind: z.enum(['post', 'opportunity', 'service', 'ask']),
      title: z.string().optional().nullable(),
      summary: z.string().optional().nullable(),
      body: z.string().optional().nullable(),
      expiresAt: z.string().optional().nullable(),
      content: z.record(z.string(), z.unknown()).optional(),
    }),
    action: 'entities.create',
  },
  events_list: {
    description: 'List upcoming events in accessible networks.',
    inputSchema: z.object({
      networkId: z.string().trim().min(1).optional(),
      limit: z.number().int().min(1).max(20).optional(),
    }),
    action: 'events.list',
  },
  events_create: {
    description: 'Create an event in one network once the conversational details are clear enough.',
    inputSchema: z.object({
      networkId: nonEmptyString('networkId'),
      title: z.string().optional().nullable(),
      summary: z.string().optional().nullable(),
      body: z.string().optional().nullable(),
      startsAt: z.string().optional().nullable(),
      endsAt: z.string().optional().nullable(),
      timezone: z.string().optional().nullable(),
      recurrenceRule: z.string().optional().nullable(),
      capacity: z.number().int().positive().optional().nullable(),
      expiresAt: z.string().optional().nullable(),
      content: z.record(z.string(), z.unknown()).optional(),
    }),
    action: 'events.create',
  },
  events_rsvp: {
    description: 'RSVP to an event visible in the actor scope.',
    inputSchema: z.object({
      eventEntityId: nonEmptyString('eventEntityId'),
      response: z.enum(['yes', 'maybe', 'no', 'waitlist']),
      note: z.string().optional().nullable(),
    }),
    action: 'events.rsvp',
  },
  messages_inbox: {
    description: 'List recent DM threads, optionally only the unread ones.',
    inputSchema: z.object({
      networkId: z.string().trim().min(1).optional(),
      unreadOnly: z.boolean().optional(),
      limit: z.number().int().min(1).max(20).optional(),
    }),
    action: 'messages.inbox',
  },
  messages_read: {
    description: 'Read a DM thread transcript and delivery receipts.',
    inputSchema: z.object({
      threadId: nonEmptyString('threadId'),
      limit: z.number().int().min(1).max(20).optional(),
    }),
    action: 'messages.read',
  },
  messages_send: {
    description: 'Send a direct message to a member within shared network context.',
    inputSchema: z.object({
      recipientMemberId: nonEmptyString('recipientMemberId'),
      networkId: z.string().trim().min(1).optional(),
      messageText: nonEmptyString('messageText'),
    }),
    action: 'messages.send',
  },
} as const;

export type CanonicalClawClubToolName = keyof typeof canonicalToolSpecs;

export function listCanonicalClawClubTools() {
  return Object.entries(canonicalToolSpecs).map(([name, spec]) => ({
    name,
    description: spec.description,
    action: spec.action,
  }));
}

export function buildClawClubAiTools(runtime: ClawClubAiRuntime): ToolSet {
  const app = buildApp({ repository: runtime.repository });

  return Object.fromEntries(
    Object.entries(canonicalToolSpecs).map(([name, spec]) => [
      name,
      tool({
        description: spec.description,
        inputSchema: spec.inputSchema,
        execute: async (input) => {
          const result = await app.handleAction({
            bearerToken: runtime.bearerToken,
            action: spec.action,
            payload: input,
          });

          return result;
        },
      }),
    ]),
  );
}

export function createClawClubOpenAIProvider(apiKey = process.env.OPENAI_API_KEY) {
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY must be set');
  }

  return createOpenAI({ apiKey });
}

export async function generateClawClubChatText(options: ClawClubChatOptions) {
  const provider = options.provider ?? createClawClubOpenAIProvider();
  return generateText({
    model: provider(CLAWCLUB_OPENAI_MODEL),
    system: options.system,
    messages: options.messages,
    tools: buildClawClubAiTools(options.runtime),
    maxSteps: options.maxSteps ?? 6,
  });
}

export function streamClawClubChatText(options: ClawClubChatOptions) {
  const provider = options.provider ?? createClawClubOpenAIProvider();
  return streamText({
    model: provider(CLAWCLUB_OPENAI_MODEL),
    system: options.system,
    messages: options.messages,
    tools: buildClawClubAiTools(options.runtime),
    maxSteps: options.maxSteps ?? 6,
  });
}
