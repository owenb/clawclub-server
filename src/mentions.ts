import type { Pool } from 'pg';
import type { DbClient } from './db.ts';
import { AppError, type IncludedBundle, type IncludedMember, type MentionSpan } from './repository.ts';
import { CROCKFORD_LOWER_ALPHABET } from './crockford.ts';

export type ContentMentionField = 'title' | 'summary' | 'body';

export type ContentMentionsByField = {
  title: MentionSpan[];
  summary: MentionSpan[];
  body: MentionSpan[];
};

export type ContentMentionWriteScope = {
  memberId: string;
};

export type ContentMentionReadScope = ContentMentionWriteScope | 'superadmin';

export type DmMentionWriteScope = {
  threadParticipantIds: string[];
};

export type DmMentionReadScope =
  | DmMentionWriteScope
  | {
    participantIdsByMessageId: ReadonlyMap<string, readonly string[]>;
  };

type ExtractedMention = {
  text: string;
  authoredLabel: string;
  memberId: string;
  start: number;
  end: number;
};

type ExtractedContentMentions = {
  title: ExtractedMention[];
  summary: ExtractedMention[];
  body: ExtractedMention[];
};

type ContentMentionRow = {
  content_version_id: string;
  field: ContentMentionField;
  start_offset: number;
  end_offset: number;
  mentioned_member_id: string;
  authored_label: string;
};

type DmMentionRow = {
  message_id: string;
  start_offset: number;
  end_offset: number;
  mentioned_member_id: string;
  authored_label: string;
};

type IncludedMemberRow = {
  member_id: string;
  public_name: string;
  display_name: string;
};

type ContentUpdatePreflightRow = {
  club_id: string;
  author_member_id: string;
  title: string | null;
  summary: string | null;
  body: string | null;
  version_id: string;
};

const MAX_UNIQUE_MENTIONED_MEMBERS = 25;
const MAX_MENTION_SPANS = 100;

// `[Display Name|memberId]` where memberId is a 12-char short_id from the
// Crockford alphabet (no 0, 1, i, l, o). Labels disallow `[`, `]`, `|`, and
// CR/LF — a mention span must live on a single line so its offsets stay
// meaningful. We also require a non-empty label with no outer whitespace,
// so the persisted `authored_label` always matches the span text exactly.
const MENTION_RE = new RegExp(`\\[([^\\[\\]|\\r\\n]+)\\|([${CROCKFORD_LOWER_ALPHABET}]{12})\\]`, 'g');

export function emptyIncludedBundle(): IncludedBundle {
  return { membersById: {} };
}

export function mergeIncludedBundles(...bundles: IncludedBundle[]): IncludedBundle {
  const membersById: Record<string, IncludedMember> = {};
  for (const bundle of bundles) {
    for (const [memberId, member] of Object.entries(bundle.membersById)) {
      membersById[memberId] = member;
    }
  }
  return { membersById };
}

export function emptyContentMentions(): ContentMentionsByField {
  return {
    title: [],
    summary: [],
    body: [],
  };
}

export function hasPotentialMentionChar(...texts: Array<string | null | undefined>): boolean {
  return texts.some((text) => typeof text === 'string' && text.includes('['));
}

export function extractMentionCandidates(text: string | null | undefined): ExtractedMention[] {
  if (!text || !text.includes('[')) return [];

  const mentions: ExtractedMention[] = [];

  // Reset lastIndex so repeated calls on the same regex don't drift.
  MENTION_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MENTION_RE.exec(text)) !== null) {
    const label = match[1]!;
    const memberId = match[2]!;
    const start = match.index;
    const end = start + match[0].length;

    // Reject labels with outer whitespace or empty-after-trim so the persisted
    // `authored_label` is always exactly what appears between `[` and `|`.
    if (label.trim().length === 0 || label !== label.trim()) continue;

    mentions.push({
      text: match[0]!,
      authoredLabel: label,
      memberId,
      start,
      end,
    });
  }

  return mentions;
}

export function extractContentMentionCandidates(input: {
  title?: string | null;
  summary?: string | null;
  body?: string | null;
}): ExtractedContentMentions {
  return {
    title: extractMentionCandidates(input.title),
    summary: extractMentionCandidates(input.summary),
    body: extractMentionCandidates(input.body),
  };
}

