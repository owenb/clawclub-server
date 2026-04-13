import type { Pool } from 'pg';
import type { DbClient } from './db.ts';
import { AppError, type IncludedBundle, type IncludedMember, type MentionSpan } from './contract.ts';
import { HANDLE_REGEX } from './identity/handles.ts';

export type ContentMentionField = 'title' | 'summary' | 'body';

export type ContentMentionsByField = {
  title: MentionSpan[];
  summary: MentionSpan[];
  body: MentionSpan[];
};

type ExtractedMention = {
  authoredHandle: string;
  start: number;
  end: number;
};

type ExtractedContentMentions = {
  title: ExtractedMention[];
  summary: ExtractedMention[];
  body: ExtractedMention[];
};

type ContentMentionRow = {
  entity_version_id: string;
  field: ContentMentionField;
  start_offset: number;
  end_offset: number;
  mentioned_member_id: string;
  authored_handle: string;
};

type DmMentionRow = {
  message_id: string;
  start_offset: number;
  end_offset: number;
  mentioned_member_id: string;
  authored_handle: string;
};

type IncludedMemberRow = {
  member_id: string;
  public_name: string;
  display_name: string;
  handle: string | null;
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
const URL_PREFIX_RE = /(?:https?:\/\/|mailto:)[^\s]+/g;

function isAllowedMentionBoundary(char: string | undefined): boolean {
  return char === undefined
    || /\s/.test(char)
    || char === '('
    || char === '['
    || char === '{'
    || char === '"'
    || char === '\''
    || char === '`';
}

function isHandleTokenChar(char: string | undefined): boolean {
  return char !== undefined && /[a-z0-9-]/.test(char);
}

function maskUrls(text: string): string {
  return text.replace(URL_PREFIX_RE, (match) => ' '.repeat(match.length));
}

function formatInvalidHandles(handles: string[]): string {
  return handles.map((handle) => `@${handle}`).join(', ');
}

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
  return texts.some((text) => typeof text === 'string' && text.includes('@'));
}

