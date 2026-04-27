/**
 * Action registry: the central contract for all API actions.
 *
 * Each action is defined in a domain module (session.ts, content.ts, etc.)
 * and assembled here into a single registry. The registry is the single
 * source of truth for:
 *   - Action metadata (description, auth, safety)
 *   - Input specs (single source for wire/docs, parse, and request-template hints)
 *   - Wire output schemas
 *   - Handler functions
 *   - LLM gate and idempotency requirements
 */
import { z } from 'zod';
import { AppError } from '../errors.ts';
import type { MembershipSummary, Repository } from '../repository.ts';
import { requestScopeForClub, type Actor, type AuthenticatedActor, type RequestScope } from '../actors.ts';
import type { ResponseNotice, ResponseNotifications } from '../notifications.ts';
import type { GateVerdict, NonApplicationArtifact } from '../gate.ts';
import type { SupportedQuotaAction } from '../quota-metadata.ts';

// ── Auth and safety types ────────────────────────────────

export type ActionAuth = 'none' | 'optional_member' | 'member' | 'clubadmin' | 'superadmin';
export type ActionSafety = 'read_only' | 'mutating';

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
  clientIp?: string | null;
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

export type ActionIdempotencyStrategy =
  | {
    kind: 'clientKey';
    requirement: 'required' | 'optional';
  }
  | {
    kind: 'secretMint';
  }
  | {
    kind: 'naturallyIdempotent';
    reason: string;
  };

export type ActionScopeDeclaration =
  | { strategy: 'rawClubId'; key?: string }
  | { strategy: 'rawMemberId'; key?: string }
  | { strategy: 'handler' }
  | { strategy: 'none' };

export type RequestTemplate = { action: string; input: Record<string, string> };

export type ActionInputSpec = {
  wire: z.ZodType;
  parse: z.ZodType;
  buildRequestTemplate?: (action: string) => RequestTemplate;
};

export function defineInput(input: {
  wire: z.ZodType;
  parse?: z.ZodType;
  buildRequestTemplate?: (action: string) => RequestTemplate;
}): ActionInputSpec {
  return {
    wire: input.wire,
    parse: input.parse ?? input.wire,
    ...(input.buildRequestTemplate ? { buildRequestTemplate: input.buildRequestTemplate } : {}),
  };
}

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

  input: ActionInputSpec;

  wire: {
    output: z.ZodType;
  };

  llmGate?: LlmGateDeclaration;
  quotaAction?: SupportedQuotaAction;
  idempotency?: IdempotencyDeclaration;
  idempotencyStrategy?: ActionIdempotencyStrategy;
  scope?: ActionScopeDeclaration;
  refreshActorOnSuccess?: boolean;
  skipNotificationsInResponse?: boolean;
  skipRequestedClubScopePrecheck?: boolean;

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

function cloneWithDef(schema: z.ZodTypeAny, patch: Record<string, unknown>): z.ZodTypeAny {
  const cloned = ((schema as unknown) as {
    _def: Record<string, unknown>;
    clone: (def: Record<string, unknown>) => z.ZodTypeAny;
  }).clone({
    ...((schema as unknown) as { _def: Record<string, unknown> })._def,
    ...patch,
  });
  return schema.description ? cloned.describe(schema.description) : cloned;
}

export function strictRecursive(schema: z.ZodTypeAny): z.ZodTypeAny {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable || schema instanceof z.ZodDefault) {
    return cloneWithDef(schema, {
      innerType: strictRecursive(((schema as unknown) as { unwrap: () => z.ZodTypeAny }).unwrap()),
    });
  }
  if (schema instanceof z.ZodArray) {
    return cloneWithDef(schema, {
      element: strictRecursive(((schema as unknown) as { element: z.ZodTypeAny }).element),
    });
  }
  if (schema instanceof z.ZodObject) {
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [key, value] of Object.entries(schema.shape)) {
      shape[key] = strictRecursive(value as z.ZodTypeAny);
    }
    const strictObject = cloneWithDef(schema, { shape }) as z.ZodObject;
    const result = strictObject.strict();
    return schema.description ? result.describe(schema.description) : result;
  }
  if (schema instanceof z.ZodDiscriminatedUnion || schema instanceof z.ZodUnion) {
    return cloneWithDef(schema, {
      options: ((schema as unknown) as { options: z.ZodTypeAny[] }).options
        .map((option) => strictRecursive(option)),
    });
  }
  return schema;
}

