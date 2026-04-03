import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { CLAWCLUB_OPENAI_MODEL } from './ai.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadPrompt(filename: string): string {
  return readFileSync(join(__dirname, 'prompts', filename), 'utf8').trim();
}

const ACTION_QUALITY_PROMPTS: Record<string, string> = {
  'entities.create': loadPrompt('entities-create.txt'),
  'entities.update': loadPrompt('entities-create.txt'),
  'events.create': loadPrompt('events-create.txt'),
  'profile.update': loadPrompt('profile-update.txt'),
  'vouches.create': loadPrompt('vouches-create.txt'),
  'admissions.sponsor': loadPrompt('admissions-sponsor.txt'),
};

const GATE_WRAPPER = `You are a content quality gate for a private members club platform. Your job is to evaluate whether a submission meets the minimum quality bar before it is published.

{{ACTION_PROMPT}}

Evaluate the following submission. If it meets the quality bar, respond with exactly: PASS
If it does not, respond with a brief explanation of what is missing or needs improvement. Do not be conversational — just state what's wrong.`;

export type QualityGateResult =
  | { pass: true }
  | { pass: false; feedback: string };

export async function runQualityGate(
  action: string,
  payload: Record<string, unknown>,
): Promise<QualityGateResult> {
  const actionPrompt = ACTION_QUALITY_PROMPTS[action];
  if (!actionPrompt) {
    return { pass: true };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // No API key configured — bypass the quality gate.
    // This allows unit tests and deployments without LLM access to function.
    return { pass: true };
  }

  const provider = createOpenAI({ apiKey });
  const model = provider(CLAWCLUB_OPENAI_MODEL);

  const system = GATE_WRAPPER.replace('{{ACTION_PROMPT}}', actionPrompt);

  const result = await generateText({
    model,
    system,
    messages: [{ role: 'user', content: JSON.stringify(payload) }],
    maxSteps: 1,
  });

  const text = result.text.trim();

  if (text.toUpperCase().startsWith('PASS')) {
    return { pass: true };
  }

  return { pass: false, feedback: text };
}
