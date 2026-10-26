/**
 * Named helpers for registerInteractiveCommand — extracted to keep
 * interactive.ts under the 200-line AST function ceiling (#3478).
 *
 * All helpers take explicit parameters; none close over enclosing locals.
 */
import { type Command } from 'commander';
import * as path from 'node:path';
import ora from 'ora';

import { palette } from '../palette.js';
import { formatCwd } from '../format-cwd.js';
import { runPicker } from '../render/picker.js';
import { registerCleanup } from '../../utils/cleanupRegistry.js';
import { elicitationRouter } from '../../agent/elicitation-router.js';
import { sleep } from '../../utils/sleep.js';
import { runFirstTurnAutoname } from './interactive/worktree-autoname.js';
import { resolveWorktreeDisposition, type WorktreeExitPolicy } from './interactive/worktree-disposition.js';
import { cancelSessionBackgroundWork, installSignalHandlers, makeSessionSaver } from './interactive/interactive.cleanup.js';
import { REPL_SPINNER_OPTIONS, printResumeBanner } from './interactive/shared.js';
import { parseThinkingUiMode, getAndClearUpdateNotices, startupHintLine } from './interactive/interactive.session-init.js';
import { formatAutonameSkipReason } from './interactive/interactive.session-init.js';
import type { InteractiveCtx } from './interactive/shared.js';
import type { WorktreeHandle, DeferredWorktree } from './interactive/worktree.js';
import { welcomeBanner } from '../render.js';
import { printUpdateBanner } from '../update-checker.js';
import { getVersion } from '../version.js';
import { isFirstRun, printFirstRunBanner } from './interactive/first-run.js';
import { drainBootWarnings } from './interactive/boot-warnings.js';
import { renderStartupRecall } from './interactive/startup-recall.js';
import { renderStartupDashboard } from './interactive/startup-dashboard.js';
import { initTranscript } from './interactive/transcript.js';
import type { TurnState } from './interactive/repl-loop.js';
import type { ExitReasonRef } from './interactive/interactive.signal-handlers.js';
import { resolveResumeTarget } from '../resume-session.js';
import { errorMessage } from '../../utils/errors.js';

// ---------------------------------------------------------------------------
// Option registration
// ---------------------------------------------------------------------------

/**
 * Appends all interactive-only `.option()` declarations to `cmd`.
 * Must be called after `applySharedChatOptions` has already run.
 * Returns the same command for chaining.
 */
export function applyInteractiveOptions(cmd: Command): Command {
  return cmd
    .option('--thinking-ui <mode>', 'Thinking display mode: summary|live|digest|off. Default live. Also: AFK_THINKING_UI env, or interactive.thinkingUi in afk.config.json.', parseThinkingUiMode)
    .option('--debug', 'Show SDK init metadata on startup; enables /debug command', false)
    .option(
      '--worktree-on-exit <ask|keep|remove>',
      'Clean-worktree quit policy. Default: ask on TTY, remove otherwise. Also: AFK_WORKTREE_ON_EXIT, or interactive.worktreeOnExit in afk.config.json.',
    )
    .option(
      '--no-worktree-autoname',
      'Disable mid-session rename of auto-named worktrees from the first user message via haiku. Default on. Also: AFK_WORKTREE_AUTONAME=0, or interactive.worktreeAutoname:false in afk.config.json.',
    )
    .option(
      '--no-shell-passthrough',
      'Disable the ! shell-passthrough feature. When set, inputs beginning with ! are sent to the model as literal text instead of being executed as shell commands. Also: AFK_SHELL_PASSTHROUGH set to 0, false, off, or no.',
    )
    .option(
      '--plain',
      'Force the session to fully behave like a non-TTY surface for rendering: append-only plain-stdout output instead of the live-overlay renderer, AND the input surface downgrades to the simple line reader — even when stdout/stdin ARE a TTY. Full opt-out escape hatch for tmux/SSH/multiplexer sessions. Also: AFK_PLAIN_OUTPUT=1. Non-TTY sessions (pipes, CI) already use this path by default.',
    );
}

