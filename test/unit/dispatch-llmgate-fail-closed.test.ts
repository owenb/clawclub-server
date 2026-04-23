import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { AppError, type Repository } from '../../src/repository.ts';
import { buildDispatcher } from '../../src/dispatch.ts';
import { registerActions, type ActionDefinition } from '../../src/schemas/registry.ts';
import { makeAuthResult, makeRepository, passthroughGate } from './fixtures.ts';

let actionCounter = 0;

function nextActionName(): string {
  actionCounter += 1;
  return `test.llmgate.failclosed.${actionCounter}`;
}

test('dispatch fails closed when an llmGate action is missing budget plumbing', async () => {
  const action: ActionDefinition = {
    action: nextActionName(),
    domain: 'test',
    description: 'llmGate fail-closed fixture',
    auth: 'member',
    safety: 'mutating',
    wire: {
      input: z.object({ body: z.string() }),
      output: z.object({ ok: z.boolean() }),
    },
    parse: {
      input: z.object({ body: z.string() }),
    },
    llmGate: {
      async buildArtifact() {
        return {
          kind: 'content',
          contentKind: 'post',
          isReply: false,
          title: null,
          summary: null,
          body: 'fixture',
        };
      },
      async resolveBudgetClubId() {
        return 'club-1';
      },
    },
    async handle() {
      return { data: { ok: true } };
    },
  };
  registerActions([action]);

  const baseRepository = makeRepository({
    async authenticateBearerToken() {
      return makeAuthResult();
    },
  });
  const repository: Repository = {
    ...baseRepository,
    reserveLlmOutputBudget: undefined,
    finalizeLlmOutputBudget: undefined,
  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });

  await assert.rejects(
    () => dispatcher.dispatch({
      bearerToken: 'test-bearer',
      action: action.action,
      payload: { body: 'hello' },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 500);
      assert.equal(error.code, 'invalid_data');
      assert.match(error.message, /without budget reservation\/finalization plumbing/);
      return true;
    },
  );
});

test('dispatch fails closed when an llmGate action is missing club spend plumbing', async () => {
  const action: ActionDefinition = {
    action: nextActionName(),
    domain: 'test',
    description: 'club spend fail-closed fixture',
    auth: 'member',
    safety: 'mutating',
    wire: {
      input: z.object({ body: z.string() }),
      output: z.object({ ok: z.boolean() }),
    },
    parse: {
      input: z.object({ body: z.string() }),
    },
    llmGate: {
      async buildArtifact() {
        return {
          kind: 'content',
          contentKind: 'post',
          isReply: false,
          title: null,
          summary: null,
          body: 'fixture',
        };
      },
      async resolveBudgetClubId() {
        return 'club-1';
      },
    },
    async handle() {
      return { data: { ok: true } };
    },
  };
  registerActions([action]);

  const baseRepository = makeRepository({
    async authenticateBearerToken() {
      return makeAuthResult();
    },
  });
  const repository: Repository = {
    ...baseRepository,
    reserveClubSpendBudget: undefined,
    finalizeClubSpendBudget: undefined,
    releaseClubSpendBudget: undefined,
  };

  const dispatcher = buildDispatcher({ repository, llmGate: passthroughGate });

  await assert.rejects(
    () => dispatcher.dispatch({
      bearerToken: 'test-bearer',
      action: action.action,
      payload: { body: 'hello' },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 500);
      assert.equal(error.code, 'invalid_data');
      assert.match(error.message, /without club spend reservation\/finalization plumbing/);
      return true;
    },
  );
});
