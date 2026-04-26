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
 *
 * Any anonymous rate limiting is handled in server.ts before dispatch,
 * since it requires IP-level context that doesn't belong in the action layer.
 */

import { AppError } from './errors.ts';
import type {
  LogApiRequestInput,
  LogLlmUsageInput,
  MembershipSummary,
  Repository,
} from './repository.ts';
import type { Actor, AuthenticatedActor, RequestScope } from './actors.ts';
import type { ResponseNotice, ResponseNotifications } from './notifications.ts';
import {
  getAction,
  parseActionInput,
  GENERIC_REQUEST_TEMPLATE,
  type ActionDefinition,
  type ActionResult,
  type HandlerContext,
  type ColdHandlerContext,
  type OptionalHandlerContext,
} from './schemas/registry.ts';
import {
  checkLlmGate as defaultCheckLlmGate,
  type GateVerdict,
  type GatedArtifact,
  type NonApplicationArtifact,
} from './gate.ts';
import {
  buildGateLlmLogEntry,
  gateVerdictToAppError,
  logMalformedGateVerdict,
} from './gate-results.ts';
import { fetchNotifications } from './notifications-core.ts';
import { CLAWCLUB_OPENAI_MODEL } from './ai.ts';
import { estimateGateSpend } from './club-spend.ts';
import { getLlmGateMaxOutputTokens } from './quotas.ts';
import { QUOTA_ACTIONS } from './quota-metadata.ts';
import { fireAndForgetRequestLog, logger } from './logger.ts';

export type LlmGateFn = (artifact: NonApplicationArtifact, options?: { maxOutputTokens?: number }) => Promise<GateVerdict>;

// ── Import all schema modules to trigger registration ────
import './schemas/session.ts';
import './schemas/accounts.ts';
import './schemas/clubs.ts';
import './schemas/invitations.ts';
import './schemas/content.ts';
import './schemas/events.ts';
import './schemas/messages.ts';
import './schemas/updates.ts';
import './schemas/platform.ts';
import './schemas/superadmin.ts';
import './schemas/membership.ts';
import './schemas/clubadmin.ts';

const UNKNOWN_ACTION_REFRESH_MESSAGE = [
  'The server has been updated since you last fetched its contract.',
  'Re-curl the skill and schema files, replace your cached copies, and then retry this request:',
  '',
  '1. curl <base-url>/skill',
  '2. curl <base-url>/api/schema',
].join('\n');

// ── Authorization helpers ────────────────────────────────

function createRequireAccessibleClub(actor: AuthenticatedActor) {
  return (clubId: string): MembershipSummary => {
    const allowed = actor.memberships.find(m => m.clubId === clubId);
    if (!allowed) {
      throw new AppError('forbidden', 'Requested club is outside your access scope');
    }
    return allowed;
  };
}

function createRequireClubAdmin(actor: AuthenticatedActor) {
  return (clubId: string): void => {
    if (actor.globalRoles.includes('superadmin')) return;
    const membership = actor.memberships.find(m => m.clubId === clubId);
    if (!membership) {
      throw new AppError('forbidden', 'Requested club is outside your access scope');
    }
    if (membership.role !== 'clubadmin') {
      throw new AppError('forbidden', 'This action requires club admin role in the requested club');
    }
  };
}

function createRequireClubOwner(actor: AuthenticatedActor) {
  return (clubId: string): void => {
    if (actor.globalRoles.includes('superadmin')) return;
    const membership = actor.memberships.find(m => m.clubId === clubId);
    if (!membership || !membership.isOwner) {
      throw new AppError('forbidden', 'This action requires club owner status');
    }
  };
}

function createRequireSuperadmin(actor: AuthenticatedActor) {
  return (): void => {
    if (!actor.globalRoles.includes('superadmin')) {
      throw new AppError('forbidden', 'This action requires superadmin role');
    }
  };
}

function createResolveScopedClubs(actor: AuthenticatedActor) {
  const requireAccessibleClub = createRequireAccessibleClub(actor);
  return (clubId?: string): MembershipSummary[] => {
    if (clubId !== undefined) {
      return [requireAccessibleClub(clubId)];
    }
    if (actor.memberships.length === 0) {
      throw new AppError('forbidden', 'This member does not currently have access to any clubs');
    }
    return actor.memberships;
  };
}

