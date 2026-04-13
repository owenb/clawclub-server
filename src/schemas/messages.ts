/**
 * Action contracts: messages.send, messages.getInbox, messages.getThread, messages.remove
 *
 * DMs are not club-scoped. Clubs are only an eligibility check:
 * two members may DM if they currently share at least one club.
 * Existing threads continue to function even if clubs diverge.
 */
import { z } from 'zod';
import { AppError } from '../contract.ts';
import {
  wireRequiredString, parseRequiredString,
  wireMessageText, parseMessageText,
  wireOptionalString, parseTrimmedNullableString,
  wireOptionalBoolean,
  wireCursor, parseCursor, decodeCursor,
  wireLimitOf, parseLimitOf,
} from './fields.ts';
import {
  directMessageSummary, directMessageThreadSummary,
  directMessageEntry, directMessageInboxSummary,
  includedBundle, messageRemovalResult,
} from './responses.ts';
import { registerActions, type ActionDefinition, type HandlerContext, type ActionResult } from './registry.ts';

// ── messages.send ───────────────────────────────────────

type SendInput = {
  recipientMemberId: string;
  messageText: string;
};

const MESSAGES_SEND_ERRORS = [
  {
    code: 'client_key_conflict',
    meaning: 'The clientKey has already been used for a different conversation or message text.',
    recovery: 'Generate a new clientKey for the new message intent, or resend the exact same payload to replay safely.',
  },
  {
    code: 'invalid_mentions',
    meaning: 'One or more @handle mentions could not be resolved in the current DM scope.',
    recovery: 'Correct or remove the listed mentions, then resend the message.',
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
  ],

  wire: {
    input: z.object({
      recipientMemberId: wireRequiredString.describe('Recipient member ID'),
      messageText: wireMessageText.describe('Message text'),
      clientKey: wireOptionalString.describe('Idempotency key — same key with same payload returns the original message; same key with different payload returns 409 client_key_conflict'),
    }),
    output: z.object({ message: directMessageSummary, included: includedBundle }),
  },

  parse: {
    input: z.object({
      recipientMemberId: parseRequiredString,
      messageText: parseMessageText,
      clientKey: parseTrimmedNullableString.default(null),
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { recipientMemberId, messageText, clientKey } = input as SendInput & { clientKey?: string | null };

    if (recipientMemberId === ctx.actor.member.id) {
      throw new AppError(400, 'invalid_input', 'Cannot send a message to yourself');
    }

    const result = await ctx.repository.sendDirectMessage({
      actorMemberId: ctx.actor.member.id,
      accessibleClubIds: ctx.actor.memberships.map((club) => club.clubId),
      recipientMemberId,
      messageText,
      clientKey,
    });

    if (!result) {
      throw new AppError(404, 'not_found', 'Recipient not found or no shared club with recipient');
    }

    return { data: result };
  },
};

// ── messages.getInbox ───────────────────────────────────

type GetInboxInput = {
  limit: number;
  unreadOnly: boolean;
  cursor: string | null;
};

const messagesGetInbox: ActionDefinition = {
  action: 'messages.getInbox',
  domain: 'messages',
  description: 'List DM inbox with unread counts. Returns all threads regardless of club context.',
  auth: 'member',
  safety: 'read_only',

  wire: {
    input: z.object({
      limit: wireLimitOf(20),
      unreadOnly: wireOptionalBoolean.describe('Only show threads with unread messages'),
      cursor: wireCursor,
    }),
    output: z.object({
      limit: z.number(),
      unreadOnly: z.boolean(),
      results: z.array(directMessageInboxSummary),
      hasMore: z.boolean(),
      nextCursor: z.string().nullable(),
      included: includedBundle,
    }),
  },

  parse: {
    input: z.object({
      limit: parseLimitOf(20, 20),
      unreadOnly: z.boolean().optional().default(false),
      cursor: parseCursor,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { limit, unreadOnly, cursor: rawCursor } = input as GetInboxInput;

    const cursor = rawCursor ? (() => {
      const [latestActivityAt, threadId] = decodeCursor(rawCursor, 2);
      return { latestActivityAt, threadId };
    })() : null;

    const result = await ctx.repository.listDirectMessageInbox({
      actorMemberId: ctx.actor.member.id,
      limit,
      unreadOnly,
      cursor,
    });

    return {
      data: {
        limit,
        unreadOnly,
        results: result.results,
        hasMore: result.hasMore,
        nextCursor: result.nextCursor,
        included: result.included,
      },
    };
  },
};

// ── messages.getThread ──────────────────────────────────

type GetThreadInput = {
  threadId: string;
  limit: number;
  cursor: string | null;
};

const messagesGetThread: ActionDefinition = {
  action: 'messages.getThread',
  domain: 'messages',
  description: 'Read a DM thread. Only participants can read a thread.',
  auth: 'member',
  safety: 'read_only',

  wire: {
    input: z.object({
      threadId: wireRequiredString.describe('Thread ID to read'),
      limit: wireLimitOf(50),
      cursor: wireCursor,
    }),
    output: z.object({
      thread: directMessageThreadSummary,
      messages: z.array(directMessageEntry),
      hasMore: z.boolean(),
      nextCursor: z.string().nullable(),
      included: includedBundle,
    }),
  },

  parse: {
    input: z.object({
      threadId: parseRequiredString,
      limit: parseLimitOf(50, 50),
      cursor: parseCursor,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { threadId, limit, cursor: rawCursor } = input as GetThreadInput;

    const cursor = rawCursor ? (() => {
      const [createdAt, messageId] = decodeCursor(rawCursor, 2);
      return { createdAt, messageId };
    })() : null;

    const result = await ctx.repository.readDirectMessageThread({
      actorMemberId: ctx.actor.member.id,
      threadId,
      limit,
      cursor,
    });

    if (!result) {
      throw new AppError(404, 'not_found', 'Thread not found or not a participant');
    }

    return {
      data: {
        thread: result.thread,
        messages: result.messages,
        hasMore: result.hasMore,
        nextCursor: result.nextCursor,
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
    ctx.requireCapability('removeMessage');

    const result = await ctx.repository.removeMessage!({
      actorMemberId: ctx.actor.member.id,
      accessibleClubIds: ctx.actor.memberships.map((m) => m.clubId),
      messageId,
      reason,
    });

    if (!result) {
      throw new AppError(404, 'not_found', 'Message not found inside the actor scope');
    }

    return { data: { removal: result } };
  },
};

registerActions([messagesSend, messagesGetInbox, messagesGetThread, messagesRemove]);
