/**
 * InputSurface — facade contract.
 *
 * Stage 2 status: facade only. These tests assert the wiring contract
 * (history + autocomplete + statusLine are owned by the surface and
 * delivered to both reader and runTurn refs), NOT the underlying read
 * behavior — that's still owned by readWithAutocomplete and covered by
 * its own test suite.
 *
 * When Stage 3 lands (persistent compositor), these tests stay
 * meaningful: the API surface remains, the implementation underneath
 * changes.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import type { Interface as ReadlineInterface } from 'readline';
import chalk from 'chalk';
import { InputSurface, type InputSurfaceStatusLine } from './input-surface.js';
import type { IHistoryRing } from './types.js';
import * as InputBox from '../input-box.js';
import {
  register as registerSlash,
  resetRegistry as resetSlashRegistry,
} from '../slash/registry.js';

function makeRl(): ReadlineInterface {
  // The facade never invokes rl directly — readWithAutocomplete owns it.
  // An empty stub suffices for surface-construction tests.
  return {} as ReadlineInterface;
}

function makeHistory(): IHistoryRing {
  return {
    back: () => null,
    forward: () => null,
    resetRecall: () => {},
    get inRecall() { return false; },
  };
}

/**
 * TTY-shaped mock streams. Mirrors the pattern in terminal-compositor.test.ts
 * so the persistent-compositor integration path can be exercised without a
 * real terminal. `setRawMode` is required by the compositor's arm() path
 * (raw-mode entry); a vi.fn that mirrors the requested state is sufficient.
 */
type MockStdout = NodeJS.WriteStream & {
  isTTY: boolean;
  columns: number;
  rows: number;
};

type MockStdin = NodeJS.ReadStream & {
  isTTY: boolean;
  isRaw: boolean;
  setRawMode: ReturnType<typeof vi.fn>;
};

function makeMockStdout(): MockStdout {
  const s = new PassThrough() as unknown as MockStdout;
  s.isTTY = true;
  s.columns = 80;
  s.rows = 24;
  return s;
}

function makeMockStdin(): MockStdin {
  const s = new PassThrough() as unknown as MockStdin;
  s.isTTY = true;
  s.isRaw = false;
  s.setRawMode = vi.fn((raw: boolean) => {
    s.isRaw = raw;
    return s;
  });
  return s;
}

function makeStatusLine(): InputSurfaceStatusLine {
  let rows = 0;
  return {
    getExtraRows: () => rows,
    setExtraRows: (n) => { rows = n; },
    withFullScrollRegion: <T>(fn: () => T) => fn(),
  };
}

