/**
 * Singleton-bypass guarantee for `whatif-api.ts`.
 *
 * Core correctness property: importing `whatif-api.ts` must NOT trigger
 * module-level singleton instantiation (e.g. `openaiCompatibleProvider`)
 * that would break CLI test suites by eagerly reading environment variables
 * or making network connections.
 *
 * The barrel `providers/index.ts` constructs `openaiCompatibleProvider` at
 * module evaluation time. `whatif-api.ts` deliberately bypasses it by
 * importing only from the leaf modules. This test confirms that bypass holds.
 *
 * @module agent/providers/whatif-api.test
 */

import { describe, it, expect, vi } from 'vitest';

// Track whether the openai-compatible singleton factory was evaluated.
// vi.mock is hoisted to the top of the file by Vitest, so this runs before
// any import of whatif-api.ts.
let providerInstantiated = false;

vi.mock('./openai-compatible/index.js', () => {
  providerInstantiated = true;
  return {
    OpenAICompatibleProvider: class {},
    openaiCompatibleProvider: {},
  };
});

// Import AFTER the mock is established (hoisting guarantees ordering).
import * as whatifApi from './whatif-api.js';

describe('whatif-api singleton-bypass guarantee', () => {
  it('importing whatif-api does NOT instantiate openaiCompatibleProvider', () => {
    // The mock factory above sets providerInstantiated = true if the
    // openai-compatible module is evaluated as part of loading whatif-api.
    expect(providerInstantiated).toBe(false);
  });

  it('exports the expected stable public API surface', () => {
    expect(typeof whatifApi.oneShotCompletion).toBe('function');
    expect(typeof whatifApi.deriveCallCostUsd).toBe('function');
    expect(typeof whatifApi.resolveModelId).toBe('function');
  });
});
