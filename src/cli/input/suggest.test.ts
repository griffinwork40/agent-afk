/**
 * Tests for `src/cli/input/suggest.ts`.
 *
 * All tests use fake injected providers and contexts — NO network, NO real
 * `resolveProvider` calls, NO env mutation side-effects across cases.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSuggestEngine, pickModel, stripGhostControlChars } from './suggest.js';
import type { SuggestContext } from './suggest.js';
import type { ModelProvider } from '../../agent/provider.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCtx(overrides: Partial<SuggestContext> = {}): SuggestContext {
  return {
    model: 'claude-sonnet-4-5',
    apiKey: undefined,
    baseUrl: undefined,
    cwd: '/home/user/my-project',
    getHistory: () => [],
    getDropdownTopCandidate: () => null,
    getTranscriptTail: () => '',
    getRecentCommands: () => [],
    llmEnabled: () => false,
    ...overrides,
  };
}

// ── Tier 1: deterministic ghost ───────────────────────────────────────────────

describe('getDeterministicGhost', () => {
  it('returns history candidate when buffer is a strict prefix', () => {
    const engine = createSuggestEngine();
    const ctx = makeCtx({
      getHistory: () => ['/compact --summarize', '/compact', '/chat hello'],
    });
    const ghost = engine.getDeterministicGhost('/compact -', ctx);
    expect(ghost).toBe('/compact --summarize');
  });

  it('returns the dropdown top candidate when it is a strict prefix', () => {
    const engine = createSuggestEngine();
    const ctx = makeCtx({
      getDropdownTopCandidate: (buf) => (buf === '/com' ? '/compact' : null),
    });
    const ghost = engine.getDeterministicGhost('/com', ctx);
    expect(ghost).toBe('/compact');
  });

  it('prefers dropdown candidate over history when both match', () => {
    const engine = createSuggestEngine();
    const ctx = makeCtx({
      getHistory: () => ['/compact history'],
      getDropdownTopCandidate: (buf) => (buf.startsWith('/com') ? '/compact-dropdown' : null),
    });
    const ghost = engine.getDeterministicGhost('/com', ctx);
    expect(ghost).toBe('/compact-dropdown');
  });

  it('returns null when buffer is not a prefix of any candidate', () => {
    const engine = createSuggestEngine();
    const ctx = makeCtx({
      getHistory: () => ['/compact', '/chat'],
      getDropdownTopCandidate: () => null,
    });
    const ghost = engine.getDeterministicGhost('/debug', ctx);
    expect(ghost).toBeNull();
  });

  it('returns null when buffer equals a history entry exactly (no continuation)', () => {
    const engine = createSuggestEngine();
    const ctx = makeCtx({
      getHistory: () => ['/compact'],
    });
    const ghost = engine.getDeterministicGhost('/compact', ctx);
    expect(ghost).toBeNull();
  });

  it('returns null for empty buffer', () => {
    const engine = createSuggestEngine();
    const ctx = makeCtx({ getHistory: () => ['/compact'] });
    const ghost = engine.getDeterministicGhost('', ctx);
    expect(ghost).toBeNull();
  });

  it('returns null when dropdown candidate equals buffer exactly', () => {
    const engine = createSuggestEngine();
    const ctx = makeCtx({
      getDropdownTopCandidate: (buf) => buf, // returns same string
    });
    const ghost = engine.getDeterministicGhost('/compact', ctx);
    expect(ghost).toBeNull();
  });
});

// ── Tier 2: LLM gate ──────────────────────────────────────────────────────────

describe('getGhost – Tier 2 disabled', () => {
  it('returns null without calling completeFn when llmEnabled is false', async () => {
    const completeFn = vi.fn().mockResolvedValue('hello world');
    const engine = createSuggestEngine({ completeFn, debounceMs: 0 });
    const ctx = makeCtx({ llmEnabled: () => false });
    const result = await engine.getGhost('hel', ctx);
    expect(result).toBeNull();
    expect(completeFn).not.toHaveBeenCalled();
  });

  it('returns null without LLM call when buffer is shorter than MIN_LLM_CHARS', async () => {
    const completeFn = vi.fn().mockResolvedValue('hi there');
    const engine = createSuggestEngine({ completeFn, debounceMs: 0 });
    const ctx = makeCtx({ llmEnabled: () => true });
    // "hi" is 2 chars, MIN_LLM_CHARS is 3
    const result = await engine.getGhost('hi', ctx);
    expect(result).toBeNull();
    expect(completeFn).not.toHaveBeenCalled();
  });
});

describe('getGhost – Tier 2 enabled with injected provider', () => {
  it('returns provider text when enabled and reply is a valid continuation', async () => {
    const engine = createSuggestEngine({
      debounceMs: 0,
      completeFn: async () => 'hello world',
    });
    const ctx = makeCtx({ llmEnabled: () => true });
    const result = await engine.getGhost('hel', ctx);
    expect(result).toBe('hello world');
  });

  it('never throws when injected provider.complete rejects — resolves null', async () => {
    const engine = createSuggestEngine({
      debounceMs: 0,
      completeFn: async () => { throw new Error('network error'); },
    });
    const ctx = makeCtx({ llmEnabled: () => true });
    // Must not throw; must resolve null
    await expect(engine.getGhost('hel', ctx)).resolves.toBeNull();
  });

  it('resolves null on abort (timeout) path', async () => {
    // completeFn that never resolves; the engine's abort (timeoutMs=0) fires first
    const engine = createSuggestEngine({
      debounceMs: 0,
      timeoutMs: 0,
      completeFn: (_args) => new Promise<string>(() => { /* never resolves */ }),
    });
    const ctx = makeCtx({ llmEnabled: () => true });
    const result = await engine.getGhost('hel', ctx);
    expect(result).toBeNull();
  });

  it('caches result — second call does not invoke completeFn again', async () => {
    const completeFn = vi.fn().mockResolvedValue('hello world');
    const engine = createSuggestEngine({ completeFn, debounceMs: 0 });
    const ctx = makeCtx({ llmEnabled: () => true });

    const first = await engine.getGhost('hel', ctx);
    const second = await engine.getGhost('hel', ctx);
    expect(first).toBe('hello world');
    expect(second).toBe('hello world');
    expect(completeFn).toHaveBeenCalledTimes(1);
  });

  it('safety guard: returns null when LLM reply does not start with buffer', async () => {
    const engine = createSuggestEngine({
      debounceMs: 0,
      completeFn: async () => 'something completely different',
    });
    const ctx = makeCtx({ llmEnabled: () => true });
    const result = await engine.getGhost('hel', ctx);
    expect(result).toBeNull();
  });

  it('safety guard: returns null when LLM reply equals buffer exactly (no new content)', async () => {
    const engine = createSuggestEngine({
      debounceMs: 0,
      completeFn: async () => 'hel',  // same as buffer, no continuation
    });
    const ctx = makeCtx({ llmEnabled: () => true });
    const result = await engine.getGhost('hel', ctx);
    expect(result).toBeNull();
  });
});

