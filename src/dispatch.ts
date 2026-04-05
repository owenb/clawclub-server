/**
 * Unified action dispatcher.
 *
 * Replaces the sequential handler chain with a registry-based
 * dispatch. All actions are looked up in the contract registry. The pipeline is:
 *
 *   1. Identify action (look up contract in registry)
 *   2. For auth:none → parse → legality gate → execute
 *      For authenticated → authenticate → parse → legality gate → authorize → execute
 *   3. Assemble canonical response envelope
 *
 * Behavioral change from previous code:
 *   - Legality gate now runs AFTER authentication (previously ran before auth,
 *     wasting LLM calls on unauthenticated requests).
 *   - Missing repository capabilities consistently return 501 'not_available'
 *     (previously mixed 500 'not_supported' and 501 'not_implemented').
 *
 * Rate limiting for cold admissions is handled in server.ts before dispatch,
 * since it requires IP-level context that doesn't belong in the action layer.
 */

import { AppError } from './contract.ts';
import type {
  ActorContext,
  LogLlmUsageInput,
  MembershipSummary,
  Repository,
  RequestScope,
  ResponseNotice,
  SharedResponseContext,
} from './contract.ts';
import {
  getAction,
  parseActionInput,
  type ActionDefinition,
  type ActionResult,
  type HandlerContext,
  type ColdHandlerContext,
  type RepositoryCapability,
} from './schemas/registry.ts';
import { runQualityGate as defaultRunQualityGate, QUALITY_GATE_PROVIDER, type QualityGateResult } from './quality-gate.ts';

export type QualityGateFn = (action: string, payload: Record<string, unknown>) => Promise<QualityGateResult>;
import { CLAWCLUB_OPENAI_MODEL } from './ai.ts';

// ── Import all schema modules to trigger registration ────
import './schemas/session.ts';
import './schemas/admissions-cold.ts';
import './schemas/entities.ts';
import './schemas/events.ts';
import './schemas/profile.ts';
import './schemas/messages.ts';
import './schemas/platform.ts';
import './schemas/updates.ts';
import './schemas/admin.ts';
import './schemas/superadmin.ts';
import './schemas/membership.ts';

// ── Authorization helpers ────────────────────────────────

function createRequireAccessibleClub(actor: ActorContext) {
  return (clubId: string): MembershipSummary => {
    const allowed = actor.memberships.find(m => m.clubId === clubId);
    if (!allowed) {
      throw new AppError(403, 'forbidden', 'Requested club is outside your access scope');
    }
    return allowed;
  };
}

function createRequireMembershipOwner(actor: ActorContext) {
  const requireAccessibleClub = createRequireAccessibleClub(actor);
  return (clubId: string): MembershipSummary => {
    const membership = requireAccessibleClub(clubId);
    if (membership.role !== 'clubadmin') {
      throw new AppError(403, 'forbidden', 'This action requires owner membership in the requested club');
    }
    return membership;
  };
}

function createRequireSuperadmin(actor: ActorContext) {
  return (): void => {
    if (!actor.globalRoles.includes('superadmin')) {
      throw new AppError(403, 'forbidden', 'This action requires superadmin role');
    }
  };
}

function createResolveScopedClubs(actor: ActorContext) {
  const requireAccessibleClub = createRequireAccessibleClub(actor);
  return (clubId?: string): MembershipSummary[] => {
    if (clubId !== undefined) {
      return [requireAccessibleClub(clubId)];
    }
    if (actor.memberships.length === 0) {
      throw new AppError(403, 'forbidden', 'This member does not currently have access to any clubs');
    }
    return actor.memberships;
  };
}

// ── Capability check ─────────────────────────────────────

function checkCapability(
  repository: Repository,
  capability: RepositoryCapability,
  action: string,
): void {
  if (!(repository as Record<string, unknown>)[capability]) {
    throw new AppError(501, 'not_available', `Action ${action} is not available in this deployment`);
  }
}

// ── Legality gate handling ────────────────────────────────

function extractRequestedClubId(payload: Record<string, unknown>): string | null {
  const clubId = payload.clubId;
  return typeof clubId === 'string' && clubId.trim().length > 0 ? clubId.trim() : null;
}