function preAuthorizeAuthenticatedAction(
  def: Pick<ActionDefinition, 'auth' | 'action'>,
  parsedInput: unknown,
  actor: AuthenticatedActor,
): void {
  if (def.auth === 'superadmin') {
    createRequireSuperadmin(actor)();
    return;
  }
  if (def.auth !== 'clubadmin') {
    return;
  }

  const requestedClubId = extractRequestedClubId(parsedInput as Record<string, unknown>);
  if (!requestedClubId) {
    throw new AppError('invalid_data', `Action ${def.action} declared clubadmin auth without a clubId input`);
  }
  createRequireClubAdmin(actor)(requestedClubId);
}

// ── Gate handling ────────────────────────────────────────

function extractRequestedClubId(payload: Record<string, unknown>): string | null {
  const clubId = payload.clubId;
  return typeof clubId === 'string' && clubId.trim().length > 0 ? clubId.trim() : null;
}

function fireAndForgetLlmLog(repository: Repository, entry: LogLlmUsageInput): void {
  if (!repository.logLlmUsage) return;
  repository.logLlmUsage(entry).catch((err) => {
    logger.error('llm_usage_log_failure', err, { actionName: entry.actionName });
  });
}

async function safeReleaseClubSpendBudget(
  repository: Repository,
  reservationId: string,
  context: { actionName: string; phase: string },
): Promise<void> {
  if (!repository.releaseClubSpendBudget) {
    return;
  }
  try {
    await repository.releaseClubSpendBudget({ reservationId });
  } catch (error) {
    logger.error('club_spend_release_failed', error, {
      actionName: context.actionName,
      phase: context.phase,
      reservationId,
    });
  }
}

async function safeFinalizeLlmOutputBudget(
  repository: Repository,
  input: { reservationId: string; actualOutputTokens: number },
  context: { actionName: string; phase: string },
): Promise<void> {
  if (!repository.finalizeLlmOutputBudget) {
    return;
  }
  try {
    await repository.finalizeLlmOutputBudget(input);
  } catch (error) {
    logger.error('llm_output_budget_finalize_failed', error, {
      actionName: context.actionName,
      phase: context.phase,
      reservationId: input.reservationId,
    });
  }
}

