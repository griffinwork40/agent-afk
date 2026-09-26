/**
 * Stream event loop body extracted from turn-handler.ts.
 *
 * Processes a single event from the `for await (const event of stream)` loop
 * inside `runWithSink`. Mutable turn state is passed in via `StreamEventState`
 * (mutated in place); all other references are bundled in `StreamEventContext`.
 *
 * Extracted to keep turn-handler.ts within its code-line ceiling.
 */

import type { OutputEvent } from '../../../agent/types.js';
import type { AgentSession } from '../../../agent/session.js';
import type { ResponseMetadata } from '../../../agent/types/message-types.js';
import type { CompletionWriter, TurnHandles } from './shared.js';
import type { TerminalCompositor } from '../../terminal-compositor.js';
import type { ToolEvent } from '../../slash/types.js';
import { StreamRenderer } from '../../_lib/stream-renderer.js';
import { palette } from '../../palette.js';
import { classifyError, presentError } from '../../errors/index.js';
import { joinAtRoundSeam } from './turn-text-seam.js';
import { observeFirstContent, type TurnTtfbState } from './turn-handler.ttfb.js';
import { tickContextProgress } from './turn-handler.context-progress.js';
import { handlePausedEvent, type PausedPickerRef } from './turn-handler.paused.js';

// ─── Mutable state ───────────────────────────────────────────────────────────

/**
 * All mutable scalars that the stream event loop reads and writes.
 * Mutated in place by {@link processStreamEvent}; the caller owns the object
 * and reads fields back after the loop ends.
 */
export interface StreamEventState {
  responseText: string;
  roundStartResponseLen: number;
  pendingRoundSeam: boolean;
  streamingStarted: boolean;
  streamErrorRendered: boolean;
  doneFired: boolean;
  doneMeta: ResponseMetadata | undefined;
  softStopRequested: boolean;
  pauseInterruptRequested: boolean;
  lastContextProgressMs: number;
  rendererDisposed: boolean;
}

// ─── Context (shared references, not mutated by processStreamEvent itself) ───

/**
 * All references needed by the event handler that are NOT scalar mutable state.
 * Functions that mutate the renderer binding (`getRenderer`/`setRenderer`) are
 * provided as accessors so the `resumed` path can hot-swap the renderer while
 * keeping the outer `let renderer` binding in sync with turn-handler.ts.
 */
