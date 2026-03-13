import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresRepository } from '../src/postgres.ts';

test('postgres repository exposes current profile embedding projection metadata', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];

  const pool = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });

      if (sql.includes('from app.members m') && sql.includes('coalesce(gr.global_roles')) {
        return {
          rows: [{
            member_id: 'member-1',
            handle: 'member-one',
            public_name: 'Member One',
            global_roles: ['superadmin'],
            membership_id: 'membership-1',
            network_id: 'network-1',
            slug: 'alpha',
            network_name: 'Alpha',
            network_summary: 'First network',
            manifesto_markdown: null,
            role: 'admin',
            status: 'active',
            sponsor_member_id: 'member-2',
            joined_at: '2026-03-12T00:00:00Z',
          }],
          rowCount: 1,
        };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
    async connect() {
      return {
        async query(sql: string, params?: unknown[]) {
          calls.push({ sql, params });

          if (sql === 'begin' || sql === 'commit' || sql === 'rollback') {
            return { rows: [], rowCount: 0 };
          }

          if (sql.includes("set_config('app.actor_member_id'")) {
            return { rows: [{ set_config: 'member-1' }], rowCount: 1 };
          }

          if (sql.includes('left join app.current_profile_version_embeddings cpve')) {
            return {
              rows: [{
                member_id: 'member-2',
                public_name: 'Member Two',
                handle: 'member-two',
                display_name: 'Member Two',
                tagline: 'Builder',
                summary: 'Short summary',
                what_i_do: 'Systems',
                known_for: 'Taste',
                services_summary: 'Advisory',
                website_url: 'https://example.test/two',
                links: [],
                profile: {},
                version_id: 'profile-version-2',
                version_no: 2,
                version_created_at: '2026-03-12T00:10:00Z',
                version_created_by_member_id: 'member-2',
                embedding_id: 'embedding-1',
                embedding_model: 'text-embedding-3-large',
                embedding_dimensions: 3072,
                embedding_source_text: 'Member Two profile summary',
                embedding_metadata: { subject: 'profile' },
                embedding_created_at: '2026-03-12T00:11:00Z',
                shared_networks: [{ id: 'network-1', slug: 'alpha', name: 'Alpha' }],
              }],
              rowCount: 1,
            };
          }

          throw new Error(`Unexpected query: ${sql}`);
        },
        release() {},
      };
    },
  };

  const repository = createPostgresRepository({ pool: pool as any });
  const profile = await repository.getMemberProfile({ actorMemberId: 'member-1', targetMemberId: 'member-2' });

  assert.equal(profile?.version.embedding?.embeddingId, 'embedding-1');
  assert.equal(profile?.version.embedding?.model, 'text-embedding-3-large');
  assert.equal(profile?.version.embedding?.dimensions, 3072);
  assert.equal(profile?.version.embedding?.sourceText, 'Member Two profile summary');
  assert.deepEqual(profile?.version.embedding?.metadata, { subject: 'profile' });
  assert.match(calls.map((call) => call.sql).join('\n'), /current_profile_version_embeddings/);
});

test('postgres repository exposes current entity embedding projection metadata during listEntities', async () => {
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

      if (sql.includes('left join app.current_entity_version_embeddings ceve')) {
        return {
          rows: [{
            entity_id: 'entity-1',
            entity_version_id: 'entity-version-1',
            network_id: 'network-1',
            kind: 'post',
            author_member_id: 'member-1',
            author_public_name: 'Member One',
            author_handle: 'member-one',
            version_no: 1,
            state: 'published',
            title: 'Hello',
            summary: 'Summary',
            body: 'Body',
            effective_at: '2026-03-12T00:00:00Z',
            expires_at: null,
            version_created_at: '2026-03-12T00:00:00Z',
            content: {},
            embedding_id: 'embedding-9',
            embedding_model: 'text-embedding-3-large',
            embedding_dimensions: 3072,
            embedding_source_text: 'Hello Summary Body',
            embedding_metadata: { subject: 'entity' },
            embedding_created_at: '2026-03-12T00:01:00Z',
            entity_created_at: '2026-03-12T00:00:00Z',
          }],
          rowCount: 1,
        };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };

  const repository = createPostgresRepository({ pool: { connect: async () => client } as any });
  const entities = await repository.listEntities({ networkIds: ['network-1'], kinds: ['post'], limit: 5 });

  assert.equal(entities[0]?.version.embedding?.embeddingId, 'embedding-9');
  assert.equal(entities[0]?.version.embedding?.sourceText, 'Hello Summary Body');
  assert.deepEqual(entities[0]?.version.embedding?.metadata, { subject: 'entity' });
  assert.match(calls.map((call) => call.sql).join('\n'), /current_entity_version_embeddings/);
});
