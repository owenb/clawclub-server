import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

import {
  defineInput,
  generateRequestTemplate,
  type ActionDefinition,
} from '../../src/schemas/registry.ts';

test('generateRequestTemplate unwraps defaulted fields and keeps nested defaults complex', () => {
  const def: ActionDefinition = {
    action: 'test.defaultTemplate',
    domain: 'test',
    description: 'Request-template test action',
    auth: 'none',
    safety: 'read_only',
    input: defineInput({
      wire: z.object({
        label: z.string().optional().default('default-label'),
        options: z.object({
          enabled: z.boolean().optional().default(true),
        }).optional().default({}),
      }),
    }),
    wire: {
      output: z.object({}),
    },
  };

  const template = generateRequestTemplate(def);

  assert.deepEqual(template, {
    action: 'test.defaultTemplate',
    input: {
      label: '(string, optional)',
      options: '(<complex>, optional)',
    },
  });
});
