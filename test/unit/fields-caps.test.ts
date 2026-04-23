import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHumanRequiredString,
  parseIsoDatetime,
  parseOptionalRecord,
  parseRequiredString,
} from '../../src/schemas/fields.ts';

test('parseHumanRequiredString rejects human text above 2000 characters', () => {
  assert.throws(
    () => parseHumanRequiredString.parse('x'.repeat(2_001)),
    /Too big|2000/,
  );
});

test('parseRequiredString accepts opaque values up to 100000 characters', () => {
  const value = 'x'.repeat(100_000);
  assert.equal(parseRequiredString.parse(value), value);
});

test('parseRequiredString rejects opaque values above 100000 characters', () => {
  assert.throws(
    () => parseRequiredString.parse('x'.repeat(100_001)),
    /Too big|100000/,
  );
});

test('parseOptionalRecord rejects records with more than 50 keys', () => {
  const value = Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`key${index}`, index]));
  assert.throws(
    () => parseOptionalRecord.parse(value),
    /50 keys/,
  );
});

test('parseOptionalRecord measures UTF-8 bytes, not UTF-16 code units', () => {
  const value = { emoji: '😀'.repeat(1_000) };
  assert.throws(
    () => parseOptionalRecord.parse(value),
    /4000 bytes/,
  );
});

test('parseIsoDatetime accepts real-world UTC offsets', () => {
  assert.equal(parseIsoDatetime.parse('2025-01-01T10:00:00+14:00'), '2025-01-01T10:00:00+14:00');
  assert.equal(parseIsoDatetime.parse('2025-01-01T10:00:00-12:00'), '2025-01-01T10:00:00-12:00');
  assert.equal(parseIsoDatetime.parse('2025-01-01T10:00:00+00:00'), '2025-01-01T10:00:00+00:00');
  assert.equal(parseIsoDatetime.parse('2025-01-01T10:00:00Z'), '2025-01-01T10:00:00Z');
});

test('parseIsoDatetime rejects impossible dates and out-of-range UTC offsets', () => {
  for (const value of [
    '2025-01-01T10:00:00+25:00',
    '2025-01-01T10:00:00+99:99',
    '2025-01-01T10:00:00+14:59',
    '2025-01-01T10:00:00-12:01',
    '2025-13-01',
    '2025-01-32',
  ]) {
    assert.throws(
      () => parseIsoDatetime.parse(value),
      /valid ISO 8601 datetime|Invalid/,
      value,
    );
  }
});