async function runLlmGateFor(
  def: ActionDefinition,
  parsedInput: unknown,
  actor: AuthenticatedActor | null,
  repository: Repository,
  requestedClubId: string | null,
  runLlmGate: LlmGateFn,
): Promise<void> {
  if (!def.llmGate) return;
  if (!actor) {
    throw new AppError('invalid_data', `Action ${def.action} declared llmGate without an authenticated actor`);
  }
  const llmGate = def.llmGate;

  const runUnlocked = async (): Promise<void> => {
    if (def.idempotency && repository.peekIdempotencyReplay) {
      const clientKey = def.idempotency.getClientKey(parsedInput);
      if (clientKey) {
        const scopeKey = def.idempotency.getScopeKey(parsedInput, { actor });
        const requestValue = def.idempotency.getRequestValue
          ? def.idempotency.getRequestValue(parsedInput, { actor })
          : parsedInput;
        const replayHit = await repository.peekIdempotencyReplay({
          clientKey,
          actorContext: scopeKey,
          requestValue,
        });
        if (replayHit) {
          return;
        }
      }
    }

    const gateCtx = { actor, repository };
    if (llmGate.shouldSkip && await llmGate.shouldSkip(parsedInput, gateCtx)) {
      return;
    }
    const artifact = await llmGate.buildArtifact(parsedInput, gateCtx);
    const budgetClubId = llmGate.resolveBudgetClubId
      ? await llmGate.resolveBudgetClubId(parsedInput, gateCtx)
      : requestedClubId;

    if (budgetClubId === null) {
      throw new AppError('invalid_data', `Action ${def.action} declared llmGate without a resolved budget club`);
    }

    if (!repository.reserveLlmOutputBudget || !repository.finalizeLlmOutputBudget) {
      throw new AppError('invalid_data', `Action ${def.action} declared llmGate without budget reservation/finalization plumbing`);
    }
    if (!repository.reserveClubSpendBudget || !repository.finalizeClubSpendBudget || !repository.releaseClubSpendBudget) {
      throw new AppError('invalid_data', `Action ${def.action} declared llmGate without club spend reservation/finalization plumbing`);
    }

    const maxOutputTokens = getLlmGateMaxOutputTokens();
    const spendEstimate = estimateGateSpend(artifact, maxOutputTokens);
    const spendReservation = await repository.reserveClubSpendBudget({
      clubId: budgetClubId,
      memberId: actor.member.id,
      actionName: def.action,
      usageKind: 'gate',
      provider: 'openai',
      model: CLAWCLUB_OPENAI_MODEL,
      reservedMicroCents: spendEstimate.reservedMicroCents,
      reservedInputTokensEstimate: spendEstimate.reservedInputTokensEstimate,
      reservedOutputTokens: spendEstimate.reservedOutputTokens,
    });

    let outputReservationId: string;
    try {
      const reservation = await repository.reserveLlmOutputBudget({
        memberId: actor.member.id,
        clubId: budgetClubId,
        actionName: def.action,
        provider: 'openai',
        model: CLAWCLUB_OPENAI_MODEL,
        maxOutputTokens,
      });
      outputReservationId = reservation.reservationId;
    } catch (error) {
      await safeReleaseClubSpendBudget(repository, spendReservation.reservationId, {
        actionName: def.action,
        phase: 'reserve_llm_output_budget',
      });
      throw error;
    }

    let verdict: GateVerdict;
    try {
      verdict = await runLlmGate(artifact, { maxOutputTokens });
    } catch (error) {
      await safeReleaseClubSpendBudget(repository, spendReservation.reservationId, {
        actionName: def.action,
        phase: 'run_llm_gate',
      });
      await safeFinalizeLlmOutputBudget(repository, {
        reservationId: outputReservationId,
        actualOutputTokens: 0,
      }, {
        actionName: def.action,
        phase: 'run_llm_gate',
      });
      throw error;
    }

    let actualPromptTokens = 0;
    let actualCompletionTokens = 0;
    const billableVerdict = verdict.status === 'passed'
      || verdict.status === 'rejected_illegal'
      || verdict.status === 'rejected_quality'
      || verdict.status === 'rejected_malformed';
    if (
      verdict.status === 'passed'
      || verdict.status === 'rejected_illegal'
      || verdict.status === 'rejected_quality'
      || verdict.status === 'rejected_malformed'
    ) {
      actualPromptTokens = verdict.usage.promptTokens;
      actualCompletionTokens = verdict.usage.completionTokens;
    }

    if (billableVerdict) {
      await repository.finalizeClubSpendBudget({
        reservationId: spendReservation.reservationId,
        usageKind: 'gate',
        actualPromptTokens,
        actualCompletionTokens,
      });
    } else {
      await safeReleaseClubSpendBudget(repository, spendReservation.reservationId, {
        actionName: def.action,
        phase: `verdict:${verdict.status}`,
      });
    }

    await repository.finalizeLlmOutputBudget({
      reservationId: outputReservationId,
      actualOutputTokens: actualCompletionTokens,
    });

    logMalformedGateVerdict({
      actionName: def.action,
      memberId: actor.member.id,
      requestedClubId: budgetClubId ?? requestedClubId,
      artifactKind: artifact.kind,
      verdict,
    });

    fireAndForgetLlmLog(
      repository,
      buildGateLlmLogEntry({
        actionName: def.action,
        memberId: actor.member.id,
        requestedClubId: budgetClubId ?? requestedClubId,
        artifactKind: artifact.kind,
        verdict,
      }),
    );

    const err = gateVerdictToAppError(verdict);
    if (err) throw err;
  };

  await runUnlocked();
}

async function runQuotaFor(
  def: ActionDefinition,
  parsedInput: unknown,
  actor: AuthenticatedActor,
  repository: Repository,
): Promise<void> {
  if (!def.quotaAction) {
    return;
  }

  if (def.idempotency && repository.peekIdempotencyReplay) {
    const clientKey = def.idempotency.getClientKey(parsedInput);
    if (clientKey) {
      const scopeKey = def.idempotency.getScopeKey(parsedInput, { actor });
      const requestValue = def.idempotency.getRequestValue
        ? def.idempotency.getRequestValue(parsedInput, { actor })
        : parsedInput;
      const replayHit = await repository.peekIdempotencyReplay({
        clientKey,
        actorContext: scopeKey,
        requestValue,
      });
      if (replayHit) {
        return;
      }
    }
  }

  switch (def.quotaAction) {
    case QUOTA_ACTIONS.contentCreate: {
      const gateCtx = { actor, repository };
      const clubId = def.llmGate?.resolveBudgetClubId
        ? await def.llmGate.resolveBudgetClubId(parsedInput, gateCtx)
        : extractRequestedClubId(parsedInput as Record<string, unknown>);
      if (!clubId) {
        throw new AppError('invalid_data', `Action ${def.action} declared quotaAction without a resolved club`);
      }
      if (!repository.enforceContentCreateQuota) {
        throw new AppError('invalid_data', `Action ${def.action} declared quotaAction without quota enforcement plumbing`);
      }
      await repository.enforceContentCreateQuota({
        memberId: actor.member.id,
        clubId,
      });
      return;
    }
    default:
      throw new AppError('invalid_data', `Unsupported quotaAction on ${def.action}`);
  }
}

