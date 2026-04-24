/**
 * Action registry: the central contract for all API actions.
 *
 * Each action is defined in a domain module (session.ts, content.ts, etc.)
 * and assembled here into a single registry. The registry is the single
 * source of truth for:
 *   - Action metadata (description, auth, safety)
 *   - Wire schemas (input/output shapes for docs and schema endpoint)
 *   - Parse schemas (runtime normalization with transforms/defaults)
 *   - Handler functions
 *   - LLM gate and capability requirements
 */
import { z } from 'zod';
import { AppError } from '../errors.ts';
import type {
  MembershipSummary,
  Repository,
} from '../repository.ts';
import { requestScopeForClub, type Actor, type AuthenticatedActor, type RequestScope } from '../actors.ts';
import type { ResponseNotice, ResponseNotifications } from '../notifications.ts';
import type { GateVerdict, NonApplicationArtifact } from '../gate.ts';
import type { SupportedQuotaAction } from '../quota-metadata.ts';

// ── Auth and safety types ────────────────────────────────

export type ActionAuth = 'none' | 'optional_member' | 'member' | 'clubadmin' | 'superadmin';
export type ActionSafety = 'read_only' | 'mutating';

// ── Repository capability ────────────────────────────────
// Narrow union of optional Repository methods that back specific actions.
// Used to check runtime availability before dispatch (→ 501 if missing).

export type RepositoryCapability =
  | 'registerAccount'
  | 'updateContactEmail'
  | 'applyToClub'
  | 'redeemInvitationApplication'
  | 'reviseClubApplication'
  | 'getMemberApplicationById'
  | 'listMemberApplications'
  | 'withdrawClubApplication'
  | 'listAdminClubApplications'
  | 'getAdminClubApplicationById'
  | 'decideClubApplication'
  | 'issueInvitation'
  | 'listIssuedInvitations'
  | 'revokeInvitation'
  | 'listClubs'
  | 'createClub'
  | 'archiveClub'
  | 'assignClubOwner'
  | 'updateClub'
  | 'removeClub'
  | 'listRemovedClubs'
  | 'restoreRemovedClub'
  | 'loadClubForGate'
  | 'enforceClubsCreateQuota'
  | 'updateMembership'
  | 'removeContent'
  | 'removeMessage'
  | 'adminCreateMember'
  | 'adminCreateMembership'
  | 'adminGetOverview'
  | 'adminListMembers'
  | 'adminGetMember'
  | 'adminRemoveMember'
  | 'adminGetClub'
  | 'adminGetClubStats'
  | 'adminListContent'
  | 'adminListThreads'
  | 'adminReadThread'
  | 'adminListMemberTokens'
  | 'adminRevokeMemberToken'
  | 'adminCreateAccessToken'
  | 'adminCreateNotificationProducer'
  | 'adminRotateNotificationProducerSecret'
  | 'adminUpdateNotificationProducerStatus'
  | 'adminUpdateNotificationProducerTopicStatus'
  | 'adminGetDiagnostics'
  | 'promoteMemberToAdmin'
  | 'demoteMemberFromAdmin';

// ── Handler context ──────────────────────────────────────
// Passed to every handler. Authorization helpers are pre-bound to the actor.

export type HandlerContext = {
  actor: AuthenticatedActor;
  requestScope: RequestScope;
  sharedContext: ResponseNotifications;
  repository: Repository;

  // Authorization helpers (pre-bound to actor)
  requireAccessibleClub: (clubId: string) => MembershipSummary;
  requireClubAdmin: (clubId: string) => void;
  requireClubOwner: (clubId: string) => void;
  requireSuperadmin: () => void;
  resolveScopedClubs: (clubId?: string) => MembershipSummary[];
  getNotifications: () => Promise<{
    items: import('../repository.ts').NotificationItem[];
    nextCursor: string | null;
  }>;
  runLlmGate: (artifact: NonApplicationArtifact, options?: { maxOutputTokens?: number }) => Promise<GateVerdict>;
};

/**
 * Minimal context for unauthenticated (auth: 'none') actions.
 */
export type ColdHandlerContext = {
  repository: Repository;
};

export type OptionalHandlerContext = {
  actor: Actor;
  bearerToken: string | null;
  requestScope: RequestScope;
  sharedContext: ResponseNotifications;
  repository: Repository;

  getNotifications: () => Promise<{
    items: import('../repository.ts').NotificationItem[];
    nextCursor: string | null;
  }>;
};

