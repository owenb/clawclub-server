/**
 * Integration tests for the content removal system.
 *
 * Covers: entities.remove, events.remove, messages.remove,
 * clubadmin.entities.remove, clubadmin.events.remove.
 * Verifies version-based entity removal, dm_message_removals table,
 * content blanking in read paths, updates-feed filtering, and
 * superadmin bypass via clubadmin actions.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from './harness.ts';

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

// ── Entity Removal (self-service) ─────────────────────────────────────────────

describe('entities.remove', () => {
  it('author removes own entity — disappears from list', async () => {
    const owner = await h.seedOwner('entity-remove-author', 'Entity Remove Author Club');
    const author = await h.seedClubMember(owner.club.id, 'Author Remove', 'author-remove-entity', { sponsorId: owner.id });

    const [ent] = await h.sqlClubs<{ id: string }>(
      `insert into app.entities (club_id, kind, author_member_id) values ($1, 'post', $2) returning id`,
      [owner.club.id, author.id],
    );
    await h.sqlClubs(
      `insert into app.entity_versions (entity_id, version_no, state, title, body, created_by_member_id)
       values ($1, 1, 'published', 'To be removed', 'Body', $2)`,
      [ent!.id, author.id],
    );

    const result = await h.apiOk(author.token, 'entities.remove', { entityId: ent!.id });
    const e = entity(result);
    assert.equal(e.entityId, ent!.id);
    assert.equal((e.version as Record<string, unknown>).state, 'removed');

    const list = await h.apiOk(author.token, 'entities.list', { clubId: owner.club.id });
    const items = (list.data as Record<string, unknown>).results as Array<Record<string, unknown>>;
    assert.ok(!items.find((i) => i.entityId === ent!.id), 'removed entity should not appear in list');
  });

  it('author removes own entity with optional reason', async () => {
    const owner = await h.seedOwner('entity-remove-reason', 'Entity Remove Reason Club');
    const author = await h.seedClubMember(owner.club.id, 'Author Reason', 'author-reason-remove', { sponsorId: owner.id });

    const [ent] = await h.sqlClubs<{ id: string }>(
      `insert into app.entities (club_id, kind, author_member_id) values ($1, 'post', $2) returning id`,
      [owner.club.id, author.id],
    );
    await h.sqlClubs(
      `insert into app.entity_versions (entity_id, version_no, state, title, body, created_by_member_id)
       values ($1, 1, 'published', 'Reason test', 'Body', $2)`,
      [ent!.id, author.id],
    );

    const result = await h.apiOk(author.token, 'entities.remove', { entityId: ent!.id, reason: 'Posted by mistake' });
    const e = entity(result);
    assert.equal((e.version as Record<string, unknown>).state, 'removed');
  });

  it('non-author cannot remove — 404 (existence-hiding)', async () => {
    const owner = await h.seedOwner('entity-remove-forbidden', 'Entity Remove Forbidden Club');
    const author = await h.seedClubMember(owner.club.id, 'Author Forbid', 'author-forbid-remove', { sponsorId: owner.id });
    const bystander = await h.seedClubMember(owner.club.id, 'Bystander', 'bystander-remove', { sponsorId: owner.id });

    const [ent] = await h.sqlClubs<{ id: string }>(
      `insert into app.entities (club_id, kind, author_member_id) values ($1, 'post', $2) returning id`,
      [owner.club.id, author.id],
    );
    await h.sqlClubs(
      `insert into app.entity_versions (entity_id, version_no, state, title, body, created_by_member_id)
       values ($1, 1, 'published', 'Protected', 'Only author may remove', $2)`,
      [ent!.id, author.id],
    );

    const err = await h.apiErr(bystander.token, 'entities.remove', { entityId: ent!.id });
    assert.equal(err.status, 404);
  });

  it('double remove is idempotent', async () => {
    const owner = await h.seedOwner('entity-remove-idempotent', 'Entity Remove Idempotent Club');
    const author = await h.seedClubMember(owner.club.id, 'Author Idempotent', 'author-idempotent-remove', { sponsorId: owner.id });

    const [ent] = await h.sqlClubs<{ id: string }>(
      `insert into app.entities (club_id, kind, author_member_id) values ($1, 'post', $2) returning id`,
      [owner.club.id, author.id],
    );
    await h.sqlClubs(
      `insert into app.entity_versions (entity_id, version_no, state, title, body, created_by_member_id)
       values ($1, 1, 'published', 'Idempotent', 'Body', $2)`,
      [ent!.id, author.id],
    );

    const first = await h.apiOk(author.token, 'entities.remove', { entityId: ent!.id });
    const second = await h.apiOk(author.token, 'entities.remove', { entityId: ent!.id });
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
      `insert into app.entities (club_id, kind, author_member_id) values ($1, 'post', $2) returning id`,
      [owner.club.id, author.id],
    );
    const [ver] = await h.sqlClubs<{ id: string }>(
      `insert into app.entity_versions (entity_id, version_no, state, title, body, created_by_member_id)
       values ($1, 1, 'published', 'Will remove', 'Content', $2) returning id`,
      [ent!.id, author.id],
    );
    await h.sqlClubs(
      `insert into app.activity (club_id, topic, entity_id, entity_version_id, created_by_member_id, payload)
       values ($1, 'entity.version.published', $2, $3, $4, '{"kind":"entity"}'::jsonb)`,
      [owner.club.id, ent!.id, ver!.id, author.id],
    );

    const beforeUpdates = await h.apiOk(viewer.token, 'updates.list', { after: seedAfter });
    const beforeItems = ((beforeUpdates.data as Record<string, unknown>).updates as Record<string, unknown>).items as Array<Record<string, unknown>>;
    assert.ok(beforeItems.some((u) => u.entityId === ent!.id), 'entity update should exist before removal');

    await h.apiOk(author.token, 'entities.remove', { entityId: ent!.id });

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

    const thread = await h.apiOk(alice.token, 'messages.read', { threadId });
    const messages = (thread.data as Record<string, unknown>).messages as Array<Record<string, unknown>>;
    const removedMsg = messages.find((m) => m.messageId === msgId);
    assert.ok(removedMsg);
    assert.equal(removedMsg.messageText, '[Message removed]');
  });

  it('non-sender cannot remove — 403', async () => {
    const owner = await h.seedOwner('msg-remove-forbidden', 'Msg Remove Forbidden Club');
    const alice = await h.seedClubMember(owner.club.id, 'Alice Forbidden', 'alice-forbidden-remove', { sponsorId: owner.id });
    const bob = await h.seedClubMember(owner.club.id, 'Bob Forbidden', 'bob-forbidden-remove', { sponsorId: owner.id });

    const sendResult = await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: 'Bob cannot remove this',
    });
    const msg = (sendResult.data as Record<string, unknown>).message as Record<string, unknown>;

    const err = await h.apiErr(bob.token, 'messages.remove', { messageId: msg.messageId as string });
    assert.equal(err.status, 403);
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

describe('clubadmin.entities.remove', () => {
  it('club admin removes any entity with required reason', async () => {
    const owner = await h.seedOwner('admin-entity-remove', 'Admin Entity Remove Club');
    const author = await h.seedClubMember(owner.club.id, 'Author AdminRemove', 'author-admin-remove', { sponsorId: owner.id });

    const [ent] = await h.sqlClubs<{ id: string }>(
      `insert into app.entities (club_id, kind, author_member_id) values ($1, 'post', $2) returning id`,
      [owner.club.id, author.id],
    );
    await h.sqlClubs(
      `insert into app.entity_versions (entity_id, version_no, state, title, body, created_by_member_id)
       values ($1, 1, 'published', 'Admin removes this', 'Content', $2)`,
      [ent!.id, author.id],
    );

    const result = await h.apiOk(owner.token, 'clubadmin.entities.remove', {
      clubId: owner.club.id,
      entityId: ent!.id,
      reason: 'Violates community guidelines',
    });
    const e = entity(result);
    assert.equal((e.version as Record<string, unknown>).state, 'removed');
  });

  it('clubadmin.entities.remove without reason — 400', async () => {
    const owner = await h.seedOwner('admin-entity-no-reason', 'Admin Entity No Reason Club');
    const err = await h.apiErr(owner.token, 'clubadmin.entities.remove', {
      clubId: owner.club.id,
      entityId: 'fake-id',
    });
    assert.equal(err.status, 400);
  });

  it('superadmin calls clubadmin.entities.remove successfully', async () => {
    const admin = await h.seedSuperadmin('Admin EntityRemove', 'admin-entity-remove-super');
    const owner = await h.seedOwner('super-entity-remove', 'Super Entity Remove Club');

    const [ent] = await h.sqlClubs<{ id: string }>(
      `insert into app.entities (club_id, kind, author_member_id) values ($1, 'post', $2) returning id`,
      [owner.club.id, owner.id],
    );
    await h.sqlClubs(
      `insert into app.entity_versions (entity_id, version_no, state, title, body, created_by_member_id)
       values ($1, 1, 'published', 'Superadmin removes', 'Content', $2)`,
      [ent!.id, owner.id],
    );

    const result = await h.apiOk(admin.token, 'clubadmin.entities.remove', {
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
  it('clubadmin.entities.remove emits entity.removed in club activity', async () => {
    const owner = await h.seedOwner('mod-audit-entity', 'Mod Audit Entity Club');
    const author = await h.seedClubMember(owner.club.id, 'Author ModAudit', 'author-mod-audit', { sponsorId: owner.id });
    const viewer = await h.seedClubMember(owner.club.id, 'Viewer ModAudit', 'viewer-mod-audit', { sponsorId: owner.id });

    const [ent] = await h.sqlClubs<{ id: string }>(
      `insert into app.entities (club_id, kind, author_member_id) values ($1, 'post', $2) returning id`,
      [owner.club.id, author.id],
    );
    await h.sqlClubs(
      `insert into app.entity_versions (entity_id, version_no, state, title, body, created_by_member_id)
       values ($1, 1, 'published', 'Mod will remove', 'Body', $2)`,
      [ent!.id, author.id],
    );

    // Seed viewer's activity cursor so subsequent reads start from before the removal
    const seedResult = await h.apiOk(viewer.token, 'updates.list', {});
    const seedAfter = ((seedResult.data as Record<string, unknown>).updates as Record<string, unknown>).nextAfter as string;

    // Moderator removes
    await h.apiOk(owner.token, 'clubadmin.entities.remove', {
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

    const [ent] = await h.sqlClubs<{ id: string }>(
      `insert into app.entities (club_id, kind, author_member_id) values ($1, 'event', $2) returning id`,
      [owner.club.id, author.id],
    );
    await h.sqlClubs(
      `insert into app.entity_versions (entity_id, version_no, state, title, summary, location, starts_at, body, created_by_member_id)
       values ($1, 1, 'published', 'To Remove', 'An event', 'Online', now() + interval '1 day', 'Details', $2)`,
      [ent!.id, author.id],
    );

    const result = await h.apiOk(author.token, 'events.remove', { entityId: ent!.id });
    const ev = event(result);
    assert.equal(ev.entityId, ent!.id);
    assert.equal((ev.version as Record<string, unknown>).state, 'removed');

    const list = await h.apiOk(author.token, 'events.list', { clubId: owner.club.id });
    const items = (list.data as Record<string, unknown>).results as Array<Record<string, unknown>>;
    assert.ok(!items.find((i) => i.entityId === ent!.id), 'removed event should not appear in list');
  });
});

describe('clubadmin.events.remove', () => {
  it('club admin removes any event with required reason', async () => {
    const owner = await h.seedOwner('admin-event-remove', 'Admin Event Remove Club');
    const author = await h.seedClubMember(owner.club.id, 'Author AdminEventRemove', 'author-admin-event-remove', { sponsorId: owner.id });

    const [ent] = await h.sqlClubs<{ id: string }>(
      `insert into app.entities (club_id, kind, author_member_id) values ($1, 'event', $2) returning id`,
      [owner.club.id, author.id],
    );
    await h.sqlClubs(
      `insert into app.entity_versions (entity_id, version_no, state, title, summary, location, starts_at, body, created_by_member_id)
       values ($1, 1, 'published', 'Admin Removes Event', 'Summary', 'Venue', now() + interval '1 day', 'Details', $2)`,
      [ent!.id, author.id],
    );

    const result = await h.apiOk(owner.token, 'clubadmin.events.remove', {
      clubId: owner.club.id,
      entityId: ent!.id,
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

    const [ent] = await h.sqlClubs<{ id: string }>(
      `insert into app.entities (club_id, kind, author_member_id) values ($1, 'event', $2) returning id`,
      [owner.club.id, author.id],
    );
    await h.sqlClubs(
      `insert into app.entity_versions (entity_id, version_no, state, title, summary, location, starts_at, body, created_by_member_id)
       values ($1, 1, 'published', 'RSVP Test Event', 'Summary', 'Online', now() + interval '1 day', 'Body', $2)`,
      [ent!.id, author.id],
    );

    // Remove the event
    await h.apiOk(author.token, 'events.remove', { entityId: ent!.id });

    // Try to RSVP — should fail
    const err = await h.apiErr(attendee.token, 'events.rsvp', {
      eventEntityId: ent!.id,
      response: 'yes',
    });
    assert.equal(err.status, 404);
  });
});
