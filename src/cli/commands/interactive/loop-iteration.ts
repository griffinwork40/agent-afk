import type { ReadWithAutocompleteResult } from '../../input-box.js';
import { formatSubmittedEcho } from '../../input/echo.js';
import { describeAttachmentSummary, type ImageAttachment } from '../../input/attachments.js';
import { renderDebugBanner } from '../../debug-banner.js';
import { isDebugEnabled } from '../../../utils/debug.js';
import { ringBellIfEnabled } from '../../_lib/capture-mode.js';
import { cyclePermissionMode } from '../../permission-mode-cycle.js';
import {
  autoRegisterPluginPassthroughs,
  getPluginShadowingNoticeLines,
} from '../../slash/plugin-skills.js';
import type { InteractiveCtx } from './shared.js';
import type { TranscriptHandle } from './transcript.js';
import type { InputSurface } from '../../input/input-surface.js';
import type { ReplHistory } from '../../input/history.js';
import { buildPrompt, type TurnState } from './repl-loop-shared.js';
import type { FooterSubsystems } from './footer-subsystems.js';
import { runFirstTurnHookIfNeeded } from './loop-iteration.first-turn.js';
import { prependTurnInjections, autoResumeDirective } from './loop-iteration.injections.js';
import { drainLoopNotifications } from './loop-iteration.drain.js';
import { handleShellPassthrough } from './loop-iteration.shell-branch.js';
import { handleSlashCommand, runPluginPreflight } from './loop-iteration.slash-branch.js';
import { dispatchUserPromptSubmit, dispatchStop } from './loop-iteration.hooks.js';
import { runOneTurn } from './loop-iteration.turn-run.js';
import { createVersionNotice } from './version-notice.js';

/**
 * Per-turn cap on autonomous auto-resumes — an idle REPL woken by a settled
 * background subagent (see the `onInjectable` wiring below). Circuit breaker
 * against a self-perpetuating loop: a woken turn can itself dispatch another
 * background job that settles and re-wakes the session. This bounds that chain
 * within a single turn; the counter resets at the top of each loop iteration
 * so auto-resume works across arbitrarily many turn boundaries.
 */
const MAX_AUTO_RESUMES_PER_TURN = 3;

/**
 * Phase 3 of the REPL loop — the main input loop.
 *
 * Owns the per-loop mutable state (seed buffer, deferred init metadata,
 * first-use notices) and runs the `while (true)` body: notification drain,
 * seed-buffer fast-path, readLine, shell-passthrough dispatch, slash dispatch,
 * plugin-forward preflight, and `runTurn`. Returns when a slash command
 * resolves to `'exit'` (after `ctx.rl.close()`); the caller's `finally` then
 * tears down the surface and footer subsystems.
 *
 * Reads the surface + footer subsystems built by the earlier phases and the
 * `installSoftStop` helper returned by {@link setupSurface}.
 */
