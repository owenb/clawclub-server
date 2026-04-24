import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { strictRecursive } from '../../src/schemas/registry.ts';

function assertUnrecognizedKey(
  schema: z.ZodTypeAny,
  value: unknown,
  expectedPath: Array<string | number>,
  expectedKey: string,
): void {
  const result = strictRecursive(schema).safeParse(value);
  assert.equal(result.success, false);
  if (result.success) return;
  const issue = result.error.issues.find((candidate) => candidate.code === 'unrecognized_keys');
  assert.ok(issue, `expected unrecognized_keys issue, got ${result.error.message}`);
  assert.deepEqual(issue.path, expectedPath);
  assert.deepEqual((issue as unknown as { keys?: string[] }).keys, [expectedKey]);
}

test('strictRecursive rejects unknown keys on root and nested ZodObject schemas', () => {
  const schema = z.object({
    nested: z.object({
      value: z.string(),
    }),
  });

  assertUnrecognizedKey(schema, {
    nested: { value: 'ok' },
    rootTypo: true,
  }, [], 'rootTypo');

  assertUnrecognizedKey(schema, {
    nested: { value: 'ok', nestedTypo: true },
  }, ['nested'], 'nestedTypo');
});

test('strictRecursive descends through optional, nullable, and default wrappers', () => {
  const schema = z.object({
    optionalObject: z.object({ value: z.string() }).optional(),
    nullableObject: z.object({ value: z.string() }).nullable(),
    defaultedObject: z.object({ value: z.string() }).optional().default({ value: 'fallback' }),
  });
  const strict = strictRecursive(schema);

  assertUnrecognizedKey(strict, {
    optionalObject: { value: 'ok', typo: true },
    nullableObject: null,
  }, ['optionalObject'], 'typo');

  assertUnrecognizedKey(strict, {
    nullableObject: { value: 'ok', typo: true },
  }, ['nullableObject'], 'typo');

  assertUnrecognizedKey(strict, {
    nullableObject: null,
    defaultedObject: { value: 'ok', typo: true },
  }, ['defaultedObject'], 'typo');

  const defaultResult = strict.safeParse({ nullableObject: null });
  assert.equal(defaultResult.success, true);
  if (defaultResult.success) {
    assert.deepEqual(defaultResult.data.defaultedObject, { value: 'fallback' });
  }
});

test('strictRecursive descends through arrays while preserving array checks', () => {
  const schema = z.object({
    items: z.array(z.object({ value: z.string() })).min(1),
  });
  const strict = strictRecursive(schema);

  assertUnrecognizedKey(strict, {
    items: [{ value: 'ok', typo: true }],
  }, ['items', 0], 'typo');

  const emptyResult = strict.safeParse({ items: [] });
  assert.equal(emptyResult.success, false);
  if (!emptyResult.success) {
    assert.equal(emptyResult.error.issues[0]?.code, 'too_small');
  }
});

test('strictRecursive descends through discriminated and plain unions', () => {
  const discriminated = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('a'), payload: z.object({ value: z.string() }) }),
    z.object({ kind: z.literal('b'), other: z.string() }),
  ]);
  assertUnrecognizedKey(discriminated, {
    kind: 'a',
    payload: { value: 'ok', typo: true },
  }, ['payload'], 'typo');

  const plain = z.union([
    z.object({ payload: z.object({ value: z.string() }) }),
    z.object({ other: z.string() }),
  ]);
  const plainResult = strictRecursive(plain).safeParse({
    payload: { value: 'ok', typo: true },
  });
  assert.equal(plainResult.success, false);
});

test('strictRecursive handles deeply nested wrapper combinations', () => {
  const schema = z.object({
    list: z.array(z.object({
      maybe: z.object({
        value: z.string(),
      }).nullable().optional(),
    })).optional(),
  });

  assertUnrecognizedKey(schema, {
    list: [{
      maybe: { value: 'ok', typo: true },
    }],
  }, ['list', 0, 'maybe'], 'typo');
});

test('strictRecursive preserves object-level refinements', () => {
  const schema = z.object({
    patch: z.object({
      role: z.string().optional(),
      status: z.string().optional(),
    }).refine(
      (patch) => patch.role !== undefined || patch.status !== undefined,
      'patch must include role or status',
    ),
  });
  const strict = strictRecursive(schema);

  const emptyPatch = strict.safeParse({ patch: {} });
  assert.equal(emptyPatch.success, false);
  if (!emptyPatch.success) {
    assert.equal(emptyPatch.error.issues[0]?.code, 'custom');
  }

  assertUnrecognizedKey(strict, {
    patch: { role: 'member', typo: true },
  }, ['patch'], 'typo');
});
