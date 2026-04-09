/**
 * Integration tests for the content removal system.
 *
 * Covers: content.remove, events.remove, messages.remove,
 * clubadmin.content.remove, clubadmin.events.remove.
 * Verifies version-based entity removal, dm_message_removals table,
 * content blanking in read paths, updates-feed filtering, and
 * superadmin bypass via clubadmin actions.
 */

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

// ── Helpers ───────────────────────────────────────────────────────────────────

function removal(result: Record<string, unknown>) {
  return (result.data as Record<string, unknown>).removal as Record<string, unknown>;
}

function entity(result: Record<string, unknown>) {
  return (result.data as Record<string, unknown>).entity as Record<string, unknown>;
}

function event(result: Record<string, unknown>) {
  return (result.data as Record<string, unknown>).event as Record<string, unknown>;
}

async function seedEventEntity(clubId: string, authorId: string, title: string): Promise<string> {
  const [ent] = await h.sqlClubs<{ id: string }>(
    `insert into entities (club_id, kind, author_member_id) values ($1, 'event', $2) returning id`,
    [clubId, authorId],
  );
  const [ver] = await h.sqlClubs<{ id: string }>(
    `insert into entity_versions (entity_id, version_no, state, title, summary, body, created_by_member_id)
     values ($1, 1, 'published', $2, 'An event', 'Details', $3) returning id`,
    [ent!.id, title, authorId],
  );
  await h.sqlClubs(
    `insert into event_version_details (entity_version_id, location, starts_at, ends_at, timezone)
     values ($1, 'Online', now() + interval '1 day', now() + interval '1 day 2 hours', 'UTC')`,
    [ver!.id],
  );
  return ent!.id;
}

// ── Entity Removal (self-service) ─────────────────────────────────────────────

