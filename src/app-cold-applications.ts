import type {
  CreateColdApplicationChallengeInput,
  Repository,
  SolveColdApplicationChallengeInput,
} from './app.ts';

type CreateAppError = (status: number, code: string, message: string) => Error;
type RequireNonEmptyString = (value: unknown, field: string) => string;

function normalizeApplicantEmail(value: unknown, requireNonEmptyString: RequireNonEmptyString, createAppError: CreateAppError): string {
  const email = requireNonEmptyString(value, 'email').toLowerCase();
  if (!email.includes('@')) {
    throw createAppError(400, 'invalid_input', 'email must look like an email address');
  }

  return email;
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

      const challenge = await repository.createColdApplicationChallenge({
        networkSlug: requireNonEmptyString(payload.networkSlug, 'networkSlug'),
        email: normalizeApplicantEmail(payload.email, requireNonEmptyString, createAppError),
        name: requireNonEmptyString(payload.name, 'name'),
      } satisfies CreateColdApplicationChallengeInput);

      if (!challenge) {
        throw createAppError(404, 'not_found', 'Requested network was not found');
      }

      return {
        action,
        data: {
          challengeId: challenge.challengeId,
          difficulty: challenge.difficulty,
          expiresAt: challenge.expiresAt,
        },
      };
    }

    case 'applications.solve': {
      if (!repository.solveColdApplicationChallenge) {
        throw createAppError(500, 'not_supported', 'Cold application challenges are not configured');
      }

      const solved = await repository.solveColdApplicationChallenge({
        challengeId: requireNonEmptyString(payload.challengeId, 'challengeId'),
        nonce: requireNonEmptyString(payload.nonce, 'nonce'),
      } satisfies SolveColdApplicationChallengeInput);

      if (!solved) {
        throw createAppError(404, 'not_found', 'Requested challenge was not found');
      }

      return {
        action,
        data: {
          message: 'Application submitted. The network owner will review your application and may reach out by email to schedule an interview.',
        },
      };
    }

    default:
      return null;
  }
}
