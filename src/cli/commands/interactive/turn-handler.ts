import type { AgentSession } from '../../../agent/session.js';
import type { SessionStats, ToolEvent } from '../../slash/types.js';
import type { OutputEvent, SubagentProgressMeta } from '../../../agent/types.js';
import { describeForHistory, type ImageAttachment } from '../../input/attachments.js';
import type { InputSurfaceRefs } from '../../input/input-surface.js';
import { palette } from '../../palette.js';
import { classifyError, presentError } from '../../errors/index.js';
import { type CompletionWriter, type ThinkingUiMode, type TurnHandles } from './shared.js';
import { StreamRenderer } from '../../_lib/stream-renderer.js';
import { runWithSink } from '../../../agent/_lib/skill-sink-channel.js';
import { createTaskViewHandler } from './task-view-mid-turn.js';
import { buildUserPayload } from '../../slash/_lib/user-payload.js';
import { expandAtFileTokens } from './at-file-inject.js';
import { makeHandleBackgroundKey, installSubagentPromotion } from './turn-handler.bg-promotion.js';
import { createTurnTtfbState, emitPlainTtfbWaiting } from './turn-handler.ttfb.js';
import { type PausedPickerRef } from './turn-handler.paused.js';
import { processStreamEvent, type StreamEventState, type StreamEventContext } from './turn-handler.stream-events.js';
import { handleTurnCompletion } from './turn-handler.completion.js';
import {
  buildRendererOptions,
  disposeRendererOnce as doDisposeRendererOnce,
  armAndWire as doArmAndWire,
  installTurnHandlers,
  teardownTurn,
  syncCapturePathRef,
} from './turn-handler.setup.js';
import {
  setTerminalTitleIfEnabled,
  formatTerminalTitle,
} from '../../_lib/capture-mode.js';

export { formatToolLine, formatToolResultLine, ToolLane } from './tool-lane.js';

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
  const buildRenderer = (): StreamRenderer => new StreamRenderer(
    buildRendererOptions({ completionWriter, thinkingUi, activeSkillName, session, h,
      handleBackgroundKey, inputSurface, borrowedCompositor, turnTtfb }),
  );

  // `let` so the resumed-event handler can swap in a fresh renderer.
  let renderer = buildRenderer();

  // Bridge the session-scoped bashOutputTailReporter to this turn's ToolLane.
  if (h.bashTailSetter) {
    h.bashTailSetter.current = (id, tail) => renderer.setBashOutputTail(id, tail);
  }

  const disposeRendererOnce = (): Promise<void> =>
    doDisposeRendererOnce({ state, h, getRenderer: () => renderer });

  // Hoisted so both initial setup and post-resume swap re-publish the
  // active compositor to completionWriter + SIGINT routing.
  const armAndWire = (): Promise<void> =>
    doArmAndWire({ getRenderer: () => renderer, completionWriter, h });

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
      console.log(); // console-ok
    }

    // Install the per-turn ESC soft-stop handler BEFORE arm() to close the
    // window between arm()'s setInputMode('streaming') and handler installation.
    installTurnHandlers({ h, state, session, getRenderer: () => renderer });

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

    // Sidecar turns persist text + metadata only. The full conversation
    // (tool_use/tool_result content, attachments) lives in the message
    // journal, which is the resume source — see docs/message-journal.md.
    await handleTurnCompletion({
      state,
      stats,
      h,
      toolEvents,
      historyText,
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
    if (h.capturePathRef) syncCapturePathRef(h.capturePathRef, renderer); // must precede dispose (#1505)
    await teardownTurn({ h, completionWriter, pickerRef, disposeRendererOnce });
  }
}

// Footer helpers extracted to turn-handler.footer.ts to keep this file within
// the baseline ceiling. Re-exported so all existing importers keep compiling.
export type { ContextTier } from './turn-handler.footer.js';
export { formatContextUsage, printTurnFooter, printTurnSeparator } from './turn-handler.footer.js';