describe('content.remove', () => {
  it('author removes own entity — disappears from list', async () => {
    const owner = await h.seedOwner('entity-remove-author', 'Entity Remove Author Club');
    const author = await h.seedClubMember(owner.club.id, 'Author Remove', 'author-remove-entity', { sponsorId: owner.id });

    const [ent] = await h.sqlClubs<{ id: string }>(
      `insert into entities (club_id, kind, author_member_id) values ($1, 'post', $2) returning id`,
      [owner.club.id, author.id],
    );
    await h.sqlClubs(
      `insert into entity_versions (entity_id, version_no, state, title, body, created_by_member_id)
       values ($1, 1, 'published', 'To be removed', 'Body', $2)`,
      [ent!.id, author.id],
    );

    const result = await h.apiOk(author.token, 'content.remove', { entityId: ent!.id });
    const e = entity(result);
    assert.equal(e.entityId, ent!.id);
    assert.equal((e.version as Record<string, unknown>).state, 'removed');

    const list = await h.apiOk(author.token, 'content.list', { clubId: owner.club.id });
    const items = (list.data as Record<string, unknown>).results as Array<Record<string, unknown>>;
    assert.ok(!items.find((i) => i.entityId === ent!.id), 'removed entity should not appear in list');
  });

  it('author removes own entity with optional reason', async () => {
    const owner = await h.seedOwner('entity-remove-reason', 'Entity Remove Reason Club');
    const author = await h.seedClubMember(owner.club.id, 'Author Reason', 'author-reason-remove', { sponsorId: owner.id });

    const [ent] = await h.sqlClubs<{ id: string }>(
      `insert into entities (club_id, kind, author_member_id) values ($1, 'post', $2) returning id`,
      [owner.club.id, author.id],
    );
    await h.sqlClubs(
      `insert into entity_versions (entity_id, version_no, state, title, body, created_by_member_id)
       values ($1, 1, 'published', 'Reason test', 'Body', $2)`,
      [ent!.id, author.id],
    );

    const result = await h.apiOk(author.token, 'content.remove', { entityId: ent!.id, reason: 'Posted by mistake' });
    const e = entity(result);
    assert.equal((e.version as Record<string, unknown>).state, 'removed');
  });

  it('non-author cannot remove — 404 (existence-hiding)', async () => {
    const owner = await h.seedOwner('entity-remove-forbidden', 'Entity Remove Forbidden Club');
    const author = await h.seedClubMember(owner.club.id, 'Author Forbid', 'author-forbid-remove', { sponsorId: owner.id });
    const bystander = await h.seedClubMember(owner.club.id, 'Bystander', 'bystander-remove', { sponsorId: owner.id });

    const [ent] = await h.sqlClubs<{ id: string }>(
      `insert into entities (club_id, kind, author_member_id) values ($1, 'post', $2) returning id`,
      [owner.club.id, author.id],
    );
    await h.sqlClubs(
      `insert into entity_versions (entity_id, version_no, state, title, body, created_by_member_id)
       values ($1, 1, 'published', 'Protected', 'Only author may remove', $2)`,
      [ent!.id, author.id],
    );

    const err = await h.apiErr(bystander.token, 'content.remove', { entityId: ent!.id });
    assert.equal(err.status, 404);
  });

  it('double remove is idempotent', async () => {
    const owner = await h.seedOwner('entity-remove-idempotent', 'Entity Remove Idempotent Club');
    const author = await h.seedClubMember(owner.club.id, 'Author Idempotent', 'author-idempotent-remove', { sponsorId: owner.id });

    const [ent] = await h.sqlClubs<{ id: string }>(
      `insert into entities (club_id, kind, author_member_id) values ($1, 'post', $2) returning id`,
      [owner.club.id, author.id],
    );
    await h.sqlClubs(
      `insert into entity_versions (entity_id, version_no, state, title, body, created_by_member_id)
       values ($1, 1, 'published', 'Idempotent', 'Body', $2)`,
      [ent!.id, author.id],
    );

    const first = await h.apiOk(author.token, 'content.remove', { entityId: ent!.id });
    const second = await h.apiOk(author.token, 'content.remove', { entityId: ent!.id });
    assert.equal((entity(first) as Record<string, unknown>).entityId, (entity(second) as Record<string, unknown>).entityId);
  });

  it('removed entity filtered from updates feed', async () => {
    const owner = await h.seedOwner('entity-remove-updates', 'Entity Remove Updates Club');
    const author = await h.seedClubMember(owner.club.id, 'Author Updates', 'author-updates-remove', { sponsorId: owner.id });
    const viewer = await h.seedClubMember(owner.club.id, 'Viewer Updates', 'viewer-updates-remove', { sponsorId: owner.id });

    // Seed the viewer's cursor BEFORE the entity is created
    const seedResult = await h.apiOk(viewer.token, 'updates.list', {});
    const seedAfter = ((seedResult.data as Record<string, unknown>).updates as Record<string, unknown>).nextAfter as string;

    const [ent] = await h.sqlClubs<{ id: string }>(
      `insert into entities (club_id, kind, author_member_id) values ($1, 'post', $2) returning id`,
      [owner.club.id, author.id],
    );
    const [ver] = await h.sqlClubs<{ id: string }>(
      `insert into entity_versions (entity_id, version_no, state, title, body, created_by_member_id)
       values ($1, 1, 'published', 'Will remove', 'Content', $2) returning id`,
      [ent!.id, author.id],
    );
    await h.sqlClubs(
      `insert into club_activity (club_id, topic, entity_id, entity_version_id, created_by_member_id, payload)
       values ($1, 'entity.version.published', $2, $3, $4, '{"kind":"entity"}'::jsonb)`,
      [owner.club.id, ent!.id, ver!.id, author.id],
    );

    const beforeUpdates = await h.apiOk(viewer.token, 'updates.list', { after: seedAfter });
    const beforeItems = ((beforeUpdates.data as Record<string, unknown>).updates as Record<string, unknown>).items as Array<Record<string, unknown>>;
    assert.ok(beforeItems.some((u) => u.entityId === ent!.id), 'entity update should exist before removal');

    await h.apiOk(author.token, 'content.remove', { entityId: ent!.id });

    const afterUpdates = await h.apiOk(viewer.token, 'updates.list', { after: seedAfter });
    const afterItems = ((afterUpdates.data as Record<string, unknown>).updates as Record<string, unknown>).items as Array<Record<string, unknown>>;
    assert.ok(
      !afterItems.some((u) => u.entityId === ent!.id && u.topic === 'entity.version.published'),
      'published entity update should be filtered after removal',
    );
  });
});

