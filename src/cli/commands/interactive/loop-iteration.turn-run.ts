/**
 * Per-turn executor for the main REPL loop — wires `TurnHandles` and fires
 * `runTurn`. Extracted from `runInputLoop` so the handle-assembly concern
 * lives independently of the loop-sequencing concern.
 *
 * All parameters are explicit; no closure over parent-scope locals.
 *
 * @module cli/commands/interactive/loop-iteration.turn-run
 */

import { enableCodeBlockRegister, resetCodeBlockRegister } from '../../code-block-register.js';
import { MomentumTicker } from './momentum-ticker.js';
import { palette } from '../../palette.js';
import { errorMessage } from '../../../utils/errors.js';
import { formatStatusFields } from './shared.js';
import { buildPrompt } from './repl-loop-shared.js';
import { saveSession } from '../../session-store.js';
import { runTurn } from './turn-handler.js';
import { markPresenceTurn } from './loop-iteration.injections.js';
import type { ImageAttachment } from '../../input/attachments.js';
import type { InteractiveCtx } from './shared.js';
import type { TurnState } from './repl-loop-shared.js';
import type { TranscriptHandle } from './transcript.js';
import type { InputSurface } from '../../input/input-surface.js';
import type { FooterSubsystems } from './footer-subsystems.js';

/**
 * Mutable per-turn verdict capture. Reset before every `runOneTurn` so a
 * verdict-less turn never reuses a stale kind. Written by the `onTerminalState`
 * callback during `runTurn`; read by the caller after `runOneTurn` returns for
 * the post-turn Stop dispatch.
 */
export interface TerminalCapture {
  kind: 'done' | 'blocked' | 'asking' | 'interrupted' | undefined;
  doneHasEvidence: boolean | undefined;
  doneClassification: 'no-code-changes' | 'verified' | 'unverified' | undefined;
}

/**
 * Execute one model turn: enable/reset the code-block register, start the
 * momentum ticker, call `runTurn` with the wired `TurnHandles`, and stop
 * the ticker on completion.
 *
 * Returns the populated `TerminalCapture` for the caller's post-turn Stop
 * dispatch. Always resets `autosaveFailureLogged` via the closure passed in.
 *
 * @param runText           The final user-text (with all injections prepended).
 * @param attachments       Image attachments from the current readline result.
 * @param ctx               Interactive session context.
 * @param turnState         Mutable per-turn compositor / in-flight state.
 * @param footer            Footer subsystems (verdictLedger, loopStageBar, etc.).
 * @param transcript        Transcript handle for onUserMessage / onTurnComplete.
 * @param surface           InputSurface for compositor / handler swaps.
 * @param installSoftStop   Setter for the per-turn ESC soft-stop handler.
 * @param maxTurnsNum       Parsed numeric maxTurns (for status-line display).
 * @param autosaveState     Single-element array holding `autosaveFailureLogged`.
 * @param rawUserText       RAW user-typed text before injections — used for
 *                          `activity.promptHead` in the presence file so peer
 *                          message bodies never leak into presence. Required;
 *                          omitting it would fall back to the composited runText
 *                          and leak peer/bg-injection content into the presence
 *                          file (finding #4 in PR #2850 review).
 */
