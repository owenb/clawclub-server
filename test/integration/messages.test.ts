import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from './harness.ts';
function decodeCursor(cursor: string): { s: number; t: string } {
  return JSON.parse(Buffer.from(cursor, 'base64url').toString());
}

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
    const alice = await h.seedClubMember(owner.club.id, 'Alice Sender', 'alice-msg-1', { sponsorId: owner.id });
    const bob = await h.seedClubMember(owner.club.id, 'Bob Recipient', 'bob-msg-1', { sponsorId: owner.id });

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

  it('sender sees the thread in messages.inbox', async () => {
    const owner = await h.seedOwner('msg-club-2', 'MsgClub2');
    const alice = await h.seedClubMember(owner.club.id, 'Alice Inbox', 'alice-msg-2', { sponsorId: owner.id });
    const bob = await h.seedClubMember(owner.club.id, 'Bob Inbox', 'bob-msg-2', { sponsorId: owner.id });

    const sent = await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: 'Hey Bob, checking inbox.',
    });
    const sentMessage = (sent.data as Record<string, unknown>).message as Record<string, unknown>;
    const threadId = sentMessage.threadId as string;

    const inbox = await h.apiOk(alice.token, 'messages.inbox', {});
    const results = (inbox.data as Record<string, unknown>).results as Array<Record<string, unknown>>;
    const found = results.find((t) => t.threadId === threadId);
    assert.ok(found, 'sender should see the thread in their inbox');
    assert.equal(found.counterpartMemberId, bob.id);
  });

  it('recipient sees the thread in messages.inbox', async () => {
    const owner = await h.seedOwner('msg-club-3', 'MsgClub3');
    const alice = await h.seedClubMember(owner.club.id, 'Alice Recv', 'alice-msg-3', { sponsorId: owner.id });
    const bob = await h.seedClubMember(owner.club.id, 'Bob Recv', 'bob-msg-3', { sponsorId: owner.id });

    const sent = await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: 'Bob, you should see this.',
    });
    const sentMessage = (sent.data as Record<string, unknown>).message as Record<string, unknown>;
    const threadId = sentMessage.threadId as string;

    const inbox = await h.apiOk(bob.token, 'messages.inbox', {});
    const results = (inbox.data as Record<string, unknown>).results as Array<Record<string, unknown>>;
    const found = results.find((t) => t.threadId === threadId);
    assert.ok(found, 'recipient should see the thread in their inbox');
    assert.equal(found.counterpartMemberId, alice.id);

    const unread = found.unread as Record<string, unknown>;
    assert.ok(unread, 'inbox thread should have an unread block');
    assert.ok(typeof unread.hasUnread === 'boolean', 'hasUnread should be a boolean');
    assert.ok(typeof unread.unreadMessageCount === 'number', 'unreadMessageCount should be a number');
  });

  it('messages.read returns the thread and message list', async () => {
    const owner = await h.seedOwner('msg-club-4', 'MsgClub4');
    const alice = await h.seedClubMember(owner.club.id, 'Alice Read', 'alice-msg-4', { sponsorId: owner.id });
    const bob = await h.seedClubMember(owner.club.id, 'Bob Read', 'bob-msg-4', { sponsorId: owner.id });

    const sent = await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: 'First message in thread.',
    });
    const sentMessage = (sent.data as Record<string, unknown>).message as Record<string, unknown>;
    const threadId = sentMessage.threadId as string;
    const messageId = sentMessage.messageId as string;

    const readResult = await h.apiOk(alice.token, 'messages.read', { threadId });
    const data = readResult.data as Record<string, unknown>;

    const thread = data.thread as Record<string, unknown>;
    assert.ok(thread, 'messages.read should return a thread summary');
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

  it('messages.list returns the thread summary', async () => {
    const owner = await h.seedOwner('msg-club-5', 'MsgClub5');
    const alice = await h.seedClubMember(owner.club.id, 'Alice List', 'alice-msg-5', { sponsorId: owner.id });
    const bob = await h.seedClubMember(owner.club.id, 'Bob List', 'bob-msg-5', { sponsorId: owner.id });

    const sent = await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: 'Thread for messages.list.',
    });
    const sentMessage = (sent.data as Record<string, unknown>).message as Record<string, unknown>;
    const threadId = sentMessage.threadId as string;

    const list = await h.apiOk(alice.token, 'messages.list', {});
    const results = (list.data as Record<string, unknown>).results as Array<Record<string, unknown>>;
    const found = results.find((t) => t.threadId === threadId);
    assert.ok(found, 'thread should appear in messages.list');
    assert.equal(found.counterpartMemberId, bob.id);

    const latestMessage = found.latestMessage as Record<string, unknown>;
    assert.ok(latestMessage, 'thread should have latestMessage');
    assert.equal(latestMessage.messageText, 'Thread for messages.list.');
  });

  it('a third member not in the conversation cannot read the thread', async () => {
    const owner = await h.seedOwner('msg-club-6', 'MsgClub6');
    const alice = await h.seedClubMember(owner.club.id, 'Alice Private', 'alice-msg-6', { sponsorId: owner.id });
    const bob = await h.seedClubMember(owner.club.id, 'Bob Private', 'bob-msg-6', { sponsorId: owner.id });
    const carol = await h.seedClubMember(owner.club.id, 'Carol Outsider', 'carol-msg-6', { sponsorId: owner.id });

    const sent = await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: 'Private message.',
    });
    const sentMessage = (sent.data as Record<string, unknown>).message as Record<string, unknown>;
    const threadId = sentMessage.threadId as string;

    // Carol is not a participant — she should get not_found
    const err = await h.apiErr(carol.token, 'messages.read', { threadId });
    assert.equal(err.code, 'not_found');
  });

  it('member can DM the club owner and owner can reply', async () => {
    const owner = await h.seedOwner('msg-club-7', 'MsgClub7');
    const alice = await h.seedClubMember(owner.club.id, 'Alice ToOwner', 'alice-msg-7', { sponsorId: owner.id });

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
    const ownerInbox = await h.apiOk(owner.token, 'messages.inbox', {});
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
    const readResult = await h.apiOk(alice.token, 'messages.read', { threadId });
    const messages = (readResult.data as Record<string, unknown>).messages as Array<Record<string, unknown>>;
    assert.ok(messages.length >= 2, 'thread should have at least two messages');
    const texts = messages.map((m) => m.messageText);
    assert.ok(texts.includes('Hi owner, question about the club!'));
    assert.ok(texts.includes('Thanks for reaching out!'));
  });

  it('multi-message conversation maintains thread correctly', async () => {
    const owner = await h.seedOwner('msg-club-8', 'MsgClub8');
    const alice = await h.seedClubMember(owner.club.id, 'Alice Multi', 'alice-msg-8', { sponsorId: owner.id });
    const bob = await h.seedClubMember(owner.club.id, 'Bob Multi', 'bob-msg-8', { sponsorId: owner.id });

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
    const readResult = await h.apiOk(alice.token, 'messages.read', { threadId });
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
    const alice = await h.seedClubMember(owner.club.id, 'Alice Multi', 'alice-multi-club', { sponsorId: owner.id });
    await h.seedMembership(club2.id, alice.id, { sponsorId: owner.id });

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
    const alice = await h.seedClubMember(owner.club.id, 'Alice Shape', 'alice-shape-1', { sponsorId: owner.id });

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

  it('messages.read returns sharedClubs on thread', async () => {
    const owner = await h.seedOwner('msg-read-sc', 'MsgReadSC');
    const alice = await h.seedClubMember(owner.club.id, 'Alice ReadSC', 'alice-read-sc', { sponsorId: owner.id });

    const sent = await h.apiOk(owner.token, 'messages.send', { recipientMemberId: alice.id, messageText: 'SC test' });
    const threadId = ((sent.data as Record<string, unknown>).message as Record<string, unknown>).threadId as string;

    const readResult = await h.apiOk(owner.token, 'messages.read', { threadId });
    const thread = (readResult.data as Record<string, unknown>).thread as Record<string, unknown>;
    assert.ok(!('clubId' in thread), 'thread should not have clubId');
    const sharedClubs = thread.sharedClubs as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(sharedClubs));
    assert.ok(sharedClubs.length >= 1);
  });

  it('messages.list returns sharedClubs on threads', async () => {
    const owner = await h.seedOwner('msg-list-sc', 'MsgListSC');
    const alice = await h.seedClubMember(owner.club.id, 'Alice ListSC', 'alice-list-sc', { sponsorId: owner.id });

    await h.apiOk(owner.token, 'messages.send', { recipientMemberId: alice.id, messageText: 'list SC test' });

    const list = await h.apiOk(owner.token, 'messages.list', {});
    const results = (list.data as Record<string, unknown>).results as Array<Record<string, unknown>>;
    assert.ok(results.length >= 1);
    assert.ok(!('clubId' in results[0]), 'thread should not have clubId');
    assert.ok(Array.isArray(results[0].sharedClubs));
  });

  it('messages.inbox returns sharedClubs on threads', async () => {
    const owner = await h.seedOwner('msg-inbox-sc', 'MsgInboxSC');
    const alice = await h.seedClubMember(owner.club.id, 'Alice InboxSC', 'alice-inbox-sc', { sponsorId: owner.id });

    await h.apiOk(alice.token, 'messages.send', { recipientMemberId: owner.id, messageText: 'inbox SC test' });

    const inbox = await h.apiOk(owner.token, 'messages.inbox', {});
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

  it('DM update payload includes sharedClubs', async () => {
    const owner = await h.seedOwner('msg-upd-sc', 'MsgUpdSC');
    const alice = await h.seedClubMember(owner.club.id, 'Alice UpdSC', 'alice-upd-sc', { sponsorId: owner.id });

    await h.apiOk(alice.token, 'messages.send', { recipientMemberId: owner.id, messageText: 'Update SC test' });

    const result = await h.apiOk(owner.token, 'updates.list', {});
    const updates = (result.data as Record<string, unknown>).updates as Record<string, unknown>;
    const items = updates.items as Array<Record<string, unknown>>;
    const dmUpdate = items.find(u => u.topic === 'dm.message.created');
    assert.ok(dmUpdate, 'should have a DM update');
    assert.equal(dmUpdate.clubId, null, 'DM update clubId should be null');
    const payload = dmUpdate.payload as Record<string, unknown>;
    const sharedClubs = payload.sharedClubs as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(sharedClubs), 'DM update payload should have sharedClubs');
    assert.ok(sharedClubs.length >= 1);
  });

  it('existing thread remains replyable after shared clubs drop to zero', async () => {
    const owner = await h.seedOwner('msg-diverge', 'MsgDiverge');
    const alice = await h.seedClubMember(owner.club.id, 'Alice Diverge', 'alice-diverge', { sponsorId: owner.id });

    // Start a DM while they share a club
    const sent = await h.apiOk(owner.token, 'messages.send', {
      recipientMemberId: alice.id,
      messageText: 'Before diverge',
    });
    const threadId = ((sent.data as Record<string, unknown>).message as Record<string, unknown>).threadId as string;

    // Remove alice from the club — shared clubs drop to zero
    await h.apiOk(owner.token, 'clubadmin.memberships.transition', {
      clubId: owner.club.id,
      membershipId: alice.membership.id,
      status: 'revoked',
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
    const readResult = await h.apiOk(owner.token, 'messages.read', { threadId });
    const thread = (readResult.data as Record<string, unknown>).thread as Record<string, unknown>;
    assert.deepEqual(thread.sharedClubs, []);
    const messages = (readResult.data as Record<string, unknown>).messages as Array<Record<string, unknown>>;
    assert.ok(messages.length >= 3);
  });

  it('DM ack receipt returns clubId null not empty string', async () => {
    const owner = await h.seedOwner('msg-ack-null', 'MsgAckNull');
    const alice = await h.seedClubMember(owner.club.id, 'Alice Ack', 'alice-ack-null', { sponsorId: owner.id });

    await h.apiOk(alice.token, 'messages.send', { recipientMemberId: owner.id, messageText: 'Ack test' });

    // Get update IDs
    const updates = await h.apiOk(owner.token, 'updates.list', {});
    const items = ((updates.data as Record<string, unknown>).updates as Record<string, unknown>).items as Array<Record<string, unknown>>;
    const dmUpdate = items.find(u => u.topic === 'dm.message.created');
    assert.ok(dmUpdate);

    // Acknowledge the DM update
    const ackResult = await h.apiOk(owner.token, 'updates.acknowledge', {
      updateIds: [dmUpdate.updateId],
      state: 'processed',
    });
    const receipts = (ackResult.data as Record<string, unknown>).receipts as Array<Record<string, unknown>>;
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].clubId, null, 'DM ack receipt clubId should be null, not empty string');
  });

  it('oversized messageText returns 400', async () => {
    const owner = await h.seedOwner('msg-long', 'MsgLong');
    const alice = await h.seedClubMember(owner.club.id, 'Alice Long', 'alice-long', { sponsorId: owner.id });
    const err = await h.apiErr(owner.token, 'messages.send', {
      recipientMemberId: alice.id,
      messageText: 'x'.repeat(500_001),
    });
    assert.equal(err.status, 400);
  });
});

