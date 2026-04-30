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

async function insertActivity(clubId: string, memberId: string, topic: string): Promise<number> {
  const [row] = await h.sql<{ seq: string }>(
    `insert into club_activity (club_id, topic, payload, created_by_member_id)
     values ($1::short_id, $2, '{}'::jsonb, $3::short_id)
     returning seq::text`,
    [clubId, topic, memberId],
  );
  return Number(row?.seq);
}

describe('/stream Last-Event-ID replay', () => {
  it('emits missed seed activity before the ready frame on reconnect', async () => {
    const owner = await h.seedOwner('stream-last-event-id', 'Stream Last Event ID');
    const member = await h.seedCompedMember(owner.club.id, 'Stream Replay Member');

    const firstStream = h.connectStream(member.token, { after: 'latest' });
    let lastEventId: string;
    try {
      await firstStream.waitForEvents(1);
      assert.equal(firstStream.events[0]?.event, 'ready');
      lastEventId = firstStream.events[0]?.id ?? '';
      assert.match(lastEventId, /^a\d+:i\d+$/);
    } finally {
      firstStream.close();
    }

    const missedSeq = await insertActivity(owner.club.id, owner.id, 'test.stream_replay_missed');

    const replayStream = h.connectStream(member.token, { lastEventId });
    try {
      await replayStream.waitForEvents(2);
      const [activity, ready] = replayStream.events;

      assert.equal(activity?.event, 'activity');
      assert.equal(activity?.id, `a${missedSeq}:i0`);
      assert.equal((activity?.data as Record<string, unknown>).topic, 'test.stream_replay_missed');
      assert.equal(ready?.event, 'ready');
      assert.equal(ready?.id, `a${missedSeq}:i0`);
    } finally {
      replayStream.close();
    }
  });

  it('emits missed DM seed frames before ready on reconnect', async () => {
    const owner = await h.seedOwner('stream-dm-replay', 'Stream DM Replay');
    const member = await h.seedCompedMember(owner.club.id, 'Stream DM Member');

    const firstStream = h.connectStream(member.token, { after: 'latest' });
    let lastEventId: string;
    try {
      await firstStream.waitForEvents(1);
      assert.equal(firstStream.events[0]?.event, 'ready');
      lastEventId = firstStream.events[0]?.id ?? '';
      assert.match(lastEventId, /^a\d+:i\d+$/);
    } finally {
      firstStream.close();
    }

    const sent = await h.apiOk(owner.token, 'messages.send', {
      recipientMemberId: member.id,
      messageText: 'Missed while disconnected',
    });
    const sentMessage = (sent.data as Record<string, unknown>).message as Record<string, unknown>;

    const replayStream = h.connectStream(member.token, { lastEventId });
    try {
      await replayStream.waitForEvents(2);
      const [message, ready] = replayStream.events;

      assert.equal(message?.event, 'message');
      assert.match(message?.id ?? '', /^a\d+:i\d+$/);
      const messages = message?.data.messages as Array<Record<string, unknown>>;
      assert.equal(messages[0]?.messageId, sentMessage.messageId);
      assert.equal(messages[0]?.messageText, 'Missed while disconnected');
      assert.equal(ready?.event, 'ready');
      assert.equal(ready?.id, message?.id);
    } finally {
      replayStream.close();
    }
  });

  it('does not let seed activity ids skip unseen DM frames', async () => {
    const owner = await h.seedOwner('stream-seed-race', 'Stream Seed Race');
    const member = await h.seedCompedMember(owner.club.id, 'Stream Seed Race Member');

    const firstStream = h.connectStream(member.token, { after: 'latest' });
    let baselineId: string;
    try {
      await firstStream.waitForEvents(1);
      assert.equal(firstStream.events[0]?.event, 'ready');
      baselineId = firstStream.events[0]?.id ?? '';
      assert.match(baselineId, /^a\d+:i\d+$/);
    } finally {
      firstStream.close();
    }

    const missedSeq = await insertActivity(owner.club.id, owner.id, 'test.stream_seed_race_activity');
    const sent = await h.apiOk(owner.token, 'messages.send', {
      recipientMemberId: member.id,
      messageText: 'Seed race message',
    });
    const sentMessage = (sent.data as Record<string, unknown>).message as Record<string, unknown>;

    const seedStream = h.connectStream(member.token, { lastEventId: baselineId });
    let activityId: string;
    try {
      await seedStream.waitForEvents(1);
      const [activity] = seedStream.events;
      assert.equal(activity?.event, 'activity');
      activityId = activity?.id ?? '';
      assert.match(activityId, new RegExp(`^a${missedSeq}:i\\d+$`));
    } finally {
      seedStream.close();
    }

    const resumed = h.connectStream(member.token, { lastEventId: activityId });
    try {
      await resumed.waitForEvents(2);
      const [message, ready] = resumed.events;

      assert.equal(message?.event, 'message');
      const messages = message?.data.messages as Array<Record<string, unknown>>;
      assert.equal(messages[0]?.messageId, sentMessage.messageId);
      assert.equal(messages[0]?.messageText, 'Seed race message');
      assert.equal(ready?.event, 'ready');
      assert.equal(ready?.id, message?.id);
    } finally {
      resumed.close();
    }
  });

  it('rejects malformed Last-Event-ID values', async () => {
    const owner = await h.seedOwner('stream-bad-last-event-id', 'Stream Bad Last Event ID');
    const response = await fetch(`http://127.0.0.1:${h.port}/stream`, {
      headers: {
        authorization: `Bearer ${owner.token}`,
        'last-event-id': 'not-a-stream-cursor',
      },
    });
    assert.equal(response.status, 400);
    const body = await response.json() as { error?: { code?: string } };
    assert.equal(body.error?.code, 'invalid_input');
  });
});
