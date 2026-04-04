/**
 * Integration tests for the redaction system.
 *
 * Covers: messages.redact, entities.redact, admin.messages.redact,
 * admin.content.redact. Verifies immutable append-only redaction,
 * content blanking in read paths, and updates-feed filtering.
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

// ── Helper ─────────────────────────────────────────────────────────────────────

function redaction(result: Record<string, unknown>) {
  return (result.data as Record<string, unknown>).redaction as Record<string, unknown>;
}

// ── Message Redaction ──────────────────────────────────────────────────────────

describe('messages.redact', () => {
  it('sender redacts own message — thread shows placeholder', async () => {
    const owner = await h.seedOwner('msg-redact-sender', 'Msg Redact Sender Club');
    const alice = await h.seedClubMember(owner.club.id, 'Alice MsgRedact', 'alice-msg-redact', { sponsorId: owner.id });
    const bob = await h.seedClubMember(owner.club.id, 'Bob MsgRedact', 'bob-msg-redact', { sponsorId: owner.id });

    // Alice sends a message to Bob
    const sendResult = await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: 'This is a secret message',
    });
    const messageId = (sendResult.data as Record<string, unknown>).message as Record<string, unknown>;
    const msgId = messageId.messageId as string;
    const threadId = messageId.threadId as string;

    // Alice redacts her own message
    const result = await h.apiOk(alice.token, 'messages.redact', {
      messageId: msgId,
      reason: 'Sent in error',
    });
    const r = redaction(result);
    assert.ok(r.redactionId);
    assert.equal(r.targetKind, 'dm_message');
    assert.equal(r.targetId, msgId);

    // Read the thread — message text should be replaced
    const thread = await h.apiOk(alice.token, 'messages.read', { threadId });
    const messages = (thread.data as Record<string, unknown>).messages as Array<Record<string, unknown>>;
    const redactedMsg = messages.find((m) => m.messageId === msgId);
    assert.ok(redactedMsg);
    assert.equal(redactedMsg.messageText, '[Message redacted]');
  });

  it('club owner redacts a member message', async () => {
    const owner = await h.seedOwner('msg-redact-owner', 'Msg Redact Owner Club');
    const member = await h.seedClubMember(owner.club.id, 'Member MsgRedact', 'member-msg-redact-owner', { sponsorId: owner.id });

    const sendResult = await h.apiOk(member.token, 'messages.send', {
      recipientMemberId: owner.id,
      messageText: 'Inappropriate content',
    });
    const msg = (sendResult.data as Record<string, unknown>).message as Record<string, unknown>;

    // Owner redacts the member's message
    const result = await h.apiOk(owner.token, 'messages.redact', {
      messageId: msg.messageId as string,
    });
    const r = redaction(result);
    assert.equal(r.targetKind, 'dm_message');
  });

  it('non-sender non-owner cannot redact another member message — 403', async () => {
    const owner = await h.seedOwner('msg-redact-forbidden', 'Msg Redact Forbidden Club');
    const alice = await h.seedClubMember(owner.club.id, 'Alice Forbidden', 'alice-forbidden-redact', { sponsorId: owner.id });
    const bob = await h.seedClubMember(owner.club.id, 'Bob Forbidden', 'bob-forbidden-redact', { sponsorId: owner.id });

    // Owner sends a message to Alice
    const sendResult = await h.apiOk(owner.token, 'messages.send', {
      recipientMemberId: alice.id,
      messageText: 'Owner says hello',
    });
    const msg = (sendResult.data as Record<string, unknown>).message as Record<string, unknown>;

    // Bob (not a participant) tries to redact — 404 (RLS hides the message)
    const err = await h.apiErr(bob.token, 'messages.redact', {
      messageId: msg.messageId as string,
    });
    assert.equal(err.status, 404);
  });

  it('redacted message disappears from updates feed', async () => {
    const owner = await h.seedOwner('msg-redact-updates', 'Msg Redact Updates Club');
    const alice = await h.seedClubMember(owner.club.id, 'Alice Updates', 'alice-updates-redact', { sponsorId: owner.id });
    const bob = await h.seedClubMember(owner.club.id, 'Bob Updates', 'bob-updates-redact', { sponsorId: owner.id });

    // Alice sends a message to Bob — creates a pending update for Bob
    const sendResult = await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: 'Will be redacted',
    });
    const msg = (sendResult.data as Record<string, unknown>).message as Record<string, unknown>;

    // Verify update exists before redaction
    const beforeUpdates = await h.apiOk(bob.token, 'updates.list', {});
    const beforeItems = ((beforeUpdates.data as Record<string, unknown>).updates as Record<string, unknown>).items as Array<Record<string, unknown>>;
    const dmUpdateBefore = beforeItems.find((u) => u.topic === 'dm.message.created');
    assert.ok(dmUpdateBefore, 'update should exist before redaction');

    // Redact the message
    await h.apiOk(alice.token, 'messages.redact', { messageId: msg.messageId as string });

    // Check updates — the dm.message.created update should be gone, replaced by dm.message.redacted
    const afterUpdates = await h.apiOk(bob.token, 'updates.list', {});
    const afterItems = ((afterUpdates.data as Record<string, unknown>).updates as Record<string, unknown>).items as Array<Record<string, unknown>>;
    const dmUpdateAfter = afterItems.find((u) => u.topic === 'dm.message.created');
    assert.ok(!dmUpdateAfter, 'dm.message.created update should be filtered after redaction');
    const redactedUpdate = afterItems.find((u) => u.topic === 'dm.message.redacted');
    assert.ok(redactedUpdate, 'dm.message.redacted update should be present');
  });

  it('double redact is idempotent', async () => {
    const owner = await h.seedOwner('msg-redact-idempotent', 'Msg Redact Idempotent Club');
    const alice = await h.seedClubMember(owner.club.id, 'Alice Idempotent', 'alice-idempotent-redact', { sponsorId: owner.id });
    const bob = await h.seedClubMember(owner.club.id, 'Bob Idempotent', 'bob-idempotent-redact', { sponsorId: owner.id });

    const sendResult = await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: bob.id,
      messageText: 'Redact me twice',
    });
    const msg = (sendResult.data as Record<string, unknown>).message as Record<string, unknown>;

    const first = await h.apiOk(alice.token, 'messages.redact', { messageId: msg.messageId as string });
    const second = await h.apiOk(alice.token, 'messages.redact', { messageId: msg.messageId as string });

    assert.equal(redaction(first).redactionId, redaction(second).redactionId);
  });
});

// ── Entity Redaction ───────────────────────────────────────────────────────────

describe('entities.redact', () => {
  it('author redacts own post — listing excludes it', async () => {
    const owner = await h.seedOwner('entity-redact-author', 'Entity Redact Author Club');
    const author = await h.seedClubMember(owner.club.id, 'Author EntityRedact', 'author-entity-redact', { sponsorId: owner.id });

    // Create the entity via SQL (bypasses LLM gate)
    const [entity] = await h.sql<{ id: string }>(
      `insert into app.entities (club_id, kind, author_member_id) values ($1, 'post', $2) returning id`,
      [owner.club.id, author.id],
    );
    await h.sql(
      `insert into app.entity_versions (entity_id, version_no, state, title, body, created_by_member_id)
       values ($1, 1, 'published', 'Sensitive post', 'This should be redacted', $2)`,
      [entity!.id, author.id],
    );

    // Author redacts it
    const result = await h.apiOk(author.token, 'entities.redact', {
      entityId: entity!.id,
    });
    const r = redaction(result);
    assert.equal(r.targetKind, 'entity');
    assert.equal(r.targetId, entity!.id);

    // Entity should not appear in listings
    const list = await h.apiOk(author.token, 'entities.list', { clubId: owner.club.id });
    const items = (list.data as Record<string, unknown>).results as Array<Record<string, unknown>>;
    const found = items.find((e) => e.entityId === entity!.id);
    assert.ok(!found, 'redacted entity should not appear in listings');
  });

  it('club owner redacts a member post', async () => {
    const owner = await h.seedOwner('entity-redact-owner', 'Entity Redact Owner Club');
    const author = await h.seedClubMember(owner.club.id, 'Author OwnerRedact', 'author-owner-redact', { sponsorId: owner.id });

    const [entity] = await h.sql<{ id: string }>(
      `insert into app.entities (club_id, kind, author_member_id) values ($1, 'post', $2) returning id`,
      [owner.club.id, author.id],
    );
    await h.sql(
      `insert into app.entity_versions (entity_id, version_no, state, title, body, created_by_member_id)
       values ($1, 1, 'published', 'Bad post', 'Owner will redact this', $2)`,
      [entity!.id, author.id],
    );

    const result = await h.apiOk(owner.token, 'entities.redact', {
      entityId: entity!.id,
    });
    const r = redaction(result);
    assert.equal(r.targetKind, 'entity');
  });

  it('non-author non-owner cannot redact — 403', async () => {
    const owner = await h.seedOwner('entity-redact-forbidden', 'Entity Redact Forbidden Club');
    const author = await h.seedClubMember(owner.club.id, 'Author Forbidden', 'author-forbidden-entity', { sponsorId: owner.id });
    const bystander = await h.seedClubMember(owner.club.id, 'Bystander', 'bystander-entity-redact', { sponsorId: owner.id });

    const [entity] = await h.sql<{ id: string }>(
      `insert into app.entities (club_id, kind, author_member_id) values ($1, 'post', $2) returning id`,
      [owner.club.id, author.id],
    );
    await h.sql(
      `insert into app.entity_versions (entity_id, version_no, state, title, body, created_by_member_id)
       values ($1, 1, 'published', 'Protected post', 'Only author/owner may redact', $2)`,
      [entity!.id, author.id],
    );

    const err = await h.apiErr(bystander.token, 'entities.redact', {
      entityId: entity!.id,
    });
    assert.equal(err.status, 403);
    assert.equal(err.code, 'forbidden');
  });

  it('redacted entity filtered from updates feed', async () => {
    const owner = await h.seedOwner('entity-redact-updates', 'Entity Redact Updates Club');
    const author = await h.seedClubMember(owner.club.id, 'Author Updates', 'author-updates-redact', { sponsorId: owner.id });
    const viewer = await h.seedClubMember(owner.club.id, 'Viewer Updates', 'viewer-updates-redact', { sponsorId: owner.id });

    // Create entity + version + fan out updates (simulates entity.create)
    const [entity] = await h.sql<{ id: string }>(
      `insert into app.entities (club_id, kind, author_member_id) values ($1, 'post', $2) returning id`,
      [owner.club.id, author.id],
    );
    const [version] = await h.sql<{ id: string }>(
      `insert into app.entity_versions (entity_id, version_no, state, title, body, created_by_member_id)
       values ($1, 1, 'published', 'Will redact', 'Content', $2) returning id`,
      [entity!.id, author.id],
    );
    // Insert update for the viewer
    await h.sql(
      `insert into app.member_updates (recipient_member_id, club_id, topic, entity_id, entity_version_id, created_by_member_id, payload)
       values ($1, $2, 'entity.version.published', $3, $4, $5, '{"kind":"entity"}'::jsonb)`,
      [viewer.id, owner.club.id, entity!.id, version!.id, author.id],
    );

    // Verify update exists
    const before = await h.apiOk(viewer.token, 'updates.list', {});
    const beforeItems = ((before.data as Record<string, unknown>).updates as Record<string, unknown>).items as Array<Record<string, unknown>>;
    assert.ok(beforeItems.some((u) => u.entityId === entity!.id), 'entity update should exist before redaction');

    // Redact the entity
    await h.apiOk(author.token, 'entities.redact', { entityId: entity!.id });

    // Update should be filtered
    const after = await h.apiOk(viewer.token, 'updates.list', {});
    const afterItems = ((after.data as Record<string, unknown>).updates as Record<string, unknown>).items as Array<Record<string, unknown>>;
    assert.ok(!afterItems.some((u) => u.entityId === entity!.id), 'entity update should be filtered after redaction');
    assert.ok(afterItems.some((u) => u.topic === 'entity.redacted'), 'entity.redacted update should be present');
  });
});

// ── Admin Redaction ────────────────────────────────────────────────────────────

describe('admin redaction', () => {
  it('admin.messages.redact — superadmin redacts any message', async () => {
    const admin = await h.seedSuperadmin('Admin MsgRedact', 'admin-msg-redact');
    const owner = await h.seedOwner('admin-msg-redact-club', 'Admin Msg Redact Club');
    const alice = await h.seedClubMember(owner.club.id, 'Alice Admin', 'alice-admin-msg-redact', { sponsorId: owner.id });

    const sendResult = await h.apiOk(alice.token, 'messages.send', {
      recipientMemberId: owner.id,
      messageText: 'Admin will redact this',
    });
    const msg = (sendResult.data as Record<string, unknown>).message as Record<string, unknown>;

    const result = await h.apiOk(admin.token, 'admin.messages.redact', {
      messageId: msg.messageId as string,
    });
    const r = redaction(result);
    assert.equal(r.targetKind, 'dm_message');
  });

  it('admin.content.redact — superadmin redacts any entity', async () => {
    const admin = await h.seedSuperadmin('Admin EntityRedact', 'admin-entity-redact');
    const owner = await h.seedOwner('admin-entity-redact-club', 'Admin Entity Redact Club');

    const [entity] = await h.sql<{ id: string }>(
      `insert into app.entities (club_id, kind, author_member_id) values ($1, 'post', $2) returning id`,
      [owner.club.id, owner.id],
    );
    await h.sql(
      `insert into app.entity_versions (entity_id, version_no, state, title, body, created_by_member_id)
       values ($1, 1, 'published', 'Admin redacts this', 'Content', $2)`,
      [entity!.id, owner.id],
    );

    const result = await h.apiOk(admin.token, 'admin.content.redact', {
      entityId: entity!.id,
    });
    const r = redaction(result);
    assert.equal(r.targetKind, 'entity');
  });
});
