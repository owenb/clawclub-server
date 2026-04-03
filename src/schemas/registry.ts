/**
 * Action registry: the central contract for all API actions.
 *
 * Each action is defined in a domain module (session.ts, entities.ts, etc.)
 * and assembled here into a single registry. The registry is the single
 * source of truth for:
 *   - Action metadata (description, auth, safety, aiExposed)
 *   - Wire schemas (input/output shapes for docs and schema endpoint)
 *   - Parse schemas (runtime normalization with transforms/defaults)
 *   - Handler functions
 *   - Quality gate and capability requirements
 */
import { z } from 'zod';
import { AppError } from '../app.ts';
import type {
  ActorContext,
  MembershipSummary,
  Repository,
  RequestScope,
  SharedResponseContext,
} from '../app-contract.ts';

// ── Auth and safety types ────────────────────────────────

export type ActionAuth = 'none' | 'member' | 'owner' | 'superadmin';
export type ActionSafety = 'read_only' | 'mutating';

// ── Repository capability ────────────────────────────────
// Narrow union of optional Repository methods that back specific actions.
// Used to check runtime availability before dispatch (→ 501 if missing).

export type RepositoryCapability =
  | 'listClubs'
  | 'createClub'
  | 'archiveClub'
  | 'assignClubOwner'
  | 'listAdmissions'
  | 'transitionAdmission'
  | 'createAdmissionChallenge'
  | 'solveAdmissionChallenge'
  | 'archiveEntity'
  | 'redactEntity'
  | 'redactMessage'
  | 'listMemberUpdates'
  | 'getLatestStreamSeq'
  | 'acknowledgeUpdates'
  | 'issueAdmissionAccess'
  | 'adminGetOverview'
  | 'adminListMembers'
  | 'adminGetMember'
  | 'adminGetClubStats'
  | 'adminListContent'
  | 'adminArchiveEntity'
  | 'adminListThreads'
  | 'adminReadThread'
  | 'adminListMemberTokens'
  | 'adminRevokeMemberToken'
  | 'adminGetDiagnostics';

// ── Handler context ──────────────────────────────────────
// Passed to every handler. Authorization helpers are pre-bound to the actor.

export type HandlerContext = {
  actor: ActorContext;
  requestScope: RequestScope;
  sharedContext: SharedResponseContext;
  repository: Repository;

  // Authorization helpers (pre-bound to actor)
  requireAccessibleClub: (clubId: string) => MembershipSummary;
  requireMembershipOwner: (clubId: string) => MembershipSummary;
  requireSuperadmin: () => void;
  resolveScopedClubs: (clubId?: string) => MembershipSummary[];

  /** Check that a repository capability exists at runtime. Throws 501 if missing. */
  requireCapability: (capability: RepositoryCapability) => void;
};

/**
 * Minimal context for unauthenticated (auth: 'none') actions.
 */
export type ColdHandlerContext = {
  repository: Repository;
};

// ── Action result ────────────────────────────────────────
// Structured return type from handlers. The transport layer
// assembles the canonical envelope from this.

export type ActionResult = {
  /** Action-specific data (goes in `data` field of response) */
  data: unknown;

  /** Override the default request scope in the response */
  requestScope?: RequestScope;

  /**
   * Replace actor.member in the response (profile.update only).
   * Full replacement, not a partial merge.
   */
  nextMember?: { id: string; handle: string | null; publicName: string };

  /**
   * Update IDs to remove from sharedContext.pendingUpdates (updates.acknowledge only).
   * Transport layer filters these out of the pending updates array.
   */
  acknowledgedUpdateIds?: string[];
};

// ── Action definition ────────────────────────────────────

export type ActionDefinition = {
  // ── Public metadata (exposed by schema endpoint) ──
  action: string;
  domain: string;
  description: string;
  auth: ActionAuth;
  safety: ActionSafety;
  aiExposed: boolean;
  authorizationNote?: string;

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
   * Handler for authenticated actions.
   * Receives parsed input and full handler context.
   */
  handle?: (input: unknown, ctx: HandlerContext) => Promise<ActionResult>;

  /**
   * Handler for unauthenticated (auth: 'none') actions.
   * Receives parsed input and minimal context (repository only).
   */
  handleCold?: (input: unknown, ctx: ColdHandlerContext) => Promise<ActionResult>;
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

/** Get the set of known action names (for unknown action detection) */
export function getKnownActions(): ReadonlySet<string> {
  return new Set(registry.keys());
}

// ── Parse helper ─────────────────────────────────────────

/**
 * Parse action input through the parse schema.
 * Converts ZodError to AppError(400, 'invalid_input', ...) to preserve
 * the existing error contract.
 */
export function parseActionInput<T>(def: ActionDefinition, payload: unknown): T {
  const result = def.parse.input.safeParse(payload);
  if (!result.success) {
    const err = result.error.errors[0];
    const path = err.path.length > 0 ? `${err.path.join('.')}: ` : '';
    throw new AppError(400, 'invalid_input', `${path}${err.message}`);
  }
  return result.data as T;
}
