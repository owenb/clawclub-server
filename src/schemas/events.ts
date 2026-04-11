/**
 * Action contracts: events.list, events.rsvp, events.cancelRsvp
 */
import { z } from 'zod';
import { AppError } from '../contract.ts';
import {
  wireRequiredString, parseRequiredString,
  wireOptionalString, parseTrimmedNullableString,
  eventRsvpState,
  wireCursor, parseCursor, decodeCursor,
  wireLimitOf, parseLimitOf,
} from './fields.ts';
import { contentEntity, membershipSummary } from './responses.ts';
import { registerActions, type ActionDefinition, type HandlerContext, type ActionResult } from './registry.ts';

type EventListInput = {
  clubId?: string;
  query?: string | null;
  limit: number;
  cursor: string | null;
};

const eventsList: ActionDefinition = {
  action: 'events.list',
  domain: 'events',
  description: 'List upcoming live events across the actor scope.',
  auth: 'member',
  safety: 'read_only',

  wire: {
    input: z.object({
      clubId: wireRequiredString.optional().describe('Restrict to one club'),
      query: wireOptionalString.describe('Search text'),
      limit: wireLimitOf(20),
      cursor: wireCursor,
    }),
    output: z.object({
      query: z.string().nullable(),
      limit: z.number(),
      clubScope: z.array(membershipSummary),
      results: z.array(contentEntity),
      hasMore: z.boolean(),
      nextCursor: z.string().nullable(),
    }),
  },

  parse: {
    input: z.object({
      clubId: parseRequiredString.optional(),
      query: parseTrimmedNullableString,
      limit: parseLimitOf(20, 20),
      cursor: parseCursor,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { clubId, query, limit, cursor: rawCursor } = input as EventListInput;
    const clubScope = ctx.resolveScopedClubs(clubId);
    const clubIds = clubScope.map(c => c.clubId);
    const cursor = rawCursor
      ? (() => {
        const [startsAt, entityId] = decodeCursor(rawCursor, 2);
        return { startsAt, entityId };
      })()
      : null;

    const result = await ctx.repository.listEvents({
      actorMemberId: ctx.actor.member.id,
      clubIds,
      limit,
      query: query ?? undefined,
      cursor,
    });

    return {
      data: {
        query: query ?? null,
        limit,
        clubScope,
        results: result.results,
        hasMore: result.hasMore,
        nextCursor: result.nextCursor,
      },
      requestScope: { requestedClubId: clubId ?? null, activeClubIds: clubIds },
    };
  },
};

type RsvpInput = {
  eventEntityId: string;
  response: 'yes' | 'maybe' | 'no' | 'waitlist';
  note?: string | null;
};

const eventsRsvp: ActionDefinition = {
  action: 'events.rsvp',
  domain: 'events',
  description: 'RSVP to a specific event entity.',
  auth: 'member',
  safety: 'mutating',

  wire: {
    input: z.object({
      eventEntityId: wireRequiredString.describe('Event entity ID'),
      response: eventRsvpState.describe('RSVP response'),
      note: wireOptionalString.describe('Optional note'),
    }),
    output: z.object({ entity: contentEntity }),
  },

  parse: {
    input: z.object({
      eventEntityId: parseRequiredString,
      response: eventRsvpState,
      note: parseTrimmedNullableString,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { eventEntityId, response, note } = input as RsvpInput;

    const entity = await ctx.repository.rsvpEvent({
      actorMemberId: ctx.actor.member.id,
      eventEntityId,
      response,
      note,
      accessibleMemberships: ctx.actor.memberships.map(m => ({
        membershipId: m.membershipId,
        clubId: m.clubId,
      })),
    });

    if (!entity) {
      throw new AppError(404, 'not_found', 'Event not found inside the actor scope');
    }

    return {
      data: { entity },
      requestScope: { requestedClubId: entity.clubId, activeClubIds: [entity.clubId] },
    };
  },
};

const eventsCancelRsvp: ActionDefinition = {
  action: 'events.cancelRsvp',
  domain: 'events',
  description: 'Cancel the actor’s current RSVP to an event.',
  auth: 'member',
  safety: 'mutating',

  wire: {
    input: z.object({
      eventEntityId: wireRequiredString.describe('Event entity ID'),
    }),
    output: z.object({ entity: contentEntity }),
  },

  parse: {
    input: z.object({
      eventEntityId: parseRequiredString,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { eventEntityId } = input as { eventEntityId: string };

    const entity = await ctx.repository.cancelEventRsvp({
      actorMemberId: ctx.actor.member.id,
      eventEntityId,
      accessibleMemberships: ctx.actor.memberships.map(m => ({
        membershipId: m.membershipId,
        clubId: m.clubId,
      })),
    });

    if (!entity) {
      throw new AppError(404, 'not_found', 'Event not found inside the actor scope');
    }

    return {
      data: { entity },
      requestScope: { requestedClubId: entity.clubId, activeClubIds: [entity.clubId] },
    };
  },
};

registerActions([eventsList, eventsRsvp, eventsCancelRsvp]);
