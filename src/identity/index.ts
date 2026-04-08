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
  MemberProfile,
  MemberSearchResult,
  MembershipAdminSummary,
  MembershipReviewSummary,
  MembershipState,
  RevokeBearerTokenInput,
  TransitionMembershipInput,
  UpdateClubInput,
  UpdateOwnProfileInput,
} from '../contract.ts';

import type { DbClient } from '../db.ts';
import { authenticateBearerToken, readActor } from './auth.ts';
import * as tokens from './tokens.ts';
import * as memberships from './memberships.ts';
import * as profiles from './profiles.ts';
import * as clubs from './clubs.ts';

export type IdentityRepository = {
  // Auth
  authenticateBearerToken(bearerToken: string): Promise<AuthResult | null>;
  readActor(memberId: string): Promise<ActorContext | null>;

  // Tokens
  listBearerTokens(input: { actorMemberId: string }): Promise<BearerTokenSummary[]>;
  createBearerToken(input: CreateBearerTokenInput): Promise<CreatedBearerToken>;
  revokeBearerToken(input: RevokeBearerTokenInput): Promise<BearerTokenSummary | null>;
  issueTokenForMember(memberId: string, label: string, metadata: Record<string, unknown>): Promise<{ bearerToken: string }>;

  // Memberships
  listMemberships(input: { actorMemberId: string; clubIds: string[]; limit: number; status?: MembershipState }): Promise<MembershipAdminSummary[]>;
  createMembership(input: CreateMembershipInput): Promise<MembershipAdminSummary | null>;
  transitionMembershipState(input: TransitionMembershipInput): Promise<MembershipAdminSummary | null>;
  listMembershipReviews(input: { actorMemberId: string; clubIds: string[]; limit: number; statuses: MembershipState[] }): Promise<MembershipReviewSummary[]>;
  listMembers(input: { actorMemberId: string; clubIds: string[]; limit: number }): Promise<ClubMemberSummary[]>;
  promoteMemberToAdmin(input: { actorMemberId: string; clubId: string; memberId: string }): Promise<MembershipAdminSummary | null>;
  demoteMemberFromAdmin(input: { actorMemberId: string; clubId: string; memberId: string }): Promise<MembershipAdminSummary | null>;

  // Superadmin member/membership creation
  createMemberDirect(input: { actorMemberId: string; publicName: string; handle?: string | null; email?: string | null }): Promise<{ memberId: string; publicName: string; handle: string; bearerToken: string }>;
  createMembershipAsSuperadmin(input: { actorMemberId: string; clubId: string; memberId: string; role: 'member' | 'clubadmin'; sponsorMemberId?: string | null; initialStatus: Extract<MembershipState, 'invited' | 'pending_review' | 'active' | 'payment_pending'>; reason?: string | null }): Promise<MembershipAdminSummary | null>;

  // Admission acceptance helpers
  createMemberFromAdmission(input: { name: string; email: string; displayName: string; details: Record<string, unknown>; admissionId: string }): Promise<string>;
  setComped(membershipId: string, compedByMemberId: string): Promise<void>;
  hasLiveAccess(membershipId: string): Promise<boolean>;
  getMemberPublicContact(memberId: string): Promise<{ memberName: string; email: string | null } | null>;

  // Profiles
  getMemberProfile(input: { actorMemberId: string; targetMemberId: string; actorClubIds: string[] }): Promise<MemberProfile | null>;

  updateOwnProfile(input: { actor: ActorContext; patch: UpdateOwnProfileInput }): Promise<MemberProfile>;

  // Clubs
  listClubs(input: { actorMemberId: string; includeArchived: boolean }): Promise<ClubSummary[]>;
  createClub(input: CreateClubInput): Promise<ClubSummary | null>;
  archiveClub(input: ArchiveClubInput): Promise<ClubSummary | null>;
  assignClubOwner(input: AssignClubOwnerInput): Promise<ClubSummary | null>;
  updateClub(input: UpdateClubInput): Promise<ClubSummary | null>;

  // Search
  fullTextSearchMembers(input: { actorMemberId: string; clubIds: string[]; query: string; limit: number }): Promise<MemberSearchResult[]>;
  findMembersViaEmbedding(input: { actorMemberId: string; clubIds: string[]; queryEmbedding: string; limit: number }): Promise<MemberSearchResult[]>;
};

export function createIdentityRepository(pool: Pool): IdentityRepository {
  return {
    authenticateBearerToken: (bearerToken) => authenticateBearerToken(pool, bearerToken),
    readActor: (memberId) => readActor(pool, memberId),

    // Tokens
    listBearerTokens: ({ actorMemberId }) => tokens.listBearerTokens(pool, actorMemberId),
    createBearerToken: (input) => tokens.createBearerToken(pool, input),
    revokeBearerToken: (input) => tokens.revokeBearerToken(pool, input),
    issueTokenForMember: (memberId, label, metadata) => tokens.issueTokenForMember(pool, memberId, label, metadata),

    // Memberships
    listMemberships: ({ clubIds, limit, status }) => memberships.listMemberships(pool, { clubIds, limit, status }),
    createMembership: (input) => memberships.createMembership(pool, input),
    transitionMembershipState: (input) => memberships.transitionMembershipState(pool, input),
    listMembershipReviews: ({ clubIds, limit, statuses }) => memberships.listMembershipReviews(pool, { clubIds, limit, statuses }),
    listMembers: ({ clubIds, limit }) => memberships.listMembers(pool, { clubIds, limit }),
    promoteMemberToAdmin: (input) => memberships.promoteMemberToAdmin(pool, input),
    demoteMemberFromAdmin: (input) => memberships.demoteMemberFromAdmin(pool, input),

    // Superadmin member/membership creation
    createMemberDirect: (input) => memberships.createMemberDirect(pool, input),
    createMembershipAsSuperadmin: (input) => memberships.createMembershipAsSuperadmin(pool, input),

    // Admission acceptance helpers
    createMemberFromAdmission: (input) => memberships.createMemberFromAdmission(pool, input),
    setComped: (membershipId, compedByMemberId) => {
      return pool.query(
        `update app.club_memberships set is_comped = true, comped_at = now(), comped_by_member_id = $2
         where id = $1 and is_comped = false`,
        [membershipId, compedByMemberId],
      ).then(() => {});
    },
    hasLiveAccess: async (membershipId) => {
      const result = await pool.query<{ has_access: boolean }>(
        `select exists(
           select 1 from app.club_memberships where id = $1 and is_comped = true
           union all
           select 1 from app.club_subscriptions
           where membership_id = $1
             and status in ('trialing', 'active', 'past_due')
             and coalesce(ended_at, 'infinity'::timestamptz) > now()
             and coalesce(current_period_end, 'infinity'::timestamptz) > now()
         ) as has_access`,
        [membershipId],
      );
      return result.rows[0]?.has_access === true;
    },
    getMemberPublicContact: (memberId) => memberships.getMemberPublicContact(pool, memberId),

    // Profiles
    getMemberProfile: ({ actorMemberId, targetMemberId, actorClubIds }) => profiles.getMemberProfile(pool, actorMemberId, targetMemberId, actorClubIds),
    updateOwnProfile: ({ actor, patch }) => profiles.updateOwnProfile(pool, actor, patch),

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
