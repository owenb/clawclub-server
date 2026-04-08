/**
 * Action contracts: events.create, events.list, events.rsvp, events.remove
 */
import { z } from 'zod';
import { AppError } from '../contract.ts';
import {
  wireRequiredString, parseRequiredString,
  wireOptionalString, parseTrimmedNullableString,
  wireOptionalRecord, parseOptionalRecord,
  wireOptionalPositiveInt, parseOptionalPositiveInt,
  eventRsvpState,
  wireCursor, parseCursor, decodeCursor,
  wireLimitOf, parseLimitOf,
} from './fields.ts';
import { eventSummary, membershipSummary } from './responses.ts';
import { registerActions, type ActionDefinition, type HandlerContext, type ActionResult } from './registry.ts';

// ── events.create ────────────────────────────────────────

type EventCreateInput = {
  clubId: string;
  title: string;
  summary: string;
  location: string;
  body: string | null;
  startsAt: string;
  endsAt: string | null;
  timezone: string | null;
  recurrenceRule: string | null;
  capacity: number | null;
  expiresAt: string | null;
  content: Record<string, unknown>;
};

const eventsCreate: ActionDefinition = {
  action: 'events.create',
  domain: 'events',
  description: 'Create a new event.',
  auth: 'member',
  safety: 'mutating',
  authorizationNote: 'Requires club membership. Subject to daily quota.',

  wire: {
    input: z.object({
      clubId: wireRequiredString.describe('Club to create event in'),
      title: wireRequiredString.describe('Event title'),
      summary: wireRequiredString.describe('Event summary'),
      location: wireRequiredString.describe('Event location (e.g. venue name, address, "Google Meet", "Online")'),
      body: wireOptionalString.describe('Extended description (optional)'),
      startsAt: wireRequiredString.describe('ISO 8601 start time'),
      endsAt: wireOptionalString.describe('ISO 8601 end time'),
      timezone: wireOptionalString.describe('IANA timezone (e.g. Europe/London)'),
      recurrenceRule: wireOptionalString.describe('Recurrence rule'),
      capacity: wireOptionalPositiveInt.describe('Max attendees'),
      expiresAt: wireOptionalString.describe('ISO 8601 expiration'),
      content: wireOptionalRecord.describe('Structured metadata'),
      clientKey: wireOptionalString.describe('Idempotency key (scoped per member globally, not per club). Same key + same payload = original event returned. Same key + different club = 409 client_key_conflict.'),
    }),
    output: z.object({ event: eventSummary }),
  },

  parse: {
    input: z.object({
      clubId: parseRequiredString,
      title: parseRequiredString,
      summary: parseRequiredString,
      location: parseRequiredString,
      body: parseTrimmedNullableString.default(null),
      startsAt: parseRequiredString,
      endsAt: parseTrimmedNullableString.default(null),
      timezone: parseTrimmedNullableString.default(null),
      recurrenceRule: parseTrimmedNullableString.default(null),
      capacity: parseOptionalPositiveInt.default(null),
      expiresAt: parseTrimmedNullableString.default(null),
      content: parseOptionalRecord,
      clientKey: parseTrimmedNullableString.default(null),
    }),
  },

  qualityGate: 'events-create',

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { clubId, ...fields } = input as EventCreateInput;
    const club = ctx.requireAccessibleClub(clubId);

    const start = new Date(fields.startsAt);
    if (isNaN(start.getTime())) {
      throw new AppError(400, 'invalid_input', 'startsAt must be a valid ISO 8601 timestamp');
    }
    if (fields.endsAt) {
      const end = new Date(fields.endsAt);
      if (isNaN(end.getTime())) {
        throw new AppError(400, 'invalid_input', 'endsAt must be a valid ISO 8601 timestamp');
      }
      if (end <= start) {
        throw new AppError(400, 'invalid_input', 'endsAt must be after startsAt');
      }
    }

    const event = await ctx.repository.createEvent({
      authorMemberId: ctx.actor.member.id,
      clubId: club.clubId,
      ...fields,
    });

    return {
      data: { event },
      requestScope: { requestedClubId: club.clubId, activeClubIds: [club.clubId] },
    };
  },
};

// ── events.list ──────────────────────────────────────────

type EventListInput = {
  clubId?: string;
  query?: string | null;
  limit: number;
  cursor: string | null;
};

const eventsList: ActionDefinition = {
  action: 'events.list',
  domain: 'events',
  description: 'List upcoming events.',
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
      results: z.array(eventSummary),
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

    const cursor = rawCursor ? (() => {
      const [effectiveAt, entityId] = decodeCursor(rawCursor, 2);
      return { effectiveAt, entityId };
    })() : null;

    const result = await ctx.repository.listEvents({
      actorMemberId: ctx.actor.member.id,
      clubIds,
      limit,
      query: query ?? undefined,
      cursor,
    });

    return {
      data: { query: query ?? null, limit, clubScope, results: result.results, hasMore: result.hasMore, nextCursor: result.nextCursor },
      requestScope: { requestedClubId: clubId ?? null, activeClubIds: clubIds },
    };
  },
};

// ── events.rsvp ──────────────────────────────────────────

type RsvpInput = {
  eventEntityId: string;
  response: 'yes' | 'maybe' | 'no' | 'waitlist';
  note?: string | null;
};

const eventsRsvp: ActionDefinition = {
  action: 'events.rsvp',
  domain: 'events',
  description: 'RSVP to an event.',
  auth: 'member',
  safety: 'mutating',

  wire: {
    input: z.object({
      eventEntityId: wireRequiredString.describe('Event entity ID'),
      response: eventRsvpState.describe('RSVP response'),
      note: wireOptionalString.describe('Optional note'),
    }),
    output: z.object({ event: eventSummary }),
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

    const event = await ctx.repository.rsvpEvent({
      actorMemberId: ctx.actor.member.id,
      eventEntityId,
      response,
      note,
      accessibleMemberships: ctx.actor.memberships.map(m => ({
        membershipId: m.membershipId,
        clubId: m.clubId,
      })),
    });

    if (!event) {
      throw new AppError(404, 'not_found', 'Event not found inside the actor scope');
    }

    return {
      data: { event },
      requestScope: { requestedClubId: event.clubId, activeClubIds: [event.clubId] },
    };
  },
};

// ── events.remove ─────────────────���─────────────────────

const eventsRemove: ActionDefinition = {
  action: 'events.remove',
  domain: 'events',
  description: 'Remove an event (author only).',
  auth: 'member',
  safety: 'mutating',
  authorizationNote: 'Only the original author may remove their own event.',

  wire: {
    input: z.object({
      entityId: wireRequiredString.describe('Event entity ID to remove'),
      reason: wireOptionalString.describe('Reason for removal (optional)'),
    }),
    output: z.object({ event: eventSummary }),
  },

  parse: {
    input: z.object({
      entityId: parseRequiredString,
      reason: parseTrimmedNullableString.default(null),
    }),
  },

  requiredCapability: 'removeEvent',

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { entityId, reason } = input as { entityId: string; reason: string | null };
    ctx.requireCapability('removeEvent');

    const event = await ctx.repository.removeEvent!({
      actorMemberId: ctx.actor.member.id,
      accessibleClubIds: ctx.actor.memberships.map(m => m.clubId),
      entityId,
      reason,
    });

    if (!event) {
      throw new AppError(404, 'not_found', 'Event not found inside the actor scope');
    }

    return {
      data: { event },
      requestScope: { requestedClubId: event.clubId, activeClubIds: [event.clubId] },
    };
  },
};

registerActions([eventsCreate, eventsList, eventsRsvp, eventsRemove]);
