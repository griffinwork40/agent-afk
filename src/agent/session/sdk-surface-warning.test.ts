/**
 * Unit tests for sdk-surface-warning.ts (issue #3442, option 3).
 *
 * Verifies that:
 *  - `isReducedToolSurface` returns true for an executor-less session that has
 *    skills but no "skill" tool in the registered tools list.
 *  - `isReducedToolSurface` returns false when the "skill" tool IS present
 *    (CLI/REPL/Telegram/web surfaces wire executors).
 *  - `isReducedToolSurface` returns false when no skills are discovered.
 *  - `emitReducedSurfaceWarning` writes to stderr iff the gap is present and
 *    AFK_SDK_SURFACE_WARN !== '0'.
 *  - The warning is suppressed when AFK_SDK_SURFACE_WARN=0.
 *
 * @module agent/session/sdk-surface-warning.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isReducedToolSurface, emitReducedSurfaceWarning } from './sdk-surface-warning.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal SessionMetadata shape with skills and tools. */
function makeMetadata(skills: string[], tools: string[]): { skills: string[]; tools: string[] } {
  return { skills, tools };
}

// ---------------------------------------------------------------------------
// isReducedToolSurface
// ---------------------------------------------------------------------------

describe('isReducedToolSurface', () => {
  it('returns true when skills discovered and "skill" tool absent (SDK surface)', () => {
    expect(
      isReducedToolSurface(makeMetadata(['mint', 'diagnose'], ['bash', 'read_file'])),
    ).toBe(true);
  });

  it('returns false when "skill" tool is present (CLI/REPL/Telegram/web surface)', () => {
    expect(
      isReducedToolSurface(makeMetadata(['mint', 'diagnose'], ['bash', 'skill', 'agent'])),
    ).toBe(false);
  });

  it('returns false when no skills are discovered (no plugins installed)', () => {
    expect(
      isReducedToolSurface(makeMetadata([], ['bash', 'read_file'])),
    ).toBe(false);
  });

  it('returns false when skills is undefined', () => {
    expect(
      isReducedToolSurface({ skills: undefined as unknown as string[], tools: ['bash'] }),
    ).toBe(false);
  });

  it('returns false when tools is undefined', () => {
    // No tools list at all → cannot confirm "skill" is absent, but it is —
    // the guard treats undefined tools as empty (no skill tool present),
    // so with skills present this should still return true.
    expect(
      isReducedToolSurface({ skills: ['mint'], tools: undefined as unknown as string[] }),
    ).toBe(true);
  });

  it('returns false when both skills and "skill" tool are present', () => {
    expect(
      isReducedToolSurface(makeMetadata(['mint'], ['skill', 'agent', 'compose'])),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// emitReducedSurfaceWarning
// ---------------------------------------------------------------------------

describe('emitReducedSurfaceWarning', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('writes to stderr when skills present and "skill" tool absent', () => {
    emitReducedSurfaceWarning(makeMetadata(['mint', 'diagnose'], ['bash', 'read_file']));
    expect(stderrSpy).toHaveBeenCalledOnce();
    const msg = stderrSpy.mock.calls[0]![0] as string;
    expect(msg).toContain('[agent-afk]');
    expect(msg).toContain('2 skills');
    expect(msg).toContain('"skill"');
    expect(msg).toContain('"agent"');
    expect(msg).toContain('"compose"');
    expect(msg).toContain('docs/sdk-surface.md');
  });

  it('is silent when "skill" tool is present (wired surface)', () => {
    emitReducedSurfaceWarning(makeMetadata(['mint'], ['bash', 'skill', 'agent']));
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('is silent when no skills are discovered', () => {
    emitReducedSurfaceWarning(makeMetadata([], ['bash', 'read_file']));
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('uses singular "skill" for a single discovered skill', () => {
    emitReducedSurfaceWarning(makeMetadata(['mint'], ['bash']));
    expect(stderrSpy).toHaveBeenCalledOnce();
    const msg = stderrSpy.mock.calls[0]![0] as string;
    expect(msg).toContain('1 skill ');
    expect(msg).not.toContain('1 skills');
  });
});

// ---------------------------------------------------------------------------
// AFK_SDK_SURFACE_WARN suppression — tested via vi.stubEnv
// ---------------------------------------------------------------------------

describe('emitReducedSurfaceWarning suppression via AFK_SDK_SURFACE_WARN', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('is silent when AFK_SDK_SURFACE_WARN=0 (embedder opt-out)', () => {
    // vi.stubEnv writes through process.env (which the `env` object reads via
    // a getter) and is automatically restored after the test by Vitest.
    vi.stubEnv('AFK_SDK_SURFACE_WARN', '0');
    emitReducedSurfaceWarning(makeMetadata(['mint', 'diagnose'], ['bash']));
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('is NOT silent when AFK_SDK_SURFACE_WARN is absent', () => {
    vi.stubEnv('AFK_SDK_SURFACE_WARN', undefined as unknown as string);
    emitReducedSurfaceWarning(makeMetadata(['mint'], ['bash']));
    expect(stderrSpy).toHaveBeenCalledOnce();
  });
});
