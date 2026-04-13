import { z } from 'zod';
import { wireCursor, parseCursor, wireLimitOf, parseLimitOf, updateReceiptState } from './fields.ts';
import { notificationItem, notificationReceipt } from './responses.ts';
import { registerActions, type ActionDefinition, type HandlerContext, type ActionResult } from './registry.ts';
import { NOTIFICATIONS_PAGE_SIZE } from '../notifications-core.ts';
import { AppError } from '../contract.ts';

const notificationsList: ActionDefinition = {
  action: 'notifications.list',
  domain: 'notifications',
  description: 'List the current member notification worklist in FIFO order.',
  auth: 'member',
  safety: 'read_only',
  notes: [
    'Pagination is oldest-first FIFO by createdAt then notificationId.',
  ],

  wire: {
    input: z.object({
      limit: wireLimitOf(NOTIFICATIONS_PAGE_SIZE),
      after: wireCursor,
    }),
    output: z.object({
      items: z.array(notificationItem),
      nextAfter: z.string().nullable(),
      polledAt: z.string(),
    }),
  },

  parse: {
    input: z.object({
      limit: parseLimitOf(NOTIFICATIONS_PAGE_SIZE, NOTIFICATIONS_PAGE_SIZE),
      after: parseCursor,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { limit, after } = input as { limit: number; after: string | null };
    const accessibleClubIds = ctx.actor.memberships.map((membership) => membership.clubId);
    const adminClubIds = ctx.actor.memberships
      .filter((membership) => membership.role === 'clubadmin')
      .map((membership) => membership.clubId);

    const result = after === null && limit === NOTIFICATIONS_PAGE_SIZE
      ? await ctx.getNotifications()
      : await ctx.repository.listNotifications({
        actorMemberId: ctx.actor.member.id,
        accessibleClubIds,
        adminClubIds,
        limit,
        after,
      });

    return {
      data: {
        items: result.items,
        nextAfter: result.nextAfter,
        polledAt: new Date().toISOString(),
      },
    };
  },
};

const notificationsAcknowledge: ActionDefinition = {
  action: 'notifications.acknowledge',
  domain: 'notifications',
  description: 'Acknowledge one or more materialized notifications.',
  auth: 'member',
  safety: 'mutating',
  businessErrors: [
    {
      code: 'invalid_input',
      meaning: 'One or more notification IDs do not refer to materialized synchronicity notifications.',
      recovery: 'Retry with only notification IDs from acknowledgeable synchronicity items.',
    },
  ],

  wire: {
    input: z.object({
      notificationIds: z.array(z.string().min(1)).min(1),
      state: updateReceiptState.optional(),
      suppressionReason: z.string().nullable().optional(),
    }),
    output: z.object({
      receipts: z.array(notificationReceipt),
    }),
  },

  parse: {
    input: z.object({
      notificationIds: z.array(z.string().trim().min(1)).min(1).transform((ids) => [...new Set(ids)]),
      state: updateReceiptState.optional().default('processed'),
      suppressionReason: z.string().trim().transform((value) => value === '' ? null : value).nullable().optional(),
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { notificationIds, state, suppressionReason } = input as {
      notificationIds: string[];
      state: 'processed' | 'suppressed';
      suppressionReason?: string | null;
    };

    if (notificationIds.some((id) => !id.startsWith('synchronicity.'))) {
      throw new AppError(422, 'invalid_input', 'Only materialized synchronicity notifications can be acknowledged');
    }

    const receipts = await ctx.repository.acknowledgeNotifications({
      actorMemberId: ctx.actor.member.id,
      notificationIds,
      state,
      suppressionReason,
    });

    return {
      data: { receipts },
      acknowledgedNotificationIds: receipts.map((receipt) => receipt.notificationId),
    };
  },
};

registerActions([notificationsList, notificationsAcknowledge]);
