/**
 * Action contract: session.describe
 */
import { z } from 'zod';
import { registerActions, type ActionDefinition, type HandlerContext, type ActionResult } from './registry.ts';

const sessionDescribe: ActionDefinition = {
  action: 'session.describe',
  domain: 'platform',
  description: 'Resolve the current member session, accessible clubs, and any pending update context.',
  auth: 'member',
  safety: 'read_only',
  aiExposed: true,

  wire: {
    input: z.object({}),
    output: z.object({}),
  },

  parse: {
    input: z.object({}),
  },

  async handle(_input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    return { data: {} };
  },
};

registerActions([sessionDescribe]);