// ── Tier 1 wins over Tier 2 ───────────────────────────────────────────────────

describe('getGhost – Tier 1 short-circuits Tier 2', () => {
  it('returns Tier 1 match and does not call completeFn', async () => {
    const completeFn = vi.fn().mockResolvedValue('history match extended');
    const engine = createSuggestEngine({ completeFn, debounceMs: 0 });
    const ctx = makeCtx({
      llmEnabled: () => true,
      getHistory: () => ['history match extended'],
    });
    const result = await engine.getGhost('history', ctx);
    expect(result).toBe('history match extended');
    expect(completeFn).not.toHaveBeenCalled();
  });
});

// ── supersede / dispose promise resolution ────────────────────────────────────

describe('getGhost – supersede resolves prior promise with null', () => {
  it('superseded getGhost promise resolves to null rather than hanging', async () => {
    // Large debounceMs so the timer never fires during the test.
    const completeFn = vi.fn().mockResolvedValue('hello world');
    const engine = createSuggestEngine({ completeFn, debounceMs: 10000 });
    const ctx = makeCtx({ llmEnabled: () => true });

    // P1 installs the debounce timer but never fires within test time.
    const p1 = engine.getGhost('abc', ctx);

    // Superseding call must synchronously resolve P1 with null.
    void engine.getGhost('abcd', ctx);

    // P1 must settle immediately (supersede is synchronous), not hang.
    await expect(p1).resolves.toBeNull();

    engine.dispose();
  });
});

