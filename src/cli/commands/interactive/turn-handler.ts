import type { AgentSession } from '../../../agent/session.js';
import type { SessionStats, ToolEvent } from '../../slash/types.js';
import type { OutputEvent, SubagentProgressMeta } from '../../../agent/types.js';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import { describeForHistory, type ImageAttachment } from '../../input/attachments.js';
import type { InputSurfaceRefs } from '../../input/input-surface.js';
import { palette } from '../../palette.js';
import { isDebugEnabled } from '../../../utils/debug.js';
import { classifyError, presentError } from '../../errors/index.js';
import { type CompletionWriter, type ThinkingUiMode, type TurnHandles } from './shared.js';
import { StreamRenderer } from '../../_lib/stream-renderer.js';
import { createConsoleWriter } from '../../slash/writer.js';
import {
  setTerminalTitleIfEnabled,
  formatTerminalTitle,
} from '../../_lib/capture-mode.js';
import { runWithSink } from '../../../agent/_lib/skill-sink-channel.js';
import { createTaskViewHandler } from './task-view-mid-turn.js';
import { buildUserPayload } from '../../slash/_lib/user-payload.js';
import { expandAtFileTokens } from './at-file-inject.js';
import { makeHandleBackgroundKey, installSubagentPromotion } from './turn-handler.bg-promotion.js';
import { createTurnTtfbState, emitPlainTtfbWaiting, ttfbRendererOptions } from './turn-handler.ttfb.js';
import { type PausedPickerRef } from './turn-handler.paused.js';
import { processStreamEvent, type StreamEventState, type StreamEventContext } from './turn-handler.stream-events.js';
import {
  handleTurnCompletion,
  buildAssistantContentBlocks,
  buildUserContentBlocks,
} from './turn-handler.completion.js';

export { formatToolLine, formatToolResultLine, ToolLane } from './tool-lane.js';

// buildAssistantContentBlocks and buildUserContentBlocks are defined in
// turn-handler.completion.ts (where they feed handleTurnCompletion directly)
// and re-exported here so existing callers that import from this module
// continue to compile without changes.
export { buildAssistantContentBlocks, buildUserContentBlocks } from './turn-handler.completion.js';

// InputSurfaceRefs moved to `src/cli/input/input-surface.ts` alongside
// the InputSurface class that owns these refs. Re-exported here so
// existing callers that import from this module keep compiling.
export type { InputSurfaceRefs } from '../../input/input-surface.js';

