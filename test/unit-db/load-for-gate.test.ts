import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRepository } from '../../src/postgres.ts';
import type { Repository } from '../../src/contract.ts';
import { timestampsEqual } from '../../src/clubs/entities.ts';
import { TestHarness } from '../integration/harness.ts';
import { seedPublishedEntity } from '../integration/helpers.ts';

let h: TestHarness;
let repository: Repository;

before(async () => {
  h = await TestHarness.start();
  repository = createRepository(h.pools.app);
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

describe('loadEntityForGate', () => {
  it('returns the current published entity for the author inside scope', async () => {
    const owner = await h.seedOwner('load-gate-entity-1', 'Load Gate Entity 1');
    const entity = await seedPublishedEntity(h, {
      clubId: owner.club.id,
      authorMemberId: owner.id,
      kind: 'post',
      title: 'Original title',
      summary: 'Original summary',
      body: 'Original body',
    });

    const loaded = await repository.loadEntityForGate?.({
      actorMemberId: owner.id,
      entityId: entity.entityId,
      accessibleClubIds: [owner.club.id],
    });

    assert.deepEqual(loaded, {
      entityKind: 'post',
      isReply: false,
      title: 'Original title',
      summary: 'Original summary',
      body: 'Original body',
      event: null,
    });
  });

  it('preserves reply semantics for an entity later in a thread', async () => {
    const owner = await h.seedOwner('load-gate-entity-2', 'Load Gate Entity 2');
    const thread = await seedPublishedEntity(h, {
      clubId: owner.club.id,
      authorMemberId: owner.id,
      kind: 'ask',
      title: 'Need a migration review',
      body: 'Looking for a quick second pair of eyes.',
    });

    const [reply] = await h.sqlClubs<{ entity_id: string }>(
      `with ent as (
         insert into entities (club_id, kind, author_member_id, open_loop, content_thread_id)
         values ($1, 'post', $2, null, $3)
         returning id
       )
       insert into entity_versions (entity_id, version_no, state, body, created_by_member_id)
       select ent.id, 1, 'published', $4, $2
       from ent
       returning entity_id`,
      [owner.club.id, owner.id, thread.threadId, 'I can look at it this afternoon.'],
    );

    const loaded = await repository.loadEntityForGate?.({
      actorMemberId: owner.id,
      entityId: reply.entity_id,
      accessibleClubIds: [owner.club.id],
    });

    assert.equal(loaded?.entityKind, 'post');
    assert.equal(loaded?.isReply, true);
    assert.equal(loaded?.body, 'I can look at it this afternoon.');
  });

  it('returns event fields for an event entity', async () => {
    const owner = await h.seedOwner('load-gate-entity-3', 'Load Gate Entity 3');
    const event = await seedPublishedEntity(h, {
      clubId: owner.club.id,
      authorMemberId: owner.id,
      kind: 'event',
      title: 'Working session',
      summary: 'Small working session',
      event: {
        location: 'Online',
        startsAt: '2026-05-20T18:00:00Z',
        endsAt: '2026-05-20T19:30:00Z',
        timezone: 'UTC',
      },
    });

    const loaded = await repository.loadEntityForGate?.({
      actorMemberId: owner.id,
      entityId: event.entityId,
      accessibleClubIds: [owner.club.id],
    });

    assert.equal(loaded?.entityKind, 'event');
    assert.equal(loaded?.isReply, false);
    assert.equal(loaded?.title, 'Working session');
    assert.equal(loaded?.summary, 'Small working session');
    assert.equal(loaded?.body, null);
    assert.equal(loaded?.event?.location, 'Online');
    assert.equal(loaded?.event?.timezone, 'UTC');
    assert.ok(timestampsEqual(loaded?.event?.startsAt, '2026-05-20T18:00:00Z'));
    assert.ok(timestampsEqual(loaded?.event?.endsAt, '2026-05-20T19:30:00Z'));
  });

  it('returns null when the entity is outside the actor scope or not authored by the actor', async () => {
    const owner = await h.seedOwner('load-gate-entity-4', 'Load Gate Entity 4');
    const other = await h.seedCompedMember(owner.club.id, 'Other Author');
    const entity = await seedPublishedEntity(h, {
      clubId: owner.club.id,
      authorMemberId: other.id,
      kind: 'post',
      title: 'Other post',
      body: 'Not yours.',
    });

    const inaccessible = await repository.loadEntityForGate?.({
      actorMemberId: owner.id,
      entityId: entity.entityId,
      accessibleClubIds: [owner.club.id],
    });
    const wrongClub = await repository.loadEntityForGate?.({
      actorMemberId: other.id,
      entityId: entity.entityId,
      accessibleClubIds: [],
    });

    assert.equal(inaccessible, null);
    assert.equal(wrongClub, null);
  });
});

describe('loadProfileForGate', () => {
  it('returns the current profile fields with normalized links', async () => {
    const owner = await h.seedOwner('load-gate-profile-1', 'Load Gate Profile 1');
    const current = await h.sql<{ membership_id: string; version_no: number }>(
      `select membership_id, version_no
       from current_member_club_profiles
       where member_id = $1 and club_id = $2`,
      [owner.id, owner.club.id],
    );
    assert.equal(current.length, 1);

    await h.sql(
      `insert into member_club_profile_versions (
         membership_id, member_id, club_id, version_no, created_by_member_id, generation_source,
         tagline, summary, what_i_do, known_for, services_summary, website_url, links
       ) values (
         $1, $2, $3, $4, $2, 'manual',
         $5, $6, $7, $8, $9, $10, $11::jsonb
       )`,
      [
        current[0]!.membership_id,
        owner.id,
        owner.club.id,
        current[0]!.version_no + 1,
        'Migration engineer',
        'I help teams land risky schema changes cleanly.',
        'Schema and migrations',
        'Careful rollout work',
        'Postgres, TypeScript, and deployment safety',
        'https://example.com',
        JSON.stringify([{ url: 'https://example.com/work', label: 'Portfolio' }]),
      ],
    );

    const loaded = await repository.loadProfileForGate?.({
      actorMemberId: owner.id,
      clubId: owner.club.id,
    });

    assert.deepEqual(loaded, {
      tagline: 'Migration engineer',
      summary: 'I help teams land risky schema changes cleanly.',
      whatIDo: 'Schema and migrations',
      knownFor: 'Careful rollout work',
      servicesSummary: 'Postgres, TypeScript, and deployment safety',
      websiteUrl: 'https://example.com',
      links: [{ url: 'https://example.com/work', label: 'Portfolio' }],
    });
  });

  it('returns null when the actor has no current profile for that club', async () => {
    const owner = await h.seedOwner('load-gate-profile-2', 'Load Gate Profile 2');
    const otherClub = await h.seedOwner('load-gate-profile-3', 'Load Gate Profile 3');

    const loaded = await repository.loadProfileForGate?.({
      actorMemberId: owner.id,
      clubId: otherClub.club.id,
    });

    assert.equal(loaded, null);
  });
});