// ── Updates ───────────────────────────────────────────────────────────────────

describe('updates', () => {
  it('recipient has a pending update after receiving a DM', async () => {
    const owner = await h.seedOwner('upd-club-1', 'UpdClub1');
    const alice = await h.seedClubMember(owner.club.id, 'Alice Updater', 'alice-upd-1', { sponsorId: owner.id });
    const bob = await h.seedClubMember(owner.club.id, 'Bob Receiver', 'bob-upd-1', { sponsorId: owner.id });

    await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: 'This should create an update for Bob.',
    });

    const result = await h.apiOk(bob.token, 'updates.list', {});
    const updates = (result.data as Record<string, unknown>).updates as Record<string, unknown>;
    const items = updates.items as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(items), 'updates.items should be an array');
    assert.ok(items.length >= 1, 'Bob should have at least one pending update');

    const dmUpdate = items.find((u) => u.topic === 'dm.message.created');
    assert.ok(dmUpdate, 'a dm.message.created update should be present');
    assert.ok(dmUpdate.updateId, 'update should have an updateId');
  });

  it('updates.acknowledge marks updates as processed', async () => {
    const owner = await h.seedOwner('upd-club-3', 'UpdClub3');
    const alice = await h.seedClubMember(owner.club.id, 'Alice Ack', 'alice-upd-3', { sponsorId: owner.id });
    const bob = await h.seedClubMember(owner.club.id, 'Bob Ack', 'bob-upd-3', { sponsorId: owner.id });

    await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: 'Message to trigger an update for acknowledgement.',
    });

    // Fetch updates to get an ID to acknowledge
    const listResult = await h.apiOk(bob.token, 'updates.list', {});
    const updates = (listResult.data as Record<string, unknown>).updates as Record<string, unknown>;
    const items = updates.items as Array<Record<string, unknown>>;
    assert.ok(items.length >= 1, 'Bob should have at least one pending update');

    const updateId = items[0]!.updateId as string;
    assert.ok(updateId, 'update item should have an updateId');

    const ackResult = await h.apiOk(bob.token, 'updates.acknowledge', {
      updateIds: [updateId],
      state: 'processed',
    });
    const receipts = (ackResult.data as Record<string, unknown>).receipts as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(receipts), 'receipts should be an array');
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]!.updateId, updateId);
    assert.equal(receipts[0]!.state, 'processed');
  });

  it('GET /updates endpoint returns pending updates with bearer token', async () => {
    const owner = await h.seedOwner('upd-club-4', 'UpdClub4');
    const alice = await h.seedClubMember(owner.club.id, 'Alice GET', 'alice-upd-4', { sponsorId: owner.id });
    const bob = await h.seedClubMember(owner.club.id, 'Bob GET', 'bob-upd-4', { sponsorId: owner.id });

    await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: 'This triggers a GET /updates update.',
    });

    const { status, body } = await h.getUpdates(bob.token, { limit: 10 });
    assert.equal(status, 200);
    assert.equal(body.ok, true);

    const updatesBlock = body.updates as Record<string, unknown>;
    assert.ok(updatesBlock, 'response should have an updates block');
    const items = updatesBlock.items as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(items), 'updates.items should be an array');
    assert.ok(items.length >= 1, 'Bob should have at least one pending update from the DM');
  });

  it('GET /updates?after=latest returns no backlog', async () => {
    const owner = await h.seedOwner('upd-club-5', 'UpdClub5');
    const alice = await h.seedClubMember(owner.club.id, 'Alice Latest', 'alice-upd-5', { sponsorId: owner.id });
    const bob = await h.seedClubMember(owner.club.id, 'Bob Latest', 'bob-upd-5', { sponsorId: owner.id });

    // Create some backlog
    await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: 'Backlog message 1',
    });
    await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: 'Backlog message 2',
    });

    // Verify backlog exists with normal polling
    const { body: normalBody } = await h.getUpdates(bob.token, { limit: 10 });
    const normalItems = ((normalBody.updates as Record<string, unknown>).items as unknown[]);
    assert.ok(normalItems.length >= 2, 'should have backlog without after=latest');

    // With after=latest, should get no items (we're caught up to "now")
    const { status, body } = await h.getUpdates(bob.token, { after: 'latest', limit: 10 });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    const items = ((body.updates as Record<string, unknown>).items as unknown[]);
    assert.equal(items.length, 0, 'after=latest should skip existing backlog');
  });
});

