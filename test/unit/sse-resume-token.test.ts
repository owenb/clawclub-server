import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  composeStreamResumeId,
  parseRequiredStreamResumeId,
  parseStreamResumeId,
} from '../../src/sse-resume.ts';
import { encodeCursor } from '../../src/schemas/fields.ts';
import { AppError } from '../../src/errors.ts';

describe('SSE stream resume tokens', () => {
  it('composes and parses composite activity/inbox cursors', () => {
    assert.equal(composeStreamResumeId(5, 3), 'a5:i3');
    assert.deepEqual(parseStreamResumeId('a5:i3'), { activitySeq: 5, inboxSeq: 3 });
    assert.deepEqual(parseStreamResumeId('a0:i0'), { activitySeq: 0, inboxSeq: 0 });
  });

  it('keeps legacy activity-only cursor support for one deploy cycle', () => {
    assert.deepEqual(parseStreamResumeId('99', { allowLegacyActivityCursor: true }), { activitySeq: 99, inboxSeq: null });
    assert.deepEqual(parseStreamResumeId(encodeCursor(['42']), { allowLegacyActivityCursor: true }), { activitySeq: 42, inboxSeq: null });
    assert.equal(parseStreamResumeId('99'), null);
  });

  it('rejects malformed or unsafe values', () => {
    for (const raw of ['garbage', 'a-1:i2', 'a1:i2.5', 'a1', 'a1:i', `a${Number.MAX_SAFE_INTEGER + 1}:i1`]) {
      assert.equal(parseStreamResumeId(raw, { allowLegacyActivityCursor: true }), null, raw);
    }

    assert.throws(
      () => parseRequiredStreamResumeId('garbage', 'Last-Event-ID must be a valid stream cursor'),
      (error) => error instanceof AppError && error.code === 'invalid_input',
    );
  });
});
