import { createHash } from 'node:crypto';
import type { DbClient } from './db.ts';
import { AppError } from './errors.ts';

export const NOTIFICATION_REF_KINDS = [
  'member',
  'club',
  'content',
  'dm_thread',
  'membership',
  'application',
  'invitation',
  'subscription',
  'support_request',
] as const;

export type NotificationRefKind = typeof NOTIFICATION_REF_KINDS[number];
export type NotificationDeliveryClass = 'transactional' | 'informational' | 'suggestion';
export type NotificationProducerStatus = 'active' | 'disabled';
export type NotificationTopicStatus = 'active' | 'disabled';

export type NotificationRefInput = {
  role: string;
  kind: NotificationRefKind;
  id: string;
};

export type DeliverNotificationInput = {
  producerId: string;
  topic: string;
  recipientMemberId: string;
  clubId?: string | null;
  payload: Record<string, unknown>;
  payloadVersion: number;
  idempotencyKey?: string | null;
  expiresAt?: string | null;
  refs?: NotificationRefInput[];
};

export type DeliverNotificationOutcome =
  | 'delivered'
  | 'duplicate'
  | 'idempotency_key_mismatch'
  | 'expired'
  | 'rate_limited'
  | 'producer_disabled'
  | 'topic_disabled'
  | 'topic_not_registered'
  | 'topic_namespace_mismatch'
  | 'recipient_not_found'
  | 'recipient_not_accessible_in_club'
  | 'invalid_ref'
  | 'ref_club_mismatch';

export type DeliverNotificationResult = {
  index: number;
  outcome: DeliverNotificationOutcome;
  notificationId: string | null;
};

export type CoreDeliverNotificationInput = Omit<DeliverNotificationInput, 'producerId'>;

export type AcknowledgedNotificationRecord = {
  id: string;
  acknowledgedAt: string;
};

export type ProducerAcknowledgeOutcome =
  | 'acknowledged'
  | 'already_acknowledged'
  | 'not_found';

export type ProducerAcknowledgeResult = {
  notificationId: string;
  outcome: ProducerAcknowledgeOutcome;
  acknowledgedAt: string | null;
};

export type AutoAcknowledgeMatch = {
  ref?: {
    kind: NotificationRefKind;
    id: string;
    role?: string;
  };
  payloadFields?: Record<string, string>;
};

export type AutoAcknowledgeSelector = {
  recipientMemberId?: string;
  producerId?: string;
  topic?: string;
  clubId?: string | null;
  matchesAny?: readonly AutoAcknowledgeMatch[];
};

type ProducerRow = {
  producerId: string;
  status: NotificationProducerStatus;
  namespacePrefix: string;
  burstLimit: number | null;
  hourlyLimit: number | null;
  dailyLimit: number | null;
};

type TopicRow = {
  producerId: string;
  topic: string;
  status: NotificationTopicStatus;
  deliveryClass: NotificationDeliveryClass;
};

type CounterWindowKind = 'burst' | 'hour' | 'day';

type RefLookup = {
  existingIds: Set<string>;
  clubById: Map<string, string | null>;
};

type PreparedNotification = {
  index: number;
  producerId: string;
  topic: string;
  recipientMemberId: string;
  clubId: string | null;
  payload: Record<string, unknown>;
  payloadVersion: number;
  idempotencyKey: string | null;
  requestFingerprint: string | null;
  expiresAt: string | null;
  refs: NotificationRefInput[];
};

const REF_KINDS_WITH_CLUB_CONTEXT = new Set<NotificationRefKind>([
  'club',
  'content',
  'dm_thread',
  'membership',
  'application',
  'invitation',
  'subscription',
]);

const BURST_WINDOW_MS = 10_000;

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortKeysDeep(record[key]);
    }
    return sorted;
  }
  return value;
}

function normalizeText(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new AppError('invalid_input', `${field} must not be empty.`);
  }
  return normalized;
}

function normalizeExpiresAt(expiresAt: string | null | undefined): string | null {
  if (expiresAt === null || expiresAt === undefined) {
    return null;
  }
  const parsed = new Date(expiresAt);
  if (Number.isNaN(parsed.valueOf())) {
    throw new AppError('invalid_input', 'expiresAt must be a valid timestamp.');
  }
  return parsed.toISOString();
}

function normalizeOptionalText(value: string | null | undefined, field: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return normalizeText(value, field);
}

