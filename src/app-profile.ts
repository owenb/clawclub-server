import type {
  ActorContext,
  Repository,
  RequestScope,
  SharedResponseContext,
  UpdateOwnProfileInput,
} from './app.ts';

type BuildSuccessResponse = (input: {
  action: string;
  actor: ActorContext;
  requestScope: RequestScope;
  sharedContext: SharedResponseContext;
  data: unknown;
}) => unknown;

type CreateAppError = (status: number, code: string, message: string) => Error;
type NormalizeProfilePatch = (payload: Record<string, unknown>) => UpdateOwnProfileInput;
type RequireNonEmptyString = (value: unknown, field: string) => string;

export async function handleProfileAction(input: {
  action: string;
  payload: Record<string, unknown>;
  actor: ActorContext;
  requestScope: RequestScope;
  sharedContext: SharedResponseContext;
  repository: Repository;
  buildSuccessResponse: BuildSuccessResponse;
  createAppError: CreateAppError;
  normalizeProfilePatch: NormalizeProfilePatch;
  requireNonEmptyString: RequireNonEmptyString;
}): Promise<unknown | null> {
  const {
    action,
    actor,
    buildSuccessResponse,
    createAppError,
    normalizeProfilePatch,
    payload,
    repository,
    requestScope,
    requireNonEmptyString,
    sharedContext,
  } = input;

  switch (action) {
    case 'profile.get': {
      const targetMemberId = payload.memberId === undefined ? actor.member.id : requireNonEmptyString(payload.memberId, 'memberId');
      const profile = await repository.getMemberProfile({
        actorMemberId: actor.member.id,
        targetMemberId,
      });

      if (!profile) {
        throw createAppError(404, 'not_found', 'Member profile not found inside the actor scope');
      }

      return buildSuccessResponse({
        action,
        actor,
        requestScope,
        sharedContext,
        data: profile,
      });
    }

    case 'profile.update': {
      const patch = normalizeProfilePatch(payload);
      const updatedProfile = await repository.updateOwnProfile({ actor, patch });

      return buildSuccessResponse({
        action,
        actor: {
          member: {
            id: updatedProfile.memberId,
            handle: updatedProfile.handle,
            publicName: updatedProfile.publicName,
          },
          memberships: actor.memberships,
          globalRoles: actor.globalRoles,
        },
        requestScope,
        sharedContext,
        data: updatedProfile,
      });
    }

    default:
      return null;
  }
}
