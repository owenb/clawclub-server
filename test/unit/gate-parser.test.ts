import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdict } from '../../src/gate.ts';

describe('parseVerdict', () => {
  it('accepts exact PASS', () => {
    assert.deepEqual(parseVerdict('PASS'), { status: 'passed' });
  });

  it('accepts pass case-insensitively with trim', () => {
    assert.deepEqual(parseVerdict('  pass  '), { status: 'passed' });
  });

  it('treats PASS with trailing text as malformed', () => {
    assert.deepEqual(parseVerdict('PASS\nextra text'), {
      status: 'rejected_malformed',
      feedback: 'PASS\nextra text',
    });
  });

  it('parses ILLEGAL with separator variants', () => {
    assert.deepEqual(parseVerdict('ILLEGAL: specific reason'), {
      status: 'rejected_illegal',
      feedback: 'specific reason',
    });
    assert.deepEqual(parseVerdict('ILLEGAL; specific reason'), {
      status: 'rejected_illegal',
      feedback: 'specific reason',
    });
    assert.deepEqual(parseVerdict('ILLEGAL - specific reason'), {
      status: 'rejected_illegal',
      feedback: 'specific reason',
    });
    assert.deepEqual(parseVerdict('ILLEGAL — specific reason'), {
      status: 'rejected_illegal',
      feedback: 'specific reason',
    });
  });

  it('parses FAIL with separator variants', () => {
    assert.deepEqual(parseVerdict('FAIL: specific reason'), {
      status: 'rejected_quality',
      feedback: 'specific reason',
    });
    assert.deepEqual(parseVerdict('FAIL; specific reason'), {
      status: 'rejected_quality',
      feedback: 'specific reason',
    });
    assert.deepEqual(parseVerdict('FAIL - specific reason'), {
      status: 'rejected_quality',
      feedback: 'specific reason',
    });
    assert.deepEqual(parseVerdict('FAIL – specific reason'), {
      status: 'rejected_quality',
      feedback: 'specific reason',
    });
  });

  it('captures multiline feedback verbatim', () => {
    assert.deepEqual(parseVerdict('FAIL: first line\nsecond line'), {
      status: 'rejected_quality',
      feedback: 'first line\nsecond line',
    });
  });

  it('treats bare ILLEGAL and FAIL as malformed', () => {
    assert.deepEqual(parseVerdict('ILLEGAL'), {
      status: 'rejected_malformed',
      feedback: 'ILLEGAL',
    });
    assert.deepEqual(parseVerdict('FAIL'), {
      status: 'rejected_malformed',
      feedback: 'FAIL',
    });
  });

  it('treats empty feedback after the separator as malformed', () => {
    assert.deepEqual(parseVerdict('ILLEGAL:    '), {
      status: 'rejected_malformed',
      feedback: 'ILLEGAL:',
    });
    assert.deepEqual(parseVerdict('FAIL:   '), {
      status: 'rejected_malformed',
      feedback: 'FAIL:',
    });
  });

  it('does not match lookalike prefixes', () => {
    assert.deepEqual(parseVerdict('ILLEGALITY is hard to define'), {
      status: 'rejected_malformed',
      feedback: 'ILLEGALITY is hard to define',
    });
    assert.deepEqual(parseVerdict('illegal content: discussion only'), {
      status: 'rejected_malformed',
      feedback: 'illegal content: discussion only',
    });
  });
});
