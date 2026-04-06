/**
 * Integration tests for actions gated by the LLM quality gate.
 *
 * These tests require OPENAI_API_KEY — the quality gate calls gpt-5.4-nano
 * to evaluate content quality before allowing the action through.
 *
 * Gated actions tested here: profile.update, vouches.create, entities.create,
 * admissions.sponsor
 *
 * Run with: npm run test:integration:with-llm
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from './harness.ts';

let h: TestHarness;

before(async () => {
  h = await TestHarness.start();
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

// ── Profile Updates (gated: profile.update) ─────────────────────────────────

describe('profile.update (LLM-gated)', () => {
  it('profile.update changes own profile fields', async () => {
    const carol = await h.seedOwner('llm-profiles-update', 'LLM ProfilesUpdateClub');

    const result = await h.apiOk(carol.token, 'profile.update', {
      displayName: 'Carol Updated',
      tagline: 'Backend engineer building carbon tracking tools for small manufacturers',
      summary: 'I spent 8 years at logistics companies building warehouse management systems, then moved into climate tech. Currently freelance, helping early-stage startups get their data pipelines right.',
      whatIDo: 'Design and build backend systems in Go and TypeScript, specialising in event-driven architectures and Postgres-heavy stacks',
      knownFor: 'Zero-downtime migrations and production incident response — I have led seven major platform migrations with zero data loss',
    });
    const profile = result.data as Record<string, unknown>;

    assert.equal(profile.displayName, 'Carol Updated');
    assert.equal(profile.tagline, 'Backend engineer building carbon tracking tools for small manufacturers');
  });

  it('updated profile is visible to shared-club members', async () => {
    const owner = await h.seedOwner('llm-profiles-visibility', 'LLM ProfilesVisibilityClub');
    const dave = await h.seedClubMember(owner.club.id, 'Dave Viewer', 'llm-dave-viewer', { sponsorId: owner.id });

    await h.apiOk(owner.token, 'profile.update', {
      tagline: 'Building carbon tracking tools for the manufacturing sector',
    });

    const result = await h.apiOk(dave.token, 'profile.get', { memberId: owner.id });
    const profile = result.data as Record<string, unknown>;

    assert.equal(profile.memberId, owner.id);
    assert.equal(profile.tagline, 'Building carbon tracking tools for the manufacturing sector');
  });
});

// ── Vouching (gated: vouches.create) ────────────────────────────────────────

describe('Vouching (LLM-gated)', () => {
  it('vouches.create — member vouches for another shared-club member', async () => {
    const owner = await h.seedOwner('llm-vouch-club', 'LLM VouchClub');
    const voter = await h.seedClubMember(owner.club.id, 'Vouch Voter', 'llm-vouch-voter', { sponsorId: owner.id });

    const result = await h.apiOk(voter.token, 'vouches.create', {
      clubId: owner.club.id,
      memberId: owner.id,
      reason: 'I worked with this person on the Greenfield carbon audit project for six months last year. They restructured our entire data pipeline in half the time we estimated and kept us on track when the client changed scope mid-project.',
    });
    const data = result.data as Record<string, unknown>;
    const vouch = data.vouch as Record<string, unknown>;

    assert.ok(vouch.edgeId, 'vouch should have an edgeId');
    assert.equal((vouch.fromMember as Record<string, unknown>).memberId, voter.id);
  });

  it('vouches.list — vouch is visible', async () => {
    const owner = await h.seedOwner('llm-vouch-list-club', 'LLM VouchListClub');
    const voter = await h.seedClubMember(owner.club.id, 'Vouch Lister', 'llm-vouch-lister', { sponsorId: owner.id });

    await h.apiOk(voter.token, 'vouches.create', {
      clubId: owner.club.id,
      memberId: owner.id,
      reason: 'I collaborated with them on the Series A due diligence process at Greenfield in Q3 2025. They personally reviewed every technical document, found three critical security issues that the external audit firm missed, and presented the findings to the board. The deal closed two weeks early because of their preparation.',
    });

    const result = await h.apiOk(voter.token, 'vouches.list', {
      clubId: owner.club.id,
      memberId: owner.id,
    });
    const data = result.data as Record<string, unknown>;
    const vouches = data.results as Array<Record<string, unknown>>;

    assert.ok(Array.isArray(vouches));
    assert.ok(vouches.length >= 1);
    const found = vouches.find(
      (v) => (v.fromMember as Record<string, unknown>).memberId === voter.id,
    );
    assert.ok(found, 'vouch from voter should appear in list');
  });

  it('self-vouch is rejected', async () => {
    const owner = await h.seedOwner('llm-vouch-self-club', 'LLM VouchSelfClub');

    // The reason is written in third person to pass the quality gate's content check.
    // The handler then catches that memberId === actorMemberId and rejects with self_vouch.
    const err = await h.apiErr(owner.token, 'vouches.create', {
      clubId: owner.club.id,
      memberId: owner.id,
      reason: 'This person oversaw four major platform migrations in the last three years, each completed ahead of schedule with zero data loss. I observed firsthand how their systems architecture work enabled the team to scale from 100 to 10,000 users during our time working together at Greenfield.',
    });

    assert.equal(err.status, 400);
    assert.equal(err.code, 'self_vouch');
  });

  it('duplicate vouch is rejected', async () => {
    const owner = await h.seedOwner('llm-vouch-dup-club', 'LLM VouchDupClub');
    const voter = await h.seedClubMember(owner.club.id, 'Dup Voter', 'llm-dup-voter', { sponsorId: owner.id });

    await h.apiOk(voter.token, 'vouches.create', {
      clubId: owner.club.id,
      memberId: owner.id,
      reason: 'I worked with them on the Greenfield platform rebuild last year. They wrote the entire authentication module from scratch and it has been running in production with zero downtime for 14 months.',
    });

    const err = await h.apiErr(voter.token, 'vouches.create', {
      clubId: owner.club.id,
      memberId: owner.id,
      reason: 'In addition to the platform rebuild, they ran point on our SOC 2 compliance project from January to March 2025. They wrote 14 policy documents, coordinated with the external auditor, and we passed on our first attempt. I attended every review meeting and saw them handle difficult auditor questions with complete clarity.',
    }, 'duplicate_vouch');

    assert.equal(err.status, 409);
    assert.equal(err.code, 'duplicate_vouch');
  });

  it('cannot vouch for member not in a shared club', async () => {
    const clubA = await h.seedOwner('llm-vouch-a-club', 'LLM VouchAClub');
    const clubB = await h.seedOwner('llm-vouch-b-club', 'LLM VouchBClub');

    const err = await h.apiErr(clubA.token, 'vouches.create', {
      clubId: clubB.club.id,
      memberId: clubB.id,
      reason: 'I worked with them for eight months on the carbon tracking platform at Greenfield. They designed and built the entire ingestion pipeline that processes 2 million records daily, and personally debugged a data corruption issue at 2am on a Saturday that would have cost us our largest client.',
    });

    assert.equal(err.status, 403);
    assert.equal(err.code, 'forbidden');
  });
});

// ── Entity Update Fan-out (gated: entities.create) ──────────────────────────

describe('entity update fan-out (LLM-gated)', () => {
  it('club members get entity updates after content is created', async () => {
    const owner = await h.seedOwner('llm-upd-club-2', 'LLM UpdClub2');
    const author = await h.seedClubMember(owner.club.id, 'Alice ContentAuthor', 'llm-alice-upd-2', { sponsorId: owner.id });
    const viewer = await h.seedClubMember(owner.club.id, 'Bob ContentViewer', 'llm-bob-upd-2', { sponsorId: owner.id });

    // Seed the viewer's activity cursor before the entity is created,
    // so the follow-up poll (with cursor) sees the new activity row.
    const seedResult = await h.apiOk(viewer.token, 'updates.list', {});
    const seedUpdates = (seedResult.data as Record<string, unknown>).updates as Record<string, unknown>;
    const seedAfter = seedUpdates.nextAfter as string;

    await h.apiOk(author.token, 'entities.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'Three patterns for building reliable event-driven systems',
      summary: 'Lessons from six years of building event-driven architectures at scale',
      body: 'After building event-driven systems for six years, three patterns consistently prove their worth. First, the outbox pattern ensures you never lose data even when the message broker is down. Second, idempotent consumers with deduplication keys prevent double-processing. Third, dead-letter queues with automated replay handle transient failures gracefully.',
    });

    const result = await h.apiOk(viewer.token, 'updates.list', { after: seedAfter });
    const updates = (result.data as Record<string, unknown>).updates as Record<string, unknown>;
    const items = updates.items as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(items), 'updates.items should be an array');
    const entityUpdate = items.find((u) =>
      typeof u.topic === 'string' && u.topic.startsWith('entity.'),
    );
    assert.ok(entityUpdate, 'viewer should have an entity update after post creation');
    assert.ok(entityUpdate.entityId ?? entityUpdate.payload, 'update should carry entity context');
  });
});

// ── Admin Content (gated: entities.create as setup) ─────────────────────────

describe('superadmin.content (LLM-gated)', () => {
  it('admin.content.list — lists content across clubs', async () => {
    const admin = await h.seedSuperadmin('Admin Content', 'llm-admin-content-list');
    const ownerCtx = await h.seedOwner('llm-content-list-club', 'LLM Content List Club');

    await h.apiOk(ownerCtx.token, 'entities.create', {
      clubId: ownerCtx.club.id,
      kind: 'post',
      title: 'How we reduced our cloud costs by 40 percent last quarter',
      body: 'By auditing our AWS resource usage and implementing reserved instances for stable workloads, we cut our monthly cloud bill from $8,000 to $4,800. The biggest wins came from right-sizing our RDS instances and moving cold data to S3 Glacier.',
    });

    const result = await h.apiOk(admin.token, 'superadmin.content.list', {
      clubId: ownerCtx.club.id,
      limit: 10,
    });
    const data = result.data as Record<string, unknown>;
    const content = data.content as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(content));
    assert.ok(content.length >= 1);
    assert.ok(content.some((c) => c.title === 'How we reduced our cloud costs by 40 percent last quarter'));
  });

  it('admin.content.archive — archives content', async () => {
    const admin = await h.seedSuperadmin('Admin Archiver Content', 'llm-admin-content-archive');
    const ownerCtx = await h.seedOwner('llm-content-archive-club', 'LLM Content Archive Club');

    const createResult = await h.apiOk(ownerCtx.token, 'entities.create', {
      clubId: ownerCtx.club.id,
      kind: 'post',
      title: 'Lessons from our first year running a remote engineering team',
      body: 'Managing a distributed team of eight engineers across four time zones taught us that async communication is not optional. We adopted written RFCs for every decision, recorded all meetings, and moved standups to written updates. Productivity improved measurably in the first quarter.',
    });
    const createData = createResult.data as Record<string, unknown>;
    const entity = createData.entity as Record<string, unknown>;
    const entityId = entity.entityId as string;

    const result = await h.apiOk(admin.token, 'clubadmin.entities.remove', { clubId: ownerCtx.club.id, entityId, reason: 'Content policy violation' });
    const data = result.data as Record<string, unknown>;
    const removedEntity = data.entity as Record<string, unknown>;
    assert.equal(removedEntity.entityId, entityId);
  });
});

// ── Admissions Sponsor (gated: admissions.sponsor) ──────────────────────────

describe('admissions.sponsor (LLM-gated)', () => {
  it('member sponsors an outsider for admission', async () => {
    const owner = await h.seedOwner('llm-sponsor-club', 'LLM Sponsor Club');
    const sponsor = await h.seedClubMember(owner.club.id, 'Sponsor Member', 'llm-sponsor-member', {
      sponsorId: owner.id,
    });

    const result = await h.apiOk(sponsor.token, 'admissions.sponsor', {
      clubId: owner.club.id,
      name: 'Jane Morrison',
      email: 'jane.morrison@greenfield.io',
      socials: '@janemorrison',
      reason: 'I have worked with Jane for three years at Greenfield building the carbon tracking platform. She designed the data ingestion pipeline that processes 2 million records daily and mentored two junior engineers to production readiness. She would be a strong fit for this club because she brings deep technical expertise in exactly the B2B SaaS infrastructure space that several members work in.',
    });
    const adm = (result.data as Record<string, unknown>).admission as Record<string, unknown>;
    assert.ok(adm.admissionId, 'admissions.sponsor should return an admissionId');
    assert.equal(adm.origin, 'member_sponsored');
    assert.equal((adm.sponsor as Record<string, unknown>).memberId, sponsor.id);
  });
});