export type PreGateContext = {
  actor: AuthenticatedActor;
  repository: Repository;
  requireAccessibleClub: (clubId: string) => MembershipSummary;
  requireClubAdmin: (clubId: string) => void;
  requireClubOwner: (clubId: string) => void;
  requireSuperadmin: () => void;
};

// ── Action result ────────────────────────────────────────
// Structured return type from handlers. The transport layer
// assembles the canonical envelope from this.

export type ActionResult = {
  /** Action-specific data (goes in `data` field of response) */
  data: unknown;

  /** Optional top-level response notices to include alongside the action data */
  notices?: ResponseNotice[];

  /** Override the default request scope in the response */
  requestScope?: RequestScope;

  /**
   * Replace actor.member in the response (members.updateProfile only).
   * Full replacement, not a partial merge.
   */
  nextMember?: { id: string; publicName: string };

  /** Notification IDs to remove from sharedContext.notifications on the same response. */
  acknowledgedNotificationIds?: string[];
};

type PaginatedResultSlice<T> = {
  results: T[];
  hasMore: boolean;
  nextCursor: string | null;
};

export function paginatedResultData<T, Extra extends Record<string, unknown>>(
  result: PaginatedResultSlice<T>,
  extra: Extra,
): Extra & PaginatedResultSlice<T>;
export function paginatedResultData<T>(
  result: PaginatedResultSlice<T>,
): PaginatedResultSlice<T>;
export function paginatedResultData<T>(
  result: PaginatedResultSlice<T>,
  extra: Record<string, unknown> = {},
) {
  return {
    ...extra,
    results: result.results,
    hasMore: result.hasMore,
    nextCursor: result.nextCursor,
  };
}

export function clubScopedResult<T extends Record<string, unknown>>(
  scope: { clubId: string },
  data: T,
): ActionResult {
  return {
    data,
    requestScope: requestScopeForClub(scope.clubId),
  };
}

export function clubScopedPaginatedResult<T, Extra extends Record<string, unknown>>(
  club: MembershipSummary,
  result: PaginatedResultSlice<T>,
  extra: Extra,
): ActionResult {
  return clubScopedResult(
    club,
    paginatedResultData(result, {
      ...extra,
      clubScope: [club],
    }),
  );
}

// ── Action definition ────────────────────────────────────

export type SchemaBusinessError = {
  code: string;
  meaning: string;
  recovery: string;
};

export type LlmGateBuildContext = {
  actor: AuthenticatedActor;
  repository: Repository;
};

export type LlmGateDeclaration = {
  buildArtifact: (
    parsedInput: unknown,
    ctx: LlmGateBuildContext,
  ) => Promise<NonApplicationArtifact>;
  shouldSkip?: (
    parsedInput: unknown,
    ctx: LlmGateBuildContext,
  ) => Promise<boolean>;
  resolveBudgetClubId?: (
    parsedInput: unknown,
    ctx: LlmGateBuildContext,
  ) => Promise<string | null>;
};

export type IdempotencyDeclaration = {
  getClientKey: (parsedInput: unknown) => string | null;
  getScopeKey: (parsedInput: unknown, ctx: { actor: AuthenticatedActor }) => string;
  getRequestValue?: (parsedInput: unknown, ctx: { actor: AuthenticatedActor }) => unknown;
};

