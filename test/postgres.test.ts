import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresRepository } from '../src/postgres.ts';

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
