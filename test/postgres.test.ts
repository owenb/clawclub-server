import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/contract.ts';
import { createPostgresRepository } from '../src/postgres.ts';

test('postgres repository lists clubs for superadmin scope including archived ones on request', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];

  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [], rowCount: 0 };
      if (sql.includes("set_config('app.actor_member_id'")) return { rows: [{ set_config: 'member-1' }], rowCount: 1 };
      if (sql.includes('from app.clubs n') && sql.includes('where ($1::boolean = true or n.archived_at is null)')) {
        return {
          rows: [{
            club_id: 'club-1', slug: 'alpha', name: 'Alpha', summary: 'First club',
            archived_at: '2026-03-12T01:00:00Z', owner_member_id: 'member-1', owner_public_name: 'Member One', owner_handle: 'member-one', owner_email: 'one@example.com',
            owner_version_no: 2, owner_created_at: '2026-03-12T00:30:00Z', owner_created_by_member_id: 'member-1',
          }], rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };

  const repository = createPostgresRepository({ pool: { connect: async () => client } as any });
  const results = await repository.listClubs({ actorMemberId: 'member-1', includeArchived: true });

  assert.equal(results[0]?.clubId, 'club-1');
  assert.equal(results[0]?.archivedAt, '2026-03-12T01:00:00Z');
  assert.equal(results[0]?.ownerVersion.versionNo, 2);
  assert.deepEqual(calls[1]?.params, ['member-1']);
  assert.deepEqual(calls[2]?.params, [true]);
});

test('postgres repository creates, archives, and reassigns club owners through superadmin scope', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];

  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [], rowCount: 0 };
      if (sql.includes("set_config('app.actor_member_id'")) return { rows: [{ set_config: 'member-1' }], rowCount: 1 };
      if (sql.includes('with owner_member as (')) return { rows: [{ club_id: 'club-9' }], rowCount: 1 };
      if (sql.includes("update app.clubs n\n            set archived_at = coalesce")) return { rows: [{ club_id: 'club-9' }], rowCount: 1 };
      if (sql.includes('select') && sql.includes('join app.current_club_owners cno on cno.club_id = n.id') && sql.includes('join app.members m on m.id = $2')) {
        return { rows: [{ club_id: 'club-9', current_owner_version_id: 'owner-1', current_version_no: 1 }], rowCount: 1 };
      }
      if (sql.includes('insert into app.club_owner_versions')) return { rows: [], rowCount: 1 };
      if (sql.includes('from app.clubs n') && sql.includes('where n.id = $1')) {
        return {
          rows: [{
            club_id: 'club-9', slug: 'gamma', name: 'Gamma', summary: 'Third club',
            archived_at: null, owner_member_id: 'member-9', owner_public_name: 'Member Nine', owner_handle: 'member-nine', owner_email: 'nine@example.com',
            owner_version_no: 2, owner_created_at: '2026-03-12T01:00:00Z', owner_created_by_member_id: 'member-1',
          }], rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };

  const repository = createPostgresRepository({ pool: { connect: async () => client } as any });
  const created = await repository.createClub({ actorMemberId: 'member-1', slug: 'gamma', name: 'Gamma', summary: 'Third club', ownerMemberId: 'member-9' });
  const archived = await repository.archiveClub({ actorMemberId: 'member-1', clubId: 'club-9' });
  const reassigned = await repository.assignClubOwner({ actorMemberId: 'member-1', clubId: 'club-9', ownerMemberId: 'member-9' });

  assert.equal(created?.clubId, 'club-9');
  assert.equal(archived?.clubId, 'club-9');
  assert.equal(reassigned?.owner.memberId, 'member-9');
  assert.equal(reassigned?.ownerVersion.versionNo, 2);
});

test('postgres repository updates an entity only when the actor is the author inside scope', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];

  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });

      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') {
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes("set_config('app.actor_member_id'")) {
        return { rows: [{ set_config: 'member-1' }], rowCount: 1 };
      }

      if (sql.includes('join app.current_entity_versions cev on cev.entity_id = e.id') && sql.includes('and e.author_member_id = $3')) {
        return {
          rows: [{
            entity_id: 'entity-1',
            club_id: 'club-2',
            author_member_id: 'member-1',
            version_id: 'entity-version-1',
            version_no: 1,
            title: 'Hello',
            summary: 'Summary',
            body: 'Body',
            expires_at: null,
            content: { mood: 'steady' },
          }],
          rowCount: 1,
        };
      }

      if (sql.includes('insert into app.entity_versions') && sql.includes(`'published'`)) {
        return { rows: [{ id: 'entity-version-2' }], rowCount: 1 };
      }

      if (sql.includes('insert into app.club_activity (')) {
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes('from app.entities e') && sql.includes('and ($2::app.short_id is null or cev.id = $2)')) {
        return {
          rows: [{
            entity_id: 'entity-1',
            entity_version_id: 'entity-version-2',
            club_id: 'club-2',
            kind: 'post',
            author_member_id: 'member-1',
            author_public_name: 'Member One',
            author_handle: 'member-one',
            version_no: 2,
            state: 'published',
            title: 'Hello',
            summary: 'Updated summary',
            body: 'Updated body',
            effective_at: '2026-03-14T12:00:00Z',
            expires_at: null,
            version_created_at: '2026-03-14T12:00:00Z',
            content: { mood: 'fresher' },
            entity_created_at: '2026-03-12T00:00:00Z',
          }],
          rowCount: 1,
        };
      }

      if (sql.includes('embeddings_enqueue_job')) {
        return { rows: [], rowCount: 0 };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };

  const repository = createPostgresRepository({ pool: { connect: async () => client } as any });
  const updated = await repository.updateEntity?.({
    actorMemberId: 'member-1',
    accessibleClubIds: ['club-2'],
    entityId: 'entity-1',
    patch: {
      title: undefined,
      summary: 'Updated summary',
      body: 'Updated body',
      expiresAt: undefined,
      content: { mood: 'fresher' },
    },
  });

  assert.equal(updated?.entityId, 'entity-1');
  assert.equal(updated?.entityVersionId, 'entity-version-2');
  assert.equal(updated?.version.versionNo, 2);
  assert.deepEqual(calls[1]?.params, ['member-1']);
  assert.deepEqual(calls[2]?.params, ['entity-1', ['club-2'], 'member-1']);
});

