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
 * Rate limiting for anonymous clubs.join traffic is handled in server.ts before dispatch,
 * since it requires IP-level context that doesn't belong in the action layer.
 */

import { AppError } from './contract.ts';
import type {
  ActorContext,
  LogLlmUsageInput,
  MaybeMemberActorContext,
  MembershipSummary,
  Repository,
  RequestScope,
  ResponseNotice,
  SharedResponseContext,
} from './contract.ts';
import {
  getAction,
  parseActionInput,
  GENERIC_REQUEST_TEMPLATE,
  type ActionDefinition,
  type ActionResult,
  type HandlerContext,
  type ColdHandlerContext,
  type OptionalHandlerContext,
  type RepositoryCapability,
} from './schemas/registry.ts';
import { checkLlmGate as defaultCheckLlmGate, type GateVerdict, type GatedArtifact } from './gate.ts';
import { NOTIFICATIONS_PAGE_SIZE } from './notifications-core.ts';
import { CLAWCLUB_OPENAI_MODEL } from './ai.ts';

const PRE_ONBOARDING_ALLOWED_ACTIONS = new Set(['session.getContext', 'clubs.onboard']);

export type LlmGateFn = (artifact: GatedArtifact) => Promise<GateVerdict>;

// ── Import all schema modules to trigger registration ────
import './schemas/session.ts';
import './schemas/clubs.ts';
import './schemas/invitations.ts';
import './schemas/entities.ts';
import './schemas/events.ts';
import './schemas/profile.ts';
import './schemas/messages.ts';
import './schemas/activity.ts';
import './schemas/notifications.ts';
import './schemas/platform.ts';
import './schemas/superadmin.ts';
import './schemas/billing-sync.ts';
import './schemas/billing.ts';
import './schemas/membership.ts';
import './schemas/clubadmin.ts';
import './schemas/clubowner.ts';

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

function createRequireClubAdmin(actor: ActorContext) {
  return (clubId: string): void => {
    if (actor.globalRoles.includes('superadmin')) return;
    const membership = actor.memberships.find(m => m.clubId === clubId);
    if (!membership) {
      throw new AppError(403, 'forbidden', 'Requested club is outside your access scope');
    }
    if (membership.role !== 'clubadmin') {
      throw new AppError(403, 'forbidden', 'This action requires club admin role in the requested club');
    }
  };
}

