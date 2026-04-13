/**
 * Action registry: the central contract for all API actions.
 *
 * Each action is defined in a domain module (session.ts, entities.ts, etc.)
 * and assembled here into a single registry. The registry is the single
 * source of truth for:
 *   - Action metadata (description, auth, safety)
 *   - Wire schemas (input/output shapes for docs and schema endpoint)
 *   - Parse schemas (runtime normalization with transforms/defaults)
 *   - Handler functions
 *   - Quality gate and capability requirements
 */
import { z } from 'zod';
import { AppError } from '../contract.ts';
import type {
  ActorContext,
  MaybeMemberActorContext,
  MembershipSummary,
  Repository,
  ResponseNotice,
  RequestScope,
  SharedResponseContext,
} from '../contract.ts';

// ── Auth and safety types ────────────────────────────────

export type ActionAuth = 'none' | 'optional_member' | 'member' | 'clubadmin' | 'clubowner' | 'superadmin';
export type ActionSafety = 'read_only' | 'mutating';

// ── Repository capability ────────────────────────────────
// Narrow union of optional Repository methods that back specific actions.
// Used to check runtime availability before dispatch (→ 501 if missing).

export type RepositoryCapability =
  | 'joinClub'
  | 'submitClubApplication'
  | 'getClubApplication'
  | 'listClubApplications'
  | 'startMembershipCheckout'
  | 'issueInvitation'
  | 'listIssuedInvitations'
  | 'revokeInvitation'
  | 'getMembershipApplication'
  | 'listClubs'
  | 'createClub'
  | 'archiveClub'
  | 'assignClubOwner'
  | 'updateClub'
  | 'removeEntity'
  | 'removeEvent'
  | 'removeMessage'
  | 'adminCreateMember'
  | 'adminCreateMembership'
  | 'adminGetOverview'
  | 'adminListMembers'
  | 'adminGetMember'
  | 'adminGetClubStats'
  | 'adminListContent'
  | 'adminListThreads'
  | 'adminReadThread'
  | 'adminListMemberTokens'
  | 'adminRevokeMemberToken'
  | 'adminGetDiagnostics'
  | 'promoteMemberToAdmin'
  | 'demoteMemberFromAdmin'
  | 'billingActivateMembership'
  | 'billingRenewMembership'
  | 'billingMarkRenewalPending'
  | 'billingExpireMembership'
  | 'billingCancelAtPeriodEnd'
  | 'billingBanMember'
  | 'billingSetClubPrice'
  | 'billingArchiveClub'
  | 'getBillingStatus';

// ── Handler context ──────────────────────────────────────
// Passed to every handler. Authorization helpers are pre-bound to the actor.

export type HandlerContext = {
  actor: ActorContext;
  requestScope: RequestScope;
  sharedContext: SharedResponseContext;
  repository: Repository;

  // Authorization helpers (pre-bound to actor)
  requireAccessibleClub: (clubId: string) => MembershipSummary;
  requireClubAdmin: (clubId: string) => void;
  requireClubOwner: (clubId: string) => void;
  requireSuperadmin: () => void;
  resolveScopedClubs: (clubId?: string) => MembershipSummary[];
  getNotifications: () => Promise<{
    items: import('../contract.ts').NotificationItem[];
    nextAfter: string | null;
  }>;

  /** Check that a repository capability exists at runtime. Throws 501 if missing. */
  requireCapability: (capability: RepositoryCapability) => void;
};

/**
 * Minimal context for unauthenticated (auth: 'none') actions.
 */
export type ColdHandlerContext = {
  repository: Repository;
};

export type OptionalHandlerContext = {
  actor: MaybeMemberActorContext;
  bearerToken: string | null;
  requestScope: RequestScope;
  sharedContext: SharedResponseContext;
  repository: Repository;

  getNotifications: () => Promise<{
    items: import('../contract.ts').NotificationItem[];
    nextAfter: string | null;
  }>;

  /** Check that a repository capability exists at runtime. Throws 501 if missing. */
  requireCapability: (capability: RepositoryCapability) => void;
};

export type PreGateContext = {
  actor: ActorContext;
  repository: Repository;
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
   * Replace actor.member in the response (profile.update only).
   * Full replacement, not a partial merge.
   */
  nextMember?: { id: string; handle: string | null; publicName: string };

  /** Notification IDs to remove from sharedContext.notifications on the same response. */
  acknowledgedNotificationIds?: string[];
};

// ── Action definition ────────────────────────────────────

export type SchemaBusinessError = {
  code: string;
  meaning: string;
  recovery: string;
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

  /** Quality gate prompt file name (without path), or undefined for no gate */
  qualityGate?: string;

  /** Repository method that must exist for this action to be available (→ 501 if missing) */
  requiredCapability?: RepositoryCapability;

  /**
   * Optional preflight hook for authenticated actions.
   * Runs after parsing and before any quality gate execution.
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
    registry.set(action.action, action);
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
    const path = err.path.length > 0 ? `${err.path.join('.')}: ` : '';
    const appErr = new AppError(400, 'invalid_input', `${path}${err.message}`);
    appErr.requestTemplate = generateRequestTemplate(def);
    throw appErr;
  }
  return result.data as T;
}

// ── Request template helpers ────────────────────────────

/** Generic template for when the action is unknown or missing. */
export const GENERIC_REQUEST_TEMPLATE = { action: '(action name)', input: {} };

/**
 * Generate a shallow request template from an action's wire input schema.
 * Walks the JSON Schema properties to produce placeholder descriptors.
 * Helps agents recover from envelope and top-level shape mistakes.
 */
export function generateRequestTemplate(def: ActionDefinition): { action: string; input: Record<string, string> } {
  const jsonSchema = z.toJSONSchema(def.wire.input) as Record<string, unknown>;
  const properties = (jsonSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set((jsonSchema.required ?? []) as string[]);

  const input: Record<string, string> = {};
  for (const [key, prop] of Object.entries(properties)) {
    const req = required.has(key) ? 'required' : 'optional';

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

  return { action: def.action, input };
}
