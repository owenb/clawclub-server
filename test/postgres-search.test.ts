import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/app.ts';
import { buildContainsLikePattern, buildPrefixLikePattern, normalizeSearchQuery } from '../src/postgres/search.ts';

test('postgres search helpers trim, bound, and escape query text', () => {
  assert.equal(normalizeSearchQuery('  trusted builder  '), 'trusted builder');
  assert.equal(normalizeSearchQuery('   '), null);
  assert.equal(buildContainsLikePattern('100%_safe\\query'), '%100\\%\\_safe\\\\query%');
  assert.equal(buildPrefixLikePattern('100%_safe\\query'), '100\\%\\_safe\\\\query%');

  assert.throws(
    () => normalizeSearchQuery('x'.repeat(121)),
    (error: unknown) => error instanceof AppError
      && error.code === 'invalid_input'
      && error.message === 'query must be 120 characters or fewer',
  );
});
