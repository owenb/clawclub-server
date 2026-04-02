import type { Repository } from './app.ts';
import type { SolveColdApplicationChallengeInput } from './app-contract.ts';
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

export async function handleColdApplicationAction(input: {
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
    case 'applications.challenge': {
      if (!repository.createColdApplicationChallenge) {
        throw createAppError(500, 'not_supported', 'Cold application challenges are not configured');
      }

      const challenge = await repository.createColdApplicationChallenge();

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

    case 'applications.solve': {
      if (!repository.solveColdApplicationChallenge) {
        throw createAppError(500, 'not_supported', 'Cold application challenges are not configured');
      }

      const solved = await repository.solveColdApplicationChallenge({
        challengeId: requireBoundedString(payload.challengeId, 'challengeId', requireNonEmptyString, createAppError),
        nonce: requireBoundedString(payload.nonce, 'nonce', requireNonEmptyString, createAppError),
        clubSlug: requireBoundedString(payload.clubSlug, 'clubSlug', requireNonEmptyString, createAppError),
        name: normalizeApplicantFullName(payload.name, requireNonEmptyString, createAppError),
        email: normalizeApplicantEmail(payload.email, requireNonEmptyString, createAppError),
        socials: requireBoundedString(payload.socials, 'socials', requireNonEmptyString, createAppError),
        reason: requireBoundedString(payload.reason, 'reason', requireNonEmptyString, createAppError),
      } satisfies SolveColdApplicationChallengeInput);

      if (!solved) {
        throw createAppError(404, 'not_found', 'Requested challenge was not found or the club does not exist');
      }

      return {
        action,
        data: {
          message: 'Application submitted. Watch your email — you will hear back soon.',
        },
      };
    }

    default:
      return null;
  }
}
