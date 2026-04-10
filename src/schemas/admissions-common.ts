import type { AdmissionApplyOutcome } from '../contract.ts';
import type { ActionResult } from './registry.ts';

export function normalizeAdmissionApplyOutcome(outcome: AdmissionApplyOutcome): ActionResult {
  if ('result' in outcome) {
    return { data: outcome.result, notices: outcome.notices };
  }
  return { data: outcome };
}
