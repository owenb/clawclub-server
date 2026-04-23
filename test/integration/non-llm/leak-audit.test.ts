import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getRegistry } from '../../../src/schemas/registry.ts';
import { TestHarness, type LeakAuditContext } from '../harness.ts';
import { passthroughGate } from '../../unit/fixtures.ts';
import { LEAK_AUDIT_FIXTURES } from './leak-audit-fixtures.ts';

let h: TestHarness;
let ctx: LeakAuditContext;

const FORBIDDEN_FIELD_SET = new Set([
  'applicationText',
  'applicationEmail',
  'applicationName',
  'applicationSocials',
  'proofKind',
  'submissionPath',
  'generatedProfileDraft',
]);

function findForbiddenFields(value: unknown, forbidden: Set<string>, path = ''): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findForbiddenFields(item, forbidden, `${path}[${index}]`));
  }
  if (!value || typeof value !== 'object') {
    return [];
  }

  const obj = value as Record<string, unknown>;
  const leaks: string[] = [];
  for (const [key, child] of Object.entries(obj)) {
    const childPath = path ? `${path}.${key}` : key;
    if (forbidden.has(key)) {
      leaks.push(childPath);
    }
    leaks.push(...findForbiddenFields(child, forbidden, childPath));
  }
  return leaks;
}

before(async () => {
  h = await TestHarness.start({ llmGate: passthroughGate });
  ctx = await h.seedLeakAuditScenario();
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

describe('leak audit: regular members never see application content', () => {
  it('every member-callable read action has a fixture and no leak', async () => {
    const actions = [...getRegistry().values()]
      .filter((action) => (action.auth === 'member' || action.auth === 'optional_member') && action.safety === 'read_only')
      .map((action) => action.action)
      .sort();

    const missingFixtures = actions.filter((action) => !(action in LEAK_AUDIT_FIXTURES));
    assert.deepEqual(
      missingFixtures,
      [],
      `These member-callable read actions have no leak-audit fixture: ${missingFixtures.join(', ')}`,
    );

    for (const action of actions) {
      const fixture = LEAK_AUDIT_FIXTURES[action]!;
      const response = await h.apiOk(ctx.regularMember.token, action, fixture.buildInput(ctx));
      if (fixture.skipResponseWalk) continue;

      const leaks = findForbiddenFields(response, FORBIDDEN_FIELD_SET);
      assert.deepEqual(
        leaks,
        [],
        `Action ${action} leaked application content at paths: ${leaks.join(', ')}`,
      );
    }
  });
});