test('postgres repository archives an entity by appending an archived version without mutating root rows directly', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];

  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });

      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') {
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes("set_config('app.actor_member_id'")) {
        return { rows: [{ set_config: 'member-1' }], rowCount: 1 };
      }

      if (sql === `select now()::text as archived_at`) {
        return { rows: [{ archived_at: '2026-03-14T12:00:00Z' }], rowCount: 1 };
      }

      if (sql.includes('join app.current_entity_versions cev on cev.entity_id = e.id') && sql.includes("e.kind = any(array['post', 'opportunity', 'service', 'ask']::app.entity_kind[])")) {
        return {
          rows: [{
            entity_id: 'entity-1',
            club_id: 'club-2',
            kind: 'post',
            author_member_id: 'member-1',
            author_public_name: 'Member One',
            author_handle: 'member-one',
            entity_created_at: '2026-03-12T00:00:00Z',
            version_id: 'entity-version-2',
            version_no: 2,
            title: 'Hello',
            summary: 'Summary',
            body: 'Body',
            expires_at: '2026-04-01T00:00:00Z',
            content: { mood: 'steady' },
          }],
          rowCount: 1,
        };
      }

      if (sql.includes('insert into app.entity_versions') && sql.includes(`'archived'`)) {
        return { rows: [{ id: 'entity-version-3' }], rowCount: 1 };
      }

      if (sql.includes('insert into app.club_activity (')) {
        return { rows: [], rowCount: 1 };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };

  const repository = createPostgresRepository({ pool: { connect: async () => client } as any });
  const archived = await repository.archiveEntity?.({
    actorMemberId: 'member-1',
    accessibleClubIds: ['club-2'],
    entityId: 'entity-1',
  });

  assert.equal(archived?.entityId, 'entity-1');
  assert.equal(archived?.entityVersionId, 'entity-version-3');
  assert.equal(archived?.version.versionNo, 3);
  assert.equal(archived?.version.state, 'archived');
  assert.equal(archived?.version.effectiveAt, '2026-03-14T12:00:00Z');
  assert.equal(archived?.version.expiresAt, '2026-04-01T00:00:00Z');
  assert.deepEqual(calls[1]?.params, ['member-1']);
  assert.deepEqual(calls[2]?.params, ['entity-1', ['club-2'], 'member-1']);
  assert.deepEqual(calls[4]?.params, [
    'entity-1',
    3,
    'Hello',
    'Summary',
    'Body',
    '2026-03-14T12:00:00Z',
    '2026-04-01T00:00:00Z',
    '{"mood":"steady"}',
    'entity-version-2',
    'member-1',
  ]);
  assert.equal(calls.some((call) => call.sql.includes('update app.entities')), false);
});