// ── Message Removal (self-service) ────────────────────────────────────────────

describe('messages.remove', () => {
  it('sender removes own message — thread shows placeholder', async () => {
    const owner = await h.seedOwner('msg-remove-sender', 'Msg Remove Sender Club');
    const alice = await h.seedClubMember(owner.club.id, 'Alice MsgRemove', 'alice-msg-remove', { sponsorId: owner.id });
    const bob = await h.seedClubMember(owner.club.id, 'Bob MsgRemove', 'bob-msg-remove', { sponsorId: owner.id });

    const sendResult = await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: 'This is a secret message',
    });
    const msg = (sendResult.data as Record<string, unknown>).message as Record<string, unknown>;
    const msgId = msg.messageId as string;
    const threadId = msg.threadId as string;

    const result = await h.apiOk(alice.token, 'messages.remove', { messageId: msgId, reason: 'Sent in error' });
    const r = removal(result);
    assert.equal(r.messageId, msgId);

    const thread = await h.apiOk(alice.token, 'messages.getThread', { threadId });
    const messages = (thread.data as Record<string, unknown>).messages as Array<Record<string, unknown>>;
    const removedMsg = messages.find((m) => m.messageId === msgId);
    assert.ok(removedMsg);
    assert.equal(removedMsg.messageText, '[Message removed]');
  });

  it('non-sender cannot remove — 404 (existence-hiding)', async () => {
    const owner = await h.seedOwner('msg-remove-forbidden', 'Msg Remove Forbidden Club');
    const alice = await h.seedClubMember(owner.club.id, 'Alice Forbidden', 'alice-forbidden-remove', { sponsorId: owner.id });
    const bob = await h.seedClubMember(owner.club.id, 'Bob Forbidden', 'bob-forbidden-remove', { sponsorId: owner.id });

    const sendResult = await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: 'Bob cannot remove this',
    });
    const msg = (sendResult.data as Record<string, unknown>).message as Record<string, unknown>;

    const err = await h.apiErr(bob.token, 'messages.remove', { messageId: msg.messageId as string });
    assert.equal(err.status, 404, 'non-sender should get 404, not 403');
  });

  it('already-removed message does not leak to non-sender', async () => {
    const owner = await h.seedOwner('msg-remove-leak', 'Msg Remove Leak Club');
    const alice = await h.seedClubMember(owner.club.id, 'Alice LeakRm', 'alice-leakrm', { sponsorId: owner.id });
    const bob = await h.seedClubMember(owner.club.id, 'Bob LeakRm', 'bob-leakrm', { sponsorId: owner.id });

    const sendResult = await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: 'Will be removed then probed',
    });
    const msg = (sendResult.data as Record<string, unknown>).message as Record<string, unknown>;

    // Sender removes
    await h.apiOk(alice.token, 'messages.remove', { messageId: msg.messageId as string });

    // Non-sender probes the already-removed message — should get 404, not the removal record
    const err = await h.apiErr(bob.token, 'messages.remove', { messageId: msg.messageId as string });
    assert.equal(err.status, 404, 'already-removed message should not leak to non-sender');
  });

  it('double remove is idempotent', async () => {
    const owner = await h.seedOwner('msg-remove-idempotent', 'Msg Remove Idempotent Club');
    const alice = await h.seedClubMember(owner.club.id, 'Alice Idempotent', 'alice-idempotent-remove', { sponsorId: owner.id });
    const bob = await h.seedClubMember(owner.club.id, 'Bob Idempotent', 'bob-idempotent-remove', { sponsorId: owner.id });

    const sendResult = await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: 'Remove me twice',
    });
    const msg = (sendResult.data as Record<string, unknown>).message as Record<string, unknown>;

    const first = await h.apiOk(alice.token, 'messages.remove', { messageId: msg.messageId as string });
    const second = await h.apiOk(alice.token, 'messages.remove', { messageId: msg.messageId as string });
    assert.equal(removal(first).messageId, removal(second).messageId);
  });

  it('removed message disappears from updates feed', async () => {
    const owner = await h.seedOwner('msg-remove-updates', 'Msg Remove Updates Club');
    const alice = await h.seedClubMember(owner.club.id, 'Alice Updates', 'alice-updates-remove', { sponsorId: owner.id });
    const bob = await h.seedClubMember(owner.club.id, 'Bob Updates', 'bob-updates-remove', { sponsorId: owner.id });

    const sendResult = await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: 'Will be removed',
    });
    const msg = (sendResult.data as Record<string, unknown>).message as Record<string, unknown>;

    const beforeUpdates = await h.apiOk(bob.token, 'updates.list', {});
    const beforeItems = ((beforeUpdates.data as Record<string, unknown>).updates as Record<string, unknown>).items as Array<Record<string, unknown>>;
    assert.ok(beforeItems.find((u) => u.topic === 'dm.message.created'), 'update should exist before removal');

    await h.apiOk(alice.token, 'messages.remove', { messageId: msg.messageId as string });

    const afterUpdates = await h.apiOk(bob.token, 'updates.list', {});
    const afterItems = ((afterUpdates.data as Record<string, unknown>).updates as Record<string, unknown>).items as Array<Record<string, unknown>>;
    assert.ok(!afterItems.find((u) => u.topic === 'dm.message.created'), 'dm.message.created should be filtered after removal');
  });
});