export async function runOneTurn(
  runText: string,
  attachments: readonly ImageAttachment[],
  ctx: InteractiveCtx,
  turnState: TurnState,
  footer: FooterSubsystems,
  transcript: TranscriptHandle,
  surface: InputSurface,
  installSoftStop: (handler: (() => void) | null) => void,
  maxTurnsNum: number | undefined,
  autosaveState: [autosaveFailureLogged: boolean],
  rawUserText: string,
): Promise<TerminalCapture> {
  const { verdictLedger, loopStageBar, mascotBar, healthRail } = footer;
  const capture: TerminalCapture = { kind: undefined, doneHasEvidence: undefined, doneClassification: undefined };

  // Enable and reset the code-block register so `/copy N` indices match
  // blocks rendered in THIS turn, not a prior one. Idempotent after first call.
  enableCodeBlockRegister();
  resetCodeBlockRegister();

  const momentumTicker = new MomentumTicker((rate) => {
    ctx.statusLine.repaint({
      ...formatStatusFields(ctx.stats, ctx.contextSampler, ctx.gitStatusSampler, maxTurnsNum),
      tokPerSec: rate ?? undefined,
    });
  });
  momentumTicker.start();
  // Contract: pass rawUserText (pre-injection) so activity.promptHead records
  // what the operator typed, never peer message bodies or bg-result content.
  markPresenceTurn(ctx.stats.sessionId, 'busy', rawUserText);

  await runTurn(
    { text: runText, attachments: attachments as ImageAttachment[] },
    ctx.session.current,
    ctx.stats,
    {
      setInFlight(v: boolean) { turnState.turnInFlight = v; },
      ...(ctx.subagentControl ? { subagentControl: ctx.subagentControl } : {}),
      // #2542/#2735: Forward the detach registry so the Ctrl+B handler can
      // free the model's turn while a bash process keeps running.
      ...(ctx.detachRegistry ? { detachRegistry: ctx.detachRegistry } : {}),
      async onUserMessage(userInput) {
        await transcript.appendUser(userInput);
      },
      async onQueuedUserMessage(userInput) {
        await transcript.appendQueuedUser(userInput);
      },
      async onTurnComplete(userInput, assistantText) {
        await transcript.appendTurn(userInput, assistantText);
        if (ctx.stats.sessionId) {
          try {
            saveSession(ctx.stats);
          } catch (err) {
            if (!autosaveState[0]) {
              autosaveState[0] = true;
              ctx.replRenderer.writeLine(
                palette.warning('⚠ ') +
                  'session autosave failed — this conversation may not be resumable: ' +
                  errorMessage(err),
              );
            }
          }
        }
      },
      async onAfterTurn() {
        momentumTicker.stop();
        await ctx.contextSampler.onTurn(ctx.stats.totalTurns);
        await ctx.gitStatusSampler.refresh();
        ctx.statusLine.repaint(formatStatusFields(ctx.stats, ctx.contextSampler, ctx.gitStatusSampler, maxTurnsNum));
        ctx.statusLine.rearm();
        loopStageBar?.repaint('observing');
        healthRail?.update(ctx.stats);
        // Pass totalTurns (post-increment) so resumed sessions seed the correct
        // historical count. Pass rawUserText for first-turn promptHead fallback
        // when sessionId was undefined at turn start.
        markPresenceTurn(ctx.stats.sessionId, 'idle', rawUserText, ctx.stats.totalTurns);
      },
      rearmStatus: () => ctx.statusLine.rearm(),
      onTerminalState: (state, meta) => {
        verdictLedger?.push(state);
        capture.kind = state.kind;
        capture.doneHasEvidence = meta?.doneHasCorroboratingEvidence;
        capture.doneClassification = meta?.doneEvidenceClassification;
      },
      setActiveCompositor: (c) => {
        turnState.activeCompositor = c;
        if (c === null && turnState.interruptPickerAbort) {
          turnState.interruptPickerAbort.abort();
          turnState.interruptPickerAbort = null;
        }
      },
      setInterruptNotifier: (fn) => { turnState.notifyInterrupting = fn; },
      scrollRegion: ctx.statusLine,
      getCompositor: () => surface.getCompositor(),
      setBackgroundHandler: (handler) => surface.setBackgroundHandler(handler),
      setTaskViewHandler: (handler) => surface.setTaskViewHandler(handler),
      setSoftStopHandler: installSoftStop,
      setPausedState: (paused) => surface.setPausedState(paused),
      setPauseInterruptHandler: (handler) => surface.setPauseInterruptHandler(handler),
      async onContextProgress() {
        await ctx.contextSampler.refresh();
        ctx.statusLine.repaint(formatStatusFields(ctx.stats, ctx.contextSampler, ctx.gitStatusSampler, maxTurnsNum));
        healthRail?.update(ctx.stats, ctx.contextSampler.getRatio());
      },
      ...(loopStageBar
        ? {
            onStageChange: (stage, signals) => {
              loopStageBar!.repaint(stage);
              mascotBar?.onStage(stage, signals);
            },
          }
        : {}),
      ...(ctx.addPreviewDiffRef ? { addPreviewDiffRef: ctx.addPreviewDiffRef } : {}),
      bashTailSetter: ctx.bashTailSetter,
      capturePathRef: ctx.capturePathRef,
      onTextDelta: (charCount) => momentumTicker.update(charCount),
    },
    ctx.stats.thinkingUi ?? ctx.options.thinkingUi,
    ctx.completionWriter,
    surface.toRunTurnRefs(buildPrompt(ctx.stats.permissionMode)),
  );

  return capture;
}
