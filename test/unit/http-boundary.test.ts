import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readJsonBody } from '../../src/http-boundary.ts';
import { AppError } from '../../src/errors.ts';

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

test('readJsonBody rejects incomplete bodies after the receive deadline', async () => {
  const request = makeRequestEmitter();
  const body = readJsonBody(request as any, 1024, 5);

  await assert.rejects(
    body,
    (error) => error instanceof AppError
      && error.code === 'payload_timeout'
      && error.closeConnection === true,
  );
  assert.equal(request.listenerCount('data'), 0);
  assert.equal(request.listenerCount('end'), 0);
  assert.equal(request.listenerCount('error'), 0);
  assert.equal(request.listenerCount('aborted'), 0);
});

test('readJsonBody classifies client aborts as invalid_json without a generic 500', async () => {
  const request = makeRequestEmitter();
  const body = readJsonBody(request as any, 1024, 1_000);

  request.emit('aborted');

  await assert.rejects(
    body,
    (error) => error instanceof AppError
      && error.code === 'invalid_json'
      && error.details?.kind === 'client_aborted'
      && error.closeConnection === true,
  );
});