// ── Club Admin Moderation ─────────────────────────────────────────────────────

describe('clubadmin.content.remove', () => {
  it('club admin removes any entity with required reason', async () => {
    const owner = await h.seedOwner('admin-entity-remove', 'Admin Entity Remove Club');
    const author = await h.seedClubMember(owner.club.id, 'Author AdminRemove', 'author-admin-remove', { sponsorId: owner.id });

    const [ent] = await h.sqlClubs<{ id: string }>(
      `insert into entities (club_id, kind, author_member_id) values ($1, 'post', $2) returning id`,
      [owner.club.id, author.id],
    );
    await h.sqlClubs(
      `insert into entity_versions (entity_id, version_no, state, title, body, created_by_member_id)
       values ($1, 1, 'published', 'Admin removes this', 'Content', $2)`,
      [ent!.id, author.id],
    );

    const result = await h.apiOk(owner.token, 'clubadmin.content.remove', {
      clubId: owner.club.id,
      entityId: ent!.id,
      reason: 'Violates community guidelines',
    });
    const e = entity(result);
    assert.equal((e.version as Record<string, unknown>).state, 'removed');
  });

  it('clubadmin.content.remove without reason — 400', async () => {
    const owner = await h.seedOwner('admin-entity-no-reason', 'Admin Entity No Reason Club');
    const err = await h.apiErr(owner.token, 'clubadmin.content.remove', {
      clubId: owner.club.id,
      entityId: 'fake-id',
    });
    assert.equal(err.status, 400);
  });

  it('superadmin calls clubadmin.content.remove successfully', async () => {
    const admin = await h.seedSuperadmin('Admin EntityRemove', 'admin-entity-remove-super');
    const owner = await h.seedOwner('super-entity-remove', 'Super Entity Remove Club');

    const [ent] = await h.sqlClubs<{ id: string }>(
      `insert into entities (club_id, kind, author_member_id) values ($1, 'post', $2) returning id`,
      [owner.club.id, owner.id],
    );
    await h.sqlClubs(
      `insert into entity_versions (entity_id, version_no, state, title, body, created_by_member_id)
       values ($1, 1, 'published', 'Superadmin removes', 'Content', $2)`,
      [ent!.id, owner.id],
    );

    const result = await h.apiOk(admin.token, 'clubadmin.content.remove', {
      clubId: owner.club.id,
      entityId: ent!.id,
      reason: 'Platform policy enforcement',
    });
    const e = entity(result);
    assert.equal(e.entityId, ent!.id);
    assert.equal((e.version as Record<string, unknown>).state, 'removed');
  });
});

// clubadmin.messages.remove has been removed — messages are no longer club-scoped.

// ── Moderation Audit ──────────────────────────────────────────────────────────

