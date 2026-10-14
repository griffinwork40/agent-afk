/**
 * Named helpers extracted from `setupSurface` (issue #3478).
 *
 * Each helper takes explicit parameters — no closures over enclosing locals.
 * Ordering invariants (elicitation after armCompositor, compositor wired once,
 * slash-ctx callbacks before the first turn) are enforced at the call-sites in
 * surface-setup.ts, not here.
 */

import { elicitationRouter } from '../../../agent/elicitation-router.js';
import { makeReplElicitationHandler } from '../../elicitation-repl.js';
import { runPicker } from '../../render/picker.js';
import { runTextInput } from '../../render/text-input.js';
import { openEditorForBuffer } from '../../slash/commands/editor-open.js';
import { palette } from '../../palette.js';
import { boundLineToTerminal } from '../../render/bounded-line.js';
import { onQuotaUpdate } from '../../../agent/quota-cache.js';
import { formatStatusFields } from './shared.js';
import type { InteractiveCtx } from './shared.js';
import type { InputSurface } from '../../input/input-surface.js';
import { TerminalCompositor } from '../../terminal-compositor.js';
import type { TranscriptHandle } from './transcript.js';
import type { SurfaceSetupDeps } from './surface-setup.js';

/**
 * Builds and installs the stdin elicitation handler.
 *
 * Invariant: must be called AFTER `surface.armCompositor()` resolves so the
 * handler routes through the compositor's onSubmit path (single stdin consumer)
 * rather than through `rl.question()`. Enforced by call ordering in setupSurface.
 *
 * Also wires the plan-exit queue check onto `ctx` so the exit_plan_mode tool
 * handler can skip the picker when the user has a queued message ready.
 *
 * Returns the installed handler so the caller can expose it on slashCtx for
 * the `/afk on/off` swap primitive.
 */
export function installElicitationHandler(
  ctx: InteractiveCtx,
  surface: InputSurface,
  armedCompositor: TerminalCompositor | null,
): ReturnType<typeof makeReplElicitationHandler> {
  // Wire the plan-exit queue check: when the user has typed ahead a queued
  // message, the exit_plan_mode tool handler skips the elicitation picker so
  // the queued message is delivered first. The predicate is stored on ctx
  // (so resume-swap can re-wire it) and installed on the session via
  // setPlanExitQueueCheck. Only armed when a compositor exists (TTY mode).
  if (armedCompositor) {
    ctx.hasPendingUserMessage = () => armedCompositor.hasPendingSubmission();
    ctx.session.current?.setPlanExitQueueCheck(ctx.hasPendingUserMessage);
  }

  const handler = makeReplElicitationHandler({
    // Elicitation / form / MCP-question sub-prompts deliberately omit
    // `primePromptSuggestion` (defaults false): the user is answering a
    // specific question, so a "what should I do next" ghost over the answer
    // field is off-topic — and it would burn one provider call per field.
    readLine: (prompt) =>
      surface.readLine({ promptFn: () => prompt }).then((r) => r.text),
    writer: {
      line: (text = '') => {
        // Route the question header through the compositor so it commits
        // ABOVE the persistent input row (and survives the DECSTBM repaint
        // cycle). A raw `process.stdout.write` here would race log-update's
        // clear/repaint tick and either get clipped or strand the question
        // mid-frame. Falls back to raw stdout when no compositor is armed
        // (non-TTY) — log-update is not live, so the race does not exist.
        const c = surface.getCompositor();
        if (c) {
          c.commitAbove(text);
        } else {
          process.stdout.write(boundLineToTerminal(text, process.stdout) + '\n');
        }
      },
    },
    pendingCount: () => elicitationRouter.pendingCount(),
    ...(armedCompositor ? {
      pickFromList: (opts) => runPicker(armedCompositor, opts),
      readTextOverlay: (opts) => runTextInput(armedCompositor, opts),
    } : {}),
  });
  elicitationRouter.install(handler);
  return handler;
}

/**
 * Wires the persistent compositor into `ctx.replRenderer`, `ctx.slashCtx`, and
 * `ctx.completionWriter` for the lifetime of the REPL surface.
 *
 * Invariant (Stage 3e): any stdout write between turns MUST route through
 * `compositor.commitAbove` so log-update's tracked-line count stays consistent
 * with actual terminal content. A raw write shifts the cursor without updating
 * the count — the next repaint clears too few lines and strands the previous
 * frame (the "stacked prompt" duplication bug).
 *
 * Non-TTY surfaces (daemon, pipe, tests): `surface.getCompositor()` returns
 * `null` and both completionWriter slots stay at their bootstrap default
 * (`console.log`) — the legacy path is preserved.
 */
export function wireCompositorIntoCtx(
  ctx: InteractiveCtx,
  surface: InputSurface,
): void {
  // Hold the persistent compositor ref on replRenderer for the lifetime of
  // the surface (so writeLine never falls through to raw stdout while armed).
  ctx.replRenderer.setCompositor(surface.getCompositor());
  // Expose the compositor via SlashContext so the built-in-skills bridge can
  // borrow it (see slash/builtin-skills.ts).
  ctx.slashCtx.getCompositor = () => surface.getCompositor();
  // Invariant: Stage 3e idle-mode completionWriter wiring. Setting `idleFn`
  // here keeps the borrowed-compositor wiring alive across turn boundaries
  // (turn-handler.ts's finally resets fn := idleFn after every turn).
  const persistentCompositor = surface.getCompositor();
  if (persistentCompositor) {
    const writeIdle = (line: string) => persistentCompositor.commitAbove(line);
    ctx.completionWriter.fn = writeIdle;
    ctx.completionWriter.idleFn = writeIdle;
  }
}