// ---------------------------------------------------------------------------
// Deferred-worktree first-turn hook
// ---------------------------------------------------------------------------

export interface FirstTurnHookParams {
  deferred: DeferredWorktree;
  apiToken: string;
  ctx: InteractiveCtx;
  branchPrefixOverride: string | undefined;
  /** Mutable ref updated when the worktree is created. */
  worktreeHandleRef: { current: WorktreeHandle | undefined };
}

/**
 * Returns the async hook to pass as `ctx.firstTurnHook`.
 * Called on the first non-slash REPL message to create the born-named worktree.
 * All captured values are passed explicitly — no closure over action-local vars.
 */
export function buildFirstTurnHook(
  params: FirstTurnHookParams,
): (firstMessage: string) => Promise<void> {
  const { deferred, apiToken, ctx, branchPrefixOverride, worktreeHandleRef } = params;
  return async (firstMessage: string): Promise<void> => {
    const namingSpinner = ora({ text: 'Naming & creating worktree…', ...REPL_SPINNER_OPTIONS }).start();
    const outcome = await runFirstTurnAutoname({
      deferred,
      message: firstMessage,
      token: apiToken,
      session: ctx.session.current,
      ...(branchPrefixOverride !== undefined ? { branchPrefix: branchPrefixOverride } : {}),
    }).finally(() => namingSpinner.stop());
    if (outcome.status === 'created' || outcome.status === 'created-fallback') {
      worktreeHandleRef.current = deferred.handle();
      ctx.stats.cwd = outcome.path;
      const rel = path.relative(process.cwd(), outcome.path) || outcome.path;
      const reasonText = outcome.status === 'created-fallback'
        ? formatAutonameSkipReason(outcome.reason, outcome.detail)
        : undefined;
      const note = reasonText !== undefined ? palette.dim(` — ${reasonText}`) : '';
      console.log(
        palette.dim('  ↪ worktree: ') + `${rel} ` +
        palette.dim(`(branch: ${outcome.branch})`) + note,
      );
    } else {
      console.warn(
        palette.warning('⚠ ') + `Worktree creation failed: ${outcome.reason}. ` +
        palette.dim(`Continuing in ${formatCwd(process.cwd(), { maxWidth: 60 })} (no isolation).`),
      );
    }
  };
}

// ---------------------------------------------------------------------------
// Worktree disposition resolver
// ---------------------------------------------------------------------------

export interface DispositionResolverParams {
  ctx: InteractiveCtx;
  pickerAbort: AbortController;
  worktreeExitPolicy: WorktreeExitPolicy;
  /** Mutable ref so the resolver always sees the current handle. */
  worktreeHandleRef: { current: WorktreeHandle | undefined };
}

/**
 * Builds the `ctx.resolveWorktreeDisposition` function and wires it.
 * Idempotent: repeated calls return the same promise.
 */
export function buildDispositionResolver(
  params: DispositionResolverParams,
): (canPrompt: boolean) => Promise<void> {
  const { ctx, pickerAbort, worktreeExitPolicy, worktreeHandleRef } = params;
  let dispositionResolution: Promise<void> | undefined;
  return (canPrompt: boolean): Promise<void> => {
    if (dispositionResolution !== undefined) return dispositionResolution;
    const compositor = canPrompt ? ctx.slashCtx.getCompositor?.() ?? null : null;
    dispositionResolution = resolveWorktreeDisposition({
      ...(compositor !== null
        ? { picker: (o) => runPicker(compositor, { ...o, signal: AbortSignal.any([pickerAbort.signal, AbortSignal.timeout(30_000)]) }) }
        : {}),
      isTTY: canPrompt && Boolean(process.stdout.isTTY),
      policy: worktreeExitPolicy,
      turnCount: ctx.stats.totalTurns,
      hasWorktree: worktreeHandleRef.current !== undefined,
      console,
    }).then((disposition) => { ctx.worktreeDisposition = disposition; });
    return dispositionResolution;
  };
}

// ---------------------------------------------------------------------------
// Session cleanup registration
// ---------------------------------------------------------------------------

