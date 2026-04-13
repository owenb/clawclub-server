#!/usr/bin/env node --experimental-strip-types
/**
 * Best-effort backfill of entity_version_mentions and dm_message_mentions
 * from historic text written before the mentions feature shipped.
 *
 * Approximate by nature: resolves @tokens against CURRENT club membership
 * and CURRENT member handles. Unresolvable handles are logged and skipped.
 * See plans/mentions.md "Historical data and backfill" for why this cannot
 * be exact.
 *
 * Non-destructive: only INSERTs into entity_version_mentions and
 * dm_message_mentions. Never updates, never deletes. Idempotent via
 * NOT EXISTS pre-filter plus ON CONFLICT DO NOTHING on insert; safe to
 * re-run any number of times.
 *
 * Reuses src/mentions.ts parser helpers so UTF-16 offsets, URL masking,
 * and boundary rules are byte-identical to the live write path.
 *
 * Usage:
 *   DATABASE_URL=... node --experimental-strip-types scripts/backfill-mentions.ts
 *   DATABASE_URL=... node --experimental-strip-types scripts/backfill-mentions.ts --commit
 *   DATABASE_URL=... node --experimental-strip-types scripts/backfill-mentions.ts --content-only --commit
 *   DATABASE_URL=... node --experimental-strip-types scripts/backfill-mentions.ts --dms-only
 *
 * Defaults to dry-run. Pass --commit to actually write rows.
 */

import pg from 'pg';
import {
  extractContentMentionCandidates,
  extractMentionCandidates,
} from '../src/mentions.ts';

const args = process.argv.slice(2);
const commit = args.includes('--commit');
const contentOnly = args.includes('--content-only');
const dmsOnly = args.includes('--dms-only');
const doContent = !dmsOnly;
const doDms = !contentOnly;

function log(msg: string = ''): void {
  process.stdout.write(msg + '\n');
}

const mode = commit ? 'COMMIT' : 'DRY-RUN';
log(`=== mention backfill (${mode}) ===`);
if (!commit) log('No rows will be written. Pass --commit to actually insert.');
log();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL must be set');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: databaseUrl });

type ContentCandidateRow = {
  version_id: string;
  entity_id: string;
  club_id: string;
  title: string | null;
  summary: string | null;
  body: string | null;
};

type DmCandidateRow = {
  message_id: string;
  thread_id: string;
  message_text: string;
  member_a_id: string;
  member_b_id: string;
};

type ContentMentionRow = {
  field: 'title' | 'summary' | 'body';
  start: number;
  end: number;
  memberId: string;
  authoredHandle: string;
};

type DmMentionRow = {
  start: number;
  end: number;
  memberId: string;
  authoredHandle: string;
};

