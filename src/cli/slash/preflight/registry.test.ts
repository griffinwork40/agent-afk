/**
 * Tests for the preflight registry.
 */

import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import {
  registerPreflight,
  getPreflight,
  runPreflight,
  _clearPreflightsForTests,
  _sealBuiltinKeys,
} from './registry.js';
import { initBuiltinPreflights, _resetBuiltinsInitializedForTests } from './index.js';
import type { PreflightContext, SkillInvocation } from './types.js';

const baseInv: SkillInvocation = {
  skillName: 'review',
  rawArgs: '277',
  source: 'plugin',
  capabilities: { compose: true, subagents: true },
};

const baseCtx: PreflightContext = {
  cwd: '/tmp',
  artifactDir: '/tmp/artifacts',
};

describe('preflight registry', () => {
  beforeEach(() => {
    _clearPreflightsForTests();
  });

  it('getPreflight returns undefined when none registered', () => {
    expect(getPreflight('review')).toBeUndefined();
  });

  it('register + getPreflight roundtrips', () => {
    const fn = vi.fn().mockResolvedValue(null);
    registerPreflight('review', fn);
    expect(getPreflight('review')).toBe(fn);
  });

  it('register replaces a prior registration for the same name (before sealing)', () => {
    const fn1 = vi.fn().mockResolvedValue(null);
    const fn2 = vi.fn().mockResolvedValue(null);
    registerPreflight('review', fn1);
    registerPreflight('review', fn2);
    expect(getPreflight('review')).toBe(fn2);
  });

  // F03 — immutability after sealing
  it('F03 — sealed key cannot be overwritten without force', () => {
    const fn1 = vi.fn().mockResolvedValue(null);
    const fn2 = vi.fn().mockResolvedValue(null);
    registerPreflight('review-pr', fn1);
    _sealBuiltinKeys();
    // Attempt to overwrite — must silently reject.
    registerPreflight('review-pr', fn2);
    // fn1 must still be registered (not fn2).
    expect(getPreflight('review-pr')).toBe(fn1);
  });

  it('F03 — sealed key CAN be overwritten with force: true (test escape hatch)', () => {
    const fn1 = vi.fn().mockResolvedValue(null);
    const fn2 = vi.fn().mockResolvedValue(null);
    registerPreflight('review-pr', fn1);
    _sealBuiltinKeys();
    registerPreflight('review-pr', fn2, { force: true });
    expect(getPreflight('review-pr')).toBe(fn2);
  });

  it('F03 — unsealed key can still be freely overwritten', () => {
    const fn1 = vi.fn().mockResolvedValue(null);
    const fn2 = vi.fn().mockResolvedValue(null);
    // Register fn1, then seal. Register a DIFFERENT name (fn2) after sealing.
    registerPreflight('sealed-key', fn1);
    _sealBuiltinKeys();
    // A different (not sealed) key can still be registered.
    registerPreflight('new-key', fn2);
    expect(getPreflight('new-key')).toBe(fn2);
  });

  it('F03 — _clearPreflightsForTests also clears the sealed-key set', () => {
    const fn1 = vi.fn().mockResolvedValue(null);
    const fn2 = vi.fn().mockResolvedValue(null);
    registerPreflight('review-pr', fn1);
    _sealBuiltinKeys();
    // clearPreflightsForTests resets everything
    _clearPreflightsForTests();
    registerPreflight('review-pr', fn2);
    // After clear, the key is no longer sealed and fn2 succeeds.
    expect(getPreflight('review-pr')).toBe(fn2);
  });

  it('runPreflight returns null when no preflight is registered', async () => {
    const result = await runPreflight(baseInv, baseCtx);
    expect(result).toBeNull();
  });

  it('runPreflight forwards inv + ctx to the registered preflight', async () => {
    const fn = vi.fn().mockResolvedValue({ manifestBlock: 'ok', artifacts: {} });
    registerPreflight('review', fn);
    await runPreflight(baseInv, baseCtx);
    expect(fn).toHaveBeenCalledWith(baseInv, baseCtx);
  });

  it('runPreflight returns the preflight result on success', async () => {
    registerPreflight('review', async () => ({
      manifestBlock: '<manifest>hello</manifest>',
      artifacts: { diff: '/tmp/pr-277.diff' },
    }));
    const result = await runPreflight(baseInv, baseCtx);
    expect(result).toEqual({
      manifestBlock: '<manifest>hello</manifest>',
      artifacts: { diff: '/tmp/pr-277.diff' },
    });
  });

  it('runPreflight returns null when the preflight returns null (not applicable)', async () => {
    registerPreflight('review', async () => null);
    const result = await runPreflight(baseInv, baseCtx);
    expect(result).toBeNull();
  });

  it('runPreflight isolates thrown errors and reports via onError, returning null', async () => {
    const onError = vi.fn();
    registerPreflight('review', async () => {
      throw new Error('boom');
    });

    const result = await runPreflight(baseInv, baseCtx, onError);

    expect(result).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
    const err = onError.mock.calls[0]?.[0];
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('boom');
  });

  it('runPreflight tolerates a thrown error with no onError handler', async () => {
    registerPreflight('review', async () => {
      throw new Error('boom');
    });
    await expect(runPreflight(baseInv, baseCtx)).resolves.toBeNull();
  });

  it('lookup uses the bare skill name only (no slash, no plugin prefix)', async () => {
    const fn = vi.fn().mockResolvedValue({ manifestBlock: 'x', artifacts: {} });
    registerPreflight('review', fn);

    // A plugin-sourced invocation still has the bare skill name on .skillName —
    // namespace stripping is the dispatcher's job, not the registry's.
    const inv: SkillInvocation = { ...baseInv, source: 'plugin' };
    const result = await runPreflight(inv, baseCtx);
    expect(result).not.toBeNull();
  });
});

