import type { MembershipSummary } from './repository.ts';
import type { ResponseNotifications } from './notifications.ts';

export type MemberActor = {
  id: string;
  publicName: string;
};

export type AuthenticatedActor = {
  kind: 'authenticated';
  member: MemberActor;
  memberships: MembershipSummary[];
  globalRoles: Array<'superadmin'>;
};

export type AnonymousActor = {
  kind: 'anonymous';
  memberships: [];
  globalRoles: [];
};

export type Actor = AnonymousActor | AuthenticatedActor;

export type RequestScope = {
  requestedClubId: string | null;
  activeClubIds: string[];
};

type MembershipScopeInput = Pick<MembershipSummary, 'clubId' | 'role' | 'isOwner'>;

type MembershipCarrier = {
  memberships: Array<{ clubId: string }>;
};

export function membershipScopes(memberships: readonly MembershipScopeInput[]): {
  clubIds: string[];
  adminClubIds: string[];
  ownerClubIds: string[];
} {
  const clubIds: string[] = [];
  const adminClubIds: string[] = [];
  const ownerClubIds: string[] = [];

  // Preserve input order so callers can safely reuse clubIds in requestScope.
  for (const membership of memberships) {
    clubIds.push(membership.clubId);
    if (membership.role === 'clubadmin') {
      adminClubIds.push(membership.clubId);
    }
    if (membership.isOwner) {
      ownerClubIds.push(membership.clubId);
    }
  }

  return { clubIds, adminClubIds, ownerClubIds };
}

export function requestScopeForClubs(
  requestedClubId: string | null,
  activeClubIds: string[],
): RequestScope {
  return { requestedClubId, activeClubIds };
}

export function requestScopeForClub(clubId: string): RequestScope {
  return requestScopeForClubs(clubId, [clubId]);
}

export function requestScopeForActor(
  actor: MembershipCarrier,
  requestedClubId: string | null,
): RequestScope {
  return requestScopeForClubs(
    requestedClubId,
    actor.memberships.map((membership) => membership.clubId),
  );
}

export type AuthResult = {
  actor: AuthenticatedActor;
  requestScope: RequestScope;
  sharedContext: ResponseNotifications;
};