function assertMentionLimits(
  uniqueMembers: number,
  spanCount: number,
  context: 'content' | 'message',
  changedFieldSpanCount?: number,
): void {
  if (context === 'content') {
    if ((uniqueMembers > MAX_UNIQUE_MENTIONED_MEMBERS || spanCount > MAX_MENTION_SPANS) && (changedFieldSpanCount ?? spanCount) > 0) {
      throw new AppError('invalid_input',
        `A content version may contain at most ${MAX_UNIQUE_MENTIONED_MEMBERS} unique mentions and ${MAX_MENTION_SPANS} mention spans.`,
      );
    }
    return;
  }

  if (uniqueMembers > MAX_UNIQUE_MENTIONED_MEMBERS || spanCount > MAX_MENTION_SPANS) {
    throw new AppError('invalid_input',
      `A direct message may contain at most ${MAX_UNIQUE_MENTIONED_MEMBERS} unique mentions and ${MAX_MENTION_SPANS} mention spans.`,
    );
  }
}

function uniqueMemberIdsInOrder(mentions: ExtractedMention[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const mention of mentions) {
    if (seen.has(mention.memberId)) continue;
    seen.add(mention.memberId);
    ids.push(mention.memberId);
  }
  return ids;
}

function toCanonicalMentionSpans(
  mentions: Array<Pick<MentionSpan, 'memberId' | 'start' | 'end'>>,
  included: IncludedBundle,
): MentionSpan[] {
  const spans: MentionSpan[] = [];
  for (const mention of mentions) {
    const member = included.membersById[mention.memberId];
    if (!member) continue;
    spans.push({
      memberId: mention.memberId,
      authoredLabel: member.publicName,
      start: mention.start,
      end: mention.end,
    });
  }
  return spans;
}

function throwInvalidMentions(mentions: ExtractedMention[]): never {
  throw new AppError('invalid_mentions', 'One or more mentions could not be resolved in this context.', {
    details: {
      invalidSpans: mentions.map((mention) => ({
        mentionText: mention.text,
        memberId: mention.memberId,
        reason: 'not_resolvable' as const,
      })),
    },
  });
}

function canonicaliseMentionLabels(mentions: MentionSpan[], included: IncludedBundle): void {
  for (const mention of mentions) {
    const member = included.membersById[mention.memberId];
    if (member) {
      mention.authoredLabel = member.publicName;
    }
  }
}

function canonicaliseContentMentionLabels(
  mentions: ContentMentionsByField,
  included: IncludedBundle,
): void {
  canonicaliseMentionLabels(mentions.title, included);
  canonicaliseMentionLabels(mentions.summary, included);
  canonicaliseMentionLabels(mentions.body, included);
}

export async function loadIncludedMembers(client: DbClient, memberIds: string[]): Promise<IncludedBundle> {
  if (memberIds.length === 0) return emptyIncludedBundle();

  const result = await client.query<IncludedMemberRow>(
    `select id as member_id, public_name, display_name
     from members
     where id = any($1::text[])`,
    [memberIds],
  );

  const membersById: Record<string, IncludedMember> = {};
  for (const row of result.rows) {
    membersById[row.member_id] = {
      memberId: row.member_id,
      publicName: row.public_name,
      displayName: row.display_name,
    };
  }

  return { membersById };
}

async function loadContentScopedMemberIds(
  client: DbClient,
  memberIds: string[],
  scope: ContentMentionReadScope,
): Promise<Set<string>> {
  if (memberIds.length === 0) return new Set();
  if (scope === 'superadmin') {
    return new Set(memberIds);
  }

  const result = await client.query<{ member_id: string }>(
    `select distinct mentioned.member_id
     from accessible_club_memberships actor
     join accessible_club_memberships mentioned
       on mentioned.club_id = actor.club_id
     where actor.member_id = $1
       and mentioned.member_id = any($2::text[])`,
    [scope.memberId, memberIds],
  );
  return new Set(result.rows.map((row) => row.member_id));
}

