import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { checkLlmGate, type ApplicationGateVerdict } from '../../../src/gate.ts';
import { admissionGateFixtures } from '../../fixtures/admission-gate-fixtures.ts';

type FrozenAdmissionGateResult = {
  name: string;
  status: 'passed' | 'needs_revision';
  feedback?: string;
};

async function readFrozenResults(): Promise<Map<string, FrozenAdmissionGateResult>> {
  const raw = await readFile(resolve('test/snapshots/admission-gate-golden.json'), 'utf8');
  const parsed = JSON.parse(raw) as FrozenAdmissionGateResult[];
  return new Map(parsed.map((entry) => [entry.name, entry]));
}

async function runFixture(fixture: typeof admissionGateFixtures[number]): Promise<ApplicationGateVerdict> {
  const actual = await checkLlmGate({
    kind: 'application',
    club: fixture.club,
    applicant: fixture.applicant,
  });

  if (actual.status === 'skipped' || actual.status === 'failed' || actual.status === 'rejected_malformed') {
    assert.fail(`application gate unavailable for ${fixture.name}: ${actual.status}`);
  }

  return actual;
}

describe('admission gate frozen baseline (LLM)', () => {
  for (const fixture of admissionGateFixtures) {
    it(`matches the frozen verdict for ${fixture.name}`, async () => {
      const frozenResults = await readFrozenResults();
      const expected = frozenResults.get(fixture.name);
      assert.ok(expected, `missing frozen baseline for ${fixture.name}`);

      let actual = await runFixture(fixture);
      if (actual.status !== expected.status) {
        actual = await runFixture(fixture);
      }

      assert.equal(actual.status, expected.status);
      if (expected.status === 'needs_revision') {
        assert.ok(actual.feedback.trim().length > 0, `expected non-empty revision feedback for ${fixture.name}`);
      }
    });
  }
});