async function backfillContent(): Promise<void> {
  log('--- content (entity_version_mentions) ---');

  const candidates = await pool.query<ContentCandidateRow>(`
    select
      cev.id as version_id,
      cev.entity_id,
      e.club_id,
      cev.title,
      cev.summary,
      cev.body
    from current_entity_versions cev
    join entities e on e.id = cev.entity_id
    where cev.state = 'published'
      and e.archived_at is null
      and e.deleted_at is null
      and (
        cev.title like '%@%'
        or cev.summary like '%@%'
        or cev.body like '%@%'
      )
      and not exists (
        select 1 from entity_version_mentions evm
        where evm.entity_version_id = cev.id
      )
    order by cev.created_at asc
  `);

  log(`candidate versions with '@' and no existing mention rows: ${candidates.rows.length}`);

  let versionsWithResolved = 0;
  let totalRowsInserted = 0;
  let totalCandidatesSkipped = 0;

  for (const row of candidates.rows) {
    const extracted = extractContentMentionCandidates({
      title: row.title,
      summary: row.summary,
      body: row.body,
    });
    const uniqueHandles = Array.from(new Set([
      ...extracted.title.map((m) => m.authoredHandle),
      ...extracted.summary.map((m) => m.authoredHandle),
      ...extracted.body.map((m) => m.authoredHandle),
    ]));
    if (uniqueHandles.length === 0) continue;

    const resolveResult = await pool.query<{ member_id: string; handle: string }>(
      `select m.id as member_id, m.handle
       from members m
       join accessible_club_memberships acm on acm.member_id = m.id
       where m.handle = any($1::text[])
         and m.state = 'active'
         and acm.club_id = $2`,
      [uniqueHandles, row.club_id],
    );
    const memberIdByHandle = new Map(resolveResult.rows.map((r) => [r.handle, r.member_id]));
    const unresolvedHandles = uniqueHandles.filter((h) => !memberIdByHandle.has(h));

    const mentionRows: ContentMentionRow[] = [];
    for (const field of ['title', 'summary', 'body'] as const) {
      for (const m of extracted[field]) {
        const memberId = memberIdByHandle.get(m.authoredHandle);
        if (!memberId) {
          totalCandidatesSkipped += 1;
          continue;
        }
        mentionRows.push({
          field,
          start: m.start,
          end: m.end,
          memberId,
          authoredHandle: m.authoredHandle,
        });
      }
    }

    if (mentionRows.length === 0) {
      log(`  entity_version ${row.version_id} [${row.club_id}]: ${uniqueHandles.length} handles, none resolved (${unresolvedHandles.map((h) => '@' + h).join(', ')})`);
      continue;
    }

    versionsWithResolved += 1;
    totalRowsInserted += mentionRows.length;

    const unresolvedSuffix = unresolvedHandles.length > 0
      ? `, skipped ${unresolvedHandles.length} (${unresolvedHandles.map((h) => '@' + h).join(', ')})`
      : '';
    log(`  entity_version ${row.version_id} [${row.club_id}]: ${mentionRows.length} rows resolved${unresolvedSuffix}`);

    if (commit) {
      const values: string[] = [];
      const params: Array<string | number> = [];
      let i = 1;
      for (const r of mentionRows) {
        values.push(`($${i}, $${i + 1}, $${i + 2}, $${i + 3}, $${i + 4}, $${i + 5})`);
        params.push(row.version_id, r.field, r.start, r.end, r.memberId, r.authoredHandle);
        i += 6;
      }
      await pool.query(
        `insert into entity_version_mentions (
           entity_version_id, field, start_offset, end_offset, mentioned_member_id, authored_handle
         ) values ${values.join(', ')}
         on conflict do nothing`,
        params,
      );
    }
  }

  log();
  log('content summary:');
  log(`  candidate versions scanned:         ${candidates.rows.length}`);
  log(`  versions with resolved mentions:    ${versionsWithResolved}`);
  log(`  mention rows ${commit ? 'inserted' : 'would insert'}:     ${totalRowsInserted}`);
  log(`  candidates skipped (unresolvable):  ${totalCandidatesSkipped}`);
  log();
}