function normalizeRefs(refs: readonly NotificationRefInput[] | undefined): NotificationRefInput[] {
  if (!refs || refs.length === 0) {
    return [];
  }

  const deduped = new Map<string, NotificationRefInput>();
  for (const ref of refs) {
    if (!NOTIFICATION_REF_KINDS.includes(ref.kind)) {
      throw new AppError('invalid_input', `Unsupported notification ref kind: ${ref.kind}`);
    }
    const normalized = {
      role: normalizeText(ref.role, 'Notification ref role'),
      kind: ref.kind,
      id: normalizeText(ref.id, 'Notification ref id'),
    } satisfies NotificationRefInput;
    deduped.set([normalized.role, normalized.kind, normalized.id].join('\u0000'), normalized);
  }

  return [...deduped.values()].sort((a, b) => {
    if (a.role !== b.role) {
      return a.role.localeCompare(b.role);
    }
    if (a.kind !== b.kind) {
      return a.kind.localeCompare(b.kind);
    }
    return a.id.localeCompare(b.id);
  });
}

function buildFingerprintPayload(input: {
  topic: string;
  recipientMemberId: string;
  clubId: string | null;
  payloadVersion: number;
  payload: Record<string, unknown>;
  expiresAt: string | null;
  refs: NotificationRefInput[];
}) {
  return {
    topic: input.topic,
    recipientMemberId: input.recipientMemberId,
    clubId: input.clubId,
    payloadVersion: input.payloadVersion,
    payload: sortKeysDeep(input.payload),
    expiresAt: input.expiresAt,
    refs: input.refs.map((ref) => ({
      role: ref.role,
      kind: ref.kind,
      id: ref.id,
    })),
  };
}

export function createNotificationRequestFingerprint(input: {
  topic: string;
  recipientMemberId: string;
  clubId?: string | null;
  payloadVersion: number;
  payload: Record<string, unknown>;
  expiresAt?: string | null;
  refs?: readonly NotificationRefInput[];
}): string {
  if (!Number.isInteger(input.payloadVersion) || input.payloadVersion < 1) {
    throw new AppError('invalid_input', 'payloadVersion must be an integer >= 1.');
  }

  const payload = buildFingerprintPayload({
    topic: normalizeText(input.topic, 'Notification topic'),
    recipientMemberId: normalizeText(input.recipientMemberId, 'Recipient member ID'),
    clubId: input.clubId ?? null,
    payloadVersion: input.payloadVersion,
    payload: sortKeysDeep(input.payload) as Record<string, unknown>,
    expiresAt: normalizeExpiresAt(input.expiresAt),
    refs: normalizeRefs(input.refs),
  });

  return createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
}

function notificationTopicKey(producerId: string, topic: string): string {
  return `${producerId}\u0000${topic}`;
}

async function loadProducerTopicMaps(
  client: DbClient,
  notifications: readonly Pick<PreparedNotification, 'producerId' | 'topic'>[],
): Promise<{
  producersById: Map<string, ProducerRow>;
  topicsByKey: Map<string, TopicRow>;
}> {
  const producerIds = [...new Set(notifications.map((notification) => notification.producerId))];
  if (producerIds.length === 0) {
    return {
      producersById: new Map(),
      topicsByKey: new Map(),
    };
  }

  const topics = [...new Set(notifications.map((notification) => notification.topic))];
  const result = await client.query<{
    producer_id: string;
    producer_status: NotificationProducerStatus;
    namespace_prefix: string;
    burst_limit: number | null;
    hourly_limit: number | null;
    daily_limit: number | null;
    topic: string | null;
    topic_status: NotificationTopicStatus | null;
    delivery_class: NotificationDeliveryClass | null;
  }>(
    `select p.producer_id,
            p.status as producer_status,
            p.namespace_prefix,
            p.burst_limit,
            p.hourly_limit,
            p.daily_limit,
            t.topic,
            t.status as topic_status,
            t.delivery_class
       from notification_producers p
       left join notification_producer_topics t
         on t.producer_id = p.producer_id
        and t.topic = any($2::text[])
      where p.producer_id = any($1::text[])`,
    [producerIds, topics],
  );

  const producersById = new Map<string, ProducerRow>();
  const topicsByKey = new Map<string, TopicRow>();
  for (const row of result.rows) {
    producersById.set(row.producer_id, {
      producerId: row.producer_id,
      status: row.producer_status,
      namespacePrefix: row.namespace_prefix,
      burstLimit: row.burst_limit,
      hourlyLimit: row.hourly_limit,
      dailyLimit: row.daily_limit,
    });
    if (row.topic) {
      topicsByKey.set(notificationTopicKey(row.producer_id, row.topic), {
        producerId: row.producer_id,
        topic: row.topic,
        status: row.topic_status ?? 'disabled',
        deliveryClass: row.delivery_class ?? 'informational',
      });
    }
  }

  return { producersById, topicsByKey };
}

