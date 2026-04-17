import type { LeakAuditContext } from '../harness.ts';

export interface LeakAuditFixture {
  buildInput: (ctx: LeakAuditContext) => Record<string, unknown>;
  note?: string;
  skipResponseWalk?: boolean;
}

export const LEAK_AUDIT_FIXTURES: Record<string, LeakAuditFixture> = {
  'accessTokens.list': { buildInput: () => ({}) },
  'activity.list': { buildInput: (ctx) => ({ clubId: ctx.testClub.id, limit: 20 }) },
  'billing.getMembershipStatus': { buildInput: (ctx) => ({ clubId: ctx.testClub.id }) },
  'clubs.applications.get': {
    buildInput: (ctx) => ({ membershipId: ctx.ownApplicationMembership.id }),
    note: 'This is the actor’s own application surface, so application content is legitimate here. Scoping is covered in test/integration/non-llm/applications-self.test.ts.',
    skipResponseWalk: true,
  },
  'clubs.applications.list': {
    buildInput: (ctx) => ({ clubId: ctx.testClub.id }),
    note: 'This is the actor’s own application surface, so application content is legitimate here when rows exist. Scoping is covered in test/integration/non-llm/applications-self.test.ts.',
    skipResponseWalk: true,
  },
  'content.get': { buildInput: (ctx) => ({ id: ctx.contentId }) },
  'content.getThread': { buildInput: (ctx) => ({ threadId: ctx.threadId, limit: 20 }) },
  'content.list': { buildInput: (ctx) => ({ clubId: ctx.testClub.id, limit: 20 }) },
  'content.searchBySemanticSimilarity': {
    buildInput: (ctx) => ({ clubId: ctx.testClub.id, query: 'community builder', limit: 20 }),
  },
  'events.list': { buildInput: (ctx) => ({ clubId: ctx.testClub.id, limit: 20 }) },
  'invitations.listMine': { buildInput: (ctx) => ({ clubId: ctx.testClub.id }) },
  'members.get': { buildInput: (ctx) => ({ clubId: ctx.testClub.id, memberId: ctx.otherMember.id }) },
  'members.list': { buildInput: (ctx) => ({ clubId: ctx.testClub.id, limit: 50 }) },
  'members.searchByFullText': { buildInput: (ctx) => ({ clubId: ctx.testClub.id, query: 'Leak', limit: 20 }) },
  'members.searchBySemanticSimilarity': {
    buildInput: (ctx) => ({ clubId: ctx.testClub.id, query: 'reliable collaborator', limit: 20 }),
  },
  'messages.getInbox': { buildInput: () => ({ limit: 20 }) },
  'messages.getThread': { buildInput: (ctx) => ({ threadId: ctx.dmThreadId, limit: 20 }) },
  'notifications.list': { buildInput: () => ({ limit: 20 }) },
  'profile.list': { buildInput: (ctx) => ({ memberId: ctx.otherMember.id, clubId: ctx.testClub.id }) },
  'quotas.getUsage': { buildInput: () => ({}) },
  'session.getContext': { buildInput: () => ({}) },
  'vouches.list': { buildInput: (ctx) => ({ clubId: ctx.testClub.id, limit: 20 }) },
};
