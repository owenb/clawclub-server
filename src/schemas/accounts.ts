import { z } from 'zod';
import { AppError } from '../repository.ts';
import {
  describeClientKey,
  parseEmail,
  parseFullName,
  parseBoundedString,
  parseRequiredString,
  timestampString,
  wireBoundedString,
  wireEmail,
  wireFullName,
  wireRequiredString,
} from './fields.ts';
import { memberIdentity } from './responses.ts';
import { registerActions, type ActionDefinition, type ActionResult, type ColdHandlerContext, type HandlerContext } from './registry.ts';

const wireAsciiEmail = wireEmail.describe('ASCII email address. Server trims, lowercases, and validates @.');
const parseAsciiEmail = parseEmail.refine((value) => /^[\x00-\x7F]+$/.test(value), 'Email must use ASCII characters only');

const registerChallenge = z.object({
  challengeBlob: z.string(),
  challengeId: z.string(),
  difficulty: z.number(),
  expiresAt: timestampString,
});

const nextDirective = z.object({
  action: z.string().nullable(),
  requiredInputs: z.array(z.string()).optional(),
  reason: z.string(),
});

const registerOutput = z.discriminatedUnion('phase', [
  z.object({
    phase: z.literal('proof_required'),
    challenge: registerChallenge,
    next: nextDirective,
    messages: z.object({
      summary: z.string(),
      details: z.string(),
    }),
  }),
  z.object({
    phase: z.literal('registered'),
      member: z.object({
        memberId: z.string(),
        publicName: z.string(),
        email: z.string(),
        registeredAt: timestampString,
    }),
    credentials: z.object({
      kind: z.literal('member_bearer'),
      memberBearer: z.string(),
      guidance: z.string(),
    }),
    next: nextDirective,
    applicationLimits: z.object({
      inFlightCount: z.number(),
      maxInFlight: z.number(),
    }),
    messages: z.object({
      summary: z.string(),
      details: z.string(),
    }),
  }),
  z.object({
    phase: z.literal('registration_already_completed'),
      member: z.object({
        memberId: z.string(),
        publicName: z.string(),
        email: z.string(),
        registeredAt: timestampString,
      }),
    next: nextDirective,
    messages: z.object({
      summary: z.string(),
      details: z.string(),
    }),
  }),
]);

const accountsRegister: ActionDefinition = {
  action: 'accounts.register',
  domain: 'accounts',
  description: 'Create a platform account. Registration is a two-step flow: discover a proof-of-work challenge, then submit name, email, challengeBlob, nonce, and clientKey.',
  auth: 'none',
  safety: 'mutating',
  requiredCapability: 'registerAccount',
  notes: [
    'This is the only anonymous action in the register-then-apply flow.',
    'Proof-of-work: see SKILL.md §Registration PoW for the algorithm (hex SHA-256 of challengeId:nonce, trailing zeros matching difficulty).',
    'A successful submit returns the member bearer exactly once.',
    'Retrying the same clientKey after success replays sanitized metadata, never the bearer.',
    'Poll updates.list after registration for the welcome and next-step guidance.',
  ],
  businessErrors: [
    {
      code: 'email_already_registered',
      meaning: 'That email is already registered to another member.',
      recovery: 'Use a different email, or ask the operator for out-of-band recovery if you already own that address.',
    },
    {
      code: 'invalid_challenge',
      meaning: 'The supplied challenge blob was malformed, failed verification, or targeted a different flow.',
      recovery: 'Call accounts.register with mode discover again and retry with the fresh challenge.',
    },
    {
      code: 'challenge_expired',
      meaning: 'The supplied registration challenge expired before submit completed.',
      recovery: 'Call accounts.register with mode discover again and solve a fresh challenge.',
    },
    {
      code: 'challenge_already_used',
      meaning: 'The supplied registration challenge was already consumed by a previous successful submit.',
      recovery: 'Call accounts.register with mode discover again and solve a fresh challenge.',
    },
    {
      code: 'invalid_proof',
      meaning: 'The supplied nonce does not satisfy the challenge difficulty.',
      recovery: 'Solve the challenge correctly and retry submit before it expires.',
    },
  ],
  wire: {
    input: z.discriminatedUnion('mode', [
      z.object({
        mode: z.literal('discover').describe('First call: get a registration proof-of-work challenge.'),
      }),
      z.object({
        mode: z.literal('submit').describe('Second call: complete registration with the solved nonce.'),
        clientKey: wireRequiredString.describe(describeClientKey('Client-generated idempotency key for the registration submit step.')),
        name: wireFullName.describe('Public display name for the new account'),
        email: wireAsciiEmail,
        challengeBlob: wireRequiredString.describe('Challenge blob returned by accounts.register discover'),
        nonce: wireRequiredString.describe('Proof-of-work solution for the supplied challenge'),
      }),
    ]),
    output: registerOutput,
  },
  parse: {
    input: z.discriminatedUnion('mode', [
      z.object({
        mode: z.literal('discover'),
      }),
      z.object({
        mode: z.literal('submit'),
        clientKey: parseRequiredString,
        name: parseFullName,
        email: parseAsciiEmail,
        challengeBlob: parseRequiredString,
        nonce: parseRequiredString,
      }),
    ]),
  },
  async handleCold(input: unknown, ctx: ColdHandlerContext): Promise<ActionResult> {
    const result = await ctx.repository.registerAccount!(input as {
      clientKey?: string;
      mode: 'discover' | 'submit';
      name?: string;
      email?: string;
      challengeBlob?: string;
      nonce?: string;
    });
    return { data: result };
  },
};