async function loadRecipientMaps(
  client: DbClient,
  notifications: readonly Pick<PreparedNotification, 'recipientMemberId' | 'clubId'>[],
): Promise<{
  knownRecipients: Set<string>;
  accessibleClubPairs: Set<string>;
}> {
  const recipientIds = [...new Set(notifications.map((notification) => notification.recipientMemberId))];
  const knownRecipients = new Set<string>();
  const accessibleClubPairs = new Set<string>();

  if (recipientIds.length === 0) {
    return { knownRecipients, accessibleClubPairs };
  }

  const recipientsResult = await client.query<{ id: string }>(
    `select id from members where id = any($1::text[])`,
    [recipientIds],
  );
  for (const row of recipientsResult.rows) {
    knownRecipients.add(row.id);
  }

  const clubIds = [...new Set(
    notifications
      .map((notification) => notification.clubId ?? null)
      .filter((clubId): clubId is string => clubId !== null),
  )];
  if (clubIds.length === 0) {
    return { knownRecipients, accessibleClubPairs };
  }

  const membershipResult = await client.query<{ member_id: string; club_id: string }>(
    `select member_id, club_id
       from club_memberships
      where status = 'active'
        and member_id = any($1::text[])
        and club_id = any($2::text[])`,
    [recipientIds, clubIds],
  );
  for (const row of membershipResult.rows) {
    accessibleClubPairs.add(`${row.member_id}\u0000${row.club_id}`);
  }

  return { knownRecipients, accessibleClubPairs };
}

async function loadRefLookup(client: DbClient, kind: NotificationRefKind, ids: string[]): Promise<RefLookup> {
  const existingIds = new Set<string>();
  const clubById = new Map<string, string | null>();

  if (ids.length === 0) {
    return { existingIds, clubById };
  }

  switch (kind) {
    case 'member': {
      const result = await client.query<{ id: string }>(
        `select id from members where id = any($1::text[])`,
        [ids],
      );
      for (const row of result.rows) {
        existingIds.add(row.id);
      }
      return { existingIds, clubById };
    }

    case 'club': {
      const result = await client.query<{ id: string }>(
        `select id from clubs where id = any($1::text[])`,
        [ids],
      );
      for (const row of result.rows) {
        existingIds.add(row.id);
        clubById.set(row.id, row.id);
      }
      return { existingIds, clubById };
    }

    case 'content': {
      const result = await client.query<{ id: string; club_id: string }>(
        `select id, club_id from contents where id = any($1::text[])`,
        [ids],
      );
      for (const row of result.rows) {
        existingIds.add(row.id);
        clubById.set(row.id, row.club_id);
      }
      return { existingIds, clubById };
    }

    case 'dm_thread': {
      const result = await client.query<{ id: string; club_id: string | null }>(
        `select t.id, c.club_id
           from dm_threads t
           left join contents c on c.id = t.subject_content_id
          where t.id = any($1::text[])`,
        [ids],
      );
      for (const row of result.rows) {
        existingIds.add(row.id);
        clubById.set(row.id, row.club_id);
      }
      return { existingIds, clubById };
    }

    case 'membership': {
      const result = await client.query<{ id: string; club_id: string }>(
        `select id, club_id from club_memberships where id = any($1::text[])`,
        [ids],
      );
      for (const row of result.rows) {
        existingIds.add(row.id);
        clubById.set(row.id, row.club_id);
      }
      return { existingIds, clubById };
    }

    case 'application': {
      const result = await client.query<{ id: string; club_id: string }>(
        `select id, club_id from club_applications where id = any($1::text[])`,
        [ids],
      );
      for (const row of result.rows) {
        existingIds.add(row.id);
        clubById.set(row.id, row.club_id);
      }
      return { existingIds, clubById };
    }

    case 'invitation': {
      const result = await client.query<{ id: string; club_id: string }>(
        `select id, club_id from invite_requests where id = any($1::text[])`,
        [ids],
      );
      for (const row of result.rows) {
        existingIds.add(row.id);
        clubById.set(row.id, row.club_id);
      }
      return { existingIds, clubById };
    }

    case 'subscription': {
      const result = await client.query<{ id: string; club_id: string }>(
        `select cs.id, cm.club_id
           from club_subscriptions cs
           join club_memberships cm on cm.id = cs.membership_id
          where cs.id = any($1::text[])`,
        [ids],
      );
      for (const row of result.rows) {
        existingIds.add(row.id);
        clubById.set(row.id, row.club_id);
      }
      return { existingIds, clubById };
    }

    case 'support_request':
      return { existingIds, clubById };
  }
}

