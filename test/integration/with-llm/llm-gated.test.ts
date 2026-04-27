/**
 * Integration tests for actions gated by the LLM content gate.
 *
 * These tests require OPENAI_API_KEY — the LLM content gate calls gpt-5.4-nano
 * before allowing the action through.
 *
 * Gated actions tested here: members.updateProfile, vouches.create, content.create,
 * invitations.issue
 *
 * Run with: npm run test:integration:with-llm
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from '../harness.ts';

let h: TestHarness;

before(async () => {
  h = await TestHarness.start({ embeddingStub: false });
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

// ── Profile Updates (gated: members.updateProfile) ─────────────────────────────────

describe('members.updateProfile (LLM-gated)', () => {
  it('members.updateProfile changes own profile fields', async () => {
    const carol = await h.seedOwner('llm-profiles-update', 'LLM ProfilesUpdateClub');

    const result = await h.apiOk(carol.token, 'members.updateProfile', {
      clubId: carol.club.id,
      tagline: 'Backend engineer building carbon tracking tools for small manufacturers',
      summary: 'I spent 8 years at logistics companies building warehouse management systems, then moved into climate tech. Currently freelance, helping early-stage startups get their data pipelines right.',
      whatIDo: 'Design and build backend systems in Go and TypeScript, specialising in event-driven architectures and Postgres-heavy stacks',
      knownFor: 'Zero-downtime migrations and production incident response — I have led seven major platform migrations with zero data loss',
    });
    const profile = result.data as Record<string, unknown>;
    const profiles = profile.profiles as Array<Record<string, unknown>>;

    assert.equal(Object.hasOwn(profile, 'displayName'), false);
    assert.equal(profiles[0]?.tagline, 'Backend engineer building carbon tracking tools for small manufacturers');
  });

  it('updated profile is visible to shared-club members', async () => {
    const owner = await h.seedOwner('llm-profiles-visibility', 'LLM ProfilesVisibilityClub');
    const dave = await h.seedCompedMember(owner.club.id, 'Dave Viewer');

    await h.apiOk(owner.token, 'members.updateProfile', {
      clubId: owner.club.id,
      tagline: 'Building carbon tracking tools for the manufacturing sector',
      summary: 'I build reporting systems for small manufacturers that need auditable emissions data without hiring a full internal platform team.',
    });

    const result = await h.apiOk(dave.token, 'members.get', {
      clubId: owner.club.id,
      memberId: owner.id,
    });
    const member = ((result.data as Record<string, unknown>).member ?? {}) as Record<string, unknown>;

    assert.equal(member.memberId, owner.id);
    assert.equal(member.tagline, 'Building carbon tracking tools for the manufacturing sector');
  });
});

// ── Vouching (gated: vouches.create) ────────────────────────────────────────

describe('Vouching (LLM-gated)', () => {
  it('vouches.create — member vouches for another shared-club member', async () => {
    const owner = await h.seedOwner('llm-vouch-club', 'LLM VouchClub');
    const voter = await h.seedCompedMember(owner.club.id, 'Vouch Voter');

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
    const voter = await h.seedCompedMember(owner.club.id, 'Vouch Lister');

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

  it('self-vouch is rejected opaquely', async () => {
    const owner = await h.seedOwner('llm-vouch-self-club', 'LLM VouchSelfClub');
    const err = await h.apiErr(owner.token, 'vouches.create', {
      clubId: owner.club.id,
      memberId: owner.id,
      reason: 'This person oversaw four major platform migrations in the last three years, each completed ahead of schedule with zero data loss. I observed firsthand how their systems architecture work enabled the team to scale from 100 to 10,000 users during our time working together at Greenfield.',
    });

    assert.equal(err.status, 404);
    assert.equal(err.code, 'vouchee_not_accessible');
  });

  it('duplicate vouch is rejected', async () => {
    const owner = await h.seedOwner('llm-vouch-dup-club', 'LLM VouchDupClub');
    const voter = await h.seedCompedMember(owner.club.id, 'Dup Voter');

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

    assert.equal(err.status, 404);
    assert.equal(err.code, 'vouchee_not_accessible');
  });
});

// ── Content Update Fan-out (gated: content.create) ─────────────────────────

describe('content update fan-out (LLM-gated)', () => {
  it('club members get content updates after content is created', async () => {
    const owner = await h.seedOwner('llm-upd-club-2', 'LLM UpdClub2');
    const author = await h.seedCompedMember(owner.club.id, 'Alice ContentAuthor');
    const viewer = await h.seedCompedMember(owner.club.id, 'Bob ContentViewer');

    const seedResult = await h.getActivity(viewer.token, { clubId: owner.club.id, after: 'latest' });
    const seedAfter = (((seedResult.body.data as Record<string, unknown>).activity as Record<string, unknown>).nextCursor) as string;

    await h.apiOk(author.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'Three patterns for building reliable event-driven systems',
      summary: 'Lessons from six years of building event-driven architectures at scale',
      body: 'After building event-driven systems for six years, three patterns consistently prove their worth. First, the outbox pattern ensures you never lose data even when the message broker is down. Second, idempotent consumers with deduplication keys prevent double-processing. Third, dead-letter queues with automated replay handle transient failures gracefully.',
    });

    const result = await h.getActivity(viewer.token, { clubId: owner.club.id, after: seedAfter });
    const items = (((result.body.data as Record<string, unknown>).activity as Record<string, unknown>).results) as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(items), 'activity.results should be an array');
    const contentUpdate = items.find((u) =>
      typeof u.topic === 'string' && u.topic.startsWith('content.'),
    );
    assert.ok(contentUpdate, 'viewer should have a content activity event after post creation');
    assert.ok(contentUpdate.contentId ?? contentUpdate.payload, 'update should carry content context');
  });
});

// ── Admin Content (gated: content.create as setup) ─────────────────────────

describe('superadmin.content (LLM-gated)', () => {
  it('admin.content.list — lists content across clubs', async () => {
    const admin = await h.seedSuperadmin('Admin Content');
    const ownerCtx = await h.seedOwner('llm-content-list-club', 'LLM Content List Club');

    await h.apiOk(ownerCtx.token, 'content.create', {
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
    const content = data.results as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(content));
    assert.ok(content.length >= 1);
    assert.ok(
      content.some((c) => {
        const version = c.version as Record<string, unknown> | undefined;
        return version?.title === 'How we reduced our cloud costs by 40 percent last quarter';
      }),
    );
  });

  it('admin.content.archive — archives content', async () => {
    const admin = await h.seedSuperadmin('Admin Archiver Content');
    const ownerCtx = await h.seedOwner('llm-content-archive-club', 'LLM Content Archive Club');

    const createResult = await h.apiOk(ownerCtx.token, 'content.create', {
      clubId: ownerCtx.club.id,
      kind: 'post',
      title: 'Lessons from our first year running a remote engineering team',
      body: 'Managing a distributed team of eight engineers across four time zones taught us that async communication is not optional. We adopted written RFCs for every decision, recorded all meetings, and moved standups to written updates. Productivity improved measurably in the first quarter.',
    });
    const createData = createResult.data as Record<string, unknown>;
    const content = createData.content as Record<string, unknown>;
    const contentId = content.id as string;

    const result = await h.apiOk(admin.token, 'clubadmin.content.remove', { clubId: ownerCtx.club.id, id: contentId, reason: 'Content policy violation' });
    const data = result.data as Record<string, unknown>;
    const removedContent = data.content as Record<string, unknown>;
    assert.equal(removedContent.id, contentId);
  });
});

// ── Invitations (gated: invitations.issue) ──────────────────────────

describe('invitations.issue (LLM-gated)', () => {
  it('member issues an invitation for a candidate', async () => {
    const owner = await h.seedOwner('llm-sponsor-club', 'LLM Sponsor Club');
    const sponsor = await h.seedCompedMember(owner.club.id, 'Sponsor Member');

    const result = await h.apiOk(sponsor.token, 'invitations.issue', {
      clubId: owner.club.id,
      candidateName: 'Jane Morrison',
      candidateEmail: 'jane.morrison@greenfield.io',
      reason: 'I have worked with Jane for three years at Greenfield building the carbon tracking platform. She designed the data ingestion pipeline that processes 2 million records daily and mentored two junior engineers to production readiness. She would be a strong fit for this club because she brings deep technical expertise in exactly the B2B SaaS infrastructure space that several members work in.',
    });
    const invitation = (result.data as Record<string, unknown>).invitation as Record<string, unknown>;
    assert.ok(invitation.invitationId, 'invitations.issue should return an invitationId');
    assert.equal((invitation.sponsor as Record<string, unknown>).memberId, sponsor.id);
    assert.match(String(invitation.code ?? ''), /^[A-HJ-KM-NP-TV-Z2-9]{4}-[A-HJ-KM-NP-TV-Z2-9]{4}$/);
  });
});

describe('club spend reservations (LLM-gated)', () => {
  it('records actual prompt and completion spend for a gated content.create call', async () => {
    const owner = await h.seedOwner('llm-spend-club', 'LLM Spend Club');

    await h.apiOk(owner.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'Measured spend post',
      body: 'We now record club AI spend from the real gate response instead of relying only on an output-token fuse. For one content.create call we persist the measured prompt tokens, the measured completion tokens, and the finalized micro-cent cost on a club-scoped reservation row.\n\nThat means a superadmin can inspect one club and see what it actually cost us, not just how many times members posted. The useful follow-up is to compare a few real rows against our reservation estimate and check whether the safety margin is consistently too wide or too tight.',
      clientKey: 'llm-spend-create-1',
    });

    const reservations = await h.sql<{
      action_name: string;
      status: string;
      actual_prompt_tokens: number | null;
      actual_completion_tokens: number | null;
      actual_micro_cents: string | null;
    }>(
      `select action_name,
              status,
              actual_prompt_tokens,
              actual_completion_tokens,
              actual_micro_cents::text as actual_micro_cents
       from ai_club_spend_reservations
       where club_id = $1
         and action_name = 'content.create'
       order by created_at desc
       limit 1`,
      [owner.club.id],
    );
    assert.equal(reservations.length, 1);
    assert.equal(reservations[0]!.status, 'finalized');
    assert.ok((reservations[0]!.actual_prompt_tokens ?? 0) > 0);
    assert.ok((reservations[0]!.actual_completion_tokens ?? 0) >= 0);
    assert.ok(Number(reservations[0]!.actual_micro_cents ?? '0') > 0);

    const usageLogs = await h.sql<{
      requested_club_id: string | null;
      prompt_tokens: number | null;
      completion_tokens: number | null;
      gate_status: string;
    }>(
      `select requested_club_id,
              prompt_tokens,
              completion_tokens,
              gate_status::text as gate_status
       from ai_llm_usage_log
       where requested_club_id = $1
         and action_name = 'content.create'
       order by created_at desc
       limit 1`,
      [owner.club.id],
    );
    assert.equal(usageLogs.length, 1);
    assert.equal(usageLogs[0]!.requested_club_id, owner.club.id);
    assert.equal(usageLogs[0]!.gate_status, 'passed');
    assert.ok((usageLogs[0]!.prompt_tokens ?? 0) > 0);
    assert.ok((usageLogs[0]!.completion_tokens ?? 0) >= 0);
  });
});