function createRequireClubOwner(actor: ActorContext) {
  return (clubId: string): void => {
    if (actor.globalRoles.includes('superadmin')) return;
    const membership = actor.memberships.find(m => m.clubId === clubId);
    if (!membership || !membership.isOwner) {
      throw new AppError(403, 'forbidden', 'This action requires club owner status');
    }
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

function isOnboardingPending(actor: Pick<ActorContext, 'member' | 'memberships'> | Pick<MaybeMemberActorContext, 'member' | 'memberships'>): boolean {
  return actor.member !== null
    && actor.member.onboardedAt === null
    && actor.memberships.length > 0;
}

function assertOnboardingAllowed(actionName: string, actor: Pick<ActorContext, 'member' | 'memberships'> | Pick<MaybeMemberActorContext, 'member' | 'memberships'>): void {
  if (!isOnboardingPending(actor)) {
    return;
  }
  if (PRE_ONBOARDING_ALLOWED_ACTIONS.has(actionName)) {
    return;
  }
  throw new AppError(
    403,
    'onboarding_required',
    'You are authenticated but haven\'t completed onboarding yet. Call clubs.onboard to receive your welcome and activate your membership. No other action will succeed until this is done.',
  );
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

// ── Gate handling ────────────────────────────────────────

function extractRequestedClubId(payload: Record<string, unknown>): string | null {
  const clubId = payload.clubId;
  return typeof clubId === 'string' && clubId.trim().length > 0 ? clubId.trim() : null;
}

function buildLlmLogEntry(
  actionName: string,
  memberId: string | null,
  requestedClubId: string | null,
  artifactKind: GatedArtifact['kind'],
  gate: GateVerdict,
): LogLlmUsageInput {
  const base = {
    memberId: memberId ?? null,
    requestedClubId,
    actionName,
    artifactKind,
    provider: 'openai',
    model: CLAWCLUB_OPENAI_MODEL,
  };

  if (gate.status === 'skipped') {
    return {
      ...base,
      gateStatus: 'skipped',
      skipReason: gate.reason,
      promptTokens: null,
      completionTokens: null,
      providerErrorCode: null,
      feedback: null,
    };
  }

  if (gate.status === 'failed') {
    return {
      ...base,
      gateStatus: 'failed',
      skipReason: null,
      promptTokens: null,
      completionTokens: null,
      providerErrorCode: gate.errorCode,
      feedback: null,
    };
  }

  return {
    ...base,
    gateStatus: gate.status,
    skipReason: null,
    promptTokens: gate.usage.promptTokens,
    completionTokens: gate.usage.completionTokens,
    providerErrorCode: null,
    feedback: gate.status === 'passed' ? null : gate.feedback,
  };
}

function fireAndForgetLlmLog(repository: Repository, entry: LogLlmUsageInput): void {
  if (!repository.logLlmUsage) return;
  repository.logLlmUsage(entry).catch((err) => {
    console.error('Failed to log LLM usage:', err);
  });
}

function verdictToHttpError(verdict: GateVerdict): AppError | null {
  switch (verdict.status) {
    case 'passed':
      return null;
    case 'rejected_illegal':
      return new AppError(422, 'illegal_content', verdict.feedback);
    case 'rejected_quality':
      return new AppError(422, 'low_quality_content', verdict.feedback);
    case 'rejected_malformed':
      return new AppError(422, 'gate_rejected', verdict.feedback);
    case 'skipped':
    case 'failed':
      return new AppError(503, 'gate_unavailable', `Content gate unavailable (${verdict.reason}).`);
  }
}

async function runLlmGateFor(
  def: ActionDefinition,
  parsedInput: unknown,
  actor: ActorContext | null,
  repository: Repository,
  requestedClubId: string | null,
  runLlmGate: LlmGateFn,
): Promise<void> {
  if (!def.llmGate) return;
  if (!actor) {
    throw new AppError(500, 'invalid_data', `Action ${def.action} declared llmGate without an authenticated actor`);
  }

  const artifact = await def.llmGate.buildArtifact(parsedInput, { actor, repository });
  const verdict = await runLlmGate(artifact);
  fireAndForgetLlmLog(
    repository,
    buildLlmLogEntry(def.action, actor.member.id, requestedClubId, artifact.kind, verdict),
  );

  const err = verdictToHttpError(verdict);
  if (err) throw err;
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
  const finalNotices = notices.concat(result.notices ?? []);

  // Apply nextMember if handler provided it (profile.update)
  const member = result.nextMember ?? { id: actor.member.id, publicName: actor.member.publicName };

  // Apply acknowledgedNotificationIds if handler provided them.
  let finalSharedContext = sharedContext;
  if (result.acknowledgedNotificationIds && result.acknowledgedNotificationIds.length > 0) {
    const ackSet = new Set(result.acknowledgedNotificationIds);
    finalSharedContext = {
      notifications: sharedContext.notifications.filter((item) => !ackSet.has(item.notificationId)),
      notificationsTruncated: sharedContext.notificationsTruncated,
    };
  }

  const envelope: Record<string, unknown> = {
    action,
    actor: {
      member,
      onboardingPending: isOnboardingPending(actor),
      globalRoles: actor.globalRoles,
      activeMemberships: actor.memberships,
      requestScope: result.requestScope ?? defaultRequestScope,
      sharedContext: finalSharedContext,
    },
    data: result.data,
  };

  if (finalNotices.length > 0) {
    envelope.notices = finalNotices;
  }

  return envelope;
}

function assembleUnauthenticatedResponse(action: string, result: ActionResult, notices: ResponseNotice[]) {
  const finalNotices = notices.concat(result.notices ?? []);
  const envelope: Record<string, unknown> = {
    action,
    data: result.data,
  };

  if (finalNotices.length > 0) {
    envelope.notices = finalNotices;
  }

  return envelope;
}

// ── Dispatch ─────────────────────────────────────────────

export type DispatchInput = {
  bearerToken: string | null;
  action: unknown;
  payload?: unknown;
};

export function buildDispatcher({ repository, llmGate }: { repository: Repository; llmGate?: LlmGateFn }) {
  const runLlmGate = llmGate ?? defaultCheckLlmGate;
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
        const err = new AppError(400, 'unknown_action', `Unsupported action: ${actionName}`);
        err.requestTemplate = GENERIC_REQUEST_TEMPLATE;
        throw err;
      }

      // 3. Branch on auth
      if (def.auth === 'none') {
        return await dispatchCold(def, actionName, payload, repository, runLlmGate);
      }
      if (def.auth === 'optional_member') {
        return await dispatchOptionalMember(def, actionName, payload, input.bearerToken, repository, runLlmGate);
      }

      return await dispatchAuthenticated(def, actionName, payload, input.bearerToken, repository, runLlmGate);
    },
  };
}

