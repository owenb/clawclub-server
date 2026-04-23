import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBearerToken, buildInvitationCode, normalizeInvitationCode, parseBearerToken } from '../../src/token.ts';

test('buildBearerToken emits clawclub_ tokens', () => {
  const token = buildBearerToken({
    tokenId: '23456789abcd',
    secret: '23456789abcdefghjkmnpqrs',
  });

  assert.equal(token.bearerToken, 'clawclub_23456789abcd_23456789abcdefghjkmnpqrs');
});

test('parseBearerToken accepts the current clawclub_ prefix', () => {
  assert.deepEqual(
    parseBearerToken('clawclub_23456789abcd_23456789abcdefghjkmnpqrs'),
    {
      tokenId: '23456789abcd',
      secret: '23456789abcdefghjkmnpqrs',
    },
  );
});

test('parseBearerToken accepts the legacy cc_live_ prefix', () => {
  assert.deepEqual(
    parseBearerToken('cc_live_23456789abcd_23456789abcdefghjkmnpqrs'),
    {
      tokenId: '23456789abcd',
      secret: '23456789abcdefghjkmnpqrs',
    },
  );
});

test('parseBearerToken rejects unknown prefixes', () => {
  assert.equal(
    parseBearerToken('wrongprefix_23456789abcd_23456789abcdefghjkmnpqrs'),
    null,
  );
});

test('buildInvitationCode emits short readable codes', () => {
  const code = buildInvitationCode();
  assert.match(code, /^[A-HJ-KM-NP-TV-Z2-9]{4}-[A-HJ-KM-NP-TV-Z2-9]{4}$/);
});

test('normalizeInvitationCode trims and uppercases mixed-case input', () => {
  assert.equal(normalizeInvitationCode('  7dk4-m9q2  '), '7DK4-M9Q2');
  assert.equal(normalizeInvitationCode('7DK4-M9Q2'), '7DK4-M9Q2');
  assert.equal(normalizeInvitationCode('bad-code'), null);
  assert.equal(normalizeInvitationCode('BADCODE'), null);
});