export interface SessionCleanupParams {
  ctx: InteractiveCtx;
  /** Mutable ref so cleanup always sees the current handle. */
  worktreeHandleRef: { current: WorktreeHandle | undefined };
}

/**
 * Registers the session-close cleanup function.
 * Ordering matters: session close → MCP disconnect → worktree cleanup.
 */
export function registerSessionCleanup(params: SessionCleanupParams): void {
  const { ctx, worktreeHandleRef } = params;
  registerCleanup(async () => {
    await ctx.resolveWorktreeDisposition?.(false);
    ctx.teardownTrustedSkillEvents?.();
    elicitationRouter.uninstall();
    ctx.bgSummarizer?.stop();
    // Background subagents, Ctrl+B-detached calls (Invariant:D3) and
    // `bash run_in_background` process jobs all stop with the session.
    await cancelSessionBackgroundWork(ctx);
    await Promise.race([
      ctx.session.current.close(),
      sleep(2000, { unref: true }),
    ]);
    if (ctx.mcpManager) await ctx.mcpManager.disconnectAll();
    ctx.memoryStore.close();
    if (worktreeHandleRef.current !== undefined) {
      await worktreeHandleRef.current.cleanup({ force: ctx.stats.totalTurns === 0, disposition: ctx.worktreeDisposition });
    }
  });
}

// ---------------------------------------------------------------------------
// Session subsystem wiring (transcript, saver, signals, turnState)
// ---------------------------------------------------------------------------

export interface SessionSubsystems {
  transcript: Awaited<ReturnType<typeof initTranscript>>;
  saveCurrentSession: () => string | undefined;
  isSaved: () => boolean;
  turnState: TurnState;
  handleSigint: () => void;
  removeListeners: () => void;
}

/**
 * Wires transcript, session-saver, signal handlers, and turnState.
 * Registers cleanup functions for transcript flush and session sidecar.
 * Returns the subsystem handles the action body needs post-wiring.
 */
export async function wireSessionSubsystems(
  ctx: InteractiveCtx,
  exitReasonRef: ExitReasonRef,
  pickerAbort: AbortController,
): Promise<SessionSubsystems> {
  const transcript = await initTranscript(() => ctx.stats.model);
  registerCleanup(async () => { await transcript.appendEnded(); });
  ctx.setTranscriptPathGetter?.(() => transcript.path());

  const { saveCurrentSession, isSaved } = makeSessionSaver(ctx, exitReasonRef);
  registerCleanup(async () => {
    if (isSaved()) return;
    try { saveCurrentSession(); } catch { /* session-sidecar best-effort */ }
  });

  const turnState: TurnState = { turnInFlight: false, lastSigintAt: 0 };
  ctx.getInFlight = () => turnState.turnInFlight;

  const { handleSigint, removeListeners } = installSignalHandlers({ ctx, turnState, pickerAbort, exitReasonRef });
  registerCleanup(async () => { removeListeners(); });

  return { transcript, saveCurrentSession, isSaved, turnState, handleSigint, removeListeners };
}

// ---------------------------------------------------------------------------
// Startup banner printing (runs inside measurePreArmAnchorRow callback)
// ---------------------------------------------------------------------------

export interface StartupBannerParams {
  ctx: InteractiveCtx;
  worktreeHandleRef: { current: WorktreeHandle | undefined };
  worktreeCwd: string | undefined;
  bootPruneNotice: string | undefined;
  bootPruneRemovedCount?: number;
}

/**
 * Prints all startup banner content: update notices, welcome banner,
 * boot-prune notice, resume banner, first-run banner, boot warnings.
 * Called as the callback to measurePreArmAnchorRow.
 */