test('postgres repository createEntity throws a missing_row AppError when the root insert returns nothing', async () => {
  const client = {
    async query(sql: string) {
      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') {
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes("set_config('app.actor_member_id'")) {
        return { rows: [{ set_config: 'member-1' }], rowCount: 1 };
      }

      if (sql.includes('insert into app.entities')) {
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes('club_quota_policies') || sql.includes('count_member_writes_today')) {
        return { rows: [], rowCount: 0 };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };

  const repository = createPostgresRepository({ pool: { connect: async () => client } as any });

  await assert.rejects(
    () => repository.createEntity({
      authorMemberId: 'member-1',
      clubId: 'club-2',
      kind: 'post',
      title: 'Hello',
      summary: null,
      body: 'Body',
      expiresAt: null,
      content: {},
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 500);
      assert.equal(error.code, 'missing_row');
      assert.equal(error.message, 'Created entity row was not returned');
      return true;
    },
  );
});

test('postgres repository createEntity throws a missing_row AppError when the created entity cannot be reloaded', async () => {
  const client = {
    async query(sql: string) {
      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') {
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes("set_config('app.actor_member_id'")) {
        return { rows: [{ set_config: 'member-1' }], rowCount: 1 };
      }

      if (sql.includes('insert into app.entities')) {
        return { rows: [{ id: 'entity-1', created_at: '2026-03-14T12:00:00Z' }], rowCount: 1 };
      }

      if (sql.includes('insert into app.entity_versions') && sql.includes(`'published'`)) {
        return { rows: [{ id: 'entity-version-1' }], rowCount: 1 };
      }

      if (sql.includes('from app.entities e') && sql.includes('join app.current_entity_versions cev on cev.entity_id = e.id')) {
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes('club_quota_policies') || sql.includes('count_member_writes_today')) {
        return { rows: [], rowCount: 0 };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };

  const repository = createPostgresRepository({ pool: { connect: async () => client } as any });

  await assert.rejects(
    () => repository.createEntity({
      authorMemberId: 'member-1',
      clubId: 'club-2',
      kind: 'post',
      title: 'Hello',
      summary: null,
      body: 'Body',
      expiresAt: null,
      content: {},
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 500);
      assert.equal(error.code, 'missing_row');
      assert.equal(error.message, 'Created entity could not be reloaded');
      return true;
    },
  );
});

test('postgres repository updateEntity throws a missing_row AppError when the updated entity cannot be reloaded', async () => {
  const client = {
    async query(sql: string) {
      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') {
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes("set_config('app.actor_member_id'")) {
        return { rows: [{ set_config: 'member-1' }], rowCount: 1 };
      }

      if (sql.includes('join app.current_entity_versions cev on cev.entity_id = e.id') && sql.includes('and e.author_member_id = $3')) {
        return {
          rows: [{
            entity_id: 'entity-1',
            club_id: 'club-2',
            author_member_id: 'member-1',
            version_id: 'entity-version-1',
            version_no: 1,
            title: 'Hello',
            summary: 'Summary',
            body: 'Body',
            expires_at: null,
            content: { mood: 'steady' },
          }],
          rowCount: 1,
        };
      }

      if (sql.includes('insert into app.entity_versions') && sql.includes(`'published'`)) {
        return { rows: [{ id: 'entity-version-2' }], rowCount: 1 };
      }

      if (sql.includes('from app.entities e') && sql.includes('join app.current_entity_versions cev on cev.entity_id = e.id')) {
        return { rows: [], rowCount: 0 };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };

  const repository = createPostgresRepository({ pool: { connect: async () => client } as any });

  await assert.rejects(
    () => repository.updateEntity?.({
      actorMemberId: 'member-1',
      accessibleClubIds: ['club-2'],
      entityId: 'entity-1',
      patch: {
        title: undefined,
        summary: 'Updated summary',
        body: undefined,
        expiresAt: undefined,
        content: undefined,
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 500);
      assert.equal(error.code, 'missing_row');
      assert.equal(error.message, 'Updated entity could not be reloaded');
      return true;
    },
  );
});

test('postgres repository lists active members with scoped membership context', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];

  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });

      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') {
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes("set_config('app.actor_member_id'")) {
        return { rows: [{ set_config: 'member-1' }], rowCount: 1 };
      }

      if (sql.includes('jsonb_agg(') && sql.includes('as memberships')) {
        return {
          rows: [
            {
              member_id: 'member-2',
              public_name: 'Member Two',
              display_name: 'Member Two',
              handle: 'member-two',
              tagline: 'Ships things',
              summary: 'Helpful builder',
              what_i_do: 'Backend systems',
              known_for: 'Moving fast without chaos',
              services_summary: 'Advisory',
              website_url: 'https://example.test/two',
              memberships: [
                {
                  membershipId: 'membership-2',
                  clubId: 'club-2',
                  slug: 'beta',
                  name: 'Beta',
                  summary: 'Second club',
                  role: 'member',
                  status: 'active',
                  sponsorMemberId: 'member-1',
                  joinedAt: '2026-03-12T00:00:00Z',
                },
              ],
            },
          ],
          rowCount: 1,
        };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };

  const repository = createPostgresRepository({ pool: { connect: async () => client } as any });
  const results = await repository.listMembers({
    actorMemberId: 'member-1',
    clubIds: ['club-2'],
    limit: 5,
  });

  assert.equal(results.length, 1);
  assert.equal(results[0]?.memberId, 'member-2');
  assert.equal(results[0]?.memberships[0]?.clubId, 'club-2');
  assert.match(calls[2]?.sql ?? '', /join app\.accessible_club_memberships anm/);
  assert.deepEqual(calls[2]?.params, [['club-2'], 5]);
});

test('postgres repository projects actor scope into the db session before dm reads', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];

  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });

      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') {
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes("set_config('app.actor_member_id'")) {
        return { rows: [{ set_config: 'member-1' }], rowCount: 1 };
      }

      if (sql.includes('with scope as (')) {
        return {
          rows: [
            {
              thread_id: 'thread-1',
              club_id: 'club-1',
              counterpart_member_id: 'member-2',
              counterpart_public_name: 'Member Two',
              counterpart_handle: 'member-two',
              latest_message_id: 'message-1',
              latest_sender_member_id: 'member-2',
              latest_role: 'member',
              latest_message_text: 'hello',
              latest_created_at: '2026-03-12T00:00:00Z',
              message_count: 1,
            },
          ],
          rowCount: 1,
        };
      }

      if (sql.includes('coalesce(receipts.update_receipts')) {
        return {
          rows: [
            {
              message_id: 'message-1',
              thread_id: 'thread-1',
              sender_member_id: 'member-2',
              role: 'member',
              message_text: 'hello',
              payload: {},
              created_at: '2026-03-12T00:00:00Z',
              in_reply_to_message_id: null,
              update_receipts: [
                {
                  updateId: 'update-1',
                  recipientMemberId: 'member-1',
                  topic: 'dm.message.created',
                  createdAt: '2026-03-12T00:00:00Z',
                  receipt: {
                    receiptId: 'receipt-1',
                    state: 'processed',
                    suppressionReason: null,
                    versionNo: 1,
                    createdAt: '2026-03-12T00:00:06Z',
                    createdByMemberId: 'member-1',
                  },
                },
              ],
            },
          ],
          rowCount: 1,
        };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };

  const pool = {
    async connect() {
      return client;
    },
  };

  const repository = createPostgresRepository({ pool: pool as any });
  const results = await repository.listDirectMessageThreads({
    actorMemberId: 'member-1',
    clubIds: ['club-1', 'club-2'],
    limit: 5,
  });

  assert.equal(results.length, 1);
  assert.equal(results[0]?.threadId, 'thread-1');
  assert.equal(calls[0]?.sql, 'begin');
  assert.match(calls[1]?.sql ?? '', /set_config\('app\.actor_member_id'/);
  assert.deepEqual(calls[1]?.params, ['member-1']);
  assert.match(calls[2]?.sql ?? '', /with scope as \(/);
  assert.equal(calls.at(-1)?.sql, 'commit');
});