export async function resolvePublicContentMentions(
  client: DbClient,
  extracted: ExtractedContentMentions,
  writerScope: ContentMentionWriteScope,
): Promise<ContentMentionsByField> {
  const allMentions = [...extracted.title, ...extracted.summary, ...extracted.body];
  const ids = uniqueMemberIdsInOrder(allMentions);
  const allowedMemberIds = await loadContentScopedMemberIds(client, ids, writerScope);
  const droppedMentions = allMentions.filter((mention) => !allowedMemberIds.has(mention.memberId));
  if (droppedMentions.length > 0) {
    throwInvalidMentions(droppedMentions);
  }
  const included = await loadIncludedMembers(client, [...allowedMemberIds]);

  const mentions = {
    title: toCanonicalMentionSpans(extracted.title.filter((mention) => allowedMemberIds.has(mention.memberId)), included),
    summary: toCanonicalMentionSpans(extracted.summary.filter((mention) => allowedMemberIds.has(mention.memberId)), included),
    body: toCanonicalMentionSpans(extracted.body.filter((mention) => allowedMemberIds.has(mention.memberId)), included),
  } satisfies ContentMentionsByField;

  const uniqueMembers = new Set([...mentions.title, ...mentions.summary, ...mentions.body].map((mention) => mention.memberId)).size;
  const spanCount = mentions.title.length + mentions.summary.length + mentions.body.length;
  assertMentionLimits(uniqueMembers, spanCount, 'content');
  return mentions;
}

export async function resolveDirectMessageMentions(
  client: DbClient,
  messageText: string,
  scope: DmMentionWriteScope,
): Promise<MentionSpan[]> {
  const extracted = extractMentionCandidates(messageText);
  if (extracted.length === 0) return [];

  const allowedParticipantIds = new Set(scope.threadParticipantIds);
  const allowedMentions = extracted.filter((mention) => allowedParticipantIds.has(mention.memberId));
  if (allowedMentions.length !== extracted.length) {
    throwInvalidMentions(extracted.filter((mention) => !allowedParticipantIds.has(mention.memberId)));
  }
  const included = await loadIncludedMembers(client, uniqueMemberIdsInOrder(allowedMentions));
  const mentions = toCanonicalMentionSpans(allowedMentions, included);
  assertMentionLimits(new Set(mentions.map((mention) => mention.memberId)).size, mentions.length, 'message');
  return mentions;
}

export async function insertEntityVersionMentions(
  client: DbClient,
  contentVersionId: string,
  mentions: ContentMentionsByField,
): Promise<void> {
  const rows = [
    ...mentions.title.map((mention) => ({ field: 'title' as const, ...mention })),
    ...mentions.summary.map((mention) => ({ field: 'summary' as const, ...mention })),
    ...mentions.body.map((mention) => ({ field: 'body' as const, ...mention })),
  ];
  if (rows.length === 0) return;

  const values: string[] = [];
  const params: Array<string | number> = [];
  let index = 1;

  for (const row of rows) {
    values.push(`($${index}, $${index + 1}, $${index + 2}, $${index + 3}, $${index + 4}, $${index + 5})`);
    params.push(contentVersionId, row.field, row.start, row.end, row.memberId, row.authoredLabel);
    index += 6;
  }

  await client.query(
    `insert into content_version_mentions (
       content_version_id, field, start_offset, end_offset, mentioned_member_id, authored_label
     ) values ${values.join(', ')}`,
    params,
  );
}

export async function insertDmMessageMentions(
  client: DbClient,
  messageId: string,
  mentions: MentionSpan[],
): Promise<void> {
  if (mentions.length === 0) return;

  const values: string[] = [];
  const params: Array<string | number> = [];
  let index = 1;

  for (const mention of mentions) {
    values.push(`($${index}, $${index + 1}, $${index + 2}, $${index + 3}, $${index + 4})`);
    params.push(messageId, mention.start, mention.end, mention.memberId, mention.authoredLabel);
    index += 5;
  }

  await client.query(
    `insert into dm_message_mentions (
       message_id, start_offset, end_offset, mentioned_member_id, authored_label
     ) values ${values.join(', ')}`,
    params,
  );
}

