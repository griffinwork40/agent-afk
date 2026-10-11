import { emitKeypressEvents, type Interface } from 'readline';
import { CPR_REPLY_RE as _CPR_REPLY_RE } from './cpr-reply-re.js';
import { env } from '../../config/env.js';

/**
 * Sets `escapeCodeTimeout` to 50ms (see {@link LONE_ESC_TIMEOUT_MS}) for
 * `readline.emitKeypressEvents`, so a lone ESC fires on the FIRST press
 * without misreading split escape sequences. 50ms is the ONLY value AFK ships;
 * the 500ms mentioned below is Node's DEFAULT, which this module overrides.
 *
 * History: ESC is the soft-stop / cancel affordance across AFK's TTY surfaces
 * (compositor stream-stop, reader, elicitation prompts). Node's readline
 * buffers a chunk-trailing `\x1b` for `escapeCodeTimeout` — whose default is
 * 500ms (the GNU readline keyseq-timeout) — to disambiguate a lone ESC from
 * the start of an escape sequence (arrows, alt-keys): the `escape` keypress
 * fires only after that timeout OR when the next key arrives. Under Node's
 * 500ms default ESC "needs two presses" (the second press flushes the first
 * buffered ESC); overriding it to 50ms below is what makes a single ESC
 * register.
 *
 * Why a small NONZERO timeout (not 0): the disambiguation window only needs
 * to drop below human perception (~100ms) to fix the double-press bug — it
 * does NOT need to be 0. Multi-byte sequences usually arrive in a single read
 * chunk (the local-TTY norm: ESC[A → up, ESC+a → alt+a) and decode
 * synchronously, but a slow/remote PTY (e.g. `ssh -t`) can deliver a sequence
 * across multiple `data` events — a TCP-fragmented bracketed-paste start
 * (`\x1b[200~`, which AFK enables via `\x1b[?2004h`) or an arrow `\x1b[A`. At
 * `escapeCodeTimeout: 0` Node flushes the lone leading `\x1b` after one
 * event-loop tick, before the remaining bytes land, so it surfaces as a bare
 * `escape` keypress — which `handleEscape`/the elicitation prompts fire
 * soft-stop/cancel on (no `sequence` guard). 50ms keeps lone-ESC well below
 * perceptible latency while leaving enough of a reassembly window for a
 * fragmented sequence to coalesce into its real keypress. (Codex review
 * #626.)
 *
 * The timeout rides on the second arg, which Node reads as
 * `iface.escapeCodeTimeout`. @types/node types that arg as a full
 * `readline.Interface` (it never modelled the documented `escapeCodeTimeout`
 * option on a bare object), so we cast the minimal shape Node actually
 * dereferences. The cast is the single auditable point of that unsoundness
 * for every keypress surface in the CLI.
 */
const LONE_ESC_TIMEOUT_MS = 50;

export function emitKeypressEventsImmediateEscape(stream: NodeJS.ReadableStream): void {
  emitKeypressEvents(stream, { escapeCodeTimeout: LONE_ESC_TIMEOUT_MS } as unknown as Interface);
}

// ---------------------------------------------------------------------------
// CPR keypress guard — Gap 2 fix (#3206)
// ---------------------------------------------------------------------------
//
// Problem: after the compositor's per-CPR `data` listener times out and is
// removed, a late terminal reply (`ESC[row;colR`) is decoded by readline's
// keypress emitter and surfaced to whatever keypress consumer is active at
// that moment.  If the compositor is already disarmed (the turn ended and
// the idle-prompt reader in `reader.ts` took over stdin), the reply reaches
// `handleKeypress`, which has no CPR guard — the sequence is unknown to every
// named key handler and falls through to the printable check.  Although
// `isPrintableGrapheme` rejects it (the leading ESC is < space), readline may
// also decode the reply with a non-empty `char` argument, causing characters
// to be inserted into the prompt buffer.
//
// Fix: a shared, time-bounded guard flag.  When a CPR request is emitted,
// `armCprKeypressGuard` sets a deadline.  Any keypress surface that wants
// protection queries `isCprKeypressGuardActive` at the top of its handler
// and drops events whose `key.sequence` matches CPR_REPLY_RE.
//
// F3 / Ctrl+F3 disambiguation:
//   `ESC[1;5R` encodes Ctrl+F3 on some terminals.  AFK binds no action to
//   F3 or its modifiers on either the compositor or the reader, so dropping
//   any CPR-shaped sequence while the guard is active is safe today.  The
//   guard is ONLY armed when a CPR is actually expected (request just emitted)
//   or recently timed out (grace window, see CPR_KEYPRESS_GRACE_MS).  Outside
//   that narrow window CPR-shaped sequences pass through normally, so a
//   Ctrl+F3 press during ordinary editing is unaffected.  If AFK ever binds
//   F3/Ctrl+F3, the guard should compare the expected {row,col} instead of
//   pattern-matching, dropping only an exact CPR match.

/** Additional ms to keep the guard active after a CPR timeout or reply. */
export const CPR_KEYPRESS_GRACE_MS = 500;

/** Epoch-ms deadline until which CPR-shaped keypresses are dropped on `_guardedStdin`. */
let _guardDeadline = 0;

/** The stdin stream the guard is associated with. */
let _guardedStdin: NodeJS.ReadableStream | null = null;

/** Cleanup timer (auto-disarm). */
let _guardTimer: ReturnType<typeof setTimeout> | null = null;

