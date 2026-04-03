import type { Repository } from './app.ts';
import type { SolveAdmissionChallengeInput } from './app-contract.ts';
import { normalizeCandidateEmail, normalizeCandidateFullName, requireBoundedString, type CreateAppError, type RequireNonEmptyString } from './app-helpers.ts';

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
        name: normalizeCandidateFullName(payload.name, requireNonEmptyString, createAppError),
        email: normalizeCandidateEmail(payload.email, requireNonEmptyString, createAppError),
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
