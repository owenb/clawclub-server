/**
 * Action contracts: updates.list, updates.acknowledge
 */
import { z } from 'zod';
import { AppError } from '../contract.ts';
import {
  wireLimit, parseLimit,
  wireUpdateIds, parseUpdateIds,
  wireOptionalString, parseTrimmedNullableString,
  updateReceiptState,
} from './fields.ts';
import { memberUpdates, updateReceipt } from './responses.ts';
import { registerActions, type ActionDefinition, type HandlerContext, type ActionResult } from './registry.ts';

// ── updates.list ────────────────────────────────────────

type ListInput = {
  after: string | null;
  limit: number;
};

const updatesList: ActionDefinition = {
  action: 'updates.list',
  domain: 'updates',
  description: 'List pending updates for the current member.',
  auth: 'member',
  safety: 'read_only',
  requiredCapability: 'listMemberUpdates',

  wire: {
    input: z.object({
      after: z.string().nullable().optional().describe('Opaque cursor from previous response (null or omit to start from beginning)'),
      limit: wireLimit,
    }),
    output: z.object({ updates: memberUpdates }),
  },

  parse: {
    input: z.object({
      after: z.string().trim().min(1).nullable().optional().default(null),
      limit: parseLimit,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { after: afterRaw, limit } = input as ListInput;
    ctx.requireCapability('listMemberUpdates');

    const clubIds = ctx.actor.memberships.map(m => m.clubId);

    // Resolve 'latest' to the actual cursor so callers can skip backlog
    const after = afterRaw === 'latest' && ctx.repository.getLatestCursor
      ? await ctx.repository.getLatestCursor({ actorMemberId: ctx.actor.member.id, clubIds })
      : afterRaw === 'latest' ? null : afterRaw;

    const updates = await ctx.repository.listMemberUpdates!({
      actorMemberId: ctx.actor.member.id,
      clubIds,
      limit,
      after,
    });

    return { data: { updates } };
  },
};

// ── updates.acknowledge ─────────────────────────────────

type AcknowledgeInput = {
  updateIds: string[];
  state: 'processed' | 'suppressed';
  suppressionReason?: string | null;
};

const updatesAcknowledge: ActionDefinition = {
  action: 'updates.acknowledge',
  domain: 'updates',
  description: 'Acknowledge one or more updates.',
  auth: 'member',
  safety: 'mutating',
  requiredCapability: 'acknowledgeUpdates',

  wire: {
    input: z.object({
      updateIds: wireUpdateIds,
      state: updateReceiptState.optional().describe('Receipt state (default: processed)'),
      suppressionReason: wireOptionalString.describe('Reason for suppression'),
    }),
    output: z.object({ receipts: z.array(updateReceipt) }),
  },

  parse: {
    input: z.object({
      updateIds: parseUpdateIds,
      state: updateReceiptState.optional().default('processed'),
      suppressionReason: parseTrimmedNullableString,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { updateIds, state, suppressionReason } = input as AcknowledgeInput;
    ctx.requireCapability('acknowledgeUpdates');

    // Activity items are cursor-advanced on read, not receipt-acked.
    // Only forward inbox IDs to the receipt system.
    const receipts = await ctx.repository.acknowledgeUpdates!({
      actorMemberId: ctx.actor.member.id,
      updateIds,
      state,
      suppressionReason,
    });

    // Don't require 1:1 matching — activity IDs are silently skipped by the SQL
    // and that's correct. Only fail if zero receipts when some IDs were provided,
    // which would indicate all IDs were invalid (not just activity IDs).
    if (receipts.length === 0 && updateIds.length > 0) {
      throw new AppError(404, 'not_found', 'No inbox updates found for the given IDs');
    }

    return {
      data: { receipts },
      acknowledgedUpdateIds: receipts.map(r => r.updateId),
    };
  },
};

registerActions([updatesList, updatesAcknowledge]);