async function dispatchCold(
  def: ActionDefinition,
  actionName: string,
  payload: Record<string, unknown>,
  repository: Repository,
  runLlmGate: LlmGateFn,
) {
  // Check capability (safe before auth since cold actions have no auth)
  if (def.requiredCapability) {
    checkCapability(repository, def.requiredCapability, actionName);
  }

  // Parse
  const parsedInput = parseActionInput(def, payload);

  await runLlmGateFor(def, parsedInput, null, repository, extractRequestedClubId(parsedInput as Record<string, unknown>), runLlmGate);
  const notices: ResponseNotice[] = [];

  // Execute
  if (!def.handleCold) {
    throw new AppError(501, 'not_implemented', `Action ${actionName} has no cold handler`);
  }

  const ctx: ColdHandlerContext = { repository };
  const result = await def.handleCold(parsedInput, ctx);

  // Assemble unauthenticated envelope
  return assembleUnauthenticatedResponse(actionName, result, notices);
}

async function dispatchOptionalMember(
  def: ActionDefinition,
  actionName: string,
  payload: Record<string, unknown>,
  bearerToken: string | null,
  repository: Repository,
  runLlmGate: LlmGateFn,
) {
  let actor: MaybeMemberActorContext = { member: null, memberships: [], globalRoles: [] };
  let sharedContext: SharedResponseContext = { notifications: [], notificationsTruncated: false };
  let defaultRequestScope: RequestScope = { requestedClubId: null, activeClubIds: [] };
  let notificationsMemo: Promise<{ items: import('./contract.ts').NotificationItem[]; nextAfter: string | null }> | null = null;

  if (bearerToken !== null) {
    if (typeof bearerToken !== 'string' || bearerToken.trim().length === 0) {
      throw new AppError(401, 'unauthorized', 'Authorization bearer token must be a non-empty string');
    }
    const auth = await repository.authenticateBearerToken(bearerToken);
    if (!auth) {
      throw new AppError(401, 'unauthorized', 'Unknown bearer token');
    }
    actor = auth.actor;
    sharedContext = auth.sharedContext ?? { notifications: [], notificationsTruncated: false };
    defaultRequestScope = {
      requestedClubId: auth.requestScope.requestedClubId,
      activeClubIds: auth.requestScope.activeClubIds,
    };
  }

  assertOnboardingAllowed(actionName, actor);

  if (def.requiredCapability) {
    checkCapability(repository, def.requiredCapability, actionName);
  }

  const parsedInput = parseActionInput(def, payload);

  await runLlmGateFor(
    def,
    parsedInput,
    actor.member ? actor as ActorContext : null,
    repository,
    extractRequestedClubId(parsedInput as Record<string, unknown>),
    runLlmGate,
  );
  const notices: ResponseNotice[] = [];

  if (!def.handleOptionalMember) {
    throw new AppError(501, 'not_implemented', `Action ${actionName} has no optional-member handler`);
  }

  const ctx: OptionalHandlerContext = {
    actor,
    bearerToken,
    requestScope: defaultRequestScope,
    sharedContext,
    repository,
    getNotifications: async () => {
      if (!actor.member) return { items: [], nextAfter: null };
      if (!notificationsMemo) {
        const accessibleClubIds = actor.memberships.map((membership) => membership.clubId);
        const adminClubIds = actor.memberships
          .filter((membership) => membership.role === 'clubadmin')
          .map((membership) => membership.clubId);
        notificationsMemo = repository.listNotifications({
          actorMemberId: actor.member.id,
          accessibleClubIds,
          adminClubIds,
          limit: NOTIFICATIONS_PAGE_SIZE,
          after: null,
        });
      }
      return notificationsMemo;
    },
    requireCapability: (capability: RepositoryCapability) => checkCapability(repository, capability, actionName),
  };

  const result = await def.handleOptionalMember(parsedInput, ctx);

  if (actor.member) {
    return assembleAuthenticatedResponse(actionName, result, actor as ActorContext, defaultRequestScope, sharedContext, notices);
  }
  return assembleUnauthenticatedResponse(actionName, result, notices);
}