test('postgres repository stitches current update receipt state into DM reads', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];

  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });

      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') {
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes("set_config('app.actor_member_id'")) {
        return { rows: [{ set_config: 'member-1' }], rowCount: 1 };
      }

      if (sql.includes('with thread_scope as (')) {
        return {
          rows: [
            {
              thread_id: 'thread-1',
              club_id: 'club-2',
              counterpart_member_id: 'member-2',
              counterpart_public_name: 'Member Two',
              counterpart_handle: 'member-two',
              latest_message_id: 'message-2',
              latest_sender_member_id: 'member-1',
              latest_role: 'member',
              latest_message_text: 'Later',
              latest_created_at: '2026-03-12T00:02:00Z',
              message_count: 2,
            },
          ],
          rowCount: 1,
        };
      }

      if (sql.includes('coalesce(receipts.update_receipts')) {
        return {
          rows: [
            {
              message_id: 'message-1',
              thread_id: 'thread-1',
              sender_member_id: 'member-2',
              role: 'member',
              message_text: 'Earlier',
              payload: {},
              created_at: '2026-03-12T00:01:00Z',
              in_reply_to_message_id: null,
              update_receipts: [
                {
                  updateId: 'update-1',
                  recipientMemberId: 'member-1',
                  topic: 'dm.message.created',
                  createdAt: '2026-03-12T00:01:00Z',
                  receipt: {
                    receiptId: 'receipt-1',
                    state: 'processed',
                    suppressionReason: null,
                    versionNo: 1,
                    createdAt: '2026-03-12T00:01:06Z',
                    createdByMemberId: 'member-1',
                  },
                },
              ],
            },
            {
              message_id: 'message-2',
              thread_id: 'thread-1',
              sender_member_id: 'member-1',
              role: 'member',
              message_text: 'Later',
              payload: {},
              created_at: '2026-03-12T00:02:00Z',
              in_reply_to_message_id: 'message-1',
              update_receipts: [
                {
                  updateId: 'update-2',
                  recipientMemberId: 'member-2',
                  topic: 'dm.message.created',
                  createdAt: '2026-03-12T00:02:00Z',
                  receipt: null,
                },
              ],
            },
          ],
          rowCount: 2,
        };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };

  const pool = {
    async connect() {
      return client;
    },
  };

  const repository = createPostgresRepository({ pool: pool as any });
  const result = await repository.readDirectMessageThread({
    actorMemberId: 'member-1',
    accessibleClubIds: ['club-2'],
    threadId: 'thread-1',
    limit: 5,
  });

  assert.ok(result);
  assert.equal(result?.thread.threadId, 'thread-1');
  assert.equal(result?.messages.length, 2);
  assert.equal(result?.messages.find((message) => message.messageId === 'message-1')?.updateReceipts[0]?.receipt?.state, 'processed');
  assert.equal(result?.messages.find((message) => message.messageId === 'message-2')?.updateReceipts[0]?.recipientMemberId, 'member-2');
  assert.equal(calls[0]?.sql, 'begin');
  assert.match(calls[1]?.sql ?? '', /set_config\('app\.actor_member_id'/);
  assert.deepEqual(calls[1]?.params, ['member-1']);
  assert.match(calls[2]?.sql ?? '', /with thread_scope as \(/);
  assert.match(calls[3]?.sql ?? '', /coalesce\(receipts\.update_receipts/);
  assert.equal(calls.at(-1)?.sql, 'commit');
});

test('postgres repository projects actor scope into the db session before inbox reads', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];

  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });

      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') {
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes("set_config('app.actor_member_id'")) {
        return { rows: [{ set_config: 'member-1' }], rowCount: 1 };
      }

      if (sql.includes('from app.current_dm_inbox_threads inbox')) {
        return {
          rows: [
            {
              thread_id: 'thread-1',
              club_id: 'club-2',
              counterpart_member_id: 'member-2',
              counterpart_public_name: 'Member Two',
              counterpart_handle: 'member-two',
              latest_message_id: 'message-2',
              latest_sender_member_id: 'member-2',
              latest_role: 'member',
              latest_message_text: 'still waiting on your reply',
              latest_created_at: '2026-03-12T00:05:00Z',
              message_count: 4,
              unread_message_count: 2,
              unread_update_count: 3,
              latest_unread_message_created_at: '2026-03-12T00:05:00Z',
              has_unread: true,
            },
          ],
          rowCount: 1,
        };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };

  const pool = {
    async connect() {
      return client;
    },
  };

  const repository = createPostgresRepository({ pool: pool as any });
  const results = await repository.listDirectMessageInbox({
    actorMemberId: 'member-1',
    clubIds: ['club-2'],
    limit: 5,
    unreadOnly: true,
  });

  assert.equal(results.length, 1);
  assert.equal(results[0]?.threadId, 'thread-1');
  assert.equal(results[0]?.unread.unreadMessageCount, 2);
  assert.equal(calls[0]?.sql, 'begin');
  assert.match(calls[1]?.sql ?? '', /set_config\('app\.actor_member_id'/);
  assert.deepEqual(calls[1]?.params, ['member-1']);
  assert.match(calls[2]?.sql ?? '', /from app\.current_dm_inbox_threads inbox/);
  assert.deepEqual(calls[2]?.params, ['member-1', ['club-2'], true, 5]);
  assert.equal(calls.at(-1)?.sql, 'commit');
});

