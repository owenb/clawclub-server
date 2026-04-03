/**
 * Unified action dispatcher.
 *
 * Replaces the sequential handler chain in app.ts with a registry-based
 * dispatch. All actions are looked up in the contract registry. The pipeline is:
 *
 *   1. Identify action (look up contract in registry)
 *   2. For auth:none → parse → quality gate → execute
 *      For authenticated → authenticate → parse → quality gate → authorize → execute
 *   3. Assemble canonical response envelope
 *
 * Behavioral change from previous code:
 *   - Quality gate now runs AFTER authentication (previously ran before auth,
 *     wasting LLM calls on unauthenticated requests).
 *   - Missing repository capabilities consistently return 501 'not_available'
 *     (previously mixed 500 'not_supported' and 501 'not_implemented').
 *
 * Rate limiting for cold admissions is handled in server.ts before dispatch,
 * since it requires IP-level context that doesn't belong in the action layer.
 */

import { AppError } from './app.ts';
import type {
  ActorContext,
  MembershipSummary,
  Repository,
  RequestScope,
  SharedResponseContext,
} from './app-contract.ts';
import {
  getAction,
  parseActionInput,
  type ActionDefinition,
  type ActionResult,
  type HandlerContext,
  type ColdHandlerContext,
  type RepositoryCapability,
} from './schemas/registry.ts';
import { runQualityGate } from './quality-gate.ts';

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
import './schemas/admissions.ts';

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
    if (membership.role !== 'owner') {
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

// ── Response envelope assembly ───────────────────────────

function assembleAuthenticatedResponse(
  action: string,
  result: ActionResult,
  actor: ActorContext,
  defaultRequestScope: RequestScope,
  sharedContext: SharedResponseContext,
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

  return {
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
}

function assembleUnauthenticatedResponse(action: string, result: ActionResult) {
  return {
    action,
    data: result.data,
  };
}

// ── Dispatch ─────────────────────────────────────────────

export type DispatchInput = {
  bearerToken: string | null;
  action: unknown;
  payload?: unknown;
};

export function buildDispatcher({ repository }: { repository: Repository }) {
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
        return await dispatchCold(def, actionName, payload, repository);
      }

      return await dispatchAuthenticated(def, actionName, payload, input.bearerToken, repository);
    },
  };
}

async function dispatchCold(
  def: ActionDefinition,
  actionName: string,
  payload: Record<string, unknown>,
  repository: Repository,
) {
  // Check capability (safe before auth since cold actions have no auth)
  if (def.requiredCapability) {
    checkCapability(repository, def.requiredCapability, actionName);
  }

  // Parse
  const parsedInput = parseActionInput(def, payload);

  // Quality gate (cold actions currently don't have quality gates, but support it)
  if (def.qualityGate) {
    const gate = await runQualityGate(actionName, parsedInput as Record<string, unknown>);
    if (!gate.pass) {
      throw new AppError(422, 'quality_check_failed', (gate as { pass: false; feedback: string }).feedback);
    }
  }

  // Execute
  if (!def.handleCold) {
    throw new AppError(501, 'not_implemented', `Action ${actionName} has no cold handler`);
  }

  const ctx: ColdHandlerContext = { repository };
  const result = await def.handleCold(parsedInput, ctx);

  // Assemble unauthenticated envelope
  return assembleUnauthenticatedResponse(actionName, result);
}

async function dispatchAuthenticated(
  def: ActionDefinition,
  actionName: string,
  payload: Record<string, unknown>,
  bearerToken: string | null,
  repository: Repository,
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

  // Quality gate (runs on parsed/normalized input, after auth, before execution)
  if (def.qualityGate) {
    const gate = await runQualityGate(actionName, parsedInput as Record<string, unknown>);
    if (!gate.pass) {
      throw new AppError(422, 'quality_check_failed', (gate as { pass: false; feedback: string }).feedback);
    }
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
  return assembleAuthenticatedResponse(actionName, result, actor, defaultRequestScope, sharedContext);
}
