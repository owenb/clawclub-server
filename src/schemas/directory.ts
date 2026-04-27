import { z } from 'zod';
import {
  listDirectoryPage,
  normalizeDirectoryFilter,
  type DirectorySort,
} from '../directory.ts';
import {
  includedMember,
  directoryClubSummary,
} from './responses.ts';
import {
  paginationFields,
  paginatedOutput,
  timestampString,
} from './fields.ts';
import {
  defineInput,
  registerActions,
  type ActionDefinition,
  type ActionResult,
  type ColdHandlerContext,
} from './registry.ts';

const DIRECTORY_LIST_PAGINATION = paginationFields({ defaultLimit: 50, maxLimit: 50 });
const directorySort = z.enum(['newest', 'alphabetical', 'most_popular']);

type DirectoryListInput = {
  cursor: string | null;
  limit: number;
  sort: DirectorySort;
  nameContains?: string;
};

const directoryList: ActionDefinition = {
  action: 'directory.list',
  domain: 'directory',
  description: 'Discover publicly listed clubs. Directory cursors are tied to the current 60-second cache snapshot; restart listing if a cursor expires.',
  auth: 'none',
  scope: { strategy: 'none' },
  safety: 'read_only',
  notes: [
    'This action is anonymous and returns only the opt-in public directory shape. Discovery does not grant access to club content, members, applications, or DMs.',
    'Directory cursors are valid only for the current cached directory snapshot and for the same sort/filter inputs.',
  ],
  input: defineInput({
    wire: z.object({
      ...DIRECTORY_LIST_PAGINATION.wire,
      sort: directorySort.optional().describe('Sort order. Defaults to newest.'),
      nameContains: z.string().min(1).max(120).optional()
        .describe('Case-insensitive substring filter on club name.'),
    }),
    parse: z.object({
      ...DIRECTORY_LIST_PAGINATION.parse,
      sort: directorySort.optional().default('newest'),
      nameContains: z.string().trim().min(1).max(120).optional(),
    }),
  }),
  wire: {
    output: paginatedOutput(directoryClubSummary).extend({
      schemaVersion: z.literal(1),
      directorySchemaHash: z.string(),
      generatedAt: timestampString,
      membersById: z.record(z.string(), includedMember),
    }),
  },

  async handleCold(input: unknown, ctx: ColdHandlerContext): Promise<ActionResult> {
    const parsed = input as DirectoryListInput;
    const entry = await ctx.directoryCache.get();
    const page = listDirectoryPage(entry, {
      cursor: parsed.cursor,
      limit: parsed.limit,
      sort: parsed.sort,
      nameContains: normalizeDirectoryFilter(parsed.nameContains) === ''
        ? null
        : parsed.nameContains,
    });
    return { data: page };
  },
};

registerActions([directoryList]);
