import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseGateResponse } from '../../src/quality-gate.ts';

describe('parseGateResponse', () => {
  // ── PASS ──────────────────────────────────────────────

  it('accepts exact "PASS"', () => {
    assert.equal(parseGateResponse('PASS').status, 'passed');
  });

  it('accepts "pass" (case-insensitive)', () => {
    assert.equal(parseGateResponse('pass').status, 'passed');
  });

  it('does NOT treat "Passports are illegal" as a pass', () => {
    assert.notEqual(parseGateResponse('Passports and forged IDs are illegal activity.').status, 'passed');
  });

  it('does NOT treat "PASSED" as a pass', () => {
    assert.notEqual(parseGateResponse('PASSED').status, 'passed');
  });

  it('does NOT treat "PASS - not allowed" as a pass', () => {
    assert.notEqual(parseGateResponse('PASS - not allowed').status, 'passed');
  });

  it('does NOT treat "PASS\\nsolicts fraud" as a pass', () => {
    assert.notEqual(parseGateResponse('PASS\nsolicits fraud').status, 'passed');
  });

  // ── ILLEGAL ───────────────────────────────────────────

  it('parses "ILLEGAL: reason"', () => {
    const result = parseGateResponse('ILLEGAL: solicits forged documents');
    assert.equal(result.status, 'rejected_illegal');
    assert.equal((result as { feedback: string }).feedback, 'solicits forged documents');
  });

  it('parses "illegal: reason" (case-insensitive)', () => {
    assert.equal(parseGateResponse('illegal: drug trafficking').status, 'rejected_illegal');
  });

  it('parses "ILLEGAL - reason" (dash separator)', () => {
    const result = parseGateResponse('ILLEGAL - threats of violence');
    assert.equal(result.status, 'rejected_illegal');
    assert.equal((result as { feedback: string }).feedback, 'threats of violence');
  });

  it('parses "ILLEGAL; reason" (semicolon separator)', () => {
    assert.equal(parseGateResponse('ILLEGAL; fraud').status, 'rejected_illegal');
  });

  it('parses "Illegal" with em-dash separator', () => {
    assert.equal(parseGateResponse('Illegal — solicits violence').status, 'rejected_illegal');
  });

  it('does NOT match "ILLEGAL this solicits" (space only, no separator)', () => {
    const result = parseGateResponse('ILLEGAL this solicits violence');
    assert.equal(result.status, 'rejected');
  });

  it('parses bare "ILLEGAL" with no separator', () => {
    const result = parseGateResponse('ILLEGAL');
    assert.equal(result.status, 'rejected_illegal');
    assert.equal((result as { feedback: string }).feedback, 'Rejected for illegal content.');
  });

  it('provides default feedback when "ILLEGAL:" has empty explanation', () => {
    const result = parseGateResponse('ILLEGAL:');
    assert.equal(result.status, 'rejected_illegal');
    assert.equal((result as { feedback: string }).feedback, 'Rejected for illegal content.');
  });

  it('does NOT match "ILLEGALITY" as illegal', () => {
    const result = parseGateResponse('ILLEGALITY is hard to define here.');
    assert.equal(result.status, 'rejected');
  });

  it('does NOT match "illegal content:" as illegal', () => {
    const result = parseGateResponse('illegal content: this post discusses drugs');
    assert.equal(result.status, 'rejected');
  });

  // ── Plain rejection ───────────────────────────────────

  it('treats anything else as a plain rejection', () => {
    const result = parseGateResponse('Post needs a clearer point or takeaway.');
    assert.equal(result.status, 'rejected');
    assert.equal((result as { feedback: string }).feedback, 'Post needs a clearer point or takeaway.');
  });
});
