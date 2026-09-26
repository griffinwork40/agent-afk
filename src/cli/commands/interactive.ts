import { Command } from 'commander';
import { env } from '../../config/env.js';
import ora from 'ora';

import * as path from 'node:path';
import { welcomeBanner } from '../render.js';
import { registerCleanup, runCleanupFunctions } from '../../utils/cleanupRegistry.js';
import { activateDumpPrompt } from '../shared-helpers.js';
import { applySharedChatOptions } from './shared-command-options.js';
import { palette } from '../palette.js';
import { setTerminalTitleIfEnabled, formatTerminalTitle } from '../_lib/capture-mode.js';
import { formatCwd } from '../format-cwd.js';
import { bootstrapSession } from './interactive/bootstrap.js';
import { drainBootWarnings } from './interactive/boot-warnings.js';
import { printFirstRunBanner } from './interactive/first-run.js';
import { elicitationRouter } from '../../agent/elicitation-router.js';
import { initTranscript } from './interactive/transcript.js';
import { runReplLoop, type TurnState } from './interactive/repl-loop.js';
import { setupWorktree, setupWorktreeDeferred, type WorktreeHandle, type DeferredWorktree } from './interactive/worktree.js';
import { bootPruneWorktrees } from './interactive/boot-prune.js';
import { runFirstTurnAutoname } from './interactive/worktree-autoname.js';
import { getApiKey } from '../shared-helpers.js';
import { loadConfig } from '../config.js';
import { resolveResumeTarget } from '../resume-session.js';
import type { CliOptions, InteractiveCtx } from './interactive/shared.js';
import { applyTheme, resolveTheme, resolveThemeMode } from '../theme.js';
import { REPL_SPINNER_OPTIONS, printResumeBanner } from './interactive/shared.js';
import { handleCommandError } from '../errors/index.js';
import { type UpdateInfo, printUpdateBanner } from '../update-checker.js';
import { getVersion } from '../version.js';
import { runPicker } from '../render/picker.js';
import {
  resolveWorktreeDisposition,
  resolveWorktreeExitPolicy,
} from './interactive/worktree-disposition.js';
import { installUnknownCommandGuard, checkBareUnknownCommand } from './interactive/unknown-command-guard.js';
import { errorMessage } from '../../utils/errors.js';

// Lifecycle-phase siblings
import {
  setInteractiveUpdateNotices as _setInteractiveUpdateNotices,
  getAndClearUpdateNotices,
  parseThinkingUiMode,
  resolveThinkingUi,
  isAutonameEnabled,
  startupHintLine,
  formatAutonameSkipReason,
} from './interactive/interactive.session-init.js';
import {
  installSignalHandlers,
  printExitSummary,
  snapshotGitStateForCancelAll,
  makeSessionSaver,
} from './interactive/interactive.cleanup.js';
import { measurePreArmAnchorRow } from './interactive/interactive.pty-setup.js';

export { formatToolResultLine } from './interactive/tool-lane.js';

// Re-export pure helpers that callers of interactive.ts may use.
export { formatAutonameSkipReason, isAutonameEnabled, resolveThinkingUi, startupHintLine };

/**
 * Called by `index.ts` before `program.parse()` to stash any update notices
 * that need to survive the interactive screen clear.
 *
 * The screen-clear escape sequence at the start of interactive mode wipes
 * everything written before `program.parse()` — including the update-available
 * banner and the "Updated to vX" message that `index.ts` writes before the
 * parse call. Index.ts calls this to stash those notices so the interactive
 * action can re-emit them after the clear, where they will survive.
 */
export function setInteractiveUpdateNotices(
  updateInfo: UpdateInfo | null,
  pendingMessage: string | null,
): void {
  _setInteractiveUpdateNotices(updateInfo, pendingMessage);
}

