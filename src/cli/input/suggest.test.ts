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
import { register as registerSlashCommand, resetRegistry as resetSlashRegistry } from '../slash/registry.js';

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

  describe('source (c): mid-sentence skill name prefix-match', () => {
    beforeEach(() => { resetSlashRegistry(); });
    afterEach(() => { resetSlashRegistry(); });

    it('T1: ghost fires mid-sentence for a registered canonical command', () => {
      registerSlashCommand({ name: '/forge', summary: 'test', handler: async () => 'continue' });
      const engine = createSuggestEngine();
      const ctx = makeCtx({ getDropdownTopCandidate: () => null, getHistory: () => [] });
      expect(engine.getDeterministicGhost('can you run /fo', ctx)).toBe('can you run /forge');
    });

    it('T2: first-token /partial does NOT fire (no preceding whitespace)', () => {
      registerSlashCommand({ name: '/forge', summary: 'test', handler: async () => 'continue' });
      const engine = createSuggestEngine();
      const ctx = makeCtx({ getDropdownTopCandidate: () => null, getHistory: () => [] });
      // "/fo" at the start of the buffer — no preceding \s+ — must return null
      expect(engine.getDeterministicGhost('/fo', ctx)).toBeNull();
    });

    it('T3: returns null when no registered command matches the partial', () => {
      registerSlashCommand({ name: '/forge', summary: 'test', handler: async () => 'continue' });
      const engine = createSuggestEngine();
      const ctx = makeCtx({ getDropdownTopCandidate: () => null, getHistory: () => [] });
      expect(engine.getDeterministicGhost('please use /zzz', ctx)).toBeNull();
    });

    it('T4: multiple prefix matches → lexicographically first wins', () => {
      registerSlashCommand({ name: '/forge', summary: 'test', handler: async () => 'continue' });
      registerSlashCommand({ name: '/fork', summary: 'test', handler: async () => 'continue' });
      const engine = createSuggestEngine();
      const ctx = makeCtx({ getDropdownTopCandidate: () => null, getHistory: () => [] });
      // '/forge' < '/fork' lexicographically
      expect(engine.getDeterministicGhost('use /for', ctx)).toBe('use /forge');
    });

    it('T5: aliases are prefix-match candidates', () => {
      registerSlashCommand({ name: '/exit', summary: 'test', aliases: ['/quit'], handler: async () => 'continue' });
      const engine = createSuggestEngine();
      const ctx = makeCtx({ getDropdownTopCandidate: () => null, getHistory: () => [] });
      expect(engine.getDeterministicGhost('try /qu', ctx)).toBe('try /quit');
    });

    it('T6: source (c) fires after source (a) falls through (candidate does not prefix-match buffer)', () => {
      registerSlashCommand({ name: '/forge', summary: 'test', handler: async () => 'continue' });
      const engine = createSuggestEngine();
      // Dropdown returns '/forge' only for the exact buffer 'use /fo' — source (a)
      // checks dropdownCandidate.startsWith(buffer). '/forge' does NOT startsWith
      // 'use /fo', so source (a) misses and source (c) fires: returns 'use /forge'.
      const ctx = makeCtx({
        getDropdownTopCandidate: (buf) => buf === 'use /fo' ? '/forge' : null,
        getHistory: () => [],
      });
      const result = engine.getDeterministicGhost('use /fo', ctx);
      // Source (a) misses (candidate '/forge' doesn't startsWith 'use /fo').
      // Source (c) fires and returns 'use /forge'.
      expect(result).toBe('use /forge');
    });

    it('T7: partial with colons and underscores matches registered command', () => {
      registerSlashCommand({ name: '/my:skill', summary: 'test', handler: async () => 'continue' });
      const engine = createSuggestEngine();
      const ctx = makeCtx({ getDropdownTopCandidate: () => null, getHistory: () => [] });
      expect(engine.getDeterministicGhost('invoke /my:sk', ctx)).toBe('invoke /my:skill');
    });
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

// ── Tier 2: egress secret redaction ───────────────────────────────────────────

describe('getGhost – Tier 2 egress redaction', () => {
  it('scrubs secrets from the assembled prompt before it reaches completeFn', async () => {
    let capturedUser = '';
    const engine = createSuggestEngine({
      debounceMs: 0,
      completeFn: async (args) => {
        capturedUser = args.user;
        return 'hello world';
      },
    });
    // A recent command carrying an AWS access-key id (the canonical AWS example
    // key). ReplHistory's weak deny-list would NOT catch this, so the egress
    // boundary in buildUser() is the load-bearing scrub.
    const ctx = makeCtx({
      llmEnabled: () => true,
      getRecentCommands: () => ['export AWS_KEY=AKIAIOSFODNN7EXAMPLE'],
    });

    const result = await engine.getGhost('hel', ctx);

    // Normal (non-secret) completion still works end-to-end.
    expect(result).toBe('hello world');
    // The key must never appear in the outbound prompt; it is redacted.
    expect(capturedUser).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(capturedUser).toContain('[REDACTED]');
  });

  it('does not redact the raw buffer used by the continuation guard', async () => {
    // A plain buffer must still produce a ghost — proving redaction wraps the
    // prompt, not the `buffer` handed to isValidContinuation().
    const engine = createSuggestEngine({
      debounceMs: 0,
      completeFn: async () => 'hello world',
    });
    const ctx = makeCtx({ llmEnabled: () => true });
    const result = await engine.getGhost('hel', ctx);
    expect(result).toBe('hello world');
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

  it('strips U+2028/U+2029 line separators (outside the C0/C1 ranges)', () => {
    expect(stripGhostControlChars('fix the bug\u2028rm -rf /tmp/x')).toBe('fix the bugrm -rf /tmp/x');
    expect(stripGhostControlChars('a\u2029b')).toBe('ab');
  });

  it('strips bidi overrides and isolates (Trojan Source reordering)', () => {
    // Displayed order must equal accepted order: an override left in the ghost
    // could render "rm -rf /" as something innocuous while Tab accepts the real
    // bytes.
    expect(stripGhostControlChars('a\u202eb\u202cc')).toBe('abc');
    expect(stripGhostControlChars('a\u202a\u202b\u202db')).toBe('ab');
    expect(stripGhostControlChars('a\u2066b\u2069c\u2067\u2068d')).toBe('abcd');
  });

  it('leaves directional marks alone — they carry no override scope', () => {
    expect(stripGhostControlChars('a\u200e\u200fb')).toBe('a\u200e\u200fb');
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

// ── Empty-prompt suggestion ───────────────────────────────────────────────────

describe('primePromptSuggestion', () => {
  function enabledCtx(overrides: Partial<SuggestContext> = {}): SuggestContext {
    return makeCtx({
      llmEnabled: () => true,
      promptSuggestEnabled: () => true,
      getTranscriptTail: () => 'user: fix the parser\nassistant: fixed',
      ...overrides,
    });
  }

  it('is a no-op when promptSuggestEnabled is absent (legacy context)', async () => {
    const completeFn = vi.fn();
    const engine = createSuggestEngine({ completeFn });
    await engine.primePromptSuggestion(makeCtx({ llmEnabled: () => true }));
    expect(completeFn).not.toHaveBeenCalled();
    expect(engine.peekPromptSuggestion()).toBeNull();
  });

  it('is a no-op when promptSuggestEnabled is false', async () => {
    const completeFn = vi.fn();
    const engine = createSuggestEngine({ completeFn });
    await engine.primePromptSuggestion(
      enabledCtx({ promptSuggestEnabled: () => false }),
    );
    expect(completeFn).not.toHaveBeenCalled();
  });

  it('is a no-op when the LLM tier itself is disabled', async () => {
    const completeFn = vi.fn();
    const engine = createSuggestEngine({ completeFn });
    await engine.primePromptSuggestion(enabledCtx({ llmEnabled: () => false }));
    expect(completeFn).not.toHaveBeenCalled();
  });

  it('is a no-op at the startup prompt — no turn has completed yet', async () => {
    // Regression: the first readLine() of a session primes like any other turn
    // handoff, so without this gate the very first prompt showed a ghost
    // invented from the cwd name plus the PREVIOUS session's history ring.
    // No transcript => no provider call at all, not merely a discarded reply.
    const completeFn = vi.fn(async () => 'run the failing parser test');
    const engine = createSuggestEngine({ completeFn });
    await engine.primePromptSuggestion(
      enabledCtx({
        getTranscriptTail: () => '',
        getRecentCommands: () => ['/review', '/ship'],
      }),
    );
    expect(completeFn).not.toHaveBeenCalled();
    expect(engine.peekPromptSuggestion()).toBeNull();
    engine.dispose();
  });

  it('stores a valid suggestion for peek', async () => {
    const engine = createSuggestEngine({
      completeFn: async () => 'run the failing parser test',
    });
    await engine.primePromptSuggestion(enabledCtx());
    expect(engine.peekPromptSuggestion()).toBe('run the failing parser test');
  });

  it('normalizes a quoted, period-terminated reply', async () => {
    const engine = createSuggestEngine({ completeFn: async () => '"run the tests."' });
    await engine.primePromptSuggestion(enabledCtx());
    expect(engine.peekPromptSuggestion()).toBe('run the tests');
  });

  it('discards a refusal', async () => {
    const engine = createSuggestEngine({
      completeFn: async () => 'I cannot determine a next step',
    });
    await engine.primePromptSuggestion(enabledCtx());
    expect(engine.peekPromptSuggestion()).toBeNull();
  });

  it('discards a multi-line reply', async () => {
    const engine = createSuggestEngine({ completeFn: async () => 'do this\nthen that' });
    await engine.primePromptSuggestion(enabledCtx());
    expect(engine.peekPromptSuggestion()).toBeNull();
  });

  it('never throws and reports the error when the provider rejects', async () => {
    const error = new Error('provider exploded');
    const onError = vi.fn();
    const engine = createSuggestEngine({
      completeFn: async () => {
        throw error;
      },
      onError,
    });
    await expect(engine.primePromptSuggestion(enabledCtx())).resolves.toBeUndefined();
    expect(engine.peekPromptSuggestion()).toBeNull();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(error);
  });

  it('keeps the newer suggestion when an older completion resolves last', async () => {
    let resolveFirst: ((value: string) => void) | undefined;
    let resolveSecond: ((value: string) => void) | undefined;
    const completeFn = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<string>((resolve) => { resolveFirst = resolve; }),
      )
      .mockImplementationOnce(
        () => new Promise<string>((resolve) => { resolveSecond = resolve; }),
      );
    const engine = createSuggestEngine({ completeFn });

    const first = engine.primePromptSuggestion(enabledCtx());
    await vi.waitFor(() => expect(resolveFirst).toBeTypeOf('function'));
    const second = engine.primePromptSuggestion(enabledCtx());
    await vi.waitFor(() => expect(resolveSecond).toBeTypeOf('function'));

    resolveSecond?.('newer action');
    await second;
    expect(engine.peekPromptSuggestion()).toBe('newer action');

    resolveFirst?.('stale action');
    await first;
    expect(engine.peekPromptSuggestion()).toBe('newer action');
  });

  it('dispose aborts the current prompt-suggestion request', async () => {
    let signal: AbortSignal | undefined;
    const engine = createSuggestEngine({
      completeFn: (req) => {
        signal = req.signal;
        return new Promise<string>(() => {});
      },
    });

    const prime = engine.primePromptSuggestion(enabledCtx());
    await vi.waitFor(() => expect(signal).toBeDefined());
    expect(signal?.aborted).toBe(false);

    engine.dispose();
    expect(signal?.aborted).toBe(true);
    await prime;
    expect(engine.peekPromptSuggestion()).toBeNull();
  });

  it('sends the transcript tail as context', async () => {
    const completeFn = vi.fn(async () => 'ship it');
    const engine = createSuggestEngine({ completeFn });
    await engine.primePromptSuggestion(enabledCtx());
    const arg = completeFn.mock.calls[0]?.[0] as { user: string } | undefined;
    expect(arg?.user).toContain('fix the parser');
  });

  it('clearPromptSuggestion drops the stored value', async () => {
    const engine = createSuggestEngine({ completeFn: async () => 'run the tests' });
    await engine.primePromptSuggestion(enabledCtx());
    expect(engine.peekPromptSuggestion()).not.toBeNull();
    engine.clearPromptSuggestion();
    expect(engine.peekPromptSuggestion()).toBeNull();
  });

  it('dispose drops the stored value', async () => {
    const engine = createSuggestEngine({ completeFn: async () => 'run the tests' });
    await engine.primePromptSuggestion(enabledCtx());
    engine.dispose();
    expect(engine.peekPromptSuggestion()).toBeNull();
  });

  it('does not poison the Tier-2 completion cache', async () => {
    // The empty-prompt suggestion is deliberately uncached; it must also not
    // land in the buffer-keyed Tier-2 cache under the '' key.
    const completeFn = vi.fn(async () => 'run the tests');
    const engine = createSuggestEngine({ completeFn });
    await engine.primePromptSuggestion(enabledCtx());
    const ghost = await engine.getGhost('', enabledCtx());
    expect(ghost).toBeNull();
  });
});

describe('primePromptSuggestion — sanitization ordering', () => {
  // A transcript tail is required grounding — without it the startup gate
  // short-circuits before the provider call and these cases would pass for
  // the wrong reason (null from the gate, not from the sanitizer).
  const ctx = () =>
    makeCtx({
      llmEnabled: () => true,
      promptSuggestEnabled: () => true,
      getTranscriptTail: () => 'user: fix the parser\nassistant: fixed',
    });

  it('rejects a multi-line reply even though the scrubber would remove newlines', async () => {
    // Regression: stripGhostControlChars deletes \n. Scrubbing before
    // validating turned "do this\nthen that" into the plausible-looking
    // "do thisthen that" and let it through.
    const engine = createSuggestEngine({ completeFn: async () => 'do this\nthen that' });
    await engine.primePromptSuggestion(ctx());
    expect(engine.peekPromptSuggestion()).toBeNull();
  });

  it('rejects a U+2028 reply — the second class of line terminator', async () => {
    // Regression: the multi-line guard tested only /[\r\n]/, so a reply using
    // U+2028 (rendered as a break by many terminals) routed around the very
    // ordering the test above installs.
    const engine = createSuggestEngine({
      completeFn: async () => 'fix the bug\u2028rm -rf /tmp/x',
    });
    await engine.primePromptSuggestion(ctx());
    expect(engine.peekPromptSuggestion()).toBeNull();
  });

  it('scrubs bidi overrides out of an otherwise valid reply', async () => {
    const engine = createSuggestEngine({
      completeFn: async () => 'run \u202ethe tests\u202c',
    });
    await engine.primePromptSuggestion(ctx());
    const got = engine.peekPromptSuggestion();
    expect(got).toBe('run the tests');
    expect(got).not.toMatch(/[\u202a-\u202e\u2066-\u2069]/);
  });

  it('still scrubs control characters out of an otherwise valid reply', async () => {
    const engine = createSuggestEngine({
      completeFn: async () => '\u001b[31mrun the tests\u001b[0m',
    });
    await engine.primePromptSuggestion(ctx());
    const got = engine.peekPromptSuggestion();
    expect(got).toBe('run the tests');
    expect(got).not.toMatch(/\u001b/);
  });

  it('discards a reply that scrubs down to nothing', async () => {
    const engine = createSuggestEngine({ completeFn: async () => '\u001b[0m\u001b[0m' });
    await engine.primePromptSuggestion(ctx());
    expect(engine.peekPromptSuggestion()).toBeNull();
  });
});
