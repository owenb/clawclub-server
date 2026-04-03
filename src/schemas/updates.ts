/**
 * Action contracts: updates.list, updates.acknowledge
 */
import { z } from 'zod';
import { AppError } from '../app.ts';
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
  after: number | null;
  limit: number;
};

const updatesList: ActionDefinition = {
  action: 'updates.list',
  domain: 'updates',
  description: 'List pending updates for the current member.',
  auth: 'member',
  safety: 'read_only',
  aiExposed: false,

  requiredCapability: 'listMemberUpdates',

  wire: {
    input: z.object({
      after: z.number().int().nullable().optional().describe('Stream sequence cursor (null or omit to start from beginning)'),
      limit: wireLimit,
    }),
    output: z.object({ updates: memberUpdates }),
  },

  parse: {
    input: z.object({
      after: z.number().int().nullable().optional().default(null),
      limit: parseLimit,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { after, limit } = input as ListInput;
    ctx.requireCapability('listMemberUpdates');

    const updates = await ctx.repository.listMemberUpdates!({
      actorMemberId: ctx.actor.member.id,
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
  aiExposed: false,

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

    const receipts = await ctx.repository.acknowledgeUpdates!({
      actorMemberId: ctx.actor.member.id,
      updateIds,
      state,
      suppressionReason,
    });

    if (receipts.length !== updateIds.length) {
      throw new AppError(404, 'not_found', 'One or more updates were not found inside the actor scope');
    }

    return {
      data: { receipts },
      acknowledgedUpdateIds: receipts.map(r => r.updateId),
    };
  },
};

registerActions([updatesList, updatesAcknowledge]);