function applyStrictInputCanon(schema: z.ZodType): z.ZodType {
  if (
    !(schema instanceof z.ZodObject)
    && !(schema instanceof z.ZodDiscriminatedUnion)
    && !(schema instanceof z.ZodUnion)
  ) {
    throw new Error(`Action input schema root must be ZodObject or object union, got ${schema.constructor.name}`);
  }
  return strictRecursive(schema);
}

function validateIdempotencyStrategy(action: ActionDefinition): void {
  if (action.auth === 'none' || action.safety !== 'mutating') {
    return;
  }
  if (!action.idempotencyStrategy) {
    throw new Error(`Mutating authenticated action ${action.action} must declare an idempotencyStrategy`);
  }
  if (
    (action.idempotencyStrategy.kind === 'clientKey' || action.idempotencyStrategy.kind === 'secretMint')
    && !action.idempotency
  ) {
    throw new Error(`Action ${action.action} declares ${action.idempotencyStrategy.kind} idempotency without an idempotency declaration`);
  }
}

function validateInputSpec(action: ActionDefinition): void {
  const candidate = action as unknown as {
    input?: Partial<ActionInputSpec>;
    wire?: { input?: unknown };
    parse?: unknown;
  };
  if (candidate.wire && Object.prototype.hasOwnProperty.call(candidate.wire, 'input')) {
    throw new Error(`Action ${action.action} must declare input via defineInput(), not wire.input`);
  }
  if (Object.prototype.hasOwnProperty.call(candidate, 'parse')) {
    throw new Error(`Action ${action.action} must declare input via defineInput(), not parse.input`);
  }
  if (!candidate.input || !candidate.input.wire || !candidate.input.parse) {
    throw new Error(`Action ${action.action} must declare an input spec with defineInput()`);
  }
}

