export type ActionAuth = 'none' | 'member' | 'owner' | 'superadmin';
export type ActionSafety = 'read_only' | 'mutating';

export type ActionSpec = {
  action: string;
  domain: string;
  description: string;
  auth: ActionAuth;
  safety: ActionSafety;
  aiExposed: boolean;
};

export const ACTION_MANIFEST: ActionSpec[] = [
  // Cold applications (unauthenticated)
  { action: 'applications.challenge', domain: 'cold-applications', description: 'Request a proof-of-work challenge for a cold application.', auth: 'none', safety: 'mutating', aiExposed: false },
  { action: 'applications.solve', domain: 'cold-applications', description: 'Submit a solved proof-of-work challenge to create a cold application.', auth: 'none', safety: 'mutating', aiExposed: false },

  // Session
  { action: 'session.describe', domain: 'platform', description: 'Resolve the current member session, accessible networks, and any pending update context.', auth: 'member', safety: 'read_only', aiExposed: true },

  // Networks (superadmin)
  { action: 'networks.list', domain: 'platform', description: 'List all networks (superadmin only).', auth: 'superadmin', safety: 'read_only', aiExposed: false },
  { action: 'networks.create', domain: 'platform', description: 'Create a new network (superadmin only).', auth: 'superadmin', safety: 'mutating', aiExposed: false },
  { action: 'networks.archive', domain: 'platform', description: 'Archive a network (superadmin only).', auth: 'superadmin', safety: 'mutating', aiExposed: false },
  { action: 'networks.assignOwner', domain: 'platform', description: 'Reassign network ownership (superadmin only).', auth: 'superadmin', safety: 'mutating', aiExposed: false },

  // Quotas
  { action: 'quotas.status', domain: 'platform', description: 'Get current write quota usage and limits across networks.', auth: 'member', safety: 'read_only', aiExposed: false },

  // Tokens
  { action: 'tokens.list', domain: 'platform', description: 'List bearer tokens for the current member.', auth: 'member', safety: 'read_only', aiExposed: false },
  { action: 'tokens.create', domain: 'platform', description: 'Create a new bearer token for the current member.', auth: 'member', safety: 'mutating', aiExposed: false },
  { action: 'tokens.revoke', domain: 'platform', description: 'Revoke a bearer token for the current member.', auth: 'member', safety: 'mutating', aiExposed: false },

  // Memberships & members
  { action: 'memberships.list', domain: 'admissions', description: 'List memberships in owner-managed networks.', auth: 'owner', safety: 'read_only', aiExposed: false },
  { action: 'memberships.review', domain: 'admissions', description: 'Review memberships in admissions flow with sponsor stats and vouches.', auth: 'owner', safety: 'read_only', aiExposed: true },
  { action: 'memberships.create', domain: 'admissions', description: 'Add a new member to a network.', auth: 'owner', safety: 'mutating', aiExposed: false },
  { action: 'memberships.transition', domain: 'admissions', description: 'Change a membership status (activate, pause, revoke).', auth: 'owner', safety: 'mutating', aiExposed: false },
  { action: 'vouches.create', domain: 'admissions', description: 'Vouch for another member in a shared network with a concrete reason.', auth: 'member', safety: 'mutating', aiExposed: true },
  { action: 'vouches.list', domain: 'admissions', description: 'List vouches for a member in accessible networks.', auth: 'member', safety: 'read_only', aiExposed: true },
  { action: 'sponsorships.create', domain: 'sponsorships', description: 'Recommend an outsider for admission to a network.', auth: 'member', safety: 'mutating', aiExposed: true },
  { action: 'sponsorships.list', domain: 'sponsorships', description: 'List sponsorship recommendations. Owners see all; members see their own.', auth: 'member', safety: 'read_only', aiExposed: true },
  { action: 'members.search', domain: 'admissions', description: 'Search for members by name, skill, or interests.', auth: 'member', safety: 'read_only', aiExposed: true },
  { action: 'members.list', domain: 'admissions', description: 'List members in accessible networks.', auth: 'member', safety: 'read_only', aiExposed: false },

  // Applications
  { action: 'applications.list', domain: 'admissions', description: 'List applications in owner-managed networks.', auth: 'owner', safety: 'read_only', aiExposed: true },
  { action: 'applications.create', domain: 'admissions', description: 'Create a new admissions application.', auth: 'owner', safety: 'mutating', aiExposed: true },
  { action: 'applications.transition', domain: 'admissions', description: 'Advance an application through the admissions workflow.', auth: 'owner', safety: 'mutating', aiExposed: true },

  // Profile
  { action: 'profile.get', domain: 'profile', description: 'Read a member profile. Omit memberId for the current actor.', auth: 'member', safety: 'read_only', aiExposed: true },
  { action: 'profile.update', domain: 'profile', description: 'Update the current actor profile.', auth: 'member', safety: 'mutating', aiExposed: true },

  // Content
  { action: 'entities.list', domain: 'content', description: 'List posts, asks, opportunities, or services.', auth: 'member', safety: 'read_only', aiExposed: true },
  { action: 'entities.create', domain: 'content', description: 'Create a new post, ask, opportunity, or service.', auth: 'member', safety: 'mutating', aiExposed: true },
  { action: 'entities.update', domain: 'content', description: 'Update an existing entity (author only).', auth: 'member', safety: 'mutating', aiExposed: false },
  { action: 'entities.archive', domain: 'content', description: 'Archive an entity (author only).', auth: 'member', safety: 'mutating', aiExposed: true },

  // Events
  { action: 'events.list', domain: 'content', description: 'List upcoming events.', auth: 'member', safety: 'read_only', aiExposed: true },
  { action: 'events.create', domain: 'content', description: 'Create a new event.', auth: 'member', safety: 'mutating', aiExposed: true },
  { action: 'events.rsvp', domain: 'content', description: 'RSVP to an event.', auth: 'member', safety: 'mutating', aiExposed: true },

  // Messages
  { action: 'messages.send', domain: 'messages', description: 'Send a direct message to another member.', auth: 'member', safety: 'mutating', aiExposed: true },
  { action: 'messages.list', domain: 'messages', description: 'List DM threads.', auth: 'member', safety: 'read_only', aiExposed: false },
  { action: 'messages.read', domain: 'messages', description: 'Read a DM thread transcript.', auth: 'member', safety: 'read_only', aiExposed: true },
  { action: 'messages.inbox', domain: 'messages', description: 'List DM inbox with unread counts.', auth: 'member', safety: 'read_only', aiExposed: true },

  // Updates
  { action: 'updates.list', domain: 'updates', description: 'List pending updates for the current member.', auth: 'member', safety: 'read_only', aiExposed: false },
  { action: 'updates.acknowledge', domain: 'updates', description: 'Acknowledge updates as processed or suppressed.', auth: 'member', safety: 'mutating', aiExposed: false },

  // Admin
  { action: 'admin.overview', domain: 'admin', description: 'Platform-wide stats overview.', auth: 'superadmin', safety: 'read_only', aiExposed: false },
  { action: 'admin.members.list', domain: 'admin', description: 'List all members with pagination.', auth: 'superadmin', safety: 'read_only', aiExposed: false },
  { action: 'admin.members.get', domain: 'admin', description: 'Get full member detail with all memberships.', auth: 'superadmin', safety: 'read_only', aiExposed: false },
  { action: 'admin.networks.stats', domain: 'admin', description: 'Per-network member, content, message, and application counts.', auth: 'superadmin', safety: 'read_only', aiExposed: false },
  { action: 'admin.content.list', domain: 'admin', description: 'List all content across networks.', auth: 'superadmin', safety: 'read_only', aiExposed: false },
  { action: 'admin.content.archive', domain: 'admin', description: 'Archive any content (moderation).', auth: 'superadmin', safety: 'mutating', aiExposed: false },
  { action: 'admin.messages.threads', domain: 'admin', description: 'List all message threads across networks.', auth: 'superadmin', safety: 'read_only', aiExposed: false },
  { action: 'admin.messages.read', domain: 'admin', description: 'Read any message thread.', auth: 'superadmin', safety: 'read_only', aiExposed: false },
  { action: 'admin.tokens.list', domain: 'admin', description: 'List bearer tokens for any member.', auth: 'superadmin', safety: 'read_only', aiExposed: false },
  { action: 'admin.tokens.revoke', domain: 'admin', description: 'Revoke any member bearer token.', auth: 'superadmin', safety: 'mutating', aiExposed: false },
  { action: 'admin.diagnostics.health', domain: 'admin', description: 'System diagnostics: migrations, RLS, DB size.', auth: 'superadmin', safety: 'read_only', aiExposed: false },
];

export const KNOWN_ACTIONS = new Set(ACTION_MANIFEST.map((spec) => spec.action));
export const AI_EXPOSED_ACTIONS = ACTION_MANIFEST.filter((spec) => spec.aiExposed);
