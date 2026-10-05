/**
 * Tests for `applyReload` — specifically the AFK_FRAMEWORK_PROMPT_FILE
 * error-containment path introduced in issue #2388.
 *
 * `loadSystemPrompt()` throws on an unreadable or relative override path.
 * That throw propagates through `resolveBaseSystemPrompt()` into `applyReload()`.
 * The fix catches it here so a mid-session `/afk-md reload` does NOT crash the
 * REPL: the prompt is left unchanged, `frameworkPromptError` is set, and
 * `applied` is false with no bundled-prompt fallback.
 *
 * These tests isolate `applyReload` directly. Command-level (`/afk-md reload`)
 * rendering of `frameworkPromptError` is exercised in the sibling `afk-md.test.ts`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SlashContext } from '../../types.js';

// ── Mocks (must hoist before module imports) ─────────────────────────────────

// Controlled in each test: either throws or returns successfully.
let resolveBaseSystemPromptImpl: () => { prompt: string; source: string };

vi.mock('../../../shared-helpers.js', () => ({
  resolveBaseSystemPrompt: (...args: unknown[]) => resolveBaseSystemPromptImpl(...args as []),
}));

vi.mock('../../../config/afk-md-tier.js', () => ({
  resetAfkMdCache: (): void => {},
  loadAfkMd: (): null => null,
}));

vi.mock('../../../config.js', () => ({
  _resetConfigCache: (): void => {},
  loadConfig: (): { autoRouting: { interactive: boolean } } => ({
    autoRouting: { interactive: true },
  }),
}));

vi.mock('../../../../agent/routing-directive.js', () => ({
  assembleSystemPrompt: (base: string | undefined): string | undefined => base,
}));

vi.mock('../../../../agent/memory/index.js', () => ({
  estimateTokens: (): number => 0,
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { applyReload } from './reload.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCtx(setSystemPromptReturn = true): SlashContext {
  return {
    session: {
      current: {
        setSystemPrompt: vi.fn(() => setSystemPromptReturn),
      },
    },
    stats: { cwd: '/tmp/test-cwd' },
    out: { error: vi.fn(), warn: vi.fn(), success: vi.fn(), line: vi.fn() },
  } as unknown as SlashContext;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('applyReload — AFK_FRAMEWORK_PROMPT_FILE error containment (issue #2388)', () => {
  beforeEach(() => {
    // Default: resolves successfully (override per-test for error cases).
    resolveBaseSystemPromptImpl = () => ({
      prompt: 'FRAMEWORK-TEXT',
      source: 'framework',
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns frameworkPromptError when resolveBaseSystemPrompt throws', () => {
    resolveBaseSystemPromptImpl = () => {
      throw new Error('AFK_FRAMEWORK_PROMPT_FILE="/relative" must be an absolute path.');
    };
    const ctx = makeCtx();
    const outcome = applyReload(ctx, 0);

    expect(outcome.frameworkPromptError).toMatch(/AFK_FRAMEWORK_PROMPT_FILE/);
  });

  it('does NOT call setSystemPrompt when resolveBaseSystemPrompt throws', () => {
    resolveBaseSystemPromptImpl = () => {
      throw new Error('AFK_FRAMEWORK_PROMPT_FILE="/bad" is unreadable: no such file.');
    };
    const ctx = makeCtx();
    applyReload(ctx, 0);

    expect((ctx.session.current.setSystemPrompt as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('sets applied=false on prompt-load error (prompt is unchanged)', () => {
    resolveBaseSystemPromptImpl = () => {
      throw new Error('AFK_FRAMEWORK_PROMPT_FILE error');
    };
    const ctx = makeCtx();
    const outcome = applyReload(ctx, 0);

    expect(outcome.applied).toBe(false);
  });

  it('does not fall back to the bundled prompt — no setSystemPrompt call at all', () => {
    // The critical invariant: a bad path must NEVER silently run the bundled
    // prompt. If setSystemPrompt were called, a whatif A/B run would become A/A.
    resolveBaseSystemPromptImpl = () => {
      throw new Error('AFK_FRAMEWORK_PROMPT_FILE unreadable');
    };
    const ctx = makeCtx();
    applyReload(ctx, 0);

    const spy = ctx.session.current.setSystemPrompt as ReturnType<typeof vi.fn>;
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns a normal outcome when resolveBaseSystemPrompt succeeds', () => {
    // Baseline: no regression on the happy path.
    resolveBaseSystemPromptImpl = () => ({
      prompt: 'FULL-COMPOSED-PROMPT',
      source: 'framework',
    });
    const ctx = makeCtx(true);
    const outcome = applyReload(ctx, 0);

    expect(outcome.frameworkPromptError).toBeUndefined();
    expect(outcome.applied).toBe(true);
    const spy = ctx.session.current.setSystemPrompt as ReturnType<typeof vi.fn>;
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
