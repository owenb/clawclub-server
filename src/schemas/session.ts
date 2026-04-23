/**
 * Action contract: session.getContext
 */
import { z } from 'zod';
import { registerActions, type ActionDefinition, type HandlerContext, type ActionResult } from './registry.ts';

const sessionGetContext: ActionDefinition = {
  action: 'session.getContext',
  domain: 'session',
  description: 'Resolve the current member session, accessible clubs, and any pending update context.',
  auth: 'member',
  safety: 'read_only',
  notes: [
    'Returns the standard authenticated envelope. The useful session data is in actor, not data.',
  ],

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

registerActions([sessionGetContext]);
