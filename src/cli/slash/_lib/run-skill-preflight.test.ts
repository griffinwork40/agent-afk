/**
 * Tests for invokeSkillPreflight — the shared skill-preflight invocation
 * helper extracted in #3268.
 *
 * Coverage:
 *   - Returns manifest block string when preflight resolves one
 *   - Returns undefined when no preflight is registered for the skill
 *   - Returns undefined when the registered preflight returns null
 *   - Failure isolation: preflight throws → returns undefined (does not rethrow)
 *   - Emits ctx.out.warn when AFK_SKILL_STREAM_VERBOSE=1 and preflight throws
 *   - Does NOT emit warn when AFK_SKILL_STREAM_VERBOSE is unset
 *   - Builds SkillInvocation with the caller-supplied skillName / rawArgs / source
 *   - Uses ctx.stats.cwd as the cwd (not process.cwd())
 *   - Falls back to process.cwd() when ctx.stats.cwd is undefined
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SlashContext, SessionStats } from '../types.js';
import type { SkillInvocation, PreflightResult } from '../preflight/index.js';
import { invokeSkillPreflight } from './run-skill-preflight.js';

// ---------------------------------------------------------------------------
// Module mocks — must be hoisted before any import of the module under test.
// ---------------------------------------------------------------------------

vi.mock('../preflight/index.js', () => ({
  runPreflight: vi.fn(),
  getSkillPreflightDir: vi.fn(() => '/fake/artifact-dir'),
}));

vi.mock('../../../config/env.js', () => ({
  env: { AFK_SKILL_STREAM_VERBOSE: undefined as string | undefined },
}));

import { runPreflight, getSkillPreflightDir } from '../preflight/index.js';
import { env } from '../../../config/env.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStats(cwd?: string): SessionStats {
  return {
    totalTurns: 0,
    totalCostUsd: 0,
    totalTokens: 0,
    totalDurationMs: 0,
    sessionStartTime: Date.now(),
    turnCosts: [],
    turnTokens: [],
    turns: [],
    model: 'sonnet',
    permissionMode: 'default',
    ...(cwd !== undefined ? { cwd } : {}),
  };
}

function makeCtx(opts: { cwd?: string; sessionId?: string } = {}): {
  ctx: SlashContext;
  warns: string[];
} {
  const warns: string[] = [];
  const ctx: SlashContext = {
    session: {
      current: { sessionId: opts.sessionId } as unknown as SlashContext['session']['current'],
    } as unknown as SlashContext['session'],
    stats: makeStats(opts.cwd),
    out: {
      line: vi.fn(),
      raw: vi.fn(),
      success: vi.fn(),
      info: vi.fn(),
      warn: (t: string) => warns.push(t),
      error: vi.fn(),
    },
    ui: { clearScreen: vi.fn(), repaintStatusLine: vi.fn() },
  };
  return { ctx, warns };
}

function makeResult(manifest: string): PreflightResult {
  return { manifestBlock: manifest, artifacts: {} };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.mocked(runPreflight).mockReset();
  vi.mocked(getSkillPreflightDir).mockReturnValue('/fake/artifact-dir');
  // Reset env mock to no verbose by default.
  (env as { AFK_SKILL_STREAM_VERBOSE: string | undefined }).AFK_SKILL_STREAM_VERBOSE = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('invokeSkillPreflight — manifest return', () => {
  it('returns manifestBlock when the preflight resolves one', async () => {
    vi.mocked(runPreflight).mockResolvedValue(makeResult('<manifest>data</manifest>'));
    const { ctx } = makeCtx({ cwd: '/repo' });

    const result = await invokeSkillPreflight('review', '277', 'builtin', ctx);

    expect(result).toBe('<manifest>data</manifest>');
  });

  it('returns undefined when no preflight is registered (runPreflight returns null)', async () => {
    vi.mocked(runPreflight).mockResolvedValue(null);
    const { ctx } = makeCtx();

    const result = await invokeSkillPreflight('mint', 'idea', 'user', ctx);

    expect(result).toBeUndefined();
  });

  it('returns undefined when preflight returns null (signals not-applicable)', async () => {
    vi.mocked(runPreflight).mockResolvedValue(null);
    const { ctx } = makeCtx();

    const result = await invokeSkillPreflight('forge', '', 'project', ctx);

    expect(result).toBeUndefined();
  });
});

describe('invokeSkillPreflight — failure isolation', () => {
  it('returns undefined and does NOT rethrow when runPreflight rejects', async () => {
    // runPreflight itself wraps in try/catch and calls onError, returning null.
    // Simulate the onError path by having runPreflight call the error callback
    // and return null.
    vi.mocked(runPreflight).mockImplementation(
      async (_inv, _ctx, onError) => {
        onError?.(new Error('network failure'));
        return null;
      },
    );
    const { ctx } = makeCtx();

    await expect(invokeSkillPreflight('review', '', 'plugin', ctx)).resolves.toBeUndefined();
  });

  it('emits ctx.out.warn when AFK_SKILL_STREAM_VERBOSE=1 and preflight errors', async () => {
    (env as { AFK_SKILL_STREAM_VERBOSE: string | undefined }).AFK_SKILL_STREAM_VERBOSE = '1';
    vi.mocked(runPreflight).mockImplementation(
      async (_inv, _ctx, onError) => {
        onError?.(new Error('boom'));
        return null;
      },
    );
    const { ctx, warns } = makeCtx();

    await invokeSkillPreflight('review', '', 'builtin', ctx);

    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('preflight(review) failed');
    expect(warns[0]).toContain('boom');
  });

  it('does NOT emit warn when AFK_SKILL_STREAM_VERBOSE is not set', async () => {
    (env as { AFK_SKILL_STREAM_VERBOSE: string | undefined }).AFK_SKILL_STREAM_VERBOSE = undefined;
    vi.mocked(runPreflight).mockImplementation(
      async (_inv, _ctx, onError) => {
        onError?.(new Error('quiet error'));
        return null;
      },
    );
    const { ctx, warns } = makeCtx();

    await invokeSkillPreflight('review', '', 'builtin', ctx);

    expect(warns).toHaveLength(0);
  });
});

describe('invokeSkillPreflight — SkillInvocation shape', () => {
  it('passes skillName, rawArgs, and source through to runPreflight', async () => {
    vi.mocked(runPreflight).mockResolvedValue(null);
    const { ctx } = makeCtx();

    await invokeSkillPreflight('myskill', 'my-args', 'imported', ctx);

    expect(runPreflight).toHaveBeenCalledTimes(1);
    const inv = vi.mocked(runPreflight).mock.calls[0]?.[0] as SkillInvocation;
    expect(inv.skillName).toBe('myskill');
    expect(inv.rawArgs).toBe('my-args');
    expect(inv.source).toBe('imported');
    expect(inv.capabilities).toEqual({ compose: true, subagents: true });
  });

  it('always sets capabilities to { compose: true, subagents: true }', async () => {
    vi.mocked(runPreflight).mockResolvedValue(null);
    const { ctx } = makeCtx();

    await invokeSkillPreflight('review', '', 'plugin', ctx);

    const inv = vi.mocked(runPreflight).mock.calls[0]?.[0] as SkillInvocation;
    expect(inv.capabilities).toEqual({ compose: true, subagents: true });
  });
});

describe('invokeSkillPreflight — cwd resolution', () => {
  it('passes ctx.stats.cwd as the preflight cwd when set', async () => {
    vi.mocked(runPreflight).mockResolvedValue(null);
    const { ctx } = makeCtx({ cwd: '/my/worktree' });

    await invokeSkillPreflight('review', '', 'builtin', ctx);

    const preflightCtx = vi.mocked(runPreflight).mock.calls[0]?.[1];
    expect(preflightCtx?.cwd).toBe('/my/worktree');
  });

  it('falls back to process.cwd() when ctx.stats.cwd is undefined', async () => {
    vi.mocked(runPreflight).mockResolvedValue(null);
    const { ctx } = makeCtx({ cwd: undefined });

    await invokeSkillPreflight('review', '', 'builtin', ctx);

    const preflightCtx = vi.mocked(runPreflight).mock.calls[0]?.[1];
    expect(preflightCtx?.cwd).toBe(process.cwd());
  });

  it('passes the artifactDir from getSkillPreflightDir', async () => {
    vi.mocked(getSkillPreflightDir).mockReturnValue('/custom/artifact-dir');
    vi.mocked(runPreflight).mockResolvedValue(null);
    const { ctx } = makeCtx({ sessionId: 'abc-123' });

    await invokeSkillPreflight('review', '', 'builtin', ctx);

    expect(getSkillPreflightDir).toHaveBeenCalledWith('abc-123');
    const preflightCtx = vi.mocked(runPreflight).mock.calls[0]?.[1];
    expect(preflightCtx?.artifactDir).toBe('/custom/artifact-dir');
  });
});