test('postgres repository creates and revokes hashed bearer tokens without returning the hash', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];

  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });

      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') {
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes("set_config('app.actor_member_id'")) {
        return { rows: [{ set_config: 'member-1' }], rowCount: 1 };
      }

      if (sql.includes('insert into app.member_bearer_tokens')) {
        return {
          rows: [
            {
              token_id: 'token-1',
              member_id: 'member-1',
              label: 'laptop',
              created_at: '2026-03-12T00:00:00Z',
              last_used_at: null,
              revoked_at: null,
              metadata: { device: 'mbp' },
            },
          ],
          rowCount: 1,
        };
      }

      if (sql.includes('update app.member_bearer_tokens mbt')) {
        return {
          rows: [
            {
              token_id: 'token-1',
              member_id: 'member-1',
              label: 'laptop',
              created_at: '2026-03-12T00:00:00Z',
              last_used_at: null,
              revoked_at: '2026-03-12T00:05:00Z',
              metadata: { device: 'mbp' },
            },
          ],
          rowCount: 1,
        };
      }

      if (sql.includes('count(*)') && sql.includes('member_bearer_tokens')) {
        return { rows: [{ count: '0' }], rowCount: 1 };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };

  const pool = {
    async connect() {
      return client;
    },
  };

  const repository = createPostgresRepository({ pool: pool as any });
  const created = await repository.createBearerToken({
    actorMemberId: 'member-1',
    label: 'laptop',
    metadata: { device: 'mbp' },
  });

  assert.equal(created.token.tokenId, 'token-1');
  assert.equal(created.token.memberId, 'member-1');
  assert.equal(created.token.label, 'laptop');
  assert.equal(created.bearerToken.startsWith('cc_live_token-1_'), false);
  assert.match(created.bearerToken, /^cc_live_[23456789abcdefghjkmnpqrstuvwxyz]{12}_[23456789abcdefghjkmnpqrstuvwxyz]{24}$/);
  assert.equal(calls.filter((call) => call.sql === 'begin').length, 1);
  assert.equal(calls.filter((call) => call.sql === 'commit').length, 1);
  // calls[2] = token count check, calls[3] = INSERT
  assert.match(calls[2]?.sql ?? '', /count\(\*\).*member_bearer_tokens/);
  assert.match(calls[3]?.sql ?? '', /insert into app\.member_bearer_tokens/);
  assert.equal((calls[3]?.params?.[0] as string).length, 12);
  assert.equal(calls[3]?.params?.[1], 'member-1');
  assert.equal(calls[3]?.params?.[2], 'laptop');
  assert.equal(typeof calls[3]?.params?.[3], 'string');
  assert.notEqual(calls[3]?.params?.[3], created.bearerToken);

  const revoked = await repository.revokeBearerToken({
    actorMemberId: 'member-1',
    tokenId: 'token-1',
  });

  assert.equal(revoked?.tokenId, 'token-1');
  assert.equal(revoked?.revokedAt, '2026-03-12T00:05:00Z');
  assert.equal(calls.filter((call) => call.sql === 'begin').length, 2);
  assert.equal(calls.filter((call) => call.sql === 'commit').length, 2);
  const revokeCall = [...calls].reverse().find((call) => /update app\.member_bearer_tokens mbt/.test(call.sql));
  assert.match(revokeCall?.sql ?? '', /update app\.member_bearer_tokens mbt/);
  assert.deepEqual(revokeCall?.params, ['token-1', 'member-1']);
});

test('postgres repository createBearerToken throws a missing_row AppError when insert returning is empty', async () => {
  const client = {
    async query(sql: string) {
      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') {
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes("set_config('app.actor_member_id'")) {
        return { rows: [{ set_config: 'member-1' }], rowCount: 1 };
      }

      if (sql.includes('count(*)') && sql.includes('member_bearer_tokens')) {
        return { rows: [{ count: '0' }], rowCount: 1 };
      }

      if (sql.includes('insert into app.member_bearer_tokens')) {
        return { rows: [], rowCount: 0 };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };

  const repository = createPostgresRepository({ pool: { connect: async () => client } as any });

  await assert.rejects(
    () => repository.createBearerToken({
      actorMemberId: 'member-1',
      label: 'laptop',
      metadata: {},
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 500);
      assert.equal(error.code, 'missing_row');
      assert.equal(error.message, 'Created bearer token row was not returned');
      return true;
    },
  );
});

test('postgres repository sendDirectMessage throws a missing_row AppError when the message insert returns nothing', async () => {
  const client = {
    async query(sql: string) {
      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') {
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes("set_config('app.actor_member_id'")) {
        return { rows: [{ set_config: 'member-1' }], rowCount: 1 };
      }

      if (sql.includes('with actor_scope as (')) {
        return { rows: [{ club_id: 'club-2' }], rowCount: 1 };
      }

      if (sql.includes('insert into app.dm_threads') && sql.includes('on conflict do nothing')) {
        return { rows: [{ id: 'thread-1' }], rowCount: 1 };
      }

      if (sql.includes('insert into app.dm_messages')) {
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes('club_quota_policies') || sql.includes('count_member_writes_today')) {
        return { rows: [], rowCount: 0 };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };

  const repository = createPostgresRepository({ pool: { connect: async () => client } as any });

  await assert.rejects(
    () => repository.sendDirectMessage({
      actorMemberId: 'member-1',
      accessibleClubIds: ['club-2'],
      recipientMemberId: 'member-2',
      messageText: 'hello',
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 500);
      assert.equal(error.code, 'missing_row');
      assert.equal(error.message, 'Direct message row was not returned');
      return true;
    },
  );
});

test('postgres repository sendDirectMessage reuses an existing DM thread after insert conflict', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];

  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });

      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') {
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes("set_config('app.actor_member_id'")) {
        return { rows: [{ set_config: 'member-1' }], rowCount: 1 };
      }

      if (sql.includes('with actor_scope as (')) {
        return { rows: [{ club_id: 'club-2' }], rowCount: 1 };
      }

      if (sql.includes('insert into app.dm_threads') && sql.includes('on conflict do nothing')) {
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes('select participant.thread_id as id')) {
        return { rows: [{ id: 'thread-1' }], rowCount: 1 };
      }

      if (sql.includes('insert into app.dm_messages')) {
        return { rows: [{ id: 'message-1', created_at: '2026-03-15T12:00:00Z' }], rowCount: 1 };
      }

      if (sql.includes('select public_name, handle')) {
        return { rows: [{ public_name: 'Member One', handle: 'member-one' }], rowCount: 1 };
      }

      if (sql.includes('insert into app.member_updates')) {
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes('club_quota_policies') || sql.includes('count_member_writes_today')) {
        return { rows: [], rowCount: 0 };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };

  const repository = createPostgresRepository({ pool: { connect: async () => client } as any });
  const message = await repository.sendDirectMessage({
    actorMemberId: 'member-1',
    accessibleClubIds: ['club-2'],
    recipientMemberId: 'member-2',
    messageText: 'hello',
  });

  assert.equal(message?.threadId, 'thread-1');
  assert.equal(message?.messageId, 'message-1');
  assert.equal(message?.updateCount, 1);
  const threadInsertCall = calls.find((c) => c.sql.includes('insert into app.dm_threads'));
  const threadLookupCall = calls.find((c) => c.sql.includes('select participant.thread_id as id'));
  assert.ok(threadInsertCall, 'expected a dm_threads INSERT');
  assert.ok(threadLookupCall, 'expected a thread_id lookup after insert conflict');
});