export type ActionDefinition = {
  // ── Public metadata (exposed by schema endpoint) ──
  action: string;
  domain: string;
  description: string;
  auth: ActionAuth;
  safety: ActionSafety;
  authorizationNote?: string;
  businessErrors?: SchemaBusinessError[];
  scopeRules?: string[];
  notes?: string[];

  wire: {
    input: z.ZodType;
    output: z.ZodType;
  };

  // ── Internal (not exposed publicly) ──
  parse: {
    input: z.ZodType;
  };

  llmGate?: LlmGateDeclaration;
  quotaAction?: SupportedQuotaAction;
  idempotency?: IdempotencyDeclaration;
  refreshActorOnSuccess?: boolean;
  skipNotificationsInResponse?: boolean;
  skipRequestedClubScopePrecheck?: boolean;

  /** Repository method that must exist for this action to be available (→ 501 if missing) */
  requiredCapability?: RepositoryCapability;
  /** Additional repository methods that must exist for this action to be available (→ 501 if missing) */
  requiredCapabilities?: RepositoryCapability[];

  /**
   * Optional preflight hook for authenticated actions.
   * Runs after parsing and before any llm gate execution.
   * Signals failure by throwing AppError.
   */
  preGate?: (input: unknown, ctx: PreGateContext) => Promise<void>;

  /**
   * Handler for authenticated actions.
   * Receives parsed input and full handler context.
   */
  handle?: (input: unknown, ctx: HandlerContext) => Promise<ActionResult>;

  /**
   * Handler for unauthenticated (auth: 'none') actions.
   * Receives parsed input and minimal context (repository only).
   */
  handleCold?: (input: unknown, ctx: ColdHandlerContext) => Promise<ActionResult>;

  /**
   * Handler for auth: 'optional_member' actions.
   * Receives either an authenticated member actor or an anonymous actor shape.
   */
  handleOptionalMember?: (input: unknown, ctx: OptionalHandlerContext) => Promise<ActionResult>;
};

// ── Registry ─────────────────────────────────────────────

const registry = new Map<string, ActionDefinition>();

function normalizeRequiredCapabilities(action: Pick<ActionDefinition, 'requiredCapability' | 'requiredCapabilities'>): RepositoryCapability[] | undefined {
  const requiredCapabilities = action.requiredCapabilities
    ?? (action.requiredCapability ? [action.requiredCapability] : undefined);
  return requiredCapabilities ? [...new Set(requiredCapabilities)] : undefined;
}

function strictActionInputSchema(schema: z.ZodType): z.ZodType {
  if (!(schema instanceof z.ZodObject)) {
    if (schema instanceof z.ZodDiscriminatedUnion) {
      const discriminator = ((schema as unknown) as { _def: { discriminator: string } })._def.discriminator;
      const strictOptions = ((schema as unknown) as { options: z.ZodObject[] }).options
        .map((option) => option.strict());
      return z.discriminatedUnion(discriminator, strictOptions as [z.ZodObject, ...z.ZodObject[]]);
    }
    if (schema instanceof z.ZodUnion) {
      const strictOptions = ((schema as unknown) as { options: z.ZodType[] }).options
        .map((option) => option instanceof z.ZodObject ? option.strict() : option);
      return z.union(strictOptions as [z.ZodType, z.ZodType, ...z.ZodType[]]);
    }
    throw new Error(`Action input schema root must be ZodObject or object union, got ${schema.constructor.name}`);
  }
  return schema.strict();
}

/**
 * Register action definitions from a domain module.
 * Called by each domain schema file during module initialization.
 */
export function registerActions(actions: ActionDefinition[]): void {
  for (const action of actions) {
    if (registry.has(action.action)) {
      throw new Error(`Duplicate action registration: ${action.action}`);
    }
    if (action.requiredCapability && action.requiredCapabilities && action.requiredCapabilities.length > 0) {
      throw new Error(`Action ${action.action} must not declare both requiredCapability and requiredCapabilities`);
    }
    if (action.auth === 'none' && action.preGate) {
      throw new Error(`Cold action ${action.action} must not define preGate`);
    }
    const requiredCapabilities = normalizeRequiredCapabilities(action);
    registry.set(action.action, {
      ...action,
      requiredCapability: undefined,
      requiredCapabilities,
      wire: {
        ...action.wire,
        input: strictActionInputSchema(action.wire.input),
      },
      parse: {
        ...action.parse,
        input: strictActionInputSchema(action.parse.input),
      },
    });
  }
}

/** Get the full registry (read-only) */
export function getRegistry(): ReadonlyMap<string, ActionDefinition> {
  return registry;
}

/** Look up a single action definition */
export function getAction(action: string): ActionDefinition | undefined {
  return registry.get(action);
}

// ── Parse helper ─────────────────────────────────────────

/**
 * Parse action input through the parse schema.
 * Converts ZodError to AppError(400, 'invalid_input', ...) to preserve
 * the existing error contract. Attaches a requestTemplate so agents can
 * self-correct envelope and top-level shape mistakes.
 */
