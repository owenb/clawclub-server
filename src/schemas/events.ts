/**
 * Action contracts: events.list, events.setRsvp
 */
import { z } from 'zod';
import { requestScopeForClub, requestScopeForClubs } from '../actors.ts';
import { AppError } from '../repository.ts';
import {
  describeOptionalScopedClubId,
  wireRequiredString, parseRequiredString,
  wireOptionalString, parseTrimmedNullableString,
  eventRsvpState,
  decodeOptionalCursor,
  paginationFields,
} from './fields.ts';
import { content, eventWithIncluded, membershipSummary, paginatedOutputWithIncluded } from './responses.ts';
import { clubScopedResult, registerActions, type ActionDefinition, type HandlerContext, type ActionResult } from './registry.ts';

type EventListInput = {
  clubId?: string;
  query?: string | null;
  limit: number;
  cursor: string | null;
};

const EVENTS_LIST_PAGINATION = paginationFields({ defaultLimit: 20, maxLimit: 20 });

const eventsList: ActionDefinition = {
  action: 'events.list',
  domain: 'events',
  description: 'List upcoming live events across the actor scope.',
  auth: 'member',
  safety: 'read_only',

  wire: {
    input: z.object({
      clubId: wireRequiredString.optional().describe(describeOptionalScopedClubId('Optional club filter for events.')),
      query: wireOptionalString.describe('Search text'),
      ...EVENTS_LIST_PAGINATION.wire,
    }),
    output: paginatedOutputWithIncluded(content, {
      query: z.string().nullable(),
      limit: z.number(),
      clubScope: z.array(membershipSummary),
    }),
  },

  parse: {
    input: z.object({
      clubId: parseRequiredString.optional(),
      query: parseTrimmedNullableString,
      ...EVENTS_LIST_PAGINATION.parse,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { clubId, query, limit, cursor: rawCursor } = input as EventListInput;
    const clubScope = ctx.resolveScopedClubs(clubId);
    const clubIds = clubScope.map(c => c.clubId);
    const cursor = decodeOptionalCursor(rawCursor, 2, ([startsAt, contentId]) => ({ startsAt, contentId }));

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
        included: result.included,
      },
      requestScope: requestScopeForClubs(clubId ?? null, clubIds),
    };
  },
};

type SetRsvpInput = {
  eventId: string;
  response: 'yes' | 'maybe' | 'no' | 'waitlist' | null;
  note?: string | null;
};

const eventsSetRsvp: ActionDefinition = {
  action: 'events.setRsvp',
  domain: 'events',
  description: 'Create, change, or clear the actor’s RSVP to a specific event. RSVP updates and cancellations close once the event starts and return event_rsvp_closed.',
  auth: 'member',
  safety: 'mutating',
  businessErrors: [
    {
      code: 'invalid_state',
      meaning: 'The target content exists but is not an event.',
      recovery: 'Use events.setRsvp only on content where kind=event.',
    },
  ],

  wire: {
    input: z.object({
      eventId: wireRequiredString.describe('Event content ID'),
      response: eventRsvpState.nullable().describe('RSVP response. Use null to cancel the current RSVP. Use waitlist to opt into the waitlist explicitly; yes auto-waitlists when the event is full.'),
      note: wireOptionalString.describe('Optional note'),
    }),
    output: eventWithIncluded,
  },

  parse: {
    input: z.object({
      eventId: parseRequiredString,
      response: eventRsvpState.nullable(),
      note: parseTrimmedNullableString,
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { eventId, response, note } = input as SetRsvpInput;
    const accessibleMemberships = ctx.actor.memberships.map((membership) => ({
      membershipId: membership.membershipId,
      clubId: membership.clubId,
    }));

    const result = response === null
      ? await ctx.repository.cancelEventRsvp({
          actorMemberId: ctx.actor.member.id,
          eventId,
          accessibleMemberships,
        })
      : await ctx.repository.rsvpEvent({
          actorMemberId: ctx.actor.member.id,
          eventId,
          response,
          note,
          accessibleMemberships,
        });

    if (!result) {
      throw new AppError('event_not_found', 'Event not found inside the actor scope');
    }

    return clubScopedResult(result.event, result);
  },
};

registerActions([eventsList, eventsSetRsvp]);
