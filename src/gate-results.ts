import { CLAWCLUB_OPENAI_MODEL } from './ai.ts';
import { AppError } from './errors.ts';
import type { ApplicationGateVerdict, GateVerdict, GatedArtifact } from './gate.ts';
import { logger } from './logger.ts';
import type { LogLlmUsageInput } from './repository.ts';

export const MALFORMED_GATE_CLIENT_MESSAGE = 'The content gate returned an unexpected response. Please try again.';
export const MALFORMED_GATE_LOG_FEEDBACK = 'Malformed gate verdict from LLM';

export function buildGateLlmLogEntry(input: {
  actionName: string;
  memberId: string | null;
  requestedClubId: string | null;
  artifactKind: GatedArtifact['kind'];
  verdict: GateVerdict;
}): LogLlmUsageInput {
  const base = {
    memberId: input.memberId,
    requestedClubId: input.requestedClubId,
    actionName: input.actionName,
    artifactKind: input.artifactKind,
    provider: 'openai',
    model: CLAWCLUB_OPENAI_MODEL,
  };

  if (input.verdict.status === 'skipped') {
    return {
      ...base,
      gateStatus: 'skipped',
      skipReason: input.verdict.reason,
      promptTokens: null,
      completionTokens: null,
      providerErrorCode: null,
      feedback: null,
    };
  }

  if (input.verdict.status === 'failed') {
    return {
      ...base,
      gateStatus: 'failed',
      skipReason: null,
      promptTokens: null,
      completionTokens: null,
      providerErrorCode: input.verdict.errorCode,
      feedback: null,
    };
  }

  return {
    ...base,
    gateStatus: input.verdict.status,
    skipReason: null,
    promptTokens: input.verdict.usage.promptTokens,
    completionTokens: input.verdict.usage.completionTokens,
    providerErrorCode: null,
    feedback: input.verdict.status === 'passed'
      ? null
      : input.verdict.status === 'rejected_malformed'
        ? MALFORMED_GATE_LOG_FEEDBACK
        : input.verdict.feedback,
  };
}

export function gateVerdictToAppError(verdict: GateVerdict): AppError | null {
  switch (verdict.status) {
    case 'passed':
      return null;
    case 'rejected_illegal':
      return new AppError('illegal_content', verdict.feedback);
    case 'rejected_quality':
      return new AppError('low_quality_content', verdict.feedback);
    case 'rejected_malformed':
      return new AppError('gate_rejected', MALFORMED_GATE_CLIENT_MESSAGE);
    case 'skipped':
    case 'failed':
      return new AppError('gate_unavailable', `Content gate unavailable (${verdict.reason}).`);
  }
}

export function logMalformedGateVerdict(input: {
  actionName: string;
  memberId: string | null;
  requestedClubId: string | null;
  artifactKind: GatedArtifact['kind'];
  verdict: GateVerdict | ApplicationGateVerdict;
}): void {
  if (input.verdict.status !== 'rejected_malformed') {
    return;
  }

  logger.warn('llm_gate_malformed_verdict', {
    actionName: input.actionName,
    memberId: input.memberId,
    requestedClubId: input.requestedClubId,
    artifactKind: input.artifactKind,
    rawText: input.verdict.rawText,
  });
}