export async function runTurn(
  input: { text: string; attachments: ImageAttachment[] },
  session: AgentSession,
  stats: SessionStats,
  h: TurnHandles,
  thinkingUi: ThinkingUiMode = 'summary',
  completionWriter?: CompletionWriter,
  inputSurface?: InputSurfaceRefs,
): Promise<void> {
  const historyText = describeForHistory(input.text, input.attachments);

  // Persist the user's message before the stream starts. onTurnComplete
  // only fires on doneFired && !softStopRequested, so without this hook a
  // crash, ESC soft-stop, or backgrounded turn loses the user's message.
  if (h.onUserMessage) {
    await Promise.resolve(h.onUserMessage(historyText))
      .catch(() => { /* best-effort */ });
  }

  h.setInFlight(true);

  const turnStartedAt = Date.now();
  const turnTtfb = createTurnTtfbState(turnStartedAt);
  emitPlainTtfbWaiting(completionWriter, process.stdout, turnTtfb);
  // OSC 2 terminal title: show "· running" while the turn is in flight.
  setTerminalTitleIfEnabled(process.stdout, formatTerminalTitle(process.cwd(), true));

  // Mutable turn state — mutated in place by processStreamEvent.
  // See turn-handler.stream-events.ts for the StreamEventState type.
  const state: StreamEventState = {
    responseText: '',
    roundStartResponseLen: 0,
    pendingRoundSeam: false,
    streamingStarted: false,
    streamErrorRendered: false,
    doneFired: false,
    doneMeta: undefined,
    softStopRequested: false,
    pauseInterruptRequested: false,
    lastContextProgressMs: 0,
    rendererDisposed: false,
  };
  // Stored in an object so TypeScript's control-flow narrowing doesn't collapse
  // the type to `never` in the finally block after the async .then() assignment.
  const pickerRef: PausedPickerRef = { abort: null };
  const toolEvents: ToolEvent[] = [];
  const pendingTools = new Map<string, ToolEvent>();

  const activeSkillName = input.text.startsWith('/')
    ? input.text.split(/[\s:]/)[0]?.slice(1)
    : undefined;

  // Borrow the REPL's persistent compositor when available; fall back to
  // per-turn compositor construction for non-TTY / legacy paths.
  const borrowedCompositor = h.getCompositor ? h.getCompositor() : null;

  // Ctrl+B subagent-promotion handler (foreground subagent detach only).
  const handleBackgroundKey = makeHandleBackgroundKey({ h, borrowedCompositor, completionWriter });

  // Factory so the paused→resumed path can swap in a fresh renderer mid-turn
  // (the original renderer is disposed at "Usage paused" and its process() is a no-op).
  const buildRenderer = (): StreamRenderer => new StreamRenderer({
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
  });

  // `let` so the resumed-event handler can swap in a fresh renderer.
  let renderer = buildRenderer();

  // Bridge the session-scoped bashOutputTailReporter to this turn's ToolLane.
  if (h.bashTailSetter) {
    h.bashTailSetter.current = (id, tail) => renderer.setBashOutputTail(id, tail);
  }

  const disposeRendererOnce = async (): Promise<void> => {
    if (state.rendererDisposed) return;
    state.rendererDisposed = true;
    if (h.bashTailSetter) h.bashTailSetter.current = undefined;
    try { await renderer.dispose(); } catch { /* best-effort */ }
  };

  // Hoisted so both initial setup and post-resume swap re-publish the
  // active compositor to completionWriter + SIGINT routing.
  const armAndWire = async (): Promise<void> => {
    await renderer.arm();
    const armedCompositor = renderer.getCompositor();
    if (completionWriter && armedCompositor) {
      const c = armedCompositor;
      completionWriter.fn = (line) => c.commitAbove(line);
      // Suppress the redundant SubagentStop line while the overlay is live.
      completionWriter.suppressSubagentCompletion = true;
    }
    h.setActiveCompositor?.(armedCompositor);
    // Notifier follows the live renderer across paused→resumed hot-swaps.
    h.setInterruptNotifier?.((active) => renderer.setInterrupting(active));
    h.rearmStatus?.();
  };

  try {
    // Blank line separating user input from agent output.
    // Borrowed compositor: route through commitAbove so log-update's line
    // tracker stays consistent (arm() flips input mode but doesn't re-arm
    // log-update, so a raw console.log would stray its cursor tracking).
    // Legacy own-compositor: arm() constructs its compositor mid-call, so
    // a raw console.log() BEFORE arm() is safe — no log-update tracking yet.
    if (borrowedCompositor) {
      borrowedCompositor.commitAbove('');
    } else {
      console.log();
    }

    // Install the per-turn ESC soft-stop handler BEFORE arm() to close the
    // window between arm()'s setInputMode('streaming') and handler installation.
    if (h.setSoftStopHandler) {
      h.setSoftStopHandler(() => {
        state.softStopRequested = true;
        // Immediate banner feedback; closure follows the live renderer post-swap.
        renderer.setSoftStopping(true);
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

    await armAndWire();

    // Per-turn Ctrl+B (foreground subagent promotion) and Tab (task view).
    installSubagentPromotion({ h, borrowedCompositor, completionWriter });
    h.setTaskViewHandler?.(createTaskViewHandler(h));

    // Expand `@<path>` tokens in the user's text into file-content blocks
    // (tilde/absolute/relative, size+binary+secret guarded — see
    // at-file-inject.ts). The token stays in the text; content rides alongside.
    const { fileBlocks, warnings: atFileWarnings } = expandAtFileTokens(input.text, {
      rootDir: process.cwd(),
    });
    for (const w of atFileWarnings) {
      (completionWriter ?? { fn: console.log }).fn(palette.dim(`  @-file: ${w}`));
    }
    if (input.attachments.length > 0) {
      await session.waitForInitialization();
      if (session.sessionId === undefined) throw new Error('CLI session initialized without a session id');
    }
    const payload =
      fileBlocks.length > 0 || input.attachments.length > 0
        ? await buildUserPayload(input.text, input.attachments, undefined, fileBlocks, session.sessionId)
        : input.text;
    const stream = session.sendMessageStream(payload);

    // Ambient sink: dereferences the live renderer so mid-turn subagents route
    // into whichever renderer is current (including after a paused→resumed swap).
    const ambientSink = (event: OutputEvent, meta?: SubagentProgressMeta): void => {
      renderer.process(event, meta);
      if (meta) turnTtfb.plainHooks?.onSubagentEvent(event, meta);
    };
    const streamCtx: StreamEventContext = {
      state,
      pickerRef,
      toolEvents,
      pendingTools,
      getRenderer: () => renderer,
      setRenderer: (r) => { renderer = r; },
      turnTtfb,
      h,
      session,
      completionWriter,
      borrowedCompositor,
      disposeRendererOnce,
      armAndWire,
      buildRenderer,
    };

    await runWithSink(ambientSink, async () => {
      for await (const event of stream) {
        // Invariant: interrupt fires in the ESC/pause handler, not here.
        // The loop only breaks — no interrupt() call — so a long-running
        // tool call that blocks this loop does not create a dead-ESC window.
        // Orphaned tool_use records from a mid-loop break are healed by
        // repairOrphanToolUses before the next request (see query.ts).
        if (state.softStopRequested || state.pauseInterruptRequested) {
          break;
        }
        await processStreamEvent(event, streamCtx);
      }
    });

    // Pre-compute content blocks for the sidecar (structured resume path).
    // See turn-handler.completion.ts: buildAssistantContentBlocks / buildUserContentBlocks.
    const assistantBlocks = buildAssistantContentBlocks(state.responseText, toolEvents);
    const prevTurnToolEvents = stats.turns.at(-1)?.toolEvents ?? [];
    const userBlocks = Array.isArray(payload)
      ? (payload as ContentBlockParam[])
      : buildUserContentBlocks(historyText, prevTurnToolEvents);

    await handleTurnCompletion({
      state,
      stats,
      h,
      toolEvents,
      historyText,
      assistantBlocks,
      userBlocks,
      completionWriter,
      borrowedCompositor,
      renderer,
      disposeRendererOnce,
    });
  } catch (error) {
    await disposeRendererOnce();
    if (!state.streamErrorRendered) {
      presentError(classifyError(error));
    }
  } finally {
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
}

// Footer helpers extracted to turn-handler.footer.ts to keep this file within
// the baseline ceiling. Re-exported so all existing importers keep compiling.
export type { ContextTier } from './turn-handler.footer.js';
export { formatContextUsage, printTurnFooter, printTurnSeparator } from './turn-handler.footer.js';
