import type { TestHarness } from './harness.ts';

export function activeMemberships(sessionBody: Record<string, unknown>): Array<Record<string, unknown>> {
  const actor = sessionBody.actor as Record<string, unknown>;
  return (actor.activeMemberships ?? []) as Array<Record<string, unknown>>;
}

export function admission(responseBody: Record<string, unknown>): Record<string, unknown> {
  return (responseBody.data as Record<string, unknown>).admission as Record<string, unknown>;
}

export function admissionList(responseBody: Record<string, unknown>): Array<Record<string, unknown>> {
  return (responseBody.data as Record<string, unknown>).results as Array<Record<string, unknown>>;
}

export function makeVector(values: number[]): string {
  const full = new Array(1536).fill(0);
  for (let i = 0; i < values.length; i++) full[i] = values[i];
  return `[${full.join(',')}]`;
}

export function getUpdates(result: Record<string, unknown>): {
  items: Array<Record<string, unknown>>;
  nextAfter: string | null;
} {
  const data = result.data as Record<string, unknown>;
  return data.updates as { items: Array<Record<string, unknown>>; nextAfter: string | null };
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
  const entityRows = await h.sqlClubs<{ id: string }>(
    `insert into entities (club_id, kind, author_member_id, open_loop)
     values (
       $1,
       $2::entity_kind,
       $3,
       case
         when $2::entity_kind in ('ask', 'gift', 'service', 'opportunity') then true
         else null
       end
     ) returning id`,
    [clubId, kind, authorMemberId],
  );
  const entityId = entityRows[0].id;

  const versionRows = await h.sqlClubs<{ id: string }>(
    `insert into entity_versions (entity_id, version_no, state, title, summary)
     values ($1, 1, 'published', 'test entity', 'test summary') returning id`,
    [entityId],
  );
  const entityVersionId = versionRows[0].id;

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
