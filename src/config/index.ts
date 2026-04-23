import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseJsonc, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { ZodError } from 'zod';
import { logger } from '../logger.ts';
import { QUOTA_ACTIONS, getQuotaActionMeta } from '../quota-metadata.ts';
import { ConfigError, zodIssuesToConfigDetails } from './errors.ts';
import {
  DEFAULT_CONFIG_V1,
  QUOTA_WINDOW_SEMANTICS,
  cloneConfig,
  freezeConfig,
  getDefaultConfig,
  type AppConfig,
} from './defaults.ts';
import { configSchema, type ResolvedConfig } from './schema.ts';

type ConfigState = {
  config: AppConfig;
  fingerprint: string;
  source: 'file' | 'defaults' | 'test';
  path: string | null;
};

let configState: ConfigState | null = null;
let warnedMissingDefaultConfig = false;

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortKeysDeep(record[key]);
    }
    return sorted;
  }
  return value;
}

function normalizeConfig(config: ResolvedConfig): AppConfig {
  return freezeConfig(cloneConfig(config)) as AppConfig;
}

function parseErrorDetail(error: ParseError): string {
  return `offset ${error.offset}: ${printParseErrorCode(error.error)}`;
}

function validateConfig(pathLabel: string, raw: unknown): AppConfig {
  try {
    return normalizeConfig(configSchema.parse(raw));
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ConfigError(pathLabel, 'Invalid clawclub config', zodIssuesToConfigDetails(error));
    }
    throw error;
  }
}

function resolveConfigPath(explicitPath?: string | null): { path: string; isExplicit: boolean } {
  const envPath = process.env.CLAWCLUB_CONFIG_PATH?.trim();
  if (explicitPath && explicitPath.trim().length > 0) {
    return { path: path.resolve(explicitPath), isExplicit: true };
  }
  if (envPath && envPath.length > 0) {
    return { path: path.resolve(envPath), isExplicit: true };
  }
  return { path: path.resolve(process.cwd(), 'clawclub.config.jsonc'), isExplicit: false };
}

function loadConfigFromResolvedPath(resolvedPath: string, isExplicit: boolean): AppConfig {
  if (!existsSync(resolvedPath)) {
    if (isExplicit) {
      throw new ConfigError(resolvedPath, 'Missing clawclub config');
    }
    if (!warnedMissingDefaultConfig) {
      warnedMissingDefaultConfig = true;
      logger.warn('config_missing_default_file', {
        path: resolvedPath,
        message: `no clawclub.config.jsonc found at ${resolvedPath}; using built-in defaults`,
      });
    }
    return freezeConfig(getDefaultConfig());
  }

  const rawText = readFileSync(resolvedPath, 'utf8');
  const parseErrors: ParseError[] = [];
  const parsed = parseJsonc(rawText, parseErrors, { allowEmptyContent: false, allowTrailingComma: true, disallowComments: false });
  if (parseErrors.length > 0) {
    throw new ConfigError(resolvedPath, 'Invalid clawclub config JSONC', parseErrors.map(parseErrorDetail));
  }

  return validateConfig(resolvedPath, parsed);
}

function loadConfigStateFromResolvedPath(resolvedPath: string, isExplicit: boolean): ConfigState {
  if (!existsSync(resolvedPath)) {
    if (isExplicit) {
      throw new ConfigError(resolvedPath, 'Missing clawclub config');
    }
    if (!warnedMissingDefaultConfig) {
      warnedMissingDefaultConfig = true;
      logger.warn('config_missing_default_file', {
        path: resolvedPath,
        message: `no clawclub.config.jsonc found at ${resolvedPath}; using built-in defaults`,
      });
    }
    const config = freezeConfig(getDefaultConfig());
    return {
      config,
      fingerprint: getConfigFingerprint(config),
      source: 'defaults',
      path: resolvedPath,
    };
  }

  const config = loadConfigFromResolvedPath(resolvedPath, isExplicit);
  return {
    config,
    fingerprint: getConfigFingerprint(config),
    source: 'file',
    path: resolvedPath,
  };
}

export function hasInitializedConfig(): boolean {
  return configState !== null;
}

export function loadConfigFromFile(explicitPath?: string | null): AppConfig {
  const resolved = resolveConfigPath(explicitPath);
  return loadConfigFromResolvedPath(resolved.path, resolved.isExplicit);
}

export function getConfigFingerprint(config: AppConfig = getConfig()): string {
  return createHash('sha256').update(JSON.stringify(sortKeysDeep(config))).digest('hex').slice(0, 16);
}

export function initializeConfigFromFile(explicitPath?: string | null): AppConfig {
  if (configState) {
    return configState.config;
  }

  const resolved = resolveConfigPath(explicitPath);
  configState = loadConfigStateFromResolvedPath(resolved.path, resolved.isExplicit);
  return configState.config;
}

