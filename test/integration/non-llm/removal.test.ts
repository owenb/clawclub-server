/**
 * Integration tests for unified public-content removal and DM message removal.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from '../harness.ts';
import { getActivity } from '../helpers.ts';
import { passthroughGate } from '../../unit/fixtures.ts';

let h: TestHarness;

before(async () => {
  h = await TestHarness.start({ llmGate: passthroughGate });
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

function removal(result: Record<string, unknown>) {
  return (result.data as Record<string, unknown>).removal as Record<string, unknown>;
}

function entity(result: Record<string, unknown>) {
  return (result.data as Record<string, unknown>).entity as Record<string, unknown>;
}

function listedFirstEntityIds(result: Record<string, unknown>): string[] {
  const threads = (result.data as Record<string, unknown>).results as Array<Record<string, unknown>>;
  return threads.map((thread) => ((thread.firstEntity as Record<string, unknown>).entityId as string));
}

async function createPost(token: string, clubId: string, title: string, body = 'Body'): Promise<Record<string, unknown>> {
  const result = await h.apiOk(token, 'content.create', {
    clubId,
    kind: 'post',
    title,
    body,
  });
  return entity(result);
}

async function createEvent(token: string, clubId: string, title: string): Promise<Record<string, unknown>> {
  const result = await h.apiOk(token, 'content.create', {
    clubId,
    kind: 'event',
    title,
    summary: 'An event',
    body: 'Details',
    event: {
      location: 'Online',
      startsAt: '2026-07-01T18:00:00Z',
      endsAt: '2026-07-01T20:00:00Z',
      timezone: 'UTC',
    },
  });
  return entity(result);
}

describe('content.remove', () => {
  it('author removes own post and it disappears from content.list', async () => {
    const owner = await h.seedOwner('entity-remove-author', 'Entity Remove Author Club');
    const author = await h.seedCompedMember(owner.club.id, 'Author Remove');

    const post = await createPost(author.token, owner.club.id, 'To be removed');

    const result = await h.apiOk(author.token, 'content.remove', { entityId: post.entityId });
    const removed = entity(result);
    assert.equal(removed.entityId, post.entityId);
    assert.equal((removed.version as Record<string, unknown>).state, 'removed');

    const list = await h.apiOk(author.token, 'content.list', { clubId: owner.club.id });
    const ids = listedFirstEntityIds(list as Record<string, unknown>);
    assert.ok(!ids.includes(post.entityId as string), 'removed root thread should not appear in list');
  });

  it('author removes own post with optional reason', async () => {
    const owner = await h.seedOwner('entity-remove-reason', 'Entity Remove Reason Club');
    const author = await h.seedCompedMember(owner.club.id, 'Author Reason');

    const post = await createPost(author.token, owner.club.id, 'Reason test');
    const result = await h.apiOk(author.token, 'content.remove', {
      entityId: post.entityId,
      reason: 'Posted by mistake',
    });
    assert.equal((entity(result).version as Record<string, unknown>).state, 'removed');
  });

  it('non-author cannot remove a post', async () => {
    const owner = await h.seedOwner('entity-remove-forbidden', 'Entity Remove Forbidden Club');
    const author = await h.seedCompedMember(owner.club.id, 'Author Forbid');
    const bystander = await h.seedCompedMember(owner.club.id, 'Bystander');

    const post = await createPost(author.token, owner.club.id, 'Protected');
    const err = await h.apiErr(bystander.token, 'content.remove', { entityId: post.entityId });
    assert.equal(err.status, 404);
  });

  it('double remove is idempotent', async () => {
    const owner = await h.seedOwner('entity-remove-idempotent', 'Entity Remove Idempotent Club');
    const author = await h.seedCompedMember(owner.club.id, 'Author Idempotent');

    const post = await createPost(author.token, owner.club.id, 'Idempotent');
    const first = await h.apiOk(author.token, 'content.remove', { entityId: post.entityId });
    const second = await h.apiOk(author.token, 'content.remove', { entityId: post.entityId });
    assert.equal(entity(first).entityId, entity(second).entityId);
  });

  it('removed entities cannot be updated back to published', async () => {
    const owner = await h.seedOwner('entity-remove-update', 'Entity Remove Update Club');
    const author = await h.seedCompedMember(owner.club.id, 'Author Update Blocked');

    const post = await createPost(author.token, owner.club.id, 'Do not resurrect');
    await h.apiOk(author.token, 'content.remove', { entityId: post.entityId });

    const err = await h.apiErr(author.token, 'content.update', {
      entityId: post.entityId,
      title: 'Resurrected title',
    });
    assert.equal(err.status, 404);
    assert.equal(err.code, 'not_found');
  });

  it('removed entity is filtered from activity.list', async () => {
    const owner = await h.seedOwner('entity-remove-updates', 'Entity Remove Updates Club');
    const author = await h.seedCompedMember(owner.club.id, 'Author Updates');
    const viewer = await h.seedCompedMember(owner.club.id, 'Viewer Updates');

    const seedResult = getActivity(await h.apiOk(viewer.token, 'activity.list', { clubId: owner.club.id, after: 'latest' }));
    const seedAfter = seedResult.nextAfter as string;

    const post = await createPost(author.token, owner.club.id, 'Will remove', 'Content');

    const beforeItems = getActivity(await h.apiOk(viewer.token, 'activity.list', {
      clubId: owner.club.id,
      after: seedAfter,
    })).items;
    assert.ok(beforeItems.some((u) => u.entityId === post.entityId && u.topic === 'entity.version.published'));

    await h.apiOk(author.token, 'content.remove', { entityId: post.entityId });

    const afterItems = getActivity(await h.apiOk(viewer.token, 'activity.list', {
      clubId: owner.club.id,
      after: seedAfter,
    })).items;
    assert.ok(
      !afterItems.some((u) => u.entityId === post.entityId && u.topic === 'entity.version.published'),
      'published update should be hidden after removal',
    );
  });
});

describe('messages.remove', () => {
  it('sender removes own message and the thread shows a placeholder', async () => {
    const owner = await h.seedOwner('msg-remove-sender', 'Msg Remove Sender Club');
    const alice = await h.seedCompedMember(owner.club.id, 'Alice MsgRemove');
    const bob = await h.seedCompedMember(owner.club.id, 'Bob MsgRemove');

    const sendResult = await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: 'This is a secret message',
    });
    const msg = (sendResult.data as Record<string, unknown>).message as Record<string, unknown>;

    const result = await h.apiOk(alice.token, 'messages.remove', { messageId: msg.messageId, reason: 'Sent in error' });
    assert.equal(removal(result).messageId, msg.messageId);

    const thread = await h.apiOk(alice.token, 'messages.getThread', { threadId: msg.threadId });
    const messages = (thread.data as Record<string, unknown>).messages as Array<Record<string, unknown>>;
    const removedMsg = messages.find((m) => m.messageId === msg.messageId);
    assert.ok(removedMsg);
    assert.equal(removedMsg.messageText, '[Message removed]');
  });

  it('non-sender cannot remove a message', async () => {
    const owner = await h.seedOwner('msg-remove-forbidden', 'Msg Remove Forbidden Club');
    const alice = await h.seedCompedMember(owner.club.id, 'Alice Forbidden');
    const bob = await h.seedCompedMember(owner.club.id, 'Bob Forbidden');

    const sendResult = await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: 'Bob cannot remove this',
    });
    const msg = (sendResult.data as Record<string, unknown>).message as Record<string, unknown>;

    const err = await h.apiErr(bob.token, 'messages.remove', { messageId: msg.messageId as string });
    assert.equal(err.status, 404);
  });

  it('already-removed message does not leak to the non-sender', async () => {
    const owner = await h.seedOwner('msg-remove-leak', 'Msg Remove Leak Club');
    const alice = await h.seedCompedMember(owner.club.id, 'Alice LeakRm');
    const bob = await h.seedCompedMember(owner.club.id, 'Bob LeakRm');

    const sendResult = await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: 'Will be removed then probed',
    });
    const msg = (sendResult.data as Record<string, unknown>).message as Record<string, unknown>;

    await h.apiOk(alice.token, 'messages.remove', { messageId: msg.messageId as string });

    const err = await h.apiErr(bob.token, 'messages.remove', { messageId: msg.messageId as string });
    assert.equal(err.status, 404);
  });

  it('double remove is idempotent', async () => {
    const owner = await h.seedOwner('msg-remove-idempotent', 'Msg Remove Idempotent Club');
    const alice = await h.seedCompedMember(owner.club.id, 'Alice Idempotent');
    const bob = await h.seedCompedMember(owner.club.id, 'Bob Idempotent');

    const sendResult = await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: 'Remove me twice',
    });
    const msg = (sendResult.data as Record<string, unknown>).message as Record<string, unknown>;

    const first = await h.apiOk(alice.token, 'messages.remove', { messageId: msg.messageId as string });
    const second = await h.apiOk(alice.token, 'messages.remove', { messageId: msg.messageId as string });
    assert.equal(removal(first).messageId, removal(second).messageId);
  });

  it('removed message shows a placeholder to the recipient', async () => {
    const owner = await h.seedOwner('msg-remove-updates', 'Msg Remove Updates Club');
    const alice = await h.seedCompedMember(owner.club.id, 'Alice Updates');
    const bob = await h.seedCompedMember(owner.club.id, 'Bob Updates');

    const sendResult = await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: 'Will be removed',
    });
    const msg = (sendResult.data as Record<string, unknown>).message as Record<string, unknown>;

    await h.apiOk(alice.token, 'messages.remove', { messageId: msg.messageId as string });

    const thread = await h.apiOk(bob.token, 'messages.getThread', { threadId: msg.threadId });
    const messages = (thread.data as Record<string, unknown>).messages as Array<Record<string, unknown>>;
    const removed = messages.find((message) => message.messageId === msg.messageId);
    assert.ok(removed);
    assert.equal(removed.messageText, '[Message removed]');
  });
});

describe('clubadmin.content.remove', () => {
  it('club admin removes any entity with a required reason', async () => {
    const owner = await h.seedOwner('admin-entity-remove', 'Admin Entity Remove Club');
    const author = await h.seedCompedMember(owner.club.id, 'Author AdminRemove');

    const post = await createPost(author.token, owner.club.id, 'Admin removes this', 'Content');

    const result = await h.apiOk(owner.token, 'clubadmin.content.remove', {
      clubId: owner.club.id,
      entityId: post.entityId,
      reason: 'Violates community guidelines',
    });
    assert.equal((entity(result).version as Record<string, unknown>).state, 'removed');
  });

  it('clubadmin.content.remove without reason returns 400', async () => {
    const owner = await h.seedOwner('admin-entity-no-reason', 'Admin Entity No Reason Club');
    const err = await h.apiErr(owner.token, 'clubadmin.content.remove', {
      clubId: owner.club.id,
      entityId: 'fake-id',
    });
    assert.equal(err.status, 400);
  });

  it('superadmin can call clubadmin.content.remove', async () => {
    const admin = await h.seedSuperadmin('Admin EntityRemove');
    const owner = await h.seedOwner('super-entity-remove', 'Super Entity Remove Club');

    const post = await createPost(owner.token, owner.club.id, 'Superadmin removes', 'Content');
    const result = await h.apiOk(admin.token, 'clubadmin.content.remove', {
      clubId: owner.club.id,
      entityId: post.entityId,
      reason: 'Platform policy enforcement',
    });
    assert.equal(entity(result).entityId, post.entityId);
    assert.equal((entity(result).version as Record<string, unknown>).state, 'removed');
  });

  it('the same moderation path removes events too', async () => {
    const owner = await h.seedOwner('admin-event-remove', 'Admin Event Remove Club');
    const author = await h.seedCompedMember(owner.club.id, 'Author AdminEventRemove');

    const eventEntity = await createEvent(author.token, owner.club.id, 'Admin Removes Event');
    const result = await h.apiOk(owner.token, 'clubadmin.content.remove', {
      clubId: owner.club.id,
      entityId: eventEntity.entityId,
      reason: 'Event policy violation',
    });
    assert.equal((entity(result).version as Record<string, unknown>).state, 'removed');
  });
});

describe('moderation removal emits feed events', () => {
  it('clubadmin.content.remove emits entity.removed in club activity', async () => {
    const owner = await h.seedOwner('mod-audit-entity', 'Mod Audit Entity Club');
    const author = await h.seedCompedMember(owner.club.id, 'Author ModAudit');
    const viewer = await h.seedCompedMember(owner.club.id, 'Viewer ModAudit');

    const post = await createPost(author.token, owner.club.id, 'Mod will remove');

    const seedResult = getActivity(await h.apiOk(viewer.token, 'activity.list', {
      clubId: owner.club.id,
      after: 'latest',
    }));
    const seedAfter = seedResult.nextAfter as string;

    await h.apiOk(owner.token, 'clubadmin.content.remove', {
      clubId: owner.club.id,
      entityId: post.entityId,
      reason: 'Policy violation',
    });

    const items = getActivity(await h.apiOk(viewer.token, 'activity.list', {
      clubId: owner.club.id,
      after: seedAfter,
    })).items;
    const removedUpdate = items.find((u) => u.topic === 'entity.removed' && u.entityId === post.entityId);
    assert.ok(removedUpdate);
  });
});

describe('event removal via unified content actions', () => {
  it('author removes own event and it disappears from events.list', async () => {
    const owner = await h.seedOwner('event-remove-author', 'Event Remove Author Club');
    const author = await h.seedCompedMember(owner.club.id, 'Author EventRemove');

    const eventEntity = await createEvent(author.token, owner.club.id, 'To Remove');
    const result = await h.apiOk(author.token, 'content.remove', { entityId: eventEntity.entityId });
    assert.equal((entity(result).version as Record<string, unknown>).state, 'removed');

    const list = await h.apiOk(author.token, 'events.list', { clubId: owner.club.id });
    const items = (list.data as Record<string, unknown>).results as Array<Record<string, unknown>>;
    assert.ok(!items.find((item) => item.entityId === eventEntity.entityId));
  });

  it('non-author cannot remove an event', async () => {
    const owner = await h.seedOwner('event-rm-nonauth', 'Event Remove NonAuth Club');
    const author = await h.seedCompedMember(owner.club.id, 'Author NARm');
    const other = await h.seedCompedMember(owner.club.id, 'Other NARm');

    const eventEntity = await createEvent(author.token, owner.club.id, 'Not Yours');
    const err = await h.apiErr(other.token, 'content.remove', { entityId: eventEntity.entityId });
    assert.equal(err.status, 404);
  });

  it('removed events reject new RSVPs', async () => {
    const owner = await h.seedOwner('rsvp-removed-event', 'RSVP Removed Event Club');
    const author = await h.seedCompedMember(owner.club.id, 'Author RSVP');
    const attendee = await h.seedCompedMember(owner.club.id, 'Attendee RSVP');

    const eventEntity = await createEvent(author.token, owner.club.id, 'RSVP Test Event');
    await h.apiOk(author.token, 'content.remove', { entityId: eventEntity.entityId });

    const err = await h.apiErr(attendee.token, 'events.rsvp', {
      eventEntityId: eventEntity.entityId,
      response: 'yes',
    });
    assert.equal(err.status, 404);
  });
});

describe('multi-club entity.removed activity goes to the correct club', () => {
  it('removal activity is emitted to the entity club, not another membership club', async () => {
    const ownerA = await h.seedOwner('multi-rm-a', 'Multi Remove Club A');
    const ownerB = await h.seedOwner('multi-rm-b', 'Multi Remove Club B');

    const author = await h.seedCompedMember(ownerA.club.id, 'Author Multi');
    await h.seedCompedMembership(ownerB.club.id, author.id);

    const viewerB = await h.seedCompedMember(ownerB.club.id, 'Viewer B Multi');
    const viewerA = await h.seedCompedMember(ownerA.club.id, 'Viewer A Multi');

    const post = await createPost(author.token, ownerB.club.id, 'In Club B');

    const seedB = getActivity(await h.apiOk(viewerB.token, 'activity.list', {
      clubId: ownerB.club.id,
      after: 'latest',
    }));
    const cursorB = seedB.nextAfter as string;
    const seedA = getActivity(await h.apiOk(viewerA.token, 'activity.list', {
      clubId: ownerA.club.id,
      after: 'latest',
    }));
    const cursorA = seedA.nextAfter as string;

    await h.apiOk(author.token, 'content.remove', { entityId: post.entityId });

    const itemsB = getActivity(await h.apiOk(viewerB.token, 'activity.list', {
      clubId: ownerB.club.id,
      after: cursorB,
    })).items;
    assert.ok(itemsB.find((u) => u.topic === 'entity.removed' && u.entityId === post.entityId));

    const itemsA = getActivity(await h.apiOk(viewerA.token, 'activity.list', {
      clubId: ownerA.club.id,
      after: cursorA,
    })).items;
    assert.ok(!itemsA.find((u) => u.topic === 'entity.removed' && u.entityId === post.entityId));
  });
});
