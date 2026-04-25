import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import '../../src/dispatch.ts';
import {
  DEFAULT_CONFIG_V1,
  getPublicInstancePolicy,
  initializeConfigForTests,
  loadConfigFromFile,
  resetConfigForTests,
} from '../../src/config/index.ts';
import { configSchema } from '../../src/config/schema.ts';
import { getSchemaPayload } from '../../src/schema-endpoint.ts';
import { QUOTA_ACTIONS, getQuotaActionMeta } from '../../src/quota-metadata.ts';

afterEach(() => {
  resetConfigForTests();
});

describe('config loader', () => {
  it('parses JSONC with comments and fills defaults', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'clawclub-config-'));
    try {
      const configPath = path.join(dir, 'clawclub.config.jsonc');
      writeFileSync(configPath, `{
        // minimal file
        "configVersion": 1,
        "policy": {
          "quotas": {
            "actions": {
              "content.create": {
                "dailyMax": 12
              }
            }
          }
        }
      }`);

      const loaded = loadConfigFromFile(configPath);
      assert.equal(loaded.policy.quotas.actions['content.create'].dailyMax, 12);
      assert.equal(loaded.policy.quotas.actions['messages.send'].dailyMax, DEFAULT_CONFIG_V1.policy.quotas.actions['messages.send'].dailyMax);
      assert.equal(loaded.policy.quotas.actions['clubs.create'].dailyMax, DEFAULT_CONFIG_V1.policy.quotas.actions['clubs.create'].dailyMax);
      assert.equal(loaded.policy.clubs.maxClubsPerMember, DEFAULT_CONFIG_V1.policy.clubs.maxClubsPerMember);
      assert.equal(loaded.policy.clubs.freeClubMemberCap, DEFAULT_CONFIG_V1.policy.clubs.freeClubMemberCap);
      assert.equal(loaded.policy.clubs.removedClubRetentionDays, DEFAULT_CONFIG_V1.policy.clubs.removedClubRetentionDays);
      assert.equal(loaded.policy.transport.maxStreamsPerMember, DEFAULT_CONFIG_V1.policy.transport.maxStreamsPerMember);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects unknown keys', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'clawclub-config-'));
    try {
      const configPath = path.join(dir, 'clawclub.config.jsonc');
      writeFileSync(configPath, `{
        "configVersion": 1,
        "policy": {
          "quotas": {
            "bogus": true
          }
        }
      }`);

      assert.throws(
        () => loadConfigFromFile(configPath),
        /Invalid clawclub config/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when an explicit config path is missing', () => {
    assert.throws(
      () => loadConfigFromFile('/definitely/missing/clawclub.config.jsonc'),
      /Missing clawclub config/,
    );
  });
});

