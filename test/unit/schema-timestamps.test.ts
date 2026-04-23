import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import '../../src/dispatch.ts';
import { getRegistry } from '../../src/schemas/registry.ts';
import {
  CLAWCLUB_TIMESTAMP_META,
} from '../../src/schemas/fields.ts';
import { isTimestampKey } from '../../src/timestamps.ts';
import {
  authenticatedSuccessEnvelope,
  unauthenticatedSuccessEnvelope,
  sseReadyEvent,
  sseActivityEvent,
  sseMessageEvent,
  sseNotificationsDirtyEvent,
  sseClosedEvent,
} from '../../src/schemas/transport.ts';

function unwrapSchema(schema: z.ZodType): z.ZodType {
  let current = schema;
  while (
    current instanceof z.ZodOptional
    || current instanceof z.ZodNullable
    || current instanceof z.ZodDefault
    || current instanceof z.ZodCatch
    || current instanceof z.ZodReadonly
  ) {
    current = current.unwrap();
  }
  return current;
}

function isTimestampSchema(schema: z.ZodType): boolean {
  return unwrapSchema(schema).meta()?.clawclubType === CLAWCLUB_TIMESTAMP_META;
}

function isTimestampValueWrapper(schema: z.ZodType): boolean {
  const unwrapped = unwrapSchema(schema);
  if (!(unwrapped instanceof z.ZodObject)) {
    return false;
  }
  const valueSchema = (unwrapped.shape as Record<string, z.ZodType>).value;
  return valueSchema != null && isTimestampSchema(valueSchema);
}

function collectTimestampSchemaIssues(
  schema: z.ZodType,
  path: string,
  propertyKey: string | null,
  issues: string[],
): void {
  const unwrapped = unwrapSchema(schema);
  const schemaIsTimestamp = isTimestampSchema(unwrapped);
  const schemaIsTimestampWrapper = isTimestampValueWrapper(unwrapped);

  if (propertyKey !== null) {
    const keyLooksTimestamp = isTimestampKey(propertyKey);
    if (keyLooksTimestamp && !schemaIsTimestamp && !schemaIsTimestampWrapper) {
      issues.push(`${path} ends with At/On/Until but does not use timestampString`);
    }
    if (schemaIsTimestamp && !keyLooksTimestamp && propertyKey !== 'value') {
      issues.push(`${path} uses timestampString but key does not end with At/On/Until`);
    }
  } else if (schemaIsTimestamp) {
    issues.push(`${path} uses timestampString outside a statically-named object key`);
  }

  if (unwrapped instanceof z.ZodObject) {
    for (const [key, child] of Object.entries(unwrapped.shape)) {
      collectTimestampSchemaIssues(child as z.ZodType, `${path}.${key}`, key, issues);
    }
    return;
  }
  if (unwrapped instanceof z.ZodArray) {
    collectTimestampSchemaIssues(unwrapped.element, `${path}[]`, null, issues);
    return;
  }
  if (unwrapped instanceof z.ZodTuple) {
    for (const [index, child] of unwrapped.items.entries()) {
      collectTimestampSchemaIssues(child, `${path}[${index}]`, null, issues);
    }
    return;
  }
  if (unwrapped instanceof z.ZodUnion || unwrapped instanceof z.ZodDiscriminatedUnion) {
    for (const [index, option] of unwrapped.options.entries()) {
      collectTimestampSchemaIssues(option, `${path}<option:${index}>`, propertyKey, issues);
    }
    return;
  }
  if (unwrapped instanceof z.ZodIntersection) {
    collectTimestampSchemaIssues(unwrapped._def.left as z.ZodType, `${path}<left>`, propertyKey, issues);
    collectTimestampSchemaIssues(unwrapped._def.right as z.ZodType, `${path}<right>`, propertyKey, issues);
    return;
  }
  if (unwrapped instanceof z.ZodRecord) {
    collectTimestampSchemaIssues(unwrapped.valueType, `${path}{}`, null, issues);
    return;
  }
  if (unwrapped instanceof z.ZodLazy) {
    collectTimestampSchemaIssues(unwrapped._def.getter(), `${path}<lazy>`, propertyKey, issues);
  }
}

test('public output schemas keep timestampString aligned with *At/*On/*Until naming canon', () => {
  const issues: string[] = [];

  for (const [actionName, def] of getRegistry()) {
    collectTimestampSchemaIssues(def.wire.output, `action:${actionName}.output`, null, issues);
  }

  collectTimestampSchemaIssues(authenticatedSuccessEnvelope, 'transport:authenticatedSuccessEnvelope', null, issues);
  collectTimestampSchemaIssues(unauthenticatedSuccessEnvelope, 'transport:unauthenticatedSuccessEnvelope', null, issues);
  collectTimestampSchemaIssues(sseReadyEvent, 'transport:sseReadyEvent', null, issues);
  collectTimestampSchemaIssues(sseActivityEvent, 'transport:sseActivityEvent', null, issues);
  collectTimestampSchemaIssues(sseMessageEvent, 'transport:sseMessageEvent', null, issues);
  collectTimestampSchemaIssues(sseNotificationsDirtyEvent, 'transport:sseNotificationsDirtyEvent', null, issues);
  collectTimestampSchemaIssues(sseClosedEvent, 'transport:sseClosedEvent', null, issues);

  assert.deepEqual(issues, []);
});
