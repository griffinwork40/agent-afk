/**
 * Tests for ghost-text (inline suggestion) wiring in TerminalCompositor.
 *
 * Strategy: inject a controlled SuggestEngine via `opts.suggest` and verify
 * the render + accept + suppress logic at the compositor seam. No live LLM
 * or history disk I/O — all behaviour is exercised through the injected
 * engine and a synthetic SuggestContext.
 *
 * Covered:
 *   - Ghost renders when buffer is a strict prefix of a history entry and
 *     the dropdown is closed.
 *   - Ghost is SUPPRESSED when the dropdown is open.
 *   - Tab accepts the ghost (buffer becomes full suggestion) when dropdown
 *     is closed and the engine returns a Tier-1 ghost.
 *   - Tab still accepts the dropdown candidate when the dropdown is open
 *     (regression — existing Tab behaviour must not change).
 *   - Right-arrow at end-of-buffer accepts the ghost.
 *   - Right-arrow mid-buffer keeps its normal cursor-move behaviour.
 *   - Stale async ghost is discarded when the buffer changes between
 *     getGhost dispatch and resolve.
 *   - engine.dispose() is called when the compositor is disarmed.
 *   - Ghost is cleared on buffer change that breaks the prefix.
 *   - No ghost when buffer is empty.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { TerminalCompositor } from './terminal-compositor.js';
import { createAutocompleteState } from './input/autocomplete-state.js';
import type { SuggestEngine, SuggestContext } from './terminal-compositor.js';
import { register as registerSlashCommand, resetRegistry as resetSlashRegistry } from './slash/registry.js';

// ── TTY mock helpers (copied from terminal-compositor.test.ts) ────────────────

type MockStdout = NodeJS.WriteStream & {
  isTTY: boolean;
  columns: number;
  rows: number;
  emit(event: string, ...args: unknown[]): boolean;
};

type MockStdin = NodeJS.ReadStream & {
  isTTY: boolean;
  isRaw: boolean;
  setRawMode: ReturnType<typeof vi.fn>;
  emit(event: string, ...args: unknown[]): boolean;
};

function makeMockStdout(isTTY = true): MockStdout {
  const s = new PassThrough() as unknown as MockStdout;
  s.isTTY = isTTY;
  s.columns = 80;
  s.rows = 24;
  return s;
}

function makeMockStdin(isTTY = true): MockStdin {
  const s = new PassThrough() as unknown as MockStdin;
  s.isTTY = isTTY;
  s.isRaw = false;
  s.setRawMode = vi.fn((raw: boolean) => {
    (s as MockStdin).isRaw = raw;
    return s;
  });
  return s;
}

function collectWrites(stream: MockStdout): { all: () => string; clear: () => void } {
  const chunks: string[] = [];
  stream.on('data', (c: unknown) => chunks.push(String(c)));
  return {
    all: () => chunks.join(''),
    clear: () => { chunks.length = 0; },
  };
}

// ── SuggestEngine mock helpers ────────────────────────────────────────────────

function makeCtx(): SuggestContext {
  return {
    model: 'claude-haiku',
    apiKey: undefined,
    baseUrl: undefined,
    cwd: '/tmp',
    getHistory: () => [],
    getDropdownTopCandidate: () => null,
    getTranscriptTail: () => '',
    getRecentCommands: () => [],
    llmEnabled: () => false,
  };
}

/**
 * Create a minimal SuggestEngine mock.
 *
 * @param tier1Result  What getDeterministicGhost returns (null = no match).
 * @param tier2Result  What getGhost's promise resolves to (default: never resolves).
 */
function makeEngine(opts: {
  tier1Result?: string | null;
  tier2Result?: string | null;
  tier2Delay?: number;
} = {}): SuggestEngine & { disposeCalled: boolean } {
  const { tier1Result = null, tier2Result = undefined, tier2Delay = 0 } = opts;
  let disposeCalled = false;

  const engine = {
    get disposeCalled() { return disposeCalled; },
    getDeterministicGhost(_buffer: string, _ctx: SuggestContext): string | null {
      return tier1Result;
    },
    getGhost(_buffer: string, _ctx: SuggestContext): Promise<string | null> {
      if (tier2Result === undefined) {
        // Never resolves — simulates a pending async request.
        return new Promise<string | null>(() => {});
      }
      return new Promise<string | null>((resolve) => {
        setTimeout(() => resolve(tier2Result), tier2Delay);
      });
    },
    dispose() {
      disposeCalled = true;
    },
  };
  return engine;
}

