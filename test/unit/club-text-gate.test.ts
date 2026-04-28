import test from 'node:test';
import assert from 'node:assert/strict';
import { clubTextPatchSkipsGate } from '../../src/schemas/club-text.ts';

const current = {
  name: 'Builders Circle',
  summary: 'A club for builders.',
  admissionPolicy: 'Tell us what you build.',
};

test('clubTextPatchSkipsGate treats optional text clears as gate no-ops', () => {
  assert.equal(clubTextPatchSkipsGate(current, { summary: null }), true);
  assert.equal(clubTextPatchSkipsGate(current, { admissionPolicy: null }), true);
});

test('clubTextPatchSkipsGate still gates newly introduced club text', () => {
  assert.equal(clubTextPatchSkipsGate(current, { summary: 'A new summary.' }), false);
  assert.equal(clubTextPatchSkipsGate(current, { admissionPolicy: 'Answer these new questions.' }), false);
});

test('clubTextPatchSkipsGate gates mixed clear and new-text patches', () => {
  assert.equal(clubTextPatchSkipsGate(current, {
    summary: null,
    admissionPolicy: 'Answer these new questions.',
  }), false);
});

test('clubTextPatchSkipsGate preserves existing name-change behavior', () => {
  assert.equal(clubTextPatchSkipsGate(current, { name: 'New Builders Circle' }), false);
  assert.equal(clubTextPatchSkipsGate(current, { name: current.name }), true);
});

test('clubTextPatchSkipsGate treats empty and exact no-op patches as gate no-ops', () => {
  assert.equal(clubTextPatchSkipsGate(current, {}), true);
  assert.equal(clubTextPatchSkipsGate(current, {
    summary: current.summary,
    admissionPolicy: current.admissionPolicy,
  }), true);
});