test('postgres repository sendDirectMessage throws a missing_row AppError when the sender profile row is missing', async () => {
  const client = {
    async query(sql: string) {
      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') {
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes("set_config('app.actor_member_id'")) {
        return { rows: [{ set_config: 'member-1' }], rowCount: 1 };
      }

      if (sql.includes('with actor_scope as (')) {
        return { rows: [{ club_id: 'club-2' }], rowCount: 1 };
      }

      if (sql.includes('insert into app.dm_threads') && sql.includes('on conflict do nothing')) {
        return { rows: [{ id: 'thread-1' }], rowCount: 1 };
      }

      if (sql.includes('insert into app.dm_messages')) {
        return { rows: [{ id: 'message-1', created_at: '2026-03-15T12:00:00Z' }], rowCount: 1 };
      }

      if (sql.includes('select public_name, handle')) {
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes('club_quota_policies') || sql.includes('count_member_writes_today')) {
        return { rows: [], rowCount: 0 };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };

  const repository = createPostgresRepository({ pool: { connect: async () => client } as any });

  await assert.rejects(
    () => repository.sendDirectMessage({
      actorMemberId: 'member-1',
      accessibleClubIds: ['club-2'],
      recipientMemberId: 'member-2',
      messageText: 'hello',
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 500);
      assert.equal(error.code, 'missing_row');
      assert.equal(error.message, 'Sender profile row was not returned for DM update fanout');
      return true;
    },
  );
});

test('postgres repository updateOwnProfile throws a missing_row AppError when the actor row disappears during update', async () => {
  const client = {
    async query(sql: string) {
      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') {
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes("set_config('app.actor_member_id'")) {
        return { rows: [{ set_config: 'member-1' }], rowCount: 1 };
      }

      if (sql.includes('from app.members m') && sql.includes('left join app.current_member_profiles')) {
        return { rows: [], rowCount: 0 };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };

  const repository = createPostgresRepository({ pool: { connect: async () => client } as any });

  await assert.rejects(
    () => repository.updateOwnProfile?.({
      actor: {
        member: {
          id: 'member-1',
          handle: 'member-one',
          publicName: 'Member One',
        },
        memberships: [],
        globalRoles: [],
      },
      patch: {},
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 500);
      assert.equal(error.code, 'missing_row');
      assert.equal(error.message, 'Actor member row disappeared during profile update');
      return true;
    },
  );
});

test('postgres repository createEvent throws a missing_row AppError when the created event cannot be reloaded', async () => {
  const client = {
    async query(sql: string) {
      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') {
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes("set_config('app.actor_member_id'")) {
        return { rows: [{ set_config: 'member-1' }], rowCount: 1 };
      }

      if (sql.includes(`insert into app.entities (club_id, kind, author_member_id) values ($1, 'event', $2)`)) {
        return { rows: [{ id: 'event-entity-1' }], rowCount: 1 };
      }

      if (sql.includes('insert into app.entity_versions') && sql.includes('recurrence_rule')) {
        return { rows: [{ id: 'event-version-1' }], rowCount: 1 };
      }

      if (sql.includes('with actor_scope as (') && sql.includes('event_base as (')) {
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes('club_quota_policies') || sql.includes('count_member_writes_today')) {
        return { rows: [], rowCount: 0 };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };

  const repository = createPostgresRepository({ pool: { connect: async () => client } as any });

  await assert.rejects(
    () => repository.createEvent?.({
      authorMemberId: 'member-1',
      clubId: 'club-2',
      title: 'Launch Party',
      summary: null,
      body: 'Body',
      startsAt: '2026-03-20T18:00:00Z',
      endsAt: '2026-03-20T20:00:00Z',
      timezone: 'UTC',
      recurrenceRule: null,
      capacity: 50,
      expiresAt: null,
      content: {},
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 500);
      assert.equal(error.code, 'missing_row');
      assert.equal(error.message, 'Created event could not be reloaded');
      return true;
    },
  );
});

test('postgres repository lists current membership projections for owner scope', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];

  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [], rowCount: 0 };
      if (sql.includes("set_config('app.actor_member_id'")) return { rows: [{ set_config: 'member-1' }], rowCount: 1 };
      if (sql.includes('from app.current_club_memberships cnm')) {
        return {
          rows: [{
            membership_id: 'membership-9', club_id: 'club-2', member_id: 'member-9', public_name: 'Member Nine', handle: 'member-nine',
            sponsor_member_id: 'member-1', sponsor_public_name: 'Member One', sponsor_handle: 'member-one', role: 'member', status: 'pending_review',
            state_reason: 'Booked intro call', state_version_no: 2, state_created_at: '2026-03-12T00:04:00Z', state_created_by_member_id: 'member-1',
            joined_at: '2026-03-12T00:00:00Z', accepted_covenant_at: null, metadata: { source: 'operator' },
          }], rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };

  const repository = createPostgresRepository({ pool: { connect: async () => client } as any });
  const results = await repository.listMemberships({ actorMemberId: 'member-1', clubIds: ['club-2'], limit: 5, status: 'pending_review' });

  assert.equal(results.length, 1);
  assert.equal(results[0]?.state.status, 'pending_review');
  assert.equal(results[0]?.sponsor?.memberId, 'member-1');
  assert.match(calls[2]?.sql ?? '', /from app\.current_club_memberships cnm/);
  assert.deepEqual(calls[2]?.params, [['club-2'], 'pending_review', 5]);
});

test('postgres repository lists admissions with interview metadata inside owner scope', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];

  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [], rowCount: 0 };
      if (sql.includes("set_config('app.actor_member_id'")) return { rows: [{ set_config: 'member-1' }], rowCount: 1 };
      if (sql.includes('from app.current_admissions ca')) {
        return {
          rows: [{
            admission_id: 'application-9', club_id: 'club-2', applicant_member_id: 'member-9', applicant_public_name: 'Member Nine', applicant_handle: 'member-nine',
            applicant_email: null, applicant_name: null,
            sponsor_member_id: 'member-1', sponsor_public_name: 'Member One', sponsor_handle: 'member-one', membership_id: 'membership-9',
            linked_membership_status: null, linked_membership_accepted_covenant_at: null,
            origin: 'member_sponsored',
            intake_kind: 'fit_check', intake_price_amount: '49.00', intake_price_currency: 'GBP', intake_booking_url: 'https://cal.example.test/fit-check',
            intake_booked_at: '2026-03-14T10:00:00Z', intake_completed_at: null,
            status: 'submitted', notes: 'Warm intro via sponsor', version_no: 1, version_created_at: '2026-03-12T00:00:00Z', version_created_by_member_id: 'member-1',
            admission_details: null, metadata: { source: 'operator' }, created_at: '2026-03-12T00:00:00Z',
          }], rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };

  const repository = createPostgresRepository({ pool: { connect: async () => client } as any });
  const results = await repository.listAdmissions({ actorMemberId: 'member-1', clubIds: ['club-2'], limit: 5, statuses: ['submitted'] });

  assert.equal(results.length, 1);
  assert.equal(results[0]?.admissionId, 'application-9');
  assert.equal(results[0]?.intake.kind, 'fit_check');
  assert.equal(results[0]?.intake.price.amount, 49);
  assert.deepEqual(calls[2]?.params, [['club-2'], ['submitted'], 5]);
});

