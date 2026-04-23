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
      assert.match(lastEventId, /^\d+$/);
    } finally {
      firstStream.close();
    }

    const missedSeq = await insertActivity(owner.club.id, owner.id, 'test.stream_replay_missed');

    const replayStream = h.connectStream(member.token, { lastEventId });
    try {
      await replayStream.waitForEvents(2);
      const [activity, ready] = replayStream.events;

      assert.equal(activity?.event, 'activity');
      assert.equal(activity?.id, String(missedSeq));
      assert.equal((activity?.data as Record<string, unknown>).topic, 'test.stream_replay_missed');
      assert.equal(ready?.event, 'ready');
      assert.equal(ready?.id, String(missedSeq));
    } finally {
      replayStream.close();
    }
  });
});
