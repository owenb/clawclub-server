import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseEmail,
  parseFutureIsoDatetime,
  parseLimitOf,
  parsePublicName,
  parseSlug,
} from '../../src/schemas/fields.ts';

test('parseLimitOf rejects out-of-range limits instead of clamping', () => {
  const schema = parseLimitOf(20, 50);

  assert.equal(schema.safeParse(undefined).success, true);
  assert.equal(schema.parse(undefined), 20);
  assert.equal(schema.parse(1), 1);
  assert.equal(schema.parse(50), 50);
  assert.equal(schema.safeParse(0).success, false);
  assert.equal(schema.safeParse(-1).success, false);
  assert.equal(schema.safeParse(51).success, false);
});

test('parseEmail rejects malformed addresses', () => {
  for (const value of ['@', 'a@b@c', 'foo@bar@baz', ' @ ']) {
    assert.equal(parseEmail.safeParse(value).success, false, value);
  }
  assert.equal(parseEmail.parse('  USER@example.COM '), 'user@example.com');
});

test('parseSlug caps slugs at the DNS label limit', () => {
  assert.equal(parseSlug.safeParse('a'.repeat(63)).success, true);
  assert.equal(parseSlug.safeParse('a'.repeat(64)).success, false);
});

test('parsePublicName caps display names at 120 chars', () => {
  assert.equal(parsePublicName.safeParse('A'.repeat(120)).success, true);
  assert.equal(parsePublicName.safeParse('A'.repeat(121)).success, false);
});

test('parseFutureIsoDatetime accepts null/omitted and rejects past or too-distant timestamps', () => {
  const oneHourFuture = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const oneHourPast = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const sixYearsFuture = new Date(Date.now() + 6 * 365 * 24 * 60 * 60 * 1000).toISOString();

  assert.equal(parseFutureIsoDatetime.parse(undefined), undefined);
  assert.equal(parseFutureIsoDatetime.parse(null), null);
  assert.equal(parseFutureIsoDatetime.parse(oneHourFuture), oneHourFuture);
  assert.equal(parseFutureIsoDatetime.safeParse(oneHourPast).success, false);
  assert.equal(parseFutureIsoDatetime.safeParse(sixYearsFuture).success, false);
});