async function loadRefLookups(
  client: DbClient,
  notifications: readonly Pick<PreparedNotification, 'refs'>[],
): Promise<Map<NotificationRefKind, RefLookup>> {
  const idsByKind = new Map<NotificationRefKind, Set<string>>();
  for (const kind of NOTIFICATION_REF_KINDS) {
    idsByKind.set(kind, new Set());
  }

  for (const notification of notifications) {
    for (const ref of notification.refs) {
      idsByKind.get(ref.kind)?.add(ref.id);
    }
  }

  const lookups = new Map<NotificationRefKind, RefLookup>();
  for (const kind of NOTIFICATION_REF_KINDS) {
    const ids = [...(idsByKind.get(kind) ?? new Set())];
    lookups.set(kind, await loadRefLookup(client, kind, ids));
  }
  return lookups;
}

function refViolatesClubBoundary(input: {
  clubId: string | null;
  ref: NotificationRefInput;
  lookup: RefLookup | undefined;
}): boolean {
  if (input.clubId === null) {
    return false;
  }
  if (!REF_KINDS_WITH_CLUB_CONTEXT.has(input.ref.kind)) {
    return false;
  }
  if (!input.lookup) {
    return true;
  }

  const refClubId = input.lookup.clubById.get(input.ref.id);
  if (input.ref.kind === 'dm_thread') {
    return refClubId !== undefined && refClubId !== null && refClubId !== input.clubId;
  }
  return refClubId !== input.clubId;
}

function windowStartFor(kind: CounterWindowKind, now: Date): string {
  const windowStart = new Date(now);

  if (kind === 'burst') {
    const bucket = Math.floor(windowStart.getTime() / BURST_WINDOW_MS) * BURST_WINDOW_MS;
    windowStart.setTime(bucket);
    return windowStart.toISOString();
  }

  if (kind === 'hour') {
    windowStart.setUTCMinutes(0, 0, 0);
    return windowStart.toISOString();
  }

  windowStart.setUTCHours(0, 0, 0, 0);
  return windowStart.toISOString();
}

async function ensureRateCounterRow(
  client: DbClient,
  input: {
    producerId: string;
    recipientMemberId: string | null;
    deliveryClass: NotificationDeliveryClass;
    windowKind: CounterWindowKind;
    windowStart: string;
  },
): Promise<void> {
  await client.query(
    `insert into notification_delivery_counters (
       producer_id,
       recipient_member_id,
       delivery_class,
       window_kind,
       window_start,
       delivery_count
     )
     values ($1, $2, $3, $4, $5::timestamptz, 0)
     on conflict (
       producer_id,
       recipient_member_id,
       delivery_class,
       window_kind,
       window_start
     ) do nothing`,
    [
      input.producerId,
      input.recipientMemberId,
      input.deliveryClass,
      input.windowKind,
      input.windowStart,
    ],
  );
}

async function incrementRateCounter(
  client: DbClient,
  input: {
    producerId: string;
    recipientMemberId: string | null;
    deliveryClass: NotificationDeliveryClass;
    windowKind: CounterWindowKind;
    windowStart: string;
  },
): Promise<number> {
  const result = await client.query<{ delivery_count: string }>(
    `update notification_delivery_counters
        set delivery_count = delivery_count + 1
      where producer_id = $1
        and recipient_member_id is not distinct from $2
        and delivery_class = $3
        and window_kind = $4
        and window_start = $5::timestamptz
    returning delivery_count::text as delivery_count`,
    [
      input.producerId,
      input.recipientMemberId,
      input.deliveryClass,
      input.windowKind,
      input.windowStart,
    ],
  );

  return Number(result.rows[0]?.delivery_count ?? 0);
}

