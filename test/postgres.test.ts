import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresRepository } from '../src/postgres.ts';

test('postgres repository lists networks for superadmin scope including archived ones on request', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];

  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [], rowCount: 0 };
      if (sql.includes("set_config('app.actor_member_id'")) return { rows: [{ set_config: 'member-1' }], rowCount: 1 };
      if (sql.includes('from app.networks n') && sql.includes('where ($1::boolean = true or n.archived_at is null)')) {
        return {
          rows: [{
            network_id: 'network-1', slug: 'alpha', name: 'Alpha', summary: 'First network', manifesto_markdown: null,
            archived_at: '2026-03-12T01:00:00Z', owner_member_id: 'member-1', owner_public_name: 'Member One', owner_handle: 'member-one',
            owner_version_no: 2, owner_created_at: '2026-03-12T00:30:00Z', owner_created_by_member_id: 'member-1',
          }], rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };

  const repository = createPostgresRepository({ pool: { connect: async () => client } as any });
  const results = await repository.listNetworks({ actorMemberId: 'member-1', includeArchived: true });

  assert.equal(results[0]?.networkId, 'network-1');
  assert.equal(results[0]?.archivedAt, '2026-03-12T01:00:00Z');
  assert.equal(results[0]?.ownerVersion.versionNo, 2);
  assert.deepEqual(calls[1]?.params, ['member-1', '']);
  assert.deepEqual(calls[2]?.params, [true]);
});

test('postgres repository creates, archives, and reassigns network owners through superadmin scope', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];

  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [], rowCount: 0 };
      if (sql.includes("set_config('app.actor_member_id'")) return { rows: [{ set_config: 'member-1' }], rowCount: 1 };
      if (sql.includes('with owner_member as (')) return { rows: [{ network_id: 'network-9' }], rowCount: 1 };
      if (sql.includes("update app.networks n\n            set archived_at = coalesce")) return { rows: [{ network_id: 'network-9' }], rowCount: 1 };
      if (sql.includes('select') && sql.includes('join app.current_network_owners cno on cno.network_id = n.id') && sql.includes('join app.members m on m.id = $2')) {
        return { rows: [{ network_id: 'network-9', current_owner_version_id: 'owner-1', current_version_no: 1 }], rowCount: 1 };
      }
      if (sql.includes('insert into app.network_owner_versions')) return { rows: [], rowCount: 1 };
      if (sql.includes('update app.networks set owner_member_id = $2')) return { rows: [], rowCount: 1 };
      if (sql.includes('from app.networks n') && sql.includes('where n.id = $1')) {
        return {
          rows: [{
            network_id: 'network-9', slug: 'gamma', name: 'Gamma', summary: 'Third network', manifesto_markdown: null,
            archived_at: null, owner_member_id: 'member-9', owner_public_name: 'Member Nine', owner_handle: 'member-nine',
            owner_version_no: 2, owner_created_at: '2026-03-12T01:00:00Z', owner_created_by_member_id: 'member-1',
          }], rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };

  const repository = createPostgresRepository({ pool: { connect: async () => client } as any });
  const created = await repository.createNetwork({ actorMemberId: 'member-1', slug: 'gamma', name: 'Gamma', summary: 'Third network', manifestoMarkdown: null, ownerMemberId: 'member-9' });
  const archived = await repository.archiveNetwork({ actorMemberId: 'member-1', networkId: 'network-9' });
  const reassigned = await repository.assignNetworkOwner({ actorMemberId: 'member-1', networkId: 'network-9', ownerMemberId: 'member-9' });

  assert.equal(created?.networkId, 'network-9');
  assert.equal(archived?.networkId, 'network-9');
  assert.equal(reassigned?.owner.memberId, 'member-9');
  assert.equal(reassigned?.ownerVersion.versionNo, 2);
});

