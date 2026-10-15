/**
 * Tests that the per-slot `contextWindow` override flows through the
 * openai-compatible overflow guard (`checkContextOverflow`) and compaction
 * limit (`autoCompactLimitFor`).
 *
 * The openai-compatible provider calls `checkContextOverflow(lastUsage,
 * currentModel, ...)` where `currentModel` is the CONCRETE resolved id (e.g.
 * `qwen-3.8-27b`). This test proves the slot override reaches that call
 * without the slot alias being involved at guard time — which is the real
 * provider path. `guardContextOverflow` fires when
 * `contextWindowTokensUsed(lastUsage) + max_output_tokens > contextLimitFor(model)`.
 *
 * @module agent/providers/openai-compatible/query/context-overflow-slot-override.test
 */

import { afterEach, describe, expect, it } from 'vitest';
import { checkContextOverflow } from './context-overflow.js';
import { autoCompactLimitFor, contextLimitFor } from '../../../model-limits.js';
import {
  DEFAULT_SLOT_BINDINGS,
  resetSlotBindings,
  setSlotBindings,
} from '../../../session/model-slots.js';

/** Concrete Cerebras model id (no built-in table entry → Anthropic default 200k without override). */
const CEREBRAS_ID = 'qwen-3.8-27b';
/** maxOutputTokens used in these tests — must be > 0 for guard to fire. */
const MAX_OUT = 8_000;

afterEach(() => { resetSlotBindings(); });

describe('openai-compatible overflow guard honours slot contextWindow override', () => {
  it('without override: usage=195k + max_out=8k=203k > 200k default → overflow', () => {
    resetSlotBindings();
    // contextWindowTokensUsed picks contextWindowTokens first; fall through to
    // computeUsedTokens (inputTokens + outputTokens) when absent.
    const err = checkContextOverflow(
      { contextWindowTokens: 195_000 },
      CEREBRAS_ID,
      MAX_OUT,
      CEREBRAS_ID,
    );
    // Window is 200k (Anthropic fallback); 195k + 8k = 203k → overflow fired.
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/context/i);
  });

  it('with 128k override: usage=100k + 8k=108k < 128k → no overflow', () => {
    setSlotBindings({
      local: { id: CEREBRAS_ID, contextWindow: 128_000 },
      small: DEFAULT_SLOT_BINDINGS.small,
      medium: DEFAULT_SLOT_BINDINGS.medium,
      large: DEFAULT_SLOT_BINDINGS.large,
    });
    const safe = checkContextOverflow(
      { contextWindowTokens: 100_000 },
      CEREBRAS_ID,
      MAX_OUT,
      CEREBRAS_ID,
    );
    expect(safe).toBeNull();
  });

  it('with 128k override: usage=122k + 8k=130k > 128k → overflow', () => {
    setSlotBindings({
      local: { id: CEREBRAS_ID, contextWindow: 128_000 },
      small: DEFAULT_SLOT_BINDINGS.small,
      medium: DEFAULT_SLOT_BINDINGS.medium,
      large: DEFAULT_SLOT_BINDINGS.large,
    });
    const overflow = checkContextOverflow(
      { contextWindowTokens: 122_000 },
      CEREBRAS_ID,
      MAX_OUT,
      CEREBRAS_ID,
    );
    expect(overflow).toBeInstanceOf(Error);
    expect(overflow?.message).toMatch(/128,000/);
  });

  it('contextLimitFor reflects the override on the concrete id (real provider path)', () => {
    setSlotBindings({
      local: { id: CEREBRAS_ID, contextWindow: 128_000 },
      small: DEFAULT_SLOT_BINDINGS.small,
      medium: DEFAULT_SLOT_BINDINGS.medium,
      large: DEFAULT_SLOT_BINDINGS.large,
    });
    expect(contextLimitFor(CEREBRAS_ID)).toBe(128_000);
  });

  it('autoCompactLimitFor reflects the override (compaction threshold)', () => {
    setSlotBindings({
      local: { id: CEREBRAS_ID, contextWindow: 128_000 },
      small: DEFAULT_SLOT_BINDINGS.small,
      medium: DEFAULT_SLOT_BINDINGS.medium,
      large: DEFAULT_SLOT_BINDINGS.large,
    });
    // No MODEL_AUTOCOMPACT_BUDGET entry for qwen-3.8-27b → returns full override window.
    expect(autoCompactLimitFor(CEREBRAS_ID)).toBe(128_000);
  });
});