export function registerInteractiveCommand(program: Command): void {
  // Build the command with shared options, then append interactive-only flags.
  const interactiveCmd = applySharedChatOptions(
    program
      .command('interactive', { isDefault: true })
      .description('Start interactive chat session')
      .argument(
        '[input...]',
        'Optional first message — or a /slash-command — auto-submitted as the opening turn. ' +
          'E.g. `afk "what does this project do"` or `afk /review`. A bare `afk` starts an empty REPL.',
      ),
    {
      maxTurnsDefault: '100',
      themeDescriptionSuffix: 'Toggle live with /theme.',
      worktreeDescription:
        'Create a git worktree for an isolated session. Optional value sets the branch name; ' +
        'otherwise auto-named. On clean interactive exit, choose whether to keep or delete it; ' +
        'dirty worktrees are always preserved.',
      worktreeBaseDescriptionSuffix:
        ', or interactive.worktreeBase in afk.config.json.',
      dangerouslySkipPermissionsDescription:
        'Force bypass mode (already the default for new installs): skip path-approval prompts; ' +
        'read/write ANY path with no confirmation. Toggle live with Shift+Tab (permission-mode cycle); ' +
        'disable persistently with `afk config set permissionMode default`. Does not affect ask_question.',
    },
  )
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
    )
    .action(async (input: string[], options: CliOptions) => {
      // Issue #710 mode 2: a bare unknown token with no flags (`afk skill`)
      // reaches this action because Commander's default-command swallows it
      // silently. Intercept here — before any side-effect — when the token is
      // a single word close enough to a known subcommand name (Levenshtein ≤ 2).
      const bareCheck = checkBareUnknownCommand(input, program);
      if (bareCheck.isUnknown) {
        const hint = bareCheck.suggestion
          ? `\n\nDid you mean \`afk ${bareCheck.suggestion}\`?`
          : '';
        process.stderr.write(`error: unknown command '${bareCheck.token}'${hint}\n`);
        process.stderr.write(`Run \`afk --help\` for a list of available commands.\n`);
        process.exitCode = 1;
        return;
      }

      if (options.debug) { process.env['AFK_DEBUG'] = '1'; }
      if (options.plain) { process.env['AFK_PLAIN_OUTPUT'] = '1'; }
      activateDumpPrompt(options.dumpPrompt, options.provider);

      const spinner = ora({ text: 'Initializing interactive session...', ...REPL_SPINNER_OPTIONS }).start();

      // Validate --resume / --continue early — before any side effects so a
      // bad resume id never leaks a partially-created worktree directory.
      if (options.resume || options.continue) {
        try {
          const earlyTarget = resolveResumeTarget({ resume: options.resume, continue: options.continue });
          if (earlyTarget && !earlyTarget.stored) {
            spinner.fail('Session not found');
            process.stderr.write(
              `Error: session not found: ${JSON.stringify(options.resume)}\n` +
                `Run \`afk i\` then \`/resume\` to list saved sessions.\n`,
            );
            process.exitCode = 1;
            return;
          }
        } catch (err) {
          spinner.fail('Session not found');
          process.stderr.write(
            `Error: ${errorMessage(err)}\n` +
              `Run \`afk i\` then \`/resume\` to list saved sessions.\n`,
          );
          process.exitCode = 1;
          return;
        }
      }

      const cliConfig = loadConfig();
      const worktreeExitPolicy = resolveWorktreeExitPolicy({
        cli: options.worktreeOnExit,
        env: env.AFK_WORKTREE_ON_EXIT,
        config: cliConfig.interactive?.worktreeOnExit,
        isTTY: Boolean(process.stdout.isTTY),
        console,
      });
      // Resolve persistent defaults (--thinking-ui flag > AFK_THINKING_UI env >
      // config > 'live') and mutate options so bootstrap seeding picks it up.
      options.thinkingUi = resolveThinkingUi(options, cliConfig);
      applyTheme(resolveTheme(resolveThemeMode(options.theme, cliConfig.theme)));

      const branchPrefixOverride = env.AFK_WORKTREE_BRANCH_PREFIX ?? cliConfig.interactive?.worktreeBranchPrefix;
      const worktreeBaseOverride = options.worktreeBase ?? env.AFK_WORKTREE_BASE ?? cliConfig.interactive?.worktreeBase;
      const worktreeSetupOpts: { branchPrefix?: string; baseRef?: string } = {};
      if (branchPrefixOverride !== undefined) worktreeSetupOpts.branchPrefix = branchPrefixOverride;
      if (worktreeBaseOverride !== undefined) worktreeSetupOpts.baseRef = worktreeBaseOverride;
      const worktreeSetupArg = Object.keys(worktreeSetupOpts).length > 0 ? worktreeSetupOpts : undefined;

      // Boot-time worktree sweep before setupWorktree so the new worktree
      // isn't judged as a ghost. 1.5s hard budget, silent on failure.
      const bootPrune = await bootPruneWorktrees({ disabled: env.AFK_WORKTREE_BOOT_PRUNE === '0' });

      // Deferred (born-named): auto-named `-w` + autoname enabled + credential.
      // Eager (everything else): explicit branch, autoname off, or no credential.
      const autonameAllowed = isAutonameEnabled(options, cliConfig);
      const apiToken = getApiKey();
      const useDeferredWorktree = options.worktree === true && autonameAllowed && apiToken !== undefined;

      let worktreeCwd: string | undefined;
      let worktreeHandle: WorktreeHandle | undefined;
      let deferredWorktree: DeferredWorktree | undefined;
      if (options.worktree !== undefined) {
        try {
          if (useDeferredWorktree) {
            deferredWorktree = await setupWorktreeDeferred(worktreeSetupArg);
            spinner.text = 'Worktree will be named from your first message';
          } else {
            worktreeHandle = await setupWorktree(options.worktree, worktreeSetupArg);
            worktreeCwd = worktreeHandle.path;
            spinner.text = `Worktree ready at ${worktreeHandle.path} (branch: ${worktreeHandle.branch})`;
          }
        } catch (err) { spinner.fail('Worktree setup failed'); handleCommandError(err); }
      }

      const bootPruneNotice = bootPrune.ran && bootPrune.removedCount > 0
        ? `Pruned ${bootPrune.removedCount} stale worktree(s). Run /worktree list for details.`
        : undefined;

      // Bootstrap-warning bucket owned HERE so it's reachable even if bootstrap throws.
      const bootWarnings: string[] = [];
      let ctx: InteractiveCtx;
      try {
        ctx = await bootstrapSession(options, {
          bootWarnings,
          ...(worktreeCwd !== undefined ? { cwd: worktreeCwd } : {}),
        });
      } catch (err) {
        // Constraint: fail → drain → exit (handleCommandError is typed `never`).
        spinner.fail('Invalid options');
        drainBootWarnings(bootWarnings);
        handleCommandError(err);
      }

      const seed = input.join(' ').trim();
      if (seed) ctx.initialInput = seed;

      // First-turn worktree hook — born-named creation. Wired only on the
      // deferred path. On the first non-slash message the REPL awaits this
      // hook BEFORE the turn runs, so the worktree is created with its final
      // name before any tool call fires — no race, no directory move.
      if (deferredWorktree !== undefined && apiToken !== undefined) {
        const deferred = deferredWorktree;
        const token = apiToken;
        ctx.firstTurnHook = async (firstMessage: string): Promise<void> => {
          const namingSpinner = ora({ text: 'Naming & creating worktree…', ...REPL_SPINNER_OPTIONS }).start();
          const outcome = await runFirstTurnAutoname({
            deferred,
            message: firstMessage,
            token,
            session: ctx.session.current,
            ...(branchPrefixOverride !== undefined ? { branchPrefix: branchPrefixOverride } : {}),
          }).finally(() => namingSpinner.stop());
          if (outcome.status === 'created' || outcome.status === 'created-fallback') {
            worktreeHandle = deferred.handle();
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

      // Invariant: the picker owns raw stdin until it settles, so a signal-driven
      // shutdown MUST be able to cancel it via pickerAbort.
      const pickerAbort = new AbortController();
      let dispositionResolution: Promise<void> | undefined;
      ctx.resolveWorktreeDisposition = (canPrompt: boolean): Promise<void> => {
        if (dispositionResolution !== undefined) return dispositionResolution;
        const compositor = canPrompt ? ctx.slashCtx.getCompositor?.() ?? null : null;
        dispositionResolution = resolveWorktreeDisposition({
          ...(compositor !== null
            ? { picker: (o) => runPicker(compositor, { ...o, signal: AbortSignal.any([pickerAbort.signal, AbortSignal.timeout(30_000)]) }) }
            : {}),
          isTTY: canPrompt && Boolean(process.stdout.isTTY),
          policy: worktreeExitPolicy,
          turnCount: ctx.stats.totalTurns,
          hasWorktree: worktreeHandle !== undefined,
          console,
        }).then((disposition) => { ctx.worktreeDisposition = disposition; });
        return dispositionResolution;
      };

      // Ordering matters: session close → MCP disconnect → worktree cleanup.
      registerCleanup(async () => {
        await ctx.resolveWorktreeDisposition?.(false);
        ctx.teardownTrustedSkillEvents?.();
        elicitationRouter.uninstall();
        ctx.bgSummarizer?.stop();
        const runningJobs = ctx.backgroundRegistry.list().filter((j) => j.status === 'running');
        if (runningJobs.length > 0) await snapshotGitStateForCancelAll(ctx.stats.cwd ?? process.cwd());
        await ctx.backgroundRegistry.cancelAll().catch(() => { /* best-effort */ });
        await Promise.race([
          ctx.session.current.close(),
          new Promise<void>(resolve => {
            const t = setTimeout(resolve, 2000);
            t.unref();
          }),
        ]);
        if (ctx.mcpManager) await ctx.mcpManager.disconnectAll();
        ctx.memoryStore.close();
        if (worktreeHandle !== undefined) {
          await worktreeHandle.cleanup({ force: ctx.stats.totalTurns === 0, disposition: ctx.worktreeDisposition });
        }
      });

      spinner.succeed('Session ready');
      if (worktreeHandle !== undefined) {
        console.log(
          palette.dim('  ↪ worktree: ') +
          palette.dim(formatCwd(worktreeHandle.path, { maxWidth: 60 })) +
          palette.dim(` (branch: ${worktreeHandle.branch})`),
        );
      } else if (deferredWorktree !== undefined) {
        console.log(palette.dim('  ↪ worktree: named & created from your first message'));
      }

      const transcript = await initTranscript(() => ctx.stats.model);
      console.log(palette.dim(`  transcript: ${transcript.path()}`));
      registerCleanup(async () => { await transcript.appendEnded(); });

      const { saveCurrentSession, isSaved } = makeSessionSaver(ctx);
      registerCleanup(async () => {
        if (isSaved()) return;
        try { saveCurrentSession(); } catch { /* session-sidecar best-effort */ }
      });

      const turnState: TurnState = { turnInFlight: false, lastSigintAt: 0 };
      ctx.getInFlight = () => turnState.turnInFlight;

      const { handleSigint, removeListeners } = installSignalHandlers({ ctx, turnState, pickerAbort });
      registerCleanup(async () => { removeListeners(); });

      // Screen clear then measure the pre-arm anchor row (newlines from
      // banner/notices) so the persistent compositor starts below them.
      process.stdout.write('\x1b[3J\x1b[2J\x1b[H');
      const { anchorRow } = await measurePreArmAnchorRow(async () => {
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
          ...(worktreeHandle !== undefined ? { worktree: worktreeHandle.branch } : {}),
          cwd: worktreeCwd ?? process.cwd(),
          ...(resumeMeta !== undefined ? { metaLine: resumeMeta } : {}),
          hintLine: startupHintLine(),
        }));
        if (bootPruneNotice !== undefined) console.log(palette.dim(`  ${bootPruneNotice}`));
        if (ctx.resumeTarget) printResumeBanner(ctx.stats, ctx.completionWriter);
        printFirstRunBanner({ isTTY: Boolean(process.stdout.isTTY), isResume: ctx.resumeTarget !== undefined });
        drainBootWarnings(ctx.bootWarnings);
        console.log();
      });

      ctx.preArmAnchorRow = anchorRow;
      setTerminalTitleIfEnabled(process.stdout, formatTerminalTitle(process.cwd(), false));
      ctx.statusLine.start();
      ctx.slashCtx.ui.repaintStatusLine();

      ctx.rl.on('close', async () => {
        ctx.statusLine.stop();
        setTerminalTitleIfEnabled(process.stdout, '');
        printExitSummary(ctx, worktreeHandle, saveCurrentSession);
        console.log(palette.info('ℹ ') + 'Goodbye!');
        await runCleanupFunctions();
        process.exit(0);
      });

      await runReplLoop(ctx, transcript, turnState, handleSigint);
    });

  // Issue #710 mode 1: name the unrecognized COMMAND when a mistyped subcommand
  // falls through to this default command.
  installUnknownCommandGuard(interactiveCmd, program);
}
