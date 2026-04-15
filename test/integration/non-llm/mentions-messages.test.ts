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

function mentionSpan(label: string, memberId: string): string {
  return `[${label}|${memberId}]`;
}

describe('message mentions', () => {
  it('hydrates DM mention spans with current display name across reads', async () => {
    const owner = await h.seedOwner('dm-mention-club', 'DM Mention Club');
    const alice = await h.seedCompedMember(owner.club.id, 'DM Alice');
    const bob = await h.seedCompedMember(owner.club.id, 'DM Bob');
    const carol = await h.seedCompedMember(owner.club.id, 'DM Carol');

    const firstSend = await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: `Looping in ${mentionSpan('DM Carol', carol.id)} on this one.`,
    });
    const firstMessage = message(firstSend);
    const mentions = firstMessage.mentions as Array<Record<string, unknown>>;
    assert.equal(mentions.length, 1);
    assert.equal(mentions[0]?.memberId, carol.id);
    assert.equal(mentions[0]?.authoredLabel, 'DM Carol');
    assert.equal(included(firstSend)[carol.id]?.publicName, 'DM Carol');

    // Display name rename — authoredLabel preserved, hydration reflects new display.
    await h.apiOk(carol.token, 'members.updateIdentity', {
      displayName: 'Carol (renamed)',
    });

    const threadAfterRename = await h.apiOk(alice.token, 'messages.getThread', {
      threadId: firstMessage.threadId as string,
      limit: 20,
    });
    const msgs = (threadAfterRename.data as Record<string, unknown>).messages as Array<Record<string, unknown>>;
    const msgMentions = (msgs[0]!.mentions as Array<Record<string, unknown>>);
    assert.equal(msgMentions[0]?.authoredLabel, 'DM Carol');
    assert.equal(included(threadAfterRename)[carol.id]?.displayName, 'Carol (renamed)');
  });

  it('rejects DM mentions with unknown member ids', async () => {
    const owner = await h.seedOwner('dm-unknown-club', 'DM Unknown Club');
    const alice = await h.seedCompedMember(owner.club.id, 'Unknown Alice');
    const bob = await h.seedCompedMember(owner.club.id, 'Unknown Bob');

    const bogusId = 'zzzzzzzzzzzz';
    const err = await h.apiErr(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: `Trying to ping ${mentionSpan('Ghost', bogusId)} before activation.`,
    });
    assert.equal(err.status, 400);
    assert.equal(err.code, 'invalid_mentions');
    assert.match(err.message, new RegExp(bogusId));
  });

  it('suppresses mentions on removed messages', async () => {
    const owner = await h.seedOwner('dm-remove-mention-club', 'DM Remove Mention Club');
    const alice = await h.seedCompedMember(owner.club.id, 'Remove Alice');
    const bob = await h.seedCompedMember(owner.club.id, 'Remove Bob');
    const carol = await h.seedCompedMember(owner.club.id, 'Remove Carol');

    const sendResult = await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: `This is just for ${mentionSpan('Remove Carol', carol.id)}.`,
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
  });
});