async function rateLimitExceeded(
  client: DbClient,
  input: {
    producerId: string;
    recipientMemberId: string;
    deliveryClass: NotificationDeliveryClass;
    producer: ProducerRow & {
      burstLimit?: number | null;
      hourlyLimit?: number | null;
      dailyLimit?: number | null;
    };
  },
): Promise<boolean> {
  const windows: Array<{
    kind: CounterWindowKind;
    limit: number | null | undefined;
  }> = [
    { kind: 'burst', limit: input.producer.burstLimit },
    { kind: 'hour', limit: input.producer.hourlyLimit },
    { kind: 'day', limit: input.producer.dailyLimit },
  ].filter((window): window is {
    kind: CounterWindowKind;
    limit: number;
  } => window.limit != null);

  if (windows.length === 0) {
    return false;
  }

  const now = new Date();
  const scopes = [null, input.recipientMemberId];

  for (const window of windows) {
    const start = windowStartFor(window.kind, now);
    for (const recipientMemberId of scopes) {
      await ensureRateCounterRow(client, {
        producerId: input.producerId,
        recipientMemberId,
        deliveryClass: input.deliveryClass,
        windowKind: window.kind,
        windowStart: start,
      });
    }
  }

  const lockedCounters = await client.query<{
    recipient_member_id: string | null;
    window_kind: CounterWindowKind;
    window_start: string;
    delivery_count: string;
  }>(
    `select recipient_member_id,
            window_kind,
            window_start::text as window_start,
            delivery_count::text as delivery_count
       from notification_delivery_counters
      where producer_id = $1
        and delivery_class = $2
        and (
          recipient_member_id is null
          or recipient_member_id = $3
        )
        and (
          (window_kind = 'burst' and window_start = $4::timestamptz)
          or (window_kind = 'hour' and window_start = $5::timestamptz)
          or (window_kind = 'day' and window_start = $6::timestamptz)
        )
      for update`,
    [
      input.producerId,
      input.deliveryClass,
      input.recipientMemberId,
      windowStartFor('burst', now),
      windowStartFor('hour', now),
      windowStartFor('day', now),
    ],
  );

  const counterByScope = new Map<string, number>();
  for (const row of lockedCounters.rows) {
    counterByScope.set(
      `${row.window_kind}\u0000${row.recipient_member_id ?? '*'}`,
      Number(row.delivery_count),
    );
  }

  for (const window of windows) {
    const limit = window.limit ?? null;
    if (limit === null) {
      continue;
    }

    const globalCount = counterByScope.get(`${window.kind}\u0000*`) ?? 0;
    if (globalCount + 1 > limit) {
      return true;
    }

    const memberCount = counterByScope.get(`${window.kind}\u0000${input.recipientMemberId}`) ?? 0;
    if (memberCount + 1 > limit) {
      return true;
    }
  }

  for (const window of windows) {
    await incrementRateCounter(client, {
      producerId: input.producerId,
      recipientMemberId: null,
      deliveryClass: input.deliveryClass,
      windowKind: window.kind,
      windowStart: windowStartFor(window.kind, now),
    });
    await incrementRateCounter(client, {
      producerId: input.producerId,
      recipientMemberId: input.recipientMemberId,
      deliveryClass: input.deliveryClass,
      windowKind: window.kind,
      windowStart: windowStartFor(window.kind, now),
    });
  }

  return false;
}

async function insertNotificationRefs(
  client: DbClient,
  notificationId: string,
  refs: readonly NotificationRefInput[],
): Promise<void> {
  if (refs.length === 0) {
    return;
  }

  await client.query(
    `insert into notification_refs (notification_id, ref_role, ref_kind, ref_id)
     select $1, ref_role, ref_kind, ref_id
       from unnest($2::text[], $3::text[], $4::text[]) as refs(ref_role, ref_kind, ref_id)
     on conflict do nothing`,
    [
      notificationId,
      refs.map((ref) => ref.role),
      refs.map((ref) => ref.kind),
      refs.map((ref) => ref.id),
    ],
  );
}

function normalizePreparedNotification(input: {
  index: number;
  producerId: string;
  topic: string;
  recipientMemberId: string;
  clubId?: string | null;
  payload: Record<string, unknown>;
  payloadVersion: number;
  idempotencyKey?: string | null;
  expiresAt?: string | null;
  refs?: readonly NotificationRefInput[];
}): PreparedNotification {
  if (!Number.isInteger(input.payloadVersion) || input.payloadVersion < 1) {
    throw new AppError('invalid_input', 'payloadVersion must be an integer >= 1.');
  }

  const topic = normalizeText(input.topic, 'Notification topic');
  const recipientMemberId = normalizeText(input.recipientMemberId, 'Recipient member ID');
  const producerId = normalizeText(input.producerId, 'Producer ID');
  const idempotencyKey = input.idempotencyKey
    ? normalizeText(input.idempotencyKey, 'Notification idempotency key')
    : null;
  const expiresAt = normalizeExpiresAt(input.expiresAt);
  const refs = normalizeRefs(input.refs);
  const requestFingerprint = idempotencyKey
    ? createNotificationRequestFingerprint({
      topic,
      recipientMemberId,
      clubId: input.clubId ?? null,
      payloadVersion: input.payloadVersion,
      payload: input.payload,
      expiresAt,
      refs,
    })
    : null;

  return {
    index: input.index,
    producerId,
    topic,
    recipientMemberId,
    clubId: input.clubId ?? null,
    payload: input.payload,
    payloadVersion: input.payloadVersion,
    idempotencyKey,
    requestFingerprint,
    expiresAt,
    refs,
  };
}

