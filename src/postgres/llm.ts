import type { Pool } from 'pg';
import type { LogLlmUsageInput, Repository } from '../contract.ts';

export function buildLlmRepository({ pool }: { pool: Pool }): Pick<Repository, 'logLlmUsage'> {
  return {
    async logLlmUsage(input: LogLlmUsageInput): Promise<void> {
      await pool.query(
        `SELECT app.log_llm_usage($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          input.memberId,
          input.requestedClubId,
          input.actionName,
          input.gateName ?? 'quality_gate',
          input.provider,
          input.model,
          input.gateStatus,
          input.skipReason,
          input.promptTokens,
          input.completionTokens,
          input.providerErrorCode,
        ],
      );
    },
  };
}
