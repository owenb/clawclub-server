import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProfileSourceText, buildEntitySourceText, buildEventSourceText, computeSourceHash } from '../../src/embedding-source.ts';
import { EMBEDDING_PROFILES } from '../../src/ai.ts';

// ── Source text determinism ─────────────────────────────

test('buildProfileSourceText produces deterministic output', () => {
  const input = {
    publicName: 'Alice',
    displayName: 'Alice Smith',
    tagline: 'Builder',
    summary: 'Builds things',
    whatIDo: 'Engineering',
    knownFor: 'Quality',
    servicesSummary: 'Consulting',
    websiteUrl: 'https://alice.example',
    links: [{ label: 'GitHub', url: 'https://github.com/alice' }],
  };

  const a = buildProfileSourceText(input);
  const b = buildProfileSourceText(input);
  assert.equal(a, b, 'Same input must produce same output');
  assert.ok(a.includes('Name: Alice Smith'));
  assert.ok(a.includes('Tagline: Builder'));
  assert.ok(!a.includes('Handle'), 'Handle section must not appear (v2 source)');
});

test('buildEntitySourceText produces deterministic output', () => {
  const input = {
    kind: 'post',
    title: 'Hello World',
    summary: 'A greeting',
    body: 'Extended greeting content',
    content: { tags: ['intro'] },
  };

  const a = buildEntitySourceText(input);
  const b = buildEntitySourceText(input);
  assert.equal(a, b);
  assert.ok(a.includes('Kind: post'));
  assert.ok(a.includes('Title: Hello World'));
});

test('buildEventSourceText includes temporal fields', () => {
  const input = {
    title: 'Meetup',
    summary: 'Weekly sync',
    body: null,
    location: 'London',
    startsAt: '2026-04-10T18:00:00Z',
    endsAt: '2026-04-10T20:00:00Z',
    timezone: 'Europe/London',
    recurrenceRule: null,
    content: {},
  };

  const text = buildEventSourceText(input);
  assert.ok(text.includes('Kind: event'));
  assert.ok(text.includes('Location: London'));
  assert.ok(text.includes('Starts: 2026-04-10'));
});

// ── Source hash ─────────────────────────────────────────

test('computeSourceHash returns consistent sha256 hex', () => {
  const text = 'Name: Alice\nHandle: alice';
  const h1 = computeSourceHash(text);
  const h2 = computeSourceHash(text);
  assert.equal(h1, h2);
  assert.equal(h1.length, 64, 'Should be 64-char hex string');
});

test('computeSourceHash differs for different input', () => {
  const h1 = computeSourceHash('Name: Alice');
  const h2 = computeSourceHash('Name: Bob');
  assert.notEqual(h1, h2);
});

// ── Embedding profiles ─────────────────────────────────

test('EMBEDDING_PROFILES has expected structure', () => {
  assert.ok(EMBEDDING_PROFILES.member_profile);
  assert.ok(EMBEDDING_PROFILES.entity);
  assert.equal(EMBEDDING_PROFILES.member_profile.model, 'text-embedding-3-small');
  assert.equal(EMBEDDING_PROFILES.member_profile.dimensions, 1536);
  assert.equal(EMBEDDING_PROFILES.member_profile.sourceVersion, 'v2');
  assert.equal(EMBEDDING_PROFILES.entity.model, 'text-embedding-3-small');
  assert.equal(EMBEDDING_PROFILES.entity.dimensions, 1536);
  assert.equal(EMBEDDING_PROFILES.entity.sourceVersion, 'v1');
});

// ── Profile response no longer has embedding ────────────

test('clubProfile response schema does not include embedding', async () => {
  const { clubProfile } = await import('../../src/schemas/responses.ts');
  const shape = clubProfile.shape;
  const versionShape = shape.version.shape;
  assert.ok(!('embedding' in versionShape), 'version should not have embedding field');
});

test('entitySummary response schema does not include embedding', async () => {
  const { entitySummary } = await import('../../src/schemas/responses.ts');
  const shape = entitySummary.shape;
  const versionShape = shape.version.shape;
  assert.ok(!('embedding' in versionShape), 'version should not have embedding field');
});

// ── Fixture stubs ──────────────────────────────────────

test('makeRepository includes new search methods', async () => {
  const { makeRepository } = await import('./fixtures.ts');
  const repo = makeRepository();
  assert.equal(typeof repo.fullTextSearchMembers, 'function');
  assert.equal(typeof repo.findMembersViaEmbedding, 'function');
  assert.equal(typeof repo.findEntitiesViaEmbedding, 'function');
});

// ── Action registration ────────────────────────────────

test('members.searchByFullText action is registered', async () => {
  await import('../../src/dispatch.ts');
  const { getAction } = await import('../../src/schemas/registry.ts');
  const action = getAction('members.searchByFullText');
  assert.ok(action, 'members.searchByFullText should be registered');
  assert.equal(action?.auth, 'member');
  assert.equal(action?.safety, 'read_only');
});

test('members.searchBySemanticSimilarity action is registered', async () => {
  const { getAction } = await import('../../src/schemas/registry.ts');
  const action = getAction('members.searchBySemanticSimilarity');
  assert.ok(action, 'members.searchBySemanticSimilarity should be registered');
});

test('content.searchBySemanticSimilarity action is registered', async () => {
  const { getAction } = await import('../../src/schemas/registry.ts');
  const action = getAction('content.searchBySemanticSimilarity');
  assert.ok(action, 'content.searchBySemanticSimilarity should be registered');
});

test('old members.search action is no longer registered', async () => {
  const { getAction } = await import('../../src/schemas/registry.ts');
  const action = getAction('members.search');
  assert.equal(action, undefined, 'members.search should not exist');
});

test('old members.discover action is no longer registered', async () => {
  const { getAction } = await import('../../src/schemas/registry.ts');
  const action = getAction('members.discover');
  assert.equal(action, undefined, 'members.discover should not exist');
});

test('old members.findSimilar action is no longer registered', async () => {
  const { getAction } = await import('../../src/schemas/registry.ts');
  const action = getAction('members.findSimilar');
  assert.equal(action, undefined, 'members.findSimilar should not exist');
});
