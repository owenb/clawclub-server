import { createHash } from 'node:crypto';
import type { TestHarness } from './harness.ts';

let discoverIpCounter = 0;

function nextDiscoverClientIp(): string {
  discoverIpCounter = (discoverIpCounter + 1) % 65_536;
  const third = Math.floor(discoverIpCounter / 256);
  const fourth = discoverIpCounter % 256;
  return `198.18.${third}.${fourth}`;
}

export function activeMemberships(sessionBody: Record<string, unknown>): Array<Record<string, unknown>> {
  const actor = sessionBody.actor as Record<string, unknown>;
  return (actor.activeMemberships ?? []) as Array<Record<string, unknown>>;
}

export function makeVector(values: number[]): string {
  const full = new Array(1536).fill(0);
  for (let i = 0; i < values.length; i++) full[i] = values[i];
  return `[${full.join(',')}]`;
}

export function getActivity(result: Record<string, unknown>): {
  results: Array<Record<string, unknown>>;
  items: Array<Record<string, unknown>>;
  hasMore: boolean;
  nextCursor: string;
} {
  const data = result.data as Record<string, unknown>;
  const slice = (data.activity as Record<string, unknown> | undefined) ?? data;
  const page = slice as { results: Array<Record<string, unknown>>; hasMore: boolean; nextCursor: string };
  return { ...page, items: page.results };
}

export function getNotifications(result: Record<string, unknown>): {
  results: Array<Record<string, unknown>>;
  items: Array<Record<string, unknown>>;
  nextCursor: string | null;
} {
  const data = result.data as Record<string, unknown>;
  const slice = (data.notifications as Record<string, unknown> | undefined) ?? data;
  const page = slice as { results: Array<Record<string, unknown>>; nextCursor: string | null };
  return { ...page, items: page.results };
}

export function getInbox(result: Record<string, unknown>): {
  limit: number;
  unreadOnly: boolean;
  results: Array<Record<string, unknown>>;
  hasMore: boolean;
  nextCursor: string | null;
  included: Record<string, unknown>;
} {
  const data = result.data as Record<string, unknown>;
  const slice = (data.inbox as Record<string, unknown> | undefined) ?? data;
  return slice as {
    limit: number;
    unreadOnly: boolean;
    results: Array<Record<string, unknown>>;
    hasMore: boolean;
    nextCursor: string | null;
    included: Record<string, unknown>;
  };
}

export function findPowNonce(challengeId: string, difficulty: number): string {
  const zeros = '0'.repeat(difficulty);
  for (let nonce = 0; nonce < 250_000; nonce += 1) {
    const candidate = String(nonce);
    const hash = createHash('sha256').update(`${challengeId}:${candidate}`, 'utf8').digest('hex');
    if (hash.endsWith(zeros)) {
      return candidate;
    }
  }
  throw new Error(`Unable to find trailing-zero nonce for difficulty ${difficulty}`);
}

export function findInvalidPowNonce(challengeId: string, difficulty: number): string {
  const zeros = '0'.repeat(difficulty);
  for (let nonce = 0; nonce < 1_000; nonce += 1) {
    const candidate = `invalid-${nonce}`;
    const hash = createHash('sha256').update(`${challengeId}:${candidate}`, 'utf8').digest('hex');
    if (!hash.endsWith(zeros)) {
      return candidate;
    }
  }
  throw new Error(`Unable to find invalid nonce for difficulty ${difficulty}`);
}

export async function prepareAccountRegistration(
  h: TestHarness,
  _clientKey = 'register-discover',
  input: { invitationCode?: string; email?: string } = {},
): Promise<{ challengeBlob: string; challengeId: string; difficulty: number; expiresAt: string }> {
  const body = await h.apiOk(null, 'accounts.register', { mode: 'discover', ...input }, {
    headers: { 'x-forwarded-for': nextDiscoverClientIp() },
  });
  const data = body.data as Record<string, unknown>;
  const challenge = data.challenge as Record<string, unknown>;
  return {
    challengeBlob: challenge.challengeBlob as string,
    challengeId: challenge.challengeId as string,
    difficulty: challenge.difficulty as number,
    expiresAt: challenge.expiresAt as string,
  };
}

export async function registerWithPow(
  h: TestHarness,
  input: { name: string; email: string; clientKey?: string; invitationCode?: string },
): Promise<{ body: Record<string, unknown>; bearerToken: string; memberId: string }> {
  const challenge = await prepareAccountRegistration(
    h,
    input.clientKey ?? 'register-discover',
    input.invitationCode ? { invitationCode: input.invitationCode, email: input.email } : {},
  );
  const nonce = findPowNonce(challenge.challengeId, challenge.difficulty);
  const body = await h.apiOk(null, 'accounts.register', {
    mode: 'submit',
    clientKey: input.clientKey ?? 'register-submit',
    name: input.name,
    email: input.email,
    challengeBlob: challenge.challengeBlob,
    nonce,
    ...(input.invitationCode ? { invitationCode: input.invitationCode } : {}),
  });
  const data = body.data as Record<string, unknown>;
  const member = data.member as Record<string, unknown>;
  const credentials = data.credentials as Record<string, unknown>;
  return {
    body,
    bearerToken: credentials.memberBearer as string,
    memberId: member.memberId as string,
  };
}