export async function printStartupBanner(params: StartupBannerParams): Promise<void> {
  const { ctx, worktreeHandleRef, worktreeCwd, bootPruneNotice, bootPruneRemovedCount } = params;
  const notices = getAndClearUpdateNotices();
  if (notices !== null) {
    if (notices.pendingMessage !== null) process.stderr.write(notices.pendingMessage);
    if (notices.updateInfo !== null) printUpdateBanner(notices.updateInfo);
  }
  const resumeMeta = ctx.resumeTarget
    ? `Resuming ${ctx.resumeTarget.id} · ${ctx.stats.totalTurns} prior turn${ctx.stats.totalTurns === 1 ? '' : 's'}`
    : undefined;
  console.log(welcomeBanner({
    mode: 'Interactive Mode',
    model: ctx.stats.model,
    version: getVersion(),
    ...(worktreeHandleRef.current !== undefined ? { worktree: worktreeHandleRef.current.branch } : {}),
    cwd: worktreeCwd ?? process.cwd(),
    ...(resumeMeta !== undefined ? { metaLine: resumeMeta } : {}),
    hintLine: startupHintLine(),
  }));
  if (bootPruneNotice !== undefined) console.log(palette.dim(`  ${bootPruneNotice}`));

  // Dynamic startup: recall (last session for this cwd) + ambient dashboard.
  const firstRun = isFirstRun();
  const tty = Boolean(process.stdout.isTTY);
  const isResume = ctx.resumeTarget !== undefined;
  const recallLine = renderStartupRecall({
    cwd: worktreeCwd ?? process.cwd(),
    isResume, isTTY: tty, isFirstRun: firstRun,
    currentSessionId: ctx.session.current.sessionId,
  });
  if (recallLine) console.log(recallLine);
  const dashboardLines = await renderStartupDashboard({
    isTTY: tty, isFirstRun: firstRun,
    bootPruneStaleCount: bootPruneRemovedCount,
  });
  for (const line of dashboardLines) console.log(line);

  if (ctx.resumeTarget) await printResumeBanner(ctx.stats, ctx.completionWriter);
  printFirstRunBanner({ isTTY: tty, isResume });
  drainBootWarnings(ctx.bootWarnings);
  console.log();
}

// ---------------------------------------------------------------------------
// Early resume validation
// ---------------------------------------------------------------------------

export interface ResumeValidationResult {
  /** true = validation passed (or no resume option given); false = caller must return. */
  ok: boolean;
}

/**
 * Validates --resume / --continue early — before any side effects — so a bad
 * resume id never leaks a partially-created worktree directory.
 * Writes errors to stderr and sets process.exitCode on failure.
 * Calls spinner.fail on failure.
 */
export function validateResumeOption(
  options: { resume?: string; continue?: boolean },
  spinner: { fail: (msg: string) => void },
): ResumeValidationResult {
  if (!options.resume && !options.continue) return { ok: true };
  try {
    const earlyTarget = resolveResumeTarget({ resume: options.resume, continue: options.continue });
    if (earlyTarget && !earlyTarget.stored) {
      spinner.fail('Session not found');
      process.stderr.write(
        `Error: session not found: ${JSON.stringify(options.resume)}\n` +
          `Run \`afk i\` then \`/resume\` to list saved sessions.\n`,
      );
      process.exitCode = 1;
      return { ok: false };
    }
  } catch (err) {
    spinner.fail('Session not found');
    process.stderr.write(
      `Error: ${errorMessage(err)}\n` +
        `Run \`afk i\` then \`/resume\` to list saved sessions.\n`,
    );
    process.exitCode = 1;
    return { ok: false };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Worktree setup-arg resolution
// ---------------------------------------------------------------------------

/**
 * Derives the worktree setup options object from CLI options, env, and config.
 * Returns undefined when neither branchPrefix nor baseRef is set.
 */
export function resolveWorktreeSetupArg(
  branchPrefixOverride: string | undefined,
  worktreeBaseOverride: string | undefined,
): { branchPrefix?: string; baseRef?: string } | undefined {
  const opts: { branchPrefix?: string; baseRef?: string } = {};
  if (branchPrefixOverride !== undefined) opts.branchPrefix = branchPrefixOverride;
  if (worktreeBaseOverride !== undefined) opts.baseRef = worktreeBaseOverride;
  return Object.keys(opts).length > 0 ? opts : undefined;
}