describe('InputSurface', () => {
  describe('construction', () => {
    it('exposes the history ref passed at construction', () => {
      const history = makeHistory();
      const surface = new InputSurface({ rl: makeRl(), history });
      expect(surface.history).toBe(history);
    });

    it('creates a fresh autocomplete state per surface', () => {
      const a = new InputSurface({ rl: makeRl(), history: makeHistory() });
      const b = new InputSurface({ rl: makeRl(), history: makeHistory() });
      expect(a.autocompleteState).not.toBe(b.autocompleteState);
      // And it's a usable AutocompleteState (has the reset method).
      expect(typeof a.autocompleteState.reset).toBe('function');
    });
  });

  describe('toRunTurnRefs', () => {
    it('packages surface refs + caller-supplied promptText into the run-turn shape', () => {
      const history = makeHistory();
      const surface = new InputSurface({ rl: makeRl(), history });
      const refs = surface.toRunTurnRefs('afk (sonnet) › ');
      expect(refs.history).toBe(history);
      expect(refs.autocompleteState).toBe(surface.autocompleteState);
      expect(refs.promptText).toBe('afk (sonnet) › ');
    });

    it('produces a fresh refs object per call so callers cannot mutate surface state via the returned bag', () => {
      const surface = new InputSurface({ rl: makeRl(), history: makeHistory() });
      const a = surface.toRunTurnRefs('p1');
      const b = surface.toRunTurnRefs('p2');
      expect(a).not.toBe(b);
      expect(a.promptText).toBe('p1');
      expect(b.promptText).toBe('p2');
      // Shared refs by reference (correct — they ARE long-lived):
      expect(a.history).toBe(b.history);
      expect(a.autocompleteState).toBe(b.autocompleteState);
    });
  });

  describe('statusLine', () => {
    it('accepts an optional statusLine ref at construction', () => {
      const statusLine = makeStatusLine();
      // No throw on construction with a statusLine — the surface stores it
      // and forwards it inside readLine(). Behavior is exercised end-to-end
      // by repl-loop-wiring.test.ts; this is just the shape contract.
      expect(() => new InputSurface({
        rl: makeRl(),
        history: makeHistory(),
        statusLine,
      })).not.toThrow();
    });

    it('accepts construction without a statusLine (non-REPL surfaces)', () => {
      expect(() => new InputSurface({
        rl: makeRl(),
        history: makeHistory(),
      })).not.toThrow();
    });
  });

  describe('persistent compositor lifecycle (Stage 3e)', () => {
    it('armCompositor is a no-op on non-TTY surfaces', async () => {
      // Vitest runs with process.stdout.isTTY === undefined (false). The
      // armCompositor guard at input-surface.ts:188 short-circuits, leaving
      // getCompositor() returning null. readLine() then takes the
      // readWithAutocomplete fallback path — this is the contract for
      // daemon, pipe, and CI surfaces.
      const surface = new InputSurface({ rl: makeRl(), history: makeHistory() });
      await surface.armCompositor({
        promptFn: () => '> ',
        onCancel: () => {},
      });
      expect(surface.getCompositor()).toBeNull();
    });

    it('armCompositor is idempotent — second call is a no-op even on non-TTY', async () => {
      const surface = new InputSurface({ rl: makeRl(), history: makeHistory() });
      await surface.armCompositor({ promptFn: () => '> ', onCancel: () => {} });
      await surface.armCompositor({ promptFn: () => '> ', onCancel: () => {} });
      // No throw. The idempotency guard is internal so the only observable is
      // that we don't crash.
      expect(surface.getCompositor()).toBeNull();
    });

    it('dispose is idempotent and safe on a never-armed surface', async () => {
      const surface = new InputSurface({ rl: makeRl(), history: makeHistory() });
      // Two disposes without an arm — surfaces dispose() must not throw even
      // when compositor was never set (e.g. surface constructed but never
      // armed because of a startup error before armCompositor).
      await expect(surface.dispose()).resolves.toBeUndefined();
      await expect(surface.dispose()).resolves.toBeUndefined();
    });

    it('setBackgroundHandler is safe before armCompositor', () => {
      // The handler ref lives on the surface even when no compositor is
      // armed — the per-turn caller (turn-handler) sets/clears it
      // unconditionally without checking TTY status, so the surface must
      // accept the call cleanly.
      const surface = new InputSurface({ rl: makeRl(), history: makeHistory() });
      expect(() => surface.setBackgroundHandler(() => {})).not.toThrow();
      expect(() => surface.setBackgroundHandler(null)).not.toThrow();
    });

    describe('AFK_PLAIN_OUTPUT full render opt-out (Lever 1)', () => {
      // Regression for the "--plain doesn't suppress the persistent
      // compositor" bug. Root cause: armCompositor()'s early-return only
      // checked `!stdout.isTTY || !stdin.isTTY` — a --plain session on a
      // real TTY (both streams report isTTY: true) still armed the
      // persistent compositor, leaving setCompositor() a no-op downstream
      // (repl-renderer.ts) while the compositor itself stayed live. Adding
      // isPlainOutputRequested() to the guard makes armCompositor() agree
      // with the render seam: getCompositor() stays null, so readLine()
      // falls through to the non-TTY readWithAutocomplete reader — the
      // intended opt-out tradeoff.
      afterEach(() => {
        vi.unstubAllEnvs();
      });

      it('armCompositor is a no-op when AFK_PLAIN_OUTPUT=1 even though stdout/stdin are TTYs', async () => {
        vi.stubEnv('AFK_PLAIN_OUTPUT', '1');
        const stdout = makeMockStdout();
        const stdin = makeMockStdin();
        const surface = new InputSurface({ rl: makeRl(), history: makeHistory() });

        await surface.armCompositor({
          promptFn: () => '> ',
          onCancel: () => {},
          stdout,
          stdin,
        });

        expect(surface.getCompositor()).toBeNull();
      });

      it('armCompositor is a no-op when AFK_PLAIN_OUTPUT=true (case-insensitive) on a TTY', async () => {
        vi.stubEnv('AFK_PLAIN_OUTPUT', 'TRUE');
        const stdout = makeMockStdout();
        const stdin = makeMockStdin();
        const surface = new InputSurface({ rl: makeRl(), history: makeHistory() });

        await surface.armCompositor({
          promptFn: () => '> ',
          onCancel: () => {},
          stdout,
          stdin,
        });

        expect(surface.getCompositor()).toBeNull();
      });

      it('arms normally on a TTY when AFK_PLAIN_OUTPUT is unset (no behavior change)', async () => {
        vi.stubEnv('AFK_PLAIN_OUTPUT', undefined as unknown as string);
        const stdout = makeMockStdout();
        const stdin = makeMockStdin();
        const surface = new InputSurface({ rl: makeRl(), history: makeHistory() });

        await surface.armCompositor({
          promptFn: () => '> ',
          onCancel: () => {},
          stdout,
          stdin,
        });

        expect(surface.getCompositor()).not.toBeNull();
        await surface.dispose();
      });

      it('does not suppress arming for unrecognized values (e.g. "0")', async () => {
        vi.stubEnv('AFK_PLAIN_OUTPUT', '0');
        const stdout = makeMockStdout();
        const stdin = makeMockStdin();
        const surface = new InputSurface({ rl: makeRl(), history: makeHistory() });

        await surface.armCompositor({
          promptFn: () => '> ',
          onCancel: () => {},
          stdout,
          stdin,
        });

        expect(surface.getCompositor()).not.toBeNull();
        await surface.dispose();
      });
    });

    it('readLine on an armed TTY surface does not call readWithAutocomplete (persistent path)', async () => {
      // Invariant carried over from the deleted repl-loop-seed.test.ts:
      // When the persistent compositor is armed and readLine() is called,
      // the implementation MUST take the compositor path (Promise waiting
      // for onSubmit) and MUST NOT fall through to the readWithAutocomplete
      // fallback. This test asserts the bypass, not just that readLine
      // resolves — an earlier version of this suite only checked resolution
      // and would not have caught a regression that called both paths.
      const spy = vi.spyOn(InputBox, 'readWithAutocomplete');

      const stdout = makeMockStdout();
      const stdin = makeMockStdin();
      const surface = new InputSurface({ rl: makeRl(), history: makeHistory() });

      await surface.armCompositor({
        promptFn: () => 'afk › ',
        onCancel: () => {},
        stdout,
        stdin,
      });
      expect(surface.getCompositor()).not.toBeNull();

      const readPromise = surface.readLine({ promptFn: () => 'afk › ' });

      // Submit a line via the compositor path (keypress → Enter).
      for (const ch of 'bypass-check') {
        stdin.emit('keypress', ch, { name: ch, sequence: ch });
      }
      stdin.emit('keypress', undefined, { name: 'return' });

      await readPromise;

      // The compositor path resolved the promise — the fallback must never
      // have been called.
      expect(spy).not.toHaveBeenCalled();

      spy.mockRestore();
      await surface.dispose();
    });

    it('dispose() called mid-flight rejects the pending readLine promise', async () => {
      // Contract: readLine() blocks on an onSubmit handler. If dispose() is
      // called while that Promise is still in-flight (no Enter yet), the
      // Promise must reject with a disposal error — callers must never be
      // left with a permanently-hanging await.
      //
      // Implementation: dispose() calls setOnSubmit(null) and then calls
      // the stored pendingReadReject with a DisposedError before disarming.
      const stdout = makeMockStdout();
      const stdin = makeMockStdin();
      const surface = new InputSurface({ rl: makeRl(), history: makeHistory() });

      await surface.armCompositor({
        promptFn: () => 'afk › ',
        onCancel: () => {},
        stdout,
        stdin,
      });
      expect(surface.getCompositor()).not.toBeNull();

      // Start readLine but do NOT press Enter — leave the Promise in-flight.
      const readPromise = surface.readLine({ promptFn: () => 'afk › ' });

      // Call dispose() while the Promise is still pending.
      await surface.dispose();

      // The pending Promise must have been rejected by dispose().
      await expect(readPromise).rejects.toThrow('disposed');
    });

    it('readLine repaints the prompt before blocking even when already idle (regression: fresh-session prompt invisible until first keypress)', async () => {
      // Regression: on a fresh `afk interactive` session, armCompositor()
      // paints the prompt (streaming→idle repaint), then footer subsystems
      // (loop-stage bar, bg bar) bump StatusLine.extraRows and overwrite the
      // prompt row. The first readLine() then calls setInputMode('idle') on an
      // ALREADY-idle compositor — a no-op for the repaint, because the
      // `prev !== mode` guard (terminal-compositor.ts) suppresses idle→idle
      // repaints — so the prompt stayed invisible until the user's first
      // keypress triggered a repaint. readLine() must repaint explicitly so
      // the prompt shows up immediately. We assert the surface-level invariant
      // ("readLine paints the prompt before blocking") rather than a specific
      // call count, so the test stays green under either fix shape.
      const stdout = makeMockStdout();
      const stdin = makeMockStdin();
      const surface = new InputSurface({ rl: makeRl(), history: makeHistory() });

      await surface.armCompositor({
        promptFn: () => 'afk › ',
        onCancel: () => {},
        stdout,
        stdin,
      });
      const compositor = surface.getCompositor()!;
      expect(compositor).not.toBeNull();
      // armCompositor leaves the compositor in idle mode — so the readLine
      // below exercises the idle→idle (no mode change) path exactly.
      expect(compositor.getInputMode()).toBe('idle');

      // Spy AFTER arm so we measure only the readLine-triggered repaint, not
      // armCompositor's own streaming→idle paint. vi.spyOn calls through, so
      // the real prompt still renders.
      const repaintSpy = vi.spyOn(compositor, 'repaint');

      // Start readLine but do NOT submit — it blocks waiting for Enter. The
      // act of calling readLine (idle→idle setInputMode, no queue) must paint
      // the prompt at least once before blocking. Pre-fix this was zero.
      const readPromise = surface.readLine({ promptFn: () => 'afk › ' });

      expect(repaintSpy).toHaveBeenCalled();

      // Cleanup: dispose rejects the in-flight readLine promise.
      repaintSpy.mockRestore();
      await surface.dispose();
      await expect(readPromise).rejects.toThrow('disposed');
    });
  });

  /**
   * Stage 3e integration coverage — fills the gap surfaced by the
   * adversarial verifier on the Stage 3e PR. The deleted
   * `repl-loop-seed.test.ts` had an analogous integration shape for the
   * old `seedBuffer` fast-path; this replaces it for the new
   * `surface.readLine → compositor.onSubmit → resolve` roundtrip.
   *
   * The compositor-level flush invariant is unit-tested at
   * `terminal-compositor.test.ts:1032` ('idle → idle with queued buffer +
   * handler flushes'). This suite asserts the SURFACE wires that
   * mechanism correctly: readLine installs the handler, the typed Enter
   * fires it, and the promise resolves with the typed payload.
   */
  describe('readLine → onSubmit roundtrip (Stage 3e integration)', () => {
    it('readLine resolves with the typed text when user presses Enter', async () => {
      const stdout = makeMockStdout();
      const stdin = makeMockStdin();
      const surface = new InputSurface({ rl: makeRl(), history: makeHistory() });

      await surface.armCompositor({
        promptFn: () => 'afk › ',
        onCancel: () => {},
        stdout,
        stdin,
      });
      expect(surface.getCompositor()).not.toBeNull();

      // Start the read. Don't await yet — we need to drive keypresses
      // into stdin before Enter resolves the promise.
      const readPromise = surface.readLine({
        promptFn: () => 'afk › ',
      });

      // Type "hello" + Enter.
      for (const ch of 'hello') {
        stdin.emit('keypress', ch, { name: ch, sequence: ch });
      }
      stdin.emit('keypress', undefined, { name: 'return' });

      const result = await readPromise;
      expect(result.text).toBe('hello');
      expect(result.attachments).toEqual([]);

      // Cleanup so the surface's raw-mode handle releases cleanly.
      await surface.dispose();
    });

    it('readLine auto-resolves when a buffer was queued between calls (idle → idle flush)', async () => {
      // Scenario the widened setInputMode flush invariant closes: the
      // user types + Enters in the brief gap between two readLine calls
      // (no handler installed); the Enter falls through to the streaming-
      // queue branch. The NEXT readLine must auto-fire the queued
      // submission via setInputMode('idle') flushing the buffer through
      // the freshly-installed onSubmit handler.
      const stdout = makeMockStdout();
      const stdin = makeMockStdin();
      const surface = new InputSurface({ rl: makeRl(), history: makeHistory() });

      await surface.armCompositor({
        promptFn: () => 'afk › ',
        onCancel: () => {},
        stdout,
        stdin,
      });

      // Simulate the inter-readLine race: type + Enter with NO handler
      // installed. The compositor's Enter handler falls through to the
      // queue branch and sets queued=true.
      const compositor = surface.getCompositor()!;
      for (const ch of 'queued') {
        stdin.emit('keypress', ch, { name: ch, sequence: ch });
      }
      stdin.emit('keypress', undefined, { name: 'return' });
      // New contract: Enter commits 'queued' to the FIFO and clears the live buffer.
      expect(compositor.getBuffer()).toEqual({ text: '', queued: true });
      expect(compositor.getPendingCount()).toBe(1);

      // Now call readLine. The widened flush invariant fires the just-
      // installed handler synchronously inside setInputMode('idle').
      const result = await surface.readLine({ promptFn: () => 'afk › ' });
      expect(result.text).toBe('queued');
      expect(result.attachments).toEqual([]);
      // Buffer + queued flag cleared after the synthesized submission.
      expect(compositor.getBuffer()).toEqual({ text: '', queued: false });

      await surface.dispose();
    });

    it('readLine commits a scrollback echo above the live overlay', async () => {
      // Visual-parity guarantee: the submitted text must surface in
      // scrollback (above the live overlay), not vanish when the input
      // row clears. The compositor's commitAbove writes the echo line
      // to stdout — assert the echo is present in what was written.
      const stdout = makeMockStdout();
      const stdin = makeMockStdin();
      const writes: string[] = [];
      stdout.on('data', (chunk: unknown) => writes.push(String(chunk)));

      const surface = new InputSurface({ rl: makeRl(), history: makeHistory() });
      await surface.armCompositor({
        promptFn: () => 'afk › ',
        onCancel: () => {},
        stdout,
        stdin,
      });

      const readPromise = surface.readLine({ promptFn: () => 'afk › ' });
      for (const ch of 'echo-me') {
        stdin.emit('keypress', ch, { name: ch, sequence: ch });
      }
      stdin.emit('keypress', undefined, { name: 'return' });
      const result = await readPromise;
      expect(result.text).toBe('echo-me');

      // The echo content lands in writes via commitAbove. We can't pin
      // it to a specific line because log-update's clear/repaint cycle
      // interleaves frames, but the submitted text must appear somewhere
      // in the cumulative output.
      const allOutput = writes.join('');
      expect(allOutput).toContain('echo-me');

      await surface.dispose();
    });

    it('submit echo colorizes registered slash commands (regression: scrollback used to render /cmd as plain text)', async () => {
      // Regression for the bug where the persistent-compositor path
      // (input-surface.ts) populated formatSubmittedEcho with the raw
      // SubmissionPayload.text — bypassing colorizeInputBuffer — so
      // submitted `/cmd` tokens committed to scrollback as plain text
      // even though live-typing was correctly colorized. The legacy
      // reader path (reader.ts:329-330) always colorized before echoing;
      // this test pins the two paths to the same visual contract.
      //
      // Forces chalk on (vitest's piped stdout otherwise lands at
      // level 0 and colorizeInputBuffer becomes a no-op pass-through).
      const originalLevel = chalk.level;
      chalk.level = 3;
      // Clear the registry so list() returns only our test command —
      // input-surface.test.ts otherwise never touches the registry, so
      // this is a fresh slate (vitest isolates modules per file).
      resetSlashRegistry();
      registerSlash({
        name: '/test-cmd',
        summary: 'test command for highlight regression',
        handler: async () => 'continue',
      });
      try {
        const stdout = makeMockStdout();
        const stdin = makeMockStdin();

        const surface = new InputSurface({ rl: makeRl(), history: makeHistory() });
        await surface.armCompositor({
          promptFn: () => 'afk › ',
          onCancel: () => {},
          stdout,
          stdin,
        });

        // Spy on commitAbove directly — the live-typing repaint also
        // writes ANSI-colored text to stdout (via formatInputBuffer),
        // so stdout writes can't discriminate the regression. The bug
        // was specifically that the *committed scrollback line* came
        // through plain. commitAbove receives that line as its `text`
        // argument; spying isolates the assertion to the committed echo.
        const compositor = surface.getCompositor()!;
        const commitAboveSpy = vi.spyOn(compositor, 'commitAbove');

        const readPromise = surface.readLine({ promptFn: () => 'afk › ' });
        for (const ch of '/test-cmd') {
          stdin.emit('keypress', ch, { name: ch, sequence: ch });
        }
        stdin.emit('keypress', undefined, { name: 'return' });
        const result = await readPromise;
        // The submitted text may include a trailing space from the
        // autocomplete-completion path (input-box.ts inserts a separator
        // after a recognized command); the regression we care about is
        // visual, not textual — `/test-cmd` must be present.
        expect(result.text).toContain('/test-cmd');

        // Contract: at least one commitAbove call carries an ANSI SGR
        // escape directly preceding `/test-cmd`. Before the fix, the
        // submit-echo branch passed the raw payload.text and committed
        // a plain string here. We deliberately don't pin a specific RGB
        // value — palette colors are tuning-domain. The brand-palette
        // ANSI escape SHAPE (`\x1b[…m/test-cmd`) is the invariant.
        const committedLines = commitAboveSpy.mock.calls.map(([line]) =>
          typeof line === 'string' ? line : '',
        );
        const aggregate = committedLines.join('\n');
        // eslint-disable-next-line no-control-regex
        expect(aggregate).toMatch(/\x1b\[[\d;]+m\/test-cmd/);

        await surface.dispose();
      } finally {
        chalk.level = originalLevel;
        resetSlashRegistry();
      }
    });

    it('large-paste truncation: readLine returns expanded text, scrollback echo shows placeholder', async () => {
      // End-to-end contract for the paste-truncation feature:
      //   1. User pastes a multi-line blob that exceeds the compositor
      //      threshold (≥5 newlines).
      //   2. The visible input row collapses to a `[Pasted text #<nonce> +N lines]`
      //      placeholder while pasted content lives in pasteRegistry.
      //   3. User presses Enter — readLine() resolves with the EXPANDED text
      //      (sent to the model verbatim).
      //   4. The scrollback echo (committed via commitAbove) carries the
      //      placeholder form so transcript stays compact.
      const stdout = makeMockStdout();
      const stdin = makeMockStdin();

      const surface = new InputSurface({ rl: makeRl(), history: makeHistory() });
      await surface.armCompositor({
        promptFn: () => 'afk › ',
        onCancel: () => {},
        stdout,
        stdin,
      });

      const compositor = surface.getCompositor()!;
      const commitAboveSpy = vi.spyOn(compositor, 'commitAbove');

      const readPromise = surface.readLine({ promptFn: () => 'afk › ' });

      // Emit a 6-line bracketed paste.
      stdin.emit('keypress', undefined, { sequence: '\x1b[200~' });
      const lines = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        for (const ch of line) {
          stdin.emit('keypress', ch, { name: ch, sequence: ch });
        }
        if (i < lines.length - 1) {
          stdin.emit('keypress', '\r', { name: 'return', sequence: '\r' });
        }
      }
      stdin.emit('keypress', undefined, { sequence: '\x1b[201~' });
      stdin.emit('keypress', undefined, { name: 'return' });

      const result = await readPromise;

      // readLine result MUST be the expanded form — that's what flows to
      // the model on the next agent turn.
      expect(result.text).toBe('alpha\nbeta\ngamma\ndelta\nepsilon\nzeta');

      // The scrollback echo MUST carry the placeholder form (or contain it
      // as a substring after the prompt). Aggregate every commitAbove call
      // and strip ANSI for a robust substring check.
      const ANSI = /\x1b\[[0-9;]*m/g;
      const committedLines = commitAboveSpy.mock.calls.map(([line]) =>
        typeof line === 'string' ? line.replace(ANSI, '') : '',
      );
      const aggregate = committedLines.join('\n');
      expect(aggregate).toMatch(/\[Pasted text #[0-9a-f]{8} \+6 lines\]/);
      // And critically: the expanded content must NOT appear in the echo
      // — otherwise the scrollback would still scroll past 6 lines.
      expect(aggregate).not.toContain('alpha\nbeta');

      await surface.dispose();
    });

    it('drives two full readLine turns on the same armed surface — core persistent-compositor invariant', async () => {
      // This is the highest-value integration scenario: the compositor stays
      // armed across BOTH turns (persistent), each turn resolves independently
      // with the correct text, and the buffer is clean between turns.
      const stdout = makeMockStdout();
      const stdin = makeMockStdin();
      const surface = new InputSurface({ rl: makeRl(), history: makeHistory() });

      await surface.armCompositor({
        promptFn: () => 'afk › ',
        onCancel: () => {},
        stdout,
        stdin,
      });
      const compositor = surface.getCompositor()!;
      expect(compositor).not.toBeNull();

      // ── Turn 1 ────────────────────────────────────────────────────────────
      const readPromise1 = surface.readLine({ promptFn: () => 'afk › ' });

      for (const ch of 'first') {
        stdin.emit('keypress', ch, { name: ch, sequence: ch });
      }
      stdin.emit('keypress', undefined, { name: 'return' });

      const result1 = await readPromise1;
      expect(result1.text).toBe('first');
      expect(result1.attachments).toEqual([]);

      // Buffer must be clean after the first turn resolves — the compositor
      // stays armed but its input state is fully reset for the next cycle.
      expect(compositor.getBuffer()).toEqual({ text: '', queued: false });

      // ── Turn 2 (same armed compositor, no re-arm) ─────────────────────────
      const readPromise2 = surface.readLine({ promptFn: () => 'afk › ' });

      for (const ch of 'second') {
        stdin.emit('keypress', ch, { name: ch, sequence: ch });
      }
      stdin.emit('keypress', undefined, { name: 'return' });

      const result2 = await readPromise2;
      expect(result2.text).toBe('second');
      expect(result2.attachments).toEqual([]);

      // Buffer must be clean again after the second turn — the persistent
      // compositor correctly handles N consecutive cycles.
      expect(compositor.getBuffer()).toEqual({ text: '', queued: false });

      // Compositor ref must be the SAME object across both turns (persistent,
      // not torn down and re-created between cycles).
      expect(surface.getCompositor()).toBe(compositor);

      await surface.dispose();
    });
  });

  /**
   * Auto-resume wake support — the seam that lets a settled background
   * subagent wake an idle prompt without a keystroke (see
   * loop-iteration.ts `onInjectable` wiring). `abortPendingRead()` resolves
   * an in-flight compositor read with an EMPTY payload; `isAwaitingInput()`
   * and `bufferIsEmpty()` gate that wake so it never clobbers a half-typed
   * line or fires when no read is blocked.
   */
  describe('auto-resume wake support (abortPendingRead / isAwaitingInput / bufferIsEmpty)', () => {
    it('isAwaitingInput() tracks the in-flight compositor read: false → true → false', async () => {
      const stdout = makeMockStdout();
      const stdin = makeMockStdin();
      const surface = new InputSurface({ rl: makeRl(), history: makeHistory() });
      await surface.armCompositor({ promptFn: () => 'afk › ', onCancel: () => {}, stdout, stdin });

      expect(surface.isAwaitingInput()).toBe(false);
      const readPromise = surface.readLine({ promptFn: () => 'afk › ' });
      expect(surface.isAwaitingInput()).toBe(true);

      surface.abortPendingRead();
      await readPromise;
      expect(surface.isAwaitingInput()).toBe(false);

      await surface.dispose();
    });

    it('abortPendingRead() resolves the in-flight read with an empty payload (no keypress)', async () => {
      const stdout = makeMockStdout();
      const stdin = makeMockStdin();
      const surface = new InputSurface({ rl: makeRl(), history: makeHistory() });
      await surface.armCompositor({ promptFn: () => 'afk › ', onCancel: () => {}, stdout, stdin });

      const readPromise = surface.readLine({ promptFn: () => 'afk › ' });
      surface.abortPendingRead();
      const result = await readPromise;

      expect(result).toEqual({ text: '', attachments: [] });
      await surface.dispose();
    });

    it('abortPendingRead() clears onSubmit so a later Enter cannot double-fire, and the NEXT read works normally', async () => {
      const stdout = makeMockStdout();
      const stdin = makeMockStdin();
      const surface = new InputSurface({ rl: makeRl(), history: makeHistory() });
      await surface.armCompositor({ promptFn: () => 'afk › ', onCancel: () => {}, stdout, stdin });

      // Wake-abort the first read.
      const first = surface.readLine({ promptFn: () => 'afk › ' });
      surface.abortPendingRead();
      expect(await first).toEqual({ text: '', attachments: [] });

      // A stray Enter arriving before the next read must be a no-op (onSubmit
      // was cleared by abortPendingRead) — it must not resolve anything.
      stdin.emit('keypress', undefined, { name: 'return' });

      // The next real read wires a fresh handler and resolves with typed text.
      const second = surface.readLine({ promptFn: () => 'afk › ' });
      for (const ch of 'again') stdin.emit('keypress', ch, { name: ch, sequence: ch });
      stdin.emit('keypress', undefined, { name: 'return' });
      expect((await second).text).toBe('again');

      await surface.dispose();
    });

    it('abortPendingRead() is a no-op when no read is in flight', async () => {
      const stdout = makeMockStdout();
      const stdin = makeMockStdin();
      const surface = new InputSurface({ rl: makeRl(), history: makeHistory() });
      await surface.armCompositor({ promptFn: () => 'afk › ', onCancel: () => {}, stdout, stdin });

      // No readLine outstanding — must not throw.
      expect(() => surface.abortPendingRead()).not.toThrow();
      expect(surface.isAwaitingInput()).toBe(false);

      await surface.dispose();
    });

    it('bufferIsEmpty() is true on a fresh idle prompt and false once text is typed', async () => {
      const stdout = makeMockStdout();
      const stdin = makeMockStdin();
      const surface = new InputSurface({ rl: makeRl(), history: makeHistory() });
      await surface.armCompositor({ promptFn: () => 'afk › ', onCancel: () => {}, stdout, stdin });

      const readPromise = surface.readLine({ promptFn: () => 'afk › ' });
      expect(surface.bufferIsEmpty()).toBe(true);

      for (const ch of 'half') stdin.emit('keypress', ch, { name: ch, sequence: ch });
      expect(surface.bufferIsEmpty()).toBe(false);

      // Cleanup: dispose rejects the in-flight read.
      await surface.dispose();
      await expect(readPromise).rejects.toThrow('disposed');
    });

    it('isAwaitingInput() and bufferIsEmpty() are inert on a never-armed (non-TTY) surface', () => {
      const surface = new InputSurface({ rl: makeRl(), history: makeHistory() });
      // No compositor: no wake seam. isAwaitingInput must be false (so the
      // wake path self-gates off) and bufferIsEmpty defaults true.
      expect(surface.isAwaitingInput()).toBe(false);
      expect(surface.bufferIsEmpty()).toBe(true);
      expect(() => surface.abortPendingRead()).not.toThrow();
    });
  });
});
