import type { ApplicationGateVerdict } from './gate.ts';

export const APPLICATION_GATE_UNAVAILABLE_MESSAGE = 'The gate was unavailable, so the application was queued directly for admin review.';

export type StoredApplicationGateResult =
  | {
      phase: 'revision_required';
      gateVerdict: 'needs_revision';
      gateFeedback: { message: string; missingItems: string[] };
      gateLastRunAt: string;
    }
  | {
      phase: 'awaiting_review';
      gateVerdict: 'passed' | 'unavailable';
      gateFeedback: { message: string; missingItems: string[] } | null;
      gateLastRunAt: string;
    };

function parseApplicationGateFeedback(feedback: string): { message: string; missingItems: string[] } {
  return {
    message: feedback,
    missingItems: [],
  };
}

function normalizeApplicationGateVerdict(
  verdict: ApplicationGateVerdict,
): { status: 'needs_revision'; feedback: string } | { status: 'passed' } | { status: 'unavailable' } {
  switch (verdict.status) {
    case 'passed':
      return { status: 'passed' };
    case 'needs_revision':
      return { status: 'needs_revision', feedback: verdict.feedback };
    case 'rejected_malformed':
    case 'skipped':
    case 'failed':
      return { status: 'unavailable' };
  }
}

export function mapApplicationGateVerdict(input: {
  verdict: ApplicationGateVerdict;
  gateLastRunAt: string;
}): StoredApplicationGateResult {
  const gate = normalizeApplicationGateVerdict(input.verdict);
  if (gate.status === 'needs_revision') {
    return {
      phase: 'revision_required',
      gateVerdict: 'needs_revision',
      gateFeedback: parseApplicationGateFeedback(gate.feedback),
      gateLastRunAt: input.gateLastRunAt,
    };
  }
  if (gate.status === 'passed') {
    return {
      phase: 'awaiting_review',
      gateVerdict: 'passed',
      gateFeedback: null,
      gateLastRunAt: input.gateLastRunAt,
    };
  }
  return {
    phase: 'awaiting_review',
    gateVerdict: 'unavailable',
    gateFeedback: {
      message: APPLICATION_GATE_UNAVAILABLE_MESSAGE,
      missingItems: [],
    },
    gateLastRunAt: input.gateLastRunAt,
  };
}
