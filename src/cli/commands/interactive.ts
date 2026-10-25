import { Command } from 'commander';
import { env } from '../../config/env.js';
import ora from 'ora';

import { runCleanupFunctions } from '../../utils/cleanupRegistry.js';
import { activateDumpPrompt } from '../shared-helpers.js';
import { applySharedChatOptions } from './shared-command-options.js';
import { palette } from '../palette.js';
import { setTerminalTitleIfEnabled, formatTerminalTitle } from '../_lib/capture-mode.js';
import { formatCwd } from '../format-cwd.js';
import { bootstrapSession } from './interactive/bootstrap.js';
import { drainBootWarnings } from './interactive/boot-warnings.js';
import { runReplLoop } from './interactive/repl-loop.js';
import { setupWorktree, setupWorktreeDeferred, type WorktreeHandle } from './interactive/worktree.js';
import { bootPruneWorktrees } from './interactive/boot-prune.js';
import { getApiKey } from '../shared-helpers.js';
import { loadConfig } from '../config.js';
import type { CliOptions, InteractiveCtx } from './interactive/shared.js';
import { applyTheme, resolveTheme, resolveThemeMode } from '../theme.js';
import { REPL_SPINNER_OPTIONS } from './interactive/shared.js';
import { handleCommandError } from '../errors/index.js';
import { type UpdateInfo } from '../update-checker.js';
import { resolveWorktreeExitPolicy } from './interactive/worktree-disposition.js';
import { installUnknownCommandGuard, checkBareUnknownCommand } from './interactive/unknown-command-guard.js';

// Lifecycle-phase siblings
import {
  setInteractiveUpdateNotices as _setInteractiveUpdateNotices,
  resolveThinkingUi,
  isAutonameEnabled,
  startupHintLine,
  formatAutonameSkipReason,
} from './interactive/interactive.session-init.js';
import { printExitSummary } from './interactive/interactive.cleanup.js';
import { measurePreArmAnchorRow } from './interactive/interactive.pty-setup.js';

// Extracted helpers (option registration + named action helpers).
import {
  applyInteractiveOptions,
  buildFirstTurnHook,
  buildDispositionResolver,
  registerSessionCleanup,
  wireSessionSubsystems,
  printStartupBanner,
  validateResumeOption,
  resolveWorktreeSetupArg,
} from './interactive.register-helpers.js';

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
  const interactiveCmd = applyInteractiveOptions(
    applySharedChatOptions(
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
    ),
  ).action(async (input: string[], options: CliOptions) => {
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
      if (!validateResumeOption(options, spinner).ok) return;

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
      const worktreeSetupArg = resolveWorktreeSetupArg(branchPrefixOverride, worktreeBaseOverride);

      // Boot-time worktree sweep before setupWorktree so the new worktree
      // isn't judged as a ghost. 1.5s hard budget, silent on failure.
      const bootPrune = await bootPruneWorktrees({ disabled: env.AFK_WORKTREE_BOOT_PRUNE === '0' });

      // Deferred (born-named): auto-named `-w` + autoname enabled + credential.
      // Eager (everything else): explicit branch, autoname off, or no credential.
      const autonameAllowed = isAutonameEnabled(options, cliConfig);
      const apiToken = getApiKey();
      const useDeferredWorktree = options.worktree === true && autonameAllowed && apiToken !== undefined;

      // Mutable ref so helpers (cleanup, disposition) always see the current handle.
      const worktreeHandleRef: { current: WorktreeHandle | undefined } = { current: undefined };
      let worktreeCwd: string | undefined;
      let deferredWorktree: Awaited<ReturnType<typeof setupWorktreeDeferred>> | undefined;

      if (options.worktree !== undefined) {
        try {
          if (useDeferredWorktree) {
            deferredWorktree = await setupWorktreeDeferred(worktreeSetupArg);
            spinner.text = 'Worktree will be named from your first message';
          } else {
            const handle = await setupWorktree(options.worktree, worktreeSetupArg);
            worktreeHandleRef.current = handle;
            worktreeCwd = handle.path;
            spinner.text = `Worktree ready at ${handle.path} (branch: ${handle.branch})`;
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
        ctx.firstTurnHook = buildFirstTurnHook({
          deferred: deferredWorktree,
          apiToken,
          ctx,
          branchPrefixOverride,
          worktreeHandleRef,
        });
      }

      // Invariant: the picker owns raw stdin until it settles, so a signal-driven
      // shutdown MUST be able to cancel it via pickerAbort.
      const pickerAbort = new AbortController();
      ctx.resolveWorktreeDisposition = buildDispositionResolver({
        ctx,
        pickerAbort,
        worktreeExitPolicy,
        worktreeHandleRef,
      });

      // Ordering matters: session close → MCP disconnect → worktree cleanup.
      registerSessionCleanup({ ctx, worktreeHandleRef });

      spinner.succeed('Session ready');
      if (worktreeHandleRef.current !== undefined) {
        console.log(
          palette.dim('  ↪ worktree: ') +
          palette.dim(formatCwd(worktreeHandleRef.current.path, { maxWidth: 60 })) +
          palette.dim(` (branch: ${worktreeHandleRef.current.branch})`),
        );
      } else if (deferredWorktree !== undefined) {
        console.log(palette.dim('  ↪ worktree: named & created from your first message'));
      }

      ctx.exitReasonRef = { current: undefined };
      const { transcript, saveCurrentSession, turnState, handleSigint } =
        await wireSessionSubsystems(ctx, ctx.exitReasonRef, pickerAbort);
      console.log(palette.dim(`  transcript: ${transcript.path()}`));

      // Screen clear then measure the pre-arm anchor row (newlines from
      // banner/notices) so the persistent compositor starts below them.
      process.stdout.write('\x1b[3J\x1b[2J\x1b[H');
      const { anchorRow } = await measurePreArmAnchorRow(() =>
        printStartupBanner({ ctx, worktreeHandleRef, worktreeCwd, bootPruneNotice, bootPruneRemovedCount: bootPrune.removedCount }),
      );

      ctx.preArmAnchorRow = anchorRow;
      setTerminalTitleIfEnabled(process.stdout, formatTerminalTitle(process.cwd(), false));
      ctx.statusLine.start();
      ctx.slashCtx.ui.repaintStatusLine();

      ctx.rl.on('close', async () => {
        ctx.statusLine.stop();
        setTerminalTitleIfEnabled(process.stdout, '');
        // No signal handler wrote exitReason → stdin reached EOF.
        ctx.exitReasonRef!.current ??= 'eof';
        printExitSummary(ctx, worktreeHandleRef.current, saveCurrentSession);
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
