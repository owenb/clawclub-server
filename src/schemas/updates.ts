import { z } from 'zod';
import { AppError } from '../errors.ts';
import {
  describeOptionalScopedClubId,
  wireRequiredString,
  parseRequiredString,
  wireCursor,
  parseCursor,
  wireLimitOf,
  parseLimitOf,
  wireOptionalBoolean,
  paginatedOutput,
  timestampString,
} from './fields.ts';
import {
  activityEvent,
  notificationItem,
  notificationReceipt,
  directMessageInboxSummary,
  includedBundle,
} from './responses.ts';
import { registerActions, type ActionDefinition, type HandlerContext, type ActionResult } from './registry.ts';
import { NOTIFICATIONS_PAGE_SIZE } from '../notifications-core.ts';
import { toIsoNow } from '../timestamps.ts';
import {
  runActivitySlice,
  runInboxSlice,
  runNotificationsSlice,
  type ActivitySliceInput,
  type InboxSliceInput,
  type NotificationsSliceInput,
} from '../polling-slices.ts';

type UpdatesListInput = {
  clubId?: string;
  activity: Omit<ActivitySliceInput, 'clubId'>;
  notifications: NotificationsSliceInput;
  inbox: InboxSliceInput;
};

const updatesList: ActionDefinition = {
  action: 'updates.list',
  domain: 'updates',
  description: 'Preferred one-call polling surface for activity, notifications, and DM inbox summaries.',
  auth: 'member',
  safety: 'read_only',
  skipNotificationsInResponse: true,
  notes: [
    'Use this for the general "has anything happened?" poll path.',
    'The activity slice supports after="latest" to seed from the current activity tip.',
    'Activity nextCursor is a stable resume cursor: when hasMore is false, keep that cursor and poll again later instead of discarding it.',
    'The inbox slice defaults to unreadOnly=true so the DM part answers "anything I need to know?" by default.',
  ],

  wire: {
    input: z.object({
      clubId: wireRequiredString.optional().describe(describeOptionalScopedClubId('Optional club scope for the activity slice only. Notifications and inbox remain personal.')),
      activity: z.object({
        limit: wireLimitOf(20),
        after: wireCursor.describe('Opaque activity cursor from a previous response, or "latest" to seed from the current activity tip. Reuse the returned cursor even when hasMore is false.'),
      }).optional(),
      notifications: z.object({
        limit: wireLimitOf(NOTIFICATIONS_PAGE_SIZE),
        after: wireCursor,
      }).optional(),
      inbox: z.object({
        limit: wireLimitOf(20),
        unreadOnly: wireOptionalBoolean.describe('Only show threads with unread messages. Defaults to true on updates.list.'),
        cursor: wireCursor,
      }).optional(),
    }),
    output: z.object({
      activity: paginatedOutput(activityEvent).extend({
        nextCursor: z.string().describe('Stable activity resume cursor. Always present; reuse it on the next poll even when hasMore is false.'),
      }),
      notifications: paginatedOutput(notificationItem),
      inbox: paginatedOutput(directMessageInboxSummary).extend({
        limit: z.number(),
        unreadOnly: z.boolean(),
        included: includedBundle,
      }),
      polledAt: timestampString,
    }),
  },

  parse: {
    input: z.object({
      clubId: parseRequiredString.optional(),
      activity: z.object({
        limit: parseLimitOf(20, 20),
        after: parseCursor,
      }).optional().default({ limit: 20, after: null }),
      notifications: z.object({
        limit: parseLimitOf(NOTIFICATIONS_PAGE_SIZE, NOTIFICATIONS_PAGE_SIZE),
        after: parseCursor,
      }).optional().default({ limit: NOTIFICATIONS_PAGE_SIZE, after: null }),
      inbox: z.object({
        limit: parseLimitOf(20, 20),
        unreadOnly: z.boolean().optional().default(true),
        cursor: parseCursor,
      }).optional().default({ limit: 20, unreadOnly: true, cursor: null }),
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const {
      clubId,
      activity,
      notifications,
      inbox,
    } = input as UpdatesListInput;

    const [activityResult, notificationsResult, inboxResult] = await Promise.all([
      runActivitySlice(ctx, { clubId, ...activity }, { allowEmptyGlobalScope: true }),
      runNotificationsSlice(ctx, notifications),
      runInboxSlice(ctx, inbox),
    ]);

    return {
      data: {
        activity: {
          results: activityResult.results,
          hasMore: activityResult.hasMore,
          nextCursor: activityResult.nextCursor,
        },
        notifications: {
          results: notificationsResult.results,
          hasMore: notificationsResult.hasMore,
          nextCursor: notificationsResult.nextCursor,
        },
        inbox: {
          limit: inbox.limit,
          unreadOnly: inbox.unreadOnly,
          results: inboxResult.results,
          hasMore: inboxResult.hasMore,
          nextCursor: inboxResult.nextCursor,
          included: inboxResult.included,
        },
        polledAt: toIsoNow(),
      },
      requestScope: activityResult.requestScope,
    };
  },
};

const updatesAcknowledge: ActionDefinition = {
  action: 'updates.acknowledge',
  domain: 'updates',
  description: 'Acknowledge notifications or mark a DM thread read.',
  auth: 'member',
  safety: 'mutating',
  scopeRules: [
    'Use target.kind=notification to acknowledge notifications from the personal queue.',
    'Use target.kind=thread to mark a DM thread read without replying.',
  ],
  wire: {
    input: z.object({
      target: z.discriminatedUnion('kind', [
        z.object({
          kind: z.literal('notification'),
          notificationIds: z.array(z.string().min(1)).min(1),
        }),
        z.object({
          kind: z.literal('thread'),
          threadId: wireRequiredString.describe('Thread to mark as read'),
        }),
      ]),
    }),
    output: z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('notification'),
        receipts: z.array(notificationReceipt),
      }),
      z.object({
        kind: z.literal('thread'),
        threadId: z.string(),
        acknowledgedCount: z.number(),
      }),
    ]),
  },
  parse: {
    input: z.object({
      target: z.discriminatedUnion('kind', [
        z.object({
          kind: z.literal('notification'),
          notificationIds: z.array(z.string().trim().min(1)).min(1).transform((ids) => [...new Set(ids)]),
        }),
        z.object({
          kind: z.literal('thread'),
          threadId: parseRequiredString,
        }),
      ]),
    }),
  },
  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { target } = input as {
      target:
        | { kind: 'notification'; notificationIds: string[] }
        | { kind: 'thread'; threadId: string };
    };

    if (target.kind === 'notification') {
      const receipts = await ctx.repository.acknowledgeNotifications({
        actorMemberId: ctx.actor.member.id,
        notificationIds: target.notificationIds,
      });
      return {
        data: { kind: 'notification', receipts },
        acknowledgedNotificationIds: receipts.map((receipt) => receipt.notificationId),
      };
    }

    const result = await ctx.repository.acknowledgeDirectMessageInbox({
      actorMemberId: ctx.actor.member.id,
      threadId: target.threadId,
    });
    if (!result) {
      throw new AppError('thread_not_found', 'Thread not found inside the actor scope');
    }
    return { data: { kind: 'thread', threadId: result.threadId, acknowledgedCount: result.acknowledgedCount } };
  },
};

registerActions([updatesList, updatesAcknowledge]);
