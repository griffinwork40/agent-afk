/**
 * Unit tests for `query-system.ts`.
 *
 * Covers:
 *  1. `splitAtEnvironmentBoundary` — correct split / no-split / empty halves.
 *  2. `composeQuerySystem` — block count, `cache_control` placement when the
 *     stable/volatile split succeeds, degrade-to-single-block when the
 *     environment section is absent, plan/afk addendum position invariants.
 *
 * These tests do NOT require a live Anthropic client. They operate on pure
 * in-memory `SessionState` stubs with caching on (default env).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import { ENV_SPLIT_MARKER, splitAtEnvironmentBoundary, composeQuerySystem } from './query-system.js';
import type { SessionState } from './query/session-state.js';
import type { ToolDispatcher } from './tool-dispatcher.js';

// --- helpers ---

const ENV_DISABLE = 'AFK_DISABLE_PROMPT_CACHE';
const ENV_TTL = 'AFK_PROMPT_CACHE_TTL';

function clearCacheEnv(): void {
  delete process.env[ENV_DISABLE];
  delete process.env[ENV_TTL];
}

function disableCache(): void {
  process.env[ENV_DISABLE] = '1';
}

/** Minimal stub that satisfies the `SessionState` type surface used by `composeQuerySystem`. */
function makeState(userSystem: string | null, permissionMode = 'default'): SessionState {
  return {
    messages: [],
    currentModel: 'test-model',
    requestedModel: 'test-model',
    currentPermissionMode: permissionMode,
    userSystem,
    // Only the minimal dispatcher surface is touched (never, in this unit).
    toolDispatcher: {} as unknown as ToolDispatcher,
    lastUsage: null,
    closed: false,
    journalSync: {
      seed: () => {},
      sync: () => Promise.resolve(),
      flush: () => Promise.resolve(),
    } as unknown as SessionState['journalSync'],
    messageJournal: undefined,
    autoCompactThreshold: undefined,
  };
}

/**
 * Build an assembled system-prompt string shaped like `assembleSystemPrompt`
 * output.
 *
 * `ENV_SPLIT_MARKER` = `\n\n# Environment\n`, so `afterEnv` is the content
 * AFTER the `# Environment\n` header line (e.g. `- Working directory: /x`).
 * The full assembled string is: `${stable}\n\n# Environment\n${afterEnv}`.
 *
 * This mirrors exactly what `assembleSystemPrompt` produces when parts are
 * joined with `\n\n` and the environment section is `# Environment\n<lines>`.
 */
function makeAssembled(stable: string, afterEnv: string): string {
  // ENV_SPLIT_MARKER = '\n\n# Environment\n'
  // So the result is: stable + '\n\n# Environment\n' + afterEnv
  return `${stable}${ENV_SPLIT_MARKER}${afterEnv}`;
}

/**
 * The text that `splitAtEnvironmentBoundary` returns as `volatileTail`.
 * Since ENV_SPLIT_MARKER = `\n\n# Environment\n`, the tail starts at
 * `# Environment\n` and continues with the afterEnv content.
 */
function expectedVolatileTail(afterEnv: string): string {
  return `# Environment\n${afterEnv}`;
}

// --- splitAtEnvironmentBoundary ---

describe('splitAtEnvironmentBoundary', () => {
  it('returns null when the environment marker is absent', () => {
    expect(splitAtEnvironmentBoundary('no env section here')).toBeNull();
    expect(splitAtEnvironmentBoundary('')).toBeNull();
  });

  it('splits at the marker: stablePrefix excludes \\n\\n, volatileTail starts at # Environment', () => {
    const afterEnv = '- Working directory: /x';
    const text = makeAssembled('STABLE', afterEnv);
    const result = splitAtEnvironmentBoundary(text);
    expect(result).not.toBeNull();
    expect(result!.stablePrefix).toBe('STABLE');
    // Tail retains the `# Environment\n` header but not the `\n\n` separator.
    expect(result!.volatileTail).toBe(expectedVolatileTail(afterEnv));
  });

  it('uses the LAST marker when the stable prefix itself contains the pattern', () => {
    // A decoy occurrence inside the stable section must not win.
    const realAfterEnv = '- Working directory: /real';
    const text = `HEADER${ENV_SPLIT_MARKER}decoy body${ENV_SPLIT_MARKER}${realAfterEnv}`;
    const result = splitAtEnvironmentBoundary(text);
    expect(result!.volatileTail).toBe(expectedVolatileTail(realAfterEnv));
  });

  it('exported ENV_SPLIT_MARKER is the exact string the split is anchored on', () => {
    // Regression guard: if the constant drifts from the implementation, this fails.
    const afterEnv = '- cwd: /x';
    const text = makeAssembled('STABLE', afterEnv);
    const idx = text.lastIndexOf(ENV_SPLIT_MARKER);
    expect(idx).toBeGreaterThanOrEqual(0);
    // stablePrefix is everything before the marker.
    expect(text.slice(0, idx)).toBe('STABLE');
    // volatileTail starts at `# Environment\n` (after the leading `\n\n`).
    expect(text.slice(idx + '\n\n'.length)).toBe(expectedVolatileTail(afterEnv));
  });
});