async function executeWithClientKeyBarrierIfPresent<T>(
  def: ActionDefinition,
  parsedInput: unknown,
  actor: AuthenticatedActor | null,
  repository: Repository,
  execute: () => Promise<T>,
): Promise<T> {
  if (!def.idempotency) {
    return execute();
  }

  const clientKey = def.idempotency.getClientKey(parsedInput);
  if (!clientKey) {
    return execute();
  }
  if (!actor) {
    throw new AppError('invalid_data', `Action ${def.action} declared idempotency without an authenticated actor`);
  }

  if (!repository.withClientKeyBarrier) {
    throw new AppError('invalid_data', `Action ${def.action} declared idempotency without clientKey replay barrier plumbing`);
  }

  return repository.withClientKeyBarrier({
    clientKey,
    actorContext: def.idempotency.getScopeKey(parsedInput, { actor }),
    execute,
  });
}

// ── Response envelope assembly ───────────────────────────

function assembleAuthenticatedResponse(
  action: string,
  result: ActionResult,
  actor: AuthenticatedActor,
  defaultRequestScope: RequestScope,
  sharedContext: ResponseNotifications,
  notices: ResponseNotice[],
) {
  const finalNotices = notices.concat(result.notices ?? []);

  // Apply nextMember if handler provided it (members.updateProfile)
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
  clientIp?: string | null;
  stampAuthenticatedMemberId?: (memberId: string) => void;
};