// Invariant: _guardGeneration is a monotonically increasing counter bumped by
// every armCprKeypressGuard call.  A deferred disarm (e.g. setImmediate) must
// capture the generation at the time it was scheduled and pass it back as
// `guardGen`; disarmCprKeypressGuard treats a stale generation as a no-op.
// This prevents a re-arm that occurs BETWEEN the schedule and the deferral
// firing from being silently cleared by the older deferred disarm — the exact
// race in the dirty-burst re-query path: cleanup() → setImmediate(disarm)
// scheduled, then _requestCpr() → armCprKeypressGuard() (generation bumps),
// then the setImmediate fires and must NOT clear the freshly armed guard.
let _guardGeneration = 0;

/**
 * Arm (or extend) the CPR keypress guard on `stdin` for `durationMs` ms.
 *
 * While the guard is active, `isCprKeypressGuardActive(stdin)` returns true
 * and every keypress consumer is expected to drop events whose sequence
 * matches `CPR_REPLY_RE`.  Calling this again before the deadline extends it
 * to the later of the two expirations.
 *
 * Returns the guard generation token after this arm.  Pass the token to
 * `disarmCprKeypressGuard` when scheduling a deferred disarm (e.g.
 * `setImmediate`) so that a re-arm that happens between the schedule and the
 * deferred call does not get silently cleared — the disarm is a no-op when
 * the generation token is stale.
 *
 * Called from `_requestCpr` (in `terminal-compositor.lifecycle.cpr.ts`) when
 * a CPR request is emitted and again on timeout to cover the grace window.
 */
export function armCprKeypressGuard(stdin: NodeJS.ReadableStream, durationMs: number): number {
  const newDeadline = Date.now() + durationMs;

  if (_guardedStdin !== null && _guardedStdin !== stdin) {
    // Different stream — disarm the old guard before installing a new one.
    // Log a diagnostic under AFK_DEBUG_COMPOSITOR so stream-swap surprises
    // are visible without polluting normal output.
    if (env.AFK_DEBUG_COMPOSITOR) {
      process.stderr.write(
        '[afk/cpr] armCprKeypressGuard: stream swap detected while guard is active —' +
        ' disarming previous guard and arming on new stream\n',
      );
    }
    _disarm();
  }

  _guardedStdin = stdin;
  _guardGeneration += 1;

  if (newDeadline > _guardDeadline) {
    _guardDeadline = newDeadline;
    if (_guardTimer !== null) { clearTimeout(_guardTimer); _guardTimer = null; }
    _guardTimer = setTimeout(_disarm, durationMs);
    // Unref so the guard timer does not keep the event loop alive past process
    // exit.  The guard is a safety net — if it fires during shutdown, there is
    // no meaningful work left to do.  Without unref the timer can hold the loop
    // for up to CPR_KEYPRESS_GRACE_MS (~500ms) beyond the last real task.
    _guardTimer.unref();
  }

  return _guardGeneration;
}

function _disarm(): void {
  if (_guardTimer !== null) { clearTimeout(_guardTimer); _guardTimer = null; }
  _guardDeadline = 0;
  _guardedStdin = null;
}

/**
 * Immediately disarm the CPR keypress guard.
 *
 * When called without arguments, always disarms (unconditional).
 *
 * When called with `guardGen` — the generation token returned by the
 * `armCprKeypressGuard` call that scheduled this disarm — the disarm is
 * skipped if a newer arm happened after the disarm was scheduled.  This
 * prevents a `setImmediate`-deferred disarm from clearing a guard that was
 * re-armed in the gap between the schedule and the deferred call (the
 * dirty-burst re-query race: cleanup → setImmediate(disarm) → _requestCpr
 * → armCprKeypressGuard → setImmediate fires → should be no-op).
 *
 * Call this after successfully consuming a CPR reply so the guard does not
 * persist for the full `timeoutMs + CPR_KEYPRESS_GRACE_MS` window when the
 * reply arrived promptly.  Calling when the guard is already inactive is a
 * no-op.
 */
export function disarmCprKeypressGuard(guardGen?: number): void {
  if (guardGen !== undefined && guardGen !== _guardGeneration) {
    // Stale deferred disarm — a newer arm was installed after this disarm was
    // scheduled.  Leave the current guard intact.
    return;
  }
  _disarm();
}

/**
 * Returns true when any keypress event on `stdin` whose sequence matches
 * `CPR_REPLY_RE` should be silently dropped.
 *
 * Consumers call this at the top of their keypress handler.  When it returns
 * true the handler must check `CPR_REPLY_RE.test(key?.sequence ?? '')` and
 * return early without processing the event.
 */
export function isCprKeypressGuardActive(stdin: NodeJS.ReadableStream): boolean {
  return _guardedStdin === stdin && Date.now() <= _guardDeadline;
}

/**
 * True when `sequence` looks like a CPR reply and the guard is armed.
 * Convenience wrapper combining `isCprKeypressGuardActive` + the CPR pattern.
 */
export function isCprSequence(stdin: NodeJS.ReadableStream, sequence: string): boolean {
  return isCprKeypressGuardActive(stdin) && _CPR_REPLY_RE.test(sequence);
}

/**
 * Test helper: reset all CPR keypress guard state.
 * Must only be called from tests.
 */
export function __resetCprKeypressGuardForTests(): void {
  _disarm();
  _guardGeneration = 0;
}
