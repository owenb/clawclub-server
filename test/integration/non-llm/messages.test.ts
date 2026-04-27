import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from '../harness.ts';
import { getInbox } from '../helpers.ts';

let h: TestHarness;

before(async () => {
  h = await TestHarness.start();
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

async function readInbox(
  token: string,
  params: { limit?: number; unreadOnly?: boolean; cursor?: string | null } = {},
) {
  return getInbox((await h.getInbox(token, params)).body);
}

// ── Messages ──────────────────────────────────────────────────────────────────

describe('messages', () => {
  it('two shared-club members can exchange a DM via messages.send', async () => {
    const owner = await h.seedOwner('msg-club-1', 'MsgClub1');
    const alice = await h.seedCompedMember(owner.club.id, 'Alice Sender');
    const bob = await h.seedCompedMember(owner.club.id, 'Bob Recipient');

    const result = await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: 'Hello Bob!',
    });
    const data = result.data as Record<string, unknown>;
    const message = data.message as Record<string, unknown>;
    const thread = data.thread as Record<string, unknown>;
    assert.ok(message.threadId, 'sent message should have a threadId');
    assert.ok(message.messageId, 'sent message should have a messageId');
    assert.equal(message.senderMemberId, alice.id);
    assert.equal(thread.recipientMemberId, bob.id);
    assert.equal(message.messageText, 'Hello Bob!');
    assert.equal(Object.hasOwn(message, 'recipientMemberId'), false);
    assert.equal(Object.hasOwn(message, 'sharedClubs'), false);
    assert.equal(Object.hasOwn(message, 'updateCount'), false);
    assert.equal(Object.hasOwn(message, 'inReplyToMessageId'), false);
    assert.ok(Array.isArray(thread.sharedClubs));
  });

  it('sender sees the thread in the updates.list inbox slice', async () => {
    const owner = await h.seedOwner('msg-club-2', 'MsgClub2');
    const alice = await h.seedCompedMember(owner.club.id, 'Alice Inbox');
    const bob = await h.seedCompedMember(owner.club.id, 'Bob Inbox');

    const sent = await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: 'Hey Bob, checking inbox.',
    });
    const sentMessage = (sent.data as Record<string, unknown>).message as Record<string, unknown>;
    const threadId = sentMessage.threadId as string;

    const inbox = await readInbox(alice.token);
    assert.equal(inbox.unreadOnly, false);
    const results = inbox.results;
    const found = results.find((t) => t.threadId === threadId);
    assert.ok(found, 'sender should see the thread in their inbox');
    assert.equal((found.counterpart as Record<string, unknown>).memberId, bob.id);
  });

  it('recipient sees the thread in the updates.list inbox slice', async () => {
    const owner = await h.seedOwner('msg-club-3', 'MsgClub3');
    const alice = await h.seedCompedMember(owner.club.id, 'Alice Recv');
    const bob = await h.seedCompedMember(owner.club.id, 'Bob Recv');

    const sent = await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: 'Bob, you should see this.',
    });
    const sentMessage = (sent.data as Record<string, unknown>).message as Record<string, unknown>;
    const threadId = sentMessage.threadId as string;

    const inbox = await readInbox(bob.token);
    const results = inbox.results;
    const found = results.find((t) => t.threadId === threadId);
    assert.ok(found, 'recipient should see the thread in their inbox');
    assert.equal((found.counterpart as Record<string, unknown>).memberId, alice.id);

    const unread = found.unread as Record<string, unknown>;
    assert.ok(unread, 'inbox thread should have an unread block');
    assert.ok(typeof unread.hasUnread === 'boolean', 'hasUnread should be a boolean');
    assert.ok(typeof unread.unreadMessageCount === 'number', 'unreadMessageCount should be a number');
  });

  it('does not count pre-session DM history as unread for a newly materialized receiver', async () => {
    const owner = await h.seedOwner('msg-pre-session-history', 'MsgPreSessionHistory');
    const alice = await h.seedCompedMember(owner.club.id, 'Alice History');
    const bob = await h.seedCompedMember(owner.club.id, 'Bob History');
    const [memberA, memberB] = [alice.id, bob.id].sort();

    const threadRows = await h.sql<{ id: string }>(
      `insert into dm_threads (kind, created_by_member_id, member_a_id, member_b_id, created_at)
       values ('direct', $1, $2, $3, '2026-01-01T09:00:00Z')
       returning id`,
      [alice.id, memberA, memberB],
    );
    const threadId = threadRows[0]!.id;
    await h.sql(
      `insert into dm_thread_participants (thread_id, member_id, joined_at)
       values
         ($1, $2, '2026-01-01T09:00:00Z'),
         ($1, $3, '2026-01-03T09:00:00Z')`,
      [threadId, alice.id, bob.id],
    );
    const oldMessages = await h.sql<{ id: string; created_at: string }>(
      `insert into dm_messages (thread_id, sender_member_id, role, message_text, created_at)
       values
         ($1, $2, 'member', 'Old history 1', '2026-01-02T09:00:00Z'),
         ($1, $2, 'member', 'Old history 2', '2026-01-02T10:00:00Z')
       returning id, created_at::text as created_at`,
      [threadId, alice.id],
    );
    for (const message of oldMessages) {
      await h.sql(
        `insert into dm_inbox_entries (recipient_member_id, thread_id, message_id, created_at)
         values ($1, $2, $3, $4::timestamptz)`,
        [bob.id, threadId, message.id, message.created_at],
      );
    }

    const inboxBeforeFreshMessage = await readInbox(bob.token, { unreadOnly: true });
    assert.equal(
      inboxBeforeFreshMessage.results.some((entry) => entry.threadId === threadId),
      false,
      'pre-session history alone should not make the thread unread',
    );

    const sent = await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: 'Fresh message after Bob joins',
    });
    assert.equal(((sent.data as Record<string, unknown>).message as Record<string, unknown>).threadId, threadId);

    const inbox = await readInbox(bob.token, { unreadOnly: true });
    const thread = inbox.results.find((entry) => entry.threadId === threadId);
    assert.ok(thread, 'new post-join message should surface the thread as unread');
    const unread = thread.unread as Record<string, unknown>;
    assert.equal(unread.hasUnread, true);
    assert.equal(unread.unreadMessageCount, 1);
    assert.equal((thread.latestMessage as Record<string, unknown>).messageText, 'Fresh message after Bob joins');
  });

  it('messages.get returns the thread and message list', async () => {
    const owner = await h.seedOwner('msg-club-4', 'MsgClub4');
    const alice = await h.seedCompedMember(owner.club.id, 'Alice Read');
    const bob = await h.seedCompedMember(owner.club.id, 'Bob Read');

    const sent = await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: 'First message in thread.',
    });
    const sentMessage = (sent.data as Record<string, unknown>).message as Record<string, unknown>;
    const threadId = sentMessage.threadId as string;
    const messageId = sentMessage.messageId as string;

    const readResult = await h.apiOk(alice.token, 'messages.get', { threadId });
    const data = readResult.data as Record<string, unknown>;

    const thread = data.thread as Record<string, unknown>;
    assert.ok(thread, 'messages.get should return a thread summary');
    assert.equal(thread.threadId, threadId);
    assert.equal((thread.counterpart as Record<string, unknown>).memberId, bob.id);
    assert.ok(thread.messageCount, 'thread should have a messageCount');

    const messages = (data.messages as Record<string, unknown>).results as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(messages), 'messages should be an array');
    assert.ok(messages.length >= 1, 'at least one message should be in the thread');
    const msg = messages.find((m) => m.messageId === messageId);
    assert.ok(msg, 'the sent message should appear in the thread');
    assert.equal(msg.senderMemberId, alice.id);
    assert.equal(msg.messageText, 'First message in thread.');
    assert.equal(Object.hasOwn(msg, 'updateCount'), false);
    assert.equal(Object.hasOwn(msg, 'inReplyToMessageId'), false);
  });

  it('messages.get hydrates participant member refs even without mentions', async () => {
    const owner = await h.seedOwner('msg-club-hydrate-thread', 'MsgClubHydrateThread');
    const alice = await h.seedCompedMember(owner.club.id, 'Alice Hydrate Thread');
    const bob = await h.seedCompedMember(owner.club.id, 'Bob Hydrate Thread');

    const sent = await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: 'No mentions here, just a plain DM.',
    });
    const threadId = (((sent.data as Record<string, unknown>).message as Record<string, unknown>).threadId as string);

    await h.apiOk(bob.token, 'messages.send', {
      recipientMemberId: alice.id,
      messageText: 'Replying without mention spans too.',
    });

    const readResult = await h.apiOk(alice.token, 'messages.get', { threadId });
    const data = readResult.data as Record<string, unknown>;
    const thread = data.thread as Record<string, unknown>;
    const messages = ((data.messages as Record<string, unknown>).results as Array<Record<string, unknown>>);
    const included = (((data.included as Record<string, unknown>).membersById) as Record<string, Record<string, unknown>>);

    assert.equal(included[alice.id]?.memberId, alice.id);
    assert.equal(included[alice.id]?.publicName, alice.publicName);
    assert.equal(included[bob.id]?.memberId, bob.id);
    assert.equal(included[bob.id]?.publicName, bob.publicName);
    assert.equal(((thread.counterpart as Record<string, unknown>).memberId as string), bob.id);
    assert.ok(
      messages.every((message) => {
        const senderMemberId = message.senderMemberId as string | null;
        return senderMemberId === null || included[senderMemberId] !== undefined;
      }),
      'every non-null senderMemberId should resolve through included.membersById',
    );
  });

  it('updates.list inbox returns the thread summary', async () => {
    const owner = await h.seedOwner('msg-club-5', 'MsgClub5');
    const alice = await h.seedCompedMember(owner.club.id, 'Alice List');
    const bob = await h.seedCompedMember(owner.club.id, 'Bob List');

    const sent = await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: 'Thread for updates.list inbox.',
    });
    const sentMessage = (sent.data as Record<string, unknown>).message as Record<string, unknown>;
    const threadId = sentMessage.threadId as string;

    const list = await readInbox(alice.token);
    const results = list.results;
    const found = results.find((t) => t.threadId === threadId);
    assert.ok(found, 'thread should appear in the updates.list inbox slice');
    assert.equal((found.counterpart as Record<string, unknown>).memberId, bob.id);

    const latestMessage = found.latestMessage as Record<string, unknown>;
    assert.ok(latestMessage, 'thread should have latestMessage');
    assert.equal(latestMessage.messageText, 'Thread for updates.list inbox.');
  });

  it('updates.list inbox hydrates participant refs even without mentions', async () => {
    const owner = await h.seedOwner('msg-club-hydrate-inbox', 'MsgClubHydrateInbox');
    const alice = await h.seedCompedMember(owner.club.id, 'Alice Hydrate Inbox');
    const bob = await h.seedCompedMember(owner.club.id, 'Bob Hydrate Inbox');

    const sent = await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: 'Inbox hydration check.',
    });
    const threadId = (((sent.data as Record<string, unknown>).message as Record<string, unknown>).threadId as string);

    const inbox = await readInbox(alice.token);
    const found = inbox.results.find((thread) => thread.threadId === threadId);
    assert.ok(found, 'thread should appear in the sender inbox');

    const included = (inbox.included.membersById ?? {}) as Record<string, Record<string, unknown>>;
    assert.equal(included[alice.id]?.memberId, alice.id);
    assert.equal(included[bob.id]?.memberId, bob.id);
    assert.equal(((found?.counterpart as Record<string, unknown> | undefined)?.memberId as string), bob.id);

    const latestMessage = (found?.latestMessage ?? {}) as Record<string, unknown>;
    const latestSenderId = latestMessage.senderMemberId as string | null | undefined;
    assert.equal(latestSenderId, alice.id);
    assert.ok(latestSenderId && included[latestSenderId], 'latest sender should resolve through included.membersById');
  });

  it('a third member not in the conversation cannot read the thread', async () => {
    const owner = await h.seedOwner('msg-club-6', 'MsgClub6');
    const alice = await h.seedCompedMember(owner.club.id, 'Alice Private');
    const bob = await h.seedCompedMember(owner.club.id, 'Bob Private');
    const carol = await h.seedCompedMember(owner.club.id, 'Carol Outsider');

    const sent = await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: 'Private message.',
    });
    const sentMessage = (sent.data as Record<string, unknown>).message as Record<string, unknown>;
    const threadId = sentMessage.threadId as string;

    // Carol is not a participant — she should get not_found
    const err = await h.apiErr(carol.token, 'messages.get', { threadId });
    assert.equal(err.code, 'thread_not_found');
  });

  it('member can DM the club owner and owner can reply', async () => {
    const owner = await h.seedOwner('msg-club-7', 'MsgClub7');
    const alice = await h.seedCompedMember(owner.club.id, 'Alice ToOwner');

    // Member messages the owner
    const sent = await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: owner.id,
      messageText: 'Hi owner, question about the club!',
    });
    const msg1 = (sent.data as Record<string, unknown>).message as Record<string, unknown>;
    const sentThread = (sent.data as Record<string, unknown>).thread as Record<string, unknown>;
    const threadId = msg1.threadId as string;
    assert.equal(msg1.senderMemberId, alice.id);
    assert.equal(sentThread.recipientMemberId, owner.id);

    // Owner sees it in their inbox
    const ownerInbox = await readInbox(owner.token);
    const ownerThreads = ownerInbox.results;
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
    const readResult = await h.apiOk(alice.token, 'messages.get', { threadId });
    const messages = (((readResult.data as Record<string, unknown>).messages as Record<string, unknown>).results) as Array<Record<string, unknown>>;
    assert.ok(messages.length >= 2, 'thread should have at least two messages');
    const texts = messages.map((m) => m.messageText);
    assert.ok(texts.includes('Hi owner, question about the club!'));
    assert.ok(texts.includes('Thanks for reaching out!'));
  });

  it('multi-message conversation maintains thread correctly', async () => {
    const owner = await h.seedOwner('msg-club-8', 'MsgClub8');
    const alice = await h.seedCompedMember(owner.club.id, 'Alice Multi');
    const bob = await h.seedCompedMember(owner.club.id, 'Bob Multi');

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
    const readResult = await h.apiOk(alice.token, 'messages.get', { threadId });
    const messages = (((readResult.data as Record<string, unknown>).messages as Record<string, unknown>).results) as Array<Record<string, unknown>>;
    assert.equal(messages.length, 3, 'thread should have exactly 3 messages');
    assert.deepEqual(
      messages.map((m) => m.messageText),
      ['Message 3', 'Message 2', 'Message 1'],
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
    const alice = await h.seedCompedMember(owner.club.id, 'Alice Multi');
    await h.seedCompedMembership(club2.id, alice.id);

    const result = await h.apiOk(owner.token, 'messages.send', {
      recipientMemberId: alice.id,
      messageText: 'No club needed',
    });
    const data = result.data as Record<string, unknown>;
    const message = data.message as Record<string, unknown>;
    const thread = data.thread as Record<string, unknown>;
    assert.ok(message.threadId, 'should succeed without clubId');
    assert.equal(message.messageText, 'No club needed');

    // sharedClubs should include both clubs and live on the thread context.
    const sharedClubs = thread.sharedClubs as Array<Record<string, unknown>>;
    assert.equal(Object.hasOwn(message, 'sharedClubs'), false);
    assert.ok(Array.isArray(sharedClubs), 'send response should have sharedClubs');
    assert.ok(sharedClubs.length >= 2, 'should show both shared clubs');
    const slugs = sharedClubs.map(c => c.slug);
    assert.ok(slugs.includes('msg-multi-1'));
    assert.ok(slugs.includes('msg-multi-2'));
  });

  it('send response has sharedClubs not clubId', async () => {
    const owner = await h.seedOwner('msg-shape-1', 'MsgShape1');
    const alice = await h.seedCompedMember(owner.club.id, 'Alice Shape');

    const result = await h.apiOk(owner.token, 'messages.send', {
      recipientMemberId: alice.id,
      messageText: 'Shape check',
    });
    const data = result.data as Record<string, unknown>;
    const message = data.message as Record<string, unknown>;
    const thread = data.thread as Record<string, unknown>;
    assert.ok(!('clubId' in message), 'send response should not have clubId');
    assert.ok(!('sharedClubs' in message), 'message should not have thread sharedClubs');
    const sharedClubs = thread.sharedClubs as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(sharedClubs), 'send response should have sharedClubs');
    assert.ok(sharedClubs.length >= 1);
    assert.ok(sharedClubs[0].clubId);
    assert.ok(sharedClubs[0].slug);
    assert.ok(sharedClubs[0].name);
  });

  it('messages.get returns sharedClubs on thread', async () => {
    const owner = await h.seedOwner('msg-read-sc', 'MsgReadSC');
    const alice = await h.seedCompedMember(owner.club.id, 'Alice ReadSC');

    const sent = await h.apiOk(owner.token, 'messages.send', { recipientMemberId: alice.id, messageText: 'SC test' });
    const threadId = ((sent.data as Record<string, unknown>).message as Record<string, unknown>).threadId as string;

    const readResult = await h.apiOk(owner.token, 'messages.get', { threadId });
    const thread = (readResult.data as Record<string, unknown>).thread as Record<string, unknown>;
    assert.ok(!('clubId' in thread), 'thread should not have clubId');
    const sharedClubs = thread.sharedClubs as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(sharedClubs));
    assert.ok(sharedClubs.length >= 1);
  });

  it('updates.list inbox returns sharedClubs on threads', async () => {
    const owner = await h.seedOwner('msg-list-sc', 'MsgListSC');
    const alice = await h.seedCompedMember(owner.club.id, 'Alice ListSC');

    await h.apiOk(owner.token, 'messages.send', { recipientMemberId: alice.id, messageText: 'list SC test' });

    const list = await readInbox(owner.token);
    const results = list.results;
    assert.ok(results.length >= 1);
    assert.ok(!('clubId' in results[0]), 'thread should not have clubId');
    assert.ok(Array.isArray(results[0].sharedClubs));
  });

  it('updates.list inbox returns sharedClubs on threads (unreadOnly)', async () => {
    const owner = await h.seedOwner('msg-inbox-sc', 'MsgInboxSC');
    const alice = await h.seedCompedMember(owner.club.id, 'Alice InboxSC');

    await h.apiOk(alice.token, 'messages.send', { recipientMemberId: owner.id, messageText: 'inbox SC test' });

    const inbox = await readInbox(owner.token);
    const results = inbox.results;
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
    assert.equal(err.code, 'member_not_found');
    assert.equal(err.message, 'Recipient is not reachable from your current member scope.');

    const unknown = await h.apiErr(ownerA.token, 'messages.send', {
      recipientMemberId: 'member-does-not-exist',
      messageText: 'Should also fail',
    });
    assert.deepEqual(
      { code: unknown.code, message: unknown.message },
      { code: err.code, message: err.message },
    );
  });

  it('stream message frame carries sharedClubs on the thread', async () => {
    const owner = await h.seedOwner('msg-upd-sc', 'MsgUpdSC');
    const alice = await h.seedCompedMember(owner.club.id, 'Alice UpdSC');

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
    const alice = await h.seedCompedMember(owner.club.id, 'Alice Diverge');

    // Start a DM while they share a club
    const sent = await h.apiOk(owner.token, 'messages.send', {
      recipientMemberId: alice.id,
      messageText: 'Before diverge',
    });
    const threadId = ((sent.data as Record<string, unknown>).message as Record<string, unknown>).threadId as string;

    // Remove alice from the club — shared clubs drop to zero
    await h.apiOk(owner.token, 'clubadmin.members.update', {
      clubId: owner.club.id,
      memberId: alice.id,
      patch: { status: 'removed', reason: 'testing diverge' },
    });

    // Alice can still reply in the existing thread
    const reply = await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: owner.id,
      messageText: 'After diverge',
    });
    const replyMsg = (reply.data as Record<string, unknown>).message as Record<string, unknown>;
    const replyThread = (reply.data as Record<string, unknown>).thread as Record<string, unknown>;
    assert.equal(replyMsg.threadId, threadId, 'reply should be in the same thread');
    const sharedClubs = replyThread.sharedClubs as Array<Record<string, unknown>>;
    assert.equal(sharedClubs.length, 0, 'sharedClubs should be empty after diverge');

    // Owner can also reply
    const ownerReply = await h.apiOk(owner.token, 'messages.send', {
      recipientMemberId: alice.id,
      messageText: 'Owner after diverge',
    });
    assert.equal(((ownerReply.data as Record<string, unknown>).message as Record<string, unknown>).threadId, threadId);

    // Thread is readable with sharedClubs: []
    const readResult = await h.apiOk(owner.token, 'messages.get', { threadId });
    const thread = (readResult.data as Record<string, unknown>).thread as Record<string, unknown>;
    assert.deepEqual(thread.sharedClubs, []);
    const messages = (((readResult.data as Record<string, unknown>).messages as Record<string, unknown>).results) as Array<Record<string, unknown>>;
    assert.ok(messages.length >= 3);
  });

  it('existing thread cannot reach a platform-banned recipient', async () => {
    const owner = await h.seedOwner('msg-banned-recipient', 'MsgBannedRecipient');
    const bob = await h.seedCompedMember(owner.club.id, 'Bob Banned');

    // Owner starts a DM with Bob while both are active and share a club.
    const sent = await h.apiOk(owner.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: 'Before ban',
    });
    const threadId = ((sent.data as Record<string, unknown>).message as Record<string, unknown>).threadId as string;

    // Bob is banned platform-wide. Simulated by flipping members.state directly;
    // this is the exact state billingBanMember would leave the row in, and it
    // isolates the DM standing gate from other parts of the ban flow.
    await h.sql(`update members set state = 'banned' where id = $1`, [bob.id]);

    // The thread still exists, but the owner can no longer DM into it because
    // the standing check at the write path rejects banned recipients. The error
    // must be specific enough that an agent can tell its user why the send
    // failed: "Bob is no longer on ClawClub," not a generic not_found.
    const err = await h.apiErr(owner.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: 'After ban',
    });
    assert.equal(err.status, 404);
    assert.equal(err.code, 'recipient_unavailable');
    assert.match(err.message, /no longer active on ClawClub/i);

    // No new message row was created — only the pre-ban "Before ban" message
    // should exist in the thread.
    const threadMessages = await h.sql<{ message_text: string }>(
      `select message_text from dm_messages where thread_id = $1 order by created_at asc`,
      [threadId],
    );
    assert.equal(threadMessages.length, 1);
    assert.equal(threadMessages[0]?.message_text, 'Before ban');
  });

  it('updates.acknowledge marks a thread read and is idempotent', async () => {
    const owner = await h.seedOwner('msg-ack-null', 'MsgAckNull');
    const alice = await h.seedCompedMember(owner.club.id, 'Alice Ack');

    await h.apiOk(alice.token, 'messages.send', { recipientMemberId: owner.id, messageText: 'Ack test' });

    const inboxBefore = await readInbox(owner.token, { unreadOnly: true });
    const beforeThreads = inboxBefore.results;
    assert.equal(beforeThreads.length, 1);
    const threadId = beforeThreads[0]!.threadId as string;
    const unreadBefore = beforeThreads[0]!.unread as Record<string, unknown>;
    assert.equal(unreadBefore.unreadMessageCount, 1);

    const ack = await h.apiOk(owner.token, 'updates.acknowledge', {
      target: { kind: 'thread', threadId },
    });
    assert.equal((ack.data as Record<string, unknown>).kind, 'thread');
    assert.equal((ack.data as Record<string, unknown>).threadId, threadId);
    assert.equal((ack.data as Record<string, unknown>).acknowledgedCount, 1);

    const acknowledgedRows = await h.sql<{ acknowledged_at: string | null }>(
      `select acknowledged_at::text as acknowledged_at
       from dm_inbox_entries
       where recipient_member_id = $1 and thread_id = $2`,
      [owner.id, threadId],
    );
    assert.match(String(acknowledgedRows[0]?.acknowledged_at), /^\d{4}-\d{2}-\d{2}/);

    const inboxAfter = await readInbox(owner.token, { unreadOnly: true });
    const afterThreads = inboxAfter.results;
    assert.equal(afterThreads.length, 0, 'thread should disappear from unread-only inbox after acknowledgement');

    const fullInbox = await readInbox(owner.token);
    const fullThreads = fullInbox.results;
    const thread = fullThreads.find((entry) => entry.threadId === threadId);
    assert.ok(thread, 'thread should still exist in the full inbox');
    const unreadAfter = thread.unread as Record<string, unknown>;
    assert.equal(unreadAfter.hasUnread, false);
    assert.equal(unreadAfter.unreadMessageCount, 0);

    const secondAck = await h.apiOk(owner.token, 'updates.acknowledge', {
      target: { kind: 'thread', threadId },
    });
    assert.equal((secondAck.data as Record<string, unknown>).acknowledgedCount, 0);
  });

  it('replying auto-acknowledges the sender side of the DM thread', async () => {
    const owner = await h.seedOwner('msg-auto-ack', 'MsgAutoAck');
    const alice = await h.seedCompedMember(owner.club.id, 'Alice AutoAck');

    const first = await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: owner.id,
      messageText: 'First unread message',
    });
    const threadId = ((first.data as Record<string, unknown>).message as Record<string, unknown>).threadId as string;

    await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: owner.id,
      messageText: 'Second unread message',
    });

    const ownerUnreadBefore = await readInbox(owner.token, { unreadOnly: true });
    const ownerUnreadThreadsBefore = ownerUnreadBefore.results;
    assert.equal(ownerUnreadThreadsBefore.length, 1);
    assert.equal(ownerUnreadThreadsBefore[0]!.threadId, threadId);
    assert.equal((ownerUnreadThreadsBefore[0]!.unread as Record<string, unknown>).unreadMessageCount, 2);

    await h.apiOk(owner.token, 'messages.send', {
      recipientMemberId: alice.id,
      messageText: 'Replying means I have seen the thread',
    });

    const ownerUnreadAfter = await readInbox(owner.token, { unreadOnly: true });
    const ownerUnreadThreadsAfter = ownerUnreadAfter.results;
    assert.equal(ownerUnreadThreadsAfter.length, 0, 'replying should clear the sender unread state for that thread');

    const ownerFullInbox = await readInbox(owner.token);
    const ownerFullThreads = ownerFullInbox.results;
    const ownerThread = ownerFullThreads.find((entry) => entry.threadId === threadId);
    assert.ok(ownerThread, 'thread should remain in the full inbox after replying');
    assert.equal((ownerThread.unread as Record<string, unknown>).unreadMessageCount, 0);

    const aliceUnreadAfter = await readInbox(alice.token, { unreadOnly: true });
    const aliceUnreadThreadsAfter = aliceUnreadAfter.results;
    assert.equal(aliceUnreadThreadsAfter.length, 1, 'recipient-side unread state should still reflect the new reply');
    assert.equal(aliceUnreadThreadsAfter[0]!.threadId, threadId);
    assert.equal((aliceUnreadThreadsAfter[0]!.unread as Record<string, unknown>).unreadMessageCount, 1);
  });

  it('reply auto-ack is isolated to the replied thread', async () => {
    const owner = await h.seedOwner('msg-auto-ack-iso', 'MsgAutoAckIso');
    const alice = await h.seedCompedMember(owner.club.id, 'Alice IsoAck');
    const bob = await h.seedCompedMember(owner.club.id, 'Bob IsoAck');

    const aliceThread = await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: owner.id,
      messageText: 'Unread from Alice',
    });
    const aliceThreadId = ((aliceThread.data as Record<string, unknown>).message as Record<string, unknown>).threadId as string;

    const bobThread = await h.apiOk(bob.token, 'messages.send', {
      recipientMemberId: owner.id,
      messageText: 'Unread from Bob',
    });
    const bobThreadId = ((bobThread.data as Record<string, unknown>).message as Record<string, unknown>).threadId as string;

    const ownerUnreadBefore = await readInbox(owner.token, { unreadOnly: true });
    const ownerUnreadThreadsBefore = ownerUnreadBefore.results;
    assert.equal(ownerUnreadThreadsBefore.length, 2);

    await h.apiOk(owner.token, 'messages.send', {
      recipientMemberId: alice.id,
      messageText: 'Replying only to Alice',
    });

    const ownerUnreadAfter = await readInbox(owner.token, { unreadOnly: true });
    const ownerUnreadThreadsAfter = ownerUnreadAfter.results;
    assert.equal(ownerUnreadThreadsAfter.length, 1, 'replying should only clear unread state in the replied thread');
    assert.equal(ownerUnreadThreadsAfter[0]!.threadId, bobThreadId);
    assert.notEqual(ownerUnreadThreadsAfter[0]!.threadId, aliceThreadId);
    assert.equal((ownerUnreadThreadsAfter[0]!.unread as Record<string, unknown>).unreadMessageCount, 1);
  });

  it('updates.acknowledge returns not_found for an unknown thread', async () => {
    const owner = await h.seedOwner('msg-ack-missing', 'MsgAckMissing');

    const err = await h.apiErr(owner.token, 'updates.acknowledge', {
      target: { kind: 'thread', threadId: 'thread_missing' },
    });
    assert.equal(err.status, 404);
    assert.equal(err.code, 'thread_not_found');
  });

  it('updates.acknowledge rejects unknown fields inside the target union arm', async () => {
    const owner = await h.seedOwner('msg-ack-strict', 'MsgAckStrict');

    const err = await h.apiErr(owner.token, 'updates.acknowledge', {
      target: {
        kind: 'thread',
        threadId: 'thread_missing',
        unexpected: true,
      },
    });
    assert.equal(err.status, 400);
    assert.equal(err.code, 'invalid_input');
    assert.match(err.message, /Unrecognized key/i);
  });

  it('duplicate clientKey sends return the original message without creating another row', async () => {
    const owner = await h.seedOwner('msg-client-key', 'MsgClientKey');
    const alice = await h.seedCompedMember(owner.club.id, 'Alice ClientKey');
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

  it('clientKey replay does not auto-ack unread replies that arrived later', async () => {
    const owner = await h.seedOwner('msg-client-key-ack', 'MsgClientKeyAck');
    const alice = await h.seedCompedMember(owner.club.id, 'Alice ClientKeyAck');
    const clientKey = 'retry-key-ack-1';

    await h.apiOk(owner.token, 'messages.send', {
      recipientMemberId: alice.id,
      messageText: 'Original send',
      clientKey,
    });

    await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: owner.id,
      messageText: 'Unread reply after original send',
    });

    const unreadBeforeReplay = await readInbox(owner.token, { unreadOnly: true });
    const unreadThreadsBeforeReplay = unreadBeforeReplay.results;
    assert.equal(unreadThreadsBeforeReplay.length, 1);
    const threadId = unreadThreadsBeforeReplay[0]!.threadId as string;
    assert.equal((unreadThreadsBeforeReplay[0]!.unread as Record<string, unknown>).unreadMessageCount, 1);

    const replay = await h.apiOk(owner.token, 'messages.send', {
      recipientMemberId: alice.id,
      messageText: 'Original send',
      clientKey,
    });
    const replayMessage = (replay.data as Record<string, unknown>).message as Record<string, unknown>;
    assert.equal(replayMessage.threadId, threadId);

    const unreadAfterReplay = await readInbox(owner.token, { unreadOnly: true });
    const unreadThreadsAfterReplay = unreadAfterReplay.results;
    assert.equal(unreadThreadsAfterReplay.length, 1, 'clientKey replay should not clear unread state');
    assert.equal(unreadThreadsAfterReplay[0]!.threadId, threadId);
    assert.equal((unreadThreadsAfterReplay[0]!.unread as Record<string, unknown>).unreadMessageCount, 1);
  });

  it('clientKey with different messageText returns 409 client_key_conflict', async () => {
    const owner = await h.seedOwner('msg-ck-conflict', 'MsgCKConflict');
    const alice = await h.seedCompedMember(owner.club.id, 'Alice CKConflict');
    const clientKey = 'conflict-key-1';

    await h.apiOk(owner.token, 'messages.send', {
      recipientMemberId: alice.id,
      messageText: 'Original message',
      clientKey,
    });

    const conflict = await h.api(owner.token, 'messages.send', {
      recipientMemberId: alice.id,
      messageText: 'Different message text',
      clientKey,
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.ok, false);
    const error = conflict.body.error as Record<string, unknown>;
    assert.equal(error.code, 'client_key_conflict');
    const details = error.details as Record<string, unknown>;
    const storedMessage = details.message as Record<string, unknown>;
    assert.equal(storedMessage.messageText, 'Original message');
    assert.ok(storedMessage.messageId, 'conflict details should include the canonical stored message state');
  });

  it('clientKey is scoped to the sender, not global across actors', async () => {
    const owner = await h.seedOwner('msg-ck-actor-scope', 'MsgCKActorScope');
    const alice = await h.seedCompedMember(owner.club.id, 'Alice CKActorScope');
    const bob = await h.seedCompedMember(owner.club.id, 'Bob CKActorScope');
    const clientKey = 'shared-sender-scoped-key';

    const first = await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: 'Alice uses a sender-scoped key.',
      clientKey,
    });
    const second = await h.apiOk(bob.token, 'messages.send', {
      recipientMemberId: alice.id,
      messageText: 'Bob may reuse the same key independently.',
      clientKey,
    });

    const firstMessage = (first.data as Record<string, unknown>).message as Record<string, unknown>;
    const secondMessage = (second.data as Record<string, unknown>).message as Record<string, unknown>;
    assert.notEqual(firstMessage.messageId, secondMessage.messageId);
    assert.equal(firstMessage.senderMemberId, alice.id);
    assert.equal(secondMessage.senderMemberId, bob.id);
  });

  it('oversized messageText returns 400', async () => {
    const owner = await h.seedOwner('msg-long', 'MsgLong');
    const alice = await h.seedCompedMember(owner.club.id, 'Alice Long');
    const err = await h.apiErr(owner.token, 'messages.send', {
      recipientMemberId: alice.id,
      messageText: 'x'.repeat(500_001),
    });
    assert.equal(err.status, 400);
  });
});

