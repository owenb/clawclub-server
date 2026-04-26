/**
 * Identity domain — members, auth, profiles, clubs, memberships, subscriptions.
 */

import type { Pool } from 'pg';
import type {
  AdminMemberSummary,
  BearerTokenSummary,
  ClubSummary,
  CreateBearerTokenInput,
  CreateClubInput,
  CreateMembershipInput,
  CreatedBearerToken,
  ArchiveClubInput,
  AssignClubOwnerInput,
  ClubProfileFields,
  UpdateMembershipInput,
  ProfileForGate,
  MemberProfileEnvelope,
  MemberIdentity,
  MemberRef,
  MemberSearchResult,
  MembershipAdminSummary,
  MembershipState,
  PublicMemberSummary,
  RevokeBearerTokenInput,
  TransitionMembershipInput,
  UpdateClubInput,
  UpdateClubProfileInput,
  UpdateMemberIdentityInput,
} from '../repository.ts';
import type { AuthResult, AuthenticatedActor } from '../actors.ts';

import type { DbClient } from '../db.ts';
import { authenticateBearerToken, validateBearerTokenPassive, readActor } from './auth.ts';
import * as tokens from './tokens.ts';
import * as members from './members.ts';
import * as memberships from './memberships.ts';
import * as profiles from './profiles.ts';
import * as clubs from './clubs.ts';