describe('moderation removal emits feed events', () => {
  it('clubadmin.content.remove emits entity.removed in club activity', async () => {
    const owner = await h.seedOwner('mod-audit-entity', 'Mod Audit Entity Club');
    const author = await h.seedClubMember(owner.club.id, 'Author ModAudit', 'author-mod-audit', { sponsorId: owner.id });
    const viewer = await h.seedClubMember(owner.club.id, 'Viewer ModAudit', 'viewer-mod-audit', { sponsorId: owner.id });

    const [ent] = await h.sqlClubs<{ id: string }>(
      `insert into entities (club_id, kind, author_member_id) values ($1, 'post', $2) returning id`,
      [owner.club.id, author.id],
    );
    await h.sqlClubs(
      `insert into entity_versions (entity_id, version_no, state, title, body, created_by_member_id)
       values ($1, 1, 'published', 'Mod will remove', 'Body', $2)`,
      [ent!.id, author.id],
    );

    // Seed viewer's activity cursor so subsequent reads start from before the removal
    const seedResult = await h.apiOk(viewer.token, 'updates.list', {});
    const seedAfter = ((seedResult.data as Record<string, unknown>).updates as Record<string, unknown>).nextAfter as string;

    // Moderator removes
    await h.apiOk(owner.token, 'clubadmin.content.remove', {
      clubId: owner.club.id,
      entityId: ent!.id,
      reason: 'Policy violation',
    });

    // Viewer should see entity.removed in their activity feed
    const updates = await h.apiOk(viewer.token, 'updates.list', { after: seedAfter });
    const items = ((updates.data as Record<string, unknown>).updates as Record<string, unknown>).items as Array<Record<string, unknown>>;
    const removedUpdate = items.find((u) => u.topic === 'entity.removed' && u.entityId === ent!.id);
    assert.ok(removedUpdate, 'entity.removed should appear in club activity after moderator removal');
  });
});

// RLS audit test removed — no RLS in the split architecture.
// Message removal auth is enforced at the application layer (sender check in messages/index.ts).

// ── Event Removal ─────────────────────────────────────────────────────────────

describe('events.remove', () => {
  it('author removes own event — disappears from list', async () => {
    const owner = await h.seedOwner('event-remove-author', 'Event Remove Author Club');
    const author = await h.seedClubMember(owner.club.id, 'Author EventRemove', 'author-event-remove', { sponsorId: owner.id });
    const entId = await seedEventEntity(owner.club.id, author.id, 'To Remove');

    const result = await h.apiOk(author.token, 'events.remove', { entityId: entId });
    const ev = event(result);
    assert.equal(ev.entityId, entId);
    assert.equal((ev.version as Record<string, unknown>).state, 'removed');

    const list = await h.apiOk(author.token, 'events.list', { clubId: owner.club.id });
    const items = (list.data as Record<string, unknown>).results as Array<Record<string, unknown>>;
    assert.ok(!items.find((i) => i.entityId === entId), 'removed event should not appear in list');
  });

  it('non-author cannot remove — 404 (existence-hiding)', async () => {
    const owner = await h.seedOwner('event-rm-nonauth', 'Event Remove NonAuth Club');
    const author = await h.seedClubMember(owner.club.id, 'Author NARm', 'author-narm', { sponsorId: owner.id });
    const other = await h.seedClubMember(owner.club.id, 'Other NARm', 'other-narm', { sponsorId: owner.id });
    const entId = await seedEventEntity(owner.club.id, author.id, 'Not Yours');

    const err = await h.apiErr(other.token, 'events.remove', { entityId: entId });
    assert.equal(err.status, 404, 'non-author should get 404, not 403');
  });

  it('already-removed event does not leak to non-author', async () => {
    const owner = await h.seedOwner('event-rm-leak', 'Event Remove Leak Club');
    const author = await h.seedClubMember(owner.club.id, 'Author LeakRm', 'author-leakrm', { sponsorId: owner.id });
    const other = await h.seedClubMember(owner.club.id, 'Other LeakRm', 'other-leakrm', { sponsorId: owner.id });
    const entId = await seedEventEntity(owner.club.id, author.id, 'Will Remove');

    // Author removes
    await h.apiOk(author.token, 'events.remove', { entityId: entId });

    // Non-author tries to remove same event — should get 404 (not the removed event)
    const err = await h.apiErr(other.token, 'events.remove', { entityId: entId });
    assert.equal(err.status, 404, 'already-removed event should not leak to non-author');
  });

  it('author double-remove is idempotent', async () => {
    const owner = await h.seedOwner('event-rm-idem', 'Event Remove Idempotent Club');
    const author = await h.seedClubMember(owner.club.id, 'Author IdemRm', 'author-idemrm', { sponsorId: owner.id });
    const entId = await seedEventEntity(owner.club.id, author.id, 'Double Remove');

    const first = await h.apiOk(author.token, 'events.remove', { entityId: entId });
    const second = await h.apiOk(author.token, 'events.remove', { entityId: entId });

    const firstEv = event(first);
    const secondEv = event(second);
    assert.equal(firstEv.entityId, secondEv.entityId, 'double remove should return same event');
    assert.equal((secondEv.version as Record<string, unknown>).state, 'removed');
  });
});

