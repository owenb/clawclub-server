import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { getHarness } from './setup.ts';
import type { TestHarness } from './harness.ts';

let h: TestHarness;

before(async () => {
  h = await getHarness();
}, { timeout: 30_000 });

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

    const transcript = await h.apiOk(alice.token, 'messages.read', { threadId });
    const data = transcript.data as Record<string, unknown>;

    const thread = data.thread as Record<string, unknown>;
    assert.ok(thread, 'messages.read should return a thread summary');
    assert.equal(thread.threadId, threadId);
    assert.equal(thread.counterpartMemberId, bob.id);
    assert.ok(thread.messageCount, 'thread should have a messageCount');

    const messages = data.messages as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(messages), 'messages should be an array');
    assert.ok(messages.length >= 1, 'at least one message should be in the thread');
    const msg = messages.find((m) => m.messageId === messageId);
    assert.ok(msg, 'the sent message should appear in the transcript');
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
    const transcript = await h.apiOk(alice.token, 'messages.read', { threadId });
    const messages = (transcript.data as Record<string, unknown>).messages as Array<Record<string, unknown>>;
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
    const transcript = await h.apiOk(alice.token, 'messages.read', { threadId });
    const messages = (transcript.data as Record<string, unknown>).messages as Array<Record<string, unknown>>;
    assert.equal(messages.length, 3, 'thread should have exactly 3 messages');
    assert.deepEqual(
      messages.map((m) => m.messageText),
      ['Message 1', 'Message 2', 'Message 3'],
    );
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

    const dmUpdate = items.find((u) => u.topic === 'transcript.message.created');
    assert.ok(dmUpdate, 'a transcript.message.created update should be present');
    assert.ok(dmUpdate.updateId, 'update should have an updateId');
  });

  it('club members get entity updates after content is created', async () => {
    const owner = await h.seedOwner('upd-club-2', 'UpdClub2');
    const author = await h.seedClubMember(owner.club.id, 'Alice ContentAuthor', 'alice-upd-2', { sponsorId: owner.id });
    const viewer = await h.seedClubMember(owner.club.id, 'Bob ContentViewer', 'bob-upd-2', { sponsorId: owner.id });

    await h.apiOk(author.token, 'entities.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'Post that triggers updates',
      summary: 'Should fan out to club members',
    });

    const result = await h.apiOk(viewer.token, 'updates.list', {});
    const updates = (result.data as Record<string, unknown>).updates as Record<string, unknown>;
    const items = updates.items as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(items), 'updates.items should be an array');
    const entityUpdate = items.find((u) =>
      typeof u.topic === 'string' && u.topic.startsWith('entity.'),
    );
    assert.ok(entityUpdate, 'viewer should have an entity update after post creation');
    assert.ok(entityUpdate.entityId ?? entityUpdate.payload, 'update should carry entity context');
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
});
