import type { GateVerdict, NonApplicationArtifact } from './gate.ts';
import {
  buildGateLlmLogEntry,
  gateVerdictToAppError,
  logMalformedGateVerdict,
} from './gate-results.ts';
import { logger } from './logger.ts';
import { getLlmGateMaxOutputTokens } from './quotas.ts';
import type { LogLlmUsageInput, Repository } from './repository.ts';

function fireAndForgetLlmLog(repository: Repository, entry: LogLlmUsageInput): void {
  if (!repository.logLlmUsage) return;
  repository.logLlmUsage(entry).catch((err) => {
    logger.error('llm_usage_log_failure', err, { actionName: entry.actionName });
  });
}

export async function runCreateGateCheck(input: {
  actionName: string;
  actorMemberId: string;
  requestedClubId?: string | null;
  artifact: NonApplicationArtifact;
  repository: Repository;
  runLlmGate: (artifact: NonApplicationArtifact, options?: { maxOutputTokens?: number }) => Promise<GateVerdict>;
}): Promise<void> {
  const maxOutputTokens = getLlmGateMaxOutputTokens();
  const verdict = await input.runLlmGate(input.artifact, { maxOutputTokens });
  logMalformedGateVerdict({
    actionName: input.actionName,
    memberId: input.actorMemberId,
    requestedClubId: input.requestedClubId ?? null,
    artifactKind: input.artifact.kind,
    verdict,
  });

  fireAndForgetLlmLog(
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
    throw error;
  }
}