export function buildDispatcher({ repository, llmGate }: { repository: Repository; llmGate?: LlmGateFn }) {
  const runLlmGate = llmGate ?? (defaultCheckLlmGate as LlmGateFn);
  return {
    async dispatch(input: DispatchInput) {
      // 1. Identify action
      if (typeof input.action !== 'string' || input.action.trim().length === 0) {
        throw new AppError('invalid_input', 'action must be a non-empty string');
      }
      const actionName = input.action.trim();
      const payload = (input.payload ?? {}) as Record<string, unknown>;

      // 2. Look up contract
      const def = getAction(actionName);
      if (!def) {
        if (typeof input.bearerToken === 'string' && input.bearerToken.trim().length > 0 && repository.validateBearerTokenPassive) {
          try {
            const auth = await repository.validateBearerTokenPassive(input.bearerToken);
            if (auth) {
              input.stampAuthenticatedMemberId?.(auth.actor.member.id);
              fireAndForgetRequestLog(repository, {
                memberId: auth.actor.member.id,
                actionName,
                ipAddress: input.clientIp ?? null,
              });
            }
          } catch (error) {
            logger.error('unknown_action_request_log_failed', error, { actionName });
          }
        }
        const err = new AppError(
          'unknown_action',
          `Unsupported action: ${actionName}\n\n${UNKNOWN_ACTION_REFRESH_MESSAGE}`,
        );
        err.requestTemplate = GENERIC_REQUEST_TEMPLATE;
        throw err;
      }

      // 3. Branch on auth
      if (def.auth === 'none') {
        return await dispatchCold(def, actionName, payload, repository, runLlmGate);
      }
      if (def.auth === 'optional_member') {
        return await dispatchOptionalMember(
          def,
          actionName,
          payload,
          input.bearerToken,
          repository,
          runLlmGate,
          input.stampAuthenticatedMemberId,
        );
      }

      return await dispatchAuthenticated(
        def,
        actionName,
        payload,
        input.bearerToken,
        input.clientIp ?? null,
        repository,
        runLlmGate,
        input.stampAuthenticatedMemberId,
      );
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

  // Parse
  const parsedInput = parseActionInput(def, payload);

  return executeWithClientKeyBarrierIfPresent(def, parsedInput, null, repository, async () => {
    await runLlmGateFor(def, parsedInput, null, repository, extractRequestedClubId(parsedInput as Record<string, unknown>), runLlmGate);
    const notices: ResponseNotice[] = [];

    if (!def.handleCold) {
      throw new AppError('not_implemented', `Action ${actionName} has no cold handler`);
    }

    const ctx: ColdHandlerContext = { repository };
    const result = await def.handleCold(parsedInput, ctx);
    return assembleUnauthenticatedResponse(actionName, result, notices);
  });
}

async function dispatchOptionalMember(
  def: ActionDefinition,
  actionName: string,
  payload: Record<string, unknown>,
  bearerToken: string | null,
  repository: Repository,
  runLlmGate: LlmGateFn,
  stampAuthenticatedMemberId?: (memberId: string) => void,
) {
  let actor: Actor = { kind: 'anonymous', memberships: [], globalRoles: [] };
  let sharedContext: ResponseNotifications = { notifications: [], notificationsTruncated: false };
  let defaultRequestScope: RequestScope = { requestedClubId: null, activeClubIds: [] };
  let notificationsMemo: Promise<{ items: import('./repository.ts').NotificationItem[]; nextCursor: string | null }> | null = null;

  if (bearerToken !== null) {
    if (typeof bearerToken !== 'string' || bearerToken.trim().length === 0) {
      throw new AppError('unauthorized', 'Authorization bearer token must be a non-empty string');
    }
    const auth = await repository.authenticateBearerToken(bearerToken);
    if (!auth) {
      throw new AppError('unauthorized', 'Unknown bearer token');
    }
    actor = auth.actor;
    const authenticatedActor = auth.actor;
    stampAuthenticatedMemberId?.(authenticatedActor.member.id);
    sharedContext = auth.sharedContext ?? { notifications: [], notificationsTruncated: false };
    defaultRequestScope = {
      requestedClubId: auth.requestScope.requestedClubId,
      activeClubIds: auth.requestScope.activeClubIds,
    };
  }

  const parsedInput = parseActionInput(def, payload);

  return executeWithClientKeyBarrierIfPresent(
    def,
    parsedInput,
    actor.kind === 'authenticated' ? actor : null,
    repository,
    async () => {
      await runLlmGateFor(
        def,
        parsedInput,
        actor.kind === 'authenticated' ? actor : null,
        repository,
        extractRequestedClubId(parsedInput as Record<string, unknown>),
        runLlmGate,
      );
      const notices: ResponseNotice[] = [];

      if (!def.handleOptionalMember) {
        throw new AppError('not_implemented', `Action ${actionName} has no optional-member handler`);
      }

      const ctx: OptionalHandlerContext = {
        actor,
        bearerToken,
        requestScope: defaultRequestScope,
        sharedContext,
        repository,
        getNotifications: async () => {
          if (actor.kind !== 'authenticated') return { items: [], nextCursor: null };
          if (!notificationsMemo) {
            notificationsMemo = fetchNotifications(repository, actor);
          }
          return notificationsMemo;
        },
      };

      const result = await def.handleOptionalMember(parsedInput, ctx);

      if (actor.kind === 'authenticated') {
        return assembleAuthenticatedResponse(actionName, result, actor, defaultRequestScope, sharedContext, notices);
      }
      return assembleUnauthenticatedResponse(actionName, result, notices);
    },
  );
}

async function dispatchAuthenticated(
  def: ActionDefinition,
  actionName: string,
  payload: Record<string, unknown>,
  bearerToken: string | null,
  clientIp: string | null,
  repository: Repository,
  runLlmGate: LlmGateFn,
  stampAuthenticatedMemberId?: (memberId: string) => void,
) {
  // Authenticate
  if (typeof bearerToken !== 'string' || bearerToken.trim().length === 0) {
    throw new AppError('unauthorized', 'Authorization bearer token must be a non-empty string');
  }
  const auth = await repository.authenticateBearerToken(bearerToken);
  if (!auth) {
    throw new AppError('unauthorized', 'Unknown bearer token');
  }

  let actor = auth.actor;
  stampAuthenticatedMemberId?.(actor.member.id);
  const requestLogEntry: LogApiRequestInput = {
    memberId: actor.member.id,
    actionName,
    ipAddress: clientIp,
  };
  let requestLogFired = false;
  const fireRequestLogOnce = () => {
    if (requestLogFired) {
      return;
    }
    requestLogFired = true;
    fireAndForgetRequestLog(repository, requestLogEntry);
  };
  const sharedContext = auth.sharedContext ?? { notifications: [], notificationsTruncated: false };
  let defaultRequestScope: RequestScope = {
    requestedClubId: auth.requestScope.requestedClubId,
    activeClubIds: auth.requestScope.activeClubIds,
  };
  let notificationsMemo: Promise<{ items: import('./repository.ts').NotificationItem[]; nextCursor: string | null }> | null = null;

  // Parse
  let parsedInput: unknown;
  try {
    parsedInput = parseActionInput(def, payload);
  } catch (error) {
    fireRequestLogOnce();
    throw error;
  }

  const idempotencyClientKey = def.idempotency?.getClientKey(parsedInput) ?? null;

  const maybeFireReplayAwareRequestLog = async () => {
    if (requestLogFired) {
      return;
    }
    if (!def.idempotency || !idempotencyClientKey || !repository.peekIdempotencyReplay) {
      fireRequestLogOnce();
      return;
    }
    const actorContext = def.idempotency.getScopeKey(parsedInput, { actor });
    const requestValue = def.idempotency.getRequestValue
      ? def.idempotency.getRequestValue(parsedInput, { actor })
      : parsedInput;
    const replayHit = await repository.peekIdempotencyReplay({
      clientKey: idempotencyClientKey,
      actorContext,
      requestValue,
    });
    if (!replayHit) {
      fireRequestLogOnce();
    }
  };

  // Pre-gate club access check: reject unauthorized requests before running the LLM gate
  if (def.llmGate && !def.skipRequestedClubScopePrecheck) {
    const requestedClubId = extractRequestedClubId(parsedInput as Record<string, unknown>);
    if (
      requestedClubId
      && !auth.requestScope.activeClubIds.includes(requestedClubId)
      && !auth.actor.globalRoles.includes('superadmin')
    ) {
      throw new AppError('forbidden', 'Requested club is outside your access scope');
    }
  }

  return executeWithClientKeyBarrierIfPresent(def, parsedInput, actor, repository, async () => {
    await maybeFireReplayAwareRequestLog();
    preAuthorizeAuthenticatedAction(def, parsedInput, actor);
    const requireAccessibleClub = createRequireAccessibleClub(actor);
    const requireClubAdmin = createRequireClubAdmin(actor);
    const requireClubOwner = createRequireClubOwner(actor);
    const requireSuperadmin = createRequireSuperadmin(actor);

    if (def.preGate) {
      await def.preGate(parsedInput, {
        actor,
        repository,
        requireAccessibleClub,
        requireClubAdmin,
        requireClubOwner,
        requireSuperadmin,
      });
    }

    await runQuotaFor(def, parsedInput, actor, repository);

    await runLlmGateFor(
      def,
      parsedInput,
      actor,
      repository,
      extractRequestedClubId(parsedInput as Record<string, unknown>),
      runLlmGate,
    );
    const notices: ResponseNotice[] = [];

    if (!def.handle) {
      throw new AppError('not_implemented', `Action ${actionName} has no authenticated handler`);
    }

    const ctx: HandlerContext = {
      actor,
      requestScope: defaultRequestScope,
      sharedContext,
      repository,
      requireAccessibleClub,
      requireClubAdmin,
      requireClubOwner,
      requireSuperadmin,
      resolveScopedClubs: createResolveScopedClubs(actor),
      runLlmGate,
      getNotifications: () => {
        if (typeof repository.listNotifications !== 'function') {
          return Promise.resolve({ items: [], nextCursor: null });
        }
        if (!notificationsMemo) {
          notificationsMemo = fetchNotifications(repository, actor);
        }
        return notificationsMemo;
      },
    };

    const result = await def.handle(parsedInput, ctx);

    if (def.refreshActorOnSuccess) {
      const refreshed = await repository.authenticateBearerToken(bearerToken);
      if (!refreshed) {
        throw new AppError('unauthorized', 'Bearer token became invalid after the action completed');
      }
      actor = refreshed.actor;
      defaultRequestScope = {
        requestedClubId: refreshed.requestScope.requestedClubId,
        activeClubIds: refreshed.requestScope.activeClubIds,
      };
    }

    let nextSharedContext: ResponseNotifications;
    if (def.skipNotificationsInResponse) {
      nextSharedContext = {
        notifications: [],
        notificationsTruncated: false,
      };
    } else {
      try {
        const notifications = await fetchNotifications(repository, actor);
        nextSharedContext = {
          notifications: notifications.items,
          notificationsTruncated: notifications.nextCursor !== null,
        };
      } catch (error) {
        logger.error('response_notifications_population_failed', error, { actionName });
        nextSharedContext = {
          notifications: [],
          notificationsTruncated: false,
        };
      }
    }

    return assembleAuthenticatedResponse(actionName, result, actor, defaultRequestScope, nextSharedContext, notices);
  });
}
