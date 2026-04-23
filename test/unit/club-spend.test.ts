import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLUB_SPEND_RESERVATION_MARGIN_BPS,
  computeEmbeddingActualMicroCents,
  computeGateActualMicroCents,
  estimateEmbeddingSpend,
  estimateGateSpend,
  estimateTokensFromText,
} from '../../src/club-spend.ts';
import {
  CLAWCLUB_EMBEDDING_INPUT_MICRO_CENTS_PER_TOKEN,
  CLAWCLUB_OPENAI_INPUT_MICRO_CENTS_PER_TOKEN,
  CLAWCLUB_OPENAI_OUTPUT_MICRO_CENTS_PER_TOKEN,
} from '../../src/ai.ts';
import { pickPrompt, renderArtifact } from '../../src/gate.ts';

test('estimateTokensFromText rounds up from characters to tokens', () => {
  assert.equal(estimateTokensFromText(''), 0);
  assert.equal(estimateTokensFromText('abcd'), 1);
  assert.equal(estimateTokensFromText('abcde'), 2);
  assert.equal(estimateTokensFromText('abcdefgh'), 2);
});

test('estimateGateSpend prices prompt and output with the fixed reservation margin', () => {
  const artifact = {
    kind: 'content' as const,
    contentKind: 'post' as const,
    isReply: false,
    title: 'Budgeted title',
    summary: 'Budgeted summary',
    body: 'Budgeted body',
  };

  const estimate = estimateGateSpend(artifact, 64);
  const promptAndUser = `${pickPrompt(artifact)}\n${renderArtifact(artifact)}`;
  const expectedInputTokens = Math.ceil(promptAndUser.length / 4);
  const baseMicroCents = (expectedInputTokens * CLAWCLUB_OPENAI_INPUT_MICRO_CENTS_PER_TOKEN)
    + (64 * CLAWCLUB_OPENAI_OUTPUT_MICRO_CENTS_PER_TOKEN);
  const expectedReserved = Math.ceil((baseMicroCents * (10_000 + CLUB_SPEND_RESERVATION_MARGIN_BPS)) / 10_000);

  assert.equal(estimate.usageKind, 'gate');
  assert.equal(estimate.reservedInputTokensEstimate, expectedInputTokens);
  assert.equal(estimate.reservedOutputTokens, 64);
  assert.equal(estimate.reservedMicroCents, expectedReserved);
});

test('embedding spend uses input tokens only', () => {
  const sourceText = 'Embedding source text';
  const estimate = estimateEmbeddingSpend(sourceText);
  const expectedTokens = Math.ceil(sourceText.length / 4);
  const baseMicroCents = expectedTokens * CLAWCLUB_EMBEDDING_INPUT_MICRO_CENTS_PER_TOKEN;
  const expectedReserved = Math.ceil((baseMicroCents * (10_000 + CLUB_SPEND_RESERVATION_MARGIN_BPS)) / 10_000);

  assert.equal(estimate.usageKind, 'embedding');
  assert.equal(estimate.reservedInputTokensEstimate, expectedTokens);
  assert.equal(estimate.reservedOutputTokens, 0);
  assert.equal(estimate.reservedMicroCents, expectedReserved);
});

test('actual spend pricing is exact and un-margined', () => {
  assert.equal(
    computeGateActualMicroCents({ promptTokens: 11, completionTokens: 7 }),
    (11 * CLAWCLUB_OPENAI_INPUT_MICRO_CENTS_PER_TOKEN) + (7 * CLAWCLUB_OPENAI_OUTPUT_MICRO_CENTS_PER_TOKEN),
  );
  assert.equal(
    computeEmbeddingActualMicroCents({ embeddingTokens: 123 }),
    123 * CLAWCLUB_EMBEDDING_INPUT_MICRO_CENTS_PER_TOKEN,
  );
});
