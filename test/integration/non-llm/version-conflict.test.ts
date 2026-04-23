import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from '../harness.ts';
import { passthroughGate } from '../../unit/fixtures.ts';

let h: TestHarness;

type ApiResult = Awaited<ReturnType<TestHarness['api']>>;

before(async () => {
  h = await TestHarness.start({ llmGate: passthroughGate });
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

function assertOneVersionConflict(results: [ApiResult, ApiResult]): ApiResult {
  const statuses = results.map((result) => result.status).sort((left, right) => left - right);
  assert.deepEqual(statuses, [200, 409]);

  const success = results.find((result) => result.status === 200);
  const conflict = results.find((result) => result.status === 409);
  assert.ok(success);
  assert.ok(conflict);
  assert.equal(success.body.ok, true);
  assert.equal(conflict.body.ok, false);
  assert.equal((conflict.body.error as Record<string, unknown>).code, 'version_conflict');
  assert.equal((conflict.body.error as Record<string, unknown>).message, 'This resource was modified concurrently. Retry.');
  return success;
}

async function withInsertDelay<T>(
  table: 'event_rsvps' | 'content_versions' | 'club_membership_state_versions' | 'member_club_profile_versions',
  run: () => Promise<T>,
): Promise<T> {
  const suffix = table.replace(/[^a-z0-9_]/g, '_');
  const functionName = `test_delay_${suffix}_insert`;
  const triggerName = `${functionName}_trigger`;
  await h.sql(
    `create or replace function ${functionName}() returns trigger
     language plpgsql
     as $$
     begin
       perform pg_sleep(0.2);
       return new;
     end;
     $$;`,
  );
  await h.sql(`drop trigger if exists ${triggerName} on ${table}`);
  await h.sql(
    `create trigger ${triggerName}
     before insert on ${table}
     for each row
     execute function ${functionName}()`,
  );

  try {
    return await run();
  } finally {
    await h.sql(`drop trigger if exists ${triggerName} on ${table}`);
    await h.sql(`drop function if exists ${functionName}()`);
  }
}

async function createPost(token: string, clubId: string, title: string): Promise<string> {
  const created = await h.apiOk(token, 'content.create', {
    clubId,
    kind: 'post',
    title,
    summary: `${title} summary`,
    body: `${title} body with enough detail to pass the content gate in tests.`,
  });
  return ((created.data as Record<string, unknown>).content as Record<string, unknown>).id as string;
}

async function createEvent(token: string, clubId: string, title: string): Promise<string> {
  const created = await h.apiOk(token, 'content.create', {
    clubId,
    kind: 'event',
    title,
    summary: `${title} summary`,
    body: `${title} body with enough detail to pass the content gate in tests.`,
    event: {
      location: 'London',
      startsAt: '2026-09-01T18:00:00Z',
      endsAt: '2026-09-01T20:00:00Z',
      timezone: 'Europe/London',
      recurrenceRule: null,
      capacity: 20,
    },
  });
  return ((created.data as Record<string, unknown>).content as Record<string, unknown>).id as string;
}

describe('version_conflict translations', () => {
  it('events.setRsvp returns version_conflict instead of a raw 500 on concurrent writes', async () => {
    const owner = await h.seedOwner('version-conflict-rsvp', 'Version Conflict RSVP');
    const attendee = await h.seedCompedMember(owner.club.id, 'Version Conflict Attendee');
    const eventId = await createEvent(owner.token, owner.club.id, 'Version Conflict Event');

    await withInsertDelay('event_rsvps', async () => {
      const results = await Promise.all([
        h.api(attendee.token, 'events.setRsvp', {
          eventId,
          response: 'yes',
          note: 'First RSVP path',
        }),
        h.api(attendee.token, 'events.setRsvp', {
          eventId,
          response: 'maybe',
          note: 'Second RSVP path',
        }),
      ]) as [ApiResult, ApiResult];

      assertOneVersionConflict(results);
    });

    const [current] = await h.sql<{ response: string; version_no: number }>(
      `select response::text as response, version_no
         from current_event_rsvps
        where event_content_id = $1
          and membership_id = $2`,
      [eventId, attendee.membership.id],
    );
    assert.ok(current);
    assert.ok(current.response === 'yes' || current.response === 'maybe');
    assert.equal(current.version_no, 1);
  });

  it('content.update returns version_conflict instead of a raw 500 on concurrent edits', async () => {
    const owner = await h.seedOwner('version-conflict-content', 'Version Conflict Content');
    const contentId = await createPost(owner.token, owner.club.id, 'Original Version Conflict Post');

    await withInsertDelay('content_versions', async () => {
      const results = await Promise.all([
        h.api(owner.token, 'content.update', {
          id: contentId,
          title: 'Concurrent Title A',
        }),
        h.api(owner.token, 'content.update', {
          id: contentId,
          title: 'Concurrent Title B',
        }),
      ]) as [ApiResult, ApiResult];

      assertOneVersionConflict(results);
    });

    const [current] = await h.sql<{ title: string; version_no: number }>(
      `select title, version_no
         from current_content_versions
        where content_id = $1`,
      [contentId],
    );
    assert.ok(current);
    assert.ok(current.title === 'Concurrent Title A' || current.title === 'Concurrent Title B');
    assert.equal(current.version_no, 2);
  });

  it('clubadmin.members.update returns version_conflict instead of a raw 500 on concurrent status transitions', async () => {
    const owner = await h.seedOwner('version-conflict-membership', 'Version Conflict Membership');
    const member = await h.seedCompedMember(owner.club.id, 'Version Conflict Member');

    await withInsertDelay('club_membership_state_versions', async () => {
      const results = await Promise.all([
        h.api(owner.token, 'clubadmin.members.update', {
          clubId: owner.club.id,
          memberId: member.id,
          patch: { status: 'cancelled', reason: 'Concurrent path A' },
        }),
        h.api(owner.token, 'clubadmin.members.update', {
          clubId: owner.club.id,
          memberId: member.id,
          patch: { status: 'removed', reason: 'Concurrent path B' },
        }),
      ]) as [ApiResult, ApiResult];

      assertOneVersionConflict(results);
    });

    const [current] = await h.sql<{ status: string; state_version_no: number }>(
      `select status::text as status, state_version_no
         from current_club_memberships
        where club_id = $1
          and member_id = $2`,
      [owner.club.id, member.id],
    );
    assert.ok(current);
    assert.ok(current.status === 'cancelled' || current.status === 'removed');
    assert.equal(current.state_version_no, 2);
  });

  it('members.updateProfile returns version_conflict instead of a raw 500 on concurrent profile edits', async () => {
    const owner = await h.seedOwner('version-conflict-profile', 'Version Conflict Profile');

    await withInsertDelay('member_club_profile_versions', async () => {
      const results = await Promise.all([
        h.api(owner.token, 'members.updateProfile', {
          clubId: owner.club.id,
          tagline: 'Concurrent profile tagline A',
        }),
        h.api(owner.token, 'members.updateProfile', {
          clubId: owner.club.id,
          tagline: 'Concurrent profile tagline B',
        }),
      ]) as [ApiResult, ApiResult];

      const success = assertOneVersionConflict(results);
      const profiles = (((success.body as Record<string, unknown>).data as Record<string, unknown>).profiles ??
        []) as Array<Record<string, unknown>>;
      const currentProfile = profiles.find((profile) =>
        ((profile.club as Record<string, unknown>).clubId ?? null) === owner.club.id
      );
      assert.ok(currentProfile);
      assert.ok(
        currentProfile.tagline === 'Concurrent profile tagline A'
          || currentProfile.tagline === 'Concurrent profile tagline B',
      );
    });

    const memberView = await h.apiOk(owner.token, 'members.get', {
      clubId: owner.club.id,
      memberId: owner.id,
    });
    const member = ((memberView.data as Record<string, unknown>).member ?? {}) as Record<string, unknown>;
    assert.ok(
      member.tagline === 'Concurrent profile tagline A'
        || member.tagline === 'Concurrent profile tagline B',
    );

    const [current] = await h.sql<{ version_no: number }>(
      `select version_no
         from current_member_club_profiles
        where member_id = $1
          and club_id = $2`,
      [owner.id, owner.club.id],
    );
    assert.ok(current);
    assert.equal(current.version_no, 2);
  });
});
