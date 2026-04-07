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

  // Admission acceptance helpers
  createMemberFromAdmission(input: { name: string; email: string; displayName: string; details: Record<string, unknown>; admissionId: string }): Promise<string>;
  createCompedSubscription(membershipId: string, payerMemberId: string): Promise<void>;
  hasLiveSubscription(membershipId: string): Promise<boolean>;
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

    // Admission acceptance helpers
    createMemberFromAdmission: (input) => memberships.createMemberFromAdmission(pool, input),
    createCompedSubscription: (membershipId, payerMemberId) => {
      // Run outside a transaction — caller manages the saga
      return pool.query(
        `insert into app.subscriptions (membership_id, payer_member_id, status, amount) values ($1, $2, 'active', 0)`,
        [membershipId, payerMemberId],
      ).then(() => {});
    },
    hasLiveSubscription: async (membershipId) => {
      const result = await pool.query<{ has_sub: boolean }>(
        `select exists(
           select 1 from app.subscriptions
           where membership_id = $1
             and status in ('trialing', 'active')
             and coalesce(ended_at, 'infinity'::timestamptz) > now()
             and coalesce(current_period_end, 'infinity'::timestamptz) > now()
         ) as has_sub`,
        [membershipId],
      );
      return result.rows[0]?.has_sub === true;
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