function buildLlmLogEntry(
  actionName: string,
  memberId: string | null,
  requestedClubId: string | null,
  gate: QualityGateResult,
): LogLlmUsageInput {
  const base = {
    memberId: memberId ?? null,
    requestedClubId,
    actionName,
    provider: QUALITY_GATE_PROVIDER,
    model: CLAWCLUB_OPENAI_MODEL,
  };

  if (gate.status === 'skipped') {
    return {
      ...base,
      gateStatus: 'skipped',
      skipReason: gate.reason,
      promptTokens: null,
      completionTokens: null,
      providerErrorCode: gate.providerErrorCode ?? null,
    };
  }

  if (gate.status === 'failed') {
    return {
      ...base,
      gateStatus: 'skipped',
      skipReason: gate.reason,
      promptTokens: null,
      completionTokens: null,
      providerErrorCode: gate.providerErrorCode ?? null,
    };
  }

  return {
    ...base,
    gateStatus: gate.status,
    skipReason: null,
    promptTokens: gate.usage.promptTokens,
    completionTokens: gate.usage.completionTokens,
    providerErrorCode: null,
  };
}

function fireAndForgetLlmLog(repository: Repository, entry: LogLlmUsageInput): void {
  if (!repository.logLlmUsage) return;
  repository.logLlmUsage(entry).catch((err) => {
    console.error('Failed to log LLM usage:', err);
  });
}

function gateNotices(_gate: QualityGateResult): ResponseNotice[] {
  return [];
}

// ── Response envelope assembly ───────────────────────────

function assembleAuthenticatedResponse(
  action: string,
  result: ActionResult,
  actor: ActorContext,
  defaultRequestScope: RequestScope,
  sharedContext: SharedResponseContext,
  notices: ResponseNotice[],
) {
  // Apply nextMember if handler provided it (profile.update)
  const member = result.nextMember ?? actor.member;

  // Apply acknowledgedUpdateIds if handler provided them (updates.acknowledge)
  let finalSharedContext = sharedContext;
  if (result.acknowledgedUpdateIds && result.acknowledgedUpdateIds.length > 0) {
    const ackSet = new Set(result.acknowledgedUpdateIds);
    finalSharedContext = {
      pendingUpdates: sharedContext.pendingUpdates.filter(u => !ackSet.has(u.updateId)),
    };
  }

  const envelope: Record<string, unknown> = {
    action,
    actor: {
      member,
      globalRoles: actor.globalRoles,
      activeMemberships: actor.memberships,
      requestScope: result.requestScope ?? defaultRequestScope,
      sharedContext: finalSharedContext,
    },
    data: result.data,
  };

  if (notices.length > 0) {
    envelope.notices = notices;
  }

  return envelope;
}

function assembleUnauthenticatedResponse(action: string, result: ActionResult, notices: ResponseNotice[]) {
  const envelope: Record<string, unknown> = {
    action,
    data: result.data,
  };

  if (notices.length > 0) {
    envelope.notices = notices;
  }

  return envelope;
}

// ── Dispatch ─────────────────────────────────────────────

export type DispatchInput = {
  bearerToken: string | null;
  action: unknown;
  payload?: unknown;
};

export function buildDispatcher({ repository, qualityGate }: { repository: Repository; qualityGate?: QualityGateFn }) {
  const runQualityGate = qualityGate ?? defaultRunQualityGate;
  return {
    async dispatch(input: DispatchInput) {
      // 1. Identify action
      if (typeof input.action !== 'string' || input.action.trim().length === 0) {
        throw new AppError(400, 'invalid_input', 'action must be a non-empty string');
      }
      const actionName = input.action.trim();
      const payload = (input.payload ?? {}) as Record<string, unknown>;

      // 2. Look up contract
      const def = getAction(actionName);
      if (!def) {
        throw new AppError(400, 'unknown_action', `Unsupported action: ${actionName}`);
      }

      // 3. Branch on auth
      if (def.auth === 'none') {
        return await dispatchCold(def, actionName, payload, repository, runQualityGate);
      }

      return await dispatchAuthenticated(def, actionName, payload, input.bearerToken, repository, runQualityGate);
    },
  };
}