test('postgres repository lists admissions review context with sponsor load and vouches', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];

  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [], rowCount: 0 };
      if (sql.includes("set_config('app.actor_member_id'")) return { rows: [{ set_config: 'member-1' }], rowCount: 1 };
      if (sql.includes("from app.current_club_memberships cnm") && sql.includes("e.kind = 'vouched_for'")) {
        return {
          rows: [{
            membership_id: 'membership-9', club_id: 'club-2', member_id: 'member-9', public_name: 'Member Nine', handle: 'member-nine',
            sponsor_member_id: 'member-1', sponsor_public_name: 'Member One', sponsor_handle: 'member-one', role: 'member', status: 'pending_review',
            state_reason: 'Booked intro call', state_version_no: 2, state_created_at: '2026-03-12T00:04:00Z', state_created_by_member_id: 'member-1',
            joined_at: '2026-03-12T00:00:00Z', accepted_covenant_at: null, metadata: { source: 'operator' },
            sponsor_active_sponsored_count: 1, sponsor_sponsored_this_month_count: 2,
            vouches: [{
              edge_id: 'edge-1', from_member_id: 'member-2', from_public_name: 'Member Two', from_handle: 'member-two',
              reason: 'I trust their presence and follow-through.', metadata: { strength: 'warm' },
              created_at: '2026-03-12T00:03:00Z', created_by_member_id: 'member-2',
            }],
          }], rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };

  const repository = createPostgresRepository({ pool: { connect: async () => client } as any });
  const results = await repository.listMembershipReviews({ actorMemberId: 'member-1', clubIds: ['club-2'], limit: 5, statuses: ['pending_review'] });

  assert.equal(results.length, 1);
  assert.equal(results[0]?.sponsorStats.activeSponsoredCount, 1);
  assert.equal(results[0]?.vouches[0]?.fromMember.publicName, 'Member Two');
  assert.equal(results[0]?.vouches[0]?.reason, 'I trust their presence and follow-through.');
  assert.match(calls[2]?.sql ?? '', /e\.kind = 'vouched_for'/);
  assert.deepEqual(calls[2]?.params, [['club-2'], ['pending_review'], 5]);
});

