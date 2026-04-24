import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from '../harness.ts';
import { passthroughGate } from '../../unit/fixtures.ts';

let h: TestHarness;

before(async () => {
  h = await TestHarness.start({ llmGate: passthroughGate });
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

describe('pagination canon', () => {
  it('rejects out-of-range limits instead of clamping', async () => {
    const owner = await h.seedOwner('pagination-limit-club', 'Pagination Limit Club');
    const admin = await h.seedSuperadmin('Pagination Limit Admin');

    for (const limit of [0, -1, 21]) {
      const err = await h.apiErr(owner.token, 'content.list', {
        clubId: owner.club.id,
        limit,
      });
      assert.equal(err.status, 400);
      assert.equal(err.code, 'invalid_input');
    }

    const adminErr = await h.apiErr(admin.token, 'superadmin.clubs.list', {
      limit: 51,
    });
    assert.equal(adminErr.status, 400);
    assert.equal(adminErr.code, 'invalid_input');
  });

  it('walks superadmin.clubs.list with canonical pagination and active clubs first', async () => {
    const admin = await h.seedSuperadmin('Pagination Clubs Admin');
    const active = await h.seedOwner('pagination-active-club', 'ZZZ Pagination Active Club');
    const archived = await h.seedOwner('pagination-archived-club', 'AAA Pagination Archived Club');
    await h.apiOk(admin.token, 'superadmin.clubs.archive', { clubId: archived.club.id });

    const seen: Array<{ slug: string; archivedAt: string | null }> = [];
    let cursor: string | null = null;
    for (let i = 0; i < 50; i += 1) {
      const page = await h.apiOk(admin.token, 'superadmin.clubs.list', {
        includeArchived: true,
        limit: 1,
        cursor,
      });
      const data = page.data as Record<string, unknown>;
      assert.equal(data.includeArchived, true);
      const results = data.results as Array<Record<string, unknown>>;
      assert.ok(Array.isArray(results));
      for (const club of results) {
        seen.push({
          slug: String(club.slug),
          archivedAt: club.archivedAt === null ? null : String(club.archivedAt),
        });
      }
      cursor = data.nextCursor as string | null;
      if (!cursor) break;
    }

    const activeIndex = seen.findIndex((club) => club.slug === active.club.slug);
    const archivedIndex = seen.findIndex((club) => club.slug === archived.club.slug);
    assert.notEqual(activeIndex, -1);
    assert.notEqual(archivedIndex, -1);
    assert.equal(seen[activeIndex]?.archivedAt, null);
    assert.notEqual(seen[archivedIndex]?.archivedAt, null);
    assert.ok(activeIndex < archivedIndex, 'active clubs should sort before archived clubs');
  });

  it('walks superadmin.messages.get with canonical nested pagination', async () => {
    const admin = await h.seedSuperadmin('Pagination Messages Admin');
    const sender = await h.seedOwner('pagination-dm-club', 'Pagination DM Club');
    const recipient = await h.seedCompedMember(sender.club.id, 'Pagination DM Recipient');

    const first = await h.apiOk(sender.token, 'messages.send', {
      recipientMemberId: recipient.id,
      messageText: 'first pagination message',
      clientKey: 'pagination-dm-1',
    });
    const firstMessage = (first.data as Record<string, unknown>).message as Record<string, unknown>;
    const threadId = String(firstMessage.threadId);
    await h.apiOk(sender.token, 'messages.send', {
      recipientMemberId: recipient.id,
      messageText: 'second pagination message',
      clientKey: 'pagination-dm-2',
    });

    const page1 = await h.apiOk(admin.token, 'superadmin.messages.get', { threadId, limit: 1 });
    const messages1 = ((page1.data as Record<string, unknown>).messages) as Record<string, unknown>;
    assert.equal((messages1.results as unknown[]).length, 1);
    assert.equal(messages1.hasMore, true);
    assert.equal(typeof messages1.nextCursor, 'string');

    const page2 = await h.apiOk(admin.token, 'superadmin.messages.get', {
      threadId,
      limit: 1,
      cursor: messages1.nextCursor,
    });
    const messages2 = ((page2.data as Record<string, unknown>).messages) as Record<string, unknown>;
    assert.equal((messages2.results as unknown[]).length, 1);
    assert.equal(messages2.hasMore, false);
  });

  it('walks invitations.list with canonical pagination', async () => {
    const sponsor = await h.seedOwner('pagination-invite-club', 'Pagination Invite Club');
    for (let i = 0; i < 3; i += 1) {
      await h.apiOk(sponsor.token, 'invitations.issue', {
        clubId: sponsor.club.id,
        candidateName: `Pagination Invitee ${i}`,
        candidateEmail: `pagination-invitee-${i}@example.com`,
        reason: 'This person has enough context for the pagination canon test.',
        clientKey: `pagination-invite-${i}`,
      });
    }

    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let i = 0; i < 3; i += 1) {
      const page = await h.apiOk(sponsor.token, 'invitations.list', {
        clubId: sponsor.club.id,
        limit: 1,
        cursor,
      });
      const data = page.data as Record<string, unknown>;
      const results = data.results as Array<Record<string, unknown>>;
      assert.equal(results.length, 1);
      seen.add(String(results[0]?.invitationId));
      cursor = data.nextCursor as string | null;
      if (i < 2) assert.equal(typeof cursor, 'string');
    }
    assert.equal(seen.size, 3);
  });
});
