import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHumanRequiredString,
  parseIsoDatetime,
  parseMessageText,
  parseOptionalRecord,
  parseOptionalPositiveInt,
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

test('parseRequiredString rejects C0 controls and DEL while allowing tab newline carriage return', () => {
  for (const value of ['bad\0text', 'bad\u0007text', 'bad\u001b[31mtext', 'bad\u007ftext']) {
    assert.throws(
      () => parseRequiredString.parse(value),
      /forbidden control characters|invalid UTF-8/,
      value,
    );
  }

  assert.equal(parseRequiredString.parse('tab\tnewline\ncarriage\rreturn'), 'tab\tnewline\ncarriage\rreturn');
});

test('parseRequiredString rejects unpaired UTF-16 surrogates', () => {
  for (const value of ['bad\uD800text', 'bad\uDC00text']) {
    assert.throws(
      () => parseRequiredString.parse(value),
      /forbidden control characters|invalid UTF-8/,
      value,
    );
  }

  assert.equal(parseRequiredString.parse('paired 😀 text'), 'paired 😀 text');
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

test('parseOptionalRecord rejects strings Postgres JSONB cannot store', () => {
  for (const value of [
    { bad: 'null\0byte' },
    { bad: 'lone high \uD800' },
    { bad: 'lone low \uDC00' },
  ]) {
    assert.throws(
      () => parseOptionalRecord.parse(value),
      /JSONB/,
      JSON.stringify(value),
    );
  }
});

test('parseOptionalPositiveInt rejects values above signed int32', () => {
  assert.equal(parseOptionalPositiveInt.parse(2_147_483_647), 2_147_483_647);
  assert.throws(
    () => parseOptionalPositiveInt.parse(2_147_483_648),
    /2147483647|Too big/,
  );
});

test('parseIsoDatetime accepts real-world UTC offsets', () => {
  assert.equal(parseIsoDatetime.parse('2025-01-01T10:00:00+14:00'), '2025-01-01T10:00:00+14:00');
  assert.equal(parseIsoDatetime.parse('2025-01-01T10:00:00-12:00'), '2025-01-01T10:00:00-12:00');
  assert.equal(parseIsoDatetime.parse('2025-01-01T10:00:00+00:00'), '2025-01-01T10:00:00+00:00');
  assert.equal(parseIsoDatetime.parse('2025-01-01T10:00:00Z'), '2025-01-01T10:00:00Z');
  assert.equal(parseIsoDatetime.parse('2025-01-01T10:00:00.123456Z'), '2025-01-01T10:00:00.123456Z');
});

test('parseIsoDatetime rejects date-only and timezone-less values', () => {
  for (const value of [
    '2025-01-01',
    '2025-01-01T10:00:00',
    '2025-01-01T10:00Z',
  ]) {
    assert.throws(
      () => parseIsoDatetime.parse(value),
      /valid ISO 8601 datetime|Invalid/,
      value,
    );
  }
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

test('parseMessageText rejects whitespace and zero-width-only messages', () => {
  for (const value of ['     ', '\u200b\u200c\u200d\ufeff']) {
    assert.throws(
      () => parseMessageText.parse(value),
      /visible non-whitespace/,
      value,
    );
  }
  assert.equal(parseMessageText.parse(' hi '), 'hi');
});