test('postgres repository appends admission state transitions and reloads current projection', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];

  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [], rowCount: 0 };
      if (sql.includes("set_config('app.actor_member_id'")) return { rows: [{ set_config: 'member-1' }], rowCount: 1 };
      if (sql.includes('from app.current_admissions ca') && sql.includes('join app.accessible_club_memberships owner_scope')) {
        return {
          rows: [{
            admission_id: 'application-9', club_id: 'club-2', applicant_member_id: 'member-9',
            applicant_name: null, applicant_email: null,
            current_status: 'interview_scheduled', current_version_no: 2,
            current_version_id: 'appver-2', current_metadata: { source: 'operator' },
            current_admission_details: null,
            current_intake_kind: 'fit_check', current_intake_price_amount: '49.00',
            current_intake_price_currency: 'GBP', current_intake_booking_url: 'https://cal.example.test/fit-check', current_intake_booked_at: '2026-03-14T10:00:00Z',
            current_intake_completed_at: null, current_membership_id: 'membership-9',
            sponsor_member_id: 'member-1',
          }], rowCount: 1,
        };
      }
      if (sql.includes('update app.admissions a')) return { rows: [], rowCount: 1 };
      if (sql.includes('insert into app.admission_versions')) return { rows: [], rowCount: 1 };
      if (sql.includes('from app.current_club_memberships cnm') && sql.includes('current_state_version_id')) {
        return {
          rows: [{ membership_id: 'membership-9', current_status: 'pending_review', current_version_no: 2, current_state_version_id: 'state-2' }],
          rowCount: 1,
        };
      }
      if (sql.includes('insert into app.club_membership_state_versions')) return { rows: [], rowCount: 1 };
      if (sql.includes('membership_has_live_subscription')) return { rows: [{ has_sub: false }], rowCount: 1 };
      if (sql.includes('create_comped_subscription')) return { rows: [], rowCount: 1 };
      if (sql.includes('from app.current_admissions ca') && sql.includes('where ca.id = $1')) {
        return {
          rows: [{
            admission_id: 'application-9', club_id: 'club-2', applicant_member_id: 'member-9', applicant_public_name: 'Member Nine', applicant_handle: 'member-nine',
            applicant_email: null, applicant_name: null,
            sponsor_member_id: 'member-1', sponsor_public_name: 'Member One', sponsor_handle: 'member-one', membership_id: 'membership-9',
            linked_membership_status: 'active', linked_membership_accepted_covenant_at: null, origin: 'member_sponsored',
            intake_kind: 'fit_check', intake_price_amount: '49.00', intake_price_currency: 'GBP', intake_booking_url: 'https://cal.example.test/fit-check',
            intake_booked_at: '2026-03-14T10:00:00Z', intake_completed_at: '2026-03-14T10:30:00Z',
            status: 'accepted', notes: 'Strong yes', version_no: 3, version_created_at: '2026-03-14T10:30:00Z', version_created_by_member_id: 'member-1',
            admission_details: null, metadata: { source: 'operator', outcome: 'strong_yes' }, created_at: '2026-03-12T00:00:00Z',
          }], rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };

  const repository = createPostgresRepository({ pool: { connect: async () => client } as any });
  const application = await repository.transitionAdmission({
    actorMemberId: 'member-1',
    admissionId: 'application-9',
    nextStatus: 'accepted',
    notes: 'Strong yes',
    accessibleClubIds: ['club-2'],
    intake: { completedAt: '2026-03-14T10:30:00Z' },
    metadataPatch: { outcome: 'strong_yes' },
  });

  assert.ok(application);
  assert.equal(application?.state.status, 'accepted');
  assert.equal(application?.origin, 'member_sponsored');
  assert.deepEqual(calls[3]?.params, ['application-9', '{"source":"operator","outcome":"strong_yes"}']);
  assert.deepEqual(calls[4]?.params, ['application-9', 'accepted', 'Strong yes', 'fit_check', '49.00', 'GBP', 'https://cal.example.test/fit-check', '2026-03-14T10:00:00Z', '2026-03-14T10:30:00Z', 3, 'appver-2', 'member-1']);
});

test('postgres repository appends membership state transitions and reloads current projection', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];

  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [], rowCount: 0 };
      if (sql.includes("set_config('app.actor_member_id'")) return { rows: [{ set_config: 'member-1' }], rowCount: 1 };
      if (sql.includes('join app.accessible_club_memberships owner_scope')) {
        return {
          rows: [{
            membership_id: 'membership-9', club_id: 'club-2', member_id: 'member-9', current_status: 'pending_review', current_version_no: 2, current_state_version_id: 'state-2',
          }], rowCount: 1,
        };
      }
      if (sql.includes('insert into app.club_membership_state_versions')) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('membership_has_live_subscription')) return { rows: [{ has_sub: false }], rowCount: 1 };
      if (sql.includes('create_comped_subscription')) return { rows: [], rowCount: 1 };
      if (sql.includes('where cnm.id = $1')) {
        return {
          rows: [{
            membership_id: 'membership-9', club_id: 'club-2', member_id: 'member-9', public_name: 'Member Nine', handle: 'member-nine',
            sponsor_member_id: 'member-1', sponsor_public_name: 'Member One', sponsor_handle: 'member-one', role: 'member', status: 'active',
            state_reason: 'Fit check passed', state_version_no: 3, state_created_at: '2026-03-12T00:05:00Z', state_created_by_member_id: 'member-1',
            joined_at: '2026-03-12T00:00:00Z', accepted_covenant_at: null, metadata: {},
          }], rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };

  const repository = createPostgresRepository({ pool: { connect: async () => client } as any });
  const membership = await repository.transitionMembershipState({ actorMemberId: 'member-1', membershipId: 'membership-9', nextStatus: 'active', reason: 'Fit check passed', accessibleClubIds: ['club-2'] });

  assert.ok(membership);
  assert.equal(membership?.state.status, 'active');
  assert.equal(membership?.state.versionNo, 3);
  assert.match(calls[2]?.sql ?? '', /join app\.accessible_club_memberships owner_scope/);
  assert.deepEqual(calls[2]?.params, ['member-1', 'membership-9', ['club-2']]);
  assert.deepEqual(calls[3]?.params, ['membership-9', 'active', 'Fit check passed', 3, 'state-2', 'member-1']);
  assert.equal(calls.at(-1)?.sql, 'commit');
});
