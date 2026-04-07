/**
 * Action contracts: messages.send, messages.list, messages.read, messages.inbox, messages.remove
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
  wireLimit, parseLimit,
  wireOptionalBoolean,
} from './fields.ts';
import {
  directMessageSummary, directMessageThreadSummary,
  directMessageEntry, directMessageInboxSummary,
  messageRemovalResult,
} from './responses.ts';
import { registerActions, type ActionDefinition, type HandlerContext, type ActionResult } from './registry.ts';

// ── messages.send ───────────────────────────────────────

type SendInput = {
  recipientMemberId: string;
  messageText: string;
};

const messagesSend: ActionDefinition = {
  action: 'messages.send',
  domain: 'messages',
  description: 'Send a direct message to another member. Requires at least one shared club, or an existing thread between the participants.',
  auth: 'member',
  safety: 'mutating',

  wire: {
    input: z.object({
      recipientMemberId: wireRequiredString.describe('Recipient member ID'),
      messageText: wireMessageText.describe('Message text'),
      clientKey: wireOptionalString.describe('Idempotency key — duplicate sends with the same key return the original message'),
    }),
    output: z.object({ message: directMessageSummary }),
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

    const message = await ctx.repository.sendDirectMessage({
      actorMemberId: ctx.actor.member.id,
      accessibleClubIds: ctx.actor.memberships.map((club) => club.clubId),
      recipientMemberId,
      messageText,
      clientKey,
    });

    if (!message) {
      throw new AppError(404, 'not_found', 'Recipient not found or no shared club with recipient');
    }

    return { data: { message } };
  },
};

// ── messages.list ───────────────────────────────────────

type ListInput = {
  limit: number;
};

const messagesList: ActionDefinition = {
  action: 'messages.list',
  domain: 'messages',
  description: 'List DM threads. Returns all threads regardless of club context.',
  auth: 'member',
  safety: 'read_only',

  wire: {
    input: z.object({
      limit: wireLimit,
    }),
    output: z.object({
      limit: z.number(),
      results: z.array(directMessageThreadSummary),
    }),
  },

  parse: {
    input: z.object({
      limit: parseLimit,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { limit } = input as ListInput;

    const results = await ctx.repository.listDirectMessageThreads({
      actorMemberId: ctx.actor.member.id,
      limit,
    });

    return { data: { limit, results } };
  },
};

// ── messages.read ───────────────────────────────────────

type ReadInput = {
  threadId: string;
  limit: number;
};

const messagesRead: ActionDefinition = {
  action: 'messages.read',
  domain: 'messages',
  description: 'Read a DM thread. Only participants can read a thread.',
  auth: 'member',
  safety: 'read_only',

  wire: {
    input: z.object({
      threadId: wireRequiredString.describe('Thread ID to read'),
      limit: wireLimit,
    }),
    output: z.object({
      thread: directMessageThreadSummary,
      messages: z.array(directMessageEntry),
    }),
  },

  parse: {
    input: z.object({
      threadId: parseRequiredString,
      limit: parseLimit,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { threadId, limit } = input as ReadInput;

    const result = await ctx.repository.readDirectMessageThread({
      actorMemberId: ctx.actor.member.id,
      threadId,
      limit,
    });

    if (!result) {
      throw new AppError(404, 'not_found', 'Thread not found or not a participant');
    }

    return { data: result };
  },
};

// ── messages.inbox ──────────────────────────────────────

type InboxInput = {
  limit: number;
  unreadOnly: boolean;
};

const messagesInbox: ActionDefinition = {
  action: 'messages.inbox',
  domain: 'messages',
  description: 'List DM inbox with unread counts. Returns all threads regardless of club context.',
  auth: 'member',
  safety: 'read_only',

  wire: {
    input: z.object({
      limit: wireLimit,
      unreadOnly: wireOptionalBoolean.describe('Only show threads with unread messages'),
    }),
    output: z.object({
      limit: z.number(),
      unreadOnly: z.boolean(),
      results: z.array(directMessageInboxSummary),
    }),
  },

  parse: {
    input: z.object({
      limit: parseLimit,
      unreadOnly: z.boolean().optional().default(false),
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { limit, unreadOnly } = input as InboxInput;

    const results = await ctx.repository.listDirectMessageInbox({
      actorMemberId: ctx.actor.member.id,
      limit,
      unreadOnly,
    });

    return { data: { limit, unreadOnly, results } };
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

registerActions([messagesSend, messagesList, messagesRead, messagesInbox, messagesRemove]);
