import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { registerActions } from '../../src/schemas/registry.ts';

test('registerActions rejects authenticated mutating actions without an idempotency strategy', () => {
  assert.throws(
    () => registerActions([{
      action: `test.idempotency.missing.${Date.now()}`,
      domain: 'test',
      description: 'Mutating action missing idempotency strategy',
      auth: 'member',
      safety: 'mutating',
      wire: {
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
      },
      parse: {
        input: z.object({}),
      },
      async handle() {
        return { data: { ok: true } };
      },
    }]),
    /must declare an idempotencyStrategy/,
  );
});

test('registerActions rejects clientKey strategies without an idempotency declaration', () => {
  assert.throws(
    () => registerActions([{
      action: `test.idempotency.unwired.${Date.now()}`,
      domain: 'test',
      description: 'Mutating action with unwired clientKey strategy',
      auth: 'member',
      safety: 'mutating',
      idempotencyStrategy: { kind: 'clientKey', requirement: 'required' },
      wire: {
        input: z.object({ clientKey: z.string() }),
        output: z.object({ ok: z.boolean() }),
      },
      parse: {
        input: z.object({ clientKey: z.string() }),
      },
      async handle() {
        return { data: { ok: true } };
      },
    }]),
    /declares clientKey idempotency without an idempotency declaration/,
  );
});
