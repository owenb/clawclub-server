import { membershipScopes, type AuthenticatedActor } from './actors.ts';
import { AppError } from './repository.ts';
import type { NotificationItem, Repository } from './repository.ts';
import { decodeCursor, encodeCursor } from './schemas/fields.ts';

export const NOTIFICATIONS_PAGE_SIZE = 20;

export function encodeNotificationCursor(seq: number): string {
  return encodeCursor([String(seq)]);
}

export function decodeNotificationCursor(cursor: string): number {
  const [rawSeq] = decodeCursor(cursor, 1);
  const seq = Number.parseInt(rawSeq, 10);
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new AppError('invalid_input', 'Invalid notification cursor');
  }
  return seq;
}

export async function fetchNotifications(
  repository: Pick<Repository, 'listNotifications'>,
  actor: AuthenticatedActor,
): Promise<{ items: NotificationItem[]; nextCursor: string | null }> {
  if (typeof repository.listNotifications !== 'function') {
    return { items: [], nextCursor: null };
  }

  const { clubIds: accessibleClubIds, adminClubIds } = membershipScopes(actor.memberships);
  return repository.listNotifications({
    actorMemberId: actor.member.id,
    accessibleClubIds,
    adminClubIds,
    limit: NOTIFICATIONS_PAGE_SIZE,
    after: null,
  });
}