export function extractMentionCandidates(text: string | null | undefined): ExtractedMention[] {
  if (!text || !text.includes('@')) return [];

  const masked = maskUrls(text);
  const mentions: ExtractedMention[] = [];

  for (let index = 0; index < masked.length; index += 1) {
    if (masked[index] !== '@') continue;
    if (!isAllowedMentionBoundary(masked[index - 1])) continue;

    let cursor = index + 1;
    while (isHandleTokenChar(masked[cursor])) {
      cursor += 1;
    }

    const authoredHandle = masked.slice(index + 1, cursor);
    if (!HANDLE_REGEX.test(authoredHandle)) continue;

    mentions.push({
      authoredHandle,
      start: index,
      end: index + 1 + authoredHandle.length,
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

function assertMentionLimits(uniqueMembers: number, spanCount: number, context: 'content' | 'message', changedFieldSpanCount?: number): void {
  if (context === 'content') {
    if ((uniqueMembers > MAX_UNIQUE_MENTIONED_MEMBERS || spanCount > MAX_MENTION_SPANS) && (changedFieldSpanCount ?? spanCount) > 0) {
      throw new AppError(
        400,
        'invalid_input',
        `A content version may contain at most ${MAX_UNIQUE_MENTIONED_MEMBERS} unique mentions and ${MAX_MENTION_SPANS} mention spans.`,
      );
    }
    return;
  }

  if (uniqueMembers > MAX_UNIQUE_MENTIONED_MEMBERS || spanCount > MAX_MENTION_SPANS) {
    throw new AppError(
      400,
      'invalid_input',
      `A direct message may contain at most ${MAX_UNIQUE_MENTIONED_MEMBERS} unique mentions and ${MAX_MENTION_SPANS} mention spans.`,
    );
  }
}

function buildInvalidMentionsError(scope: 'club' | 'conversation', handles: string[]): AppError {
  return new AppError(
    400,
    'invalid_mentions',
    scope === 'club'
      ? `These mentions do not resolve in this club: ${formatInvalidHandles(handles)}`
      : `These mentions do not resolve in this conversation: ${formatInvalidHandles(handles)}`,
  );
}

function uniqueHandlesInOrder(mentions: ExtractedMention[]): string[] {
  const seen = new Set<string>();
  const handles: string[] = [];
  for (const mention of mentions) {
    if (seen.has(mention.authoredHandle)) continue;
    seen.add(mention.authoredHandle);
    handles.push(mention.authoredHandle);
  }
  return handles;
}

function mapResolvedMentions(
  mentions: ExtractedMention[],
  memberIdByHandle: Map<string, string>,
): MentionSpan[] {
  return mentions.map((mention) => ({
    memberId: memberIdByHandle.get(mention.authoredHandle)!,
    authoredHandle: mention.authoredHandle,
    start: mention.start,
    end: mention.end,
  }));
}

export async function loadIncludedMembers(client: DbClient, memberIds: string[]): Promise<IncludedBundle> {
  if (memberIds.length === 0) return emptyIncludedBundle();

  const result = await client.query<IncludedMemberRow>(
    `select id as member_id, public_name, display_name, handle
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
      handle: row.handle,
    };
  }

  return { membersById };
}

async function resolvePublicHandles(client: DbClient, handles: string[], clubId: string): Promise<Map<string, string>> {
  if (handles.length === 0) return new Map();

  const result = await client.query<{ member_id: string; handle: string }>(
    `select m.id as member_id, m.handle
     from members m
     join accessible_club_memberships acm on acm.member_id = m.id
     where m.handle = any($1::text[])
       and m.state = 'active'
       and acm.club_id = $2`,
    [handles, clubId],
  );

  return new Map(result.rows.map((row) => [row.handle, row.member_id]));
}

export async function resolvePublicContentMentions(
  client: DbClient,
  extracted: ExtractedContentMentions,
  clubId: string,
): Promise<ContentMentionsByField> {
  const handles = uniqueHandlesInOrder([...extracted.title, ...extracted.summary, ...extracted.body]);
  const memberIdByHandle = await resolvePublicHandles(client, handles, clubId);
  const invalid = handles.filter((handle) => !memberIdByHandle.has(handle));
  if (invalid.length > 0) {
    throw buildInvalidMentionsError('club', invalid);
  }

  const mentions = {
    title: mapResolvedMentions(extracted.title, memberIdByHandle),
    summary: mapResolvedMentions(extracted.summary, memberIdByHandle),
    body: mapResolvedMentions(extracted.body, memberIdByHandle),
  } satisfies ContentMentionsByField;

  const uniqueMembers = new Set([...mentions.title, ...mentions.summary, ...mentions.body].map((mention) => mention.memberId)).size;
  const spanCount = mentions.title.length + mentions.summary.length + mentions.body.length;
  assertMentionLimits(uniqueMembers, spanCount, 'content');
  return mentions;
}

export async function resolveDirectMessageMentions(
  client: DbClient,
  messageText: string,
  participantIds: string[],
  sharedClubIds: string[],
): Promise<MentionSpan[]> {
  const extracted = extractMentionCandidates(messageText);
  const handles = uniqueHandlesInOrder(extracted);
  if (handles.length === 0) return [];

  // Active thread participants bypass the shared-club requirement, but not the
  // active-member requirement. Third-party mentions must satisfy both.
  const result = await client.query<{ member_id: string; handle: string }>(
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
    [handles, participantIds, sharedClubIds],
  );

  const memberIdByHandle = new Map(result.rows.map((row) => [row.handle, row.member_id]));
  const invalid = handles.filter((handle) => !memberIdByHandle.has(handle));
  if (invalid.length > 0) {
    throw buildInvalidMentionsError('conversation', invalid);
  }

  const mentions = mapResolvedMentions(extracted, memberIdByHandle);
  const uniqueMembers = new Set(mentions.map((mention) => mention.memberId)).size;
  assertMentionLimits(uniqueMembers, mentions.length, 'message');
  return mentions;
}

export async function insertEntityVersionMentions(
  client: DbClient,
  entityVersionId: string,
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
    params.push(entityVersionId, row.field, row.start, row.end, row.memberId, row.authoredHandle);
    index += 6;
  }

  await client.query(
    `insert into entity_version_mentions (
       entity_version_id, field, start_offset, end_offset, mentioned_member_id, authored_handle
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
    params.push(messageId, mention.start, mention.end, mention.memberId, mention.authoredHandle);
    index += 5;
  }

  await client.query(
    `insert into dm_message_mentions (
       message_id, start_offset, end_offset, mentioned_member_id, authored_handle
     ) values ${values.join(', ')}`,
    params,
  );
}

export async function loadEntityVersionMentions(
  client: DbClient,
  entityVersionIds: string[],
): Promise<{ mentionsByVersionId: Map<string, ContentMentionsByField>; included: IncludedBundle }> {
  const mentionsByVersionId = new Map<string, ContentMentionsByField>();
  if (entityVersionIds.length === 0) {
    return { mentionsByVersionId, included: emptyIncludedBundle() };
  }

  const result = await client.query<ContentMentionRow>(
    `select entity_version_id, field, start_offset, end_offset, mentioned_member_id, authored_handle
     from entity_version_mentions
     where entity_version_id = any($1::text[])
     order by entity_version_id, field, start_offset`,
    [entityVersionIds],
  );

  const memberIds = new Set<string>();
  for (const row of result.rows) {
    memberIds.add(row.mentioned_member_id);
    if (!mentionsByVersionId.has(row.entity_version_id)) {
      mentionsByVersionId.set(row.entity_version_id, emptyContentMentions());
    }
    mentionsByVersionId.get(row.entity_version_id)![row.field].push({
      memberId: row.mentioned_member_id,
      authoredHandle: row.authored_handle,
      start: row.start_offset,
      end: row.end_offset,
    });
  }

  return {
    mentionsByVersionId,
    included: await loadIncludedMembers(client, [...memberIds]),
  };
}

export async function loadEntityVersionMentionsForVersion(
  client: DbClient,
  entityVersionId: string,
): Promise<ContentMentionsByField> {
  const { mentionsByVersionId } = await loadEntityVersionMentions(client, [entityVersionId]);
  return mentionsByVersionId.get(entityVersionId) ?? emptyContentMentions();
}

export async function copyEntityVersionMentions(
  client: DbClient,
  oldVersionId: string,
  newVersionId: string,
  fields: ContentMentionField[],
): Promise<void> {
  if (fields.length === 0) return;

  await client.query(
    `insert into entity_version_mentions (
       entity_version_id, field, start_offset, end_offset, mentioned_member_id, authored_handle
     )
     select
       $2,
       field,
       start_offset,
       end_offset,
       mentioned_member_id,
       authored_handle
     from entity_version_mentions
     where entity_version_id = $1
       and field = any($3::text[])`,
    [oldVersionId, newVersionId, fields],
  );
}

export async function loadDmMentions(
  client: DbClient,
  messageIds: string[],
): Promise<{ mentionsByMessageId: Map<string, MentionSpan[]>; included: IncludedBundle }> {
  const mentionsByMessageId = new Map<string, MentionSpan[]>();
  if (messageIds.length === 0) {
    return { mentionsByMessageId, included: emptyIncludedBundle() };
  }

  const result = await client.query<DmMentionRow>(
    `select message_id, start_offset, end_offset, mentioned_member_id, authored_handle
     from dm_message_mentions
     where message_id = any($1::text[])
     order by message_id, start_offset`,
    [messageIds],
  );

  const memberIds = new Set<string>();
  for (const row of result.rows) {
    memberIds.add(row.mentioned_member_id);
    if (!mentionsByMessageId.has(row.message_id)) {
      mentionsByMessageId.set(row.message_id, []);
    }
    mentionsByMessageId.get(row.message_id)!.push({
      memberId: row.mentioned_member_id,
      authoredHandle: row.authored_handle,
      start: row.start_offset,
      end: row.end_offset,
    });
  }

  return {
    mentionsByMessageId,
    included: await loadIncludedMembers(client, [...memberIds]),
  };
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
      throw new AppError(404, 'not_found', 'Thread not found inside the actor scope');
    }
  }
  if (!input.actorClubIds.includes(clubId)) {
    throw new AppError(
      input.threadId ? 404 : 403,
      input.threadId ? 'not_found' : 'forbidden',
      input.threadId ? 'Thread not found inside the actor scope' : 'Requested club is outside your access scope',
    );
  }

  if (!hasPotentialMentionChar(input.title, input.summary, input.body)) return;

  if (input.clientKey) {
    const existing = await pool.query<{ id: string }>(
      `select id
       from entities
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
  await resolvePublicContentMentions(pool, extracted, clubId);
}

export async function preflightContentUpdateMentions(
  pool: Pool,
  input: {
    actorMemberId: string;
    actorClubIds: string[];
    entityId: string;
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
     from entities e
     join current_entity_versions cev on cev.entity_id = e.id
     where e.id = $1
       and e.archived_at is null
       and e.deleted_at is null
       and cev.state = 'published'`,
    [input.entityId],
  );
  const current = currentResult.rows[0];
  if (!current || current.author_member_id !== input.actorMemberId) {
    throw new AppError(404, 'not_found', 'Entity not found inside the actor scope');
  }
  if (!input.actorClubIds.includes(current.club_id)) {
    throw new AppError(404, 'not_found', 'Entity not found inside the actor scope');
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

  const existingMentions = await loadEntityVersionMentionsForVersion(pool, current.version_id);
  const changedMentions = await resolvePublicContentMentions(pool, extracted, current.club_id);
  const mergedMentions: ContentMentionsByField = {
    title: changedFields.includes('title') ? changedMentions.title : existingMentions.title,
    summary: changedFields.includes('summary') ? changedMentions.summary : existingMentions.summary,
    body: changedFields.includes('body') ? changedMentions.body : existingMentions.body,
  };
  const changedFieldSpanCount = changedMentions.title.length + changedMentions.summary.length + changedMentions.body.length;
  applyContentMentionLimitsForUpdate(mergedMentions, changedFieldSpanCount);
}