export interface StreamEventContext {
  state: StreamEventState;
  pickerRef: PausedPickerRef;
  toolEvents: ToolEvent[];
  pendingTools: Map<string, ToolEvent>;
  /** Read the current renderer (follows hot-swaps). */
  getRenderer: () => StreamRenderer;
  /** Replace the renderer binding (resumed path). */
  setRenderer: (r: StreamRenderer) => void;
  turnTtfb: TurnTtfbState;
  h: TurnHandles;
  session: AgentSession;
  completionWriter: CompletionWriter | undefined;
  borrowedCompositor: TerminalCompositor | null;
  disposeRendererOnce: () => Promise<void>;
  armAndWire: () => Promise<void>;
  buildRenderer: () => StreamRenderer;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

/**
 * Process a single event from the stream's `for await` loop.
 *
 * Returns:
 * - `'continue'` — event fully handled; caller should `continue` the loop.
 * - `'normal'`   — event processed (renderer.process called); loop iteration
 *                  ends normally.
 *
 * The soft-stop guard (`if (softStopRequested || pauseInterruptRequested) break`)
 * is the caller's responsibility and must run BEFORE calling this function.
 */
export async function processStreamEvent(
  event: OutputEvent,
  ctx: StreamEventContext,
): Promise<'continue' | 'normal'> {
  const { state, pickerRef, toolEvents, pendingTools, turnTtfb, h, session,
    completionWriter, borrowedCompositor, disposeRendererOnce, armAndWire, buildRenderer } = ctx;

  const isFirstContentEvent = observeFirstContent(turnTtfb, event, state.streamingStarted);

  // ── Content / message accumulation ──────────────────────────────────────

  if (event.type === 'chunk' && event.chunk.type === 'content') {
    state.responseText = state.pendingRoundSeam
      ? joinAtRoundSeam(state.responseText, event.chunk.content)
      : state.responseText + event.chunk.content;
    state.pendingRoundSeam = false;
    state.streamingStarted = true;
    h.onTextDelta?.(event.chunk.content.length);
  } else if (event.type === 'message' && !state.streamingStarted) {
    state.responseText = event.message.content;
  }

  // ── stream_retry: truncate partial round text ────────────────────────────

  if (event.type === 'stream_retry') {
    state.responseText = state.responseText.slice(0, state.roundStartResponseLen);
    state.pendingRoundSeam = state.responseText.length > 0;
    // Fall through to renderer.process below.
  }

  // ── Tool events ──────────────────────────────────────────────────────────

  if (event.type === 'chunk' && event.chunk.type === 'tool_use_detail') {
    const c = event.chunk;
    const te: ToolEvent = {
      toolName: c.toolName,
      toolUseId: c.toolUseId,
      input: c.toolInput,
      ...(c.toolInputRaw !== undefined && { inputRaw: c.toolInputRaw }),
    };
    pendingTools.set(c.toolUseId, te);
    toolEvents.push(te);
    turnTtfb.plainHooks?.onToolStart(c);
  } else if (event.type === 'chunk' && event.chunk.type === 'tool_result') {
    const c = event.chunk;
    state.roundStartResponseLen = state.responseText.length;
    state.pendingRoundSeam = true;
    const pending = pendingTools.get(c.toolUseId);
    if (pending) {
      pending.result = c.content;
      pending.isError = c.isError;
      pendingTools.delete(c.toolUseId);
    }
    turnTtfb.plainHooks?.onToolResult(c, pending?.toolName);
    state.lastContextProgressMs = await tickContextProgress(
      h.onContextProgress,
      state.lastContextProgressMs,
    );
  }

  // ── paused ───────────────────────────────────────────────────────────────

  if (event.type === 'paused') {
    await handlePausedEvent({
      event,
      session,
      borrowedCompositor,
      pickerRef,
      completionWriter,
      disposeRendererOnce,
      setPausedState: h.setPausedState,
      onPauseInterrupt: () => { state.pauseInterruptRequested = true; },
    });
    return 'continue';
  }

  // ── resumed ──────────────────────────────────────────────────────────────

  if (event.type === 'resumed') {
    h.setPausedState?.(false);
    pickerRef.abort?.abort();
    pickerRef.abort = null;

    const note = event.hotSwapped && event.accountId
      ? `▶ Resumed on ${event.accountId}`
      : '▶ Resumed';

    // Reset per-turn accumulators FIRST so the new renderer starts clean.
    state.responseText = '';
    state.roundStartResponseLen = 0;
    state.pendingRoundSeam = false;
    state.streamingStarted = false;
    toolEvents.length = 0;
    pendingTools.clear();
    state.doneFired = false;
    state.doneMeta = undefined;
    state.streamErrorRendered = false;

    // Build + arm a fresh renderer for the replayed turn.
    const newRenderer = buildRenderer();
    ctx.setRenderer(newRenderer);
    state.rendererDisposed = false;
    await armAndWire();

    (completionWriter ?? { fn: console.log }).fn(palette.success(note));
    return 'continue';
  }

  // ── error ────────────────────────────────────────────────────────────────

  if (event.type === 'error') {
    await disposeRendererOnce();
    presentError(classifyError(event.error));
    state.streamErrorRendered = true;
    return 'continue';
  }

  // ── default: let the renderer handle it ─────────────────────────────────

  ctx.getRenderer().process(event);

  if (isFirstContentEvent) {
    turnTtfb.plainHooks?.onFirstContent(process.stdout);
    // Deliberately follows process(): notifyFirstContent marks the
    // progress-banner slot dirty so the TTFB waiting line disappears
    // on the next overlay repaint.
    ctx.getRenderer().notifyFirstContent();
  }

  if (event.type === 'done') {
    state.doneFired = true;
    state.doneMeta = event.metadata;
  }

  return 'normal';
}
