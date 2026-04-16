/**
 * Content gate anchor suite — the small, high-confidence real-LLM gate that
 * runs in CI as part of `test:integration:with-llm`.
 *
 * This file is NOT the full calibration suite. The full 95-case matrix lives
 * in `test/calibration/content-gate-calibration.test.ts` and is NOT run in
 * CI — it's for on-demand calibration after prompt edits or model updates.
 *
 * The cases here are chosen to be as close to deterministic as a real-LLM
 * suite can be: each case exercises a clearly-unambiguous outcome that any
 * reasonably-tuned model should handle the same way on any run. They cover:
 *
 *   - all five artifact kinds (content, event, profile, vouch, invitation)
 *   - both rejection paths (illegal, low-quality) and pass paths
 *   - merge-path regressions for content.update
 *   - `assertActionableFeedback` on every rejection
 *
 * A flake in this suite is a real signal. A flake in the calibration suite
 * is noise to ignore unless a whole category regresses.
 *
 * Requires OPENAI_API_KEY in `.env.local`. Runtime: ~90 seconds. Cost: pennies.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from '../harness.ts';

let h: TestHarness;

before(async () => {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY must be set for content gate anchor tests');
  }
  h = await TestHarness.start({ embeddingStub: false });
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

function assertActionableFeedback(err: { status: number; code: string; message: string }): void {
  assert.equal(err.status, 422);
  const message = err.message.trim();
  assert.ok(message.length >= 40, `feedback too short: ${message}`);
  assert.match(message, /\s/, 'feedback should be a sentence, not a label');
  const normalized = message.toLowerCase();
  const disallowed = new Set([
    'low quality',
    'vague',
    'insufficient',
    'generic',
    'missing detail',
    'too vague',
    'not specific',
  ]);
  assert.ok(!disallowed.has(normalized), `feedback should not be a stock phrase: ${message}`);
}

function ownerSlug(id: number): string {
  return `cga-${id.toString().padStart(3, '0')}`;
}

function ownerName(id: number): string {
  return `Anchor Gate Club ${id}`;
}

function entityIdFrom(result: Record<string, unknown>): string {
  return ((result.data as Record<string, unknown>).entity as Record<string, unknown>).entityId as string;
}

function threadIdFrom(result: Record<string, unknown>): string {
  return ((result.data as Record<string, unknown>).entity as Record<string, unknown>).contentThreadId as string;
}

async function seedThread(
  owner: Awaited<ReturnType<TestHarness['seedOwner']>>,
  title = 'Thread subject',
): Promise<string> {
  const created = await h.apiOk(owner.token, 'content.create', {
    clubId: owner.club.id,
    kind: 'post',
    title,
    body: 'We are a 14-person B2B SaaS team moving support in-house after repeated 36-hour bug-report loops with our outsourced team. I am collecting short operator notes on staffing, SLAs, escalation rules, tooling, and the first metric that moved once support sat next to product. Reply with one tactic, one mistake, or one useful offer of help.',
  });
  return threadIdFrom(created);
}

describe('content gate anchor — clear-cut pass cases', () => {
  it('1. passes a substantive three-paragraph post', async () => {
    const owner = await h.seedOwner(ownerSlug(1), ownerName(1));
    const result = await h.apiOk(owner.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'What changed after we moved support in-house',
      body: `We spent six months undoing a fully outsourced support model. The first thing we learned was that the delay between customer pain and product learning was killing us.\n\nOnce support sat next to product, we stopped debating which bugs mattered. The team heard the same issues all week, fixed the noisy ones first, and our escalation volume dropped.\n\nIf you are under fifty customers, I would keep support close to the builders. The time you save by outsourcing is usually lost again in slower product learning.`,
    });
    assert.ok(entityIdFrom(result));
  });

  it('2. passes a well-formed in-person event', async () => {
    const owner = await h.seedOwner(ownerSlug(2), ownerName(2));
    const result = await h.apiOk(owner.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'event',
      title: 'Founders breakfast',
      summary: 'Small breakfast for founders working on consumer products. We will each share one live challenge and one metric that moved.',
      event: {
        location: 'The Wolseley, 160 Piccadilly, London W1J 9EB',
        startsAt: '2026-05-20T08:30:00Z',
        endsAt: '2026-05-20T10:00:00Z',
        timezone: 'Europe/London',
      },
    });
    assert.ok(entityIdFrom(result));
  });

  it('3. passes a substantive multi-field profile', async () => {
    const owner = await h.seedOwner(ownerSlug(3), ownerName(3));
    const result = await h.apiOk(owner.token, 'profile.update', {
      clubId: owner.club.id,
      tagline: 'Data engineer for climate and industrial systems',
      summary: 'I build data pipelines for messy operational environments where devices go offline and the reporting still has to make sense.',
      whatIDo: 'ETL, warehouse modeling, and rollout planning',
      knownFor: 'Untangling systems that grew faster than their data model',
      servicesSummary: 'Short audits, migration plans, and hands-on implementation support',
    });
    assert.equal((result.data as Record<string, unknown>).memberId, owner.id);
  });

  it('4. passes a short concrete vouch with firsthand detail', async () => {
    const owner = await h.seedOwner(ownerSlug(4), ownerName(4));
    const target = await h.seedCompedMember(owner.club.id, `Vouch Target ${4}`);
    const result = await h.apiOk(owner.token, 'vouches.create', {
      clubId: owner.club.id,
      memberId: target.id,
      reason: 'I saw him run incident response during an outage in March. He kept the team calm, narrowed the blast radius quickly, and wrote the clearest follow-up notes.',
    });
    const vouch = (result.data as Record<string, unknown>).vouch as Record<string, unknown>;
    assert.ok(vouch.edgeId);
  });
});

describe('content gate anchor — clear-cut low-quality rejections', () => {
  it('5. rejects a post with title only', async () => {
    const owner = await h.seedOwner(ownerSlug(5), ownerName(5));
    const err = await h.apiErr(owner.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'Quick thought',
    }, 'low_quality_content');
    assertActionableFeedback(err);
  });

  it('7. rejects a profile filled with generic filler', async () => {
    const owner = await h.seedOwner(ownerSlug(7), ownerName(7));
    const err = await h.apiErr(owner.token, 'profile.update', {
      clubId: owner.club.id,
      tagline: 'Versatile collaborator',
      summary: 'Focused on impact and working across many challenges.',
      whatIDo: 'I help teams succeed.',
      knownFor: 'Positive energy',
      servicesSummary: 'Available for different kinds of support.',
    }, 'low_quality_content');
    assertActionableFeedback(err);
  });

  it('8. rejects a generic adjective-chain vouch', async () => {
    const owner = await h.seedOwner(ownerSlug(8), ownerName(8));
    const target = await h.seedCompedMember(owner.club.id, `Vouch Target ${8}`);
    const err = await h.apiErr(owner.token, 'vouches.create', {
      clubId: owner.club.id,
      memberId: target.id,
      reason: 'Brilliant, thoughtful, strategic, hardworking, impressive.',
    }, 'low_quality_content');
    assertActionableFeedback(err);
  });
});

describe('content gate anchor — clear-cut illegal rejections', () => {
  it('6. rejects a reply soliciting illegal activity', async () => {
    const owner = await h.seedOwner(ownerSlug(6), ownerName(6));
    const threadId = await seedThread(owner, 'Reply seed anchor six');
    const err = await h.apiErr(owner.token, 'content.create', {
      threadId,
      kind: 'post',
      body: "I'll pay anyone who can phish this competitor's Microsoft 365 account and send me the credentials.",
    }, 'illegal_content');
    assertActionableFeedback(err);
  });

  it('9. rejects a post with a targeted violence threat', async () => {
    const owner = await h.seedOwner(ownerSlug(9), ownerName(9));
    const err = await h.apiErr(owner.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'He is going to pay',
      body: 'If Tom Walker shows up at the next meetup I am going to break his jaw myself. This is a real threat.',
    }, 'illegal_content');
    assertActionableFeedback(err);
  });

  it('10. rejects an opportunity for moving stolen goods', async () => {
    const owner = await h.seedOwner(ownerSlug(10), ownerName(10));
    const err = await h.apiErr(owner.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'opportunity',
      title: 'Distribution role',
      body: 'Need someone with a van to move stolen electronics from a storage unit to buyers this weekend.',
    }, 'illegal_content');
    assertActionableFeedback(err);
  });

  it('11. rejects an invitation endorsing money laundering', async () => {
    const owner = await h.seedOwner(ownerSlug(11), ownerName(11));
    const sponsor = await h.seedCompedMember(owner.club.id, `Sponsor ${11}`);
    const err = await h.apiErr(sponsor.token, 'invitations.issue', {
      clubId: owner.club.id,
      candidateName: `Candidate ${11}`,
      candidateEmail: `candidate${11}@example.com`,
      reason: 'I know this candidate from a cash-routing network where he helps people wash funds through shell companies.',
    }, 'illegal_content');
    assertActionableFeedback(err);
  });

  it('12. rejects a profile link label for forged identity documents', async () => {
    const owner = await h.seedOwner(ownerSlug(12), ownerName(12));
    const err = await h.apiErr(owner.token, 'profile.update', {
      clubId: owner.club.id,
      links: [{ url: 'https://example.com/offer', label: 'Counterfeit passport service' }],
    }, 'illegal_content');
    assertActionableFeedback(err);
  });
});

describe('content gate anchor — merge-path regressions', () => {
  it('13. rejects a content.update patch that hollows out a substantive post', async () => {
    const owner = await h.seedOwner(ownerSlug(13), ownerName(13));
    const created = await h.apiOk(owner.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'Launch notes',
      body: 'We launched the new import flow yesterday. The main lesson was that validation errors must appear before the upload completes or users assume the file worked.',
    });
    const err = await h.apiErr(owner.token, 'content.update', {
      entityId: entityIdFrom(created),
      body: 'More details later.',
    }, 'low_quality_content');
    assertActionableFeedback(err);
  });

  it('14. passes a content.update patch that only fixes a title typo', async () => {
    const owner = await h.seedOwner(ownerSlug(14), ownerName(14));
    const created = await h.apiOk(owner.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'Databse migration checklist',
      body: 'Checklist for the rollout: rehearse the lock profile on staging, cap the backfill batch size to keep replica lag under a minute, announce the maintenance window clearly, and keep a rollback query ready before you touch production.',
    });
    const updated = await h.apiOk(owner.token, 'content.update', {
      entityId: entityIdFrom(created),
      title: 'Database migration checklist',
    });
    assert.ok(entityIdFrom(updated));
  });

  it('15. passes a content.update patch on an existing reply with short concrete body', async () => {
    const owner = await h.seedOwner(ownerSlug(15), ownerName(15));
    const threadId = await seedThread(owner, 'Reply merge anchor seed');
    const reply = await h.apiOk(owner.token, 'content.create', {
      threadId,
      kind: 'post',
      body: 'I can review the migration SQL this evening and flag lock risks before you run it.',
    });
    const updated = await h.apiOk(owner.token, 'content.update', {
      entityId: entityIdFrom(reply),
      body: 'I can review the SQL after dinner, flag lock risks, and send inline notes by 9pm.',
    });
    assert.ok(entityIdFrom(updated));
  });
});
