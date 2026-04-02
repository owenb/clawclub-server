import type {
  ActorContext,
  EntityKind,
  EventRsvpState,
  MembershipSummary,
  Repository,
  RequestScope,
  SharedResponseContext,
  UpdateEntityInput,
} from './app-contract.ts';

export type BuildSuccessResponse = (input: {
  action: string;
  actor: ActorContext;
  requestScope: RequestScope;
  sharedContext: SharedResponseContext;
  data: unknown;
}) => unknown;

export type CreateAppError = (status: number, code: string, message: string) => Error;
export type NormalizeLimit = (value: unknown) => number;
export type NormalizeOptionalInteger = (value: unknown, field: string) => number | null | undefined;
export type NormalizeOptionalString = (value: unknown, field: string) => string | null | undefined;
export type NormalizeEntityKinds = (value: unknown) => EntityKind[];
export type NormalizeEntityPatch = (payload: Record<string, unknown>) => UpdateEntityInput['patch'];
export type NormalizeTokenCreateInput = (payload: Record<string, unknown>) => { label: string | null; expiresAt: string | null; metadata: Record<string, unknown> };
export type NormalizeProfilePatch = (payload: Record<string, unknown>) => import('./app-contract.ts').UpdateOwnProfileInput;
export type RequireAccessibleNetwork = (actor: ActorContext, networkIdValue: unknown) => MembershipSummary;
export type RequireMembershipOwner = (actor: ActorContext, networkIdValue: unknown) => MembershipSummary;
export type RequireSuperadmin = (actor: ActorContext) => void;
export type RequireEntityKind = (value: unknown, field: string) => EntityKind;
export type RequireEventRsvpState = (value: unknown, field: string) => EventRsvpState;
export type RequireNonEmptyString = (value: unknown, field: string) => string;
export type RequireInteger = (value: unknown, field: string) => number;
export type RequireObject = (value: unknown, field: string) => Record<string, unknown>;
export type IsEntityKind = (value: unknown) => value is EntityKind;
export type RequireMembershipState = (value: unknown, field: string) => import('./app-contract.ts').MembershipState;
export type RequireApplicationStatus = (value: unknown, field: string) => import('./app-contract.ts').ApplicationStatus;
export type RequireApplicationPath = (value: unknown, field: string) => 'sponsored' | 'outside';
export type NormalizeApplicationIntake = (value: unknown, field: string) => import('./app-contract.ts').CreateApplicationInput['intake'];
export type NormalizeApplicationMetadataPatch = (value: unknown, field: string) => Record<string, unknown> | undefined;

export function resolveScopedNetworks(
  actor: ActorContext,
  requestedNetworkId: unknown,
  requireAccessibleNetwork: RequireAccessibleNetwork,
  createAppError: CreateAppError,
): MembershipSummary[] {
  if (requestedNetworkId !== undefined) {
    return [requireAccessibleNetwork(actor, requestedNetworkId)];
  }

  if (actor.memberships.length === 0) {
    throw createAppError(403, 'forbidden', 'This member does not currently have access to any networks');
  }

  return actor.memberships;
}

export function resolveRequestedNetworkId(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}
