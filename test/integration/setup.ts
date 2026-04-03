/**
 * Shared test harness accessor.
 *
 * When tests are run via run.ts (recommended), the harness is set on globalThis
 * before any test files import this module. When run individually, creates one.
 */

import { TestHarness } from './harness.ts';

let fallback: TestHarness | null = null;
let fallbackPromise: Promise<TestHarness> | null = null;

export async function getHarness(): Promise<TestHarness> {
  // @ts-ignore
  const global = globalThis.__clawclub_test_harness as TestHarness | null;
  if (global) return global;

  // Fallback: create a harness for standalone file execution
  if (fallback) return fallback;
  if (!fallbackPromise) {
    fallbackPromise = TestHarness.start().then((h) => {
      fallback = h;
      return h;
    });
  }
  return fallbackPromise;
}
