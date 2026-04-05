/**
 * Action contracts: messages.send, messages.list, messages.read, messages.inbox, messages.remove
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
  membershipSummary, messageRemovalResult,
} from './responses.ts';
import { registerActions, type ActionDefinition, type HandlerContext, type ActionResult } from './registry.ts';

// ── messages.send ───────────────────────────────────────

type SendInput = {
  recipientMemberId: string;
  clubId?: string;
  messageText: string;
};

const messagesSend: ActionDefinition = {
  action: 'messages.send',
  domain: 'messages',
  description: 'Send a direct message to another member.',
  auth: 'member',
  safety: 'mutating',

  wire: {
    input: z.object({
      recipientMemberId: wireRequiredString.describe('Recipient member ID'),
      clubId: wireRequiredString.optional().describe('Restrict to one club'),
      messageText: wireMessageText.describe('Message text'),
    }),
    output: z.object({ message: directMessageSummary }),
  },

  parse: {
    input: z.object({
      recipientMemberId: parseRequiredString,
      clubId: parseRequiredString.optional(),
      messageText: parseMessageText,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { recipientMemberId, clubId, messageText } = input as SendInput;

    if (recipientMemberId === ctx.actor.member.id) {
      throw new AppError(400, 'invalid_input', 'Cannot send a message to yourself');
    }

    const message = await ctx.repository.sendDirectMessage({
      actorMemberId: ctx.actor.member.id,
      accessibleClubIds: ctx.actor.memberships.map((club) => club.clubId),
      recipientMemberId,
      clubId: clubId === undefined ? undefined : ctx.requireAccessibleClub(clubId).clubId,
      messageText,
    });

    if (!message) {
      throw new AppError(404, 'not_found', 'Recipient not found inside the actor scope');
    }

    return {
      data: { message },
      requestScope: { requestedClubId: message.clubId, activeClubIds: [message.clubId] },
    };
  },
};

// ── messages.list ───────────────────────────────────────

type ListInput = {
  clubId?: string;
  limit: number;
};

const messagesList: ActionDefinition = {
  action: 'messages.list',
  domain: 'messages',
  description: 'List DM threads.',
  auth: 'member',
  safety: 'read_only',

  wire: {
    input: z.object({
      clubId: wireRequiredString.optional().describe('Restrict to one club'),
      limit: wireLimit,
    }),
    output: z.object({
      limit: z.number(),
      clubScope: z.array(membershipSummary),
      results: z.array(directMessageThreadSummary),
    }),
  },

  parse: {
    input: z.object({
      clubId: parseRequiredString.optional(),
      limit: parseLimit,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { clubId, limit } = input as ListInput;
    const clubScope = ctx.resolveScopedClubs(clubId);
    const clubIds = clubScope.map((club) => club.clubId);

    const results = await ctx.repository.listDirectMessageThreads({
      actorMemberId: ctx.actor.member.id,
      clubIds,
      limit,
    });

    return {
      data: { limit, clubScope, results },
      requestScope: {
        requestedClubId: clubId ?? null,
        activeClubIds: clubIds,
      },
    };
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
  description: 'Read a DM thread.',
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
      accessibleClubIds: ctx.actor.memberships.map((club) => club.clubId),
      threadId,
      limit,
    });

    if (!result) {
      throw new AppError(404, 'not_found', 'Thread not found inside the actor scope');
    }

    return {
      data: result,
      requestScope: {
        requestedClubId: result.thread.clubId,
        activeClubIds: [result.thread.clubId],
      },
    };
  },
};

// ── messages.inbox ──────────────────────────────────────

type InboxInput = {
  clubId?: string;
  limit: number;
  unreadOnly: boolean;
};

const messagesInbox: ActionDefinition = {
  action: 'messages.inbox',
  domain: 'messages',
  description: 'List DM inbox with unread counts.',
  auth: 'member',
  safety: 'read_only',

  wire: {
    input: z.object({
      clubId: wireRequiredString.optional().describe('Restrict to one club'),
      limit: wireLimit,
      unreadOnly: wireOptionalBoolean.describe('Only show threads with unread messages'),
    }),
    output: z.object({
      limit: z.number(),
      unreadOnly: z.boolean(),
      clubScope: z.array(membershipSummary),
      results: z.array(directMessageInboxSummary),
    }),
  },

  parse: {
    input: z.object({
      clubId: parseRequiredString.optional(),
      limit: parseLimit,
      unreadOnly: z.boolean().optional().default(false),
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { clubId, limit, unreadOnly } = input as InboxInput;
    const clubScope = ctx.resolveScopedClubs(clubId);
    const clubIds = clubScope.map((club) => club.clubId);

    const results = await ctx.repository.listDirectMessageInbox({
      actorMemberId: ctx.actor.member.id,
      clubIds,
      limit,
      unreadOnly,
    });

    return {
      data: { limit, unreadOnly, clubScope, results },
      requestScope: {
        requestedClubId: clubId ?? null,
        activeClubIds: clubIds,
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

    return {
      data: { removal: result },
      requestScope: {
        requestedClubId: result.clubId,
        activeClubIds: [result.clubId],
      },
    };
  },
};

registerActions([messagesSend, messagesList, messagesRead, messagesInbox, messagesRemove]);
