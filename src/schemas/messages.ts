/**
 * Action contracts: messages.send, messages.get, messages.remove
 *
 * DMs are not club-scoped. Clubs are only an eligibility check:
 * two members may DM if they currently share at least one club.
 * Existing threads continue to function even if clubs diverge.
 */
import { z } from 'zod';
import { membershipScopes } from '../actors.ts';
import { AppError } from '../repository.ts';
import {
  describeClientKey,
  wireRequiredString, parseRequiredString,
  wireMessageText, parseMessageText,
  wireOptionalString, parseTrimmedNullableString,
  wireOptionalOpaqueString, parseTrimmedNullableOpaqueString,
  decodeOptionalCursor,
  paginatedOutput,
  paginationFields,
} from './fields.ts';
import {
  directMessageSummary, directMessageThreadSummary,
  directMessageEntry,
  directMessageWithIncluded, includedBundle, messageRemovalResult,
} from './responses.ts';
import { registerActions, type ActionDefinition, type HandlerContext, type ActionResult } from './registry.ts';

// ── messages.send ───────────────────────────────────────

type SendInput = {
  recipientMemberId: string;
  messageText: string;
  clientKey?: string | null;
};

const MESSAGES_SEND_ERRORS = [
  {
    code: 'quota_exceeded',
    meaning: 'The member has reached the rolling DM send quota.',
    recovery: 'Inform the user, check quotas.getUsage for remaining budget, or retry after the oldest usage ages out of the quota window.',
  },
  {
    code: 'client_key_conflict',
    meaning: 'The clientKey has already been used for a different conversation or message text.',
    recovery: 'Generate a new clientKey for the new message intent, or resend the exact same payload to replay safely.',
  },
  {
    code: 'invalid_mentions',
    meaning: 'One or more mention spans points to a member that cannot be resolved as a participant in this DM thread.',
    recovery: 'Read error.details.invalidSpans, remove or correct those mention spans, and retry.',
  },
  {
    code: 'recipient_unavailable',
    meaning: 'The recipient is no longer active on ClawClub (account removed, suspended, or banned).',
    recovery: 'Tell the human the recipient is no longer reachable. Do not retry — the account is gone. Remove them from future send attempts.',
  },
  {
    code: 'account_not_active',
    meaning: 'The caller\'s own account is no longer active and cannot send messages.',
    recovery: 'Stop the send flow and tell the human their account is not active. Contact a club admin or platform operator.',
  },
] as const;

const messagesSend: ActionDefinition = {
  action: 'messages.send',
  domain: 'messages',
  description: 'Send a direct message to another member. Requires at least one shared club, or an existing thread between the participants.',
  auth: 'member',
  safety: 'mutating',
  businessErrors: [...MESSAGES_SEND_ERRORS],
  scopeRules: [
    'DMs are not club-scoped. Do not send clubId when calling messages.send.',
    'A shared club is only required to start a new thread; existing threads remain replyable even if shared clubs later drop to zero.',
  ],
  notes: [
    'clientKey is scoped per sender globally, not per thread.',
    'Sending a reply implicitly marks that thread read for the sender; use updates.acknowledge when you read without replying.',
  ],

  wire: {
    input: z.object({
      recipientMemberId: wireRequiredString.describe('Recipient member ID'),
      messageText: wireMessageText.describe('Message text'),
      clientKey: wireOptionalOpaqueString.describe(describeClientKey('Idempotency key for this direct message send.')),
    }),
    output: directMessageWithIncluded,
  },

  parse: {
    input: z.object({
      recipientMemberId: parseRequiredString,
      messageText: parseMessageText,
      clientKey: parseTrimmedNullableOpaqueString.default(null),
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { recipientMemberId, messageText, clientKey } = input as SendInput;

    if (recipientMemberId === ctx.actor.member.id) {
      throw new AppError('invalid_input', 'Cannot send a message to yourself');
    }

    const result = await ctx.repository.sendDirectMessage({
      actorMemberId: ctx.actor.member.id,
      accessibleClubIds: membershipScopes(ctx.actor.memberships).clubIds,
      recipientMemberId,
      messageText,
      clientKey,
    });

    if (!result) {
      throw new AppError('member_not_found', 'Recipient not found or no shared club with recipient');
    }

    return { data: result };
  },
};

// ── messages.get ──────────────────────────────────

type GetThreadInput = {
  threadId: string;
  limit: number;
  cursor: string | null;
};

const MESSAGES_GET_PAGINATION = paginationFields({ defaultLimit: 50, maxLimit: 50 });

const messagesGetThread: ActionDefinition = {
  action: 'messages.get',
  domain: 'messages',
  description: 'Read a DM thread. Only participants can read a thread.',
  auth: 'member',
  safety: 'read_only',

  wire: {
    input: z.object({
      threadId: wireRequiredString.describe('Thread ID to read'),
      ...MESSAGES_GET_PAGINATION.wire,
    }),
    output: z.object({
      thread: directMessageThreadSummary,
      messages: paginatedOutput(directMessageEntry),
      included: includedBundle,
    }),
  },

  parse: {
    input: z.object({
      threadId: parseRequiredString,
      ...MESSAGES_GET_PAGINATION.parse,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { threadId, limit, cursor: rawCursor } = input as GetThreadInput;

    const cursor = decodeOptionalCursor(rawCursor, 2, ([createdAt, messageId]) => ({ createdAt, messageId }));

    const result = await ctx.repository.readDirectMessageThread({
      actorMemberId: ctx.actor.member.id,
      threadId,
      limit,
      cursor,
    });

    if (!result) {
      throw new AppError('thread_not_found', 'Thread not found or not a participant');
    }

    return {
      data: {
        thread: result.thread,
        messages: {
          results: result.messages,
          hasMore: result.hasMore,
          nextCursor: result.nextCursor,
        },
        included: result.included,
      },
    };
  },
};

// ── messages.remove ─────────────────────────────────────

type RemoveInput = {
  messageId: string;
  reason: string | null;
};

const messagesRemove: ActionDefinition = {
  action: 'messages.remove',
  domain: 'messages',
  description: 'Remove a DM (sender only).',
  auth: 'member',
  safety: 'mutating',
  authorizationNote: 'Only the sender may remove their own message.',
  businessErrors: [
    {
      code: 'message_already_removed',
      meaning: 'The message was already removed with a different reason.',
      recovery: 'Read error.details.removal for the canonical removal and error.details.requestedReason for the rejected retry intent.',
    },
  ],

  wire: {
    input: z.object({
      messageId: wireRequiredString.describe('Message to remove'),
      reason: wireOptionalString.describe('Reason for removal (optional)'),
    }),
    output: z.object({ removal: messageRemovalResult }),
  },

  parse: {
    input: z.object({
      messageId: parseRequiredString,
      reason: parseTrimmedNullableString.default(null),
    }),
  },

  requiredCapability: 'removeMessage',

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { messageId, reason } = input as RemoveInput;

    const result = await ctx.repository.removeMessage!({
      actorMemberId: ctx.actor.member.id,
      accessibleClubIds: membershipScopes(ctx.actor.memberships).clubIds,
      messageId,
      reason,
    });

    if (!result) {
      throw new AppError('message_not_found', 'Message not found inside the actor scope');
    }

    return { data: { removal: result } };
  },
};

registerActions([messagesSend, messagesGetThread, messagesRemove]);
