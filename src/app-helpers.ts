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
export type RequireAccessibleClub = (actor: ActorContext, clubIdValue: unknown) => MembershipSummary;
export type RequireMembershipOwner = (actor: ActorContext, clubIdValue: unknown) => MembershipSummary;
export type RequireSuperadmin = (actor: ActorContext) => void;
export type RequireEntityKind = (value: unknown, field: string) => EntityKind;
export type RequireEventRsvpState = (value: unknown, field: string) => EventRsvpState;
export type RequireNonEmptyString = (value: unknown, field: string) => string;
export type RequireInteger = (value: unknown, field: string) => number;
export type RequireObject = (value: unknown, field: string) => Record<string, unknown>;
export type IsEntityKind = (value: unknown) => value is EntityKind;
export type RequireMembershipState = (value: unknown, field: string) => import('./app-contract.ts').MembershipState;
export type RequireAdmissionStatus = (value: unknown, field: string) => import('./app-contract.ts').AdmissionStatus;
export type NormalizeAdmissionIntake = (value: unknown, field: string) => NonNullable<import('./app-contract.ts').TransitionAdmissionInput['intake']>;
export type NormalizeAdmissionMetadataPatch = (value: unknown, field: string) => Record<string, unknown> | undefined;

const CANDIDATE_FIELD_MAX_LENGTH = 500;

export function requireBoundedString(
  value: unknown,
  field: string,
  requireNonEmptyString: RequireNonEmptyString,
  createAppError: CreateAppError,
): string {
  const str = requireNonEmptyString(value, field);
  if (str.length > CANDIDATE_FIELD_MAX_LENGTH) {
    throw createAppError(400, 'invalid_input', `${field} must be at most ${CANDIDATE_FIELD_MAX_LENGTH} characters`);
  }
  return str;
}

export function normalizeCandidateEmail(
  value: unknown,
  requireNonEmptyString: RequireNonEmptyString,
  createAppError: CreateAppError,
): string {
  const email = requireBoundedString(value, 'email', requireNonEmptyString, createAppError).toLowerCase();
  if (!email.includes('@')) {
    throw createAppError(400, 'invalid_input', 'email must look like an email address');
  }
  return email;
}

export function normalizeCandidateFullName(
  value: unknown,
  requireNonEmptyString: RequireNonEmptyString,
  createAppError: CreateAppError,
): string {
  const name = requireBoundedString(value, 'name', requireNonEmptyString, createAppError);
  const words = name.split(/\s+/).filter((w) => w.length > 0);
  if (words.length < 2) {
    throw createAppError(400, 'invalid_input', 'name must be a full name (first and last name)');
  }
  return words.join(' ');
}

export function resolveScopedClubs(
  actor: ActorContext,
  requestedClubId: unknown,
  requireAccessibleClub: RequireAccessibleClub,
  createAppError: CreateAppError,
): MembershipSummary[] {
  if (requestedClubId !== undefined) {
    return [requireAccessibleClub(actor, requestedClubId)];
  }

  if (actor.memberships.length === 0) {
    throw createAppError(403, 'forbidden', 'This member does not currently have access to any clubs');
  }

  return actor.memberships;
}

export function resolveRequestedClubId(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}