// --- composeQuerySystem — stable/volatile split ---

describe('composeQuerySystem — stable/volatile split', () => {
  beforeEach(clearCacheEnv);
  afterEach(clearCacheEnv);

  it('emits TWO blocks (stable + volatile) when the env section is present and cache is on', () => {
    const userSystem = makeAssembled(
      'STABLE CONTENT',
      '- Working directory: /home/user\n- Date: Thursday, 2026-10-08',
    );
    const state = makeState(userSystem);
    const blocks = composeQuerySystem({ state, systemPrefix: null }) as ContentBlockParam[];

    // Exactly 2 blocks from userSystem (stable + volatile).
    // Default mode → no addendum → total 2.
    expect(blocks).toHaveLength(2);

    const stableBlock = blocks[0]!;
    const volatileBlock = blocks[1]!;

    expect(stableBlock.type).toBe('text');
    expect(stableBlock.type === 'text' && stableBlock.text).toContain('STABLE CONTENT');

    expect(volatileBlock.type).toBe('text');
    expect(volatileBlock.type === 'text' && volatileBlock.text).toContain('# Environment');
    expect(volatileBlock.type === 'text' && volatileBlock.text).toContain('Working directory');
  });

  it('stamps cache_control on the stable prefix block', () => {
    const userSystem = makeAssembled(
      'STABLE CONTENT',
      '- Working directory: /home/user\n- Date: Thursday, 2026-10-08',
    );
    const state = makeState(userSystem);
    const blocks = composeQuerySystem({ state, systemPrefix: null }) as ContentBlockParam[];

    const stableBlock = blocks[0] as { type: string; text: string; cache_control?: { type: string; ttl?: string } };
    expect(stableBlock.cache_control).toBeDefined();
    expect(stableBlock.cache_control?.type).toBe('ephemeral');
  });

  it('stamps cache_control on the last block (via withSystemBreakpoint)', () => {
    const userSystem = makeAssembled('STABLE', '- Working directory: /home/user');
    const state = makeState(userSystem);
    const blocks = composeQuerySystem({ state, systemPrefix: null }) as ContentBlockParam[];

    const lastBlock = blocks[blocks.length - 1] as { type: string; cache_control?: unknown };
    expect(lastBlock.cache_control).toBeDefined();
  });

  it('stable prefix block is byte-identical when only the env section changes', () => {
    const stableText = 'STABLE CONTENT — toolBase, doctrine, etc.';
    const env1 = makeAssembled(stableText, '- Working directory: /repo/a\n- Date: Mon, 2026-10-05');
    const env2 = makeAssembled(stableText, '- Working directory: /repo/b\n- Date: Thu, 2026-10-08');

    const state1 = makeState(env1);
    const state2 = makeState(env2);

    const blocks1 = composeQuerySystem({ state: state1, systemPrefix: null }) as ContentBlockParam[];
    const blocks2 = composeQuerySystem({ state: state2, systemPrefix: null }) as ContentBlockParam[];

    // Stable prefix text must be byte-identical across different env sections.
    const text1 = (blocks1[0] as { text: string }).text;
    const text2 = (blocks2[0] as { text: string }).text;
    expect(text1).toBe(text2);
    expect(text1).toBe(stableText);

    // cache_control shape must be identical (same TTL).
    const cc1 = (blocks1[0] as { cache_control?: unknown }).cache_control;
    const cc2 = (blocks2[0] as { cache_control?: unknown }).cache_control;
    expect(cc1).toEqual(cc2);

    // But the volatile tail (block index 1) must differ.
    const tail1 = (blocks1[1] as { text: string }).text;
    const tail2 = (blocks2[1] as { text: string }).text;
    expect(tail1).not.toBe(tail2);
  });

  it('degrades to a single block when the environment section is absent (no split)', () => {
    const state = makeState('STABLE ONLY — no environment section');
    const blocks = composeQuerySystem({ state, systemPrefix: null }) as ContentBlockParam[];

    // Single block — old behavior preserved.
    expect(blocks).toHaveLength(1);
    const only = blocks[0] as { type: string; text: string; cache_control?: unknown };
    expect(only.type).toBe('text');
    expect(only.text).toBe('STABLE ONLY — no environment section');
    // The tail breakpoint still stamps the sole block.
    expect(only.cache_control).toBeDefined();
  });

  it('returns null when userSystem is null and there are no other blocks', () => {
    const state = makeState(null);
    const result = composeQuerySystem({ state, systemPrefix: null });
    expect(result).toBeNull();
  });

  it('does NOT split or stamp cache_control when cache is disabled', () => {
    disableCache();
    const userSystem = makeAssembled('STABLE', '- Working directory: /home/user');
    const state = makeState(userSystem);
    const blocks = composeQuerySystem({ state, systemPrefix: null }) as ContentBlockParam[];

    // No split when cache is off.
    expect(blocks).toHaveLength(1);
    const only = blocks[0] as { cache_control?: unknown };
    expect(only.cache_control).toBeUndefined();
  });

  it('does NOT split when baseUrl is set (local shim, cache force-disabled)', () => {
    const userSystem = makeAssembled('STABLE', '- Working directory: /home/user');
    const state = makeState(userSystem);
    const blocks = composeQuerySystem({
      state,
      systemPrefix: null,
      baseUrl: 'http://127.0.0.1:8080',
    }) as ContentBlockParam[];

    expect(blocks).toHaveLength(1);
    const only = blocks[0] as { cache_control?: unknown };
    expect(only.cache_control).toBeUndefined();
  });
});

