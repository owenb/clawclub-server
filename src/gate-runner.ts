import { renderGateText, type GateVerdict, type NonApplicationArtifact } from './gate.ts';
import {
  buildGateLlmLogEntry,
  gateVerdictToAppError,
  logMalformedGateVerdict,
} from './gate-results.ts';
import { AppError } from './errors.ts';
import { fireAndForgetLlmUsageLog, logger } from './logger.ts';
import { getLlmGateMaxOutputTokens } from './quotas.ts';
import type { Repository } from './repository.ts';
import { hasSubstantiveText } from './schemas/fields.ts';

export function artifactTextForPrecheck(artifact: NonApplicationArtifact): string | null {
  switch (artifact.kind) {
    case 'content':
      if (artifact.isReply) return null;
      return [artifact.title, artifact.summary, artifact.body]
        .filter((value): value is string => typeof value === 'string')
        .map(renderGateText)
        .join('\n');
    case 'vouch':
    case 'invitation':
      return renderGateText(artifact.reason);
    case 'club':
      return [artifact.name, artifact.summary, artifact.admissionPolicy]
        .filter((value): value is string => typeof value === 'string')
        .map(renderGateText)
        .join('\n');
    case 'profile': {
      const fields = [
        artifact.tagline,
        artifact.summary,
        artifact.whatIDo,
        artifact.knownFor,
        artifact.servicesSummary,
        artifact.websiteUrl,
        ...artifact.links.flatMap((link) => [link.label, link.url]),
      ].filter((value): value is string => typeof value === 'string');
      return fields.length === 0 ? null : fields.map(renderGateText).join('\n');
    }
    case 'event':
      return null;
  }
}

export function deterministicLowSubstanceError(artifact: NonApplicationArtifact): AppError | null {
  const text = artifactTextForPrecheck(artifact);
  if (text === null) return null;
  if (hasSubstantiveText(text, 2)) return null;
  return new AppError(
    'low_quality_content',
    'The submission is too short to evaluate. Add meaningful visible text and retry with a fresh clientKey.',
  );
}

async function storeTerminalGateError(input: {
  actionName: string;
  repository: Repository;
  idempotency?: {
    clientKey: string;
    actorContext: string;
    requestValue: unknown;
  };
  error: AppError;
}): Promise<void> {
  if (!input.idempotency || !input.repository.storeIdempotencyTerminalError) return;
  if (!['illegal_content', 'low_quality_content', 'gate_rejected'].includes(input.error.code)) return;
  try {
    await input.repository.storeIdempotencyTerminalError({
      clientKey: input.idempotency.clientKey,
      actorContext: input.idempotency.actorContext,
      requestValue: input.idempotency.requestValue,
      error: {
        code: input.error.code,
        message: input.error.message,
        ...(input.error.details !== undefined ? { details: input.error.details } : {}),
      },
    });
  } catch (error) {
    logger.error('idempotency_terminal_gate_error_store_failed', error, {
      actionName: input.actionName,
      clientKey: input.idempotency.clientKey,
      actorContext: input.idempotency.actorContext,
    });
  }
}

export async function runCreateGateCheck(input: {
  actionName: string;
  actorMemberId: string;
  requestedClubId?: string | null;
  artifact: NonApplicationArtifact;
  repository: Repository;
  runLlmGate: (artifact: NonApplicationArtifact, options?: { maxOutputTokens?: number }) => Promise<GateVerdict>;
  idempotency?: {
    clientKey: string;
    actorContext: string;
    requestValue: unknown;
  };
}): Promise<void> {
  const lowSubstanceError = deterministicLowSubstanceError(input.artifact);
  if (lowSubstanceError) {
    await storeTerminalGateError({
      actionName: input.actionName,
      repository: input.repository,
      idempotency: input.idempotency,
      error: lowSubstanceError,
    });
    throw lowSubstanceError;
  }

  const maxOutputTokens = getLlmGateMaxOutputTokens();
  const verdict = await input.runLlmGate(input.artifact, { maxOutputTokens });
  logMalformedGateVerdict({
    actionName: input.actionName,
    memberId: input.actorMemberId,
    requestedClubId: input.requestedClubId ?? null,
    artifactKind: input.artifact.kind,
    verdict,
  });

  fireAndForgetLlmUsageLog(
    input.repository,
    buildGateLlmLogEntry({
      actionName: input.actionName,
      memberId: input.actorMemberId,
      requestedClubId: input.requestedClubId ?? null,
      artifactKind: input.artifact.kind,
      verdict,
    }),
  );

  const error = gateVerdictToAppError(verdict);
  if (error) {
    await storeTerminalGateError({
      actionName: input.actionName,
      repository: input.repository,
      idempotency: input.idempotency,
      error,
    });
    throw error;
  }
}