async function deliverPreparedNotifications(
  client: DbClient,
  notifications: readonly PreparedNotification[],
): Promise<DeliverNotificationResult[]> {
  const [{ producersById, topicsByKey }, { knownRecipients, accessibleClubPairs }, refLookups] = await Promise.all([
    loadProducerTopicMaps(client, notifications),
    loadRecipientMaps(client, notifications),
    loadRefLookups(client, notifications),
  ]);

  const now = Date.now();
  const results: DeliverNotificationResult[] = [];
  for (const notification of notifications) {
    const producer = producersById.get(notification.producerId);
    if (!producer || producer.status !== 'active') {
      results.push({
        index: notification.index,
        outcome: 'producer_disabled',
        notificationId: null,
      });
      continue;
    }

    const topic = topicsByKey.get(notificationTopicKey(notification.producerId, notification.topic));
    if (!topic) {
      results.push({
        index: notification.index,
        outcome: 'topic_not_registered',
        notificationId: null,
      });
      continue;
    }

    if (producer.namespacePrefix.length > 0 && !notification.topic.startsWith(producer.namespacePrefix)) {
      results.push({
        index: notification.index,
        outcome: 'topic_namespace_mismatch',
        notificationId: null,
      });
      continue;
    }

    if (topic.status !== 'active') {
      results.push({
        index: notification.index,
        outcome: 'topic_disabled',
        notificationId: null,
      });
      continue;
    }

    if (!knownRecipients.has(notification.recipientMemberId)) {
      results.push({
        index: notification.index,
        outcome: 'recipient_not_found',
        notificationId: null,
      });
      continue;
    }

    if (
      notification.clubId !== null
      && !accessibleClubPairs.has(`${notification.recipientMemberId}\u0000${notification.clubId}`)
    ) {
      results.push({
        index: notification.index,
        outcome: 'recipient_not_accessible_in_club',
        notificationId: null,
      });
      continue;
    }

    if (notification.expiresAt !== null && Date.parse(notification.expiresAt) <= now) {
      results.push({
        index: notification.index,
        outcome: 'expired',
        notificationId: null,
      });
      continue;
    }

    let invalidRef = false;
    let refClubMismatch = false;
    for (const ref of notification.refs) {
      const lookup = refLookups.get(ref.kind);
      if (!lookup || !lookup.existingIds.has(ref.id)) {
        invalidRef = true;
        break;
      }
      if (refViolatesClubBoundary({
        clubId: notification.clubId,
        ref,
        lookup,
      })) {
        refClubMismatch = true;
        break;
      }
    }

    if (invalidRef) {
      results.push({
        index: notification.index,
        outcome: 'invalid_ref',
        notificationId: null,
      });
      continue;
    }

    if (refClubMismatch) {
      results.push({
        index: notification.index,
        outcome: 'ref_club_mismatch',
        notificationId: null,
      });
      continue;
    }

    if (notification.idempotencyKey !== null) {
      const existingResult = await client.query<{ id: string; request_fingerprint: string | null }>(
        `select id, request_fingerprint
           from member_notifications
          where producer_id = $1
            and idempotency_key = $2
          limit 1`,
        [notification.producerId, notification.idempotencyKey],
      );
      const existing = existingResult.rows[0];
      if (existing) {
        results.push({
          index: notification.index,
          outcome: existing.request_fingerprint === notification.requestFingerprint
            ? 'duplicate'
            : 'idempotency_key_mismatch',
          notificationId: existing.id,
        });
        continue;
      }
    }

    if (await rateLimitExceeded(client, {
      producerId: notification.producerId,
      recipientMemberId: notification.recipientMemberId,
      deliveryClass: topic.deliveryClass,
      producer,
    })) {
      results.push({
        index: notification.index,
        outcome: 'rate_limited',
        notificationId: null,
      });
      continue;
    }

    const insertResult = await client.query<{ id: string }>(
      `insert into member_notifications (
         club_id,
         recipient_member_id,
         producer_id,
         topic,
         payload,
         payload_version,
         idempotency_key,
         request_fingerprint,
         expires_at
       )
       values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
       on conflict (producer_id, idempotency_key) where idempotency_key is not null do nothing
       returning id`,
      [
        notification.clubId,
        notification.recipientMemberId,
        notification.producerId,
        notification.topic,
        JSON.stringify(notification.payload),
        notification.payloadVersion,
        notification.idempotencyKey,
        notification.requestFingerprint,
        notification.expiresAt,
      ],
    );

    const inserted = insertResult.rows[0];
    if (inserted) {
      await insertNotificationRefs(client, inserted.id, notification.refs);
      results.push({
        index: notification.index,
        outcome: 'delivered',
        notificationId: inserted.id,
      });
      continue;
    }

    if (notification.idempotencyKey === null) {
      throw new AppError('missing_row', 'Notification insert did not return a row.');
    }

    const existingResult = await client.query<{ id: string; request_fingerprint: string | null }>(
      `select id, request_fingerprint
         from member_notifications
        where producer_id = $1
          and idempotency_key = $2
        limit 1`,
      [notification.producerId, notification.idempotencyKey],
    );
    const existing = existingResult.rows[0];
    if (!existing) {
      throw new AppError('missing_row', 'Notification idempotency lookup missed the conflicting row.');
    }

    if (existing.request_fingerprint !== notification.requestFingerprint) {
      results.push({
        index: notification.index,
        outcome: 'idempotency_key_mismatch',
        notificationId: existing.id,
      });
      continue;
    }

    results.push({
      index: notification.index,
      outcome: 'duplicate',
      notificationId: existing.id,
    });
  }

  return results;
}