export async function loadEntityVersionMentions(
  client: DbClient,
  contentVersionIds: string[],
  readerScope: ContentMentionReadScope,
): Promise<{ mentionsByVersionId: Map<string, ContentMentionsByField>; included: IncludedBundle }> {
  const mentionsByVersionId = new Map<string, ContentMentionsByField>();
  if (contentVersionIds.length === 0) {
    return { mentionsByVersionId, included: emptyIncludedBundle() };
  }

  const result = await client.query<ContentMentionRow>(
    `select content_version_id, field, start_offset, end_offset, mentioned_member_id, authored_label
     from content_version_mentions
     where content_version_id = any($1::text[])
     order by content_version_id, field, start_offset`,
    [contentVersionIds],
  );

  const allowedMemberIds = await loadContentScopedMemberIds(
    client,
    [...new Set(result.rows.map((row) => row.mentioned_member_id))],
    readerScope,
  );

  const memberIds = new Set<string>();
  for (const row of result.rows) {
    if (!allowedMemberIds.has(row.mentioned_member_id)) {
      continue;
    }
    memberIds.add(row.mentioned_member_id);
    if (!mentionsByVersionId.has(row.content_version_id)) {
      mentionsByVersionId.set(row.content_version_id, emptyContentMentions());
    }
    mentionsByVersionId.get(row.content_version_id)![row.field].push({
      memberId: row.mentioned_member_id,
      authoredLabel: row.authored_label,
      start: row.start_offset,
      end: row.end_offset,
    });
  }

  const included = await loadIncludedMembers(client, [...memberIds]);
  for (const mentions of mentionsByVersionId.values()) {
    canonicaliseContentMentionLabels(mentions, included);
  }

  return { mentionsByVersionId, included };
}

export async function loadEntityVersionMentionsForVersion(
  client: DbClient,
  contentVersionId: string,
  readerScope: ContentMentionReadScope,
): Promise<ContentMentionsByField> {
  const { mentionsByVersionId } = await loadEntityVersionMentions(client, [contentVersionId], readerScope);
  return mentionsByVersionId.get(contentVersionId) ?? emptyContentMentions();
}

export async function copyEntityVersionMentions(
  client: DbClient,
  oldVersionId: string,
  newVersionId: string,
  fields: ContentMentionField[],
): Promise<void> {
  if (fields.length === 0) return;

  await client.query(
    `insert into content_version_mentions (
       content_version_id, field, start_offset, end_offset, mentioned_member_id, authored_label
     )
     select
       $2,
       field,
       start_offset,
       end_offset,
       mentioned_member_id,
       authored_label
     from content_version_mentions
     where content_version_id = $1
       and field = any($3::text[])`,
    [oldVersionId, newVersionId, fields],
  );
}

export async function loadDmMentions(
  client: DbClient,
  messageIds: string[],
  scope: DmMentionReadScope,
): Promise<{ mentionsByMessageId: Map<string, MentionSpan[]>; included: IncludedBundle }> {
  const mentionsByMessageId = new Map<string, MentionSpan[]>();
  if (messageIds.length === 0) {
    return { mentionsByMessageId, included: emptyIncludedBundle() };
  }

  const result = await client.query<DmMentionRow>(
    `select message_id, start_offset, end_offset, mentioned_member_id, authored_label
     from dm_message_mentions
     where message_id = any($1::text[])
     order by message_id, start_offset`,
    [messageIds],
  );

  const memberIds = new Set<string>();
  for (const row of result.rows) {
    const allowedIds = 'threadParticipantIds' in scope
      ? scope.threadParticipantIds
      : (scope.participantIdsByMessageId.get(row.message_id) ?? []);
    if (!allowedIds.includes(row.mentioned_member_id)) {
      continue;
    }
    memberIds.add(row.mentioned_member_id);
    if (!mentionsByMessageId.has(row.message_id)) {
      mentionsByMessageId.set(row.message_id, []);
    }
    mentionsByMessageId.get(row.message_id)!.push({
      memberId: row.mentioned_member_id,
      authoredLabel: row.authored_label,
      start: row.start_offset,
      end: row.end_offset,
    });
  }

  const included = await loadIncludedMembers(client, [...memberIds]);
  for (const mentions of mentionsByMessageId.values()) {
    canonicaliseMentionLabels(mentions, included);
  }

  return { mentionsByMessageId, included };
}

export function applyContentMentionLimitsForUpdate(
  mentions: ContentMentionsByField,
  changedFieldSpanCount: number,
): void {
  const allMentions = [...mentions.title, ...mentions.summary, ...mentions.body];
  const uniqueMembers = new Set(allMentions.map((mention) => mention.memberId)).size;
  assertMentionLimits(uniqueMembers, allMentions.length, 'content', changedFieldSpanCount);
}

