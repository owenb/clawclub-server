/**
 * Identity domain — members, auth, profiles, clubs, memberships, subscriptions.
 */

import type { Pool } from 'pg';
import type {
  ActorContext,
  AuthResult,
  BearerTokenSummary,
  ClubMemberSummary,
  ClubSummary,
  CreateBearerTokenInput,
  CreateClubInput,
  CreateMembershipInput,
  CreatedBearerToken,
  ArchiveClubInput,
  AssignClubOwnerInput,
  ClubProfileFields,
  MemberProfileEnvelope,
  MemberIdentity,
  MemberSearchResult,
  MembershipAdminSummary,
  MembershipReviewSummary,
  MembershipState,
  RevokeBearerTokenInput,
  TransitionMembershipInput,
  UpdateClubInput,
  UpdateClubProfileInput,
  UpdateMemberIdentityInput,
} from '../contract.ts';

import type { DbClient } from '../db.ts';
import { authenticateBearerToken, validateBearerTokenPassive, readActor } from './auth.ts';
import * as tokens from './tokens.ts';
import * as memberships from './memberships.ts';
import * as profiles from './profiles.ts';
import * as clubs from './clubs.ts';

export type IdentityRepository = {
  // Auth
  authenticateBearerToken(bearerToken: string): Promise<AuthResult | null>;
  validateBearerTokenPassive(bearerToken: string): Promise<AuthResult | null>;
  readActor(memberId: string): Promise<ActorContext | null>;

  // Tokens
  listBearerTokens(input: { actorMemberId: string }): Promise<BearerTokenSummary[]>;
  createBearerToken(input: CreateBearerTokenInput): Promise<CreatedBearerToken>;
  revokeBearerToken(input: RevokeBearerTokenInput): Promise<BearerTokenSummary | null>;
  issueTokenForMember(memberId: string, label: string, metadata: Record<string, unknown>): Promise<{ bearerToken: string }>;
  createBearerTokenAsSuperadmin(input: {
    actorMemberId: string;
    memberId: string;
    label?: string | null;
    expiresAt?: string | null;
    reason?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<CreatedBearerToken | null>;

  // Memberships
  listMemberships(input: { actorMemberId: string; clubIds: string[]; limit: number; status?: MembershipState; cursor?: { stateCreatedAt: string; id: string } | null }): Promise<{ results: MembershipAdminSummary[]; hasMore: boolean; nextCursor: string | null }>;
  createMembership(input: CreateMembershipInput): Promise<MembershipAdminSummary | null>;
  transitionMembershipState(input: TransitionMembershipInput): Promise<MembershipAdminSummary | null>;
  listMembershipReviews(input: { actorMemberId: string; clubIds: string[]; limit: number; statuses: MembershipState[]; cursor?: { stateCreatedAt: string; id: string } | null }): Promise<{ results: MembershipReviewSummary[]; hasMore: boolean; nextCursor: string | null }>;
  listMembers(input: { actorMemberId: string; clubId: string; limit: number; cursor?: { joinedAt: string; memberId: string } | null }): Promise<{ results: ClubMemberSummary[]; hasMore: boolean; nextCursor: string | null }>;
  buildMembershipSeedProfile(input: { memberId: string; clubId: string }): Promise<ClubProfileFields>;
  promoteMemberToAdmin(input: { actorMemberId: string; clubId: string; memberId: string }): Promise<{ membership: MembershipAdminSummary; changed: boolean } | null>;
  demoteMemberFromAdmin(input: { actorMemberId: string; clubId: string; memberId: string }): Promise<{ membership: MembershipAdminSummary; changed: boolean } | null>;

  // Superadmin member/membership creation
  createMemberDirect(input: { actorMemberId: string; publicName: string; email?: string | null }): Promise<{ memberId: string; publicName: string; bearerToken: string }>;
  createMembershipAsSuperadmin(input: {
    actorMemberId: string;
    clubId: string;
    memberId: string;
    role: 'member' | 'clubadmin';
    sponsorMemberId?: string | null;
    initialStatus: Extract<MembershipState, 'applying' | 'submitted' | 'active' | 'payment_pending'>;
    reason?: string | null;
    initialProfile: {
      fields: ClubProfileFields;
      generationSource: 'membership_seed' | 'application_generated';
    };
  }): Promise<MembershipAdminSummary | null>;

  // Membership helpers
  setComped(membershipId: string, compedByMemberId: string): Promise<void>;
  hasLiveAccess(membershipId: string): Promise<boolean>;

  // Profiles
  listMemberProfiles(input: { actorMemberId: string; targetMemberId: string; actorClubIds: string[]; clubId?: string }): Promise<MemberProfileEnvelope | null>;
  updateMemberIdentity(input: { actor: ActorContext; patch: UpdateMemberIdentityInput }): Promise<MemberIdentity>;
  updateClubProfile(input: { actor: ActorContext; patch: UpdateClubProfileInput }): Promise<MemberProfileEnvelope>;

  // Clubs
  listClubs(input: { actorMemberId: string; includeArchived: boolean }): Promise<ClubSummary[]>;
  createClub(input: CreateClubInput): Promise<ClubSummary | null>;
  archiveClub(input: ArchiveClubInput): Promise<ClubSummary | null>;
  assignClubOwner(input: AssignClubOwnerInput): Promise<ClubSummary | null>;
  updateClub(input: UpdateClubInput): Promise<ClubSummary | null>;

  // Search
  fullTextSearchMembers(input: { actorMemberId: string; clubId: string; query: string; limit: number; cursor?: { rank: string; memberId: string } | null }): Promise<{ results: MemberSearchResult[]; hasMore: boolean; nextCursor: string | null }>;
  findMembersViaEmbedding(input: { actorMemberId: string; clubId: string; queryEmbedding: string; limit: number; cursor?: { distance: string; memberId: string } | null }): Promise<{ results: MemberSearchResult[]; hasMore: boolean; nextCursor: string | null }>;
};

export function createIdentityRepository(pool: Pool): IdentityRepository {
  return {
    authenticateBearerToken: (bearerToken) => authenticateBearerToken(pool, bearerToken),
    validateBearerTokenPassive: (bearerToken) => validateBearerTokenPassive(pool, bearerToken),
    readActor: (memberId) => readActor(pool, memberId),

    // Tokens
    listBearerTokens: ({ actorMemberId }) => tokens.listBearerTokens(pool, actorMemberId),
    createBearerToken: (input) => tokens.createBearerToken(pool, input),
    revokeBearerToken: (input) => tokens.revokeBearerToken(pool, input),
    issueTokenForMember: (memberId, label, metadata) => tokens.issueTokenForMember(pool, memberId, label, metadata),
    createBearerTokenAsSuperadmin: (input) => tokens.createBearerTokenAsSuperadmin(pool, input),

    // Memberships
    listMemberships: ({ clubIds, limit, status, cursor }) => memberships.listMemberships(pool, { clubIds, limit, status, cursor }),
    createMembership: (input) => memberships.createMembership(pool, input),
    transitionMembershipState: (input) => memberships.transitionMembershipState(pool, input),
    listMembershipReviews: ({ clubIds, limit, statuses, cursor }) => memberships.listMembershipReviews(pool, { clubIds, limit, statuses, cursor }),
    listMembers: ({ clubId, limit, cursor }) => memberships.listMembers(pool, { clubId, limit, cursor }),
    buildMembershipSeedProfile: ({ memberId, clubId }) => profiles.buildMembershipSeedProfile(pool, { memberId, clubId }),
    promoteMemberToAdmin: (input) => memberships.promoteMemberToAdmin(pool, input),
    demoteMemberFromAdmin: (input) => memberships.demoteMemberFromAdmin(pool, input),

    // Superadmin member/membership creation
    createMemberDirect: (input) => memberships.createMemberDirect(pool, input),
    createMembershipAsSuperadmin: (input) => memberships.createMembershipAsSuperadmin(pool, input),

    // Membership helpers
    setComped: (membershipId, compedByMemberId) => {
      return pool.query(
        `update club_memberships set is_comped = true, comped_at = now(), comped_by_member_id = $2
         where id = $1 and is_comped = false`,
        [membershipId, compedByMemberId],
      ).then(() => {});
    },
    hasLiveAccess: async (membershipId) => {
      const result = await pool.query<{ has_access: boolean }>(
        `select exists(
           select 1 from club_memberships where id = $1 and is_comped = true
           union all
           select 1 from club_subscriptions
           where membership_id = $1
             and status in ('trialing', 'active', 'past_due')
             and coalesce(ended_at, 'infinity'::timestamptz) > now()
             and coalesce(current_period_end, 'infinity'::timestamptz) > now()
         ) as has_access`,
        [membershipId],
      );
      return result.rows[0]?.has_access === true;
    },

    // Profiles
    listMemberProfiles: ({ actorMemberId, targetMemberId, actorClubIds, clubId }) => profiles.listMemberProfiles(pool, { actorMemberId, targetMemberId, actorClubIds, clubId }),
    updateMemberIdentity: ({ actor, patch }) => profiles.updateMemberIdentity(pool, actor, patch),
    updateClubProfile: ({ actor, patch }) => profiles.updateClubProfile(pool, actor, patch),

    // Clubs
    listClubs: ({ includeArchived }) => clubs.listClubs(pool, includeArchived),
    createClub: (input) => clubs.createClub(pool, input),
    archiveClub: (input) => clubs.archiveClub(pool, input),
    assignClubOwner: (input) => clubs.assignClubOwner(pool, input),
    updateClub: (input) => clubs.updateClub(pool, input),

    // Search
    fullTextSearchMembers: (input) => profiles.fullTextSearchMembers(pool, input),
    findMembersViaEmbedding: (input) => profiles.findMembersViaEmbedding(pool, input),
  };
}