export async function runInputLoop(
  ctx: InteractiveCtx,
  transcript: TranscriptHandle,
  turnState: TurnState,
  sigintHandler: () => void,
  surface: InputSurface,
  installSoftStop: (handler: (() => void) | null) => void,
  footer: FooterSubsystems,
  history: ReplHistory,
): Promise<void> {
  const { verdictLedger, bgResultNotifier, peerNotifier } = footer;
  const maxTurnsNum = (() => { const mt = parseInt(ctx.options.maxTurns, 10); return mt > 0 ? mt : undefined; })();

  // Init metadata deferred to loop top so it prints cleanly between turns.
  let pendingInitMeta: string | null = null;
  let pendingShadowingNotices: string[] = [];
  ctx.session.current.waitForInitialization().then(async (meta) => {
    if (isDebugEnabled()) pendingInitMeta = renderDebugBanner(meta);
    await autoRegisterPluginPassthroughs(ctx.session.current);
    if (isDebugEnabled()) pendingShadowingNotices = getPluginShadowingNoticeLines();
  }).catch(() => { /* init / plugin discovery non-critical */ });

  // Slash-command submit queue: pre-seeded from ctx.initialInput when the
  // session was launched with a first-message argument. See original docs.
  let seedBuffer: { text: string; attachments: readonly ImageAttachment[]; echo?: 'normal' | 'silent' } | undefined =
    ctx.initialInput !== undefined ? { text: ctx.initialInput, attachments: [] } : undefined;

  // Rewind reload-for-edit: `/rewind` returns a prefill payload; unlike
  // seedBuffer (auto-submit) this pre-fills the next readLine for editing.
  let prefillBuffer: string | undefined;

  let shellPassthroughNoticePrinted = false;
  // Single-element array so runOneTurn can mutate it via reference.
  const autosaveState: [boolean] = [false];

  // Post-turn Stop-hook correction stashed for next-turn delivery.
  let pendingStopInjection: string | undefined;
  ctx.clearPendingStopInjection = () => { pendingStopInjection = undefined; };

  const versionNotice = createVersionNotice();
  // Auto-resume: wake an idle prompt when bg results or peer messages land.
  let autoResumeCount = 0;
  const tryAutoResume = (): void => {
    if (autoResumeCount >= MAX_AUTO_RESUMES_PER_TURN) return;
    if (!surface.isAwaitingInput() || !surface.bufferIsEmpty()) return;
    if (!bgResultNotifier.hasPendingInjections() && !peerNotifier.hasPendingInjections()) return;
    autoResumeCount++;
    ringBellIfEnabled(process.stdout);
    seedBuffer = { text: autoResumeDirective(bgResultNotifier.hasPendingInjections()), attachments: [], echo: 'silent' };
    surface.abortPendingRead();
  };
  bgResultNotifier.onInjectable = tryAutoResume;
  peerNotifier.onInjectable = tryAutoResume;
  surface.onAwaitingInput = tryAutoResume;

  while (true) {
    autoResumeCount = 0;

    if (pendingInitMeta) {
      ctx.replRenderer.writeLine(pendingInitMeta);
      ctx.replRenderer.writeLine('');
      pendingInitMeta = null;
    }
    if (pendingShadowingNotices.length > 0) {
      for (const line of pendingShadowingNotices) ctx.replRenderer.writeLine(line);
      ctx.replRenderer.writeLine('');
      pendingShadowingNotices = [];
    }
    drainLoopNotifications(ctx, footer);

    let text: string;
    let attachments: ReadWithAutocompleteResult['attachments'];

    // Plan-exit seed: promote a queued exit_plan_mode seed to seedBuffer.
    if (seedBuffer === undefined) {
      const planExit = await ctx.session.current.takePendingPlanExitSeed();
      if (planExit !== undefined) {
        ctx.stats.permissionMode = planExit.mode;
        seedBuffer = { text: planExit.message, attachments: [] };
      }
    }

    if (seedBuffer !== undefined) {
      const queued = seedBuffer;
      seedBuffer = undefined;
      if (queued.echo !== 'silent') {
        const prompt = buildPrompt(ctx.stats.permissionMode, queued.text);
        const echo = formatSubmittedEcho({
          buffer: queued.text,
          promptText: prompt,
          isTTY: Boolean(process.stdout.isTTY),
          attachmentSummary: describeAttachmentSummary([...queued.attachments]),
        });
        ctx.replRenderer.writeLine(echo);
      }
      text = queued.text.trim();
      attachments = queued.attachments as ReadWithAutocompleteResult['attachments'];
    } else {
      const initialBuffer = prefillBuffer;
      prefillBuffer = undefined;
      const result = await surface.readLine({
        promptFn: (buffer) => buildPrompt(ctx.stats.permissionMode, buffer),
        ...(initialBuffer !== undefined ? { initialBuffer } : {}),
        primePromptSuggestion: true,
        onSigint: sigintHandler,
        onShiftTab: () => {
          cyclePermissionMode(ctx.slashCtx).catch(() => {});
          ctx.statusLine.rearm();
        },
      });
      text = result.text.trim();
      attachments = result.attachments;
    }
    // Invariant: await readLine first so idle upgrades are checked before
    // dispatch. writeLine commits above the persistent compositor, never raw
    // stdout while the input overlay owns the cursor. No timer can interrupt it.
    const notice = versionNotice();
    if (notice) ctx.replRenderer.writeLine(notice);
    if (!text && attachments.length === 0) continue;

    // Shell-passthrough branch — `!cmd` foreground / `!&cmd` background.
    if (text.startsWith('!')) {
      const sh = await handleShellPassthrough(text, ctx, footer, shellPassthroughNoticePrinted);
      shellPassthroughNoticePrinted = shellPassthroughNoticePrinted || sh.noticeNowPrinted;
      if (sh.handled) continue;
    }

    // Slash-command branch.
    let isPluginForward = false;
    if (text.startsWith('/')) {
      const slashResult = await handleSlashCommand(
        text, attachments ?? [], ctx, transcript, verdictLedger,
        () => { pendingStopInjection = undefined; },
      );
      if (slashResult.action === 'exit') return;
      if (slashResult.action === 'continue') continue;
      if (slashResult.action === 'submit') {
        seedBuffer = { text: slashResult.message, attachments: attachments ?? [] };
        ctx.statusLine.rearm(); continue;
      }
      if (slashResult.action === 'prefill') {
        prefillBuffer = slashResult.message;
        ctx.statusLine.rearm(); continue;
      }
      // fall-through → plugin-forward path
      isPluginForward = true;
    }

    history.push(text);
    await runFirstTurnHookIfNeeded(ctx, text);

    // Plugin preflight — only on the plugin-forward path.
    let runText = text;
    if (isPluginForward) runText = await runPluginPreflight(text, ctx);

    // Prepend shell/bg/peer injections, then any pending Stop correction.
    runText = prependTurnInjections(runText, [footer.shellPassthrough, bgResultNotifier, peerNotifier]);
    if (pendingStopInjection !== undefined) {
      runText = pendingStopInjection + '\n\n' + runText;
      pendingStopInjection = undefined;
    }

    // Pre-turn UserPromptSubmit hook.
    const ups = await dispatchUserPromptSubmit(runText, ctx);
    if (ups.shouldContinue) continue;
    runText = ups.runText;

    // Execute the model turn.
    // Contract: pass `text` (raw, pre-injection) as rawUserText so the presence
    // activity.promptHead records what the operator typed, never peer message
    // bodies or bg-subagent-result content that are prepended into `runText`.
    const capture = await runOneTurn(
      runText, attachments ?? [], ctx, turnState, footer,
      transcript, surface, installSoftStop, maxTurnsNum, autosaveState, text,
    );

    // Post-turn Stop hook.
    const stopInjection = await dispatchStop(
      ctx, capture.kind, capture.doneHasEvidence, capture.doneClassification,
    );
    if (stopInjection !== undefined) pendingStopInjection = stopInjection;
  }
}