export async function deliverNotifications(
  client: DbClient,
  notifications: readonly DeliverNotificationInput[],
): Promise<DeliverNotificationResult[]> {
  return deliverPreparedNotifications(client, notifications.map((notification, index) => (
    normalizePreparedNotification({
      index,
      producerId: notification.producerId,
      topic: notification.topic,
      recipientMemberId: notification.recipientMemberId,
      clubId: notification.clubId,
      payload: notification.payload,
      payloadVersion: notification.payloadVersion,
      idempotencyKey: notification.idempotencyKey,
      expiresAt: notification.expiresAt,
      refs: notification.refs,
    })
  )));
}

export async function deliverCoreNotifications(
  client: DbClient,
  notifications: readonly CoreDeliverNotificationInput[],
): Promise<DeliverNotificationResult[]> {
  const results = await deliverPreparedNotifications(client, notifications.map((notification, index) => (
    normalizePreparedNotification({
      index,
      producerId: 'core',
      topic: notification.topic,
      recipientMemberId: notification.recipientMemberId,
      clubId: notification.clubId,
      payload: notification.payload,
      payloadVersion: notification.payloadVersion,
      idempotencyKey: notification.idempotencyKey,
      expiresAt: notification.expiresAt,
      refs: notification.refs,
    })
  )));

  const failed = results.find((result) => (
    result.outcome !== 'delivered'
    && result.outcome !== 'duplicate'
  ));
  if (failed) {
    throw new AppError('missing_row', `Core notification delivery failed with outcome ${failed.outcome}.`);
  }

  return results;
}

export async function acknowledgeNotificationsById(
  client: DbClient,
  input: {
    recipientMemberId: string;
    notificationIds: readonly string[];
    producerId?: string;
  },
): Promise<AcknowledgedNotificationRecord[]> {
  const notificationIds = [...new Set(input.notificationIds.map((notificationId) => notificationId.trim()).filter(Boolean))];
  if (notificationIds.length === 0) {
    return [];
  }

  const values: unknown[] = [notificationIds, input.recipientMemberId];
  let whereSql = `
      where id = any($1::text[])
        and recipient_member_id = $2
        and acknowledged_at is null
  `;

  if (input.producerId) {
    values.push(input.producerId);
    whereSql += ` and producer_id = $${values.length}`;
  }

  const result = await client.query<{ id: string; acknowledged_at: string }>(
    `update member_notifications
        set acknowledged_at = coalesce(acknowledged_at, now())
     ${whereSql}
      returning id, acknowledged_at::text as acknowledged_at`,
    values,
  );

  return result.rows.map((row) => ({
    id: row.id,
    acknowledgedAt: row.acknowledged_at,
  }));
}

