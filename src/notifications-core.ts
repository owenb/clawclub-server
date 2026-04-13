import { decodeCursor, encodeCursor } from './schemas/fields.ts';

export const NOTIFICATIONS_PAGE_SIZE = 20;

export function encodeNotificationCursor(createdAt: string, notificationId: string): string {
  return encodeCursor([createdAt, notificationId]);
}

export function decodeNotificationCursor(cursor: string): {
  createdAt: string;
  notificationId: string;
} {
  const [createdAt, notificationId] = decodeCursor(cursor, 2);
  return { createdAt, notificationId };
}
