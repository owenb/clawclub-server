import type { Repository } from './app.ts';
import type { SolveAdmissionChallengeInput } from './app-contract.ts';
import type { CreateAppError, RequireNonEmptyString } from './app-helpers.ts';

const MAX_FIELD_LENGTH = 500;

function requireBoundedString(value: unknown, field: string, requireNonEmptyString: RequireNonEmptyString, createAppError: CreateAppError): string {
  const str = requireNonEmptyString(value, field);
  if (str.length > MAX_FIELD_LENGTH) {
    throw createAppError(400, 'invalid_input', `${field} must be at most ${MAX_FIELD_LENGTH} characters`);
  }
  return str;
}

function normalizeApplicantEmail(value: unknown, requireNonEmptyString: RequireNonEmptyString, createAppError: CreateAppError): string {
  const email = requireBoundedString(value, 'email', requireNonEmptyString, createAppError).toLowerCase();
  if (!email.includes('@')) {
    throw createAppError(400, 'invalid_input', 'email must look like an email address');
  }

  return email;
}

function normalizeApplicantFullName(value: unknown, requireNonEmptyString: RequireNonEmptyString, createAppError: CreateAppError): string {
  const name = requireBoundedString(value, 'name', requireNonEmptyString, createAppError);
  const words = name.split(/\s+/).filter((w) => w.length > 0);
  if (words.length < 2) {
    throw createAppError(400, 'invalid_input', 'name must be a full name (first and last name)');
  }

  return words.join(' ');
}

export async function handleColdAdmissionAction(input: {
  action: string;
  payload: Record<string, unknown>;
  repository: Repository;
  createAppError: CreateAppError;
  requireNonEmptyString: RequireNonEmptyString;
}): Promise<unknown | null> {
  const {
    action,
    payload,
    repository,
    createAppError,
    requireNonEmptyString,
  } = input;

  switch (action) {
    case 'admissions.challenge': {
      if (!repository.createAdmissionChallenge) {
        throw createAppError(500, 'not_supported', 'Cold admission challenges are not configured');
      }

      const challenge = await repository.createAdmissionChallenge();

      return {
        action,
        data: {
          challengeId: challenge.challengeId,
          difficulty: challenge.difficulty,
          expiresAt: challenge.expiresAt,
          clubs: challenge.clubs,
        },
      };
    }

    case 'admissions.apply': {
      if (!repository.solveAdmissionChallenge) {
        throw createAppError(500, 'not_supported', 'Cold admission challenges are not configured');
      }

      const solved = await repository.solveAdmissionChallenge({
        challengeId: requireBoundedString(payload.challengeId, 'challengeId', requireNonEmptyString, createAppError),
        nonce: requireBoundedString(payload.nonce, 'nonce', requireNonEmptyString, createAppError),
        clubSlug: requireBoundedString(payload.clubSlug, 'clubSlug', requireNonEmptyString, createAppError),
        name: normalizeApplicantFullName(payload.name, requireNonEmptyString, createAppError),
        email: normalizeApplicantEmail(payload.email, requireNonEmptyString, createAppError),
        socials: requireBoundedString(payload.socials, 'socials', requireNonEmptyString, createAppError),
        reason: requireBoundedString(payload.reason, 'reason', requireNonEmptyString, createAppError),
      } satisfies SolveAdmissionChallengeInput);

      if (!solved) {
        throw createAppError(404, 'not_found', 'Requested challenge was not found or the club does not exist');
      }

      return {
        action,
        data: {
          message: 'Admission submitted. The club owner will review your request.',
        },
      };
    }

    default:
      return null;
  }
}
