import { z } from 'zod';
import { DEFAULT_CONFIG_V1 } from './defaults.ts';

const clubSlugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

const contentCreateRoleMultipliersSchema = z.object({
  member: z.int().min(1).default(DEFAULT_CONFIG_V1.policy.quotas.actions['content.create'].roleMultipliers.member),
  clubadmin: z.int().min(1).default(DEFAULT_CONFIG_V1.policy.quotas.actions['content.create'].roleMultipliers.clubadmin),
  clubOwner: z.int().min(1).default(DEFAULT_CONFIG_V1.policy.quotas.actions['content.create'].roleMultipliers.clubOwner),
}).strict();

const contentCreateQuotaSchema = z.object({
  dailyMax: z.int().min(1).default(DEFAULT_CONFIG_V1.policy.quotas.actions['content.create'].dailyMax),
  roleMultipliers: contentCreateRoleMultipliersSchema.default(DEFAULT_CONFIG_V1.policy.quotas.actions['content.create'].roleMultipliers),
  clubOverrides: z.record(clubSlugSchema, z.int().min(1)).default(DEFAULT_CONFIG_V1.policy.quotas.actions['content.create'].clubOverrides),
}).strict();

const requestQuotaSchema = (defaultDailyMax: number) => z.object({
  dailyMax: z.int().min(1).default(defaultDailyMax),
}).strict();

const quotaActionsSchema = z.object({
  'content.create': contentCreateQuotaSchema.default(DEFAULT_CONFIG_V1.policy.quotas.actions['content.create']),
  'messages.send': requestQuotaSchema(DEFAULT_CONFIG_V1.policy.quotas.actions['messages.send'].dailyMax)
    .default(DEFAULT_CONFIG_V1.policy.quotas.actions['messages.send']),
  'embedding.query': requestQuotaSchema(DEFAULT_CONFIG_V1.policy.quotas.actions['embedding.query'].dailyMax)
    .default(DEFAULT_CONFIG_V1.policy.quotas.actions['embedding.query']),
  'clubs.apply': requestQuotaSchema(DEFAULT_CONFIG_V1.policy.quotas.actions['clubs.apply'].dailyMax)
    .default(DEFAULT_CONFIG_V1.policy.quotas.actions['clubs.apply']),
  'clubs.create': requestQuotaSchema(DEFAULT_CONFIG_V1.policy.quotas.actions['clubs.create'].dailyMax)
    .default(DEFAULT_CONFIG_V1.policy.quotas.actions['clubs.create']),
  'llm.outputTokens': requestQuotaSchema(DEFAULT_CONFIG_V1.policy.quotas.actions['llm.outputTokens'].dailyMax)
    .default(DEFAULT_CONFIG_V1.policy.quotas.actions['llm.outputTokens']),
}).strict();

const policySchema = z.object({
  applications: z.object({
    maxInFlightPerMember: z.int().min(1).default(DEFAULT_CONFIG_V1.policy.applications.maxInFlightPerMember),
  }).strict().default(DEFAULT_CONFIG_V1.policy.applications),
  applicationBlocks: z.object({
    postDeclineDays: z.int().min(0).max(365).default(DEFAULT_CONFIG_V1.policy.applicationBlocks.postDeclineDays),
  }).strict().default(DEFAULT_CONFIG_V1.policy.applicationBlocks),
  invitations: z.object({
    openPerSponsorPerClub: z.int().min(1).default(DEFAULT_CONFIG_V1.policy.invitations.openPerSponsorPerClub),
  }).strict().default(DEFAULT_CONFIG_V1.policy.invitations),
  accessTokens: z.object({
    maxActivePerMember: z.int().min(1).default(DEFAULT_CONFIG_V1.policy.accessTokens.maxActivePerMember),
  }).strict().default(DEFAULT_CONFIG_V1.policy.accessTokens),
  clubs: z.object({
    maxClubsPerMember: z.int().min(0).default(DEFAULT_CONFIG_V1.policy.clubs.maxClubsPerMember),
    freeClubMemberCap: z.int().min(1).default(DEFAULT_CONFIG_V1.policy.clubs.freeClubMemberCap),
    removedClubRetentionDays: z.int().min(1).default(DEFAULT_CONFIG_V1.policy.clubs.removedClubRetentionDays),
  }).strict().default(DEFAULT_CONFIG_V1.policy.clubs),
  quotas: z.object({
    windowMultipliers: z.object({
      week: z.number().positive().default(DEFAULT_CONFIG_V1.policy.quotas.windowMultipliers.week),
      month: z.number().positive().default(DEFAULT_CONFIG_V1.policy.quotas.windowMultipliers.month),
    }).strict().default(DEFAULT_CONFIG_V1.policy.quotas.windowMultipliers),
    actions: quotaActionsSchema.default(DEFAULT_CONFIG_V1.policy.quotas.actions),
    llm: z.object({
      gateMaxOutputTokens: z.int().min(1).default(DEFAULT_CONFIG_V1.policy.quotas.llm.gateMaxOutputTokens),
      clubSpendBudget: z.object({
        dailyMaxCents: z.int().min(1).default(DEFAULT_CONFIG_V1.policy.quotas.llm.clubSpendBudget.dailyMaxCents),
      }).strict().default(DEFAULT_CONFIG_V1.policy.quotas.llm.clubSpendBudget),
    }).strict().default(DEFAULT_CONFIG_V1.policy.quotas.llm),
  }).strict().default(DEFAULT_CONFIG_V1.policy.quotas),
  pow: z.object({
    registrationDifficulty: z.int().min(1).default(DEFAULT_CONFIG_V1.policy.pow.registrationDifficulty),
    invitedRegistrationDifficulty: z.int().min(1).default(DEFAULT_CONFIG_V1.policy.pow.invitedRegistrationDifficulty),
    challengeTtlMs: z.int().min(1).default(DEFAULT_CONFIG_V1.policy.pow.challengeTtlMs),
  }).strict().refine(
    (pow) => pow.invitedRegistrationDifficulty <= pow.registrationDifficulty,
    {
      message: 'invitedRegistrationDifficulty must be <= registrationDifficulty',
      path: ['invitedRegistrationDifficulty'],
    },
  ).default(DEFAULT_CONFIG_V1.policy.pow),
  transport: z.object({
    maxStreamsPerMember: z.int().min(1).default(DEFAULT_CONFIG_V1.policy.transport.maxStreamsPerMember),
  }).strict().default(DEFAULT_CONFIG_V1.policy.transport),
  features: z.record(z.string(), z.unknown()).default(DEFAULT_CONFIG_V1.policy.features),
}).strict();

const runtimeSchema = z.object({
  workers: z.object({}).strict().default(DEFAULT_CONFIG_V1.runtime.workers),
}).strict();

export const configSchema = z.object({
  $schema: z.string().optional(),
  configVersion: z.literal(1),
  policy: policySchema.default(DEFAULT_CONFIG_V1.policy),
  runtime: runtimeSchema.default(DEFAULT_CONFIG_V1.runtime),
}).strict();

export type ResolvedConfig = z.infer<typeof configSchema>;