async function backfillDms(): Promise<void> {
  log('--- dms (dm_message_mentions) ---');

  const candidates = await pool.query<DmCandidateRow>(`
    select
      dm.id as message_id,
      dm.thread_id,
      dm.message_text,
      dt.member_a_id,
      dt.member_b_id
    from dm_messages dm
    join dm_threads dt on dt.id = dm.thread_id
    left join dm_message_removals rmv on rmv.message_id = dm.id
    where dm.message_text is not null
      and dm.message_text like '%@%'
      and rmv.message_id is null
      and dt.kind = 'direct'
      and dt.member_a_id is not null
      and dt.member_b_id is not null
      and not exists (
        select 1 from dm_message_mentions dmm where dmm.message_id = dm.id
      )
    order by dm.created_at asc
  `);

  log(`candidate messages with '@' and no existing mention rows: ${candidates.rows.length}`);

  let messagesWithResolved = 0;
  let totalRowsInserted = 0;
  let totalCandidatesSkipped = 0;

  // Cache shared-club lookups per thread — most backfill batches have
  // several messages per thread, so this halves the resolver query count.
  const sharedClubCache = new Map<string, string[]>();

  for (const row of candidates.rows) {
    const extracted = extractMentionCandidates(row.message_text);
    const uniqueHandles = Array.from(new Set(extracted.map((m) => m.authoredHandle)));
    if (uniqueHandles.length === 0) continue;

    const participantIds = [row.member_a_id, row.member_b_id];
    let sharedClubIds = sharedClubCache.get(row.thread_id);
    if (sharedClubIds === undefined) {
      const scResult = await pool.query<{ club_id: string }>(
        `select a.club_id
         from accessible_club_memberships a
         join accessible_club_memberships b
           on b.club_id = a.club_id and b.member_id = $2
         where a.member_id = $1`,
        [row.member_a_id, row.member_b_id],
      );
      sharedClubIds = scResult.rows.map((r) => r.club_id);
      sharedClubCache.set(row.thread_id, sharedClubIds);
    }

    const resolveResult = await pool.query<{ member_id: string; handle: string }>(
      `select m.id as member_id, m.handle
       from members m
       where m.handle = any($1::text[])
         and m.state = 'active'
         and (
           m.id = any($2::text[])
           or exists (
             select 1
             from accessible_club_memberships acm
             where acm.member_id = m.id
               and acm.club_id = any($3::text[])
           )
         )`,
      [uniqueHandles, participantIds, sharedClubIds],
    );
    const memberIdByHandle = new Map(resolveResult.rows.map((r) => [r.handle, r.member_id]));
    const unresolvedHandles = uniqueHandles.filter((h) => !memberIdByHandle.has(h));

    const mentionRows: DmMentionRow[] = [];
    for (const m of extracted) {
      const memberId = memberIdByHandle.get(m.authoredHandle);
      if (!memberId) {
        totalCandidatesSkipped += 1;
        continue;
      }
      mentionRows.push({
        start: m.start,
        end: m.end,
        memberId,
        authoredHandle: m.authoredHandle,
      });
    }

    if (mentionRows.length === 0) {
      log(`  dm_message ${row.message_id} [thread ${row.thread_id}]: ${uniqueHandles.length} handles, none resolved (${unresolvedHandles.map((h) => '@' + h).join(', ')})`);
      continue;
    }

    messagesWithResolved += 1;
    totalRowsInserted += mentionRows.length;

    const unresolvedSuffix = unresolvedHandles.length > 0
      ? `, skipped ${unresolvedHandles.length} (${unresolvedHandles.map((h) => '@' + h).join(', ')})`
      : '';
    log(`  dm_message ${row.message_id} [thread ${row.thread_id}]: ${mentionRows.length} rows resolved${unresolvedSuffix}`);

    if (commit) {
      const values: string[] = [];
      const params: Array<string | number> = [];
      let i = 1;
      for (const r of mentionRows) {
        values.push(`($${i}, $${i + 1}, $${i + 2}, $${i + 3}, $${i + 4})`);
        params.push(row.message_id, r.start, r.end, r.memberId, r.authoredHandle);
        i += 5;
      }
      await pool.query(
        `insert into dm_message_mentions (
           message_id, start_offset, end_offset, mentioned_member_id, authored_handle
         ) values ${values.join(', ')}
         on conflict do nothing`,
        params,
      );
    }
  }

  log();
  log('dms summary:');
  log(`  candidate messages scanned:         ${candidates.rows.length}`);
  log(`  messages with resolved mentions:    ${messagesWithResolved}`);
  log(`  mention rows ${commit ? 'inserted' : 'would insert'}:     ${totalRowsInserted}`);
  log(`  candidates skipped (unresolvable):  ${totalCandidatesSkipped}`);
  log();
}

async function main(): Promise<void> {
  try {
    if (doContent) await backfillContent();
    if (doDms) await backfillDms();
    log('=== done ===');
    if (!commit) {
      log('(dry run — no changes written. re-run with --commit to persist.)');
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('backfill failed:', err);
  process.exit(1);
});
