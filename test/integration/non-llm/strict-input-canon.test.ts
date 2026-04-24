import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from '../harness.ts';
import { passthroughGate } from '../../unit/fixtures.ts';

let h: TestHarness;

before(async () => {
  h = await TestHarness.start({ llmGate: passthroughGate });
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

function assertInvalidInputIssue(
  response: { status: number; body: Record<string, unknown> },
  expectedPath: string[],
  expectedKey: string,
): void {
  assert.equal(response.status, 400);
  assert.equal(response.body.ok, false);

  const error = response.body.error as Record<string, unknown>;
  assert.equal(error.code, 'invalid_input');
  assert.match(String(error.message), new RegExp(expectedKey));

  const details = error.details as Record<string, unknown>;
  const issues = details.issues as Array<Record<string, unknown>>;
  const issue = issues.find((candidate) => {
    return candidate.code === 'unrecognized_keys'
      && JSON.stringify(candidate.path) === JSON.stringify(expectedPath);
  });
  assert.ok(issue, `expected unrecognized_keys at ${expectedPath.join('.')}; got ${JSON.stringify(issues)}`);
  assert.deepEqual(issue.keys, [expectedKey]);
}

describe('recursive strict action input canon', () => {
  it('rejects unknown keys inside updates.list activity slice', async () => {
    const owner = await h.seedOwner('strict-updates-activity', 'Strict Updates Activity');

    const response = await h.api(owner.token, 'updates.list', {
      activity: {
        limit: 20,
        extraneous: 'x',
      },
    });

    assertInvalidInputIssue(response, ['activity'], 'extraneous');
  });

  it('rejects unknown keys inside updates.list inbox slice', async () => {
    const owner = await h.seedOwner('strict-updates-inbox', 'Strict Updates Inbox');

    const response = await h.api(owner.token, 'updates.list', {
      inbox: {
        unreadOnly: false,
        typo: true,
      },
    });

    assertInvalidInputIssue(response, ['inbox'], 'typo');
  });

  it('rejects unknown keys inside non-updates nested input objects', async () => {
    const owner = await h.seedOwner('strict-clubadmin-patch', 'Strict Clubadmin Patch');
    const member = await h.seedCompedMember(owner.club.id, 'Strict Patch Member');

    const response = await h.api(owner.token, 'clubadmin.members.update', {
      clubId: owner.club.id,
      memberId: member.id,
      patch: {
        role: 'member',
        typo: true,
      },
    });

    assertInvalidInputIssue(response, ['patch'], 'typo');
  });
});