export type IdentityRepository = {
  // Auth
  authenticateBearerToken(bearerToken: string): Promise<AuthResult | null>;
  validateBearerTokenPassive(bearerToken: string): Promise<AuthResult | null>;
  readActor(memberId: string): Promise<AuthenticatedActor | null>;

  // Tokens
  listBearerTokens(input: { actorMemberId: string }): Promise<BearerTokenSummary[]>;
  createBearerToken(input: CreateBearerTokenInput): Promise<CreatedBearerToken>;
  revokeBearerToken(input: RevokeBearerTokenInput): Promise<BearerTokenSummary | null>;
  issueTokenForMember(input: {
    memberId: string;
    label: string;
    metadata: Record<string, unknown>;
    expiresAt?: string | null;
  }): Promise<{ bearerToken: string }>;
  createBearerTokenAsSuperadmin(input: {
    actorMemberId: string;
    clientKey: string;
    idempotencyActorContext: string;
    idempotencyRequestValue: unknown;
    memberId: string;
    label?: string | null;
    expiresAt?: string | null;
    reason?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<CreatedBearerToken | null>;

  // Memberships
  createMembership(input: CreateMembershipInput): Promise<MembershipAdminSummary | null>;
  transitionMembershipState(input: TransitionMembershipInput): Promise<MembershipAdminSummary | null>;
  updateMembership(input: UpdateMembershipInput): Promise<{ membership: MembershipAdminSummary; changed: boolean } | null>;
  listMembers(input: { actorMemberId: string; clubId: string; limit: number; cursor?: { joinedAt: string; membershipId: string } | null }): Promise<{ results: PublicMemberSummary[]; hasMore: boolean; nextCursor: string | null }>;
  getMember(input: { actorMemberId: string; clubId: string; memberId: string }): Promise<PublicMemberSummary | null>;
  listAdminMembers(input: {
    actorMemberId: string;
    clubId: string;
    limit: number;
    statuses?: Array<Extract<MembershipState, 'active' | 'cancelled'>> | null;
    roles?: Array<'clubadmin' | 'member'> | null;
    cursor?: { joinedAt: string; membershipId: string } | null;
  }): Promise<{ results: AdminMemberSummary[]; hasMore: boolean; nextCursor: string | null }>;
  getAdminMember(input: { actorMemberId: string; clubId: string; memberId: string }): Promise<AdminMemberSummary | null>;
  buildMembershipSeedProfile(input: { memberId: string; clubId: string }): Promise<ClubProfileFields>;
  promoteMemberToAdmin(input: { actorMemberId: string; clubId: string; memberId: string }): Promise<{ membership: MembershipAdminSummary; changed: boolean } | null>;
  demoteMemberFromAdmin(input: { actorMemberId: string; clubId: string; memberId: string }): Promise<{ membership: MembershipAdminSummary; changed: boolean } | null>;

  // Superadmin member/membership creation
  createMemberDirect(input: {
    actorMemberId: string;
    clientKey: string;
    idempotencyActorContext: string;
    idempotencyRequestValue: unknown;
    publicName: string;
    email: string;
  }): Promise<{ member: MemberRef; token: CreatedBearerToken }>;
  removeMember(input: import('../repository.ts').RemoveMemberInput): Promise<import('../repository.ts').RemovedMemberSummary | null>;
  createMembershipAsSuperadmin(input: {
    actorMemberId: string;
    clientKey: string;
    idempotencyActorContext: string;
    idempotencyRequestValue: unknown;
    clubId: string;
    memberId: string;
    role: 'member' | 'clubadmin';
    sponsorId?: string | null;
    initialStatus: 'active';
    reason?: string | null;
    initialProfile: {
      fields: ClubProfileFields;
      generationSource: 'membership_seed' | 'application_generated';
    };
  }): Promise<MembershipAdminSummary | null>;

  // Profiles
  updateMemberIdentity(input: { actor: AuthenticatedActor; patch: UpdateMemberIdentityInput; clientKey: string }): Promise<MemberIdentity>;
  updateClubProfile(input: { actor: AuthenticatedActor; patch: UpdateClubProfileInput }): Promise<MemberProfileEnvelope>;
  loadProfileForGate(input: { actorMemberId: string; clubId: string }): Promise<ProfileForGate | null>;

  // Clubs
  findClubBySlug(input: { actorMemberId: string; slug: string }): Promise<ClubSummary | null>;
  listClubs(input: {
    actorMemberId: string;
    includeArchived: boolean;
    limit: number;
    cursor?: { archivedAt: string; name: string; clubId: string } | null;
  }): Promise<{ results: ClubSummary[]; hasMore: boolean; nextCursor: string | null }>;
  createClub(input: CreateClubInput): Promise<ClubSummary | null>;
  archiveClub(input: ArchiveClubInput): Promise<ClubSummary | null>;
  assignClubOwner(input: AssignClubOwnerInput): Promise<ClubSummary | null>;
  updateClub(input: UpdateClubInput): Promise<ClubSummary | null>;
  removeClub(input: import('../repository.ts').RemoveClubInput): Promise<{
    archiveId: string;
    clubId: string;
    clubSlug: string;
    removedAt: string;
    retainedUntil: string;
  } | null>;
  listRemovedClubs(input: {
    actorMemberId: string;
    limit: number;
    cursor?: { removedAt: string; archiveId: string } | null;
    clubSlug?: string | null;
  }): Promise<{ results: import('../repository.ts').RemovedClubSummary[]; hasMore: boolean; nextCursor: string | null }>;
  restoreRemovedClub(input: import('../repository.ts').RestoreRemovedClubInput): Promise<ClubSummary | null>;
  loadClubForGate(input: { actorMemberId: string; clubId: string }): Promise<import('../repository.ts').ClubForGate | null>;

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
    issueTokenForMember: (input) => tokens.issueTokenForMember(pool, input),
    createBearerTokenAsSuperadmin: (input) => tokens.createBearerTokenAsSuperadmin(pool, input),

    // Memberships
    createMembership: (input) => memberships.createMembership(pool, input),
    transitionMembershipState: (input) => memberships.transitionMembershipState(pool, input),
    updateMembership: (input) => memberships.updateMembership(pool, input),
    listMembers: ({ clubId, limit, cursor }) => memberships.listMembers(pool, { clubId, limit, cursor }),
    getMember: ({ clubId, memberId }) => memberships.getMember(pool, { clubId, memberId }),
    listAdminMembers: ({ clubId, limit, statuses, roles, cursor }) => memberships.listAdminMembers(pool, { clubId, limit, statuses, roles, cursor }),
    getAdminMember: ({ clubId, memberId }) => memberships.getAdminMember(pool, { clubId, memberId }),
    buildMembershipSeedProfile: ({ memberId, clubId }) => profiles.buildMembershipSeedProfile(pool, { memberId, clubId }),
    promoteMemberToAdmin: (input) => memberships.promoteMemberToAdmin(pool, input),
    demoteMemberFromAdmin: (input) => memberships.demoteMemberFromAdmin(pool, input),

    // Superadmin member/membership creation
    createMemberDirect: (input) => memberships.createMemberDirect(pool, input),
    removeMember: (input) => members.removeMember(pool, input),
    createMembershipAsSuperadmin: (input) => memberships.createMembershipAsSuperadmin(pool, input),

    // Profiles
    updateMemberIdentity: ({ actor, patch, clientKey }) => profiles.updateMemberIdentity(pool, actor, patch, clientKey),
    updateClubProfile: ({ actor, patch }) => profiles.updateClubProfile(pool, actor, patch),
    loadProfileForGate: ({ actorMemberId, clubId }) => profiles.loadProfileForGate(pool, { actorMemberId, clubId }),

    // Clubs
    findClubBySlug: ({ slug }) => clubs.findClubBySlug(pool, slug),
    listClubs: ({ includeArchived, limit, cursor }) => clubs.listClubs(pool, { includeArchived, limit, cursor }),
    createClub: (input) => clubs.createClub(pool, input),
    archiveClub: (input) => clubs.archiveClub(pool, input),
    assignClubOwner: (input) => clubs.assignClubOwner(pool, input),
    updateClub: (input) => clubs.updateClub(pool, input),
    removeClub: (input) => clubs.removeClub(pool, input),
    listRemovedClubs: ({ limit, cursor, clubSlug }) => clubs.listRemovedClubs(pool, { limit, cursor, clubSlug }),
    restoreRemovedClub: (input) => clubs.restoreRemovedClub(pool, input),
    loadClubForGate: ({ clubId }) => clubs.loadClubForGate(pool, { clubId }),

    // Search
    fullTextSearchMembers: (input) => profiles.fullTextSearchMembers(pool, input),
    findMembersViaEmbedding: (input) => profiles.findMembersViaEmbedding(pool, input),
  };
}
