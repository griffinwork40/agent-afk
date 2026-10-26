/**
 * Setup helpers extracted from turn-handler.ts to keep runTurn under the
 * 200-line function ceiling (issue #3478).
 *
 * All exports are named helpers that take explicit parameters — no closures
 * over enclosing locals. The public surface of turn-handler.ts is unchanged.
 */

import type { AgentSession } from '../../../agent/session.js';
import type { CompletionWriter, TurnHandles } from './shared.js';
import type { StreamEventState } from './turn-handler.stream-events.js';
import type { PausedPickerRef } from './turn-handler.paused.js';
import type { StreamRenderer } from '../../_lib/stream-renderer.js';
import type { StreamRendererOptions } from '../../_lib/stream-renderer-options.js';
import type { InputSurfaceRefs } from '../../input/input-surface.js';
import type { TerminalCompositor } from '../../terminal-compositor.js';
import type { ThinkingUiMode } from '../../slash/types.js';
import { palette } from '../../palette.js';
import { isDebugEnabled } from '../../../utils/debug.js';
import { createConsoleWriter } from '../../slash/writer.js';
import { ttfbRendererOptions, type TurnTtfbState } from './turn-handler.ttfb.js';
import { syncCapturePathRef } from './turn-handler.capture-sync.js';
import { setTerminalTitleIfEnabled, formatTerminalTitle } from '../../_lib/capture-mode.js';

// ─── Renderer options builder ────────────────────────────────────────────────

/**
 * Build the {@link StreamRendererOptions} object for a new per-turn renderer.
 * Extracted from the `buildRenderer` factory closure in `runTurn` to keep
 * that function under 200 lines. All context is passed explicitly — no
 * closure over enclosing locals.
 *
 * Contract: every optional spread in the returned object matches the
 * conditional spreads that existed inline in `runTurn` before extraction.
 */
export function buildRendererOptions(params: {
  completionWriter: CompletionWriter | undefined;
  thinkingUi: ThinkingUiMode;
  activeSkillName: string | undefined;
  session: AgentSession;
  h: TurnHandles;
  handleBackgroundKey: () => void;
  inputSurface: InputSurfaceRefs | undefined;
  borrowedCompositor: TerminalCompositor | null;
  turnTtfb: TurnTtfbState;
}): StreamRendererOptions {
  const {
    completionWriter,
    thinkingUi,
    activeSkillName,
    session,
    h,
    handleBackgroundKey,
    inputSurface,
    borrowedCompositor,
    turnTtfb,
  } = params;
  return {
    out: createConsoleWriter(completionWriter),
    thinkingMode: thinkingUi,
    ...(activeSkillName ? { activeSkillName } : {}),
    onCancel: () => {
      session.interrupt().catch((err) => {
        if (isDebugEnabled()) {
          console.error('  ' + palette.error('session.interrupt() failed:'), err);
        }
      });
    },
    ...(h.subagentControl ? { onBackground: handleBackgroundKey } : {}),
    ...(inputSurface?.history ? { history: inputSurface.history } : {}),
    ...(inputSurface?.autocompleteState ? { autocompleteState: inputSurface.autocompleteState } : {}),
    ...(inputSurface?.promptText !== undefined ? { promptText: inputSurface.promptText } : {}),
    ...(h.scrollRegion ? { scrollRegion: h.scrollRegion } : {}),
    ...(borrowedCompositor ? { compositor: borrowedCompositor } : {}),
    ...(h.onStageChange ? { onStageChange: h.onStageChange } : {}),
    ...ttfbRendererOptions(turnTtfb),
    ...(h.addPreviewDiffRef ? { addPreviewDiffRef: h.addPreviewDiffRef } : {}),
    ...(completionWriter ? { completionWriter } : {}),
  };
}

// ─── Renderer lifecycle helpers ───────────────────────────────────────────────

/**
 * Idempotent renderer disposal. Guards with `state.rendererDisposed` so
 * the finally block and the catch block can both call it safely.
 *
 * Contract: clears `bashTailSetter.current` before disposing so the
 * session-scoped reporter cannot route to a dead renderer.
 */
export async function disposeRendererOnce(params: {
  state: StreamEventState;
  h: TurnHandles;
  getRenderer: () => StreamRenderer;
}): Promise<void> {
  const { state, h, getRenderer } = params;
  if (state.rendererDisposed) return;
  state.rendererDisposed = true;
  if (h.bashTailSetter) h.bashTailSetter.current = undefined;
  try { await getRenderer().dispose(); } catch { /* best-effort */ }
}

/**
 * Arm the renderer and wire the live compositor into `completionWriter` and
 * the SIGINT notifier. Hoisted so both initial setup and the post-resume
 * paused→resumed swap can re-publish the active compositor.
 *
 * Contract: must be awaited before the stream loop starts. The
 * `completionWriter.fn` swap and `setActiveCompositor` call are ordering-
 * sensitive — they must happen after `renderer.arm()` resolves.
 */