async function dispatchCold(
  def: ActionDefinition,
  actionName: string,
  payload: Record<string, unknown>,
  repository: Repository,
  runQualityGate: QualityGateFn,
) {
  // Check capability (safe before auth since cold actions have no auth)
  if (def.requiredCapability) {
    checkCapability(repository, def.requiredCapability, actionName);
  }

  // Parse
  const parsedInput = parseActionInput(def, payload);

  // Legality gate (cold actions currently don't have gates, but support it)
  let notices: ResponseNotice[] = [];
  if (def.qualityGate) {
    const gate = await runQualityGate(actionName, parsedInput as Record<string, unknown>);

    const requestedClubId = extractRequestedClubId(parsedInput as Record<string, unknown>);
    if (!(gate.status === 'skipped' && gate.reason === 'no_gate_for_action')) {
      fireAndForgetLlmLog(repository, buildLlmLogEntry(actionName, null, requestedClubId, gate));
    }

    if (gate.status === 'failed') {
      throw new AppError(503, 'gate_unavailable', `Content gate unavailable (${gate.reason}). Gated actions cannot proceed.`);
    }
    if (gate.status === 'rejected_illegal') {
      throw new AppError(422, 'illegal_content', gate.feedback);
    }
    if (gate.status === 'rejected') {
      throw new AppError(422, 'gate_rejected', gate.feedback);
    }
    notices = gateNotices(gate);
  }

  // Execute
  if (!def.handleCold) {
    throw new AppError(501, 'not_implemented', `Action ${actionName} has no cold handler`);
  }

  const ctx: ColdHandlerContext = { repository };
  const result = await def.handleCold(parsedInput, ctx);

  // Assemble unauthenticated envelope
  return assembleUnauthenticatedResponse(actionName, result, notices);
}

async function dispatchAuthenticated(
  def: ActionDefinition,
  actionName: string,
  payload: Record<string, unknown>,
  bearerToken: string | null,
  repository: Repository,
  runQualityGate: QualityGateFn,
) {
  // Authenticate
  if (typeof bearerToken !== 'string' || bearerToken.trim().length === 0) {
    throw new AppError(400, 'invalid_input', 'Authorization bearer token must be a non-empty string');
  }
  const auth = await repository.authenticateBearerToken(bearerToken);
  if (!auth) {
    throw new AppError(401, 'unauthorized', 'Unknown bearer token');
  }

  const actor = auth.actor;
  const sharedContext = auth.sharedContext ?? { pendingUpdates: [] };
  const defaultRequestScope: RequestScope = {
    requestedClubId: auth.requestScope.requestedClubId,
    activeClubIds: auth.requestScope.activeClubIds,
  };

  // Parse
  const parsedInput = parseActionInput(def, payload);

  // Legality gate (runs on parsed/normalized input, after auth, before execution)
  let notices: ResponseNotice[] = [];
  if (def.qualityGate) {
    const gate = await runQualityGate(actionName, parsedInput as Record<string, unknown>);

    const requestedClubId = extractRequestedClubId(parsedInput as Record<string, unknown>);
    if (!(gate.status === 'skipped' && gate.reason === 'no_gate_for_action')) {
      fireAndForgetLlmLog(repository, buildLlmLogEntry(actionName, actor.member.id, requestedClubId, gate));
    }

    if (gate.status === 'failed') {
      throw new AppError(503, 'gate_unavailable', `Content gate unavailable (${gate.reason}). Gated actions cannot proceed.`);
    }
    if (gate.status === 'rejected_illegal') {
      throw new AppError(422, 'illegal_content', gate.feedback);
    }
    if (gate.status === 'rejected') {
      throw new AppError(422, 'gate_rejected', gate.feedback);
    }
    notices = gateNotices(gate);
  }

  // Execute
  if (!def.handle) {
    throw new AppError(501, 'not_implemented', `Action ${actionName} has no authenticated handler`);
  }

  const ctx: HandlerContext = {
    actor,
    requestScope: defaultRequestScope,
    sharedContext,
    repository,
    requireAccessibleClub: createRequireAccessibleClub(actor),
    requireMembershipOwner: createRequireMembershipOwner(actor),
    requireSuperadmin: createRequireSuperadmin(actor),
    resolveScopedClubs: createResolveScopedClubs(actor),
    requireCapability: (capability) => checkCapability(repository, capability, actionName),
  };

  const result = await def.handle(parsedInput, ctx);

  // Assemble authenticated envelope
  return assembleAuthenticatedResponse(actionName, result, actor, defaultRequestScope, sharedContext, notices);
}
