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

// ── Messages ──────────────────────────────────────────────────────────────────

describe('messages', () => {
  it('two shared-club members can exchange a DM via messages.send', async () => {
    const owner = await h.seedOwner('msg-club-1', 'MsgClub1');
    const alice = await h.seedCompedMember(owner.club.id, 'Alice Sender', 'alice-msg-1');
    const bob = await h.seedCompedMember(owner.club.id, 'Bob Recipient', 'bob-msg-1');

    const result = await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: 'Hello Bob!',
    });
    const message = (result.data as Record<string, unknown>).message as Record<string, unknown>;
    assert.ok(message.threadId, 'sent message should have a threadId');
    assert.ok(message.messageId, 'sent message should have a messageId');
    assert.equal(message.senderMemberId, alice.id);
    assert.equal(message.recipientMemberId, bob.id);
    assert.equal(message.messageText, 'Hello Bob!');
  });

  it('sender sees the thread in messages.getInbox', async () => {
    const owner = await h.seedOwner('msg-club-2', 'MsgClub2');
    const alice = await h.seedCompedMember(owner.club.id, 'Alice Inbox', 'alice-msg-2');
    const bob = await h.seedCompedMember(owner.club.id, 'Bob Inbox', 'bob-msg-2');

    const sent = await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: 'Hey Bob, checking inbox.',
    });
    const sentMessage = (sent.data as Record<string, unknown>).message as Record<string, unknown>;
    const threadId = sentMessage.threadId as string;

    const inbox = await h.apiOk(alice.token, 'messages.getInbox', {});
    const results = (inbox.data as Record<string, unknown>).results as Array<Record<string, unknown>>;
    const found = results.find((t) => t.threadId === threadId);
    assert.ok(found, 'sender should see the thread in their inbox');
    assert.equal(found.counterpartMemberId, bob.id);
  });

  it('recipient sees the thread in messages.getInbox', async () => {
    const owner = await h.seedOwner('msg-club-3', 'MsgClub3');
    const alice = await h.seedCompedMember(owner.club.id, 'Alice Recv', 'alice-msg-3');
    const bob = await h.seedCompedMember(owner.club.id, 'Bob Recv', 'bob-msg-3');

    const sent = await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: 'Bob, you should see this.',
    });
    const sentMessage = (sent.data as Record<string, unknown>).message as Record<string, unknown>;
    const threadId = sentMessage.threadId as string;

    const inbox = await h.apiOk(bob.token, 'messages.getInbox', {});
    const results = (inbox.data as Record<string, unknown>).results as Array<Record<string, unknown>>;
    const found = results.find((t) => t.threadId === threadId);
    assert.ok(found, 'recipient should see the thread in their inbox');
    assert.equal(found.counterpartMemberId, alice.id);

    const unread = found.unread as Record<string, unknown>;
    assert.ok(unread, 'inbox thread should have an unread block');
    assert.ok(typeof unread.hasUnread === 'boolean', 'hasUnread should be a boolean');
    assert.ok(typeof unread.unreadMessageCount === 'number', 'unreadMessageCount should be a number');
  });

  it('messages.getThread returns the thread and message list', async () => {
    const owner = await h.seedOwner('msg-club-4', 'MsgClub4');
    const alice = await h.seedCompedMember(owner.club.id, 'Alice Read', 'alice-msg-4');
    const bob = await h.seedCompedMember(owner.club.id, 'Bob Read', 'bob-msg-4');

    const sent = await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: 'First message in thread.',
    });
    const sentMessage = (sent.data as Record<string, unknown>).message as Record<string, unknown>;
    const threadId = sentMessage.threadId as string;
    const messageId = sentMessage.messageId as string;

    const readResult = await h.apiOk(alice.token, 'messages.getThread', { threadId });
    const data = readResult.data as Record<string, unknown>;

    const thread = data.thread as Record<string, unknown>;
    assert.ok(thread, 'messages.getThread should return a thread summary');
    assert.equal(thread.threadId, threadId);
    assert.equal(thread.counterpartMemberId, bob.id);
    assert.ok(thread.messageCount, 'thread should have a messageCount');

    const messages = data.messages as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(messages), 'messages should be an array');
    assert.ok(messages.length >= 1, 'at least one message should be in the thread');
    const msg = messages.find((m) => m.messageId === messageId);
    assert.ok(msg, 'the sent message should appear in the thread');
    assert.equal(msg.senderMemberId, alice.id);
    assert.equal(msg.messageText, 'First message in thread.');
  });

  it('messages.getInbox returns the thread summary', async () => {
    const owner = await h.seedOwner('msg-club-5', 'MsgClub5');
    const alice = await h.seedCompedMember(owner.club.id, 'Alice List', 'alice-msg-5');
    const bob = await h.seedCompedMember(owner.club.id, 'Bob List', 'bob-msg-5');

    const sent = await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: 'Thread for messages.getInbox.',
    });
    const sentMessage = (sent.data as Record<string, unknown>).message as Record<string, unknown>;
    const threadId = sentMessage.threadId as string;

    const list = await h.apiOk(alice.token, 'messages.getInbox', {});
    const results = (list.data as Record<string, unknown>).results as Array<Record<string, unknown>>;
    const found = results.find((t) => t.threadId === threadId);
    assert.ok(found, 'thread should appear in messages.getInbox');
    assert.equal(found.counterpartMemberId, bob.id);

    const latestMessage = found.latestMessage as Record<string, unknown>;
    assert.ok(latestMessage, 'thread should have latestMessage');
    assert.equal(latestMessage.messageText, 'Thread for messages.getInbox.');
  });

  it('a third member not in the conversation cannot read the thread', async () => {
    const owner = await h.seedOwner('msg-club-6', 'MsgClub6');
    const alice = await h.seedCompedMember(owner.club.id, 'Alice Private', 'alice-msg-6');
    const bob = await h.seedCompedMember(owner.club.id, 'Bob Private', 'bob-msg-6');
    const carol = await h.seedCompedMember(owner.club.id, 'Carol Outsider', 'carol-msg-6');

    const sent = await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: 'Private message.',
    });
    const sentMessage = (sent.data as Record<string, unknown>).message as Record<string, unknown>;
    const threadId = sentMessage.threadId as string;

    // Carol is not a participant — she should get not_found
    const err = await h.apiErr(carol.token, 'messages.getThread', { threadId });
    assert.equal(err.code, 'not_found');
  });

  it('member can DM the club owner and owner can reply', async () => {
    const owner = await h.seedOwner('msg-club-7', 'MsgClub7');
    const alice = await h.seedCompedMember(owner.club.id, 'Alice ToOwner', 'alice-msg-7');

    // Member messages the owner
    const sent = await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: owner.id,
      messageText: 'Hi owner, question about the club!',
    });
    const msg1 = (sent.data as Record<string, unknown>).message as Record<string, unknown>;
    const threadId = msg1.threadId as string;
    assert.equal(msg1.senderMemberId, alice.id);
    assert.equal(msg1.recipientMemberId, owner.id);

    // Owner sees it in their inbox
    const ownerInbox = await h.apiOk(owner.token, 'messages.getInbox', {});
    const ownerThreads = (ownerInbox.data as Record<string, unknown>).results as Array<Record<string, unknown>>;
    const found = ownerThreads.find((t) => t.threadId === threadId);
    assert.ok(found, 'owner should see the thread in their inbox');

    // Owner replies
    const reply = await h.apiOk(owner.token, 'messages.send', {
      recipientMemberId: alice.id,
      messageText: 'Thanks for reaching out!',
    });
    const msg2 = (reply.data as Record<string, unknown>).message as Record<string, unknown>;
    assert.equal(msg2.threadId, threadId, 'reply should be in the same thread');
    assert.equal(msg2.senderMemberId, owner.id);

    // Both messages visible in thread
    const readResult = await h.apiOk(alice.token, 'messages.getThread', { threadId });
    const messages = (readResult.data as Record<string, unknown>).messages as Array<Record<string, unknown>>;
    assert.ok(messages.length >= 2, 'thread should have at least two messages');
    const texts = messages.map((m) => m.messageText);
    assert.ok(texts.includes('Hi owner, question about the club!'));
    assert.ok(texts.includes('Thanks for reaching out!'));
  });

  it('multi-message conversation maintains thread correctly', async () => {
    const owner = await h.seedOwner('msg-club-8', 'MsgClub8');
    const alice = await h.seedCompedMember(owner.club.id, 'Alice Multi', 'alice-msg-8');
    const bob = await h.seedCompedMember(owner.club.id, 'Bob Multi', 'bob-msg-8');

    // Alice sends first message
    const r1 = await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: 'Message 1',
    });
    const threadId = ((r1.data as Record<string, unknown>).message as Record<string, unknown>).threadId as string;

    // Bob replies
    const r2 = await h.apiOk(bob.token, 'messages.send', {
      recipientMemberId: alice.id,
      messageText: 'Message 2',
    });
    assert.equal(((r2.data as Record<string, unknown>).message as Record<string, unknown>).threadId, threadId);

    // Alice replies again
    const r3 = await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: 'Message 3',
    });
    assert.equal(((r3.data as Record<string, unknown>).message as Record<string, unknown>).threadId, threadId);

    // Read full thread
    const readResult = await h.apiOk(alice.token, 'messages.getThread', { threadId });
    const messages = (readResult.data as Record<string, unknown>).messages as Array<Record<string, unknown>>;
    assert.equal(messages.length, 3, 'thread should have exactly 3 messages');
    assert.deepEqual(
      messages.map((m) => m.messageText),
      ['Message 1', 'Message 2', 'Message 3'],
    );
  });

  it('self-message returns 400', async () => {
    const owner = await h.seedOwner('msg-self', 'MsgSelf');
    const err = await h.apiErr(owner.token, 'messages.send', {
      recipientMemberId: owner.id,
      messageText: 'Hello me',
    });
    assert.equal(err.status, 400);
  });

  it('members sharing multiple clubs can DM without providing clubId', async () => {
    const owner = await h.seedOwner('msg-multi-1', 'MsgMulti1');
    const club2 = await h.seedClub('msg-multi-2', 'MsgMulti2', owner.id);
    const alice = await h.seedCompedMember(owner.club.id, 'Alice Multi', 'alice-multi-club');
    await h.seedCompedMembership(club2.id, alice.id);

    const result = await h.apiOk(owner.token, 'messages.send', {
      recipientMemberId: alice.id,
      messageText: 'No club needed',
    });
    const message = (result.data as Record<string, unknown>).message as Record<string, unknown>;
    assert.ok(message.threadId, 'should succeed without clubId');
    assert.equal(message.messageText, 'No club needed');

    // sharedClubs should include both clubs
    const sharedClubs = message.sharedClubs as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(sharedClubs), 'send response should have sharedClubs');
    assert.ok(sharedClubs.length >= 2, 'should show both shared clubs');
    const slugs = sharedClubs.map(c => c.slug);
    assert.ok(slugs.includes('msg-multi-1'));
    assert.ok(slugs.includes('msg-multi-2'));
  });

  it('send response has sharedClubs not clubId', async () => {
    const owner = await h.seedOwner('msg-shape-1', 'MsgShape1');
    const alice = await h.seedCompedMember(owner.club.id, 'Alice Shape', 'alice-shape-1');

    const result = await h.apiOk(owner.token, 'messages.send', {
      recipientMemberId: alice.id,
      messageText: 'Shape check',
    });
    const message = (result.data as Record<string, unknown>).message as Record<string, unknown>;
    assert.ok(!('clubId' in message), 'send response should not have clubId');
    const sharedClubs = message.sharedClubs as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(sharedClubs), 'send response should have sharedClubs');
    assert.ok(sharedClubs.length >= 1);
    assert.ok(sharedClubs[0].clubId);
    assert.ok(sharedClubs[0].slug);
    assert.ok(sharedClubs[0].name);
  });

  it('messages.getThread returns sharedClubs on thread', async () => {
    const owner = await h.seedOwner('msg-read-sc', 'MsgReadSC');
    const alice = await h.seedCompedMember(owner.club.id, 'Alice ReadSC', 'alice-read-sc');

    const sent = await h.apiOk(owner.token, 'messages.send', { recipientMemberId: alice.id, messageText: 'SC test' });
    const threadId = ((sent.data as Record<string, unknown>).message as Record<string, unknown>).threadId as string;

    const readResult = await h.apiOk(owner.token, 'messages.getThread', { threadId });
    const thread = (readResult.data as Record<string, unknown>).thread as Record<string, unknown>;
    assert.ok(!('clubId' in thread), 'thread should not have clubId');
    const sharedClubs = thread.sharedClubs as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(sharedClubs));
    assert.ok(sharedClubs.length >= 1);
  });

  it('messages.getInbox returns sharedClubs on threads', async () => {
    const owner = await h.seedOwner('msg-list-sc', 'MsgListSC');
    const alice = await h.seedCompedMember(owner.club.id, 'Alice ListSC', 'alice-list-sc');

    await h.apiOk(owner.token, 'messages.send', { recipientMemberId: alice.id, messageText: 'list SC test' });

    const list = await h.apiOk(owner.token, 'messages.getInbox', {});
    const results = (list.data as Record<string, unknown>).results as Array<Record<string, unknown>>;
    assert.ok(results.length >= 1);
    assert.ok(!('clubId' in results[0]), 'thread should not have clubId');
    assert.ok(Array.isArray(results[0].sharedClubs));
  });

  it('messages.getInbox returns sharedClubs on threads (unreadOnly)', async () => {
    const owner = await h.seedOwner('msg-inbox-sc', 'MsgInboxSC');
    const alice = await h.seedCompedMember(owner.club.id, 'Alice InboxSC', 'alice-inbox-sc');

    await h.apiOk(alice.token, 'messages.send', { recipientMemberId: owner.id, messageText: 'inbox SC test' });

    const inbox = await h.apiOk(owner.token, 'messages.getInbox', {});
    const results = (inbox.data as Record<string, unknown>).results as Array<Record<string, unknown>>;
    assert.ok(results.length >= 1);
    assert.ok(!('clubId' in results[0]), 'inbox thread should not have clubId');
    assert.ok(Array.isArray(results[0].sharedClubs));
  });

  it('members with no shared clubs cannot start a DM', async () => {
    const ownerA = await h.seedOwner('msg-no-share-a', 'MsgNoShareA');
    const ownerB = await h.seedOwner('msg-no-share-b', 'MsgNoShareB');

    const err = await h.apiErr(ownerA.token, 'messages.send', {
      recipientMemberId: ownerB.id,
      messageText: 'Should fail',
    });
    assert.equal(err.code, 'not_found');
  });

  it('stream message frame carries sharedClubs on the thread', async () => {
    const owner = await h.seedOwner('msg-upd-sc', 'MsgUpdSC');
    const alice = await h.seedCompedMember(owner.club.id, 'Alice UpdSC', 'alice-upd-sc');

    const stream = h.connectStream(owner.token, { after: 'latest' });
    try {
      await stream.waitForEvents(1);

      await h.apiOk(alice.token, 'messages.send', {
        recipientMemberId: owner.id,
        messageText: 'Update SC test',
      });

      await stream.waitForEvents(2);
      const messageEvent = stream.events.find((event) => event.event === 'message');
      assert.ok(messageEvent, 'should have a message frame');
      const thread = messageEvent.data.thread as Record<string, unknown>;
      assert.ok(Array.isArray(thread.sharedClubs), 'message frame thread should have sharedClubs');
      assert.ok((thread.sharedClubs as unknown[]).length >= 1);
      assert.equal((messageEvent.data.messages as Array<Record<string, unknown>>)[0]?.messageText, 'Update SC test');
    } finally {
      stream.close();
    }
  });

  it('existing thread remains replyable after shared clubs drop to zero', async () => {
    const owner = await h.seedOwner('msg-diverge', 'MsgDiverge');
    const alice = await h.seedCompedMember(owner.club.id, 'Alice Diverge', 'alice-diverge');

    // Start a DM while they share a club
    const sent = await h.apiOk(owner.token, 'messages.send', {
      recipientMemberId: alice.id,
      messageText: 'Before diverge',
    });
    const threadId = ((sent.data as Record<string, unknown>).message as Record<string, unknown>).threadId as string;

    // Remove alice from the club — shared clubs drop to zero
    await h.apiOk(owner.token, 'clubadmin.memberships.setStatus', {
      clubId: owner.club.id,
      membershipId: alice.membership.id,
      status: 'removed',
      reason: 'testing diverge',
    });

    // Alice can still reply in the existing thread
    const reply = await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: owner.id,
      messageText: 'After diverge',
    });
    const replyMsg = (reply.data as Record<string, unknown>).message as Record<string, unknown>;
    assert.equal(replyMsg.threadId, threadId, 'reply should be in the same thread');
    const sharedClubs = replyMsg.sharedClubs as Array<Record<string, unknown>>;
    assert.equal(sharedClubs.length, 0, 'sharedClubs should be empty after diverge');

    // Owner can also reply
    const ownerReply = await h.apiOk(owner.token, 'messages.send', {
      recipientMemberId: alice.id,
      messageText: 'Owner after diverge',
    });
    assert.equal(((ownerReply.data as Record<string, unknown>).message as Record<string, unknown>).threadId, threadId);

    // Thread is readable with sharedClubs: []
    const readResult = await h.apiOk(owner.token, 'messages.getThread', { threadId });
    const thread = (readResult.data as Record<string, unknown>).thread as Record<string, unknown>;
    assert.deepEqual(thread.sharedClubs, []);
    const messages = (readResult.data as Record<string, unknown>).messages as Array<Record<string, unknown>>;
    assert.ok(messages.length >= 3);
  });

  it('messages.acknowledge marks a thread read and is idempotent', async () => {
    const owner = await h.seedOwner('msg-ack-null', 'MsgAckNull');
    const alice = await h.seedCompedMember(owner.club.id, 'Alice Ack', 'alice-ack-null');

    await h.apiOk(alice.token, 'messages.send', { recipientMemberId: owner.id, messageText: 'Ack test' });

    const inboxBefore = await h.apiOk(owner.token, 'messages.getInbox', { unreadOnly: true });
    const beforeThreads = (inboxBefore.data as Record<string, unknown>).results as Array<Record<string, unknown>>;
    assert.equal(beforeThreads.length, 1);
    const threadId = beforeThreads[0]!.threadId as string;
    const unreadBefore = beforeThreads[0]!.unread as Record<string, unknown>;
    assert.equal(unreadBefore.unreadMessageCount, 1);

    const ack = await h.apiOk(owner.token, 'messages.acknowledge', { threadId });
    assert.equal((ack.data as Record<string, unknown>).threadId, threadId);
    assert.equal((ack.data as Record<string, unknown>).acknowledgedCount, 1);

    const inboxAfter = await h.apiOk(owner.token, 'messages.getInbox', { unreadOnly: true });
    const afterThreads = (inboxAfter.data as Record<string, unknown>).results as Array<Record<string, unknown>>;
    assert.equal(afterThreads.length, 0, 'thread should disappear from unread-only inbox after acknowledgement');

    const fullInbox = await h.apiOk(owner.token, 'messages.getInbox', {});
    const fullThreads = (fullInbox.data as Record<string, unknown>).results as Array<Record<string, unknown>>;
    const thread = fullThreads.find((entry) => entry.threadId === threadId);
    assert.ok(thread, 'thread should still exist in the full inbox');
    const unreadAfter = thread.unread as Record<string, unknown>;
    assert.equal(unreadAfter.hasUnread, false);
    assert.equal(unreadAfter.unreadMessageCount, 0);

    const secondAck = await h.apiOk(owner.token, 'messages.acknowledge', { threadId });
    assert.equal((secondAck.data as Record<string, unknown>).acknowledgedCount, 0);
  });

  it('messages.acknowledge returns not_found for an unknown thread', async () => {
    const owner = await h.seedOwner('msg-ack-missing', 'MsgAckMissing');

    const err = await h.apiErr(owner.token, 'messages.acknowledge', { threadId: 'thread_missing' });
    assert.equal(err.status, 404);
    assert.equal(err.code, 'not_found');
  });

  it('duplicate clientKey sends return the original message without creating another row', async () => {
    const owner = await h.seedOwner('msg-client-key', 'MsgClientKey');
    const alice = await h.seedCompedMember(owner.club.id, 'Alice ClientKey', 'alice-client-key');
    const clientKey = 'retry-key-1';

    const first = await h.apiOk(owner.token, 'messages.send', {
      recipientMemberId: alice.id,
      messageText: 'Retry me',
      clientKey,
    });
    const firstMessage = (first.data as Record<string, unknown>).message as Record<string, unknown>;

    const second = await h.apiOk(owner.token, 'messages.send', {
      recipientMemberId: alice.id,
      messageText: 'Retry me',
      clientKey,
    });
    const secondMessage = (second.data as Record<string, unknown>).message as Record<string, unknown>;

    assert.equal(secondMessage.messageId, firstMessage.messageId);
    assert.equal(secondMessage.threadId, firstMessage.threadId);
    const messages = await h.sqlMessaging<{ count: string }>(
      `select count(*)::text as count
       from dm_messages
       where sender_member_id = $1 and client_key = $2`,
      [owner.id, clientKey],
    );
    assert.equal(Number(messages[0]!.count), 1);
  });

  it('clientKey with different messageText returns 409 client_key_conflict', async () => {
    const owner = await h.seedOwner('msg-ck-conflict', 'MsgCKConflict');
    const alice = await h.seedCompedMember(owner.club.id, 'Alice CKConflict', 'alice-ck-conflict');
    const clientKey = 'conflict-key-1';

    await h.apiOk(owner.token, 'messages.send', {
      recipientMemberId: alice.id,
      messageText: 'Original message',
      clientKey,
    });

    const err = await h.apiErr(owner.token, 'messages.send', {
      recipientMemberId: alice.id,
      messageText: 'Different message text',
      clientKey,
    });
    assert.equal(err.status, 409);
    assert.equal(err.code, 'client_key_conflict');
  });

  it('oversized messageText returns 400', async () => {
    const owner = await h.seedOwner('msg-long', 'MsgLong');
    const alice = await h.seedCompedMember(owner.club.id, 'Alice Long', 'alice-long');
    const err = await h.apiErr(owner.token, 'messages.send', {
      recipientMemberId: alice.id,
      messageText: 'x'.repeat(500_001),
    });
    assert.equal(err.status, 400);
  });
});

