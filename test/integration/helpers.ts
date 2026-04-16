import { createHash } from 'node:crypto';
import type { TestHarness } from './harness.ts';

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
  items: Array<Record<string, unknown>>;
  nextAfter: string | null;
} {
  const data = result.data as Record<string, unknown>;
  return data as { items: Array<Record<string, unknown>>; nextAfter: string | null };
}

export function getNotifications(result: Record<string, unknown>): {
  items: Array<Record<string, unknown>>;
  nextAfter: string | null;
} {
  const data = result.data as Record<string, unknown>;
  return data as { items: Array<Record<string, unknown>>; nextAfter: string | null };
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

export async function prepareAnonymousJoin(
  h: TestHarness,
  clubSlug: string,
): Promise<{ challengeBlob: string; challengeId: string; difficulty: number; expiresAt: string }> {
  const body = await h.apiOk(null, 'clubs.prepareJoin', { clubSlug });
  const data = body.data as Record<string, unknown>;
  return {
    challengeBlob: data.challengeBlob as string,
    challengeId: data.challengeId as string,
    difficulty: data.difficulty as number,
    expiresAt: data.expiresAt as string,
  };
}

export async function joinAnonymouslyWithPow(
  h: TestHarness,
  input: { clubSlug: string; email: string },
): Promise<Record<string, unknown>> {
  const challenge = await prepareAnonymousJoin(h, input.clubSlug);
  const nonce = findPowNonce(challenge.challengeId, challenge.difficulty);
  const body = await h.apiOk(null, 'clubs.join', {
    clubSlug: input.clubSlug,
    email: input.email,
    challengeBlob: challenge.challengeBlob,
    nonce,
  });
  return body.data as Record<string, unknown>;
}

const LOOPABLE_KINDS = new Set(['ask', 'gift', 'service', 'opportunity']);

export async function seedPublishedEntity(
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
): Promise<{ threadId: string; entityId: string; entityVersionId: string }> {
  const openLoop = input.openLoop
    ?? (LOOPABLE_KINDS.has(input.kind) ? true : null);

  const [row] = await h.sqlClubs<{
    thread_id: string;
    entity_id: string;
    entity_version_id: string;
  }>(
     `with thread as (
       insert into content_threads (club_id, created_by_member_id)
       values ($1, $3)
       returning id
     ),
     ent as (
       insert into entities (club_id, kind, author_member_id, open_loop, content_thread_id)
       select
         $1,
         $2::entity_kind,
         $3,
         $4,
         thread.id
       from thread
       returning id, content_thread_id
     ),
     ver as (
       insert into entity_versions (
         entity_id, version_no, state, title, summary, body, created_by_member_id
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
       ent.content_thread_id as thread_id,
       ent.id as entity_id,
       ver.id as entity_version_id
     from ent
     cross join ver`,
    [
      input.clubId,
      input.kind,
      input.authorMemberId,
      openLoop,
      input.title ?? 'seeded entity',
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
         entity_version_id, location, starts_at, ends_at, timezone, recurrence_rule, capacity
       ) values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        row.entity_version_id,
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
    entityId: row.entity_id,
    entityVersionId: row.entity_version_id,
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

export async function seedEntityWithEmbedding(
  h: TestHarness,
  clubId: string,
  authorMemberId: string,
  kind: string,
  vector: string,
): Promise<string> {
  const seeded = await seedPublishedEntity(h, {
    clubId,
    authorMemberId,
    kind,
    title: 'test entity',
    summary: 'test summary',
  });
  const entityId = seeded.entityId;
  const entityVersionId = seeded.entityVersionId;

  await h.sqlClubs(
    `insert into entity_embeddings
       (entity_id, entity_version_id, model, dimensions, source_version, chunk_index, source_text, source_hash, embedding)
     values ($1, $2, 'text-embedding-3-small', 1536, 'v1', 0, 'test', 'test', $3::vector)
     on conflict (entity_id, model, dimensions, source_version, chunk_index)
     do update set embedding = excluded.embedding, updated_at = now()`,
    [entityId, entityVersionId, vector],
  );

  return entityId;
}