describe('clubadmin.events.remove', () => {
  it('club admin removes any event with required reason', async () => {
    const owner = await h.seedOwner('admin-event-remove', 'Admin Event Remove Club');
    const author = await h.seedClubMember(owner.club.id, 'Author AdminEventRemove', 'author-admin-event-remove', { sponsorId: owner.id });

    const entId = await seedEventEntity(owner.club.id, author.id, 'Admin Removes Event');

    const result = await h.apiOk(owner.token, 'clubadmin.events.remove', {
      clubId: owner.club.id,
      entityId: entId,
      reason: 'Event policy violation',
    });
    const ev = event(result);
    assert.equal((ev.version as Record<string, unknown>).state, 'removed');
  });
});

describe('RSVP on removed event', () => {
  it('RSVP on a removed event returns 404', async () => {
    const owner = await h.seedOwner('rsvp-removed-event', 'RSVP Removed Event Club');
    const author = await h.seedClubMember(owner.club.id, 'Author RSVP', 'author-rsvp-removed', { sponsorId: owner.id });
    const attendee = await h.seedClubMember(owner.club.id, 'Attendee RSVP', 'attendee-rsvp-removed', { sponsorId: owner.id });

    const entId = await seedEventEntity(owner.club.id, author.id, 'RSVP Test Event');

    // Remove the event
    await h.apiOk(author.token, 'events.remove', { entityId: entId });

    // Try to RSVP — should fail
    const err = await h.apiErr(attendee.token, 'events.rsvp', {
      eventEntityId: entId,
      response: 'yes',
    });
    assert.equal(err.status, 404);
  });
});

// ── Multi-club removal correctness ──────────────────────────────────────────

describe('multi-club entity.removed activity goes to correct club', () => {
  it('removal activity is emitted to the entity\'s club, not the member\'s first club', async () => {
    // Create two clubs with a shared member
    const ownerA = await h.seedOwner('multi-rm-a', 'Multi Remove Club A');
    const ownerB = await h.seedOwner('multi-rm-b', 'Multi Remove Club B');

    // Create a member in both clubs
    const author = await h.seedClubMember(ownerA.club.id, 'Author Multi', 'author-multi-rm', { sponsorId: ownerA.id });
    await h.seedMembership(ownerB.club.id, author.id, { sponsorId: ownerB.id });

    // Create entity in club B
    const [ent] = await h.sqlClubs<{ id: string }>(
      `insert into entities (club_id, kind, author_member_id) values ($1, 'post', $2) returning id`,
      [ownerB.club.id, author.id],
    );
    await h.sqlClubs(
      `insert into entity_versions (entity_id, version_no, state, title, body, created_by_member_id)
       values ($1, 1, 'published', 'In Club B', 'Body', $2)`,
      [ent!.id, author.id],
    );

    // Seed a viewer in club B to watch for the activity
    const viewerB = await h.seedClubMember(ownerB.club.id, 'Viewer B Multi', 'viewer-b-multi-rm', { sponsorId: ownerB.id });
    const seedB = await h.apiOk(viewerB.token, 'updates.list', {});
    const cursorB = ((seedB.data as Record<string, unknown>).updates as Record<string, unknown>).nextAfter as string;

    // Seed a viewer in club A to verify no activity there
    const viewerA = await h.seedClubMember(ownerA.club.id, 'Viewer A Multi', 'viewer-a-multi-rm', { sponsorId: ownerA.id });
    const seedA = await h.apiOk(viewerA.token, 'updates.list', {});
    const cursorA = ((seedA.data as Record<string, unknown>).updates as Record<string, unknown>).nextAfter as string;

    // Author removes the entity (belongs to both clubs)
    await h.apiOk(author.token, 'content.remove', { entityId: ent!.id });

    // Viewer in club B should see entity.removed
    const updatesB = await h.apiOk(viewerB.token, 'updates.list', { after: cursorB });
    const itemsB = ((updatesB.data as Record<string, unknown>).updates as Record<string, unknown>).items as Array<Record<string, unknown>>;
    const removedInB = itemsB.find((u) => u.topic === 'entity.removed' && u.entityId === ent!.id);
    assert.ok(removedInB, 'entity.removed should appear in club B activity');

    // Viewer in club A should NOT see entity.removed (entity was never in club A)
    const updatesA = await h.apiOk(viewerA.token, 'updates.list', { after: cursorA });
    const itemsA = ((updatesA.data as Record<string, unknown>).updates as Record<string, unknown>).items as Array<Record<string, unknown>>;
    const removedInA = itemsA.find((u) => u.topic === 'entity.removed' && u.entityId === ent!.id);
    assert.ok(!removedInA, 'entity.removed should NOT appear in club A activity');
  });
});

