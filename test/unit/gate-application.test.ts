import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseApplicationVerdict } from '../../src/gate.ts';

describe('parseApplicationVerdict', () => {
  it('accepts exact PASS', () => {
    assert.deepEqual(parseApplicationVerdict('PASS'), { status: 'passed' });
  });

  it('accepts pass case-insensitively with trim', () => {
    assert.deepEqual(parseApplicationVerdict('  pass  '), { status: 'passed' });
  });

  it('treats plain missing-item feedback as revision guidance', () => {
    assert.deepEqual(parseApplicationVerdict('Missing: the city you are in.'), {
      status: 'needs_revision',
      feedback: 'Missing: the city you are in.',
    });
  });

  it('treats protocol-shaped non-PASS output as malformed', () => {
    assert.deepEqual(parseApplicationVerdict('PASS\nextra text'), {
      status: 'rejected_malformed',
      feedback: 'PASS\nextra text',
    });
    assert.deepEqual(parseApplicationVerdict('FAIL: missing your city'), {
      status: 'rejected_malformed',
      feedback: 'FAIL: missing your city',
    });
    assert.deepEqual(parseApplicationVerdict('ILLEGAL: nope'), {
      status: 'rejected_malformed',
      feedback: 'ILLEGAL: nope',
    });
  });

  it('treats empty output as malformed', () => {
    assert.deepEqual(parseApplicationVerdict('   '), {
      status: 'rejected_malformed',
      feedback: '',
    });
  });
});