/**
 * True when `s` contains an unpaired UTF-16 surrogate code unit — the
 * signature of a string sliced through the middle of an astral grapheme
 * (e.g. an emoji) by UTF-16-unit `.slice()`. A correct, grapheme-aware
 * truncation never produces one.
 */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true; // high surrogate, no low
      i++; // valid pair — skip the low surrogate
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true; // lone low surrogate
    }
  }
  return false;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TerminalCompositor ghost text', () => {
  let stdout: MockStdout;
  let stdin: MockStdin;
  let writes: ReturnType<typeof collectWrites>;

  beforeEach(() => {
    resetSlashRegistry();
    stdout = makeMockStdout();
    stdin = makeMockStdin();
    writes = collectWrites(stdout);
  });

  afterEach(() => {
    resetSlashRegistry();
  });

  // ── Render ──────────────────────────────────────────────────────────────────

  it('ghost renders dim suffix when buffer is a strict prefix of the suggestion', async () => {
    // Engine returns "hello world" for any buffer — when user types "hel",
    // the ghost suffix "lo world" should appear in dim styling.
    const engine = makeEngine({ tier1Result: 'hello world' });
    const c = new TerminalCompositor({
      stdout, stdin,
      suggest: { engine, getContext: makeCtx },
    });
    await c.arm();
    writes.clear();

    for (const ch of 'hel') {
      stdin.emit('keypress', ch, { name: ch, sequence: ch });
    }

    const out = writes.all();
    // The ghost suffix "lo world" must appear. We cannot assert exact ANSI
    // codes (palette.dim implementation detail) but the plain text must be present.
    expect(out).toContain('lo world');
    c.disarm();
  });

  it('ghost is NOT rendered when the dropdown is open', async () => {
    // Register a slash command so the dropdown can open for "/" input.
    registerSlashCommand({
      name: '/forge',
      description: 'test command',
      handler: async () => ({ kind: 'noop' as const }),
    });

    const ac = createAutocompleteState();
    const engine = makeEngine({ tier1Result: '/forge something' });
    const c = new TerminalCompositor({
      stdout, stdin,
      autocompleteState: ac,
      suggest: { engine, getContext: makeCtx },
    });
    await c.arm();
    writes.clear();

    // Type "/" to open the dropdown.
    stdin.emit('keypress', '/', { name: '/', sequence: '/' });

    // Dropdown should be open.
    expect(ac.dropdownOpen).toBe(true);

    const out = writes.all();
    // The ghost suffix " something" should NOT appear because dropdown is open.
    expect(out).not.toContain(' something');
    c.disarm();
  });

  it('ghost is cleared when buffer changes so the suggestion is no longer a prefix', async () => {
    // Ghost fires for "he" → "hello". Then user types "x" making buffer "hex".
    // "hello" no longer starts with "hex" → ghost must be absent.
    let callCount = 0;
    const engine: SuggestEngine & { disposeCalled: boolean } = {
      disposeCalled: false,
      getDeterministicGhost(buffer: string): string | null {
        callCount++;
        if (buffer === 'he') return 'hello';
        return null;
      },
      getGhost(): Promise<string | null> { return Promise.resolve(null); },
      dispose() { this.disposeCalled = true; },
    };

    const c = new TerminalCompositor({
      stdout, stdin,
      suggest: { engine, getContext: makeCtx },
    });
    await c.arm();

    // Type "he" — ghost "hello" should be active.
    for (const ch of 'he') {
      stdin.emit('keypress', ch, { name: ch, sequence: ch });
    }
    writes.clear();
    stdin.emit('keypress', 'x', { name: 'x', sequence: 'x' });

    const out = writes.all();
    // "llo" would be the ghost suffix for "hello" minus "he". Must not appear
    // because "hello" doesn't start with "hex".
    expect(out).not.toContain('llo');
    expect(callCount).toBeGreaterThan(0);
    c.disarm();
  });

  it('no ghost when buffer is empty', async () => {
    // Engine incorrectly returns something for empty buffer — compositor
    // should still not render a ghost because buffer.length === 0 and
    // the ghost contract requires buffer to be a strict non-empty prefix.
    // Actually, getDeterministicGhost in suggest.ts guards this, but the
    // compositor also checks ghost.startsWith(buffer) && ghost.length > buffer.length.
    const engine = makeEngine({ tier1Result: 'hello' });
    const c = new TerminalCompositor({
      stdout, stdin,
      suggest: { engine, getContext: makeCtx },
    });
    await c.arm();
    writes.clear();

    // No keystrokes — buffer stays empty. The initial repaint on arm() fires,
    // but the buffer is '' and the engine would have to return 'hello' for ''.
    // renderInputLine guards: ghost.startsWith('') is always true AND
    // ghost.length > 0, so this test verifies we don't render a ghost for
    // an empty-buffer arm-time repaint. The engine is called from applyEdit
    // (only on buffer changes), so at arm time with no keypress, no ghost fires.
    const out = writes.all();
    // "hello" must not appear in the initial idle render.
    expect(out).not.toContain('hello');
    c.disarm();
  });

  // ── Width-aware truncation (P1) ──────────────────────────────────────────────
  //
  // With `promptText: ''` the budget is `cols - bufferWidth - 1`, where
  // bufferWidth = displayWidth(buffer) + 1 (caret cell). These cases pin the
  // grapheme/column-aware truncation: the legacy `.length`/`.slice` path
  // under-counted wide chars (rendering past `cols` → line wrap → DECSTBM
  // corruption) and could slice through a surrogate pair.

  it('truncates a wide (CJK) ghost by display columns, not UTF-16 length (P1)', async () => {
    // cols=13, buffer 'a' (1 col) → budget = 13 - 2 - 1 = 10 cols = 5 CJK chars.
    // Legacy code compared remainder.length (8) <= budget (10) and rendered all
    // 8 CJK = 16 columns, overflowing the 13-column line.
    stdout.columns = 13;
    const engine = makeEngine({ tier1Result: 'a你好世界天地玄黄' });
    const c = new TerminalCompositor({
      stdout, stdin,
      promptText: '',
      suggest: { engine, getContext: makeCtx },
    });
    await c.arm();
    writes.clear();
    stdin.emit('keypress', 'a', { name: 'a', sequence: 'a' });

    const out = writes.all();
    expect(out).toContain('你好'); // ghost rendered (a truncated prefix)
    // The full 8-char remainder is 16 columns — it must NOT render in full.
    expect(out).not.toContain('你好世界天地玄黄');
    c.disarm();
  });

  it('truncates an emoji ghost on grapheme boundaries — never splits a surrogate pair (P1)', async () => {
    // cols=6, buffer 'a' → budget = 6 - 2 - 1 = 3 cols. Each emoji is 2 cols, so
    // one fits. Legacy `.slice(0, 3)` cut 3 UTF-16 units = one emoji + a lone
    // high surrogate.
    stdout.columns = 6;
    const engine = makeEngine({ tier1Result: 'a😀😀😀' });
    const c = new TerminalCompositor({
      stdout, stdin,
      promptText: '',
      suggest: { engine, getContext: makeCtx },
    });
    await c.arm();
    writes.clear();
    stdin.emit('keypress', 'a', { name: 'a', sequence: 'a' });

    const out = writes.all();
    expect(out).toContain('😀'); // at least one whole emoji rendered
    expect(hasLoneSurrogate(out)).toBe(false); // never split a surrogate pair
    c.disarm();
  });

  // ── Accept: Tab ─────────────────────────────────────────────────────────────

  it('Tab accepts ghost when dropdown is closed: buffer becomes the full suggestion', async () => {
    const engine = makeEngine({ tier1Result: 'hello world' });
    const c = new TerminalCompositor({
      stdout, stdin,
      suggest: { engine, getContext: makeCtx },
    });
    await c.arm();

    for (const ch of 'hel') {
      stdin.emit('keypress', ch, { name: ch, sequence: ch });
    }
    // Buffer is now 'hel', ghost is 'hello world'.
    expect(c.getBuffer().text).toBe('hel');

    stdin.emit('keypress', undefined, { name: 'tab' });
    expect(c.getBuffer().text).toBe('hello world');
    c.disarm();
  });

  it('Tab accepts dropdown candidate when dropdown is open — regression guard', async () => {
    registerSlashCommand({
      name: '/mint',
      description: 'test mint',
      handler: async () => ({ kind: 'noop' as const }),
    });

    const ac = createAutocompleteState();
    // Engine would return something but dropdown takes precedence.
    const engine = makeEngine({ tier1Result: 'something-else' });
    const c = new TerminalCompositor({
      stdout, stdin,
      autocompleteState: ac,
      suggest: { engine, getContext: makeCtx },
    });
    await c.arm();

    stdin.emit('keypress', '/', { name: '/', sequence: '/' });
    expect(ac.dropdownOpen).toBe(true);
    const dropdownCandidate = ac.candidates[0]?.value ?? '';
    expect(dropdownCandidate.length).toBeGreaterThan(0);

    stdin.emit('keypress', undefined, { name: 'tab' });
    // Buffer should contain the slash command, not 'something-else'.
    expect(c.getBuffer().text).not.toBe('something-else');
    expect(c.getBuffer().text).toContain('/');
    c.disarm();
  });

  it('Tab is a no-op when no ghost and dropdown is closed', async () => {
    const engine = makeEngine({ tier1Result: null });
    const c = new TerminalCompositor({
      stdout, stdin,
      suggest: { engine, getContext: makeCtx },
    });
    await c.arm();

    for (const ch of 'abc') {
      stdin.emit('keypress', ch, { name: ch, sequence: ch });
    }
    // Ghost is null — Tab should do nothing.
    stdin.emit('keypress', undefined, { name: 'tab' });
    expect(c.getBuffer().text).toBe('abc');
    c.disarm();
  });

  // ── Accept: Right-arrow ──────────────────────────────────────────────────────

  it('Right-arrow at end-of-buffer accepts ghost', async () => {
    const engine = makeEngine({ tier1Result: 'hello world' });
    const c = new TerminalCompositor({
      stdout, stdin,
      suggest: { engine, getContext: makeCtx },
    });
    await c.arm();

    for (const ch of 'hel') {
      stdin.emit('keypress', ch, { name: ch, sequence: ch });
    }
    expect(c.getBuffer().text).toBe('hel');

    stdin.emit('keypress', undefined, { name: 'right' });
    expect(c.getBuffer().text).toBe('hello world');
    c.disarm();
  });

  it('Right-arrow mid-buffer keeps normal cursor-move behaviour', async () => {
    const engine = makeEngine({ tier1Result: 'hello world' });
    const c = new TerminalCompositor({
      stdout, stdin,
      suggest: { engine, getContext: makeCtx },
    });
    await c.arm();

    for (const ch of 'abc') {
      stdin.emit('keypress', ch, { name: ch, sequence: ch });
    }
    // Move cursor back to position 1 (mid-buffer).
    stdin.emit('keypress', undefined, { name: 'left' });
    stdin.emit('keypress', undefined, { name: 'left' });
    // Cursor is now at position 1; ghost IS active but cursor is NOT at end.
    // Right-arrow should advance cursor, not accept ghost.
    stdin.emit('keypress', undefined, { name: 'right' });
    expect(c.getBuffer().text).toBe('abc');
    c.disarm();
  });

  // ── Stale async ghost guard ──────────────────────────────────────────────────

  it('async ghost is discarded when buffer changed before resolve', async () => {
    vi.useFakeTimers();
    let resolveGhost: ((v: string | null) => void) | null = null;

    const engine: SuggestEngine & { disposeCalled: boolean } = {
      disposeCalled: false,
      getDeterministicGhost(): string | null { return null; },
      getGhost(buffer: string): Promise<string | null> {
        // Only store the resolver for the first call (buffer = 'hel').
        if (buffer === 'hel') {
          return new Promise<string | null>((resolve) => { resolveGhost = resolve; });
        }
        return Promise.resolve(null);
      },
      dispose() { this.disposeCalled = true; },
    };

    const c = new TerminalCompositor({
      stdout, stdin,
      suggest: { engine, getContext: makeCtx },
    });
    await c.arm();

    // Type 'hel' — triggers async ghost request for 'hel'.
    for (const ch of 'hel') {
      stdin.emit('keypress', ch, { name: ch, sequence: ch });
    }
    // Type 'x' — buffer is now 'helx'. Ghost for 'hel' is stale.
    stdin.emit('keypress', 'x', { name: 'x', sequence: 'x' });

    writes.clear();
    // Now resolve the stale ghost for 'hel'.
    resolveGhost?.('hello world');
    await vi.runAllTimersAsync();
    // Flush microtasks.
    await Promise.resolve();

    // The ghost suffix 'lo world' should NOT appear — buffer is 'helx',
    // which does not match the ghost's captured buffer 'hel'.
    const out = writes.all();
    expect(out).not.toContain('lo world');
    // Buffer should remain 'helx' (ghost was not applied).
    expect(c.getBuffer().text).toBe('helx');

    c.disarm();
    vi.useRealTimers();
  });

  // ── Dispose ──────────────────────────────────────────────────────────────────

  it('engine.dispose() is called when compositor is disarmed', async () => {
    const engine = makeEngine({ tier1Result: null });
    const c = new TerminalCompositor({
      stdout, stdin,
      suggest: { engine, getContext: makeCtx },
    });
    await c.arm();
    expect(engine.disposeCalled).toBe(false);
    c.disarm();
    expect(engine.disposeCalled).toBe(true);
  });

  // ── Mid-sentence skill ghost (source c wiring) ───────────────────────────────

  it('mid-sentence skill ghost: dim suffix renders for /partial token', async () => {
    // Engine returns 'use /forge' for any buffer — simulates source (c) matching
    // 'use /fo' and returning the full buffer with the completed skill name.
    const engine = makeEngine({ tier1Result: 'use /forge' });
    const c = new TerminalCompositor({
      stdout, stdin,
      suggest: { engine, getContext: makeCtx },
    });
    await c.arm();
    writes.clear();

    for (const ch of 'use /fo') {
      stdin.emit('keypress', ch, { name: ch, sequence: ch });
    }

    const out = writes.all();
    // Ghost suffix 'rge' must appear in the render output.
    expect(out).toContain('rge');
    c.disarm();
  });

  it('Tab accepts mid-sentence skill ghost: buffer becomes full skill name', async () => {
    // Engine returns 'use /forge' as the tier1 ghost for any buffer.
    const engine = makeEngine({ tier1Result: 'use /forge' });
    const c = new TerminalCompositor({
      stdout, stdin,
      suggest: { engine, getContext: makeCtx },
    });
    await c.arm();

    for (const ch of 'use /fo') {
      stdin.emit('keypress', ch, { name: ch, sequence: ch });
    }
    expect(c.getBuffer().text).toBe('use /fo');

    stdin.emit('keypress', undefined, { name: 'tab' });
    expect(c.getBuffer().text).toBe('use /forge');
    c.disarm();
  });

  it('engine.dispose() is NOT called when compositor is disarmed without being armed (no-op path)', () => {
    // When disarm() is called on an unarmed compositor, the early-return path
    // calls resetState() but does NOT dispose the engine — the engine was never
    // started in this lifecycle and no async work was ever kicked off.
    // This matches the existing disarm() contract (the early-return path is a
    // defensive no-op, not a full teardown). In the real REPL, the engine is
    // only passed to a compositor that runs armCompositor() on a real TTY.
    const engine = makeEngine({ tier1Result: null });
    const c = new TerminalCompositor({
      stdout, stdin,
      suggest: { engine, getContext: makeCtx },
    });
    c.disarm(); // disarm without arm — early-return path
    expect(engine.disposeCalled).toBe(false);
  });

  // ── Constructor with no suggest option ──────────────────────────────────────

  it('compositor works normally when no suggest option is provided', async () => {
    // Regression: omitting `suggest` should not throw or change existing behaviour.
    const c = new TerminalCompositor({ stdout, stdin });
    await c.arm();
    for (const ch of 'hello') {
      stdin.emit('keypress', ch, { name: ch, sequence: ch });
    }
    expect(c.getBuffer().text).toBe('hello');
    c.disarm();
  });
});