/**
 * Mirrors TurnHandles.onStageChange / onContextProgress onto SlashContext so
 * skill-dispatch turns drive the same footer rails as normal turns. Also wires
 * the transcript handle, Telegram swap primitive, inputSurfaceRef, git sampler,
 * and quota repaint.
 *
 * `maxTurnsNum` is pre-parsed by the caller (avoids re-parsing on every
 * onContextProgress tick). `stdinHandler` is the installed elicitation handler
 * — exposed so `/afk on/off` can swap it.
 */
export function wireSlashCtxCallbacks(
  ctx: InteractiveCtx,
  surface: InputSurface,
  transcript: TranscriptHandle,
  deps: SurfaceSetupDeps,
  maxTurnsNum: number | undefined,
  stdinHandler: ReturnType<typeof makeReplElicitationHandler>,
): void {
  // Mirror the TurnHandles.onStageChange / onContextProgress wiring onto
  // SlashContext so skill-dispatch turns (`/review`, `/mint`, plugin skills)
  // drive the SAME footer rails as normal turns. Without these, the
  // LoopStageBar stays frozen at "observe" and the status line stays at
  // 0%/$0.00 for the entire skill turn.
  //
  // `getLoopStageBar` is read lazily: the footer subsystems are constructed
  // AFTER this phase, but this closure only fires during a turn — long after
  // the bar exists. Matches the original hoisted-`let loopStageBar` capture.
  ctx.slashCtx.onStageChange = (stage, signals) => {
    deps.getLoopStageBar()?.repaint(stage);
    deps.getMascotBar()?.onStage(stage, signals);
  };
  ctx.slashCtx.onContextProgress = async () => {
    await ctx.contextSampler.refresh();
    await ctx.gitStatusSampler.refresh();
    ctx.statusLine.repaint(formatStatusFields(ctx.stats, ctx.contextSampler, ctx.gitStatusSampler, maxTurnsNum));
  };
  // Transcript parity for skill turns: runSkillDispatchTurn appends the
  // completed `/skill args → assistant text` exchange through this handle,
  // matching the normal-turn append at onTurnComplete in the loop. Without it,
  // skill-turn output is absent from the autosaved markdown transcript.
  ctx.slashCtx.transcript = transcript;
  // AFK bidirectional Telegram (scope.lock criterion 1): expose the surface's
  // stdin elicitation handler + a swap primitive so `/afk on` can install the
  // ledger channel and `/afk off` can restore stdin (`null` → reinstall stdin).
  // The router captures its handler at enqueue time, so swapping mid-session is safe.
  ctx.slashCtx.stdinElicitationHandler = stdinHandler;
  ctx.slashCtx.swapElicitationHandler = (handler) =>
    elicitationRouter.install(handler ?? stdinHandler);
  // Wire the armed surface into the elicitation handler's compositor ref so
  // ask_question suspend/resume can yield stdin raw-mode to rl.question.
  if (ctx.inputSurfaceRef) {
    ctx.inputSurfaceRef.current = surface;
  }
  // Git branch + PR sampler: wire an on-change repaint and kick the initial
  // sample. Deferred to here (REPL Phase 1) rather than bootstrap so a
  // bootstrap-only unit test never shells out to git/gh. The branch resolves
  // in ≈ a local git call and the PR lands when its network lookup settles;
  // onUpdate repaints the status line so both appear without waiting for a turn.
  ctx.gitStatusSampler.setOnUpdate(() => {
    ctx.statusLine.repaint(formatStatusFields(ctx.stats, ctx.contextSampler, ctx.gitStatusSampler, maxTurnsNum));
  });
  void ctx.gitStatusSampler.refresh();
  // Subscription-quota indicator: repaint when the cached quota actually moves.
  // No debounce here on purpose — the cache only notifies when a ROUNDED
  // percentage changes, and `repaint` throttles at 100ms with no trailing flush,
  // so notifying per API response would churn (and sometimes drop) the bottom row.
  // Invariant: this subscription is process-lifetime, exactly like the git
  // sampler's onUpdate above — the quota listener set, the status line and the
  // REPL all die together, so there is no inverse to orphan and no teardown to
  // sequence. Tests that invoke setupSurface more than once must call
  // resetQuotaCacheForTests() to clear the module-scope listener set.
  onQuotaUpdate(() => {
    ctx.statusLine.repaint(formatStatusFields(ctx.stats, ctx.contextSampler, ctx.gitStatusSampler, maxTurnsNum));
  });
}

/**
 * Builds the `onOpenEditor` callback for `armCompositor`. Extracted so the
 * armCompositor options object in `setupSurface` stays compact.
 *
 * Fire-and-forget: the keypress dispatch is synchronous, so we kick off the
 * async editor handoff and swallow rejections rather than blocking dispatch.
 * The handoff reads the live compositor + surfaces notices via commitAbove, so
 * an absent compositor (should never happen once armed) is a safe no-op.
 */
export function buildOpenEditorCallback(
  surface: InputSurface,
  ctx: InteractiveCtx,
): () => void {
  return () => {
    const compositor = surface.getCompositor();
    openEditorForBuffer({
      compositor,
      notify: (kind, message) => {
        // Chords have no `ctx.out`; write the notice above the live input
        // frame. Color by severity to match the REPL writer's conventions.
        const painted =
          kind === 'error' ? palette.error(message)
          : kind === 'warn' ? palette.warning(message)
          : palette.dim(message);
        compositor?.commitAbove(painted);
      },
      // Late-bound: footer subsystems are constructed after this closure is
      // defined, but the chord fires long after bootstrap completes.
      suspendFooter: () => ctx.slashCtx.suspendFooter?.(),
      resumeFooter: () => ctx.slashCtx.resumeFooter?.(),
    }).catch(() => {});
  };
}