const accountsUpdateContactEmail: ActionDefinition = {
  action: 'accounts.updateContactEmail',
  domain: 'accounts',
  description: 'Replace the member contact email used for out-of-band admin contact.',
  auth: 'member',
  safety: 'mutating',
  requiredCapability: 'updateContactEmail',
  businessErrors: [
    {
      code: 'email_already_registered',
      meaning: 'That email is already registered to another member.',
      recovery: 'Use a different email, or ask the operator for out-of-band recovery if you already own that address.',
    },
  ],
  wire: {
    input: z.object({
      newEmail: wireAsciiEmail,
      clientKey: wireRequiredString.describe(describeClientKey('Idempotency key for this contact-email replacement.')),
    }),
    output: z.object({
      member: z.object({
        memberId: z.string(),
        publicName: z.string(),
        email: z.string(),
      }),
      messages: z.object({
        summary: z.string(),
        details: z.string(),
      }),
    }),
  },
  parse: {
    input: z.object({
      newEmail: parseAsciiEmail,
      clientKey: parseRequiredString,
    }),
  },
  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const { newEmail, clientKey } = input as { newEmail: string; clientKey: string };
    const result = await ctx.repository.updateContactEmail!({
      actorMemberId: ctx.actor.member.id,
      newEmail,
      clientKey,
    });
    return {
      data: result,
    };
  },
};

type AccountsUpdateIdentityInput = {
  displayName?: string;
};

const accountsUpdateIdentity: ActionDefinition = {
  action: 'accounts.updateIdentity',
  domain: 'accounts',
  description: 'Update the current actor’s global identity fields.',
  auth: 'member',
  safety: 'mutating',
  authorizationNote: 'Updates own global identity only.',
  notes: [
    'Use this action for platform-level identity fields like displayName.',
    'Club-scoped profile fields belong on members.updateProfile.',
  ],

  wire: {
    input: z.object({
      displayName: wireBoundedString.optional().describe('Global display name, max 500 characters'),
    }),
    output: memberIdentity,
  },

  parse: {
    input: z.object({
      displayName: parseBoundedString.optional(),
    }),
  },

  async handle(input: unknown, ctx: HandlerContext): Promise<ActionResult> {
    const patch = input as AccountsUpdateIdentityInput;
    if (patch.displayName === undefined) {
      throw new AppError('invalid_input', 'At least one identity field must be provided');
    }

    const identity = await ctx.repository.updateMemberIdentity!({
      actor: ctx.actor,
      patch,
    });

    return {
      data: identity,
      nextMember: {
        id: identity.memberId,
        publicName: identity.publicName,
      },
    };
  },
};

registerActions([accountsRegister, accountsUpdateContactEmail, accountsUpdateIdentity]);