function validateWireInputArrayBounds(action: ActionDefinition): void {
  const root = z.toJSONSchema(action.input.wire) as Record<string, unknown>;
  const visit = (node: unknown, path: string): void => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      return;
    }

    const schema = node as Record<string, unknown>;
    if (schema.type === 'array') {
      const enforcedBy = schema.clawclubEnforcedBy;
      if (typeof schema.maxItems !== 'number' && enforcedBy !== 'policy') {
        throw new Error(`Action ${action.action} input array at ${path} must declare maxItems or policy enforcement`);
      }
    }

    for (const key of ['properties', 'items', 'oneOf', 'anyOf', 'allOf', '$defs']) {
      const child = schema[key];
      if (Array.isArray(child)) {
        child.forEach((item, index) => visit(item, `${path}.${key}[${index}]`));
      } else if (child && typeof child === 'object') {
        if (key === 'properties' || key === '$defs') {
          for (const [propKey, propSchema] of Object.entries(child as Record<string, unknown>)) {
            visit(propSchema, `${path}.${propKey}`);
          }
        } else {
          visit(child, `${path}.${key}`);
        }
      }
    }
  };

  visit(root, 'input');
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
    if (action.auth === 'none' && action.preGate) {
      throw new Error(`Cold action ${action.action} must not define preGate`);
    }
    validateInputSpec(action);
    validateIdempotencyStrategy(action);
    validateWireInputArrayBounds(action);
    registry.set(action.action, {
      ...action,
      input: {
        ...action.input,
        wire: applyStrictInputCanon(action.input.wire),
        parse: applyStrictInputCanon(action.input.parse),
      },
      wire: {
        ...action.wire,
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
  const result = def.input.parse.safeParse(payload);
  if (!result.success) {
    const err = result.error.issues[0];
    const discriminatorMessage = formatDiscriminatorMismatch(def.input.parse, err, payload);
    const path = err.path.length > 0 ? `${err.path.join('.')}: ` : '';
    const appErr = new AppError('invalid_input', discriminatorMessage ?? `${path}${err.message}`);
    appErr.details = {
      issues: result.error.issues.map((issue) => {
        const issueRecord = issue as unknown as Record<string, unknown>;
        return {
          code: issue.code,
          path: issue.path,
          message: issue.message,
          ...(Array.isArray(issueRecord.keys) ? { keys: issueRecord.keys } : {}),
        };
      }),
    };
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

    const req = required.has(key) && prop.default === undefined ? 'required' : 'optional';
    input[key] = describeTemplateProperty(prop, req);
  }

  return { action, input };
}

function describeTemplateProperty(prop: Record<string, unknown>, req: 'required' | 'optional'): string {
  const core = unwrapTemplateProperty(prop);

  if (core.const !== undefined) {
    return `(exactly: ${String(core.const)})`;
  }

  if (core.enum && Array.isArray(core.enum)) {
    return `(one of: ${core.enum.join(', ')})`;
  }

  const typeStr = readTemplateType(core);
  if (typeStr === 'array') {
    const items = core.items as Record<string, unknown> | undefined;
    const itemCore = items ? unwrapTemplateProperty(items) : null;
    const itemType = itemCore ? readTemplateType(itemCore) : 'unknown';
    return `(array of ${itemType}, ${req})`;
  }

  if (typeStr === 'object' || typeStr === 'unknown') {
    return `(<complex>, ${req})`;
  }

  return `(${typeStr}, ${req})`;
}

function unwrapTemplateProperty(prop: Record<string, unknown>): Record<string, unknown> {
  const variants = (prop.anyOf ?? prop.oneOf) as unknown;
  if (!Array.isArray(variants)) {
    return prop;
  }
  const nonNull = variants.filter((variant): variant is Record<string, unknown> => (
    variant !== null
    && typeof variant === 'object'
    && !Array.isArray(variant)
    && (variant as Record<string, unknown>).type !== 'null'
  ));
  return nonNull.length === 1 ? nonNull[0]! : prop;
}

function readTemplateType(prop: Record<string, unknown>): string {
  if (typeof prop.type === 'string') {
    return prop.type;
  }
  if (Array.isArray(prop.type)) {
    const nonNullTypes = prop.type.filter((type): type is string => typeof type === 'string' && type !== 'null');
    return nonNullTypes.length === 1 ? nonNullTypes[0]! : 'unknown';
  }
  if (prop.properties && typeof prop.properties === 'object') {
    return 'object';
  }
  return 'unknown';
}

/**
 * Generate a shallow request template from an action's wire input schema.
 * Walks the JSON Schema properties to produce placeholder descriptors.
 * Helps agents recover from envelope and top-level shape mistakes.
 */
export function generateRequestTemplate(def: ActionDefinition): RequestTemplate {
  if (def.input.buildRequestTemplate) {
    return def.input.buildRequestTemplate(def.action);
  }

  if (def.input.wire instanceof z.ZodDiscriminatedUnion) {
    const discriminator = ((def.input.wire as unknown) as { _def: { discriminator: string } })._def.discriminator;
    const values = extractDiscriminatorValues(def.input.wire);
    const firstOption = ((def.input.wire as unknown) as { options: z.ZodObject[] }).options[0];
    if (firstOption) {
      return buildObjectTemplate(def.action, firstOption, {
        [discriminator]: `(one of: ${values.join(', ')})`,
      });
    }
  }

  if (def.input.wire instanceof z.ZodObject) {
    return buildObjectTemplate(def.action, def.input.wire);
  }

  return { action: def.action, input: {} };
}
