/**
 * Single entry point for all integration tests.
 * Run with: node --experimental-strip-types --test test/integration/run.ts
 *
 * Creates ONE clawclub_test database and ONE server, then runs all test suites.
 */

import { before, after } from 'node:test';
import { TestHarness } from './harness.ts';

// Share a single harness instance across all imported test suites
let harness: TestHarness;

// @ts-ignore – exported for test files via setup.ts
globalThis.__clawclub_test_harness = null;

before(async () => {
  harness = await TestHarness.start();
  // @ts-ignore
  globalThis.__clawclub_test_harness = harness;
}, { timeout: 60_000 });

after(async () => {
  await harness?.stop();
}, { timeout: 15_000 });

// Import all test suites — they will use getHarness() from setup.ts
// which reads from globalThis.__clawclub_test_harness
import './smoke.test.ts';
import './content.test.ts';
import './memberships.test.ts';
import './messages.test.ts';
import './profiles.test.ts';
import './admin.test.ts';
import './admissions.test.ts';