test('postgres repository lists active members with scoped membership context', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];

  const pool = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });

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
                  networkId: 'network-2',
                  slug: 'beta',
                  name: 'Beta',
                  summary: 'Second network',
                  manifestoMarkdown: null,
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
  };

  const repository = createPostgresRepository({ pool: pool as any });
  const results = await repository.listMembers({
    networkIds: ['network-2'],
    limit: 5,
  });

  assert.equal(results.length, 1);
  assert.equal(results[0]?.memberId, 'member-2');
  assert.equal(results[0]?.memberships[0]?.networkId, 'network-2');
  assert.match(calls[0]?.sql ?? '', /join app\.accessible_network_memberships anm/);
  assert.deepEqual(calls[0]?.params, [['network-2'], 5]);
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
              network_id: 'network-1',
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

      if (sql.includes('coalesce(receipts.delivery_receipts')) {
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
              delivery_receipts: [
                {
                  deliveryId: 'delivery-1',
                  recipientMemberId: 'member-1',
                  status: 'sent',
                  scheduledAt: '2026-03-12T00:00:00Z',
                  sentAt: '2026-03-12T00:00:05Z',
                  failedAt: null,
                  createdAt: '2026-03-12T00:00:00Z',
                  acknowledgement: {
                    acknowledgementId: 'ack-1',
                    state: 'shown',
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
    networkIds: ['network-1', 'network-2'],
    limit: 5,
  });

  assert.equal(results.length, 1);
  assert.equal(results[0]?.threadId, 'thread-1');
  assert.equal(calls[0]?.sql, 'begin');
  assert.match(calls[1]?.sql ?? '', /set_config\('app\.actor_member_id'/);
  assert.deepEqual(calls[1]?.params, ['member-1', 'network-1,network-2']);
  assert.match(calls[2]?.sql ?? '', /with scope as \(/);
  assert.equal(calls.at(-1)?.sql, 'commit');
});


test('postgres repository stitches current delivery receipt state into dm transcript reads', async () => {
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
              network_id: 'network-2',
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

      if (sql.includes('coalesce(receipts.delivery_receipts')) {
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
              delivery_receipts: [
                {
                  deliveryId: 'delivery-1',
                  recipientMemberId: 'member-1',
                  status: 'sent',
                  scheduledAt: '2026-03-12T00:01:00Z',
                  sentAt: '2026-03-12T00:01:05Z',
                  failedAt: null,
                  createdAt: '2026-03-12T00:01:00Z',
                  acknowledgement: {
                    acknowledgementId: 'ack-1',
                    state: 'shown',
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
              delivery_receipts: [
                {
                  deliveryId: 'delivery-2',
                  recipientMemberId: 'member-2',
                  status: 'sent',
                  scheduledAt: '2026-03-12T00:02:00Z',
                  sentAt: '2026-03-12T00:02:05Z',
                  failedAt: null,
                  createdAt: '2026-03-12T00:02:00Z',
                  acknowledgement: null,
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
  const transcript = await repository.readDirectMessageThread({
    actorMemberId: 'member-1',
    accessibleNetworkIds: ['network-2'],
    threadId: 'thread-1',
    limit: 5,
  });

  assert.ok(transcript);
  assert.equal(transcript?.thread.threadId, 'thread-1');
  assert.equal(transcript?.messages.length, 2);
  assert.equal(transcript?.messages.find((message) => message.messageId === 'message-1')?.deliveryReceipts[0]?.acknowledgement?.state, 'shown');
  assert.equal(transcript?.messages.find((message) => message.messageId === 'message-2')?.deliveryReceipts[0]?.recipientMemberId, 'member-2');
  assert.equal(calls[0]?.sql, 'begin');
  assert.match(calls[1]?.sql ?? '', /set_config\('app\.actor_member_id'/);
  assert.deepEqual(calls[1]?.params, ['member-1', 'network-2']);
  assert.match(calls[2]?.sql ?? '', /with thread_scope as \(/);
  assert.match(calls[3]?.sql ?? '', /coalesce\(receipts\.delivery_receipts/);
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
              network_id: 'network-2',
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
              unread_delivery_count: 3,
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
    networkIds: ['network-2'],
    limit: 5,
    unreadOnly: true,
  });

  assert.equal(results.length, 1);
  assert.equal(results[0]?.threadId, 'thread-1');
  assert.equal(results[0]?.unread.unreadMessageCount, 2);
  assert.equal(calls[0]?.sql, 'begin');
  assert.match(calls[1]?.sql ?? '', /set_config\('app\.actor_member_id'/);
  assert.deepEqual(calls[1]?.params, ['member-1', 'network-2']);
  assert.match(calls[2]?.sql ?? '', /from app\.current_dm_inbox_threads inbox/);
  assert.deepEqual(calls[2]?.params, ['member-1', ['network-2'], true, 5]);
  assert.equal(calls.at(-1)?.sql, 'commit');
});

test('postgres repository lists delivery attempts with operator filters inside actor scope', async () => {
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

      if (sql.includes('from app.delivery_attempts da')) {
        return {
          rows: [
            {
              attempt_id: 'attempt-1',
              delivery_id: 'delivery-1',
              network_id: 'network-2',
              endpoint_id: 'endpoint-2',
              worker_key: 'worker-a',
              status: 'failed',
              attempt_no: 2,
              response_status_code: 503,
              response_body: 'upstream unavailable',
              error_message: 'upstream unavailable',
              started_at: '2026-03-12T00:04:00Z',
              finished_at: '2026-03-12T00:04:03Z',
              created_by_member_id: 'member-1',
              delivery_network_id: 'network-2',
              delivery_recipient_member_id: 'member-2',
              recipient_public_name: 'Member Two',
              recipient_handle: 'member-two',
              delivery_topic: 'transcript.message.created',
              delivery_status: 'failed',
              delivery_attempt_count: 2,
              delivery_scheduled_at: '2026-03-12T00:03:00Z',
              delivery_sent_at: null,
              delivery_failed_at: '2026-03-12T00:04:03Z',
              delivery_last_error: 'upstream unavailable',
              delivery_created_at: '2026-03-12T00:03:00Z',
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
  const results = await repository.listDeliveryAttempts({
    actorMemberId: 'member-1',
    networkIds: ['network-2'],
    endpointId: 'endpoint-2',
    recipientMemberId: 'member-2',
    status: 'failed',
    limit: 5,
  });

  assert.equal(results.length, 1);
  assert.equal(results[0]?.attempt.attemptId, 'attempt-1');
  assert.equal(results[0]?.delivery.recipient.publicName, 'Member Two');
  assert.equal(results[0]?.delivery.topic, 'transcript.message.created');
  assert.equal(calls[0]?.sql, 'begin');
  assert.match(calls[1]?.sql ?? '', /set_config\('app\.actor_member_id'/);
  assert.deepEqual(calls[1]?.params, ['member-1', 'network-2']);
  assert.match(calls[2]?.sql ?? '', /from app\.delivery_attempts da/);
  assert.deepEqual(calls[2]?.params, [['network-2'], 'endpoint-2', 'member-2', 'failed', 5]);
  assert.equal(calls.at(-1)?.sql, 'commit');
});

test('postgres repository projects actor scope into the db session before delivery reads', async () => {
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

      if (sql.includes('from app.current_delivery_receipts cdr')) {
        return {
          rows: [
            {
              delivery_id: 'delivery-1',
              network_id: 'network-2',
              recipient_member_id: 'member-1',
              topic: 'transcript.message.created',
              payload: { kind: 'dm' },
              status: 'sent',
              entity_id: null,
              entity_version_id: null,
              transcript_message_id: 'message-1',
              scheduled_at: '2026-03-12T00:02:00Z',
              sent_at: '2026-03-12T00:03:00Z',
              failed_at: null,
              created_at: '2026-03-12T00:02:00Z',
              acknowledgement_id: 'ack-1',
              acknowledgement_state: 'shown',
              acknowledgement_suppression_reason: null,
              acknowledgement_version_no: 1,
              acknowledgement_created_at: '2026-03-12T00:04:00Z',
              acknowledgement_created_by_member_id: 'member-1',
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
  const results = await repository.listDeliveries({
    actorMemberId: 'member-1',
    networkIds: ['network-2'],
    limit: 5,
    pendingOnly: true,
  });

  assert.equal(results.length, 1);
  assert.equal(results[0]?.deliveryId, 'delivery-1');
  assert.equal(results[0]?.acknowledgement?.acknowledgementId, 'ack-1');
  assert.equal(calls[0]?.sql, 'begin');
  assert.match(calls[1]?.sql ?? '', /set_config\('app\.actor_member_id'/);
  assert.deepEqual(calls[1]?.params, ['member-1', 'network-2']);
  assert.match(calls[2]?.sql ?? '', /from app\.current_delivery_receipts cdr/);
  assert.deepEqual(calls[2]?.params, ['member-1', ['network-2'], true, 5]);
  assert.equal(calls.at(-1)?.sql, 'commit');
});

test('postgres repository retries a failed delivery inside actor scope as a fresh pending receipt', async () => {
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

      if (sql.includes('from app.current_delivery_receipts cdr') && sql.includes('where cdr.delivery_id = $1') && sql.includes('and cdr.recipient_member_id = $2')) {
        return {
          rows: [
            {
              delivery_id: 'delivery-1',
              network_id: 'network-2',
              recipient_member_id: 'member-1',
              endpoint_id: 'endpoint-2',
              entity_id: null,
              entity_version_id: null,
              transcript_message_id: 'message-1',
              topic: 'transcript.message.created',
              payload: { kind: 'dm', threadId: 'thread-1' },
              status: 'failed',
            },
          ],
          rowCount: 1,
        };
      }

      if (sql.includes('insert into app.deliveries (')) {
        return {
          rows: [{ delivery_id: 'delivery-2' }],
          rowCount: 1,
        };
      }

      if (sql.includes('from app.current_delivery_receipts cdr') && sql.includes('where cdr.delivery_id = $1') && !sql.includes('and cdr.recipient_member_id = $2')) {
        return {
          rows: [
            {
              delivery_id: 'delivery-2',
              network_id: 'network-2',
              recipient_member_id: 'member-1',
              endpoint_id: 'endpoint-2',
              topic: 'transcript.message.created',
              payload: { kind: 'dm', threadId: 'thread-1' },
              status: 'pending',
              attempt_count: 0,
              entity_id: null,
              entity_version_id: null,
              transcript_message_id: 'message-1',
              scheduled_at: '2026-03-12T00:06:00Z',
              sent_at: null,
              failed_at: null,
              last_error: null,
              created_at: '2026-03-12T00:06:00Z',
              acknowledgement_id: null,
              acknowledgement_state: null,
              acknowledgement_suppression_reason: null,
              acknowledgement_version_no: null,
              acknowledgement_created_at: null,
              acknowledgement_created_by_member_id: null,
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
  const delivery = await repository.retryDelivery({
    actorMemberId: 'member-1',
    accessibleNetworkIds: ['network-2'],
    deliveryId: 'delivery-1',
  });

  assert.ok(delivery);
  assert.equal(delivery?.deliveryId, 'delivery-2');
  assert.equal(delivery?.status, 'pending');
  assert.equal(delivery?.endpointId, 'endpoint-2');
  assert.equal(delivery?.attemptCount, 0);
  assert.equal(delivery?.lastError, null);
  assert.equal(calls[0]?.sql, 'begin');
  assert.match(calls[1]?.sql ?? '', /set_config\('app\.actor_member_id'/);
  assert.deepEqual(calls[1]?.params, ['member-1', 'network-2']);
  assert.match(calls[2]?.sql ?? '', /from app\.current_delivery_receipts cdr/);
  assert.deepEqual(calls[2]?.params, ['delivery-1', 'member-1', ['network-2']]);
  assert.match(calls[3]?.sql ?? '', /insert into app\.deliveries/);
  assert.equal(calls[3]?.params?.[0], 'network-2');
  assert.equal(calls[3]?.params?.[1], 'member-1');
  assert.equal(calls[3]?.params?.[2], 'endpoint-2');
  assert.equal(calls[3]?.params?.[5], 'message-1');
  assert.equal(calls.at(-1)?.sql, 'commit');
});

test('postgres repository lists, creates, updates, and revokes delivery endpoints for the actor member', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];

  const pool = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });

      if (sql.includes('from app.delivery_endpoints dep') && sql.includes('order by dep.created_at desc')) {
        return {
          rows: [{
            endpoint_id: 'endpoint-1', member_id: 'member-1', channel: 'openclaw_webhook', label: 'Primary',
            endpoint_url: 'https://example.test/webhook', shared_secret_ref: 'op://clawclub/primary', state: 'active',
            last_success_at: null, last_failure_at: null, metadata: { device: 'mbp' }, created_at: '2026-03-12T00:00:00Z', disabled_at: null,
          }],
          rowCount: 1,
        };
      }

      if (sql.includes('insert into app.delivery_endpoints')) {
        return {
          rows: [{
            endpoint_id: 'endpoint-2', member_id: 'member-1', channel: 'openclaw_webhook', label: 'Laptop',
            endpoint_url: 'https://hooks.example.test/clawclub', shared_secret_ref: 'op://clawclub/laptop', state: 'active',
            last_success_at: null, last_failure_at: null, metadata: { device: 'mbp' }, created_at: '2026-03-12T00:01:00Z', disabled_at: null,
          }],
          rowCount: 1,
        };
      }

      if (sql.includes('update app.delivery_endpoints dep') && sql.includes('metadata = $7::jsonb')) {
        return {
          rows: [{
            endpoint_id: 'endpoint-2', member_id: 'member-1', channel: 'openclaw_webhook', label: 'Backup',
            endpoint_url: 'https://backup.example.test/clawclub', shared_secret_ref: null, state: 'failing',
            last_success_at: null, last_failure_at: '2026-03-12T00:02:00Z', metadata: { device: 'pi' }, created_at: '2026-03-12T00:01:00Z', disabled_at: null,
          }],
          rowCount: 1,
        };
      }

      if (sql.includes("set state = 'disabled'")) {
        return {
          rows: [{
            endpoint_id: 'endpoint-2', member_id: 'member-1', channel: 'openclaw_webhook', label: 'Backup',
            endpoint_url: 'https://backup.example.test/clawclub', shared_secret_ref: null, state: 'disabled',
            last_success_at: null, last_failure_at: '2026-03-12T00:02:00Z', metadata: { device: 'pi' }, created_at: '2026-03-12T00:01:00Z', disabled_at: '2026-03-12T00:03:00Z',
          }],
          rowCount: 1,
        };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const repository = createPostgresRepository({ pool: pool as any });
  const listed = await repository.listDeliveryEndpoints({ actorMemberId: 'member-1' });
  const created = await repository.createDeliveryEndpoint({
    actorMemberId: 'member-1',
    channel: 'openclaw_webhook',
    label: 'Laptop',
    endpointUrl: 'https://hooks.example.test/clawclub',
    sharedSecretRef: 'op://clawclub/laptop',
    metadata: { device: 'mbp' },
  });
  const updated = await repository.updateDeliveryEndpoint({
    actorMemberId: 'member-1',
    endpointId: 'endpoint-2',
    patch: {
      label: 'Backup',
      endpointUrl: 'https://backup.example.test/clawclub',
      sharedSecretRef: null,
      state: 'failing',
      metadata: { device: 'pi' },
    },
  });
  const revoked = await repository.revokeDeliveryEndpoint({ actorMemberId: 'member-1', endpointId: 'endpoint-2' });

  assert.equal(listed[0]?.endpointId, 'endpoint-1');
  assert.equal(created.endpointId, 'endpoint-2');
  assert.equal(updated?.state, 'failing');
  assert.equal(updated?.sharedSecretRef, null);
  assert.equal(revoked?.state, 'disabled');
  assert.equal(revoked?.disabledAt, '2026-03-12T00:03:00Z');
  assert.deepEqual(calls[0]?.params, ['member-1']);
  assert.deepEqual(calls[1]?.params, ['member-1', 'openclaw_webhook', 'Laptop', 'https://hooks.example.test/clawclub', 'op://clawclub/laptop', '{"device":"mbp"}']);
  assert.deepEqual(calls[2]?.params, ['endpoint-2', 'member-1', 'Backup', 'https://backup.example.test/clawclub', null, 'failing', '{"device":"pi"}']);
  assert.deepEqual(calls[3]?.params, ['endpoint-2', 'member-1']);
});

test('postgres repository creates and revokes hashed bearer tokens without returning the hash', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];

  const pool = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });

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

      throw new Error(`Unexpected query: ${sql}`);
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
  assert.match(calls[0]?.sql ?? '', /insert into app\.member_bearer_tokens/);
  assert.equal((calls[0]?.params?.[0] as string).length, 12);
  assert.equal(calls[0]?.params?.[1], 'member-1');
  assert.equal(calls[0]?.params?.[2], 'laptop');
  assert.equal(typeof calls[0]?.params?.[3], 'string');
  assert.notEqual(calls[0]?.params?.[3], created.bearerToken);

  const revoked = await repository.revokeBearerToken({
    actorMemberId: 'member-1',
    tokenId: 'token-1',
  });

  assert.equal(revoked?.tokenId, 'token-1');
  assert.equal(revoked?.revokedAt, '2026-03-12T00:05:00Z');
  assert.match(calls[1]?.sql ?? '', /update app\.member_bearer_tokens mbt/);
  assert.deepEqual(calls[1]?.params, ['token-1', 'member-1']);
});

test('postgres repository claims the next pending delivery and appends a processing attempt', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];

  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });

      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [], rowCount: 0 };
      if (sql.includes("set_config('app.actor_member_id'")) return { rows: [{ set_config: 'member-1' }], rowCount: 1 };
      if (sql.includes('with next_delivery as (')) return { rows: [{ delivery_id: 'delivery-1' }], rowCount: 1 };
      if (sql.includes('from app.current_delivery_receipts cdr') && sql.includes('where cdr.delivery_id = $1')) {
        return {
          rows: [{
            delivery_id: 'delivery-1', network_id: 'network-2', recipient_member_id: 'member-2', endpoint_id: 'endpoint-2',
            topic: 'transcript.message.created', payload: { kind: 'dm' }, status: 'processing', attempt_count: 2,
            entity_id: null, entity_version_id: null, transcript_message_id: 'message-1', scheduled_at: '2026-03-12T00:02:00Z',
            sent_at: null, failed_at: null, last_error: null, created_at: '2026-03-12T00:00:00Z', acknowledgement_id: null,
            acknowledgement_state: null, acknowledgement_suppression_reason: null, acknowledgement_version_no: null,
            acknowledgement_created_at: null, acknowledgement_created_by_member_id: null,
          }], rowCount: 1,
        };
      }
      if (sql.includes('from app.delivery_endpoints de') && sql.includes('where de.id = $1')) {
        return {
          rows: [{
            endpoint_id: 'endpoint-2', member_id: 'member-2', channel: 'openclaw_webhook', label: 'Primary webhook', endpoint_url: 'https://example.test/webhook',
            shared_secret_ref: 'op://clawclub/primary', state: 'active', last_success_at: null, last_failure_at: null, metadata: { environment: 'test' },
            created_at: '2026-03-12T00:00:00Z', disabled_at: null,
          }], rowCount: 1,
        };
      }
      if (sql.includes('from app.current_delivery_attempts cda')) {
        return {
          rows: [{
            attempt_id: 'attempt-1', delivery_id: 'delivery-1', network_id: 'network-2', endpoint_id: 'endpoint-2', worker_key: 'worker-a',
            status: 'processing', attempt_no: 2, response_status_code: null, response_body: null, error_message: null,
            started_at: '2026-03-12T00:04:00Z', finished_at: null, created_by_member_id: 'member-1',
          }], rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };

  const repository = createPostgresRepository({ pool: { connect: async () => client } as any });
  const claimed = await repository.claimNextDelivery({ actorMemberId: 'member-1', accessibleNetworkIds: ['network-2'], workerKey: 'worker-a' });

  assert.ok(claimed);
  assert.equal(claimed?.delivery.deliveryId, 'delivery-1');
  assert.equal(claimed?.delivery.status, 'processing');
  assert.equal(claimed?.attempt.attemptNo, 2);
  assert.equal(claimed?.attempt.workerKey, 'worker-a');
  assert.equal(claimed?.endpoint.endpointUrl, 'https://example.test/webhook');
  assert.match(calls[2]?.sql ?? '', /with next_delivery as \(/);
  assert.deepEqual(calls[2]?.params, ['member-1', ['network-2'], 'worker-a']);
  assert.equal(calls.at(-1)?.sql, 'commit');
});

test('postgres repository completes a processing delivery attempt and touches endpoint success', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];

  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [], rowCount: 0 };
      if (sql.includes("set_config('app.actor_member_id'")) return { rows: [{ set_config: 'member-1' }], rowCount: 1 };
      if (sql.includes('with current_attempt as (')) return { rows: [{ delivery_id: 'delivery-1' }], rowCount: 1 };
      if (sql.includes('from app.current_delivery_receipts cdr') && sql.includes('where cdr.delivery_id = $1')) {
        return {
          rows: [{
            delivery_id: 'delivery-1', network_id: 'network-2', recipient_member_id: 'member-2', endpoint_id: 'endpoint-2',
            topic: 'transcript.message.created', payload: { kind: 'dm' }, status: 'sent', attempt_count: 2,
            entity_id: null, entity_version_id: null, transcript_message_id: 'message-1', scheduled_at: '2026-03-12T00:02:00Z',
            sent_at: '2026-03-12T00:05:00Z', failed_at: null, last_error: null, created_at: '2026-03-12T00:00:00Z', acknowledgement_id: null,
            acknowledgement_state: null, acknowledgement_suppression_reason: null, acknowledgement_version_no: null,
            acknowledgement_created_at: null, acknowledgement_created_by_member_id: null,
          }], rowCount: 1,
        };
      }
      if (sql.includes('from app.delivery_endpoints de') && sql.includes('where de.id = $1')) {
        return {
          rows: [{
            endpoint_id: 'endpoint-2', member_id: 'member-2', channel: 'openclaw_webhook', label: 'Primary webhook', endpoint_url: 'https://example.test/webhook',
            shared_secret_ref: 'op://clawclub/primary', state: 'active', last_success_at: null, last_failure_at: null, metadata: { environment: 'test' },
            created_at: '2026-03-12T00:00:00Z', disabled_at: null,
          }], rowCount: 1,
        };
      }
      if (sql.includes('from app.current_delivery_attempts cda')) {
        return {
          rows: [{
            attempt_id: 'attempt-1', delivery_id: 'delivery-1', network_id: 'network-2', endpoint_id: 'endpoint-2', worker_key: 'worker-a',
            status: 'sent', attempt_no: 2, response_status_code: 202, response_body: 'ok', error_message: null,
            started_at: '2026-03-12T00:04:00Z', finished_at: '2026-03-12T00:05:00Z', created_by_member_id: 'member-1',
          }], rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };

  const repository = createPostgresRepository({ pool: { connect: async () => client } as any });
  const claimed = await repository.completeDeliveryAttempt({ actorMemberId: 'member-1', accessibleNetworkIds: ['network-2'], deliveryId: 'delivery-1', responseStatusCode: 202, responseBody: 'ok' });

  assert.ok(claimed);
  assert.equal(claimed?.delivery.status, 'sent');
  assert.equal(claimed?.attempt.status, 'sent');
  assert.equal(claimed?.attempt.responseStatusCode, 202);
  assert.equal(claimed?.endpoint.endpointId, 'endpoint-2');
  assert.match(calls[2]?.sql ?? '', /with current_attempt as \(/);
  assert.deepEqual(calls[2]?.params, ['member-1', 'delivery-1', ['network-2'], 202, 'ok']);
  assert.equal(calls.at(-1)?.sql, 'commit');
});

test('postgres repository fails a processing delivery attempt and touches endpoint failure', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];

  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [], rowCount: 0 };
      if (sql.includes("set_config('app.actor_member_id'")) return { rows: [{ set_config: 'member-1' }], rowCount: 1 };
      if (sql.includes('with current_attempt as (')) return { rows: [{ delivery_id: 'delivery-1' }], rowCount: 1 };
      if (sql.includes('from app.current_delivery_receipts cdr') && sql.includes('where cdr.delivery_id = $1')) {
        return {
          rows: [{
            delivery_id: 'delivery-1', network_id: 'network-2', recipient_member_id: 'member-2', endpoint_id: 'endpoint-2',
            topic: 'transcript.message.created', payload: { kind: 'dm' }, status: 'failed', attempt_count: 2,
            entity_id: null, entity_version_id: null, transcript_message_id: 'message-1', scheduled_at: '2026-03-12T00:02:00Z',
            sent_at: null, failed_at: '2026-03-12T00:05:00Z', last_error: 'timeout', created_at: '2026-03-12T00:00:00Z', acknowledgement_id: null,
            acknowledgement_state: null, acknowledgement_suppression_reason: null, acknowledgement_version_no: null,
            acknowledgement_created_at: null, acknowledgement_created_by_member_id: null,
          }], rowCount: 1,
        };
      }
      if (sql.includes('from app.delivery_endpoints de') && sql.includes('where de.id = $1')) {
        return {
          rows: [{
            endpoint_id: 'endpoint-2', member_id: 'member-2', channel: 'openclaw_webhook', label: 'Primary webhook', endpoint_url: 'https://example.test/webhook',
            shared_secret_ref: 'op://clawclub/primary', state: 'active', last_success_at: null, last_failure_at: null, metadata: { environment: 'test' },
            created_at: '2026-03-12T00:00:00Z', disabled_at: null,
          }], rowCount: 1,
        };
      }
      if (sql.includes('from app.current_delivery_attempts cda')) {
        return {
          rows: [{
            attempt_id: 'attempt-1', delivery_id: 'delivery-1', network_id: 'network-2', endpoint_id: 'endpoint-2', worker_key: 'worker-a',
            status: 'failed', attempt_no: 2, response_status_code: 504, response_body: 'timeout', error_message: 'timeout',
            started_at: '2026-03-12T00:04:00Z', finished_at: '2026-03-12T00:05:00Z', created_by_member_id: 'member-1',
          }], rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };

  const repository = createPostgresRepository({ pool: { connect: async () => client } as any });
  const claimed = await repository.failDeliveryAttempt({ actorMemberId: 'member-1', accessibleNetworkIds: ['network-2'], deliveryId: 'delivery-1', errorMessage: 'timeout', responseStatusCode: 504, responseBody: 'timeout' });

  assert.ok(claimed);
  assert.equal(claimed?.delivery.status, 'failed');
  assert.equal(claimed?.attempt.errorMessage, 'timeout');
  assert.equal(claimed?.endpoint.state, 'active');
  assert.match(calls[2]?.sql ?? '', /with current_attempt as \(/);
  assert.deepEqual(calls[2]?.params, ['member-1', 'delivery-1', ['network-2'], 'timeout', 504, 'timeout']);
  assert.equal(calls.at(-1)?.sql, 'commit');
});

test('postgres repository lists current membership projections for owner scope', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];

  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [], rowCount: 0 };
      if (sql.includes("set_config('app.actor_member_id'")) return { rows: [{ set_config: 'member-1' }], rowCount: 1 };
      if (sql.includes('from app.current_network_memberships cnm')) {
        return {
          rows: [{
            membership_id: 'membership-9', network_id: 'network-2', member_id: 'member-9', public_name: 'Member Nine', handle: 'member-nine',
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
  const results = await repository.listMemberships({ actorMemberId: 'member-1', networkIds: ['network-2'], limit: 5, status: 'pending_review' });

  assert.equal(results.length, 1);
  assert.equal(results[0]?.state.status, 'pending_review');
  assert.equal(results[0]?.sponsor?.memberId, 'member-1');
  assert.match(calls[2]?.sql ?? '', /from app\.current_network_memberships cnm/);
  assert.deepEqual(calls[2]?.params, [['network-2'], 'pending_review', 5]);
});

test('postgres repository lists applications with interview metadata inside owner scope', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];

  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [], rowCount: 0 };
      if (sql.includes("set_config('app.actor_member_id'")) return { rows: [{ set_config: 'member-1' }], rowCount: 1 };
      if (sql.includes('from app.current_applications ca')) {
        return {
          rows: [{
            application_id: 'application-9', network_id: 'network-2', applicant_member_id: 'member-9', applicant_public_name: 'Member Nine', applicant_handle: 'member-nine',
            sponsor_member_id: 'member-1', sponsor_public_name: 'Member One', sponsor_handle: 'member-one', membership_id: 'membership-9', path: 'sponsored',
            intake_kind: 'fit_check', intake_price_amount: '49.00', intake_price_currency: 'GBP', intake_booking_url: 'https://cal.example.test/fit-check',
            intake_booked_at: '2026-03-14T10:00:00Z', intake_completed_at: null,
            status: 'submitted', notes: 'Warm intro via sponsor', version_no: 1, version_created_at: '2026-03-12T00:00:00Z', version_created_by_member_id: 'member-1',
            metadata: { source: 'operator' }, created_at: '2026-03-12T00:00:00Z',
          }], rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };

  const repository = createPostgresRepository({ pool: { connect: async () => client } as any });
  const results = await repository.listApplications({ actorMemberId: 'member-1', networkIds: ['network-2'], limit: 5, statuses: ['submitted'] });

  assert.equal(results.length, 1);
  assert.equal(results[0]?.applicationId, 'application-9');
  assert.equal(results[0]?.intake.kind, 'fit_check');
  assert.equal(results[0]?.intake.price.amount, 49);
  assert.deepEqual(calls[2]?.params, [['network-2'], ['submitted'], 5]);
});

test('postgres repository lists admissions review context with sponsor load and vouches', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];

  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [], rowCount: 0 };
      if (sql.includes("set_config('app.actor_member_id'")) return { rows: [{ set_config: 'member-1' }], rowCount: 1 };
      if (sql.includes("from app.current_network_memberships cnm") && sql.includes("e.kind = 'vouched_for'")) {
        return {
          rows: [{
            membership_id: 'membership-9', network_id: 'network-2', member_id: 'member-9', public_name: 'Member Nine', handle: 'member-nine',
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
  const results = await repository.listMembershipReviews({ actorMemberId: 'member-1', networkIds: ['network-2'], limit: 5, statuses: ['pending_review'] });

  assert.equal(results.length, 1);
  assert.equal(results[0]?.sponsorStats.activeSponsoredCount, 1);
  assert.equal(results[0]?.vouches[0]?.fromMember.publicName, 'Member Two');
  assert.equal(results[0]?.vouches[0]?.reason, 'I trust their presence and follow-through.');
  assert.match(calls[2]?.sql ?? '', /e\.kind = 'vouched_for'/);
  assert.deepEqual(calls[2]?.params, [['network-2'], ['pending_review'], 5]);
});

test('postgres repository creates an application with interview intake details and reloads current projection', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];

  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [], rowCount: 0 };
      if (sql.includes("set_config('app.actor_member_id'")) return { rows: [{ set_config: 'member-1' }], rowCount: 1 };
      if (sql.includes('from app.accessible_network_memberships anm') && sql.includes("and anm.role = 'owner'")) return { rows: [{ membership_id: 'membership-owner' }], rowCount: 1 };
      if (sql.includes('from app.current_network_memberships cnm') && sql.includes('and cnm.member_id = $2') && sql.includes("and cnm.status = 'active'")) return { rows: [{ member_id: 'member-1' }], rowCount: 1 };
      if (sql.includes('select cnm.id as membership_id') && sql.includes('where cnm.id = $1')) return { rows: [{ membership_id: 'membership-9' }], rowCount: 1 };
      if (sql.includes('with applicant as (') && sql.includes('insert into app.applications')) return { rows: [{ application_id: 'application-9' }], rowCount: 1 };
      if (sql.includes('from app.current_applications ca') && sql.includes('where ca.id = $1')) {
        return {
          rows: [{
            application_id: 'application-9', network_id: 'network-2', applicant_member_id: 'member-9', applicant_public_name: 'Member Nine', applicant_handle: 'member-nine',
            sponsor_member_id: 'member-1', sponsor_public_name: 'Member One', sponsor_handle: 'member-one', membership_id: 'membership-9', path: 'sponsored',
            intake_kind: 'fit_check', intake_price_amount: '49.00', intake_price_currency: 'GBP', intake_booking_url: 'https://cal.example.test/fit-check',
            intake_booked_at: '2026-03-14T10:00:00Z', intake_completed_at: null,
            status: 'submitted', notes: 'Warm intro via sponsor', version_no: 1, version_created_at: '2026-03-12T00:00:00Z', version_created_by_member_id: 'member-1',
            metadata: { source: 'operator' }, created_at: '2026-03-12T00:00:00Z',
          }], rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };

  const repository = createPostgresRepository({ pool: { connect: async () => client } as any });
  const application = await repository.createApplication({
    actorMemberId: 'member-1',
    networkId: 'network-2',
    applicantMemberId: 'member-9',
    sponsorMemberId: 'member-1',
    membershipId: 'membership-9',
    path: 'sponsored',
    initialStatus: 'submitted',
    notes: 'Warm intro via sponsor',
    intake: { kind: 'fit_check', price: { amount: 49, currency: 'GBP' }, bookingUrl: 'https://cal.example.test/fit-check', bookedAt: '2026-03-14T10:00:00Z' },
    metadata: { source: 'operator' },
  });

  assert.ok(application);
  assert.equal(application?.applicationId, 'application-9');
  assert.match(calls[5]?.sql ?? '', /insert into app\.applications/);
  assert.deepEqual(calls[5]?.params, [
    'network-2',
    'member-9',
    'member-1',
    'membership-9',
    'sponsored',
    '{"source":"operator"}',
    'submitted',
    'Warm intro via sponsor',
    'fit_check',
    49,
    'GBP',
    'https://cal.example.test/fit-check',
    '2026-03-14T10:00:00Z',
    null,
    'member-1',
  ]);
  assert.equal(calls.at(-1)?.sql, 'commit');
});

test('postgres repository appends application state transitions and reloads current projection', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];

  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [], rowCount: 0 };
      if (sql.includes("set_config('app.actor_member_id'")) return { rows: [{ set_config: 'member-1' }], rowCount: 1 };
      if (sql.includes('from app.current_applications ca') && sql.includes('join app.accessible_network_memberships owner_scope')) {
        return {
          rows: [{
            application_id: 'application-9', network_id: 'network-2', applicant_member_id: 'member-9', current_status: 'interview_scheduled', current_version_no: 2,
            current_version_id: 'appver-2', current_metadata: { source: 'operator' }, current_intake_kind: 'fit_check', current_intake_price_amount: '49.00',
            current_intake_price_currency: 'GBP', current_intake_booking_url: 'https://cal.example.test/fit-check', current_intake_booked_at: '2026-03-14T10:00:00Z',
            current_intake_completed_at: null, current_membership_id: 'membership-9',
          }], rowCount: 1,
        };
      }
      if (sql.includes('select cnm.id as membership_id') && sql.includes('where cnm.id = $1')) return { rows: [{ membership_id: 'membership-10' }], rowCount: 1 };
      if (sql.includes('update app.applications a')) return { rows: [], rowCount: 1 };
      if (sql.includes('insert into app.application_versions')) return { rows: [], rowCount: 1 };
      if (sql.includes('from app.current_applications ca') && sql.includes('where ca.id = $1')) {
        return {
          rows: [{
            application_id: 'application-9', network_id: 'network-2', applicant_member_id: 'member-9', applicant_public_name: 'Member Nine', applicant_handle: 'member-nine',
            sponsor_member_id: 'member-1', sponsor_public_name: 'Member One', sponsor_handle: 'member-one', membership_id: 'membership-10', path: 'sponsored',
            intake_kind: 'fit_check', intake_price_amount: '49.00', intake_price_currency: 'GBP', intake_booking_url: 'https://cal.example.test/fit-check',
            intake_booked_at: '2026-03-14T10:00:00Z', intake_completed_at: '2026-03-14T10:30:00Z',
            status: 'accepted', notes: 'Strong yes', version_no: 3, version_created_at: '2026-03-14T10:30:00Z', version_created_by_member_id: 'member-1',
            metadata: { source: 'operator', outcome: 'strong_yes' }, created_at: '2026-03-12T00:00:00Z',
          }], rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };

  const repository = createPostgresRepository({ pool: { connect: async () => client } as any });
  const application = await repository.transitionApplication({
    actorMemberId: 'member-1',
    applicationId: 'application-9',
    nextStatus: 'accepted',
    notes: 'Strong yes',
    accessibleNetworkIds: ['network-2'],
    intake: { completedAt: '2026-03-14T10:30:00Z' },
    membershipId: 'membership-10',
    metadataPatch: { outcome: 'strong_yes' },
  });

  assert.ok(application);
  assert.equal(application?.state.status, 'accepted');
  assert.deepEqual(calls[3]?.params, ['membership-10', 'network-2', 'member-9']);
  assert.deepEqual(calls[4]?.params, ['application-9', 'membership-10', '{"source":"operator","outcome":"strong_yes"}']);
  assert.deepEqual(calls[5]?.params, ['application-9', 'accepted', 'Strong yes', 'fit_check', '49.00', 'GBP', 'https://cal.example.test/fit-check', '2026-03-14T10:00:00Z', '2026-03-14T10:30:00Z', 3, 'appver-2', 'member-1']);
});

test('postgres repository appends membership state transitions and reloads current projection', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];

  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [], rowCount: 0 };
      if (sql.includes("set_config('app.actor_member_id'")) return { rows: [{ set_config: 'member-1' }], rowCount: 1 };
      if (sql.includes('join app.accessible_network_memberships owner_scope')) {
        return {
          rows: [{
            membership_id: 'membership-9', network_id: 'network-2', member_id: 'member-9', current_status: 'pending_review', current_version_no: 2, current_state_version_id: 'state-2',
          }], rowCount: 1,
        };
      }
      if (sql.includes('insert into app.network_membership_state_versions')) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('where cnm.id = $1')) {
        return {
          rows: [{
            membership_id: 'membership-9', network_id: 'network-2', member_id: 'member-9', public_name: 'Member Nine', handle: 'member-nine',
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
  const membership = await repository.transitionMembershipState({ actorMemberId: 'member-1', membershipId: 'membership-9', nextStatus: 'active', reason: 'Fit check passed', accessibleNetworkIds: ['network-2'] });

  assert.ok(membership);
  assert.equal(membership?.state.status, 'active');
  assert.equal(membership?.state.versionNo, 3);
  assert.match(calls[2]?.sql ?? '', /join app\.accessible_network_memberships owner_scope/);
  assert.deepEqual(calls[2]?.params, ['member-1', 'membership-9', ['network-2']]);
  assert.deepEqual(calls[3]?.params, ['membership-9', 'active', 'Fit check passed', 3, 'state-2', 'member-1']);
  assert.equal(calls.at(-1)?.sql, 'commit');
});
