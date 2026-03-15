import { handleAdmissionsAction } from './app-admissions.ts';
import { handleColdApplicationAction } from './app-cold-applications.ts';
import { handleContentAction } from './app-content.ts';
import { handleMessageAction } from './app-messages.ts';
import { handleProfileAction } from './app-profile.ts';
import { handleSystemAction } from './app-system.ts';
import { handleUpdatesAction } from './app-updates.ts';
import type {
  ActorContext,
  ApplicationStatus,
  CreateApplicationInput,
  EntityKind,
  EventRsvpState,
  MembershipState,
  MembershipSummary,
  Repository,
  RequestScope,
  SharedResponseContext,
  UpdateEntityInput,
  UpdateOwnProfileInput,
} from './app-contract.ts';

export * from './app-contract.ts';

export class AppError extends Error {
  statusCode: number;
  code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AppError(400, 'invalid_input', `${field} must be a non-empty string`);
  }

  return value.trim();
}

function normalizeLimit(value: unknown): number {
  if (value === undefined) {
    return 8;
  }

  if (!Number.isInteger(value)) {
    throw new AppError(400, 'invalid_input', 'limit must be an integer');
  }

  return Math.min(Math.max(Number(value), 1), 20);
}

function requireInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value)) {
    throw new AppError(400, 'invalid_input', `${field} must be an integer`);
  }

  return Number(value);
}

function normalizeOptionalString(value: unknown, field: string): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new AppError(400, 'invalid_input', `${field} must be a string or null`);
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function normalizeHandle(value: unknown): string | null | undefined {
  const normalized = normalizeOptionalString(value, 'handle');

  if (normalized === undefined || normalized === null) {
    return normalized;
  }

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized)) {
    throw new AppError(400, 'invalid_input', 'handle must use lowercase letters, numbers, and single hyphens');
  }

  return normalized;
}

function normalizeOptionalStringArray(value: unknown, field: string): unknown[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new AppError(400, 'invalid_input', `${field} must be an array`);
  }

  return value;
}

function normalizeOptionalRecord(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new AppError(400, 'invalid_input', `${field} must be an object`);
  }

  return value as Record<string, unknown>;
}

function normalizeProfilePatch(payload: Record<string, unknown>): UpdateOwnProfileInput {
  return {
    handle: normalizeHandle(payload.handle),
    displayName: payload.displayName === undefined ? undefined : requireNonEmptyString(payload.displayName, 'displayName'),
    tagline: normalizeOptionalString(payload.tagline, 'tagline'),
    summary: normalizeOptionalString(payload.summary, 'summary'),
    whatIDo: normalizeOptionalString(payload.whatIDo, 'whatIDo'),
    knownFor: normalizeOptionalString(payload.knownFor, 'knownFor'),
    servicesSummary: normalizeOptionalString(payload.servicesSummary, 'servicesSummary'),
    websiteUrl: normalizeOptionalString(payload.websiteUrl, 'websiteUrl'),
    links: normalizeOptionalStringArray(payload.links, 'links'),
    profile: normalizeOptionalRecord(payload.profile, 'profile'),
  };
}

function requireAccessibleNetwork(actor: ActorContext, networkIdValue: unknown): MembershipSummary {
  const networkId = requireNonEmptyString(networkIdValue, 'networkId');
  const allowed = actor.memberships.find((network) => network.networkId === networkId);

  if (!allowed) {
    throw new AppError(403, 'forbidden', 'Requested network is outside the actor scope');
  }

  return allowed;
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new AppError(400, 'invalid_input', `${field} must be a JSON object`);
  }

  return value as Record<string, unknown>;
}

function isEntityKind(value: unknown): value is EntityKind {
  return value === 'post' || value === 'opportunity' || value === 'service' || value === 'ask';
}

function requireEntityKind(value: unknown, field: string): EntityKind {
  if (!isEntityKind(value)) {
    throw new AppError(400, 'invalid_input', `${field} must be one of: post, opportunity, service, ask`);
  }

  return value;
}

function normalizeEntityKinds(value: unknown): EntityKind[] {
  if (value === undefined) {
    return ['post', 'opportunity', 'service', 'ask'];
  }

  if (!Array.isArray(value) || value.length === 0) {
    throw new AppError(400, 'invalid_input', 'kinds must be a non-empty array when provided');
  }

  const kinds = value.map((item) => requireEntityKind(item, 'kinds[]'));
  return [...new Set(kinds)];
}

function isMembershipState(value: unknown): value is MembershipState {
  return value === 'invited' || value === 'pending_review' || value === 'active' || value === 'paused' || value === 'revoked' || value === 'rejected';
}

function requireMembershipState(value: unknown, field: string): MembershipState {
  if (!isMembershipState(value)) {
    throw new AppError(400, 'invalid_input', `${field} must be one of: invited, pending_review, active, paused, revoked, rejected`);
  }

  return value;
}

