import test from 'node:test';
import assert from 'node:assert/strict';
import { assertStartupConfig } from '../../src/startup-check.ts';

test('assertStartupConfig is a no-op outside production', () => {
  assert.doesNotThrow(() => {
    assertStartupConfig({
      entrypoint: 'server',
      env: {
        NODE_ENV: 'development',
      },
    });
  });
});

test('assertStartupConfig throws in production when required env vars are missing', () => {
  assert.throws(
    () => {
      assertStartupConfig({
        entrypoint: 'server',
        required: ['OPENAI_API_KEY', 'CLAWCLUB_POW_HMAC_KEY'],
        env: {
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://example.test/db',
          OPENAI_API_KEY: '',
        },
      });
    },
    /OPENAI_API_KEY, CLAWCLUB_POW_HMAC_KEY/,
  );
});

test('assertStartupConfig requires DATABASE_URL by default', () => {
  assert.throws(
    () => {
      assertStartupConfig({
        entrypoint: 'worker:embedding',
        env: {
          NODE_ENV: 'production',
        },
      });
    },
    /DATABASE_URL/,
  );
});

test('assertStartupConfig can require a custom database env for non-OSS workers', () => {
  assert.throws(
    () => {
      assertStartupConfig({
        entrypoint: 'worker:producer',
        requiredDatabaseEnv: 'CLAWCLUB_PRODUCER_DATABASE_URL',
        env: {
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://example.test/oss',
        },
      });
    },
    /CLAWCLUB_PRODUCER_DATABASE_URL/,
  );

  assert.doesNotThrow(() => {
    assertStartupConfig({
      entrypoint: 'worker:producer',
      requiredDatabaseEnv: 'CLAWCLUB_PRODUCER_DATABASE_URL',
      env: {
        NODE_ENV: 'production',
        CLAWCLUB_PRODUCER_DATABASE_URL: 'postgresql://example.test/producer',
      },
    });
  });
});

test('assertStartupConfig accepts complete production config', () => {
  assert.doesNotThrow(() => {
    assertStartupConfig({
      entrypoint: 'worker:embedding',
      required: ['OPENAI_API_KEY'],
      env: {
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://example.test/db',
        OPENAI_API_KEY: 'sk-test',
      },
    });
  });
});

test('assertStartupConfig does not require PoW key for workers', () => {
  assert.doesNotThrow(() => {
    assertStartupConfig({
      entrypoint: 'worker:matches',
      env: {
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://example.test/db',
      },
    });
  });
});
