import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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

    const firstSend = await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: `Looping in ${mentionSpan('DM Bob', bob.id)} on this one.`,
    });
    const firstMessage = message(firstSend);
    const mentions = firstMessage.mentions as Array<Record<string, unknown>>;
    assert.equal(mentions.length, 1);
    assert.equal(mentions[0]?.memberId, bob.id);
    assert.equal(mentions[0]?.authoredLabel, 'DM Bob');
    assert.equal(included(firstSend)[bob.id]?.publicName, 'DM Bob');

    // Display name rename — authoredLabel preserved, hydration reflects new display.
    await h.apiOk(bob.token, 'accounts.updateIdentity', {
      clientKey: randomUUID(),
      displayName: 'Bob (renamed)',
    });

    const threadAfterRename = await h.apiOk(alice.token, 'messages.get', {
      threadId: firstMessage.threadId as string,
      limit: 20,
    });
    const msgs = (((threadAfterRename.data as Record<string, unknown>).messages as Record<string, unknown>).results) as Array<Record<string, unknown>>;
    const msgMentions = (msgs[0]!.mentions as Array<Record<string, unknown>>);
    assert.equal(msgMentions[0]?.authoredLabel, 'DM Bob');
    assert.equal(included(threadAfterRename)[bob.id]?.displayName, 'Bob (renamed)');
  });

  it('rejects DM mentions with unknown member ids', async () => {
    const owner = await h.seedOwner('dm-unknown-club', 'DM Unknown Club');
    const alice = await h.seedCompedMember(owner.club.id, 'Unknown Alice');
    const bob = await h.seedCompedMember(owner.club.id, 'Unknown Bob');

    const bogusId = 'zzzzzzzzzzzz';
    const result = await h.api(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: `Trying to ping ${mentionSpan('Ghost', bogusId)} before activation.`,
    });
    assert.equal(result.status, 409);
    assert.equal(result.body.ok, false);
    const error = result.body.error as Record<string, unknown>;
    assert.equal(error.code, 'invalid_mentions');
    const details = error.details as Record<string, unknown>;
    const invalidSpans = details.invalidSpans as Array<Record<string, unknown>>;
    assert.deepEqual(invalidSpans, [{
      mentionText: mentionSpan('Ghost', bogusId),
      memberId: bogusId,
      reason: 'not_resolvable',
    }]);
  });

  it('canonicalises caller-supplied DM mention labels to the member publicName on write', async () => {
    const owner = await h.seedOwner('dm-canon-write-club', 'DM Canon Write Club');
    const alice = await h.seedCompedMember(owner.club.id, 'DM Canon Alice');
    const bob = await h.seedCompedMember(owner.club.id, 'DM Canon Bob');

    const result = await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: `Looping in ${mentionSpan('Wrong Label', bob.id)}.`,
    });
    const sentMessage = message(result);
    const mentions = sentMessage.mentions as Array<Record<string, unknown>>;

    assert.equal(mentions.length, 1);
    assert.equal(mentions[0]?.memberId, bob.id);
    assert.equal(mentions[0]?.authoredLabel, bob.publicName);
  });

  it('canonicalises persisted spoofed DM mention labels on read', async () => {
    const owner = await h.seedOwner('dm-canon-read-club', 'DM Canon Read Club');
    const alice = await h.seedCompedMember(owner.club.id, 'DM Canon Read Alice');
    const bob = await h.seedCompedMember(owner.club.id, 'DM Canon Read Bob');

    const result = await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: `Looping in ${mentionSpan('DM Canon Read Bob', bob.id)}.`,
    });
    const sentMessage = message(result);
    const messageId = sentMessage.messageId as string;
    const threadId = sentMessage.threadId as string;

    await h.sql(
      `update dm_message_mentions
          set authored_label = 'Spoofed DM Label'
        where message_id = $1`,
      [messageId],
    );

    const readResult = await h.apiOk(alice.token, 'messages.get', { threadId });
    const messages = (((readResult.data as Record<string, unknown>).messages as Record<string, unknown>).results) as Array<Record<string, unknown>>;
    const readMessage = messages.find((row) => row.messageId === messageId) as Record<string, unknown>;
    const mentions = readMessage.mentions as Array<Record<string, unknown>>;

    assert.equal(mentions.length, 1);
    assert.equal(mentions[0]?.memberId, bob.id);
    assert.equal(mentions[0]?.authoredLabel, bob.publicName);
  });

  it('rejects DM mentions outside the thread participants', async () => {
    const owner = await h.seedOwner('dm-scope-club', 'DM Scope Club');
    const alice = await h.seedCompedMember(owner.club.id, 'Scope Alice');
    const bob = await h.seedCompedMember(owner.club.id, 'Scope Bob');
    const carol = await h.seedCompedMember(owner.club.id, 'Scope Carol');

    const result = await h.api(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: `Trying to loop in ${mentionSpan('Scope Carol', carol.id)}.`,
    });
    assert.equal(result.status, 409);
    assert.equal(result.body.ok, false);
    const error = result.body.error as Record<string, unknown>;
    assert.equal(error.code, 'invalid_mentions');
    const details = error.details as Record<string, unknown>;
    const invalidSpans = details.invalidSpans as Array<Record<string, unknown>>;
    assert.equal(invalidSpans[0]?.memberId, carol.id);
    assert.equal(invalidSpans[0]?.reason, 'not_resolvable');
  });

  it('suppresses mentions on removed messages', async () => {
    const owner = await h.seedOwner('dm-remove-mention-club', 'DM Remove Mention Club');
    const alice = await h.seedCompedMember(owner.club.id, 'Remove Alice');
    const bob = await h.seedCompedMember(owner.club.id, 'Remove Bob');

    const sendResult = await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: `This is just for ${mentionSpan('Remove Bob', bob.id)}.`,
    });
    const sentMessage = message(sendResult);

    await h.apiOk(alice.token, 'messages.remove', {
      messageId: sentMessage.messageId as string,
      reason: 'cleanup',
    });

    const memberThread = await h.apiOk(bob.token, 'messages.get', {
      threadId: sentMessage.threadId as string,
      limit: 20,
    });
    const memberMessages = (((memberThread.data as Record<string, unknown>).messages as Record<string, unknown>).results) as Array<Record<string, unknown>>;
    assert.deepEqual(memberMessages[0]?.mentions, []);
    assert.equal(included(memberThread)[alice.id]?.memberId, alice.id);
    assert.equal(included(memberThread)[bob.id]?.memberId, bob.id);
  });
});