// ── Stream / Read State ──────────────────────────────────────────────────────

describe('messages read-state and stream', () => {
  it('ready frame carries notification seed and activity cursor', async () => {
    const owner = await h.seedOwner('sse-club-1', 'SSEClub1');
    const stream = h.connectStream(owner.token, { after: 'latest' });
    try {
      await stream.waitForEvents(1);
      const ready = stream.events[0]!;
      assert.equal(ready.event, 'ready');
      assert.ok(Array.isArray(ready.data.notifications));
      assert.equal(typeof ready.data.notificationsTruncated, 'boolean');
      assert.equal(
        ready.data.activityCursor === null || typeof ready.data.activityCursor === 'string',
        true,
      );
    } finally {
      stream.close();
    }
  });

  it('after=latest skips DM backlog and only receives future message frames', async () => {
    const owner = await h.seedOwner('sse-club-2', 'SSEClub2');
    const alice = await h.seedCompedMember(owner.club.id, 'Alice Tail', 'alice-sse-2');

    await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: owner.id,
      messageText: 'Old message (backlog)',
    });

    const stream = h.connectStream(owner.token, { after: 'latest' });
    try {
      await stream.waitForEvents(1);

      await h.apiOk(alice.token, 'messages.send', {
        recipientMemberId: owner.id,
        messageText: 'New message (after connect)',
      });

      await stream.waitForEvents(2);
      const messageFrames = stream.events.filter((event) => event.event === 'message');
      assert.equal(messageFrames.length, 1, 'should only receive the post-connect DM');
      const frame = messageFrames[0]!.data;
      assert.equal((frame.messages as Array<Record<string, unknown>>)[0]?.messageText, 'New message (after connect)');
    } finally {
      stream.close();
    }
  });

  it('message frame matches a single-message projection of messages.getThread', async () => {
    const owner = await h.seedOwner('sse-club-3', 'SSEClub3');
    const alice = await h.seedCompedMember(owner.club.id, 'Alice RT', 'alice-sse-3');

    const stream = h.connectStream(owner.token, { after: 'latest' });
    try {
      await stream.waitForEvents(1);

      const sent = await h.apiOk(alice.token, 'messages.send', {
        recipientMemberId: owner.id,
        messageText: 'First real-time',
      });
      const sentMessage = (sent.data as Record<string, unknown>).message as Record<string, unknown>;
      const threadId = sentMessage.threadId as string;
      const messageId = sentMessage.messageId as string;

      await stream.waitForEvents(2);
      const messageEvent = stream.events.find((event) => event.event === 'message');
      assert.ok(messageEvent, 'should receive a message frame');

      const frameThread = messageEvent.data.thread as Record<string, unknown>;
      const frameMessages = messageEvent.data.messages as Array<Record<string, unknown>>;
      const frameIncluded = messageEvent.data.included as Record<string, unknown>;
      assert.equal(frameThread.threadId, threadId);
      assert.equal(frameMessages.length, 1);
      assert.equal(frameMessages[0]?.messageId, messageId);
      assert.equal(frameMessages[0]?.messageText, 'First real-time');
      assert.ok(Array.isArray(frameThread.sharedClubs));
      assert.ok(frameIncluded.membersById);

      const threadResult = await h.apiOk(owner.token, 'messages.getThread', { threadId });
      const threadData = threadResult.data as Record<string, unknown>;
      const thread = threadData.thread as Record<string, unknown>;
      const messages = threadData.messages as Array<Record<string, unknown>>;
      const included = threadData.included as Record<string, unknown>;
      const matchingMessage = messages.find((message) => message.messageId === messageId);

      assert.equal(frameThread.counterpartMemberId, thread.counterpartMemberId);
      assert.deepEqual(frameThread.sharedClubs, thread.sharedClubs);
      assert.ok(matchingMessage);
      assert.deepEqual(frameMessages[0], matchingMessage);
      assert.deepEqual(frameIncluded.membersById, included.membersById);
    } finally {
      stream.close();
    }
  });
});
