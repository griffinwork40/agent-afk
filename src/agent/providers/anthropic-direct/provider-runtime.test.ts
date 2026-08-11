import { describe, expect, it } from 'vitest';

import { CLAUDE_SONNET_ID } from '../../session/model-slots.js';
import { starterModels } from './query-options.js';
import { DEFAULT_MODEL } from './provider-runtime.js';

// Invariant: the default Sonnet wire id has three consumers that must agree, and
// only one of them is the source of truth (CLAUDE_SONNET_ID in
// session/model-slots.ts, which the `sonnet`/`sonnet_1m` aliases and the `medium`
// tier already follow). Before these pins existed the other two were hand-synced
// literals guarded by a comment, so bumping the default silently left the
// no-model fallback and the model picker's recommended entry on the old model.
// These tests fail on that specific drift — not on a deliberate model bump, which
// moves CLAUDE_SONNET_ID and carries both consumers with it.
describe('default Sonnet id has a single source of truth', () => {
  it('provider DEFAULT_MODEL delegates to CLAUDE_SONNET_ID', () => {
    expect(DEFAULT_MODEL).toBe(CLAUDE_SONNET_ID);
  });

  it('starterModels() recommends the default Sonnet first', () => {
    // Order is semantic here: the first entry is what model-picker surfaces as
    // the recommended default, so it must be the same model a no-model query
    // falls back to. Only `value` is pinned — the display copy is free to churn.
    const first = starterModels()[0];
    expect(first?.value).toBe(CLAUDE_SONNET_ID);
  });

  it('lists each starter model exactly once', () => {
    const values = starterModels().map((m) => m.value);
    expect(new Set(values).size).toBe(values.length);
  });
});