export function parseActionInput<T>(def: ActionDefinition, payload: unknown): T {
  const result = def.parse.input.safeParse(payload);
  if (!result.success) {
    const err = result.error.issues[0];
    const discriminatorMessage = formatDiscriminatorMismatch(def.parse.input, err, payload);
    const path = err.path.length > 0 ? `${err.path.join('.')}: ` : '';
    const appErr = new AppError('invalid_input', discriminatorMessage ?? `${path}${err.message}`);
    appErr.requestTemplate = generateRequestTemplate(def);
    throw appErr;
  }
  return result.data as T;
}

// ── Request template helpers ────────────────────────────

/** Generic template for when the action is unknown or missing. */
export const GENERIC_REQUEST_TEMPLATE = { action: '(action name)', input: {} };

function extractDiscriminatorValues(schema: z.ZodDiscriminatedUnion<any, any>) {
  const values = new Set<string>();
  const discriminator = ((schema as unknown) as { _def: { discriminator: string } })._def.discriminator;
  const options = ((schema as unknown) as { options: Array<{ shape: Record<string, unknown> }> }).options;
  for (const option of options) {
    const literal = option.shape[discriminator] as { _def?: { values?: unknown } };
    const rawValues = (literal as { _def?: { values?: unknown } })._def?.values;
    if (Array.isArray(rawValues)) {
      for (const value of rawValues) {
        if (typeof value === 'string') values.add(value);
      }
    }
  }
  return [...values];
}

function formatDiscriminatorMismatch(schema: z.ZodType, issue: z.core.$ZodIssue, payload: unknown): string | null {
  if (!(schema instanceof z.ZodDiscriminatedUnion)) return null;
  const issueRecord = issue as unknown as Record<string, unknown>;
  const discriminator = ((schema as unknown) as { _def: { discriminator: string } })._def.discriminator;
  if (
    issue.code !== 'invalid_union'
    || issueRecord.note !== 'No matching discriminator'
    || issueRecord.discriminator !== discriminator
  ) {
    return null;
  }

  const allowed = extractDiscriminatorValues(schema);
  const actual = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)[discriminator]
    : undefined;
  const got = actual === undefined ? 'undefined' : JSON.stringify(actual);
  return `${discriminator}: expected one of ${allowed.map((value) => `'${value}'`).join(' | ')} (got: ${got})`;
}

function buildObjectTemplate(action: string, schema: z.ZodObject, overrides: Record<string, string> = {}) {
  const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
  const properties = (jsonSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set((jsonSchema.required ?? []) as string[]);

  const input: Record<string, string> = {};
  for (const [key, prop] of Object.entries(properties)) {
    if (key in overrides) {
      input[key] = overrides[key]!;
      continue;
    }

    const req = required.has(key) ? 'required' : 'optional';

    if (prop.const !== undefined) {
      input[key] = `(exactly: ${String(prop.const)})`;
      continue;
    }

    if (prop.enum && Array.isArray(prop.enum)) {
      input[key] = `(one of: ${prop.enum.join(', ')})`;
      continue;
    }

    let typeStr = typeof prop.type === 'string' ? prop.type : 'unknown';

    if (typeStr === 'array') {
      const items = prop.items as Record<string, unknown> | undefined;
      const itemType = items && typeof items.type === 'string' ? items.type : 'unknown';
      input[key] = `(array of ${itemType}, ${req})`;
      continue;
    }

    input[key] = `(${typeStr}, ${req})`;
  }

  return { action, input };
}

/**
 * Generate a shallow request template from an action's wire input schema.
 * Walks the JSON Schema properties to produce placeholder descriptors.
 * Helps agents recover from envelope and top-level shape mistakes.
 */
export function generateRequestTemplate(def: ActionDefinition): { action: string; input: Record<string, string> } {
  if (def.wire.input instanceof z.ZodDiscriminatedUnion) {
    const discriminator = ((def.wire.input as unknown) as { _def: { discriminator: string } })._def.discriminator;
    const values = extractDiscriminatorValues(def.wire.input);
    const firstOption = ((def.wire.input as unknown) as { options: z.ZodObject[] }).options[0];
    if (firstOption) {
      return buildObjectTemplate(def.action, firstOption, {
        [discriminator]: `(one of: ${values.join(', ')})`,
      });
    }
  }

  if (def.wire.input instanceof z.ZodObject) {
    return buildObjectTemplate(def.action, def.wire.input);
  }

  return { action: def.action, input: {} };
}
