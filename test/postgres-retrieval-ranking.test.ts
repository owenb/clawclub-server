import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresRepository } from '../src/postgres.ts';

test('postgres repository forwards entity query terms into deterministic retrieval SQL', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];

  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });

      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') {
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes("set_config('app.actor_member_id'")) {
        return { rows: [{ set_config: '' }], rowCount: 1 };
      }

      if (sql.includes('from scope s') && sql.includes('join app.live_entities le') && sql.includes('where le.kind = any($2::app.entity_kind[])')) {
        return {
          rows: [{
            entity_id: 'entity-1',
            entity_version_id: 'entity-version-1',
            club_id: 'club-1',
            kind: 'service',
            author_member_id: 'member-1',
            author_public_name: 'Member One',
            author_handle: 'member-one',
            version_no: 1,
            state: 'published',
            title: 'Backend operator',
            summary: 'Helps with infra',
            body: 'Reliable systems support',
            effective_at: '2026-03-13T10:00:00Z',
            expires_at: null,
            version_created_at: '2026-03-13T10:00:00Z',
            content: {},
            entity_created_at: '2026-03-13T10:00:00Z',
          }],
          rowCount: 1,
        };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };

  const repository = createPostgresRepository({ pool: { connect: async () => client } as any });
  const results = await repository.listEntities({
    actorMemberId: 'member-1',
    clubIds: ['club-1'],
    kinds: ['service'],
    limit: 5,
    query: 'backend',
  });

  assert.equal(results[0]?.entityId, 'entity-1');
  assert.match(calls[2]?.sql ?? '', /lower\(coalesce\(le\.title, ''\)\) = lower\(\$3::text\)/);
  assert.match(calls[2]?.sql ?? '', /coalesce\(le\.summary, ''\) ilike \$4/);
  assert.deepEqual(calls[2]?.params, [['club-1'], ['service'], 'backend', '%backend%', 'backend%', 5]);
});

test('postgres repository forwards event query terms into deterministic retrieval SQL', async () => {
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

      if (sql.includes('select le.entity_id') && sql.includes("where le.kind = 'event'")) {
        return {
          rows: [{ entity_id: 'event-1' }],
          rowCount: 1,
        };
      }

      if (sql.includes('with actor_scope as (') && sql.includes("e.id = any($2") && sql.includes("and e.kind = 'event'")) {
        return {
          rows: [{
            entity_id: 'event-1',
            entity_version_id: 'event-version-1',
            club_id: 'club-1',
            author_member_id: 'member-1',
            author_public_name: 'Member One',
            author_handle: 'member-one',
            version_no: 1,
            state: 'published',
            title: 'Hetzner operator session',
            summary: 'Review rollout plan',
            body: 'Short sync',
            starts_at: '2026-03-14T15:00:00Z',
            ends_at: '2026-03-14T15:30:00Z',
            timezone: 'UTC',
            recurrence_rule: null,
            capacity: 6,
            effective_at: '2026-03-13T10:00:00Z',
            expires_at: null,
            version_created_at: '2026-03-13T10:00:00Z',
            content: {},
            entity_created_at: '2026-03-13T10:00:00Z',
            viewer_response: null,
            yes_count: 0,
            maybe_count: 0,
            no_count: 0,
            waitlist_count: 0,
            attendees: [],
          }],
          rowCount: 1,
        };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };

  const repository = createPostgresRepository({ pool: { connect: async () => client } as any });
  const results = await repository.listEvents({
    actorMemberId: 'member-1',
    clubIds: ['club-1'],
    limit: 3,
    query: 'hetzner',
  });

  assert.equal(results[0]?.entityId, 'event-1');
  assert.match(calls[2]?.sql ?? '', /lower\(coalesce\(le\.title, ''\)\) = lower\(\$2::text\)/);
  assert.match(calls[2]?.sql ?? '', /coalesce\(le\.body, ''\) ilike \$3/);
  assert.deepEqual(calls[2]?.params, [['club-1'], 'hetzner', '%hetzner%', 'hetzner%', 3]);
});

test('postgres repository escapes LIKE metacharacters in entity retrieval queries', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];

  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });

      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') {
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes("set_config('app.actor_member_id'")) {
        return { rows: [{ set_config: '' }], rowCount: 1 };
      }

      if (sql.includes('from scope s') && sql.includes('join app.live_entities le') && sql.includes('where le.kind = any($2::app.entity_kind[])')) {
        return { rows: [], rowCount: 0 };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };

  const repository = createPostgresRepository({ pool: { connect: async () => client } as any });
  const results = await repository.listEntities({
    actorMemberId: 'member-1',
    clubIds: ['club-1'],
    kinds: ['service'],
    limit: 5,
    query: '100%_backend',
  });

  assert.deepEqual(results, []);
  assert.match(calls[2]?.sql ?? '', /ilike \$4 escape '\\'/);
  assert.deepEqual(calls[2]?.params, [['club-1'], ['service'], '100%_backend', '%100\\%\\_backend%', '100\\%\\_backend%', 5]);
});