export async function armAndWire(params: {
  getRenderer: () => StreamRenderer;
  completionWriter: CompletionWriter | undefined;
  h: TurnHandles;
}): Promise<void> {
  const { getRenderer, completionWriter, h } = params;
  const renderer = getRenderer();
  await renderer.arm();
  const armedCompositor = renderer.getCompositor();
  if (completionWriter && armedCompositor) {
    const c = armedCompositor;
    completionWriter.fn = (line) => c.commitAbove(line);
    // Suppress the redundant SubagentStop line while the overlay is live.
    completionWriter.suppressSubagentCompletion = true;
    // Clear the per-turn rendered-id set so stale ids from a previous turn
    // don't suppress legitimate between-turn completions.
    completionWriter.renderedSubagentIds = new Set();
  }
  h.setActiveCompositor?.(armedCompositor);
  // Notifier follows the live renderer across paused→resumed hot-swaps.
  h.setInterruptNotifier?.((active) => renderer.setInterrupting(active));
  h.rearmStatus?.();
}

// ─── Per-turn interrupt handler installation ─────────────────────────────────

/**
 * Install the per-turn ESC soft-stop handler and the pause-interrupt handler
 * onto the surface. Extracted from `runTurn` to reduce its line count.
 *
 * Invariant: both handlers must be installed BEFORE `arm()` to close the
 * window between `arm()`'s `setInputMode('streaming')` and handler
 * installation (the "ESC does nothing" bug).
 *
 * Contract: `state` is mutated in place by the handlers, exactly as it was
 * in the original inline closures. `getRenderer` dereferences the live
 * renderer so a paused→resumed hot-swap is reflected correctly.
 */
export function installTurnHandlers(params: {
  h: TurnHandles;
  state: StreamEventState;
  session: AgentSession;
  getRenderer: () => StreamRenderer;
}): void {
  const { h, state, session, getRenderer } = params;

  // Install the per-turn ESC soft-stop handler BEFORE arm() to close the
  // window between arm()'s setInputMode('streaming') and handler installation.
  if (h.setSoftStopHandler) {
    h.setSoftStopHandler(() => {
      state.softStopRequested = true;
      // Immediate banner feedback; closure follows the live renderer post-swap.
      getRenderer().setSoftStopping(true);
      // Fire interrupt() synchronously — deferred fire via the for-await loop
      // would block during long tool calls (the "ESC does nothing" bug).
      session.interrupt().catch((err) => {
        if (isDebugEnabled()) {
          console.error('  ' + palette.error('soft-stop session.interrupt() failed:'), err);
        }
      });
      // A turn parked on a subagent await cannot be halted by interrupt() alone;
      // cancel the foreground subagent so it resolves and the loop can break.
      const ctrl = h.subagentControl;
      if (ctrl?.hasActiveForeground()) {
        void ctrl.cancelActiveForeground().catch((err) => {
          if (isDebugEnabled()) {
            console.error('  ' + palette.error('soft-stop cancelActiveForeground() failed:'), err);
          }
        });
      }
    });
  }

  // Install the per-turn pause-interrupt handler (usage-limit pause → next turn).
  if (h.setPauseInterruptHandler) {
    h.setPauseInterruptHandler(() => {
      state.pauseInterruptRequested = true;
      session.interrupt().catch((err) => {
        if (isDebugEnabled()) {
          console.error('  ' + palette.error('pause-interrupt session.interrupt() failed:'), err);
        }
      });
    });
  }
}

// ─── Finally-block teardown ──────────────────────────────────────────────────

/**
 * Execute the ordered finally-block teardown for a completed (or errored) turn.
 * Extracted from `runTurn`'s `finally` block to keep that function under 200
 * lines. Ordering is preserved exactly — this is a hot path with terminal
 * write ordering constraints.
 *
 * Contract: callers MUST await this and MUST NOT call it more than once per
 * turn. The `disposeRendererOnce` guard is idempotent but `setInFlight(false)`
 * and handle-clears are not side-effect-free to double-call.
 */
export async function teardownTurn(params: {
  h: TurnHandles;
  completionWriter: CompletionWriter | undefined;
  pickerRef: PausedPickerRef;
  disposeRendererOnce: () => Promise<void>;
}): Promise<void> {
  const { h, completionWriter, pickerRef, disposeRendererOnce } = params;

  await disposeRendererOnce();
  // OSC 2 title: reset "· running" on EVERY exit path (clean, ESC, error).
  setTerminalTitleIfEnabled(process.stdout, formatTerminalTitle(process.cwd(), false));

  if (completionWriter) {
    // Restore the idle sink (routes through compositor.commitAbove on the
    // borrowed path — must NOT be hardcoded to console.log; see PR /model bug).
    completionWriter.fn = completionWriter.idleFn;
    // Let backgrounded subagent completions surface again between turns.
    completionWriter.suppressSubagentCompletion = false;
  }

  // Clear all per-turn handles so between-turn presses are no-ops.
  h.setActiveCompositor?.(null);
  h.setInterruptNotifier?.(null);
  h.setBackgroundHandler?.(null);
  h.setTaskViewHandler?.(null);
  h.setSoftStopHandler?.(null);
  h.setPausedState?.(false);
  h.setPauseInterruptHandler?.(null);
  pickerRef.abort?.abort();
  pickerRef.abort = null;
  h.setInFlight(false);
  h.rearmStatus?.();
}

// Re-export syncCapturePathRef so turn-handler.ts imports from one setup sibling.
export { syncCapturePathRef };
