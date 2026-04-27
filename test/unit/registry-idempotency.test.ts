import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { defineInput, registerActions } from '../../src/schemas/registry.ts';

test('registerActions rejects authenticated mutating actions without an idempotency strategy', () => {
  assert.throws(
    () => registerActions([{
      action: `test.idempotency.missing.${Date.now()}`,
      domain: 'test',
      description: 'Mutating action missing idempotency strategy',
      auth: 'member',
      safety: 'mutating',
      input: defineInput({
        wire: z.object({}),
      }),
      wire: {
        output: z.object({ ok: z.boolean() }),
      },
      async handle() {
        return { data: { ok: true } };
      },
    }]),
    /must declare an idempotencyStrategy/,
  );
});

test('registerActions rejects legacy parallel input schema declarations', () => {
  assert.throws(
    () => registerActions([{
      action: `test.input.legacy.${Date.now()}`,
      domain: 'test',
      description: 'Legacy input schema shape',
      auth: 'member',
      safety: 'read_only',
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
    } as unknown as Parameters<typeof registerActions>[0][number]]),
    /must declare input via defineInput/,
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
      input: defineInput({
        wire: z.object({ clientKey: z.string() }),
      }),
      wire: {
        output: z.object({ ok: z.boolean() }),
      },
      async handle() {
        return { data: { ok: true } };
      },
    }]),
    /declares clientKey idempotency without an idempotency declaration/,
  );
});

test('registerActions rejects input arrays without schema or policy bounds', () => {
  assert.throws(
    () => registerActions([{
      action: `test.array.unbounded.${Date.now()}`,
      domain: 'test',
      description: 'Read action with unbounded input array',
      auth: 'member',
      safety: 'read_only',
      input: defineInput({
        wire: z.object({ ids: z.array(z.string()) }),
      }),
      wire: {
        output: z.object({ ok: z.boolean() }),
      },
      async handle() {
        return { data: { ok: true } };
      },
    }]),
    /must declare maxItems or policy enforcement/,
  );
});

test('registerActions allows policy-bounded input arrays', () => {
  assert.doesNotThrow(() => registerActions([{
    action: `test.array.policy.${Date.now()}`,
    domain: 'test',
    description: 'Read action with policy-bounded input array',
    auth: 'member',
    safety: 'read_only',
    input: defineInput({
      wire: z.object({ ids: z.array(z.string()).meta({ clawclubEnforcedBy: 'policy' }) }),
      parse: z.object({ ids: z.array(z.string()) }),
    }),
    wire: {
      output: z.object({ ok: z.boolean() }),
    },
    async handle() {
      return { data: { ok: true } };
    },
  }]));
});