export function initializeConfigForTests(config: AppConfig): AppConfig {
  const validated = validateConfig('[test-config]', config);
  configState = {
    config: validated,
    fingerprint: getConfigFingerprint(validated),
    source: 'test',
    path: null,
  };
  return validated;
}

export function resetConfigForTests(): void {
  configState = null;
  warnedMissingDefaultConfig = false;
}

export function getConfig(): AppConfig {
  if (!configState) {
    initializeConfigFromFile();
  }
  return configState!.config;
}

export function deriveQuotaWindowMaxes(dailyMax: number, config: AppConfig = getConfig()): Record<'day' | 'week' | 'month', number> {
  const multipliers = config.policy.quotas.windowMultipliers;
  return {
    day: dailyMax,
    week: Math.ceil(dailyMax * multipliers.week),
    month: Math.ceil(dailyMax * multipliers.month),
  };
}

function getResolvedQuotaMaxFields(dailyMax: number, config: AppConfig): Record<'dailyMax' | 'weeklyMax' | 'monthlyMax', number> {
  const maxes = deriveQuotaWindowMaxes(dailyMax, config);
  return {
    dailyMax: maxes.day,
    weeklyMax: maxes.week,
    monthlyMax: maxes.month,
  };
}

function getResolvedQuotaMaxCentsFields(dailyMaxCents: number, config: AppConfig): Record<'dailyMaxCents' | 'weeklyMaxCents' | 'monthlyMaxCents', number> {
  const maxes = deriveQuotaWindowMaxes(dailyMaxCents, config);
  return {
    dailyMaxCents: maxes.day,
    weeklyMaxCents: maxes.week,
    monthlyMaxCents: maxes.month,
  };
}

function buildPublicQuotaActionPolicy(action: keyof AppConfig['policy']['quotas']['actions'], config: AppConfig): Record<string, unknown> {
  const policy = config.policy.quotas.actions[action];
  const meta = getQuotaActionMeta(action);
  if (action === QUOTA_ACTIONS.contentCreate) {
    return {
      ...getResolvedQuotaMaxFields(policy.dailyMax, config),
      scope: meta.scope,
      metric: meta.metric,
      roleMultipliers: cloneConfig(config.policy.quotas.actions[QUOTA_ACTIONS.contentCreate].roleMultipliers),
      clubOverrides: cloneConfig(config.policy.quotas.actions[QUOTA_ACTIONS.contentCreate].clubOverrides),
    };
  }

  return {
    ...getResolvedQuotaMaxFields(policy.dailyMax, config),
    scope: meta.scope,
    metric: meta.metric,
  };
}

export function getPublicInstancePolicy(config: AppConfig = getConfig()): Record<string, unknown> {
  const clubSpendBudget = getResolvedQuotaMaxCentsFields(config.policy.quotas.llm.clubSpendBudget.dailyMaxCents, config);
  return {
    applications: cloneConfig(config.policy.applications),
    invitations: cloneConfig(config.policy.invitations),
    accessTokens: cloneConfig(config.policy.accessTokens),
    clubs: cloneConfig(config.policy.clubs),
    quotas: {
      windowMultipliers: cloneConfig(config.policy.quotas.windowMultipliers),
      windowSemantics: cloneConfig(QUOTA_WINDOW_SEMANTICS),
      actions: {
        'content.create': buildPublicQuotaActionPolicy(QUOTA_ACTIONS.contentCreate, config),
        'messages.send': buildPublicQuotaActionPolicy(QUOTA_ACTIONS.messagesSend, config),
        'embedding.query': buildPublicQuotaActionPolicy(QUOTA_ACTIONS.embeddingQuery, config),
        'clubs.apply': buildPublicQuotaActionPolicy(QUOTA_ACTIONS.clubsApply, config),
        'clubs.create': buildPublicQuotaActionPolicy(QUOTA_ACTIONS.clubsCreate, config),
        'llm.outputTokens': buildPublicQuotaActionPolicy(QUOTA_ACTIONS.llmOutputTokens, config),
      },
      llm: {
        gateMaxOutputTokens: config.policy.quotas.llm.gateMaxOutputTokens,
        clubSpendBudget,
      },
    },
    pow: cloneConfig(config.policy.pow),
    transport: cloneConfig(config.policy.transport),
    features: cloneConfig(config.policy.features),
  };
}

export function getInstancePolicyFingerprint(config: AppConfig = getConfig()): string {
  return createHash('sha256')
    .update(JSON.stringify(sortKeysDeep(getPublicInstancePolicy(config))))
    .digest('hex')
    .slice(0, 16);
}

export { DEFAULT_CONFIG_V1 };
export type { AppConfig };