// initBuiltinPreflights registers the PR-context preflight under the bare
// skill name `'review'` — the lookup key the slash dispatcher computes from
// `/review 277`, `/example-plugin:review 277`, and the native handler alike
// (`parsed.name.replace(/^\//, '').split(':').pop() → 'review'`). The prior
// `'review-pr'` registration was a no-op in production: no slash command
// ever produced that bare name. See preflight/index.ts.
//
// A02: the barrel no longer registers as a side effect; initBuiltinPreflights()
// is called explicitly. Tests must call it (and clear first) to observe the
// registration in isolation.
describe('initBuiltinPreflights registers as review', () => {
  it('getPreflight("review") returns the registered entry after initBuiltinPreflights()', () => {
    _clearPreflightsForTests();
    _resetBuiltinsInitializedForTests(); // M2: reset idempotency guard alongside registry clear
    initBuiltinPreflights();
    const preflight = getPreflight('review');
    expect(preflight).toBeDefined();
    expect(typeof preflight).toBe('function');
  });

  it('getPreflight("review-pr") returns undefined — phantom key from prior C02 misregistration', () => {
    _clearPreflightsForTests();
    _resetBuiltinsInitializedForTests(); // M2: reset idempotency guard alongside registry clear
    initBuiltinPreflights();
    // 'review-pr' was the prior key, but no slash command ever resolved to that
    // bare name — keep it unregistered so a future plugin can claim the slot.
    const preflight = getPreflight('review-pr');
    expect(preflight).toBeUndefined();
  });
});

// T06 — Verify that importing the preflight barrel (without _clearPreflightsForTests)
// and calling initBuiltinPreflights() once is sufficient to make getPreflight work.
// This tests the A02 explicit-init contract: barrel import alone does nothing;
// initBuiltinPreflights() is the activation point.
describe('T06 — initBuiltinPreflights() activates the registry (no clear needed)', () => {
  it('getPreflight("review") is defined after initBuiltinPreflights() even without a prior clear', () => {
    // Reset the idempotency guard (M2) so this call actually runs, even if a
    // prior test already called initBuiltinPreflights(). We intentionally do NOT
    // call _clearPreflightsForTests() — the point of this test is that
    // initBuiltinPreflights() works on an already-seeded or fresh registry.
    _resetBuiltinsInitializedForTests();
    initBuiltinPreflights();
    expect(getPreflight('review')).toBeDefined();
  });
});

