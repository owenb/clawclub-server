import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeErrorCode } from '../../src/llm-errors.ts';

test('normalizeErrorCode prefers structured codes over echoed provider text', () => {
  const error = {
    code: 'bad_request',
    message: 'The provider echoed: hello alice@example.com',
  };

  assert.equal(normalizeErrorCode(error), 'bad_request');
});

test('normalizeErrorCode falls back to nested provider codes and types', () => {
  assert.equal(
    normalizeErrorCode({ error: { code: 'context_length_exceeded' } }),
    'context_length_exceeded',
  );
  assert.equal(
    normalizeErrorCode({ error: { type: 'server_error' } }),
    'server_error',
  );
});

test('normalizeErrorCode maps status-only failures to stable http_* codes', () => {
  assert.equal(normalizeErrorCode({ status: 503, message: 'temporary failure' }), 'http_503');
  assert.equal(normalizeErrorCode({ statusCode: 429, message: 'too many requests' }), 'http_429');
});

test('normalizeErrorCode returns unknown for nullish input', () => {
  assert.equal(normalizeErrorCode(null), 'unknown');
  assert.equal(normalizeErrorCode(undefined), 'unknown');
});

test('normalizeErrorCode falls back to non-default Error names', () => {
  assert.equal(normalizeErrorCode(new TypeError('x')), 'TypeError');
});
