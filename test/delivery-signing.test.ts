import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  CLAWCLUB_SIGNATURE_TIMESTAMP_HEADER,
  CLAWCLUB_SIGNATURE_V1_HEADER,
  createDeliverySecretResolver,
  readClawClubSignatureHeaders,
  signClawClubDelivery,
  verifyClawClubDeliverySignature,
} from '../src/delivery-signing.ts';

test('createDeliverySecretResolver reads env: refs from process-style env', async () => {
  const resolveSecret = createDeliverySecretResolver({ env: { CLAWCLUB_WEBHOOK_SECRET: 'super-secret' } as NodeJS.ProcessEnv });
  assert.equal(await resolveSecret({ sharedSecretRef: 'env:CLAWCLUB_WEBHOOK_SECRET' }), 'super-secret');
  assert.equal(await resolveSecret({ sharedSecretRef: 'env:MISSING_SECRET' }), null);
});

test('createDeliverySecretResolver reads op:// refs through the injected reader', async () => {
  const seenRefs: string[] = [];
  const resolveSecret = createDeliverySecretResolver({
    readOpSecret: async (ref) => {
      seenRefs.push(ref);
      return 'vault-secret';
    },
  });

  assert.equal(await resolveSecret({ sharedSecretRef: 'op://clawclub/webhooks/member-1/secret' }), 'vault-secret');
  assert.deepEqual(seenRefs, ['op://clawclub/webhooks/member-1/secret']);
});

test('signClawClubDelivery emits the expected timestamp and signature headers', () => {
  const headers = signClawClubDelivery({
    secret: 'super-secret',
    body: '{"hello":"world"}',
    timestamp: '2026-03-13T09:30:00.000Z',
  });

  assert.equal(headers[CLAWCLUB_SIGNATURE_TIMESTAMP_HEADER], '2026-03-13T09:30:00.000Z');
  assert.equal(
    headers[CLAWCLUB_SIGNATURE_V1_HEADER],
    `sha256=${createHmac('sha256', 'super-secret').update('2026-03-13T09:30:00.000Z.{"hello":"world"}').digest('hex')}`,
  );
});

test('verifyClawClubDeliverySignature accepts a valid signature and rejects bad ones', () => {
  const body = '{"deliveryId":"delivery-1"}';
  const timestamp = '2026-03-13T09:30:00.000Z';
  const signature = `sha256=${createHmac('sha256', 'super-secret').update(`${timestamp}.${body}`).digest('hex')}`;

  assert.deepEqual(
    verifyClawClubDeliverySignature({
      secret: 'super-secret',
      body,
      timestamp,
      signature,
      now: new Date('2026-03-13T09:31:00.000Z'),
    }),
    { ok: true },
  );

  assert.deepEqual(
    verifyClawClubDeliverySignature({
      secret: 'super-secret',
      body,
      timestamp,
      signature: 'sha256=deadbeef',
      now: new Date('2026-03-13T09:31:00.000Z'),
    }),
    { ok: false, reason: 'invalid_signature_format' },
  );

  assert.deepEqual(
    verifyClawClubDeliverySignature({
      secret: 'super-secret',
      body,
      timestamp,
      signature: `sha256=${'0'.repeat(64)}`,
      now: new Date('2026-03-13T09:31:00.000Z'),
    }),
    { ok: false, reason: 'signature_mismatch' },
  );

  assert.deepEqual(
    verifyClawClubDeliverySignature({
      secret: 'super-secret',
      body,
      timestamp,
      signature,
      now: new Date('2026-03-13T09:40:01.000Z'),
    }),
    { ok: false, reason: 'timestamp_out_of_range' },
  );
});

test('readClawClubSignatureHeaders extracts signature headers from a receiver request map', () => {
  const headers = readClawClubSignatureHeaders({
    'content-type': 'application/json',
    [CLAWCLUB_SIGNATURE_TIMESTAMP_HEADER]: '2026-03-13T09:30:00.000Z',
    [CLAWCLUB_SIGNATURE_V1_HEADER]: 'sha256=abc123',
  });

  assert.deepEqual(headers, {
    timestamp: '2026-03-13T09:30:00.000Z',
    signature: 'sha256=abc123',
  });
});
