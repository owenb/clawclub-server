import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from '../harness.ts';

let h: TestHarness;

before(async () => {
  h = await TestHarness.start();
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

function message(result: Record<string, unknown>): Record<string, unknown> {
  return (result.data as Record<string, unknown>).message as Record<string, unknown>;
}

function included(result: Record<string, unknown>): Record<string, Record<string, unknown>> {
  return ((result.data as Record<string, unknown>).included as Record<string, unknown>).membersById as Record<string, Record<string, unknown>>;
}

describe('message mentions', () => {
  it('hydrates thread and inbox mentions, dedupes included members, and preserves authoredHandle across renames', async () => {
    const owner = await h.seedOwner('dm-mention-club', 'DM Mention Club');
    const alice = await h.seedClubMember(owner.club.id, 'DM Alice', 'dm-mention-alice', { sponsorId: owner.id });
    const bob = await h.seedClubMember(owner.club.id, 'DM Bob', 'dm-mention-bob', { sponsorId: owner.id });
    const carol = await h.seedClubMember(owner.club.id, 'DM Carol', 'dm-mention-carol', { sponsorId: owner.id });

    const firstSend = await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: 'Looping in @dm-mention-carol on this one.',
    });
    const firstMessage = message(firstSend);
    assert.deepEqual(firstMessage.mentions, [{
      memberId: carol.id,
      authoredHandle: 'dm-mention-carol',
      start: 11,
      end: 28,
    }]);
    assert.equal(included(firstSend)[carol.id]?.handle, 'dm-mention-carol');

    await h.apiOk(bob.token, 'messages.send', {
      recipientMemberId: alice.id,
      messageText: 'Agreed, tagging @dm-mention-carol again for visibility.',
    });

    const inbox = await h.apiOk(alice.token, 'messages.getInbox', {});
    const inboxData = inbox.data as Record<string, unknown>;
    const inboxThread = ((inboxData.results as Array<Record<string, unknown>>)
      .find((row) => row.threadId === firstMessage.threadId) as Record<string, unknown>);
    assert.deepEqual(Object.keys(included(inbox)), [carol.id]);
    assert.equal((((inboxThread.latestMessage as Record<string, unknown>).mentions as Array<Record<string, unknown>>)[0]?.memberId), carol.id);

    const threadBeforeRename = await h.apiOk(alice.token, 'messages.getThread', {
      threadId: firstMessage.threadId as string,
      limit: 20,
    });
    const beforeRenameMessages = (threadBeforeRename.data as Record<string, unknown>).messages as Array<Record<string, unknown>>;
    assert.deepEqual(Object.keys(included(threadBeforeRename)), [carol.id]);
    assert.equal((((beforeRenameMessages[0]!.mentions as Array<Record<string, unknown>>)[0]?.authoredHandle)), 'dm-mention-carol');
    assert.equal((((beforeRenameMessages[1]!.mentions as Array<Record<string, unknown>>)[0]?.authoredHandle)), 'dm-mention-carol');

    await h.apiOk(carol.token, 'members.updateIdentity', {
      handle: 'dm-carol-renamed',
    });

    const threadAfterRename = await h.apiOk(alice.token, 'messages.getThread', {
      threadId: firstMessage.threadId as string,
      limit: 20,
    });
    const afterRenameMessages = (threadAfterRename.data as Record<string, unknown>).messages as Array<Record<string, unknown>>;
    assert.equal(included(threadAfterRename)[carol.id]?.handle, 'dm-carol-renamed');
    assert.equal((((afterRenameMessages[0]!.mentions as Array<Record<string, unknown>>)[0]?.authoredHandle)), 'dm-mention-carol');
    assert.equal((((afterRenameMessages[1]!.mentions as Array<Record<string, unknown>>)[0]?.authoredHandle)), 'dm-mention-carol');
  });

  it('rejects mentions to pending shared-club members', async () => {
    const owner = await h.seedOwner('dm-pending-club', 'DM Pending Club');
    const alice = await h.seedClubMember(owner.club.id, 'Pending Alice', 'dm-pending-alice', { sponsorId: owner.id });
    const bob = await h.seedClubMember(owner.club.id, 'Pending Bob', 'dm-pending-bob', { sponsorId: owner.id });
    const carol = await h.seedClubMember(owner.club.id, 'Pending Carol', 'dm-pending-carol', { sponsorId: owner.id });

    await h.sql(
      `update members
       set state = 'pending'
       where id = $1`,
      [carol.id],
    );

    const err = await h.apiErr(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: 'Trying to ping @dm-pending-carol before activation.',
    });
    assert.equal(err.status, 400);
    assert.equal(err.code, 'invalid_mentions');
    assert.match(err.message, /@dm-pending-carol/);
  });

  it('clientKey replays bypass mention revalidation after the mentioned member is banned', async () => {
    const admin = await h.seedSuperadmin('DM Replay Admin', 'dm-replay-admin');
    const owner = await h.seedOwner('dm-replay-club', 'DM Replay Club');
    const alice = await h.seedClubMember(owner.club.id, 'Replay Alice', 'dm-replay-alice', { sponsorId: owner.id });
    const carol = await h.seedClubMember(owner.club.id, 'Replay Carol', 'dm-replay-carol', { sponsorId: owner.id });
    const clientKey = 'dm-mention-replay';

    const first = await h.apiOk(owner.token, 'messages.send', {
      recipientMemberId: alice.id,
      messageText: 'Checking with @dm-replay-carol before we decide.',
      clientKey,
    });
    const firstMessage = message(first);

    await h.apiOk(admin.token, 'superadmin.billing.banMember', {
      memberId: carol.id,
      reason: 'dm mention replay test',
    });

    const replay = await h.apiOk(owner.token, 'messages.send', {
      recipientMemberId: alice.id,
      messageText: 'Checking with @dm-replay-carol before we decide.',
      clientKey,
    });
    const replayMessage = message(replay);

    assert.equal(replayMessage.messageId, firstMessage.messageId);
    assert.deepEqual(replayMessage.mentions, firstMessage.mentions);
    assert.equal(included(replay)[carol.id]?.memberId, carol.id);
  });

  it('suppresses mentions on removed messages for both members and superadmins', async () => {
    const admin = await h.seedSuperadmin('DM Remove Admin', 'dm-remove-admin');
    const owner = await h.seedOwner('dm-remove-mention-club', 'DM Remove Mention Club');
    const alice = await h.seedClubMember(owner.club.id, 'Remove Alice', 'dm-remove-alice', { sponsorId: owner.id });
    const bob = await h.seedClubMember(owner.club.id, 'Remove Bob', 'dm-remove-bob', { sponsorId: owner.id });
    const carol = await h.seedClubMember(owner.club.id, 'Remove Carol', 'dm-remove-carol', { sponsorId: owner.id });

    const sendResult = await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: 'This is just for @dm-remove-carol.',
    });
    const sentMessage = message(sendResult);

    await h.apiOk(alice.token, 'messages.remove', {
      messageId: sentMessage.messageId as string,
      reason: 'cleanup',
    });

    const memberThread = await h.apiOk(bob.token, 'messages.getThread', {
      threadId: sentMessage.threadId as string,
      limit: 20,
    });
    const memberMessages = (memberThread.data as Record<string, unknown>).messages as Array<Record<string, unknown>>;
    assert.deepEqual(memberMessages[0]?.mentions, []);
    assert.deepEqual(included(memberThread), {});

    const adminThread = await h.apiOk(admin.token, 'superadmin.messages.getThread', {
      threadId: sentMessage.threadId as string,
      limit: 20,
    });
    const adminMessages = (adminThread.data as Record<string, unknown>).messages as Array<Record<string, unknown>>;
    assert.deepEqual(adminMessages[0]?.mentions, []);
    assert.deepEqual(included(adminThread), {});
  });
});
