import type { NotificationItem } from './repository.ts';

export type ResponseNotifications = {
  notifications: NotificationItem[];
  notificationsTruncated: boolean;
};

export type ResponseNotice = {
  code: string;
  message: string;
};