export async function preflightContentCreateMentions(
  pool: Pool,
  input: {
    actorMemberId: string;
    actorClubIds: string[];
    clubId?: string;
    threadId?: string;
    title: string | null;
    summary: string | null;
    body: string | null;
    clientKey?: string | null;
  },
): Promise<void> {
  if (!input.clubId && !input.threadId) return;

  let clubId = input.clubId ?? null;
  if (!clubId) {
    const result = await pool.query<{ club_id: string }>(
      `select ct.club_id
       from content_threads ct
       where ct.id = $1
         and ct.archived_at is null`,
      [input.threadId!],
    );
    clubId = result.rows[0]?.club_id ?? null;
    if (!clubId) {
      throw new AppError('thread_not_found', 'Thread not found inside the actor scope');
    }
  }
  if (!input.actorClubIds.includes(clubId)) {
    throw new AppError(
      input.threadId ? 'thread_not_found' : 'forbidden_scope',
      input.threadId ? 'Thread not found inside the actor scope' : 'Requested club is outside your access scope',
    );
  }

  if (!hasPotentialMentionChar(input.title, input.summary, input.body)) return;

  if (input.clientKey) {
    const existing = await pool.query<{ id: string }>(
      `select id
       from contents
       where author_member_id = $1
         and client_key = $2
         and archived_at is null
         and deleted_at is null
       limit 1`,
      [input.actorMemberId, input.clientKey],
    );
    if (existing.rows[0]) return;
  }

  const extracted = extractContentMentionCandidates(input);
  if (extracted.title.length === 0 && extracted.summary.length === 0 && extracted.body.length === 0) return;
  await resolvePublicContentMentions(pool, extracted, {
    memberId: input.actorMemberId,
  });
}

export async function preflightContentUpdateMentions(
  pool: Pool,
  input: {
    actorMemberId: string;
    actorClubIds: string[];
    id: string;
    patch: {
      title?: string | null;
      summary?: string | null;
      body?: string | null;
    };
  },
): Promise<void> {
  const currentResult = await pool.query<ContentUpdatePreflightRow>(
    `select
       e.club_id,
       e.author_member_id,
       cev.title,
       cev.summary,
       cev.body,
       cev.id as version_id
     from contents e
     join current_content_versions cev on cev.content_id = e.id
     where e.id = $1
       and e.archived_at is null
       and e.deleted_at is null
       and cev.state = 'published'`,
    [input.id],
  );
  const current = currentResult.rows[0];
  if (!current || !input.actorClubIds.includes(current.club_id)) {
    throw new AppError('content_not_found', 'Content not found inside the actor scope');
  }
  if (current.author_member_id !== input.actorMemberId) {
    throw new AppError('forbidden_scope', 'Only the original author may update this content.');
  }

  const changedFields: ContentMentionField[] = [];
  const nextTitle = input.patch.title !== undefined ? input.patch.title : current.title;
  const nextSummary = input.patch.summary !== undefined ? input.patch.summary : current.summary;
  const nextBody = input.patch.body !== undefined ? input.patch.body : current.body;

  if (nextTitle !== current.title) changedFields.push('title');
  if (nextSummary !== current.summary) changedFields.push('summary');
  if (nextBody !== current.body) changedFields.push('body');
  if (changedFields.length === 0) return;

  const extracted = extractContentMentionCandidates({
    title: changedFields.includes('title') ? nextTitle : null,
    summary: changedFields.includes('summary') ? nextSummary : null,
    body: changedFields.includes('body') ? nextBody : null,
  });

  if (extracted.title.length === 0 && extracted.summary.length === 0 && extracted.body.length === 0) return;

  const existingMentions = await loadEntityVersionMentionsForVersion(pool, current.version_id, {
    memberId: input.actorMemberId,
  });
  const changedMentions = await resolvePublicContentMentions(pool, extracted, {
    memberId: input.actorMemberId,
  });
  const mergedMentions: ContentMentionsByField = {
    title: changedFields.includes('title') ? changedMentions.title : existingMentions.title,
    summary: changedFields.includes('summary') ? changedMentions.summary : existingMentions.summary,
    body: changedFields.includes('body') ? changedMentions.body : existingMentions.body,
  };
  const changedFieldSpanCount = changedMentions.title.length + changedMentions.summary.length + changedMentions.body.length;
  applyContentMentionLimitsForUpdate(mergedMentions, changedFieldSpanCount);
}