describe('dispose', () => {
  it('can be called safely with no pending state', () => {
    const engine = createSuggestEngine();
    expect(() => engine.dispose()).not.toThrow();
  });

  it('dispose resolves a pending debounce promise to null rather than hanging', async () => {
    const completeFn = vi.fn().mockResolvedValue('hello world');
    const engine = createSuggestEngine({ completeFn, debounceMs: 10000 });
    const ctx = makeCtx({ llmEnabled: () => true });

    // P1 installs the debounce timer but never fires within test time.
    const p1 = engine.getGhost('abc', ctx);

    // dispose() must resolve P1 with null.
    engine.dispose();

    await expect(p1).resolves.toBeNull();
  });
});

// ── pickModel ─────────────────────────────────────────────────────────────────

describe('pickModel', () => {
  beforeEach(() => {
    delete process.env['AFK_SUGGEST_MODEL'];
    delete process.env['AFK_COMPACT_MODEL'];
  });
  afterEach(() => {
    delete process.env['AFK_SUGGEST_MODEL'];
    delete process.env['AFK_COMPACT_MODEL'];
  });

  it('returns AFK_SUGGEST_MODEL when set', () => {
    process.env['AFK_SUGGEST_MODEL'] = 'my-tiny-model';
    const ctx = makeCtx({ model: 'claude-sonnet-4-5' });
    expect(pickModel(ctx)).toBe('my-tiny-model');
  });

  it('returns AFK_COMPACT_MODEL for anthropic-routed session when set', () => {
    process.env['AFK_COMPACT_MODEL'] = 'claude-haiku-4-5';
    const ctx = makeCtx({ model: 'claude-sonnet-4-5' });
    expect(pickModel(ctx)).toBe('claude-haiku-4-5');
  });

  it('falls back to "haiku" for anthropic-routed session when AFK_COMPACT_MODEL unset', () => {
    const ctx = makeCtx({ model: 'claude-sonnet-4-5' });
    expect(pickModel(ctx)).toBe('haiku');
  });

  it('returns session model for non-anthropic provider', () => {
    const ctx = makeCtx({ model: 'gpt-4o' });
    expect(pickModel(ctx)).toBe('gpt-4o');
  });
});

// ── stripGhostControlChars (B1: terminal-escape sanitization) ─────────────────

describe('stripGhostControlChars', () => {
  it('passes through ordinary text unchanged', () => {
    expect(stripGhostControlChars('git commit -m hello')).toBe('git commit -m hello');
  });

  it('strips CSI escape sequences (cursor moves, SGR, erase)', () => {
    expect(stripGhostControlChars('echo \u001b[31mhi\u001b[0m')).toBe('echo hi');
    expect(stripGhostControlChars('a\u001b[2Jb')).toBe('ab');
    expect(stripGhostControlChars('a\u001b[1A\u001b[2Kb')).toBe('ab');
  });

  it('strips OSC sequences (title set, OSC 52 clipboard) — BEL and ST terminated', () => {
    expect(stripGhostControlChars('a\u001b]0;pwned\u0007b')).toBe('ab');
    expect(stripGhostControlChars('a\u001b]52;c;ZGF0YQ==\u001b\\b')).toBe('ab');
  });

  it('strips embedded newline, CR, tab, backspace (single-line invariant)', () => {
    expect(stripGhostControlChars('hel\nlo')).toBe('hello');
    expect(stripGhostControlChars('a\r\b\tb')).toBe('ab');
  });

  it('strips DEL and C1 control characters', () => {
    expect(stripGhostControlChars('a\u007f\u0085b')).toBe('ab');
  });
});

// ── Tier 2: B1 sanitization of untrusted model output ─────────────────────────

describe('getGhost – Tier 2 sanitizes untrusted model output (B1)', () => {
  it('strips terminal escape sequences from the LLM continuation', async () => {
    const engine = createSuggestEngine({
      debounceMs: 0,
      completeFn: async () => 'echo \u001b[31mhello\u001b[0m world',
    });
    const ctx = makeCtx({ llmEnabled: () => true });
    const result = await engine.getGhost('echo', ctx);
    expect(result).toBe('echo hello world');
    expect(result).not.toMatch(/\u001b/);
  });

  it('strips an embedded newline so the ghost stays single-line', async () => {
    const engine = createSuggestEngine({
      debounceMs: 0,
      completeFn: async () => 'git\n commit',
    });
    const ctx = makeCtx({ llmEnabled: () => true });
    const result = await engine.getGhost('git', ctx);
    expect(result).not.toBeNull();
    expect(result).not.toContain('\n');
  });
});

