/**
 * Shared test harness instance.
 * All integration test files import this module to get the same harness.
 * The harness is started once on first import and stopped via process exit.
 */

import { TestHarness } from './harness.ts';

let instance: TestHarness | null = null;
let startPromise: Promise<TestHarness> | null = null;

export async function getHarness(): Promise<TestHarness> {
  if (instance) return instance;

  if (!startPromise) {
    startPromise = TestHarness.start().then((h) => {
      instance = h;

      // Clean up on process exit
      process.on('beforeExit', async () => {
        if (instance) {
          await instance.stop();
          instance = null;
        }
      });

      return h;
    });
  }

  return startPromise;
}