export async function acknowledgeProducerNotificationsById(
  client: DbClient,
  input: {
    producerId: string;
    notificationIds: readonly string[];
  },
): Promise<ProducerAcknowledgeResult[]> {
  const notificationIds = [...new Set(input.notificationIds.map((notificationId) => notificationId.trim()).filter(Boolean))];
  if (notificationIds.length === 0) {
    return [];
  }

  const existingResult = await client.query<{
    id: string;
    producer_id: string;
    acknowledged_at: string | null;
  }>(
    `select id, producer_id, acknowledged_at::text as acknowledged_at
       from member_notifications
      where id = any($1::text[])`,
    [notificationIds],
  );

  const existingById = new Map(existingResult.rows.map((row) => [row.id, row]));
  const eligibleIds = existingResult.rows
    .filter((row) => row.producer_id === input.producerId && row.acknowledged_at === null)
    .map((row) => row.id);

  const acknowledgedById = new Map<string, string>();
  if (eligibleIds.length > 0) {
    const updateResult = await client.query<{ id: string; acknowledged_at: string }>(
      `update member_notifications
          set acknowledged_at = coalesce(acknowledged_at, now())
        where id = any($1::text[])
          and producer_id = $2
          and acknowledged_at is null
      returning id, acknowledged_at::text as acknowledged_at`,
      [eligibleIds, input.producerId],
    );
    for (const row of updateResult.rows) {
      acknowledgedById.set(row.id, row.acknowledged_at);
    }
  }

  return notificationIds.map((notificationId) => {
    const acknowledgedAt = acknowledgedById.get(notificationId);
    if (acknowledgedAt) {
      return {
        notificationId,
        outcome: 'acknowledged',
        acknowledgedAt,
      } satisfies ProducerAcknowledgeResult;
    }

    const existing = existingById.get(notificationId);
    if (!existing) {
      return {
        notificationId,
        outcome: 'not_found',
        acknowledgedAt: null,
      } satisfies ProducerAcknowledgeResult;
    }

    if (existing.producer_id !== input.producerId) {
      return {
        notificationId,
        outcome: 'not_found',
        acknowledgedAt: null,
      } satisfies ProducerAcknowledgeResult;
    }

    return {
      notificationId,
      outcome: 'already_acknowledged',
      acknowledgedAt: existing.acknowledged_at,
    } satisfies ProducerAcknowledgeResult;
  });
}

export async function autoAcknowledgeNotifications(
  client: DbClient,
  selector: AutoAcknowledgeSelector,
): Promise<string[]> {
  const values: unknown[] = [];
  let whereSql = `
      where mn.acknowledged_at is null
  `;

  if (selector.recipientMemberId) {
    values.push(selector.recipientMemberId);
    whereSql += ` and mn.recipient_member_id = $${values.length}`;
  }

  if (selector.producerId) {
    values.push(selector.producerId);
    whereSql += ` and mn.producer_id = $${values.length}`;
  }

  if (selector.topic) {
    values.push(selector.topic);
    whereSql += ` and mn.topic = $${values.length}`;
  }

  if (selector.clubId !== undefined) {
    values.push(selector.clubId);
    if (selector.clubId === null) {
      whereSql += ` and mn.club_id is null`;
      values.pop();
    } else {
      whereSql += ` and mn.club_id = $${values.length}`;
    }
  }

  const matchClauses: string[] = [];
  for (const match of selector.matchesAny ?? []) {
    const clauseParts: string[] = [];
    if (match.ref) {
      values.push(match.ref.kind, match.ref.id);
      const kindParam = values.length - 1;
      const idParam = values.length;
      let refSql = `
          exists (
            select 1
              from notification_refs nr
             where nr.notification_id = mn.id
               and nr.ref_kind = $${kindParam}
               and nr.ref_id = $${idParam}
      `;
      if (match.ref.role) {
        values.push(match.ref.role);
        refSql += ` and nr.ref_role = $${values.length}`;
      }
      refSql += `)`;
      clauseParts.push(refSql);
    }

    const payloadFields = Object.entries(match.payloadFields ?? {}).filter(([, value]) => value.trim().length > 0);
    for (const [key, value] of payloadFields) {
      values.push(key, value);
      const keyParam = values.length - 1;
      const valueParam = values.length;
      clauseParts.push(`mn.payload ->> $${keyParam} = $${valueParam}`);
    }

    if (clauseParts.length > 0) {
      matchClauses.push(`(${clauseParts.join(' and ')})`);
    }
  }

  if (matchClauses.length > 0) {
    whereSql += ` and (${matchClauses.join(' or ')})`;
  }

  const result = await client.query<{ id: string }>(
    `update member_notifications mn
        set acknowledged_at = coalesce(mn.acknowledged_at, now())
     ${whereSql}
      returning mn.id`,
    values,
  );

  return result.rows.map((row) => row.id);
}
