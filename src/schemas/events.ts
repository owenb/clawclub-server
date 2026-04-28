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
import { contentThread, eventWithIncluded, membershipSummary, paginatedOutputWithIncluded } from './responses.ts';
import { clubScopedResult, defineInput, registerActions, type ActionDefinition, type HandlerContext, type ActionResult } from './registry.ts';

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

  input: defineInput({
    wire: z.object({
      clubId: wireRequiredString.optional().describe(describeOptionalScopedClubId('Optional club filter for events.')),
      query: wireOptionalString.describe('Search text'),
      ...EVENTS_LIST_PAGINATION.wire,
    }),
    parse: z.object({
      clubId: parseRequiredString.optional(),
      query: parseTrimmedNullableString,
      ...EVENTS_LIST_PAGINATION.parse,
    }),
  }),
  wire: {
    output: paginatedOutputWithIncluded(contentThread, {
      query: z.string().nullable(),
      limit: z.number(),
      clubScope: z.array(membershipSummary),
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
  idempotencyStrategy: {
    kind: 'naturallyIdempotent',
    reason: 'RSVP is a set operation for the actor/event pair; repeating the same response leaves one current RSVP row and no extra state transition.',
  },
  businessErrors: [
    {
      code: 'event_not_found',
      meaning: 'The event content was not found inside the actor scope.',
      recovery: 'Refetch events.list or content.get and retry with a current eventId.',
    },
    {
      code: 'invalid_state',
      meaning: 'The target content exists but is not an event.',
      recovery: 'Use events.setRsvp only on content where kind=event.',
    },
    {
      code: 'event_rsvp_closed',
      meaning: 'The event has already started, so RSVP changes are closed.',
      recovery: 'Do not retry automatically. Show the closed state to the member.',
    },
  ],

  input: defineInput({
    wire: z.object({
      eventId: wireRequiredString.describe('Event content ID'),
      response: eventRsvpState.nullable().describe('RSVP response. Use null to cancel the current RSVP. Use waitlist to opt into the waitlist explicitly; yes auto-waitlists when the event is full.'),
      note: wireOptionalString.describe('Optional note'),
    }),
    parse: z.object({
      eventId: parseRequiredString,
      response: eventRsvpState.nullable(),
      note: parseTrimmedNullableString,
    }),
  }),
  wire: {
    output: eventWithIncluded,
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

    return clubScopedResult(result.content, result);
  },
};

registerActions([eventsList, eventsSetRsvp]);