function isApplicationStatus(value: unknown): value is ApplicationStatus {
  return value === 'draft'
    || value === 'submitted'
    || value === 'interview_scheduled'
    || value === 'interview_completed'
    || value === 'accepted'
    || value === 'declined'
    || value === 'withdrawn';
}

function requireApplicationStatus(value: unknown, field: string): ApplicationStatus {
  if (!isApplicationStatus(value)) {
    throw new AppError(400, 'invalid_input', `${field} must be one of: draft, submitted, interview_scheduled, interview_completed, accepted, declined, withdrawn`);
  }

  return value;
}

function requireMembershipOwner(actor: ActorContext, networkIdValue: unknown): MembershipSummary {
  const membership = requireAccessibleNetwork(actor, networkIdValue);

  if (membership.role !== 'owner') {
    throw new AppError(403, 'forbidden', 'This action requires owner membership in the requested network');
  }

  return membership;
}

function requireSuperadmin(actor: ActorContext): void {
  if (!actor.globalRoles.includes('superadmin')) {
    throw new AppError(403, 'forbidden', 'This action requires superadmin role');
  }
}

function normalizeEntityPatch(payload: Record<string, unknown>): UpdateEntityInput['patch'] {
  const patch = {
    title: normalizeOptionalString(payload.title, 'title'),
    summary: normalizeOptionalString(payload.summary, 'summary'),
    body: normalizeOptionalString(payload.body, 'body'),
    expiresAt: normalizeOptionalString(payload.expiresAt, 'expiresAt'),
    content: payload.content === undefined ? undefined : requireObject(payload.content, 'content'),
  };

  if (Object.values(patch).every((value) => value === undefined)) {
    throw new AppError(400, 'invalid_input', 'entities.update requires at least one field to change');
  }

  return patch;
}

function normalizeOptionalInteger(value: unknown, field: string): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (!Number.isInteger(value)) {
    throw new AppError(400, 'invalid_input', `${field} must be an integer or null`);
  }

  const number = Number(value);
  if (number <= 0) {
    throw new AppError(400, 'invalid_input', `${field} must be greater than zero when provided`);
  }

  return number;
}

function isEventRsvpState(value: unknown): value is EventRsvpState {
  return value === 'yes' || value === 'maybe' || value === 'no' || value === 'waitlist';
}

function requireEventRsvpState(value: unknown, field: string): EventRsvpState {
  if (!isEventRsvpState(value)) {
    throw new AppError(400, 'invalid_input', `${field} must be one of: yes, maybe, no, waitlist`);
  }

  return value;
}

function normalizeTokenCreateInput(payload: Record<string, unknown>): { label: string | null; metadata: Record<string, unknown> } {
  return {
    label: normalizeOptionalString(payload.label, 'label') ?? null,
    metadata: payload.metadata === undefined ? {} : requireObject(payload.metadata, 'metadata'),
  };
}

function requireApplicationPath(value: unknown, field: string): 'sponsored' | 'outside' {
  if (value !== 'sponsored' && value !== 'outside') {
    throw new AppError(400, 'invalid_input', `${field} must be one of: sponsored, outside`);
  }

  return value;
}

function requireApplicationIntakeKind(value: unknown, field: string): 'fit_check' | 'advice_call' | 'other' {
  if (value !== 'fit_check' && value !== 'advice_call' && value !== 'other') {
    throw new AppError(400, 'invalid_input', `${field} must be one of: fit_check, advice_call, other`);
  }

  return value;
}

function normalizeOptionalCurrencyCode(value: unknown, field: string): string | null | undefined {
  const normalized = normalizeOptionalString(value, field);
  if (normalized === undefined || normalized === null) {
    return normalized;
  }

  const upper = normalized.toUpperCase();
  if (!/^[A-Z]{3}$/.test(upper)) {
    throw new AppError(400, 'invalid_input', `${field} must be a 3-letter ISO currency code`);
  }

  return upper;
}

function normalizeOptionalMoneyAmount(value: unknown, field: string): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new AppError(400, 'invalid_input', `${field} must be a non-negative number or null`);
  }

  return Number(value);
}

function normalizeApplicationIntake(value: unknown, field: string): CreateApplicationInput['intake'] {
  const payload = value === undefined ? {} : requireObject(value, field);
  const priceValue = payload.price === undefined ? undefined : requireObject(payload.price, `${field}.price`);

  return {
    kind: payload.kind === undefined ? undefined : requireApplicationIntakeKind(payload.kind, `${field}.kind`),
    price: priceValue === undefined
      ? undefined
      : {
          amount: normalizeOptionalMoneyAmount(priceValue.amount, `${field}.price.amount`),
          currency: normalizeOptionalCurrencyCode(priceValue.currency, `${field}.price.currency`),
        },
    bookingUrl: normalizeOptionalString(payload.bookingUrl, `${field}.bookingUrl`),
    bookedAt: normalizeOptionalString(payload.bookedAt, `${field}.bookedAt`),
    completedAt: normalizeOptionalString(payload.completedAt, `${field}.completedAt`),
  };
}