async function dispatchAuthenticated(
  def: ActionDefinition,
  actionName: string,
  payload: Record<string, unknown>,
  bearerToken: string | null,
  repository: Repository,
  runLlmGate: LlmGateFn,
) {
  // Authenticate
  if (typeof bearerToken !== 'string' || bearerToken.trim().length === 0) {
    throw new AppError(401, 'unauthorized', 'Authorization bearer token must be a non-empty string');
  }
  const auth = await repository.authenticateBearerToken(bearerToken);
  if (!auth) {
    throw new AppError(401, 'unauthorized', 'Unknown bearer token');
  }

  let actor = auth.actor;
  assertOnboardingAllowed(actionName, actor);
  const sharedContext = auth.sharedContext ?? { notifications: [], notificationsTruncated: false };
  let defaultRequestScope: RequestScope = {
    requestedClubId: auth.requestScope.requestedClubId,
    activeClubIds: auth.requestScope.activeClubIds,
  };
  let notificationsMemo: Promise<{ items: import('./contract.ts').NotificationItem[]; nextAfter: string | null }> | null = null;

  // Parse
  const parsedInput = parseActionInput(def, payload);

  // Pre-gate club access check: reject unauthorized requests before running the LLM gate
  if (def.llmGate) {
    const requestedClubId = extractRequestedClubId(parsedInput as Record<string, unknown>);
    if (requestedClubId && !auth.requestScope.activeClubIds.includes(requestedClubId)) {
      throw new AppError(403, 'forbidden', 'Requested club is outside your access scope');
    }
  }

  if (def.preGate) {
    await def.preGate(parsedInput, { actor, repository });
  }

  // Legality gate (runs on parsed/normalized input, after auth, before execution)
  await runLlmGateFor(
    def,
    parsedInput,
    actor,
    repository,
    extractRequestedClubId(parsedInput as Record<string, unknown>),
    runLlmGate,
  );
  const notices: ResponseNotice[] = [];

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
    requireClubAdmin: createRequireClubAdmin(actor),
    requireClubOwner: createRequireClubOwner(actor),
    requireSuperadmin: createRequireSuperadmin(actor),
    resolveScopedClubs: createResolveScopedClubs(actor),
    getNotifications: () => {
      if (typeof repository.listNotifications !== 'function') {
        return Promise.resolve({ items: [], nextAfter: null });
      }
      if (!notificationsMemo) {
        const accessibleClubIds = actor.memberships.map((membership) => membership.clubId);
        const adminClubIds = actor.memberships
          .filter((membership) => membership.role === 'clubadmin')
          .map((membership) => membership.clubId);
        notificationsMemo = repository.listNotifications({
          actorMemberId: actor.member.id,
          accessibleClubIds,
          adminClubIds,
          limit: NOTIFICATIONS_PAGE_SIZE,
          after: null,
        });
      }
      return notificationsMemo;
    },
    requireCapability: (capability) => checkCapability(repository, capability, actionName),
  };

  const result = await def.handle(parsedInput, ctx);

  if (actionName === 'clubs.onboard') {
    const refreshed = repository.validateBearerTokenPassive
      ? await repository.validateBearerTokenPassive(bearerToken)
      : await repository.authenticateBearerToken(bearerToken);
    if (refreshed) {
      actor = refreshed.actor;
      defaultRequestScope = {
        requestedClubId: refreshed.requestScope.requestedClubId,
        activeClubIds: refreshed.requestScope.activeClubIds,
      };
      notificationsMemo = null;
    }
  }

  let nextSharedContext: SharedResponseContext;
  try {
    const notifications = await ctx.getNotifications();
    nextSharedContext = {
      notifications: notifications.items,
      notificationsTruncated: notifications.nextAfter !== null,
    };
  } catch (error) {
    console.error('Failed to populate shared notifications:', error);
    nextSharedContext = {
      notifications: [],
      notificationsTruncated: false,
    };
  }

  // Assemble authenticated envelope
  return assembleAuthenticatedResponse(actionName, result, actor, defaultRequestScope, nextSharedContext, notices);
}
