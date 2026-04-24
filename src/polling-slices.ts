import { membershipScopes } from './actors.ts';
import { AppError, type ActivityEvent, type DirectMessageInboxSummary, type IncludedBundle, type NotificationItem, type RequestScope } from './repository.ts';
import { NOTIFICATIONS_PAGE_SIZE } from './notifications-core.ts';
import { decodeCursor, encodeCursor } from './schemas/fields.ts';
import type { HandlerContext } from './schemas/registry.ts';

export type ActivitySliceInput = {
  clubId?: string;
  limit: number;
  cursor: string | null;
};

export type ActivitySliceResult = {
  results: ActivityEvent[];
  hasMore: boolean;
  nextCursor: string;
  requestScope: RequestScope;
};

export type NotificationsSliceInput = {
  limit: number;
  cursor: string | null;
};

export type NotificationsSliceResult = {
  results: NotificationItem[];
  hasMore: boolean;
  nextCursor: string | null;
};

export type InboxSliceInput = {
  limit: number;
  unreadOnly: boolean;
  cursor: string | null;
};

export type InboxSliceResult = {
  limit: number;
  unreadOnly: boolean;
  results: DirectMessageInboxSummary[];
  hasMore: boolean;
  nextCursor: string | null;
  included: IncludedBundle;
};

export function encodeActivityCursor(seq: number): string {
  return encodeCursor([String(seq)]);
}

export function decodeActivityCursor(cursor: string): number {
  const [rawSeq] = decodeCursor(cursor, 1);
  const seq = Number.parseInt(rawSeq, 10);
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new AppError('invalid_input', 'Invalid activity cursor');
  }
  return seq;
}

function resolveActivityMemberships(
  ctx: HandlerContext,
  clubId: string | undefined,
  allowEmptyGlobalScope: boolean,
) {
  if (clubId !== undefined) {
    return ctx.resolveScopedClubs(clubId);
  }
  if (allowEmptyGlobalScope) {
    return ctx.actor.memberships;
  }
  return ctx.resolveScopedClubs(undefined);
}

export async function runActivitySlice(
  ctx: HandlerContext,
  input: ActivitySliceInput,
  options: { allowEmptyGlobalScope?: boolean } = {},
): Promise<ActivitySliceResult> {
  const { clubId, limit, cursor } = input;
  const scopedMemberships = resolveActivityMemberships(ctx, clubId, options.allowEmptyGlobalScope ?? false);
  const { clubIds, adminClubIds, ownerClubIds } = membershipScopes(scopedMemberships);

  const afterSeq = cursor === 'latest'
    ? null
    : cursor === null
      ? clubIds.length === 0 ? null : 0
      : decodeActivityCursor(cursor);

  const result = await ctx.repository.listClubActivity({
    actorMemberId: ctx.actor.member.id,
    clubIds,
    adminClubIds,
    ownerClubIds,
    limit,
    afterSeq,
  });

  return {
    results: result.items,
    hasMore: result.hasMore,
    nextCursor: encodeActivityCursor(result.highWaterMark),
    requestScope: {
      requestedClubId: clubId ?? null,
      activeClubIds: clubIds,
    },
  };
}

export async function runNotificationsSlice(
  ctx: HandlerContext,
  input: NotificationsSliceInput,
): Promise<NotificationsSliceResult> {
  const { limit, cursor } = input;
  const { clubIds: accessibleClubIds, adminClubIds } = membershipScopes(ctx.actor.memberships);

  const result = cursor === null && limit === NOTIFICATIONS_PAGE_SIZE
    ? await ctx.getNotifications()
    : await ctx.repository.listNotifications({
      actorMemberId: ctx.actor.member.id,
      accessibleClubIds,
      adminClubIds,
      limit,
      after: cursor,
    });

  return {
    results: result.items,
    hasMore: result.nextCursor !== null,
    nextCursor: result.nextCursor,
  };
}

export async function runInboxSlice(
  ctx: HandlerContext,
  input: InboxSliceInput,
): Promise<InboxSliceResult> {
  const { limit, unreadOnly, cursor: rawCursor } = input;

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
    limit,
    unreadOnly,
    results: result.results,
    hasMore: result.hasMore,
    nextCursor: result.nextCursor,
    included: result.included,
  };
}