// ── SSE Stream ───────────────────────────────────────────────────────────────

describe('updates/stream', () => {
  it('ready event includes latestCursor', async () => {
    const owner = await h.seedOwner('sse-club-1', 'SSEClub1');
    const alice = await h.seedClubMember(owner.club.id, 'Alice SSE', 'alice-sse-1', { sponsorId: owner.id });
    const bob = await h.seedClubMember(owner.club.id, 'Bob SSE', 'bob-sse-1', { sponsorId: owner.id });

    // Send a DM so there's a known cursor
    await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: 'SSE test message',
    });

    const stream = h.connectStream(bob.token);
    try {
      await stream.waitForEvents(1); // ready event
      const ready = stream.events[0]!;
      assert.equal(ready.event, 'ready');
      assert.ok('latestCursor' in ready.data, 'ready should include latestCursor');
      assert.ok(ready.data.latestCursor === null || typeof ready.data.latestCursor === 'string');
    } finally {
      stream.close();
    }
  });

  it('after=latest skips backlog and only receives future events', async () => {
    const owner = await h.seedOwner('sse-club-2', 'SSEClub2');
    const alice = await h.seedClubMember(owner.club.id, 'Alice Tail', 'alice-sse-2', { sponsorId: owner.id });
    const bob = await h.seedClubMember(owner.club.id, 'Bob Tail', 'bob-sse-2', { sponsorId: owner.id });

    // Create backlog before connecting
    await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: 'Old message (backlog)',
    });

    // Connect with after=latest — should skip backlog
    const stream = h.connectStream(bob.token, { after: 'latest' });
    try {
      await stream.waitForEvents(1); // ready event
      const ready = stream.events[0]!;
      assert.equal(ready.event, 'ready');
      assert.ok(ready.data.latestCursor !== null, 'should have a latestCursor');
      assert.equal(ready.data.nextAfter, ready.data.latestCursor, 'nextAfter should equal latestCursor for after=latest');

      // Send a new DM — this one should arrive on the stream
      await h.apiOk(alice.token, 'messages.send', {
        recipientMemberId: bob.id,
        messageText: 'New message (after connect)',
      });

      await stream.waitForEvents(2); // ready + update
      const update = stream.events[1]!;
      assert.equal(update.event, 'update');
      assert.equal(update.data.topic, 'dm.message.created');
      const payload = update.data.payload as Record<string, unknown>;
      assert.equal(payload.messageText, 'New message (after connect)');

      // The old backlog message should NOT have appeared
      const updateEvents = stream.events.filter((e) => e.event === 'update');
      assert.equal(updateEvents.length, 1, 'should only have the new message, not the backlog');
    } finally {
      stream.close();
    }
  });

  it('stream delivers DM updates in real-time', async () => {
    const owner = await h.seedOwner('sse-club-3', 'SSEClub3');
    const alice = await h.seedClubMember(owner.club.id, 'Alice RT', 'alice-sse-3', { sponsorId: owner.id });
    const bob = await h.seedClubMember(owner.club.id, 'Bob RT', 'bob-sse-3', { sponsorId: owner.id });

    // Connect from a clean state with after=latest
    const stream = h.connectStream(bob.token, { after: 'latest' });
    try {
      await stream.waitForEvents(1); // ready

      // Send two DMs
      await h.apiOk(alice.token, 'messages.send', {
        recipientMemberId: bob.id,
        messageText: 'First real-time',
      });
      await h.apiOk(alice.token, 'messages.send', {
        recipientMemberId: bob.id,
        messageText: 'Second real-time',
      });

      await stream.waitForEvents(3); // ready + 2 updates
      const updates = stream.events.filter((e) => e.event === 'update');
      assert.equal(updates.length, 2);
      assert.equal((updates[0]!.data.payload as Record<string, unknown>).messageText, 'First real-time');
      assert.equal((updates[1]!.data.payload as Record<string, unknown>).messageText, 'Second real-time');

      // streamSeq should be monotonically increasing
      const seq0 = updates[0]!.data.streamSeq as number;
      const seq1 = updates[1]!.data.streamSeq as number;
      assert.ok(seq1 > seq0, 'streamSeq should be monotonically increasing');

      // SSE ids are opaque compound cursors. When present, they should decode
      // to a valid cursor with activity seq and timestamp.
      assert.ok(typeof updates[1]!.id === 'string', 'last streamed update should carry an SSE id');
      const cursor1 = decodeCursor(updates[1]!.id!);
      assert.ok(typeof cursor1.s === 'number', 'cursor should have activity seq');
      assert.ok(typeof cursor1.t === 'string', 'cursor should have timestamp');
    } finally {
      stream.close();
    }
  });
});
