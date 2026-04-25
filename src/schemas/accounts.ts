import { z } from 'zod';
import { AppError } from '../repository.ts';
import {
  describeClientKey,
  parseEmail,
  parsePublicName,
  parseBoundedString,
  parseRequiredString,
  timestampString,
  wireBoundedString,
  wireEmail,
  wirePublicName,
  wireRequiredString,
} from './fields.ts';
import { memberIdentity } from './responses.ts';
import { registerActions, type ActionDefinition, type ActionResult, type ColdHandlerContext, type HandlerContext } from './registry.ts';

const wireAsciiEmail = wireEmail.describe('ASCII email address. Server trims, lowercases, and validates address shape.');
const parseAsciiEmail = parseEmail.refine((value) => /^[\x00-\x7F]+$/.test(value), 'Email must use ASCII characters only');
const INVITATION_CODE_MAX_CHARS = 64;
const wireInvitationCode = z.string()
  .max(INVITATION_CODE_MAX_CHARS)
  .describe('Optional invitation code for reduced registration proof-of-work. Max 64 characters; blank strings are treated as absent.');
const parseOptionalInvitationCode = z.string()
  .max(INVITATION_CODE_MAX_CHARS)
  .trim()
  .transform((value) => value.length === 0 ? undefined : value)
  .optional();

function invitationDiscoverFieldsArePaired(input: { invitationCode?: string; email?: string }): boolean {
  return (input.invitationCode === undefined) === (input.email === undefined);
}

function addInvitationDiscoverPairingIssue(input: { invitationCode?: string; email?: string }, ctx: z.RefinementCtx): void {
  if (invitationDiscoverFieldsArePaired(input)) return;
  ctx.addIssue({
    code: 'custom',
    path: input.invitationCode === undefined ? ['invitationCode'] : ['email'],
    message: 'invitationCode and email must be supplied together for invited registration discovery.',
  });
}

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
    {
      code: 'invitation_invalid',
      meaning: 'No invitation matches the supplied code.',
      recovery: 'Call accounts.register discover again with the correct invitation code and email, or ask the sponsor to confirm the code.',
    },
    {
      code: 'invitation_revoked',
      meaning: 'The invitation has been revoked.',
      recovery: 'Ask the sponsor to issue a new invitation, then call accounts.register discover again with the new code and matching email.',
    },
    {
      code: 'invitation_expired',
      meaning: 'The invitation has expired.',
      recovery: 'Ask the sponsor to issue a new invitation, then call accounts.register discover again with the new code and matching email.',
    },
    {
      code: 'invitation_used',
      meaning: 'The invitation has already been redeemed.',
      recovery: 'Ask the sponsor to confirm whether this invitation has already been used, or request a new invitation.',
    },
    {
      code: 'invitation_support_withdrawn',
      meaning: 'The sponsor has withdrawn support for this invitation.',
      recovery: 'Contact the sponsor before retrying. Registration with this invitation cannot continue while support is withdrawn.',
    },
    {
      code: 'email_does_not_match_invite',
      meaning: 'The submitted email does not match the candidate email on this invitation.',
      recovery: 'Call accounts.register discover again with the email address the sponsor invited, or ask the sponsor to issue a new invitation for the correct email.',
    },
  ],
  wire: {
    input: z.discriminatedUnion('mode', [
      z.object({
        mode: z.literal('discover').describe('First call: get a registration proof-of-work challenge.'),
        invitationCode: wireInvitationCode.optional(),
        email: wireAsciiEmail.optional(),
      }).superRefine(addInvitationDiscoverPairingIssue),
      z.object({
        mode: z.literal('submit').describe('Second call: complete registration with the solved nonce.'),
        clientKey: wireRequiredString.describe(describeClientKey('Client-generated idempotency key for the registration submit step.')),
        name: wirePublicName.describe('Public display name for the new account'),
        email: wireAsciiEmail,
        challengeBlob: wireRequiredString.describe('Challenge blob returned by accounts.register discover'),
        nonce: wireRequiredString.describe('Proof-of-work solution for the supplied challenge'),
        invitationCode: wireInvitationCode.optional(),
      }),
    ]),
    output: registerOutput,
  },
  parse: {
    input: z.discriminatedUnion('mode', [
      z.object({
        mode: z.literal('discover'),
        invitationCode: parseOptionalInvitationCode,
        email: parseAsciiEmail.optional(),
      }).superRefine(addInvitationDiscoverPairingIssue),
      z.object({
        mode: z.literal('submit'),
        clientKey: parseRequiredString,
        name: parsePublicName,
        email: parseAsciiEmail,
        challengeBlob: parseRequiredString,
        nonce: parseRequiredString,
        invitationCode: parseOptionalInvitationCode,
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
      invitationCode?: string;
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