const LOOPABLE_KINDS = new Set(['ask', 'gift', 'service', 'opportunity']);

export async function seedPublishedContent(
  h: TestHarness,
  input: {
    clubId: string;
    authorMemberId: string;
    kind: string;
    title?: string | null;
    summary?: string | null;
    body?: string | null;
    openLoop?: boolean | null;
    event?: {
      location?: string | null;
      startsAt?: string | null;
      endsAt?: string | null;
      timezone?: string | null;
      recurrenceRule?: string | null;
      capacity?: number | null;
    } | null;
  },
): Promise<{ threadId: string; id: string; contentVersionId: string }> {
  const openLoop = input.openLoop
    ?? (LOOPABLE_KINDS.has(input.kind) ? true : null);

  const [row] = await h.sqlClubs<{
    thread_id: string;
    content_id: string;
    content_version_id: string;
  }>(
     `with thread as (
       insert into content_threads (club_id, created_by_member_id)
       values ($1, $3)
       returning id
     ),
     ent as (
       insert into contents (club_id, kind, author_member_id, open_loop, thread_id)
       select
         $1,
         $2::content_kind,
         $3,
         $4,
         thread.id
       from thread
       returning id, thread_id
     ),
     ver as (
       insert into content_versions (
         content_id, version_no, state, title, summary, body, created_by_member_id
       )
       select
         ent.id,
         1,
         'published',
         $5,
         $6,
         $7,
         $3
       from ent
       returning id
     )
     select
       ent.thread_id as thread_id,
       ent.id as content_id,
       ver.id as content_version_id
     from ent
     cross join ver`,
    [
      input.clubId,
      input.kind,
      input.authorMemberId,
      openLoop,
      input.title ?? 'seeded content',
      input.summary ?? null,
      input.body ?? null,
    ],
  );

  if (input.kind === 'event') {
    const startsAt = input.event?.startsAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const endsAt = input.event?.endsAt
      ?? new Date(new Date(startsAt).getTime() + 2 * 60 * 60 * 1000).toISOString();
    await h.sqlClubs(
      `insert into event_version_details (
         content_version_id, location, starts_at, ends_at, timezone, recurrence_rule, capacity
       ) values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        row.content_version_id,
        input.event?.location ?? 'Online',
        startsAt,
        endsAt,
        input.event?.timezone ?? 'UTC',
        input.event?.recurrenceRule ?? null,
        input.event?.capacity ?? null,
      ],
    );
  }

  return {
    threadId: row.thread_id,
    id: row.content_id,
    contentVersionId: row.content_version_id,
  };
}

export async function seedProfileEmbedding(h: TestHarness, memberId: string, vector: string): Promise<void> {
  let pvRows = await h.sql<{ id: string; club_id: string }>(
    `select id, club_id from current_member_club_profiles where member_id = $1`,
    [memberId],
  );

  if (pvRows.length === 0) {
    const membershipRows = await h.sql<{ id: string; club_id: string }>(
      `select id, club_id
         from club_memberships
        where member_id = $1 and left_at is null
        order by joined_at asc, club_id asc`,
      [memberId],
    );
    for (const row of membershipRows) {
      await h.sql(
        `insert into member_club_profile_versions (
           membership_id, member_id, club_id, version_no, created_by_member_id, generation_source
         )
         values (
           $3,
           $1,
           $2,
           1,
           $1,
           'membership_seed'
         )`,
        [memberId, row.club_id, row.id],
      );
    }
    pvRows = await h.sql<{ id: string; club_id: string }>(
      `select id, club_id from current_member_club_profiles where member_id = $1`,
      [memberId],
    );
  }

  for (const row of pvRows) {
    await h.sql(
      `insert into member_profile_embeddings
         (member_id, club_id, profile_version_id, model, dimensions, source_version, chunk_index, source_text, source_hash, embedding)
       values ($1, $2, $3, 'text-embedding-3-small', 1536, 'v1', 0, 'test', 'test', $4::vector)
       on conflict (member_id, club_id, model, dimensions, source_version, chunk_index)
       do update set
         profile_version_id = excluded.profile_version_id,
         embedding = excluded.embedding,
         updated_at = now()`,
      [memberId, row.club_id, row.id, vector],
    );
  }
}

export async function seedContentWithEmbedding(
  h: TestHarness,
  clubId: string,
  authorMemberId: string,
  kind: string,
  vector: string,
): Promise<string> {
  const seeded = await seedPublishedContent(h, {
    clubId,
    authorMemberId,
    kind,
    title: 'test content',
    summary: 'test summary',
  });
  const contentId = seeded.id;
  const contentVersionId = seeded.contentVersionId;

  await h.sqlClubs(
    `insert into content_embeddings
       (content_id, content_version_id, model, dimensions, source_version, chunk_index, source_text, source_hash, embedding)
     values ($1, $2, 'text-embedding-3-small', 1536, 'v1', 0, 'test', 'test', $3::vector)
     on conflict (content_id, model, dimensions, source_version, chunk_index)
     do update set embedding = excluded.embedding, updated_at = now()`,
    [contentId, contentVersionId, vector],
  );

  return contentId;
}