// ── Tier 2: H1 cache policy ───────────────────────────────────────────────────

describe('getGhost – Tier 2 cache policy (H1)', () => {
  it('does NOT cache an aborted/timed-out request — a later call retries', async () => {
    const completeFn = vi.fn()
      .mockImplementationOnce(() => new Promise<string>(() => { /* never resolves → times out */ }))
      .mockImplementationOnce(async () => 'hello world');
    const engine = createSuggestEngine({ completeFn, debounceMs: 0, timeoutMs: 5 });
    const ctx = makeCtx({ llmEnabled: () => true });

    const first = await engine.getGhost('hel', ctx);
    expect(first).toBeNull();

    // The poisoned-prefix bug would return the cached null here without ever
    // calling completeFn again. The fix retries because aborts are not cached.
    const second = await engine.getGhost('hel', ctx);
    expect(second).toBe('hello world');
    expect(completeFn).toHaveBeenCalledTimes(2);
  });

  it('caches a genuine null (model returned a non-continuation) — no retry', async () => {
    const completeFn = vi.fn().mockResolvedValue('something else entirely');
    const engine = createSuggestEngine({ completeFn, debounceMs: 0 });
    const ctx = makeCtx({ llmEnabled: () => true });

    const first = await engine.getGhost('hel', ctx);
    const second = await engine.getGhost('hel', ctx);
    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(completeFn).toHaveBeenCalledTimes(1);
  });
});

// ── Tier 2: H1 observability ──────────────────────────────────────────────────

describe('getGhost – Tier 2 observability (H1)', () => {
  it('invokes onError when the completion throws, and still resolves null', async () => {
    const onError = vi.fn();
    const engine = createSuggestEngine({
      debounceMs: 0,
      onError,
      completeFn: async () => { throw new Error('401 unauthorized'); },
    });
    const ctx = makeCtx({ llmEnabled: () => true });

    const result = await engine.getGhost('hel', ctx);
    expect(result).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it('does NOT invoke onError on the expected abort/timeout path', async () => {
    const onError = vi.fn();
    const engine = createSuggestEngine({
      debounceMs: 0,
      timeoutMs: 5,
      onError,
      completeFn: () => new Promise<string>(() => { /* never resolves */ }),
    });
    const ctx = makeCtx({ llmEnabled: () => true });

    const result = await engine.getGhost('hel', ctx);
    expect(result).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });
});

// ── Tier 2: provider lifecycle (memoization + disposal) ────────────────────────

describe('getGhost – Tier 2 provider lifecycle', () => {
  it('memoizes the resolved provider across keystrokes and closes it on dispose', async () => {
    const close = vi.fn();
    const complete = vi.fn(async () => 'hello world');
    const resolveProviderFn = vi.fn(
      () => ({ name: 'fake', complete, close }) as unknown as ModelProvider,
    );
    const engine = createSuggestEngine({ resolveProviderFn, debounceMs: 0 });
    const ctx = makeCtx({ llmEnabled: () => true });

    // Three distinct buffers => three cache-miss Tier-2 fires.
    await engine.getGhost('hel', ctx);
    await engine.getGhost('help', ctx);
    await engine.getGhost('helps', ctx);

    // Provider built exactly once despite three resolutions (no per-keystroke
    // construction => no leaked SQLite handles), and not closed until dispose.
    expect(resolveProviderFn).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(3);
    expect(close).not.toHaveBeenCalled();

    engine.dispose();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('does not construct a provider when Tier 2 is disabled', async () => {
    const resolveProviderFn = vi.fn(
      () => ({ name: 'fake', complete: vi.fn(), close: vi.fn() }) as unknown as ModelProvider,
    );
    const engine = createSuggestEngine({ resolveProviderFn, debounceMs: 0 });
    const ctx = makeCtx({ llmEnabled: () => false });

    const result = await engine.getGhost('hello', ctx);

    expect(result).toBeNull();
    expect(resolveProviderFn).not.toHaveBeenCalled();
    engine.dispose();
  });
});
