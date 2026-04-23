export const QUOTA_METRICS = {
  requests: 'requests',
  outputTokens: 'output_tokens',
} as const;

export const QUOTA_SCOPES = {
  perClubMember: 'per_club_member',
  perMemberGlobal: 'per_member_global',
} as const;

export const QUOTA_ACTIONS = {
  contentCreate: 'content.create',
  messagesSend: 'messages.send',
  llmOutputTokens: 'llm.outputTokens',
  embeddingQuery: 'embedding.query',
  clubsApply: 'clubs.apply',
  clubsCreate: 'clubs.create',
} as const;

export type SupportedQuotaAction = typeof QUOTA_ACTIONS[keyof typeof QUOTA_ACTIONS];

export const QUOTA_ACTION_META = {
  [QUOTA_ACTIONS.contentCreate]: {
    metric: QUOTA_METRICS.requests,
    scope: QUOTA_SCOPES.perClubMember,
  },
  [QUOTA_ACTIONS.messagesSend]: {
    metric: QUOTA_METRICS.requests,
    scope: QUOTA_SCOPES.perMemberGlobal,
  },
  [QUOTA_ACTIONS.embeddingQuery]: {
    metric: QUOTA_METRICS.requests,
    scope: QUOTA_SCOPES.perMemberGlobal,
  },
  [QUOTA_ACTIONS.clubsApply]: {
    metric: QUOTA_METRICS.requests,
    scope: QUOTA_SCOPES.perMemberGlobal,
  },
  [QUOTA_ACTIONS.clubsCreate]: {
    metric: QUOTA_METRICS.requests,
    scope: QUOTA_SCOPES.perMemberGlobal,
  },
  [QUOTA_ACTIONS.llmOutputTokens]: {
    metric: QUOTA_METRICS.outputTokens,
    scope: QUOTA_SCOPES.perClubMember,
  },
} as const satisfies Record<SupportedQuotaAction, {
  metric: (typeof QUOTA_METRICS)[keyof typeof QUOTA_METRICS];
  scope: (typeof QUOTA_SCOPES)[keyof typeof QUOTA_SCOPES];
}>;

export function getQuotaActionMeta(action: SupportedQuotaAction) {
  return QUOTA_ACTION_META[action];
}
