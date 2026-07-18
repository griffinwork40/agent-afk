/**
 * Tests for TerminalCompositor — keypress + history + buffer + spinner.
 *
 * Split verbatim from the terminal-compositor.test.ts monolith (#369);
 * these were nested describes under the top-level TerminalCompositor suite.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TerminalCompositor } from './terminal-compositor.js';
import { createAutocompleteState } from './input/autocomplete-state.js';
import { register as registerSlashCommand, resetRegistry as resetSlashRegistry } from './slash/registry.js';
import { __resetStdinClaimForTests } from './input/stdin-claim.js';
import { makeMockStdout, makeMockStdin, collectWrites } from './terminal-compositor.test-helpers.js';
import type { MockStdout, MockStdin } from './terminal-compositor.test-helpers.js';

describe('TerminalCompositor — keypress + history + buffer + spinner', () => {
  let stdout: MockStdout;
  let stdin: MockStdin;
  let writes: ReturnType<typeof collectWrites>;

  beforeEach(() => {
    stdout = makeMockStdout();
    stdin = makeMockStdin();
    writes = collectWrites(stdout);
    // Reset the process-wide StdinClaim singleton so each test starts clean.
    __resetStdinClaimForTests();
  });

  describe('keypress handling', () => {
    it('ESC triggers onSoftStop once (not onCancel)', async () => {
      const onCancel = vi.fn();
      const onSoftStop = vi.fn();
      const c = new TerminalCompositor({ stdout, stdin, onCancel, onSoftStop });
      await c.arm();
      stdin.emit('keypress', undefined, { name: 'escape' });
      // ESC routes to onSoftStop, NOT onCancel (Ctrl+C is the onCancel path).
      expect(onSoftStop).toHaveBeenCalledTimes(1);
      expect(onCancel).not.toHaveBeenCalled();
    });

    it('second ESC is a no-op (softStopped once-only guard)', async () => {
      const onSoftStop = vi.fn();
      const c = new TerminalCompositor({ stdout, stdin, onSoftStop });
      await c.arm();
      stdin.emit('keypress', undefined, { name: 'escape' });
      stdin.emit('keypress', undefined, { name: 'escape' });
      // softStopped guard: second ESC is silently ignored.
      expect(onSoftStop).toHaveBeenCalledTimes(1);
    });

    it('ESC leaves a typed-but-unsubmitted buffer as an editable draft (queued stays false)', async () => {
      // ESC does NOT queue a buffer the user only typed (never Entered).
      // The text is preserved — setInputMode no longer de-queues and never
      // clears the buffer — but queued stays false, so the next
      // idle-transition flush does NOT auto-submit it. The user keeps
      // editing and submits with an explicit Enter when ready. (Only an
      // Enter-confirmed buffer auto-submits on ESC — see the idempotent
      // test below and the 'soft-stop drain' block.)
      const onSoftStop = vi.fn();
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSoftStop });
      await c.arm();
      // Type a message mid-stream WITHOUT pressing Enter (queued stays false).
      for (const ch of 'wait') stdin.emit('keypress', ch, { name: ch, sequence: ch });
      expect(c.getBuffer()).toEqual({ text: 'wait', queued: false });
      stdin.emit('keypress', undefined, { name: 'escape' });
      expect(onSoftStop).toHaveBeenCalledTimes(1);
      // Text preserved, but NOT queued — stays a draft for explicit submission.
      expect(c.getBuffer()).toEqual({ text: 'wait', queued: false });
    });

    it('second ESC with a typed-but-unqueued draft is a no-op and does not disturb the draft', async () => {
      // The once-only `softStopped` guard must hold even when a typed draft is
      // present: a second ESC fires neither onSoftStop again nor any queue
      // mutation, and the preserved draft is left exactly as typed.
      const onSoftStop = vi.fn();
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSoftStop });
      await c.arm();
      for (const ch of 'wait') stdin.emit('keypress', ch, { name: ch, sequence: ch });
      stdin.emit('keypress', undefined, { name: 'escape' });
      stdin.emit('keypress', undefined, { name: 'escape' });
      expect(onSoftStop).toHaveBeenCalledTimes(1);
      // Draft untouched across both presses — still typed, still not queued.
      expect(c.getBuffer()).toEqual({ text: 'wait', queued: false });
    });

    it('ESC after Enter leaves the queued message in the FIFO (idempotent soft-stop)', async () => {
      // New contract: Enter commits the buffer to the FIFO and clears the live
      // input. ESC (soft-stop) does NOT drain or drop already-committed messages —
      // the queue survives the soft-stop and drains on the next → idle transition.
      const onSoftStop = vi.fn();
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSoftStop });
      await c.arm();
      // Type + Enter → commits 'hi' to FIFO, live buffer cleared.
      for (const ch of 'hi') stdin.emit('keypress', ch, { name: ch, sequence: ch });
      stdin.emit('keypress', undefined, { name: 'return' });
      expect(c.getBuffer()).toEqual({ text: '', queued: true });
      expect(c.getPendingCount()).toBe(1);
      stdin.emit('keypress', undefined, { name: 'escape' });
      expect(onSoftStop).toHaveBeenCalledTimes(1);
      // Queued message preserved, live buffer still empty.
      expect(c.getBuffer()).toEqual({ text: '', queued: true });
      expect(c.getPendingCount()).toBe(1);
    });

    it('ESC on an empty buffer does not set queued (nothing to submit)', async () => {
      const onSoftStop = vi.fn();
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSoftStop });
      await c.arm();
      stdin.emit('keypress', undefined, { name: 'escape' });
      expect(onSoftStop).toHaveBeenCalledTimes(1);
      expect(c.getBuffer()).toEqual({ text: '', queued: false });
    });

    // ── Usage-limit pause: Enter ends the wait AND queues (B) ──────────────
    //
    // While a turn is parked in a usage-limit pause, the compositor's `paused`
    // flag is set. A submitted line must still queue (so it flushes as the next
    // turn) AND fire onPauseInterrupt (so the turn handler ends the auto-resume
    // wait via session.interrupt). This is the one-gesture escape: type
    // `/model <name>` + Enter during the pause → on the new provider next turn.
    it('Enter during a usage-limit pause fires onPauseInterrupt and still queues the buffer', async () => {
      const onPauseInterrupt = vi.fn();
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onPauseInterrupt });
      await c.arm();
      c.paused = true;
      for (const ch of 'hi') stdin.emit('keypress', ch, { name: ch, sequence: ch });
      stdin.emit('keypress', undefined, { name: 'return' });
      expect(onPauseInterrupt).toHaveBeenCalledTimes(1);
      // Buffer stays queued so the next readLine's idle-flush dispatches it.
      expect(c.getBuffer()).toEqual({ text: '', queued: true });
      c.disarm();
    });

    // Regression guard: when NOT paused, Enter is plain type-ahead — it queues
    // but must NOT fire onPauseInterrupt (else normal mid-stream typing would
    // spuriously interrupt the turn).
    it('Enter when NOT paused does not fire onPauseInterrupt (normal type-ahead queue)', async () => {
      const onPauseInterrupt = vi.fn();
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onPauseInterrupt });
      await c.arm();
      // paused defaults to false.
      for (const ch of 'hi') stdin.emit('keypress', ch, { name: ch, sequence: ch });
      stdin.emit('keypress', undefined, { name: 'return' });
      expect(onPauseInterrupt).not.toHaveBeenCalled();
      expect(c.getBuffer()).toEqual({ text: '', queued: true });
      c.disarm();
    });

    // An empty-buffer Enter during a pause is suppressed (nothing to submit), so
    // it must not fire the pause-interrupt either — a stray Enter shouldn't kill
    // the wait when the user has typed nothing.
    it('Enter on an empty buffer during a pause does not fire onPauseInterrupt', async () => {
      const onPauseInterrupt = vi.fn();
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onPauseInterrupt });
      await c.arm();
      c.paused = true;
      stdin.emit('keypress', undefined, { name: 'return' });
      expect(onPauseInterrupt).not.toHaveBeenCalled();
      expect(c.getBuffer()).toEqual({ text: '', queued: false });
      c.disarm();
    });

    // ── h1 regression: ESC with an open autocomplete dropdown ──────────────
    //
    // Bug: while the agent streamed, ghost-text / slash autocomplete frequently
    // left `dropdownOpen === true`. handleEscape's dropdown-dismiss branch
    // returned EARLY, so the first ESC closed the dropdown but never reached
    // the soft-stop path — the user had to press ESC TWICE to stop the agent
    // ("double-press to cancel"). Fix (input-dispatch.ts): the dropdown-dismiss
    // branch no longer returns; it falls through so a single ESC both closes
    // the dropdown AND fires onSoftStop in streaming mode, while the idle-mode
    // guard on the next line keeps ESC a pure UI-dismissal between turns.
    it('single ESC fires onSoftStop AND dismisses an open dropdown mid-stream (h1)', async () => {
      resetSlashRegistry();
      registerSlashCommand({
        name: '/render-test',
        summary: 'Stub to open the slash dropdown',
        handler: async () => ({ kind: 'noop' as const }),
      });
      try {
        const ac = createAutocompleteState();
        const onSoftStop = vi.fn();
        const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSoftStop, autocompleteState: ac });
        await c.arm();
        c.setInputMode('streaming'); // a turn is live

        // Type '/' → updateAutocomplete opens the slash dropdown (earned via a
        // real keystroke, not mutation) — mirrors ghost-text open mid-stream.
        stdin.emit('keypress', '/', { name: '/', sequence: '/' });
        expect(ac.dropdownOpen).toBe(true);

        // A SINGLE ESC must both dismiss the dropdown AND fire soft-stop —
        // pre-fix this required two presses.
        stdin.emit('keypress', undefined, { name: 'escape' });
        expect(ac.dropdownOpen).toBe(false);
        expect(onSoftStop).toHaveBeenCalledTimes(1);
      } finally {
        resetSlashRegistry();
      }
    });

    it('ESC with an open dropdown stays a pure UI-dismissal in idle mode — no soft-stop (h1)', async () => {
      resetSlashRegistry();
      registerSlashCommand({
        name: '/render-test',
        summary: 'Stub to open the slash dropdown',
        handler: async () => ({ kind: 'noop' as const }),
      });
      try {
        const ac = createAutocompleteState();
        const onSoftStop = vi.fn();
        const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSoftStop, autocompleteState: ac });
        await c.arm();
        c.setInputMode('idle'); // between turns — NOT streaming

        stdin.emit('keypress', '/', { name: '/', sequence: '/' });
        expect(ac.dropdownOpen).toBe(true);

        // ESC dismisses the dropdown, but the idle-mode guard suppresses
        // soft-stop (no live turn to stop). The fall-through must not change this.
        stdin.emit('keypress', undefined, { name: 'escape' });
        expect(ac.dropdownOpen).toBe(false);
        expect(onSoftStop).not.toHaveBeenCalled();
      } finally {
        resetSlashRegistry();
      }
    });

    it('Ctrl+C triggers onCancel', async () => {
      const onCancel = vi.fn();
      const c = new TerminalCompositor({ stdout, stdin, onCancel });
      await c.arm();
      stdin.emit('keypress', undefined, { name: 'c', ctrl: true });
      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it('Ctrl+C does NOT auto-queue a typed-but-unconfirmed buffer (preserved as a draft, parity with ESC)', async () => {
      // Ctrl+C is now a graceful soft-stop (the REPL handleSigint fires the
      // same soft-stop ESC does). Like ESC, it must NOT auto-queue a buffer
      // the user only typed (never Entered): the text stays an editable draft
      // (queued=false) instead of being flung as a turn the user never
      // submitted. onCancel still fires (handleSigint owns stop/exit dispatch).
      const onCancel = vi.fn();
      const c = new TerminalCompositor({ stdout, stdin, onCancel });
      await c.arm();
      for (const ch of 'wait') stdin.emit('keypress', ch, { name: ch, sequence: ch });
      expect(c.getBuffer()).toEqual({ text: 'wait', queued: false });
      stdin.emit('keypress', undefined, { name: 'c', ctrl: true });
      expect(onCancel).toHaveBeenCalledTimes(1);
      // Draft preserved, NOT auto-queued.
      expect(c.getBuffer()).toEqual({ text: 'wait', queued: false });
    });

    it('a second Ctrl+C within one streaming turn is swallowed by the once-only guard', async () => {
      // The compositor fires onCancel once per streaming turn; the SECOND
      // quit-press lands in idle (the turn ends on the soft-stop interrupt),
      // where handleSigint's exit-window check quits. This guard only stops a
      // burst of presses INSIDE one turn from firing onCancel repeatedly.
      const onCancel = vi.fn();
      const c = new TerminalCompositor({ stdout, stdin, onCancel });
      await c.arm();
      stdin.emit('keypress', undefined, { name: 'c', ctrl: true });
      stdin.emit('keypress', undefined, { name: 'c', ctrl: true });
      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    // ── New keybindings (PR 231): Ctrl+L, Ctrl+D, line-relative Home/End ────
    //
    // Dispatch-level coverage for the key ROUTING. The InputCore pure-function
    // contracts (moveLineStart / moveLineEnd / deleteForward) live in
    // input-core.test.ts; these tests drive real keypress events through an
    // armed compositor to prove the keys are wired to those functions.
    it('Ctrl+L clears the viewport (CSI 2J) + repaints, and does NOT wipe scrollback (no CSI 3J)', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      writes.clear(); // isolate the writes produced by Ctrl+L alone
      stdin.emit('keypress', undefined, { name: 'l', ctrl: true });
      const out = writes.all();
      // clearScreen() writes cursor-home + erase-entire-screen before repaint.
      expect(out).toContain('\x1b[H\x1b[2J');
      // Ctrl+L preserves scrollback — unlike /clear it must NOT send CSI 3J.
      expect(out).not.toContain('\x1b[3J');
    });

    it('Ctrl+D on an EMPTY buffer fires onCancel (EOF on an empty line)', async () => {
      const onCancel = vi.fn();
      const c = new TerminalCompositor({ stdout, stdin, onCancel });
      await c.arm();
      stdin.emit('keypress', undefined, { name: 'd', ctrl: true });
      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(c.getBuffer()).toEqual({ text: '', queued: false });
    });

    it('Ctrl+D on a NON-EMPTY buffer forward-deletes one char and does NOT fire onCancel', async () => {
      const onCancel = vi.fn();
      const c = new TerminalCompositor({ stdout, stdin, onCancel });
      await c.arm();
      for (const ch of 'hello') stdin.emit('keypress', ch, { name: ch, sequence: ch });
      stdin.emit('keypress', undefined, { name: 'home' }); // cursor → line start (index 0)
      stdin.emit('keypress', undefined, { name: 'd', ctrl: true }); // forward-delete 'h'
      expect(c.getBuffer()).toEqual({ text: 'ello', queued: false });
      expect(onCancel).not.toHaveBeenCalled();
    });

    it('Home routes to moveLineStart: on line 2 of a multi-line draft it lands at the line start, not buffer start', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      // Build 'first\nsecond' (shift+Enter inserts a soft newline); cursor ends on line 2.
      for (const ch of 'first') stdin.emit('keypress', ch, { name: ch, sequence: ch });
      stdin.emit('keypress', undefined, { name: 'return', shift: true });
      for (const ch of 'second') stdin.emit('keypress', ch, { name: ch, sequence: ch });
      stdin.emit('keypress', undefined, { name: 'home' }); // line-relative → start of "second"
      stdin.emit('keypress', 'z', { name: 'z', sequence: 'z' }); // marker at the cursor
      // Line-relative Home inserts at the start of line 2 → 'first\nzsecond'.
      // Buffer-absolute moveHome would instead have produced 'zfirst\nsecond'.
      expect(c.getBuffer()).toEqual({ text: 'first\nzsecond', queued: false });
    });

    it('End routes to moveLineEnd: on line 1 of a multi-line draft it lands at the line end, not buffer end', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      // Build 'first\nsecond'; cursor ends at index 12 (on line 2).
      for (const ch of 'first') stdin.emit('keypress', ch, { name: ch, sequence: ch });
      stdin.emit('keypress', undefined, { name: 'return', shift: true });
      for (const ch of 'second') stdin.emit('keypress', ch, { name: ch, sequence: ch });
      // Move into the MIDDLE of line 1: Home (→ start of line 2, idx 6) then Left×2 (→ idx 4).
      stdin.emit('keypress', undefined, { name: 'home' });
      stdin.emit('keypress', undefined, { name: 'left' });
      stdin.emit('keypress', undefined, { name: 'left' });
      stdin.emit('keypress', undefined, { name: 'end' }); // line-relative → end of line 1 (idx 5)
      stdin.emit('keypress', 'z', { name: 'z', sequence: 'z' }); // marker at the cursor
      // Line-relative End inserts at the end of line 1 → 'firstz\nsecond'.
      // Buffer-absolute moveEnd would instead have produced 'first\nsecondz'.
      expect(c.getBuffer()).toEqual({ text: 'firstz\nsecond', queued: false });
    });

    it('trailing backslash + Enter inserts a newline instead of submitting (regression: \\+Enter)', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      // Type 'foo\' then press PLAIN Enter. A trailing backslash is the
      // documented soft-newline escape for terminals that don't report
      // shift-state on Enter. Before the fix this branch lived only in
      // reader.ts (the non-TTY/legacy path), never in the compositor's
      // handleEnter — so in the live REPL plain Enter submitted the raw
      // 'foo\' instead of continuing onto a new line.
      for (const ch of 'foo') stdin.emit('keypress', ch, { name: ch, sequence: ch });
      stdin.emit('keypress', '\\', { name: '\\', sequence: '\\' });
      stdin.emit('keypress', undefined, { name: 'return' });
      // The trailing '\' is replaced by '\n'; nothing is submitted or queued.
      expect(c.getBuffer()).toEqual({ text: 'foo\n', queued: false });
    });

    // ── Soft-stop drain (regression: ESC → perpetual input-lag-of-one) ──────
    //
    // Reported bug: after ESC (soft-stop), the user's next typed+Enter'd
    // message appeared to do nothing — "it looks like it sends but no turn
    // starts; I have to send a follow-up for it to respond to the first one,"
    // then lag for the rest of the session.
    //
    // Root cause (two layers, both now fixed):
    //   1. session.interrupt() USED to be deferred to the next stream event,
    //      so the compositor lingered in streaming mode for a network-latency
    //      window after ESC. The soft-stop handler now calls interrupt()
    //      SYNCHRONOUSLY on ESC (turn-handler.ts / run-skill-dispatch-turn.ts),
    //      so the turn settles immediately and that window is closed at the
    //      source rather than merely survived.
    //   2. setInputMode's soft-stop guard USED to DE-QUEUE a buffer queued
    //      during/after ESC — clearing the queued flag and holding the text as
    //      an editable draft that needed a SECOND explicit Enter. That IS the
    //      "looks like it sends but no turn starts" symptom: the user pressed
    //      Enter, saw the echo, but no turn began.
    //
    // Fix (Bug B): the soft-stop guard NO LONGER de-queues. It clears the
    // once-only `softStopped` flag (bounding its lifetime) and falls through,
    // so an Enter-confirmed (queued) buffer AUTO-SUBMITS as the next turn via
    // the widened any→idle flush, exactly like normal mid-turn type-ahead. A
    // buffer the user only TYPED (never Entered) stays queued=false and is
    // preserved as an editable draft — ESC does not auto-queue it (see
    // handleEscape), matching "ESC with nothing queued keeps what I typed in
    // the input field." Safe because the synchronous interrupt (layer 1) closes
    // the window that would otherwise pile queued buffers into a perpetual
    // off-by-one.
    //
    // Each test mirrors the production turn boundary using only the public
    // compositor API:
    //   arm            → setInputMode('idle') then setInputMode('streaming')
    //   dispose        → setInputMode('idle')              [stream-renderer.ts:791]
    //   readLine       → setOnSubmit(h) then setInputMode('idle')  [input-surface.ts:438,448]
    //   next turn arm  → setInputMode('streaming')         [stream-renderer.ts:352]
    describe('soft-stop drain', () => {
      it('auto-flushes a buffer typed+Entered during the interrupt window as the next turn', async () => {
        const onSoftStop = vi.fn();
        const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSoftStop });
        await c.arm();
        c.setInputMode('idle');      // armCompositor initial idle
        c.setInputMode('streaming'); // turn arm

        // ESC with an empty buffer (user just wants to stop the agent).
        stdin.emit('keypress', undefined, { name: 'escape' });
        expect(onSoftStop).toHaveBeenCalledTimes(1);
        expect(c.getBuffer()).toEqual({ text: '', queued: false });

        // Interrupt window: user types a redirect + Enter BEFORE the stream
        // halts and readLine re-arms. onSubmit is null → Enter commits to FIFO
        // and clears the live buffer.
        for (const ch of 'redirect') stdin.emit('keypress', ch, { name: ch, sequence: ch });
        stdin.emit('keypress', undefined, { name: 'return' });
        // New contract: live buffer is cleared; committed payload is in FIFO.
        expect(c.getBuffer()).toEqual({ text: '', queued: true });
        expect(c.getPendingCount()).toBe(1);

        // dispose() flips to idle. The soft-stop guard clears softStopped but
        // PRESERVES the queued FIFO (Bug B: no de-queue). onSubmit is null
        // here, so no flush yet — the FIFO stays for the next readLine.
        c.setInputMode('idle');
        expect(c.getBuffer()).toEqual({ text: '', queued: true });
        expect(c.getPendingCount()).toBe(1);

        // readLine: install handler + setInputMode('idle'). softStopped was
        // cleared at dispose, so the widened any→idle flush AUTO-SUBMITS the
        // queued message as the next turn — no second Enter, no phantom lag.
        const onSubmit = vi.fn();
        c.setOnSubmit(onSubmit);
        c.setInputMode('idle');
        expect(onSubmit).toHaveBeenCalledTimes(1);
        expect(onSubmit).toHaveBeenCalledWith({ text: 'redirect', attachments: [] });
        expect(c.getBuffer()).toEqual({ text: '', queued: false });
      });

      it('breaks the perpetual lag + buffer contamination across consecutive soft-stops', async () => {
        const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSoftStop: vi.fn() });
        await c.arm();
        c.setInputMode('idle');

        const submitTurn = (label: string): ReturnType<typeof vi.fn> => {
          // Turn arm.
          c.setInputMode('streaming');
          // ESC mid-stream, then type a message + Enter during the interrupt window.
          stdin.emit('keypress', undefined, { name: 'escape' });
          for (const ch of label) stdin.emit('keypress', ch, { name: ch, sequence: ch });
          stdin.emit('keypress', undefined, { name: 'return' });
          // dispose → idle: softStopped cleared, queued FIFO PRESERVED (no
          // de-queue). Live buffer was already cleared at Enter-time, so there is
          // no stale text from a prior turn (regression: 'alphabeta' contamination
          // cannot occur because the message was committed, not held in the buffer).
          c.setInputMode('idle');
          expect(c.getBuffer()).toEqual({ text: '', queued: true });
          expect(c.getPendingCount()).toBe(1);
          // readLine: installing the handler + setInputMode('idle') AUTO-SUBMITS
          // this turn's message exactly once — no second Enter, no off-by-one.
          const onSubmit = vi.fn();
          c.setOnSubmit(onSubmit);
          c.setInputMode('idle');
          expect(onSubmit).toHaveBeenCalledTimes(1);
          expect(onSubmit).toHaveBeenCalledWith({ text: label, attachments: [] });
          c.setOnSubmit(null);
          return onSubmit;
        };

        // Three sequential ESC-interrupted turns: each auto-submits its OWN
        // message exactly once — no off-by-one, no accumulated stale text.
        submitTurn('alpha');
        submitTurn('beta');
        submitTurn('gamma');
      });

      it('coalesces MULTIPLE messages Entered during ONE soft-stop window (merged, no backlog)', async () => {
        // The residual regression the Bug-B fix (see block comment above) did NOT
        // cover: it assumed the synchronous interrupt closes the streaming window
        // at the source. For a SUBAGENT turn that assumption fails —
        // cancelActiveForeground() (subagent-executor.ts) resolves the parent
        // await only after the child settles, so the compositor lingers in
        // 'streaming' for seconds. A user who sees no turn start types several
        // messages + Enter; pre-fix each pushed onto the FIFO, which drains ONE
        // per turn → the "it doesn't send, then I keep sending characters to catch
        // up" report. Post-fix, all window messages MERGE into one payload —
        // last-wins (the original #403 shape) silently dropped the earlier
        // messages, which users experienced as "it didn't send" all over again.
        const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSoftStop: vi.fn() });
        await c.arm();
        c.setInputMode('idle');
        c.setInputMode('streaming'); // turn arm

        // ESC once (soft-stop), then THREE messages Entered during the teardown
        // window (softStopped stays true until the post-soft-stop → idle transition).
        stdin.emit('keypress', undefined, { name: 'escape' });
        for (const msg of ['first', 'second', 'third']) {
          for (const ch of msg) stdin.emit('keypress', ch, { name: ch, sequence: ch });
          stdin.emit('keypress', undefined, { name: 'return' });
        }
        // Merged: the FIFO holds ONE payload carrying all three messages,
        // not a backlog of 3 — and not just the last one.
        expect(c.getPendingCount()).toBe(1);
        expect(c.getBuffer()).toEqual({ text: '', queued: true });

        // dispose → idle: softStopped cleared, no drain (onSubmit null).
        c.setInputMode('idle');
        expect(c.getPendingCount()).toBe(1);

        // readLine drains the single merged payload as exactly ONE next turn.
        const onSubmit = vi.fn();
        c.setOnSubmit(onSubmit);
        c.setInputMode('idle');
        expect(onSubmit).toHaveBeenCalledTimes(1);
        expect(onSubmit).toHaveBeenCalledWith({ text: 'first\nsecond\nthird', attachments: [] });
      });

      it('a "." poke after a real post-ESC message does NOT drop the message (merge, not last-wins)', async () => {
        // The exact field signature (v5.25.0 postmortem): during a slow
        // subagent-cancel settle the user types a real instruction + Enter,
        // sees nothing happen, and pokes with "." + Enter to test liveness.
        // Under last-wins the "." REPLACED the instruction — silently lost,
        // user had to retype: "it didn't send" round 2. Under merge, both
        // survive as one turn.
        const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSoftStop: vi.fn() });
        await c.arm();
        c.setInputMode('idle');
        c.setInputMode('streaming'); // turn arm

        stdin.emit('keypress', undefined, { name: 'escape' });
        for (const ch of 'fix the bug') stdin.emit('keypress', ch, { name: ch, sequence: ch });
        stdin.emit('keypress', undefined, { name: 'return' });
        stdin.emit('keypress', '.', { name: '.', sequence: '.' });
        stdin.emit('keypress', undefined, { name: 'return' });

        expect(c.getPendingCount()).toBe(1);
        c.setInputMode('idle'); // dispose → no drain (onSubmit null)

        const onSubmit = vi.fn();
        c.setOnSubmit(onSubmit);
        c.setInputMode('idle');
        expect(onSubmit).toHaveBeenCalledTimes(1);
        expect(onSubmit).toHaveBeenCalledWith({ text: 'fix the bug\n.', attachments: [] });
      });

      it('normal multi-message type-ahead (NO ESC) still accumulates every message (blast-radius guard)', async () => {
        // The merge coalesce fires ONLY under softStopped. Ordinary mid-turn
        // type-ahead must still queue every message for sequential-turn delivery —
        // coalescing here would silently drop queued turns the user intended.
        const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSoftStop: vi.fn() });
        await c.arm();
        c.setInputMode('idle');
        c.setInputMode('streaming'); // turn arm, no ESC → softStopped stays false

        for (const msg of ['one', 'two', 'three']) {
          for (const ch of msg) stdin.emit('keypress', ch, { name: ch, sequence: ch });
          stdin.emit('keypress', undefined, { name: 'return' });
        }
        // All three accumulate — the sequential-turn delivery contract is preserved.
        expect(c.getPendingCount()).toBe(3);
      });

      it('pre-ESC queued message survives a post-ESC Enter (coalesce preserves pre-ESC queue)', async () => {
        // Regression guard for the HIGH review finding: the array-wide
        // `pendingSubmissions = [payload]` reassignment silently dropped any
        // message committed via Enter BEFORE pressing ESC — violating the
        // handleEscape contract ("Already-queued messages: left untouched").
        // The fix leaves pre-ESC payloads as their own FIFO entries (they are
        // never the post-ESC merge target — handleEscape arms the epoch with a
        // null target), so they drain as their own turns while post-ESC
        // type-ahead coalesces into one payload.
        const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSoftStop: vi.fn() });
        await c.arm();
        c.setInputMode('idle');
        c.setInputMode('streaming'); // turn arm

        // 1. Enter "msg1" while streaming (no ESC yet) → push, queue=[msg1].
        for (const ch of 'msg1') stdin.emit('keypress', ch, { name: ch, sequence: ch });
        stdin.emit('keypress', undefined, { name: 'return' });
        expect(c.getPendingCount()).toBe(1);

        // 2. ESC → softStopped=true, post-ESC epoch armed (no merge target yet), queue untouched.
        stdin.emit('keypress', undefined, { name: 'escape' });

        // 3. Enter "msg2" during linger → becomes the epoch merge target, pushed → queue=[msg1, msg2].
        for (const ch of 'msg2') stdin.emit('keypress', ch, { name: ch, sequence: ch });
        stdin.emit('keypress', undefined, { name: 'return' });
        expect(c.getPendingCount()).toBe(2); // pre-ESC msg1 is NOT dropped

        // 4. dispose → idle: softStopped cleared, no drain (onSubmit null).
        c.setInputMode('idle');
        expect(c.getPendingCount()).toBe(2);

        // 5. readLine drains the FIFO oldest-first: msg1 as the first turn, msg2 as the second.
        const onSubmit = vi.fn();
        c.setOnSubmit(onSubmit);
        c.setInputMode('idle'); // drain #1 → msg1
        expect(onSubmit).toHaveBeenCalledTimes(1);
        expect(onSubmit).toHaveBeenCalledWith({ text: 'msg1', attachments: [] });
        c.setInputMode('idle'); // drain #2 → msg2
        expect(onSubmit).toHaveBeenCalledTimes(2);
        expect(onSubmit).toHaveBeenNthCalledWith(2, { text: 'msg2', attachments: [] });
      });

      it('pre-ESC queued message survives MULTIPLE post-ESC Enters (coalesce replaces only post-ESC entries)', async () => {
        // Same contract as above, but with several post-ESC Enters: the pre-ESC
        // payload must survive while the post-ESC ones coalesce into one merged payload.
        const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSoftStop: vi.fn() });
        await c.arm();
        c.setInputMode('idle');
        c.setInputMode('streaming'); // turn arm

        for (const ch of 'pre') stdin.emit('keypress', ch, { name: ch, sequence: ch });
        stdin.emit('keypress', undefined, { name: 'return' });
        expect(c.getPendingCount()).toBe(1);

        stdin.emit('keypress', undefined, { name: 'escape' });

        for (const msg of ['post1', 'post2', 'post3']) {
          for (const ch of msg) stdin.emit('keypress', ch, { name: ch, sequence: ch });
          stdin.emit('keypress', undefined, { name: 'return' });
        }
        // pre-ESC "pre" survives (never the merge target); three post-ESC Enters
        // coalesce into ONE merged payload → total queue = 2, NOT 1 (pre not dropped) and NOT 4.
        expect(c.getPendingCount()).toBe(2);

        c.setInputMode('idle'); // dispose → no drain (onSubmit null)

        const onSubmit = vi.fn();
        c.setOnSubmit(onSubmit);
        c.setInputMode('idle'); // drain #1 → "pre"
        expect(onSubmit).toHaveBeenCalledWith({ text: 'pre', attachments: [] });
        c.setInputMode('idle'); // drain #2 → merged post-ESC intent (nothing dropped)
        expect(onSubmit).toHaveBeenNthCalledWith(2, { text: 'post1\npost2\npost3', attachments: [] });
      });

      it('still auto-flushes normal mid-turn type-ahead (NO ESC) — no regression', async () => {
        const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSoftStop: vi.fn() });
        await c.arm();
        c.setInputMode('idle');
        c.setInputMode('streaming'); // turn arm (softStopped stays false — no ESC)

        // User types ahead mid-stream + Enter → commits to FIFO, live buffer cleared.
        for (const ch of 'ahead') stdin.emit('keypress', ch, { name: ch, sequence: ch });
        stdin.emit('keypress', undefined, { name: 'return' });
        // New contract: live buffer cleared; 'ahead' is in the FIFO.
        expect(c.getBuffer()).toEqual({ text: '', queued: true });
        expect(c.getPendingCount()).toBe(1);

        // dispose → idle: onSubmit null, softStopped false → FIFO stays.
        c.setInputMode('idle');
        expect(c.getBuffer()).toEqual({ text: '', queued: true });
        expect(c.getPendingCount()).toBe(1);

        // readLine: the widened flush auto-submits the type-ahead (the
        // intentional feature the drain guard must NOT suppress when there was
        // no ESC).
        const onSubmit = vi.fn();
        c.setOnSubmit(onSubmit);
        c.setInputMode('idle');
        expect(onSubmit).toHaveBeenCalledTimes(1);
        expect(onSubmit).toHaveBeenCalledWith({ text: 'ahead', attachments: [] });
      });

      it('keeps a typed-but-unconfirmed (no Enter) interrupt-window buffer editable in idle', async () => {
        // A buffer typed during the interrupt window but NOT Entered stays
        // queued=false, so it is preserved as an editable idle draft; the user
        // can keep editing and the eventual submission is the EDITED text. Only
        // a typed+Entered buffer auto-submits — see above.
        const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSoftStop: vi.fn() });
        await c.arm();
        c.setInputMode('idle');
        c.setInputMode('streaming');

        // ESC (empty buffer), then a partial message WITHOUT Enter.
        stdin.emit('keypress', undefined, { name: 'escape' });
        for (const ch of 'redirec') stdin.emit('keypress', ch, { name: ch, sequence: ch });
        c.setInputMode('idle'); // dispose → softStopped cleared; queued stays false
        expect(c.getBuffer()).toEqual({ text: 'redirec', queued: false });

        // readLine: handler installed, no auto-fire.
        const onSubmit = vi.fn();
        c.setOnSubmit(onSubmit);
        c.setInputMode('idle');
        expect(onSubmit).not.toHaveBeenCalled();

        // User finishes editing the preserved draft in idle.
        for (const ch of 't more') stdin.emit('keypress', ch, { name: ch, sequence: ch });
        expect(c.getBuffer()).toEqual({ text: 'redirect more', queued: false });

        // Explicit Enter submits the EDITED text, exactly once.
        stdin.emit('keypress', undefined, { name: 'return' });
        expect(onSubmit).toHaveBeenCalledTimes(1);
        expect(onSubmit).toHaveBeenCalledWith({ text: 'redirect more', attachments: [] });
      });

      it('keeps a pre-ESC typed draft (no Enter) editable in idle — does NOT auto-submit', async () => {
        // Symmetric to the typed-AFTER-ESC case above: a buffer the user typed
        // BEFORE pressing ESC, without Enter, is also preserved as an editable
        // draft (queued=false). ESC no longer auto-queues it, so it waits for an
        // explicit Enter instead of being flung as an unconfirmed turn. This is
        // the "ESC with nothing queued leaves what I typed in the input" case.
        const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSoftStop: vi.fn() });
        await c.arm();
        c.setInputMode('idle');
        c.setInputMode('streaming');

        // Type a draft WITHOUT Enter, then ESC. handleEscape does NOT queue it.
        for (const ch of 'wait') stdin.emit('keypress', ch, { name: ch, sequence: ch });
        stdin.emit('keypress', undefined, { name: 'escape' });
        expect(c.getBuffer()).toEqual({ text: 'wait', queued: false });

        // dispose → idle: softStopped cleared, buffer preserved, still not queued.
        c.setInputMode('idle');
        expect(c.getBuffer()).toEqual({ text: 'wait', queued: false });

        // readLine: handler installed — NO auto-fire (queued is false).
        const onSubmit = vi.fn();
        c.setOnSubmit(onSubmit);
        c.setInputMode('idle');
        expect(onSubmit).not.toHaveBeenCalled();
        expect(c.getBuffer()).toEqual({ text: 'wait', queued: false });

        // Explicit Enter submits the preserved draft, exactly once.
        stdin.emit('keypress', undefined, { name: 'return' });
        expect(onSubmit).toHaveBeenCalledTimes(1);
        expect(onSubmit).toHaveBeenCalledWith({ text: 'wait', attachments: [] });
      });

      it('flushes a message typed in the idle window AFTER an empty-buffer ESC (no dropped message)', async () => {
        // Regression (user report): "ESC to stop, then my next message looks
        // like it sends but no turn starts — I have to send a follow-up for it
        // to respond to the first one." Root cause: an EMPTY-buffer ESC sets
        // softStopped=true with queued=false, so the old `softStopped &&
        // queued` drain guard never fired at dispose and softStopped persisted
        // into the idle period; the next message — queued in the brief
        // inter-readLine window before onSubmit is installed — then hit the
        // guard at readLine→idle and was silently DE-QUEUED. The fix clears
        // softStopped at the first →idle transition, so idle-window
        // submissions flush normally. Pre-fix this asserts 0 onSubmit calls;
        // post-fix it asserts exactly 1.
        const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSoftStop: vi.fn() });
        await c.arm();
        c.setInputMode('idle');      // armCompositor initial idle
        c.setInputMode('streaming'); // turn arm

        // ESC with an EMPTY buffer — the common "just stop the agent" case.
        stdin.emit('keypress', undefined, { name: 'escape' });
        expect(c.getBuffer()).toEqual({ text: '', queued: false });

        // dispose → idle: the drain guard fires on softStopped alone and
        // clears it (buffer empty — nothing to preserve).
        c.setInputMode('idle');
        expect(c.getBuffer()).toEqual({ text: '', queued: false });

        // Inter-readLine window: the user types their next message + Enter
        // BEFORE readLine installs onSubmit. Enter commits to FIFO and clears
        // the live buffer (queued=true, not yet fired).
        for (const ch of 'next') stdin.emit('keypress', ch, { name: ch, sequence: ch });
        stdin.emit('keypress', undefined, { name: 'return' });
        // New contract: live buffer cleared; 'next' is in the FIFO.
        expect(c.getBuffer()).toEqual({ text: '', queued: true });
        expect(c.getPendingCount()).toBe(1);

        // readLine: install handler + setInputMode('idle'). softStopped is
        // already cleared, so the widened any→idle flush fires onSubmit — the
        // message is NOT silently dropped (pre-fix: softStopped persisted and
        // de-queued it here, requiring a second send).
        const onSubmit = vi.fn();
        c.setOnSubmit(onSubmit);
        c.setInputMode('idle');
        expect(onSubmit).toHaveBeenCalledTimes(1);
        expect(onSubmit).toHaveBeenCalledWith({ text: 'next', attachments: [] });
        expect(c.getBuffer()).toEqual({ text: '', queued: false });
      });

      it('post-ESC poke typed AFTER the teardown → idle still MERGES into the redirect (no stranded turn)', async () => {
        // The residual #81/#403/#467 missed (the lone-"." field report): softStopped
        // clears at the first → idle, but the user is still WAITING for the redirect
        // to run. A poke ("." to test liveness) typed after that boundary used to push
        // a SEPARATE payload → a one-drain-per-turn backlog → the lone-"." turns. The
        // post-ESC coalesce EPOCH persists until the redirect actually drains, so the
        // poke merges in. Pre-fix: getPendingCount() === 2 here; post-fix: 1.
        const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSoftStop: vi.fn() });
        await c.arm();
        c.setInputMode('idle');
        c.setInputMode('streaming'); // turn arm

        // ESC + a real redirect during the interrupt window (softStopped true).
        stdin.emit('keypress', undefined, { name: 'escape' });
        for (const ch of 'redirect') stdin.emit('keypress', ch, { name: ch, sequence: ch });
        stdin.emit('keypress', undefined, { name: 'return' });
        expect(c.getPendingCount()).toBe(1);

        // Teardown completes: dispose → idle CLEARS softStopped (existing contract).
        c.setInputMode('idle');

        // The redirect has NOT drained yet (onSubmit null). softStopped is now false —
        // a poke typed here previously stranded as a 2nd payload (one turn behind).
        stdin.emit('keypress', '.', { name: '.', sequence: '.' });
        stdin.emit('keypress', undefined, { name: 'return' });
        // FIXED: the poke merges into the still-pending redirect → ONE payload.
        expect(c.getPendingCount()).toBe(1);

        const onSubmit = vi.fn();
        c.setOnSubmit(onSubmit);
        c.setInputMode('idle');
        expect(onSubmit).toHaveBeenCalledTimes(1);
        expect(onSubmit).toHaveBeenCalledWith({ text: 'redirect\n.', attachments: [] });
      });

      it('post-ESC epoch ENDS when the redirect drains — later type-ahead is sequential again (no leak)', async () => {
        // The epoch must not leak past the redirect. Once the coalesced payload
        // drains to a running turn, subsequent mid-turn type-ahead accumulates one
        // payload per message again (normal sequential delivery) — NOT folded into
        // the already-running redirect.
        const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSoftStop: vi.fn() });
        await c.arm();
        c.setInputMode('idle');
        c.setInputMode('streaming'); // turn arm

        stdin.emit('keypress', undefined, { name: 'escape' });
        for (const ch of 'redirect') stdin.emit('keypress', ch, { name: ch, sequence: ch });
        stdin.emit('keypress', undefined, { name: 'return' });

        // Drain the redirect → it runs as a turn (idle→streaming), ending the epoch.
        const onSubmit = vi.fn();
        c.setOnSubmit(onSubmit);
        c.setInputMode('idle'); // drain redirect
        expect(onSubmit).toHaveBeenNthCalledWith(1, { text: 'redirect', attachments: [] });
        c.setInputMode('streaming'); // the redirect's turn starts

        // Two fresh mid-turn messages (no new ESC) must accumulate as TWO payloads.
        for (const msg of ['one', 'two']) {
          for (const ch of msg) stdin.emit('keypress', ch, { name: ch, sequence: ch });
          stdin.emit('keypress', undefined, { name: 'return' });
        }
        expect(c.getPendingCount()).toBe(2); // sequential — not coalesced into one
      });

      it('↑-recall of the post-ESC merge target does NOT resurrect stale text on re-send', async () => {
        // Regression guard (P2/medium review finding on PR #644): popping a
        // payload off pendingSubmissions for ↑-recall left postEscPayload
        // pointing at it. Without the fix, the re-Enter below hits the merge
        // branch's `idx < 0` defensive path (the popped payload is no longer
        // in the queue) and resurrects the stale pre-edit text, submitting
        // "redirect\nredirectX" instead of just the edited "redirectX".
        const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSoftStop: vi.fn() });
        await c.arm();
        c.setInputMode('idle');
        c.setInputMode('streaming'); // turn arm

        stdin.emit('keypress', undefined, { name: 'escape' });
        for (const ch of 'redirect') stdin.emit('keypress', ch, { name: ch, sequence: ch });
        stdin.emit('keypress', undefined, { name: 'return' });
        expect(c.getPendingCount()).toBe(1);

        // ↑ recalls the just-committed payload (also the epoch's merge target)
        // back into the live buffer for editing; the FIFO empties.
        stdin.emit('keypress', undefined, { name: 'up' });
        expect(c.getBuffer().text).toBe('redirect');
        expect(c.getPendingCount()).toBe(0);

        // Edit the recalled draft (grow the buffer — the exact suffix doesn't
        // matter, only that the re-sent text differs from the popped one).
        stdin.emit('keypress', 'X', { name: 'X', sequence: 'X' });

        // Re-Enter: still inside the post-ESC epoch (postEscCoalesce stays
        // armed). Fixed behavior: postEscPayload was cleared on pop above, so
        // this becomes a fresh single entry — NOT a merge with the stale text.
        stdin.emit('keypress', undefined, { name: 'return' });
        expect(c.getPendingCount()).toBe(1);

        const onSubmit = vi.fn();
        c.setOnSubmit(onSubmit);
        c.setInputMode('idle');
        expect(onSubmit).toHaveBeenCalledTimes(1);
        expect(onSubmit).toHaveBeenCalledWith({ text: 'redirectX', attachments: [] });
      });
    });

    it('printable chars grow buffer', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      stdin.emit('keypress', 'h', { name: 'h', sequence: 'h' });
      stdin.emit('keypress', 'i', { name: 'i', sequence: 'i' });
      expect(c.getBuffer().text).toBe('hi');
    });

    it('printable emoji (multi-UTF-16-unit graphemes) are inserted, not dropped', async () => {
      // Regression: the printable filter used `char.length === 1`, a UTF-16
      // code-UNIT count — it silently dropped surrogate-pair emoji
      // ('😀'.length === 2) and variation-selector / skin-tone emoji
      // ('❤️', '👍🏽'). Each is a single printable grapheme and must insert.
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      stdin.emit('keypress', '😀', { sequence: '😀' });
      stdin.emit('keypress', '❤️', { sequence: '❤️' });
      expect(c.getBuffer().text).toBe('😀❤️');
      c.disarm();
    });

    it('backspace shrinks buffer', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      stdin.emit('keypress', 'h', { name: 'h', sequence: 'h' });
      stdin.emit('keypress', 'i', { name: 'i', sequence: 'i' });
      stdin.emit('keypress', undefined, { name: 'backspace' });
      expect(c.getBuffer().text).toBe('h');
    });

    it('Enter sets queued=true when buffer is non-empty', async () => {
      // New contract: Enter COMMITS the buffer to the FIFO and CLEARS the live
      // input. The message is in getPendingCount(), not getBuffer().text.
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      stdin.emit('keypress', 'h', { name: 'h', sequence: 'h' });
      stdin.emit('keypress', undefined, { name: 'return' });
      expect(c.getBuffer()).toEqual({ text: '', queued: true });
      expect(c.getPendingCount()).toBe(1);
    });

    it('Enter on empty buffer does not set queued', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      stdin.emit('keypress', undefined, { name: 'return' });
      expect(c.getBuffer()).toEqual({ text: '', queued: false });
    });

    it('Backspace after Enter does NOT unqueue (queue is edited via ↑, not Backspace)', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      stdin.emit('keypress', 'h', { name: 'h', sequence: 'h' });
      stdin.emit('keypress', undefined, { name: 'return' }); // commits 'h', live buffer → ''
      expect(c.getBuffer().queued).toBe(true);
      expect(c.getPendingCount()).toBe(1);
      stdin.emit('keypress', undefined, { name: 'backspace' }); // empty buffer → no-op on the queue
      expect(c.getBuffer()).toEqual({ text: '', queued: true });
      expect(c.getPendingCount()).toBe(1);
    });

    it('typing after queue leaves the committed message queued and grows the live buffer', async () => {
      // New contract: the live buffer is independent of pendingSubmissions.
      // Editing the in-progress buffer does NOT pop or clear committed messages.
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      stdin.emit('keypress', 'h', { name: 'h', sequence: 'h' });
      stdin.emit('keypress', undefined, { name: 'return' }); // commits 'h', clears live buffer
      expect(c.getBuffer()).toEqual({ text: '', queued: true });
      expect(c.getPendingCount()).toBe(1);
      stdin.emit('keypress', 'i', { name: 'i', sequence: 'i' }); // next message draft
      // The committed 'h' is still in the queue; live buffer now has 'i'.
      expect(c.getBuffer()).toEqual({ text: 'i', queued: true });
      expect(c.getPendingCount()).toBe(1);
    });

    it('Enter on empty live buffer while already queued is a no-op (no double-queue)', async () => {
      // After first Enter: buffer cleared → ''. Second Enter on empty buffer
      // hits the early-return guard (empty text + no attachments) — does NOT
      // push an empty payload, so pendingCount stays 1.
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      stdin.emit('keypress', 'h', { name: 'h', sequence: 'h' });
      stdin.emit('keypress', 'i', { name: 'i', sequence: 'i' });
      stdin.emit('keypress', undefined, { name: 'return' }); // commits 'hi', clears live buffer
      expect(c.getBuffer()).toEqual({ text: '', queued: true });
      expect(c.getPendingCount()).toBe(1);
      stdin.emit('keypress', undefined, { name: 'return' }); // empty buffer → no-op
      expect(c.getBuffer()).toEqual({ text: '', queued: true });
      expect(c.getPendingCount()).toBe(1);
    });

    it('cursor editing in the live buffer after a commit does not affect the queue', async () => {
      // After committing 'abc', the live buffer is empty. Type 'XY', move
      // left, insert 'Z' mid-buffer. Queue stays at 1 throughout — live-buffer
      // edits are completely decoupled from pendingSubmissions.
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      stdin.emit('keypress', 'a', { name: 'a', sequence: 'a' });
      stdin.emit('keypress', 'b', { name: 'b', sequence: 'b' });
      stdin.emit('keypress', 'c', { name: 'c', sequence: 'c' });
      stdin.emit('keypress', undefined, { name: 'return' }); // commits 'abc', live buffer → ''
      expect(c.getPendingCount()).toBe(1);
      // Type new content into the cleared live buffer.
      stdin.emit('keypress', 'X', { name: 'X', sequence: 'X' });
      stdin.emit('keypress', 'Y', { name: 'Y', sequence: 'Y' });
      stdin.emit('keypress', undefined, { name: 'left' }); // cursor before 'Y'
      stdin.emit('keypress', 'Z', { name: 'Z', sequence: 'Z' }); // insert mid-buffer
      // Live buffer edited; committed 'abc' is still queued untouched.
      expect(c.getBuffer()).toEqual({ text: 'XZY', queued: true });
      expect(c.getPendingCount()).toBe(1);
    });

    it('backspace inside the live buffer does not pop the queue', async () => {
      // After committing 'abc', type 'xy' in the live buffer then backspace
      // 'y'. The queued 'abc' is untouched — backspace only pops the queue
      // when the LIVE buffer is empty (cursor at 0, nothing to delete).
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      stdin.emit('keypress', 'a', { name: 'a', sequence: 'a' });
      stdin.emit('keypress', 'b', { name: 'b', sequence: 'b' });
      stdin.emit('keypress', 'c', { name: 'c', sequence: 'c' });
      stdin.emit('keypress', undefined, { name: 'return' }); // commits 'abc', live buffer → ''
      stdin.emit('keypress', 'x', { name: 'x', sequence: 'x' });
      stdin.emit('keypress', 'y', { name: 'y', sequence: 'y' });
      stdin.emit('keypress', undefined, { name: 'backspace' }); // deletes 'y' from live buffer
      // Live buffer = 'x'; committed 'abc' still pending.
      expect(c.getBuffer()).toEqual({ text: 'x', queued: true });
      expect(c.getPendingCount()).toBe(1);
    });

    it('Backspace on empty live buffer does NOT dequeue (queue is edited via ↑, not deleted)', async () => {
      // Contract: Backspace never touches pendingSubmissions. With the buffer
      // empty and 1 message queued, Backspace is a no-op on the queue — the
      // committed message is recalled for editing with ↑, never discarded by
      // Backspace (which previously popped it and silently lost the text).
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      stdin.emit('keypress', 'a', { name: 'a', sequence: 'a' });
      stdin.emit('keypress', 'b', { name: 'b', sequence: 'b' });
      stdin.emit('keypress', 'c', { name: 'c', sequence: 'c' });
      stdin.emit('keypress', undefined, { name: 'return' }); // commits 'abc', live buffer → ''
      expect(c.getBuffer()).toEqual({ text: '', queued: true });
      expect(c.getPendingCount()).toBe(1);
      stdin.emit('keypress', undefined, { name: 'backspace' }); // empty live buffer → no-op on queue
      expect(c.getBuffer()).toEqual({ text: '', queued: true });
      expect(c.getPendingCount()).toBe(1);
    });

    it('arrow keys do not trigger cancel', async () => {
      const onCancel = vi.fn();
      const c = new TerminalCompositor({ stdout, stdin, onCancel });
      await c.arm();
      stdin.emit('keypress', undefined, { name: 'left' });
      stdin.emit('keypress', undefined, { name: 'right' });
      stdin.emit('keypress', undefined, { name: 'up' });
      stdin.emit('keypress', undefined, { name: 'down' });
      expect(onCancel).not.toHaveBeenCalled();
    });

    it('left/right move cursor within buffer', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      stdin.emit('keypress', 'a', { name: 'a', sequence: 'a' });
      stdin.emit('keypress', 'b', { name: 'b', sequence: 'b' });
      stdin.emit('keypress', 'c', { name: 'c', sequence: 'c' });
      // cursor at 3. Move left once -> insert 'X' -> buffer is "abXc"
      stdin.emit('keypress', undefined, { name: 'left' });
      stdin.emit('keypress', 'X', { name: 'X', sequence: 'X' });
      expect(c.getBuffer().text).toBe('abXc');
    });

    it('Ctrl+B fires onBackground callback exactly once', async () => {
      const onBackground = vi.fn();
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onBackground });
      await c.arm();
      stdin.emit('keypress', undefined, { name: 'b', ctrl: true });
      expect(onBackground).toHaveBeenCalledTimes(1);
      stdin.emit('keypress', undefined, { name: 'b', ctrl: true });
      expect(onBackground).toHaveBeenCalledTimes(1);
    });

    it('Ctrl+B without onBackground does not throw', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      stdin.emit('keypress', undefined, { name: 'b', ctrl: true });
      expect(c.getBuffer().text).toBe('');
    });

    it('ignores ctrl/meta modifiers that are not cancel-combos', async () => {
      const onCancel = vi.fn();
      const c = new TerminalCompositor({ stdout, stdin, onCancel });
      await c.arm();
      // Use ctrl+y / meta+z — neither is bound by the compositor, so they
      // exercise the catch-all swallow. (Avoid ctrl+a here: ctrl+a now
      // moves the cursor to line-start as part of readline-parity word/line
      // nav. On an empty buffer that's still a no-op, but the test's intent
      // is "unbound modifier combos are silently dropped", which ctrl+a is
      // no longer an example of.)
      stdin.emit('keypress', undefined, { name: 'y', ctrl: true });
      stdin.emit('keypress', undefined, { name: 'z', meta: true });
      expect(c.getBuffer().text).toBe('');
      expect(onCancel).not.toHaveBeenCalled();
    });

    it('falls back to key.sequence for printable input when char is absent', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      stdin.emit('keypress', undefined, { name: 'x', sequence: 'x' });
      expect(c.getBuffer()).toEqual({ text: 'x', queued: false });
    });
  });

  describe('history navigation', () => {
    function makeHistory(entries: string[]): {
      back(draft: string): string | null;
      forward(): string | null;
      resetRecall(): void;
      readonly inRecall: boolean;
    } {
      let idx = entries.length;
      let recalling = false;
      return {
        back(_draft: string) {
          if (idx === 0) return null;
          idx--;
          recalling = true;
          return entries[idx] ?? null;
        },
        forward() {
          if (idx >= entries.length - 1) {
            idx = entries.length;
            recalling = false;
            return '';
          }
          idx++;
          return entries[idx] ?? null;
        },
        resetRecall() {
          idx = entries.length;
          recalling = false;
        },
        get inRecall() {
          return recalling;
        },
      };
    }

    it('↑ on an empty buffer pulls the newest queued message for editing (queue takes priority over history)', async () => {
      // Contract: when messages are queued and the live buffer is empty, ↑
      // recalls the most-recently-committed message (LIFO) for editing — NOT
      // history. The pulled message leaves the FIFO and becomes an editable
      // draft (re-Enter re-commits it). History recall only applies once the
      // queue is empty (see the next test).
      const history = makeHistory(['previous-message']);
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), history });
      await c.arm();
      stdin.emit('keypress', 'h', { name: 'h', sequence: 'h' });
      stdin.emit('keypress', undefined, { name: 'return' }); // commits 'h', live buffer → ''
      expect(c.getBuffer()).toEqual({ text: '', queued: true });
      expect(c.getPendingCount()).toBe(1);
      stdin.emit('keypress', undefined, { name: 'up' }); // pulls queued 'h' back (NOT 'previous-message')
      // Live buffer now holds the recalled queued message; the FIFO is empty.
      expect(c.getBuffer()).toEqual({ text: 'h', queued: false });
      expect(c.getPendingCount()).toBe(0);
    });

    it('↑/↓ recall history when no messages are queued (queue-empty fall-through)', async () => {
      // With an empty FIFO, ↑/↓ behave as pure history navigation on the live
      // buffer — the queued-message pull is gated on a non-empty queue, so it
      // never intercepts here.
      const history = makeHistory(['older', 'newer']);
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), history });
      await c.arm();
      expect(c.getPendingCount()).toBe(0);
      stdin.emit('keypress', undefined, { name: 'up' });  // recalls 'newer'
      expect(c.getBuffer().text).toBe('newer');
      stdin.emit('keypress', undefined, { name: 'up' });  // recalls 'older'
      expect(c.getBuffer().text).toBe('older');
      stdin.emit('keypress', undefined, { name: 'down' }); // advances back to 'newer'
      expect(c.getBuffer().text).toBe('newer');
      expect(c.getPendingCount()).toBe(0);
    });
  });

  describe('getBuffer semantics', () => {
    it('initial state is empty and unqueued', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      expect(c.getBuffer()).toEqual({ text: '', queued: false });
    });

    it('disarm resets buffer state', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      stdin.emit('keypress', 'a', { name: 'a', sequence: 'a' });
      c.disarm();
      expect(c.getBuffer()).toEqual({ text: '', queued: false });
    });
  });

  describe('setSpinner', () => {
    // Match any frame from the dots Braille set (must stay in sync with
    // SPINNER_FRAMES in src/cli/terminal-compositor.ts).
    const BRAILLE_FRAME_RE = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;

    it('enabled: true renders a Braille frame in the next paint', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      writes.clear();
      c.setSpinner({ enabled: true });
      expect(writes.all()).toMatch(BRAILLE_FRAME_RE);
    });

    it('enabled: false clears the spinner from the next paint', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      c.setSpinner({ enabled: true });
      writes.clear();
      c.setSpinner({ enabled: false });
      expect(writes.all()).not.toMatch(BRAILLE_FRAME_RE);
    });

    it('enabled: true twice does not start a second interval', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      const setIntervalSpy = vi.spyOn(global, 'setInterval');
      c.setSpinner({ enabled: true });
      c.setSpinner({ enabled: true });
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      setIntervalSpy.mockRestore();
    });

    it('enabled: false is idempotent when no spinner is active', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      expect(() => c.setSpinner({ enabled: false })).not.toThrow();
    });

    it('disarm clears the spinner interval', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      c.setSpinner({ enabled: true });
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
      c.disarm();
      expect(clearIntervalSpy).toHaveBeenCalled();
      clearIntervalSpy.mockRestore();
    });

    it('non-TTY stdout makes setSpinner a no-op', async () => {
      const nonTty = makeMockStdout(false);
      const nonTtyWrites = collectWrites(nonTty);
      const c = new TerminalCompositor({ stdout: nonTty, stdin, onCancel: vi.fn() });
      await c.arm();
      c.setSpinner({ enabled: true });
      expect(nonTtyWrites.all()).not.toMatch(BRAILLE_FRAME_RE);
    });

    // ─── capture-mode regression (audit RC-1: spinner-driven repaint storms) ───

    it('captureMode=true: setSpinner enable does NOT start the interval ticker', async () => {
      // Regression for audit RC-1: in a captured stream (`script(1)`,
      // `asciinema`, AFK_DEMO_CLEAN=1) the spinner's 80ms log-update tick
      // would record 12.5 redundant overlay frames per second. The
      // capture-mode guard in setSpinner short-circuits the enable path
      // before the setInterval call.
      const setIntervalSpy = vi.spyOn(global, 'setInterval');
      const c = new TerminalCompositor({
        stdout, stdin, onCancel: vi.fn(), captureMode: true,
      });
      await c.arm();
      const beforeCount = setIntervalSpy.mock.calls.length;
      c.setSpinner({ enabled: true });
      // Zero new setInterval registrations from the spinner-enable path.
      // (Other intervals — e.g. internal heartbeat — may exist, so we
      // compare deltas rather than total counts.)
      expect(setIntervalSpy.mock.calls.length).toBe(beforeCount);
      setIntervalSpy.mockRestore();
    });

    it('captureMode=true: spinner frame does NOT render on enable', async () => {
      // Direct user-visible assertion: the artifact contains no Braille
      // spinner glyphs at all when capture-mode is on. The text overlay
      // still renders on transitions (committed scrollback, tool-lane
      // updates) — only the spinner ticker is suppressed.
      const c = new TerminalCompositor({
        stdout, stdin, onCancel: vi.fn(), captureMode: true,
      });
      await c.arm();
      writes.clear();
      c.setSpinner({ enabled: true });
      expect(writes.all()).not.toMatch(BRAILLE_FRAME_RE);
    });

    it('captureMode=true: setSpinner({enabled: false}) is still safe (disable path runs unconditionally)', async () => {
      // The disable path runs even in capture-mode so a previously-started
      // spinner can be torn down. This is defensive — capture-mode is set
      // at construction time today, but the disable path stays robust to
      // future enable/disable wiring that could otherwise strand an
      // orphaned interval.
      const c = new TerminalCompositor({
        stdout, stdin, onCancel: vi.fn(), captureMode: true,
      });
      await c.arm();
      expect(() => c.setSpinner({ enabled: false })).not.toThrow();
    });

    it('captureMode=false (default): spinner ticker behavior is unchanged', async () => {
      // Live-TTY regression guard: omitting captureMode (or passing false)
      // preserves the existing spinner-renders-Braille behavior. This
      // exists to fail loudly if someone accidentally flips the default
      // or wires capture-mode to a broader condition that captures live
      // sessions.
      const c = new TerminalCompositor({
        stdout, stdin, onCancel: vi.fn(), captureMode: false,
      });
      await c.arm();
      writes.clear();
      c.setSpinner({ enabled: true });
      expect(writes.all()).toMatch(BRAILLE_FRAME_RE);
    });
  });

  // ─── suspend/resume invariant (regression: ask_question repaint clobbering) ───
  //
  // While suspended (external readline owning stdin), repaint() MUST short-
  // circuit so the spinner ticker doesn't overwrite the elicitation prompt
  // and the user's typed input. See terminal-compositor.ts repaint() guard.
});