describe('public instance policy', () => {
  it('publishes resolved quota maxima and scopes', () => {
    const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG_V1)) as typeof DEFAULT_CONFIG_V1;
    config.policy.quotas.actions['content.create'].dailyMax = 12;
    config.policy.quotas.actions['content.create'].clubOverrides = {
      alpha: 5,
    };
    initializeConfigForTests(config);

    const policy = getPublicInstancePolicy() as {
      quotas: {
        actions: Record<string, {
          dailyMax: number;
          weeklyMax: number;
          monthlyMax: number;
          scope: string;
          metric: string;
          clubOverrides?: Record<string, number>;
        }>;
        llm: {
          gateMaxOutputTokens: number;
          clubSpendBudget: {
            dailyMaxCents: number;
            weeklyMaxCents: number;
            monthlyMaxCents: number;
          };
        };
      };
      clubs: {
        maxClubsPerMember: number;
        freeClubMemberCap: number;
        removedClubRetentionDays: number;
      };
      transport: { maxStreamsPerMember: number };
    };

    assert.equal(policy.quotas.actions['content.create'].dailyMax, 12);
    assert.equal(policy.quotas.actions['content.create'].weeklyMax, 54);
    assert.equal(policy.quotas.actions['content.create'].monthlyMax, 216);
    assert.equal(policy.quotas.actions['content.create'].scope, getQuotaActionMeta(QUOTA_ACTIONS.contentCreate).scope);
    assert.equal(policy.quotas.actions['content.create'].metric, getQuotaActionMeta(QUOTA_ACTIONS.contentCreate).metric);
    assert.deepEqual(policy.quotas.actions['content.create'].clubOverrides, { alpha: 5 });
    assert.equal(policy.quotas.actions['messages.send'].scope, getQuotaActionMeta(QUOTA_ACTIONS.messagesSend).scope);
    assert.equal(policy.quotas.actions['embedding.query'].scope, getQuotaActionMeta(QUOTA_ACTIONS.embeddingQuery).scope);
    assert.equal(policy.quotas.actions['clubs.apply'].scope, getQuotaActionMeta(QUOTA_ACTIONS.clubsApply).scope);
    assert.equal(policy.quotas.actions['clubs.create'].scope, getQuotaActionMeta(QUOTA_ACTIONS.clubsCreate).scope);
    assert.equal(policy.quotas.actions['llm.outputTokens'].metric, getQuotaActionMeta(QUOTA_ACTIONS.llmOutputTokens).metric);
    assert.equal(policy.quotas.llm.gateMaxOutputTokens, DEFAULT_CONFIG_V1.policy.quotas.llm.gateMaxOutputTokens);
    assert.deepEqual(policy.quotas.llm.clubSpendBudget, {
      dailyMaxCents: 100,
      weeklyMaxCents: 450,
      monthlyMaxCents: 1800,
    });
    assert.deepEqual(policy.clubs, DEFAULT_CONFIG_V1.policy.clubs);
    assert.equal(policy.transport.maxStreamsPerMember, DEFAULT_CONFIG_V1.policy.transport.maxStreamsPerMember);
  });

  it('changes the published schema hash when policy changes', () => {
    initializeConfigForTests(DEFAULT_CONFIG_V1);
    const first = getSchemaPayload() as { schemaHash: string };

    const changed = JSON.parse(JSON.stringify(DEFAULT_CONFIG_V1)) as typeof DEFAULT_CONFIG_V1;
    changed.policy.transport.maxStreamsPerMember = 7;
    initializeConfigForTests(changed);
    const second = getSchemaPayload() as { schemaHash: string; instancePolicy: { transport: { maxStreamsPerMember: number } } };

    assert.notEqual(second.schemaHash, first.schemaHash);
    assert.equal(second.instancePolicy.transport.maxStreamsPerMember, 7);
  });

  it('publishes the registration challenge TTL dynamically in the schema', () => {
    const firstConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG_V1)) as typeof DEFAULT_CONFIG_V1;
    firstConfig.policy.pow.challengeTtlMs = 65_000;
    initializeConfigForTests(firstConfig);

    const first = getSchemaPayload() as {
      schemaHash: string;
      actions: Array<{
        action: string;
        notes?: string[];
        businessErrors?: Array<{ code: string; meaning: string }>;
        input: {
          oneOf?: Array<{
            properties?: {
              mode?: { description?: string };
            };
          }>;
        };
        output: {
          oneOf?: Array<{
            properties?: {
              phase?: { enum?: string[] };
              challenge?: {
                properties?: {
                  expiresAt?: { description?: string };
                };
              };
            };
          }>;
        };
      }>;
    };

    const firstRegister = first.actions.find((action) => action.action === 'accounts.register');
    assert.ok(firstRegister, 'accounts.register should exist in the schema');
    assert.ok(firstRegister?.notes?.some((note) => note.includes('65000 ms (1 minute 5 seconds)')), 'accounts.register notes should include the live PoW TTL');
    assert.ok(firstRegister?.notes?.some((note) => /no extra post-solve grace period/i.test(note)), 'accounts.register notes should explain the single submit window');
    const firstDiscover = firstRegister?.input.oneOf?.find((variant) => variant.properties?.mode?.description?.includes('First call'));
    assert.match(String(firstDiscover?.properties?.mode?.description), /65000 ms \(1 minute 5 seconds\)/);
    const firstProofRequired = firstRegister?.output.oneOf?.find((variant) => variant.properties?.phase?.enum?.includes('proof_required'));
    assert.match(String(firstProofRequired?.properties?.challenge?.properties?.expiresAt?.description), /65000 ms \(1 minute 5 seconds\)/);
    const firstExpired = firstRegister?.businessErrors?.find((error) => error.code === 'challenge_expired');
    assert.match(String(firstExpired?.meaning), /65000 ms \(1 minute 5 seconds\)/);

    const secondConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG_V1)) as typeof DEFAULT_CONFIG_V1;
    secondConfig.policy.pow.challengeTtlMs = 3_600_000;
    initializeConfigForTests(secondConfig);

    const second = getSchemaPayload() as typeof first;
    const secondRegister = second.actions.find((action) => action.action === 'accounts.register');
    assert.ok(secondRegister?.notes?.some((note) => note.includes('3600000 ms (1 hour)')), 'accounts.register notes should refresh when the TTL changes');
    assert.notEqual(second.schemaHash, first.schemaHash);
  });

  it('keeps the example config aligned with the default resolved config', () => {
    const examplePath = path.resolve(process.cwd(), 'clawclub.config.example.jsonc');
    const exampleText = readFileSync(examplePath, 'utf8');
    const parsed = parseJsonc(exampleText);
    const validated = configSchema.parse(parsed);

    delete (validated as { $schema?: string }).$schema;
    assert.deepEqual(validated, DEFAULT_CONFIG_V1);
  });

  it('rejects invited registration PoW difficulty above cold registration difficulty', () => {
    const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG_V1)) as typeof DEFAULT_CONFIG_V1;
    config.policy.pow.registrationDifficulty = 3;
    config.policy.pow.invitedRegistrationDifficulty = 4;

    assert.throws(
      () => configSchema.parse(config),
      /invitedRegistrationDifficulty must be <= registrationDifficulty/,
    );
  });
});
