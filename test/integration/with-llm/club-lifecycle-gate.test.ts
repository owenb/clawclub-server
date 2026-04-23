import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { TestHarness } from '../harness.ts';

let h: TestHarness;

function assertActionableFeedback(err: { status: number; code: string; message: string }): void {
  assert.equal(err.status, 422);
  const message = err.message.trim();
  assert.ok(message.length >= 40, `feedback too short: ${message}`);
  assert.match(message, /\s/, 'feedback should be a sentence, not a stock label');
}

before(async () => {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY must be set for club lifecycle gate tests');
  }
  h = await TestHarness.start({ embeddingStub: false });
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

describe('club lifecycle gate', () => {
  it('clubs.create passes a substantive club proposal', async () => {
    const member = await h.seedMember('Club Gate Creator');
    const result = await h.apiOk(member.token, 'clubs.create', {
      clientKey: randomUUID(),
      slug: `llm-club-pass-${Date.now().toString(36)}`,
      name: 'London Operations Breakfast',
      summary: 'A private club for operations leaders running software and service teams in London. Members compare hiring patterns, incident review habits, tooling migrations, and the small workflow changes that actually improved reliability.',
      admissionPolicy: 'Members should already run operations, support, or internal tooling for a real team, and should join prepared to share one concrete lesson from their own work.',
    });

    const club = (result.data as Record<string, unknown>).club as Record<string, unknown>;
    assert.ok(club.clubId);
  });

  it('clubs.create rejects clearly illegal club text', async () => {
    const member = await h.seedMember('Illegal Club Creator');
    const err = await h.apiErr(member.token, 'clubs.create', {
      clientKey: randomUUID(),
      slug: `llm-club-illegal-${Date.now().toString(36)}`,
      name: 'Carding Circle',
      summary: 'A private group for sharing stolen card details, phishing kits, and the best ways to cash out the proceeds without getting caught.',
      admissionPolicy: 'New members should already have fraud experience and should be ready to share working tactics for phishing, laundering, and account takeovers.',
    }, 'illegal_content');
    assertActionableFeedback(err);
  });

  it('clubs.create rejects operator-hostile club text', async () => {
    const member = await h.seedMember('Hostile Club Creator');
    const err = await h.apiErr(member.token, 'clubs.create', {
      clientKey: randomUUID(),
      slug: `llm-club-hostile-${Date.now().toString(36)}`,
      name: 'Terror Crew',
      summary: 'A private club for people who want to terrorize ex-partners, coordinate intimidation, and share ways to keep targets scared and compliant.',
      admissionPolicy: 'Only admit members who are already willing to stalk, threaten, or harass specific people in real life.',
    }, 'illegal_content');
    assertActionableFeedback(err);
  });

  it('clubs.create rejects an admission policy with no concrete question or condition', async () => {
    const member = await h.seedMember('Vague Policy Creator');
    const err = await h.apiErr(member.token, 'clubs.create', {
      clientKey: randomUUID(),
      slug: `llm-club-vague-${Date.now().toString(36)}`,
      name: 'London Design Leads',
      summary: 'A private club for senior design leads in London comparing hiring pipelines, critique rituals, cross-functional handoffs, and the specific process changes that improved shipped quality in their own teams.',
      admissionPolicy: 'Just be cool. Good vibes only. No drama.',
    }, 'low_quality_content');
    assertActionableFeedback(err);
  });

  it('clubadmin.clubs.update rejects illegal text changes', async () => {
    const owner = await h.seedMember('Club Gate Owner');
    const created = await h.apiOk(owner.token, 'clubs.create', {
      clientKey: randomUUID(),
      slug: `llm-owner-club-${Date.now().toString(36)}`,
      name: 'Owner Update Club',
      summary: 'A private club for founders and operators rebuilding customer support, onboarding, and internal operations. Members compare what changed after moving key workflows in-house, trade staffing and tooling patterns, and share specific fixes that improved reliability or reduced response times.',
      admissionPolicy: 'Members should already run support, operations, or implementation work for a real team, and should join ready to share one concrete lesson, workflow, or failure they have seen firsthand.',
    });
    const clubId = String((((created.data as Record<string, unknown>).club as Record<string, unknown>).clubId));

    const err = await h.apiErr(owner.token, 'clubadmin.clubs.update', {
      clientKey: randomUUID(),
      clubId,
      admissionPolicy: 'Applicants should bring working phishing kits, stolen payroll logins, and tested cash-out routes so the group can compare the best ways to drain accounts without detection.',
    }, 'illegal_content');
    assertActionableFeedback(err);
  });

  it('superadmin.clubs.create still gates club text', async () => {
    const admin = await h.seedSuperadmin('Club Gate Superadmin');
    const owner = await h.seedMember('Club Gate Target Owner');
    const err = await h.apiErr(admin.token, 'superadmin.clubs.create', {
      clientKey: randomUUID(),
      slug: `llm-superadmin-illegal-${Date.now().toString(36)}`,
      name: 'Fraud Exchange',
      ownerMemberId: owner.id,
      summary: 'A coordination space for people moving stolen electronics and laundering money through shell companies.',
      admissionPolicy: 'Only admit people with practical experience in fraud, theft, or money laundering operations.',
    }, 'illegal_content');
    assertActionableFeedback(err);
  });

  it('superadmin.clubs.update still gates club text', async () => {
    const admin = await h.seedSuperadmin('Club Gate Superadmin Update');
    const owner = await h.seedMember('Club Gate Update Owner');
    const created = await h.apiOk(admin.token, 'superadmin.clubs.create', {
      clientKey: randomUUID(),
      slug: `llm-superadmin-pass-${Date.now().toString(36)}`,
      name: 'Superadmin Created Club',
      ownerMemberId: owner.id,
      summary: 'A private club for senior finance and operations leads who manage messy budget handoffs, procurement workflows, and reporting across small teams. Members compare how they cleaned up processes that grew faster than the company around them.',
      admissionPolicy: 'Members should already own finance, operations, or procurement work for a real organization, and should join ready to share one concrete process problem they have solved or are actively untangling.',
    });
    const clubId = String((((created.data as Record<string, unknown>).club as Record<string, unknown>).clubId));

    const err = await h.apiErr(admin.token, 'superadmin.clubs.update', {
      clientKey: randomUUID(),
      clubId,
      summary: 'This club is now for coordinating targeted violence against named rivals and sharing concrete plans for carrying it out.',
    }, 'illegal_content');
    assertActionableFeedback(err);
  });
});