function normalizeApplicationMetadataPatch(value: unknown, field: string): Record<string, unknown> | undefined {
  return value === undefined ? undefined : requireObject(value, field);
}

function buildSuccessResponse(input: {
  action: string;
  actor: ActorContext;
  requestScope: RequestScope;
  sharedContext: SharedResponseContext;
  data: unknown;
}) {
  return {
    action: input.action,
    actor: {
      member: input.actor.member,
      globalRoles: input.actor.globalRoles,
      activeMemberships: input.actor.memberships,
      requestScope: input.requestScope,
      sharedContext: input.sharedContext,
    },
    data: input.data,
  };
}

export function buildApp({ repository }: { repository: Repository }) {
  return {
    async handleAction(input: {
      bearerToken: string | null;
      action: unknown;
      payload?: unknown;
    }) {
      const action = requireNonEmptyString(input.action, 'action');
      const payload = (input.payload ?? {}) as Record<string, unknown>;
      const coldApplicationResponse = await handleColdApplicationAction({
        action,
        payload,
        repository,
        createAppError: (status, code, message) => new AppError(status, code, message),
        requireNonEmptyString,
      });
      if (coldApplicationResponse) {
        return coldApplicationResponse;
      }

      const bearerToken = requireNonEmptyString(input.bearerToken, 'Authorization bearer token');
      const auth = await repository.authenticateBearerToken(bearerToken);

      if (!auth) {
        throw new AppError(401, 'unauthorized', 'Unknown bearer token');
      }

      const actor = auth.actor;
      const sharedContext = auth.sharedContext ?? { pendingUpdates: [] };

      const admissionsResponse = await handleAdmissionsAction({
        action,
        payload,
        actor,
        sharedContext,
        repository,
        buildSuccessResponse,
        createAppError: (status, code, message) => new AppError(status, code, message),
        normalizeLimit,
        normalizeOptionalString,
        requireAccessibleNetwork,
        requireMembershipOwner,
        requireMembershipState,
        requireApplicationStatus,
        requireApplicationPath,
        normalizeApplicationIntake,
        normalizeApplicationMetadataPatch,
        requireNonEmptyString,
        requireObject,
      });
      if (admissionsResponse) {
        return admissionsResponse;
      }

      const profileResponse = await handleProfileAction({
        action,
        payload,
        actor,
        requestScope: auth.requestScope,
        sharedContext,
        repository,
        buildSuccessResponse,
        createAppError: (status, code, message) => new AppError(status, code, message),
        normalizeProfilePatch,
        requireNonEmptyString,
      });
      if (profileResponse) {
        return profileResponse;
      }

      const updatesResponse = await handleUpdatesAction({
        action,
        payload,
        actor,
        requestScope: auth.requestScope,
        sharedContext,
        repository,
        buildSuccessResponse,
        createAppError: (status, code, message) => new AppError(status, code, message),
        normalizeLimit,
        requireInteger,
        requireNonEmptyString,
      });
      if (updatesResponse) {
        return updatesResponse;
      }

      const contentResponse = await handleContentAction({
        action,
        payload,
        actor,
        sharedContext,
        repository,
        buildSuccessResponse,
        createAppError: (status, code, message) => new AppError(status, code, message),
        normalizeLimit,
        normalizeOptionalInteger,
        normalizeOptionalString,
        normalizeEntityKinds,
        normalizeEntityPatch,
        requireAccessibleNetwork,
        requireEntityKind,
        requireEventRsvpState,
        requireNonEmptyString,
        requireObject,
      });
      if (contentResponse) {
        return contentResponse;
      }

      const messageResponse = await handleMessageAction({
        action,
        payload,
        actor,
        sharedContext,
        repository,
        buildSuccessResponse,
        createAppError: (status, code, message) => new AppError(status, code, message),
        normalizeLimit,
        requireAccessibleNetwork,
        requireNonEmptyString,
      });
      if (messageResponse) {
        return messageResponse;
      }

      const systemResponse = await handleSystemAction({
        action,
        payload,
        actor,
        requestScope: auth.requestScope,
        sharedContext,
        repository,
        buildSuccessResponse,
        createAppError: (status, code, message) => new AppError(status, code, message),
        normalizeOptionalString,
        normalizeTokenCreateInput,
        requireNonEmptyString,
        requireSuperadmin,
      });
      if (systemResponse) {
        return systemResponse;
      }

      throw new AppError(400, 'unknown_action', `Unsupported action: ${action}`);
    },
  };
}
