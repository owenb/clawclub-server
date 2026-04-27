import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readJsonBody } from '../../src/http-boundary.ts';

function makeRequestEmitter() {
  const request = new EventEmitter() as EventEmitter & {
    pause: () => void;
    resume: () => void;
  };
  request.pause = () => {};
  request.resume = () => {};
  return request;
}

test('readJsonBody removes stream listeners when a data callback throws', async () => {
  const request = makeRequestEmitter();
  const body = readJsonBody(request as any);

  request.emit('data', { invalid: 'chunk' });

  await assert.rejects(body, TypeError);
  assert.equal(request.listenerCount('data'), 0);
  assert.equal(request.listenerCount('end'), 0);
  assert.equal(request.listenerCount('error'), 0);
  assert.equal(request.listenerCount('aborted'), 0);
});
