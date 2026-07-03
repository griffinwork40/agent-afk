import type { AgentSession } from '../../../agent/session.js';
import type { SessionStats, ToolEvent } from '../../slash/types.js';
import type { ResponseMetadata } from '../../../agent/types/message-types.js';
import type { OutputEvent, SubagentProgressMeta } from '../../../agent/types.js';
import type { ImageAttachment } from '../../input/attachments.js';
import type { InputSurfaceRefs } from '../../input/input-surface.js';
import { describeForHistory } from '../../input/attachments.js';
import { recordTurn } from '../../slash/session-stats.js';
import { palette } from '../../palette.js';
import { isDebugEnabled } from '../../../utils/debug.js';
import { formatDuration, formatCost, formatTokens } from '../../format-utils.js';
import { usageLimitBox } from '../../render.js';
import { runPicker } from '../../render/picker.js';
import { classifyError, presentError } from '../../errors/index.js';
import { contextLimitFor } from '../../model-limits.js';
import {
  contextRatio,
  type CompletionWriter,
  type ThinkingUiMode,
  type TurnHandles,
} from './shared.js';
import { StreamRenderer } from '../../_lib/stream-renderer.js';
import { createConsoleWriter } from '../../slash/writer.js';
import { ringBellIfEnabled } from '../../_lib/capture-mode.js';
import { runWithSink } from '../../../agent/_lib/skill-sink-channel.js';
import { parseTerminalState, type TerminalState } from './terminal-state.js';
import { renderVerdictCard } from './verdict-card.js';
import { pushTerminalStateToTelegram, doneHasCorroboratingEvidence } from './afk-push.js';
import { loadTelegramConfig } from '../../config.js';
import { buildUserPayload } from '../../slash/_lib/user-payload.js';
import { expandAtFileTokens } from './at-file-inject.js';

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

  let responseText = '';
  // Byte length of `responseText` at the start of the current tool-use round,
  // refreshed each time a tool_result lands (= the boundary after which the
  // next round's text begins). On a mid-stream overload retry (`stream_retry`)
  // the current round re-streams from scratch, so we truncate `responseText`
  // back to this checkpoint to keep the recorded turn + verdict parse free of
  // the duplicated partial text. Prior rounds (before the checkpoint) are
  // untouched — the retry is per-round, not per-turn.
  let roundStartResponseLen = 0;
  let streamingStarted = false;
  let streamErrorRendered = false;
  let rendererDisposed = false;
  let doneFired = false;
  let doneMeta: ResponseMetadata | undefined;
  let softStopRequested = false;
  // Set when the user submits a line DURING a usage-limit pause: the
  // pause-interrupt handler (installed below) ends the auto-resume wait so the
  // queued buffer flushes as the next turn. Like softStopRequested, it ends the
  // turn without a `done` event, so recordTurn is naturally skipped.
  let pauseInterruptRequested = false;
  // AbortController for the interactive usage-limit picker (C). Created when
  // the picker is shown (TTY + autoResume=true); aborted on resumed / pause-
  // interrupt / turn-end so the picker tears down cleanly on every exit path.
  // Stored in an object (not a bare `let`) so TypeScript's control-flow
  // narrowing does not collapse the type to `never` in the finally block after
  // the async .then() assignment — a synchronous read in finally always sees
  // the latest write even though the assignment happens in a microtask.
  const pickerRef: { abort: AbortController | null } = { abort: null };
  let lastContextProgressMs = 0;
  const CONTEXT_PROGRESS_MIN_INTERVAL_MS = 3_000;
  const toolEvents: ToolEvent[] = [];
  const pendingTools = new Map<string, ToolEvent>();

  const activeSkillName = input.text.startsWith('/')
    ? input.text.split(/[\s:]/)[0]?.slice(1)
    : undefined;

  // Ctrl+B handler. Backgrounds the running foreground subagent and nothing
  // else: if a subagent dispatched by THIS turn is running and promotable, it
  // is detached into a /bgsub job and the main turn keeps streaming in the
  // foreground. When no subagent is promotable, Ctrl+B is a deliberate no-op —
  // there is intentionally NO whole-turn detach (the prior behavior was removed
  // per operator decision; the main agent run is never backgrounded wholesale).
  // Promotion is async; we fire-and-forget and commit a confirmation line above
  // the live overlay via completionWriter when each job is adopted.
  const handleBackgroundKey = (): void => {
    const control = h.subagentControl;
    if (!control?.hasPromotableForeground()) return;
    void control
      .promoteActiveForeground()
      .then((jobs) => {
        for (const job of jobs) {
          (completionWriter ?? { fn: console.log }).fn(
            palette.dim(`  → subagent backgrounded as ${job.jobId}: ${job.label}`),
          );
        }
      })
      .catch(() => { /* best-effort UI note; promotion itself already happened */ });
  };

  // Stage 3e: borrow the REPL's persistent compositor when available.
  // The renderer's borrow path skips constructing/disarming its own
  // compositor — instead it flips the borrowed one to streaming mode
  // at arm() and back to idle at dispose() (which also flushes any
  // queued mid-turn submission via the surface's onSubmit handler).
  //
  // When `getCompositor()` returns null — non-TTY, daemon, surfaces
  // that don't arm — the renderer falls back to constructing its own
  // per-turn compositor with the legacy options bag below.
  const borrowedCompositor = h.getCompositor ? h.getCompositor() : null;

  // Factory so we can rebuild a fresh renderer mid-turn after a paused→resumed
  // hot-swap. The provider's auto-resume path replays the entire turn within
  // the same stream (retry-layer.ts: `yield* turnWithAuthRetry(...)`), so the
  // post-resume events must render against a fresh source state — the original
  // renderer was disposed when we printed the "Usage paused" panel above the
  // live overlay, and a disposed renderer's `process()` is a no-op (which
  // would otherwise drop the entire replay silently).
  const buildRenderer = (): StreamRenderer => new StreamRenderer({
    // Route the StreamRenderer's non-TTY fallback writer through
    // `completionWriter` so when the compositor is armed mid-turn (and
    // completionWriter.fn === compositor.commitAbove — see armAndWire below),
    // any always-emitted line from the renderer commits above the overlay
    // instead of tearing it. In TTY mode the compositor takes over rendering
    // anyway, so this is a defensive belt-and-suspenders against future
    // renderer paths that bypass the compositor.
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
    ...(h.subagentControl ? {
      onBackground: handleBackgroundKey,
    } : {}),
    ...(inputSurface?.history ? { history: inputSurface.history } : {}),
    ...(inputSurface?.autocompleteState ? { autocompleteState: inputSurface.autocompleteState } : {}),
    ...(inputSurface?.promptText !== undefined ? { promptText: inputSurface.promptText } : {}),
    // Threads StatusLine.withFullScrollRegion into the compositor so
    // commitAbove's scrollback writes don't get clipped by the persistent
    // DECSTBM sub-region (see terminal-compositor.ts:commitAbove for the
    // contract and ./repl-loop.ts:runTurn-call-site for the wiring).
    ...(h.scrollRegion ? { scrollRegion: h.scrollRegion } : {}),
    ...(borrowedCompositor ? { compositor: borrowedCompositor } : {}),
    // Thread the REPL's LoopStageBar repaint callback so the reserved footer
    // row updates on every stage transition without coupling the bar to the
    // overlay compositor. h.onStageChange is absent on non-REPL callers.
    ...(h.onStageChange ? { onStageChange: h.onStageChange } : {}),
  });

  // `let` (not `const`) so the resumed-event handler can swap in a fresh
  // renderer. All downstream references — disposeRendererOnce, the ambient
  // sink, the post-stream queued-buffer capture — go through this binding.
  let renderer = buildRenderer();

  const disposeRendererOnce = async (): Promise<void> => {
    if (rendererDisposed) return;
    rendererDisposed = true;
    try { await renderer.dispose(); } catch { /* best-effort */ }
  };

  // Hoisted "arm + wire" so both the initial setup and the post-resume swap
  // re-publish the active compositor to completionWriter + SIGINT routing.
  // Without this, after a hot-swap the slash completionWriter would still
  // point at the disposed compositor's commitAbove and SIGINT would fall
  // back to console.log (racing the new compositor's clear/repaint).
  const armAndWire = async (): Promise<void> => {
    await renderer.arm();
    const armedCompositor = renderer.getCompositor();
    if (completionWriter && armedCompositor) {
      const c = armedCompositor;
      completionWriter.fn = (line) => c.commitAbove(line);
    }
    h.setActiveCompositor?.(armedCompositor);
    // Publish a notifier so the SIGINT handler can toggle the live
    // "interrupting…" overlay affordance on the CURRENT renderer. The closure
    // dereferences `renderer` (reassigned on paused→resumed swap), so it always
    // targets the live renderer; cleared in the finally below.
    h.setInterruptNotifier?.((active) => renderer.setInterrupting(active));
    h.rearmStatus?.();
  };

  try {
    // Blank line separating user input from agent output.
    //
    // Two paths — both honor the same external constraint:
    // a raw stdout write into a log-update-tracked region shifts the
    // cursor without updating log-update's line tracker, stranding the
    // previous frame in scrollback (the "ghost spinner" / "stacked
    // prompt" duplication bug).
    //
    // Stage 3e (borrowed compositor): the surface's TerminalCompositor
    // is already armed at REPL startup and stays armed across turns.
    // `renderer.arm()` only flips its input mode — it does NOT (re-)arm
    // log-update. So the pre-arm-vs-post-arm distinction no longer
    // protects us; the compositor's log-update has been tracking stdout
    // continuously since `surface.armCompositor()` ran. Route the blank
    // line through `commitAbove` so it lands above the live overlay and
    // log-update's line count stays consistent.
    //
    // Legacy (own-compositor): `renderer.arm()` constructs and arms a
    // fresh compositor mid-call. A raw `console.log()` BEFORE arm() is
    // safe — no log-update is tracking yet. After arm() it would race
    // the freshly-installed log-update. Keep the original ordering.
    if (borrowedCompositor) {
      borrowedCompositor.commitAbove('');
    } else {
      console.log();
    }

    // Install the per-turn ESC soft-stop handler BEFORE arm() so there is
    // no window between arm()'s setInputMode('streaming') — which resets
    // softStopped=false — and handler installation where an ESC press would
    // fire against a null softStopHandler and silently consume the once-only
    // guard. By wiring the handler first, any ESC that arrives during or
    // after arm() correctly sets softStopRequested=true.
    if (h.setSoftStopHandler) {
      h.setSoftStopHandler(() => {
        softStopRequested = true;
        // Fire interrupt() synchronously on ESC instead of waiting for the
        // for-await loop below to observe `softStopRequested`. During a long
        // tool call the loop is blocked awaiting the stream's next event, so a
        // deferred interrupt would not fire until another token arrived —
        // making ESC look dead for seconds (the "ESC does nothing" symptom).
        // interrupt() is idempotent (AgentSession returns early once state
        // leaves streaming/processing), so the loop's break-path interrupt
        // below remains a safe no-op.
        session.interrupt().catch((err) => {
          if (isDebugEnabled()) {
            console.error('  ' + palette.error('soft-stop session.interrupt() failed:'), err);
          }
        });
        // A turn suspended on a subagent `await` (the parent tool-use loop is
        // parked awaiting the subagent tool_result) cannot be halted by
        // session.interrupt() alone — the parent stream is not what's blocked.
        // Cancel any in-flight foreground subagent so its runToResult resolves,
        // the tool_result flows back, and the for-await loop wakes to observe
        // softStopRequested and stop cleanly — returning the user to the prompt
        // with context intact. Without this, ESC / Ctrl+C are dead for the
        // entire subagent run (up to the 2h usage-limit cap): the "stuck
        // mid-subagent, have to fork the session" bug. Fire-and-forget; the
        // cancel resolves the await that unblocks the loop.
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

    // Install the per-turn pause-interrupt handler. When the user submits a
    // line while the turn is parked in a usage-limit pause (compositor
    // `paused === true`, toggled by setPausedState on the paused/resumed events
    // below), end the auto-resume wait so the just-queued buffer flushes as the
    // next turn. Mirrors the ESC soft-stop interrupt; session.interrupt() is
    // idempotent, so a double Enter during the pause is a safe no-op.
    if (h.setPauseInterruptHandler) {
      h.setPauseInterruptHandler(() => {
        pauseInterruptRequested = true;
        session.interrupt().catch((err) => {
          if (isDebugEnabled()) {
            console.error('  ' + palette.error('pause-interrupt session.interrupt() failed:'), err);
          }
        });
      });
    }

    await armAndWire();

    // Install the per-turn Ctrl+B handler on the surface's persistent
    // compositor (Stage 3e). The surface's armCompositor closure
    // dereferences this ref on every Ctrl+B press, so this takes effect
    // immediately. Cleared in finally so Ctrl+B between turns is a no-op.
    // Installed only when the promotion seam is available (`subagentControl`):
    // Ctrl+B exclusively backgrounds a running foreground subagent — there is
    // no whole-turn detach path anymore.
    if (h.setBackgroundHandler && h.subagentControl) {
      h.setBackgroundHandler(handleBackgroundKey);
    }

    // Expand `@<path>` tokens in the user's text into file-content blocks
    // (tilde/absolute/relative, size+binary+secret guarded — see
    // at-file-inject.ts). The token stays in the text; content rides alongside.
    const { fileBlocks, warnings: atFileWarnings } = expandAtFileTokens(input.text, {
      rootDir: process.cwd(),
    });
    for (const w of atFileWarnings) {
      (completionWriter ?? { fn: console.log }).fn(palette.dim(`  @-file: ${w}`));
    }
    const payload =
      fileBlocks.length > 0 || input.attachments.length > 0
        ? buildUserPayload(input.text, input.attachments, undefined, fileBlocks)
        : input.text;
    const stream = session.sendMessageStream(payload);

    // Install a stable ambient sink that dereferences the CURRENT renderer
    // each call, so any mid-turn subagent (forked via the Skill or Agent
    // tool → SubagentManager.forkSubagent) keeps routing into whichever
    // renderer is live — including after a paused→resumed swap. Subagent
    // events render under synthetic `Agent(<label>)` ToolLane entries; the
    // renderer routes them via meta.subagentId.
    const ambientSink = (event: OutputEvent, meta?: SubagentProgressMeta): void => {
      renderer.process(event, meta);
    };
    await runWithSink(ambientSink, async () => {
      for await (const event of stream) {
        // Invariant: soft-stop stream halt MUST happen before any
        // tool-call flush into session state. Reverse order (flush
        // then halt) risks writing partial state to disk — the stream
        // may still be delivering tool_result chunks, so tool events
        // accumulated so far would be incomplete. The soft-stop handler
        // (installed above) calls session.interrupt() synchronously on
        // ESC, so the pump is already halting before this loop breaks and
        // before the post-stream recordTurn runs. This ordering is
        // externally governed by the event-loop boundary between the HTTP
        // stream pump and the state writer in turn-handler.ts.
        //
        // Implementation: interrupt fires in the handler, NOT here — if it
        // were deferred to this for-await, a long-running tool call (during
        // which this loop is blocked awaiting the next event) would not halt
        // until the next token arrived, making ESC look dead for seconds
        // (the "ESC does nothing" bug). Here we only break: interrupt() was
        // already initiated in the handler, the stream's async iterator
        // terminates naturally (no throw), and the post-stream block detects
        // softStopRequested to render the notice and suppress recordTurn.
        //
        // History consistency: breaking mid-tool-use (e.g. after
        // cancelActiveForeground() resolves a stuck subagent's tool_result)
        // can leave the provider's running history terminating in an assistant
        // `tool_use` whose `tool_result` was never appended — anthropic-direct
        // pushes the assistant turn (loop.ts) BEFORE yielding tool output and
        // appends the tool_result only after. That transient orphan is healed
        // before the NEXT request: repairOrphanToolUses (anthropic-direct
        // query.ts) runs before every new-user-turn append and synthesizes
        // is_error tool_result placeholders, and the abort-path rollback in
        // loop.ts covers the throw case — so the following turn never 400s with
        // "tool_use ids ... without tool_result blocks". The OpenAI-compatible
        // provider appends assistant{tool_calls} + results together (one
        // synchronous block after the yield loop), so it has no orphan window.
        // See PR #400 review + query/repair-orphan-tool-uses.ts.
        if (softStopRequested || pauseInterruptRequested) {
          break;
        }

        if (event.type === 'chunk' && event.chunk.type === 'content') {
          responseText += event.chunk.content;
          streamingStarted = true;
        } else if (event.type === 'message' && !streamingStarted) {
          responseText = event.message.content;
        }

        if (event.type === 'stream_retry') {
          // Mid-stream overload re-drive: the current round re-streams from
          // scratch, so drop its partial text to keep the recorded turn +
          // verdict free of the duplicate. Falls through (no `continue`) to
          // renderer.process(event) below, which resets the live display via
          // handleOrchestratorEvent's `stream_retry` case.
          responseText = responseText.slice(0, roundStartResponseLen);
        }

        if (event.type === 'chunk' && event.chunk.type === 'tool_use_detail') {
          const c = event.chunk;
          const te: ToolEvent = { toolName: c.toolName, toolUseId: c.toolUseId, input: c.toolInput, ...(c.toolInputRaw !== undefined && { inputRaw: c.toolInputRaw }) };
          pendingTools.set(c.toolUseId, te);
          toolEvents.push(te);
        } else if (event.type === 'chunk' && event.chunk.type === 'tool_result') {
          const c = event.chunk;
          // Round boundary: the next round's text appends after this point.
          // Checkpoint so a `stream_retry` truncates back to here, not to 0.
          roundStartResponseLen = responseText.length;
          const pending = pendingTools.get(c.toolUseId);
          if (pending) {
            pending.result = c.content;
            pending.isError = c.isError;
            pendingTools.delete(c.toolUseId);
          }
          if (h.onContextProgress) {
            const now = Date.now();
            if (now - lastContextProgressMs >= CONTEXT_PROGRESS_MIN_INTERVAL_MS) {
              lastContextProgressMs = now;
              try {
                const r = h.onContextProgress();
                if (r instanceof Promise) await r;
              } catch (err) {
                // Best-effort: never let a status refresh break the turn.
                if (isDebugEnabled()) {
                  console.error('  ' + palette.error('onContextProgress (status refresh) failed:'), err);
                }
              }
            }
          }
        }

        if (event.type === 'paused') {
          // Mark the compositor paused so a submitted line ends the wait (via
          // the pause-interrupt handler + input-dispatch Enter path) instead of
          // sitting queued behind the auto-resume. Cleared on resumed / finally.
          h.setPausedState?.(true);
          // Disarm before raw console output so the card doesn't tear the
          // live overlay. Auto-resume path continues — the provider is now
          // waiting; the stream will deliver a 'resumed' event when ready,
          // at which point we rebuild a fresh renderer for the replayed turn.
          await disposeRendererOnce();

          // Invariant: the interactive picker REPLACES the passive card when a
          // TTY compositor is armed (borrowedCompositor != null) AND the
          // provider will auto-resume (autoResume === true) — i.e. there is a
          // live wait to make a decision about. The two are mutually exclusive:
          // showing both would duplicate the same options (prose card + menu).
          // Non-TTY surfaces and autoResume=false fall through to the passive
          // card, which is the only possible surface there.
          if (borrowedCompositor && event.autoResume === true) {
            const ac = new AbortController();
            pickerRef.abort = ac;

            const resetsAtStr = event.resetsAt
              ? event.resetsAt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
              : null;
            // Option labels are referenced both here and in the .then() match
            // below — keep them as consts so the definition and the match can
            // never drift apart.
            const keepLabel = resetsAtStr
              ? `Keep waiting — auto-resumes at ${resetsAtStr}`
              : 'Keep waiting — auto-resume in progress';
            const switchModelLabel = 'Switch model / provider  (type /model after)';
            const stopLabel = 'Stop waiting';

            // Contract: the picker header carries the context the passive card
            // would have shown (limit + reset time) plus the out-of-band
            // account-switch tip — "switch account" is NOT a selectable option
            // because it happens via `claude login` in another terminal during
            // the wait, which the keychain hot-swap picks up automatically.
            // Options are ordered by increasing disruption so the safe default
            // (keep waiting) is first and pre-selected.
            const header = [
              palette.warning('  ⏳ Usage limit reached.') +
                (resetsAtStr ? palette.dim(`  Auto-resumes at ${resetsAtStr}.`) : ''),
              palette.dim('  Tip: run `claude login` in another terminal to switch account — this turn resumes on it automatically.'),
              '',
            ];

            void runPicker(borrowedCompositor, {
              header,
              options: [keepLabel, switchModelLabel, stopLabel],
              signal: ac.signal,
              initialIndex: 0,
            }).then((result) => {
              // Picker resolved — null means aborted (resumed/turn-end tore it
              // down); any result means the user made an explicit choice.
              pickerRef.abort = null;
              if (!result) return; // aborted — no action needed

              const choice = result[0];
              if (choice === undefined || choice === keepLabel) {
                // Keep waiting (or a defensive undefined): the auto-resume path
                // continues unchanged; B's Enter-during-pause path stays live.
                return;
              }

              // Switch model / Stop waiting: end the wait via the pause-interrupt
              // path (same mechanism as B's Enter-during-pause). session.interrupt()
              // ends the stream; pauseInterruptRequested breaks the for-await loop
              // so recordTurn is skipped and the queued buffer flushes next turn.
              pauseInterruptRequested = true;
              if (choice === switchModelLabel) {
                // Cannot pre-fill the input buffer (no public buffer-set API on
                // the compositor), so guide with a printed hint instead.
                (completionWriter ?? { fn: console.log }).fn(
                  palette.dim('  Hint: type /model <name> to switch, then send your message again.'),
                );
              }
              session.interrupt().catch((err) => {
                if (isDebugEnabled()) {
                  console.error('  ' + palette.error('picker pause-interrupt session.interrupt() failed:'), err);
                }
              });
            }).catch((err) => {
              // Defensive: runPicker never rejects, but the .then() body calls
              // completionWriter.fn (→ compositor.commitAbove), which can throw
              // mid-teardown. Swallow outside debug so a throw here can't surface
              // as an unhandled rejection (the REPL has no process-level handler).
              if (isDebugEnabled()) {
                console.error('  ' + palette.error('picker promise rejected:'), err);
              }
            });
          } else {
            // Passive card — the only surface when no interactive picker applies
            // (non-TTY, or autoResume=false where there is no wait to decide on).
            (completionWriter ?? { fn: console.log }).fn(usageLimitBox({
              reason: event.reason,
              ...(event.resetsAt !== undefined ? { resetsAt: event.resetsAt } : {}),
              ...(event.accountId !== undefined ? { accountId: event.accountId } : {}),
              ...(event.autoResume !== undefined ? { autoResume: event.autoResume } : {}),
            }));
          }

          continue;
        }

        if (event.type === 'resumed') {
          // Pause is over (auto-resume / hot-swap). Clear the paused flag so a
          // line typed during the replayed turn queues normally (type-ahead)
          // rather than firing the pause-interrupt.
          h.setPausedState?.(false);
          // Tear down the picker if it's still open — the wait resolved
          // without user intervention (auto-resume / hot-swap won the race).
          pickerRef.abort?.abort();
          pickerRef.abort = null;
          // External constraint: the retry layer replays the ENTIRE turn
          // after this event (retry-layer.ts: `yield* turnWithAuthRetry`),
          // re-streaming all content + tool calls from scratch. We must:
          //   1. Print the resume note before constructing the new renderer
          //      so it lands in scrollback above the fresh compositor.
          //   2. Build + arm a fresh renderer so replay events render visibly
          //      — the original renderer is disposed and its `process()` is a
          //      no-op after dispose, which would have made the replay silent.
          //   3. Reset per-turn accumulators so the responseText, tool events,
          //      and done state reflect ONLY the replay (not the partial
          //      pre-pause turn, which would otherwise double-accumulate).
          // The ambient sink dereferences `renderer` each call, so swapping
          // the binding here automatically reroutes any mid-turn subagent
          // events to the new renderer.
          const note = event.hotSwapped && event.accountId
            ? `▶ Resumed on ${event.accountId}`
            : '▶ Resumed';

          // Reset per-turn accumulators FIRST so the new renderer starts
          // clean. The new compositor + new completionWriter routing
          // (rewired by armAndWire below) ensures the resume note lands
          // above the freshly-armed overlay, not the disposed one.
          responseText = '';
          roundStartResponseLen = 0;
          streamingStarted = false;
          toolEvents.length = 0;
          pendingTools.clear();
          doneFired = false;
          doneMeta = undefined;
          streamErrorRendered = false;

          // Build + arm a fresh renderer for the replayed turn. armAndWire
          // re-points completionWriter.fn at the NEW compositor's
          // commitAbove (the old one was disposed when we printed the
          // "Usage paused" panel above).
          renderer = buildRenderer();
          rendererDisposed = false;
          await armAndWire();

          // Write the resume note AFTER armAndWire so it routes through
          // the freshly-wired completionWriter — which now points at the
          // new compositor's commitAbove and stacks above the live
          // overlay correctly. Writing it before armAndWire would route
          // via the just-disposed compositor's stale commitAbove.
          (completionWriter ?? { fn: console.log }).fn(palette.success(note));
          continue;
        }

        if (event.type === 'error') {
          // Disarm before raw console output so the error box doesn't tear
          // the live overlay. Skip renderer.process (would also emit an
          // errorBox via the writer — duplicate).
          await disposeRendererOnce();
          presentError(classifyError(event.error));
          streamErrorRendered = true;
          continue;
        }

        renderer.process(event);

        if (event.type === 'done') {
          doneFired = true;
          doneMeta = event.metadata;
        }
      }
    });

    // Stage 3e — mid-stream queued buffer is now handled natively by the
    // persistent compositor: dispose() flips to idle mode, which (per
    // the widened setInputMode flush invariant) fires the surface's
    // onSubmit handler when one is installed at next readLine. No
    // explicit queue-text capture needed here. For the legacy
    // renderer-owns-compositor path (non-TTY, no surface borrow), the
    // queued state lives only on the about-to-be-disarmed compositor —
    // those callers don't observe mid-stream queuing anyway because
    // there's no input row in non-TTY mode.
    await disposeRendererOnce();

    // Invariant: ESC soft-stop intent OVERRIDES stream completion. Two
    // cases reach this guard:
    //   (a) Mid-stream ESC: the for-await loop broke at line 225 after
    //       session.interrupt(), doneFired=false. Classic soft-stop.
    //   (b) Late-ESC race: ESC fires AFTER the done event was processed
    //       (doneFired=true) but BEFORE this guard runs — e.g., during
    //       `await disposeRendererOnce()` above, or as a microtask
    //       scheduled by the keypress callback after the done yield.
    //       The for-await loop terminated naturally; doneFired=true and
    //       softStopRequested=true simultaneously.
    // Both cases honor the user's stop intent: render the notice and
    // suppress the completed-turn path (gated below by
    // `!softStopRequested`). Without the gate, late-ESC would silently
    // commit the turn as completed — visible-success-with-silent-stop,
    // exactly the failure mode the soft-stop UX exists to prevent.
    // The SDK's server-side session store preserves the response even
    // when we skip local recordTurn; the REPL session stays live, so the
    // user continues simply by sending the next message — no resume needed.
    // (/resume and --resume operate on *other* /saved sessions, not the
    // live one that was just soft-stopped, so they must NOT be advertised
    // here; doing so sent users down a dead-end. See the onSoftStop doc in
    // terminal-compositor.types.ts: "next Enter starts a new turn in the
    // same session.")
    if (softStopRequested) {
      const write = completionWriter ? completionWriter.fn : console.log;
      // Invariant (TUI rhythm contract): the soft-stop notice owns ONE
      // trailing blank line. The predecessor (last committed paragraph
      // or tool block) already emitted its own trailing blank, so a
      // leading blank here would double-up. See docs/tui-rhythm.md.
      write(palette.warning('⏸ Stopped — work so far kept.') +
        palette.dim('  Send a message to continue.'));
      write('');
    }

    // Pause-interrupt: the user submitted a line during a usage-limit pause to
    // end the wait. The queued buffer flushes as the next turn at the next
    // readLine (idle-transition flush). Gentle note, distinct from ESC's stop.
    if (pauseInterruptRequested) {
      const write = completionWriter ? completionWriter.fn : console.log;
      // Owns one trailing blank (TUI rhythm contract — see docs/tui-rhythm.md).
      write(palette.dim('▶ Ending wait — running your next command…'));
      write('');
    }

    if (doneFired && !softStopRequested && !pauseInterruptRequested) {
      recordTurn(stats, historyText, responseText, doneMeta, toolEvents);

      if (h.onTurnComplete) {
        await h.onTurnComplete(historyText, responseText).catch(() => { /* best-effort */ });
      }

      // Ring the terminal bell on turn completion when enabled (AFK_BELL=1,
      // TTY-only) — an away-from-keyboard completion cue. No-op otherwise.
      ringBellIfEnabled(process.stdout);

      // Stage 3e — post-stream writes between `disposeRendererOnce()` and
      // the finally block run while the borrowed persistent compositor is
      // STILL armed (dispose only flipped it back to idle; the surface
      // owns disarm). Route through `completionWriter.fn`, which the arm
      // path above wired to `compositor.commitAbove` (line ~131) and the
      // finally block restores to `console.log`. For the legacy
      // own-compositor path, `dispose()` already disarmed log-update so
      // raw `console.log` is safe; the writer remains console-bound there
      // either way.
      const writeAbove = (line: string): void => {
        if (completionWriter) {
          completionWriter.fn(line);
        } else {
          console.log(line);
        }
      };

      // Invariant (TUI rhythm contract): under single-owner trailing
      // rhythm, the predecessor block (last streamed paragraph via
      // markdown-stream's `trimmed + '\n\n'`, or the done-time tool
      // flush's trailing blank) already owns its trailing blank. The
      // explicit `writeAbove('\n')` spacer that used to live here would
      // double-up, producing two blank rows between content and the
      // verdict/footer. See docs/tui-rhythm.md.

      // Verdict card. AFK's prompt mandates that every turn end in a named
      // terminal state (Done / Blocked / Asking / Interrupted) with a
      // structured rationale. We parse that out of the assistant text and,
      // when found, render it as a first-class card BEFORE the cost/token
      // footer — the footer is metadata about the turn, the card is the
      // commitment of the turn. Conservative parser: silently skips when
      // the format doesn't match, so the worst case is the previous status
      // quo (just the prose).
      const verdict: TerminalState | null = parseTerminalState(responseText);
      if (verdict) {
        writeAbove(renderVerdictCard(verdict));
        writeAbove('');
        if (h.onTerminalState) {
          try { h.onTerminalState(verdict); } catch { /* ledger update is best-effort */ }
        }
        // AFK mode: the operator is away and the transcript is unwatched, so
        // surface the terminal state to them over Telegram. Scrubbed + rate-
        // limited (afk-push.ts); no-ops when Telegram is unconfigured.
        // Fire-and-forget — outbound notification must never block the turn.
        if (stats.permissionMode === 'autonomous') {
          // Opt-in (telegram.verifyDone): when the turn self-certifies `Done`
          // but produced no corroborating evidence this turn (a successful file
          // write/edit or command — see doneHasCorroboratingEvidence), label the
          // push "⚠️ Done (unverified)" so the away operator isn't pinged a
          // confident "finished" with nothing behind it. Default off; never blocks.
          const unverified =
            verdict.kind === 'done' &&
            loadTelegramConfig().verifyDone === true &&
            !doneHasCorroboratingEvidence(toolEvents);
          void pushTerminalStateToTelegram(verdict, undefined, { unverified });
        }
      }

      printTurnFooter(doneMeta, stats, writeAbove);

      if (h.onAfterTurn) {
        const result = h.onAfterTurn();
        if (result instanceof Promise) {
          await result.catch(() => { /* best-effort */ });
        }
      }
    }
  } catch (error) {
    await disposeRendererOnce();
    if (!streamErrorRendered) {
      presentError(classifyError(error));
    }
  } finally {
    await disposeRendererOnce();
    // Restore the IDLE sink — NOT a hardcoded `console.log`.
    //
    // For the borrowed/persistent compositor path (Stage 3e, set up by
    // `runReplLoop` after `armCompositor`), `idleFn` routes through
    // `compositor.commitAbove`. Between-turn slash output (e.g. `/model
    // foo` → "Unknown model" warning) MUST commit above the live idle
    // overlay rather than write raw at the input row's current cursor
    // position. The previous unconditional `fn = console.log` reset
    // here was the root cause of the `/model claude-opus-4-8` repro:
    // the warning rendered inline at the tail of the echoed input row.
    //
    // For the legacy own-compositor / non-TTY path, `idleFn` stays
    // `console.log` (set at bootstrap and never mutated) — the reset
    // is identical to the old behavior.
    if (completionWriter) completionWriter.fn = completionWriter.idleFn;
    // setActiveCompositor's "active turn" flag is still cleared. For
    // the legacy renderer-own-compositor path, the renderer just
    // disposed its compositor — the SIGINT handler must fall back to
    // its non-compositor branch (prints to console) between turns.
    // For the borrowed (persistent) path, the surface's compositor is
    // still alive but flipped back to idle; clearing the published ref
    // expresses the "no active turn" state, not "no compositor armed."
    // Between turns, handleSigint takes the non-compositor branch and
    // prints to console — correct because no overlay-clear race exists
    // in idle mode.
    h.setActiveCompositor?.(null);
    // Clear the interrupt notifier so between-turn Ctrl+C presses don't toggle
    // an affordance on a disposed renderer.
    h.setInterruptNotifier?.(null);
    // Per-turn Ctrl+B handler is cleared so between-turn presses don't
    // re-trigger backgrounding into a no-longer-existing turn.
    h.setBackgroundHandler?.(null);
    // Per-turn ESC soft-stop handler is cleared so between-turn ESC
    // presses are a no-op (compositor mode gate already drops them in
    // idle; this is a defense-in-depth clear).
    h.setSoftStopHandler?.(null);
    // Clear the pause flag + pause-interrupt handler so a line submitted
    // between turns queues normally (type-ahead) instead of firing the
    // interrupt against a no-longer-paused turn.
    h.setPausedState?.(false);
    h.setPauseInterruptHandler?.(null);
    // Abort the usage-limit picker if still open (e.g. turn ended via error
    // or soft-stop before the user made a choice). Idempotent — safe to call
    // even when the picker already resolved or was never shown.
    pickerRef.abort?.abort();
    pickerRef.abort = null;
    h.setInFlight(false);
    h.rearmStatus?.();
  }
}

export function printTurnFooter(
  meta: { durationMs?: number; totalCostUsd?: number; usage?: Record<string, unknown> } | undefined,
  stats: SessionStats,
  // Optional compositor-aware writer (Stage 3e). When `runTurn` calls
  // this between `disposeRendererOnce()` and the finally block, the
  // borrowed compositor is still armed — a raw `console.log` would
  // corrupt log-update's line tracker and strand the verdict/footer
  // above the live overlay. Defaults to console.log for direct callers
  // that don't have a compositor lifecycle (tests, standalone).
  write: (line: string) => void = console.log,
): void {
  if (!meta) return;
  const parts: string[] = [];
  if (meta.durationMs) parts.push(formatDuration(meta.durationMs));
  if (meta.totalCostUsd !== undefined) parts.push(formatCost(meta.totalCostUsd));
  const inTok = Number(meta.usage?.['input_tokens'] ?? 0);
  const outTok = Number(meta.usage?.['output_tokens'] ?? 0);
  if (inTok + outTok > 0) parts.push(formatTokens(inTok + outTok) + ' tok');
  if (parts.length > 0) {
    write(palette.dim('  ◦ ' + parts.join('  ·  ')));
  }
  const contextPct = contextRatio(stats);
  const contextLimit = contextLimitFor(stats.model);
  if (contextPct >= 1.0) {
    const overByTok = Math.round((contextPct - 1.0) * contextLimit);
    const limitK = Math.round(contextLimit / 1000);
    write(palette.error(
      `  context OVER ${limitK}k tok by ~${formatTokens(overByTok)} tok — model output may be silently truncated`
    ));
  } else if (contextPct > 0.5) {
    const color = contextPct > 0.8 ? palette.error : palette.warning;
    write(color(`  context ${Math.round(contextPct * 100)}% used of ${formatTokens(contextLimit)}`));
  }
  write('');
}