// ── Event removal feed parity ───────────────────────────────────────────────

describe('event removal emits feed events', () => {
  it('events.remove emits entity.removed in club activity', async () => {
    const owner = await h.seedOwner('event-rm-feed', 'Event Remove Feed Club');
    const author = await h.seedClubMember(owner.club.id, 'Author EventFeed', 'author-event-feed', { sponsorId: owner.id });
    const viewer = await h.seedClubMember(owner.club.id, 'Viewer EventFeed', 'viewer-event-feed', { sponsorId: owner.id });

    const entId = await seedEventEntity(owner.club.id, author.id, 'Event to Remove');

    // Seed viewer cursor
    const seedResult = await h.apiOk(viewer.token, 'updates.list', {});
    const seedAfter = ((seedResult.data as Record<string, unknown>).updates as Record<string, unknown>).nextAfter as string;

    // Author removes event
    await h.apiOk(author.token, 'events.remove', { entityId: entId });

    // Viewer should see entity.removed
    const updates = await h.apiOk(viewer.token, 'updates.list', { after: seedAfter });
    const items = ((updates.data as Record<string, unknown>).updates as Record<string, unknown>).items as Array<Record<string, unknown>>;
    const removedUpdate = items.find((u) => u.topic === 'entity.removed' && u.entityId === entId);
    assert.ok(removedUpdate, 'entity.removed should appear in activity after events.remove');
  });

  it('clubadmin.events.remove emits entity.removed in club activity', async () => {
    const owner = await h.seedOwner('admin-event-rm-feed', 'Admin Event Remove Feed Club');
    const author = await h.seedClubMember(owner.club.id, 'Author AdminEventFeed', 'author-admin-event-feed', { sponsorId: owner.id });
    const viewer = await h.seedClubMember(owner.club.id, 'Viewer AdminEventFeed', 'viewer-admin-event-feed', { sponsorId: owner.id });

    const entId = await seedEventEntity(owner.club.id, author.id, 'Admin Removes Event Feed');

    // Seed viewer cursor
    const seedResult = await h.apiOk(viewer.token, 'updates.list', {});
    const seedAfter = ((seedResult.data as Record<string, unknown>).updates as Record<string, unknown>).nextAfter as string;

    // Admin removes event
    await h.apiOk(owner.token, 'clubadmin.events.remove', {
      clubId: owner.club.id,
      entityId: entId,
      reason: 'Event moderation',
    });

    // Viewer should see entity.removed
    const updates = await h.apiOk(viewer.token, 'updates.list', { after: seedAfter });
    const items = ((updates.data as Record<string, unknown>).updates as Record<string, unknown>).items as Array<Record<string, unknown>>;
    const removedUpdate = items.find((u) => u.topic === 'entity.removed' && u.entityId === entId);
    assert.ok(removedUpdate, 'entity.removed should appear in activity after clubadmin.events.remove');
  });
});