// T03 — parseSlash namespace cases.
// Verifies the parse function in slash/registry.ts correctly handles plugin-namespaced
// slash commands, since repl-loop.ts uses parse() to extract the bare name for preflight lookup.
describe('T03 — parseSlash namespace cases', () => {
  // Import the parse function from the slash registry
  // (done at top-level to avoid ESM import-in-describe issues).
  let parseSlash: (input: string) => { name: string; args: string } | null;

  beforeAll(async () => {
    const mod = await import('../registry.js');
    parseSlash = mod.parse;
  });

  it('parses /plugin:review 277 → { name: "/plugin:review", args: "277" }', () => {
    const result = parseSlash('/plugin:review 277');
    expect(result).toEqual({ name: '/plugin:review', args: '277' });
  });

  it('parses /review 277 (no namespace) → { name: "/review", args: "277" }', () => {
    const result = parseSlash('/review 277');
    expect(result).toEqual({ name: '/review', args: '277' });
  });

  it('parses /example-plugin:mint some idea → { name: "/example-plugin:mint", args: "some idea" }', () => {
    const result = parseSlash('/example-plugin:mint some idea');
    expect(result).toEqual({ name: '/example-plugin:mint', args: 'some idea' });
  });

  it('parses /review-pr 100 → { name: "/review-pr", args: "100" }', () => {
    const result = parseSlash('/review-pr 100');
    expect(result).toEqual({ name: '/review-pr', args: '100' });
  });

  it('returns null for plain text (not a slash command)', () => {
    expect(parseSlash('hello world')).toBeNull();
  });

  it('returns args="" for a command with no args', () => {
    expect(parseSlash('/review')).toEqual({ name: '/review', args: '' });
  });

  // Verify the bare-name extraction that repl-loop.ts uses:
  // parsed.name.replace(/^\//, '').split(':').pop()
  it('extracting bare name from /plugin:review-pr gives "review-pr"', () => {
    const result = parseSlash('/plugin:review-pr 277');
    expect(result).not.toBeNull();
    const bare = result!.name.replace(/^\//, '').split(':').pop();
    expect(bare).toBe('review-pr');
  });

  it('extracting bare name from /review-pr gives "review-pr"', () => {
    const result = parseSlash('/review-pr 277');
    expect(result).not.toBeNull();
    const bare = result!.name.replace(/^\//, '').split(':').pop();
    expect(bare).toBe('review-pr');
  });
});

// T04 — SkillInvocation passed to runPreflight on the plugin-forward path
// must have source === 'plugin'. This mirrors the construction in repl-loop.ts.
describe('T04 — plugin-forward path passes source: "plugin" to runPreflight', () => {
  beforeEach(() => {
    _clearPreflightsForTests();
  });

  it('T04 — runPreflight receives inv.source = "plugin" in the forward path', async () => {
    const captured: import('./types.js').SkillInvocation[] = [];
    const fn = vi.fn().mockImplementation(async (inv: import('./types.js').SkillInvocation) => {
      captured.push(inv);
      return null;
    });
    registerPreflight('review-pr', fn);

    const pluginInv: import('./types.js').SkillInvocation = {
      skillName: 'review-pr',
      rawArgs: '277',
      source: 'plugin',
      capabilities: { compose: true, subagents: true },
    };

    await runPreflight(pluginInv, baseCtx);

    expect(captured.length).toBe(1);
    expect(captured[0]).toBeDefined();
    expect(captured[0]!.source).toBe('plugin');
  });
});

// T05 — Collision resolution: same bare name registered in native and plugin-forward paths.
// runPreflight must be called exactly once per slash invocation regardless of source.
describe('T05 — collision: same bare name in both paths → runPreflight called once', () => {
  beforeEach(() => {
    _clearPreflightsForTests();
  });

  it('T05 — registering the same name twice results in one active entry; runPreflight called once', async () => {
    const fn1 = vi.fn().mockResolvedValue({ manifestBlock: 'native', artifacts: {} });
    const fn2 = vi.fn().mockResolvedValue({ manifestBlock: 'plugin', artifacts: {} });

    // Native registration (simulates builtin-skills path).
    registerPreflight('review-pr', fn1);
    // Plugin registration for same name — should be silently rejected after sealing.
    _sealBuiltinKeys();
    registerPreflight('review-pr', fn2);

    // Only fn1 should be active.
    expect(getPreflight('review-pr')).toBe(fn1);

    const inv: import('./types.js').SkillInvocation = {
      skillName: 'review-pr',
      rawArgs: '100',
      source: 'plugin',
      capabilities: { compose: true, subagents: true },
    };
    await runPreflight(inv, baseCtx);

    // fn1 called exactly once; fn2 never called.
    expect(fn1).toHaveBeenCalledTimes(1);
    expect(fn2).not.toHaveBeenCalled();
  });
});