// ── Stream / Read State ──────────────────────────────────────────────────────

describe('messages read-state and stream', () => {
  it('uses acknowledged_at only for DM inbox read state', async () => {
    const columnRows = await h.sql<{ count: string }>(
      `select count(*)::text as count
         from information_schema.columns
        where table_schema = 'public'
          and table_name = 'dm_inbox_entries'
          and column_name = 'acknowledged'`,
    );
    assert.equal(columnRows[0]?.count, '0');

    const indexRows = await h.sql<{ index_name: string | null }>(
      `select to_regclass('public.dm_inbox_entries_unread_idx')::text as index_name
       union all
       select to_regclass('public.dm_inbox_entries_unread_poll_idx')::text
       union all
       select to_regclass('public.dm_inbox_entries_unread_thread_idx')::text`,
    );
    assert.deepEqual(indexRows.map((row) => row.index_name), [null, null, null]);
  });

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
    const alice = await h.seedCompedMember(owner.club.id, 'Alice Tail');

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

  it('message frame matches a single-message projection of messages.get', async () => {
    const owner = await h.seedOwner('sse-club-3', 'SSEClub3');
    const alice = await h.seedCompedMember(owner.club.id, 'Alice RT');

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

      const threadResult = await h.apiOk(owner.token, 'messages.get', { threadId });
      const threadData = threadResult.data as Record<string, unknown>;
      const thread = threadData.thread as Record<string, unknown>;
      const messages = ((threadData.messages as Record<string, unknown>).results) as Array<Record<string, unknown>>;
      const included = threadData.included as Record<string, unknown>;
      const matchingMessage = messages.find((message) => message.messageId === messageId);

      assert.deepEqual(frameThread.counterpart, thread.counterpart);
      assert.deepEqual(frameThread.sharedClubs, thread.sharedClubs);
      assert.ok(matchingMessage);
      assert.deepEqual(frameMessages[0], matchingMessage);
      assert.deepEqual(frameIncluded.membersById, included.membersById);
    } finally {
      stream.close();
    }
  });
});