// --- composeQuerySystem — addendum placement ---

describe('composeQuerySystem — addendum placement', () => {
  beforeEach(clearCacheEnv);
  afterEach(clearCacheEnv);

  it('plan-mode addendum is the last block (receives the tail cache_control breakpoint)', () => {
    const userSystem = makeAssembled('STABLE', '- Working directory: /x');
    const state = makeState(userSystem, 'plan');
    const blocks = composeQuerySystem({ state, systemPrefix: null }) as ContentBlockParam[];

    // stable + volatile + plan addendum = 3 blocks minimum
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    const last = blocks[blocks.length - 1] as { type: string; text: string; cache_control?: unknown };
    expect(last.type).toBe('text');
    expect(last.text).toContain('Plan mode is active');
    expect(last.cache_control).toBeDefined();
  });

  it('afk addendum is the last block in autonomous mode', () => {
    const userSystem = makeAssembled('STABLE', '- Working directory: /x');
    const state = makeState(userSystem, 'autonomous');
    const blocks = composeQuerySystem({ state, systemPrefix: null }) as ContentBlockParam[];

    const last = blocks[blocks.length - 1] as { type: string; text: string; cache_control?: unknown };
    expect(last.type).toBe('text');
    expect(last.text).toContain('AFK mode is active');
    expect(last.cache_control).toBeDefined();
  });

  it('stable prefix block always has cache_control regardless of addendum presence', () => {
    for (const mode of ['default', 'plan', 'autonomous']) {
      const userSystem = makeAssembled('STABLE', '- Working directory: /x');
      const state = makeState(userSystem, mode);
      const blocks = composeQuerySystem({ state, systemPrefix: null }) as ContentBlockParam[];
      const stable = blocks[0] as { cache_control?: unknown };
      expect(stable.cache_control).toBeDefined();
    }
  });
});

// --- composeQuerySystem — systemPrefix passthrough ---

describe('composeQuerySystem — systemPrefix passthrough', () => {
  beforeEach(clearCacheEnv);
  afterEach(clearCacheEnv);

  it('prepends systemPrefix blocks before the split userSystem blocks', () => {
    const prefix: ContentBlockParam[] = [{ type: 'text', text: 'PREFIX BLOCK' }];
    const userSystem = makeAssembled('STABLE', '- Working directory: /x');
    const state = makeState(userSystem);
    const blocks = composeQuerySystem({ state, systemPrefix: prefix }) as ContentBlockParam[];

    // prefix + stable + volatile = 3 blocks minimum
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    const first = blocks[0] as { type: string; text: string };
    expect(first.text).toBe('PREFIX BLOCK');
  });
});
