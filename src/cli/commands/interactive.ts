import { Command } from 'commander';
import { env } from '../../config/env.js';
import ora from 'ora';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { welcomeBanner, divider } from '../render.js';
import { formatDuration, formatCost, formatTokens } from '../format-utils.js';
import { registerCleanup, runCleanupFunctions } from '../../utils/cleanupRegistry.js';
import { getModel } from '../shared-helpers.js';
import { palette } from '../palette.js';
import { saveSession } from '../session-store.js';
import { formatResumeCommand } from '../resume-command.js';
import { formatCwd } from '../format-cwd.js';
import { bootstrapSession } from './interactive/bootstrap.js';
import { elicitationRouter } from '../../agent/elicitation-router.js';
import { initTranscript } from './interactive/transcript.js';
import { runReplLoop, type TurnState } from './interactive/repl-loop.js';
import { setupWorktree, setupWorktreeDeferred, type WorktreeHandle, type DeferredWorktree } from './interactive/worktree.js';
import { bootPruneWorktrees } from './interactive/boot-prune.js';
import { runFirstTurnAutoname, type SkipReason } from './interactive/worktree-autoname.js';
import { getApiKey } from '../shared-helpers.js';
import { loadConfig, type CliConfig } from '../config.js';
import { resolveResumeTarget } from '../resume-session.js';
import type { CliOptions, InteractiveCtx, ThinkingUiMode } from './interactive/shared.js';
import { REPL_SPINNER_OPTIONS, printResumeBanner } from './interactive/shared.js';
import { handleCommandError } from '../errors/index.js';
import { type UpdateInfo, printUpdateBanner } from '../update-checker.js';
import { getVersion } from '../version.js';

export { formatToolResultLine } from './interactive/tool-lane.js';

/**
 * Pending notices to re-emit after the interactive screen clear.
 *
 * The screen-clear escape sequence (`\x1b[3J\x1b[2J\x1b[H`) at the start of
 * interactive mode wipes everything written before `program.parse()` — including
 * the update-available banner and the "Updated to vX" pending-update message
 * that `index.ts` writes before the parse call. Index.ts calls
 * `setInteractiveUpdateNotices` to stash those notices so the interactive
 * action can re-emit them after the clear, where they will survive.
 */
interface UpdateNotices {
  updateInfo: UpdateInfo | null;
  pendingMessage: string | null;
}

let _pendingUpdateNotices: UpdateNotices | null = null;

/**
 * Called by `index.ts` before `program.parse()` to stash any update notices
 * that need to survive the interactive screen clear.
 */
export function setInteractiveUpdateNotices(
  updateInfo: UpdateInfo | null,
  pendingMessage: string | null,
): void {
  _pendingUpdateNotices = { updateInfo, pendingMessage };
}

function parseThinkingUiMode(raw: string): ThinkingUiMode {
  if (raw === 'summary' || raw === 'live' || raw === 'digest' || raw === 'off') {
    return raw;
  }
  throw new Error(`Invalid --thinking-ui value: ${raw}. Expected summary|live|digest|off`);
}

/**
 * Resolve the worktree-autoname enable flag with precedence:
 *   1. `--no-worktree-autoname` CLI flag → false (commander sets
 *      `options.worktreeAutoname = false`)
 *   2. `AFK_WORKTREE_AUTONAME` env: `'0'` / `'false'` → false, else true
 *      when explicitly set
 *   3. `interactive.worktreeAutoname` from `afk.config.json`
 *   4. Default: true
 *
 * The CLI flag is the hard override — passing `--no-worktree-autoname`
 * shuts naming off regardless of env or config.
 */
/**
 * Render the human-readable text for a born-named timestamp-fallback reason.
 *
 * The tags split into two UX classes:
 *
 *  - `empty-message` / `slash-command` — the first turn carried no naming
 *    signal (whitespace, native-handled slash that fell through, or a
 *    plugin-forwarded slash). Return `undefined` to suppress the dim note
 *    in those benign cases.
 *  - `slug-generator-error` / `invalid-slug-output` / `create-failed` /
 *    `unknown` — the haiku call, its output, or the named `git worktree add`
 *    misbehaved. Surface the reason so the operator knows the feature ran and
 *    fell back to the timestamp name (vs. the feature being off).
 *
 * Exported for unit tests.
 */
export function formatAutonameSkipReason(
  reason: SkipReason | 'create-failed' | 'unknown',
  detail: string | undefined,
): string | undefined {
  switch (reason) {
    case 'empty-message':
    case 'slash-command':
      return undefined;
    case 'slug-generator-error':
      return detail ? `slug generation failed: ${detail}` : 'slug generation failed';
    case 'invalid-slug-output':
      return detail
        ? `model returned invalid slug: ${JSON.stringify(detail)}`
        : 'model returned invalid slug';
    case 'create-failed':
      return detail ? `named worktree create failed: ${detail}` : 'named worktree create failed';
    case 'unknown':
    default:
      return 'unknown reason';
  }
}

export function isAutonameEnabled(options: CliOptions, config: CliConfig): boolean {
  if (options.worktreeAutoname === false) return false;
  const envRaw = env.AFK_WORKTREE_AUTONAME;
  if (envRaw !== undefined) {
    const lowered = envRaw.toLowerCase();
    if (lowered === '0' || lowered === 'false' || lowered === 'off' || lowered === 'no') {
      return false;
    }
    return true;
  }
  if (typeof config.interactive?.worktreeAutoname === 'boolean') {
    return config.interactive.worktreeAutoname;
  }
  return true;
}

/**
 * The hint line rendered under the welcome banner at session startup.
 *
 * Kept deliberately short and first-session-oriented: it teaches the handful
 * of controls a newcomer needs on day one (help, switching models, how to
 * interrupt a turn, how to leave). `/resume` is intentionally NOT listed here —
 * it does nothing for a brand-new user (no prior sessions exist to resume), and
 * for a user who IS resuming it is redundant with the "Resuming … · N prior
 * turns" metaLine the banner already shows. `/resume` stays fully discoverable
 * via `/help` and the `--resume` / `--continue` launch flags, so trimming it
 * from the busiest line of the startup screen costs no real capability.
 *
 * Pure + exported so the content is unit-testable without booting a session.
 */
export function startupHintLine(): string {
  return '/help · /model · @ for files · Shift+Tab mode · Esc to interrupt · /exit to quit';
}

export function registerInteractiveCommand(program: Command): void {
  program
    .command('interactive', { isDefault: true })
    .description('Start interactive chat session')
    .option(
      '-m, --model <model>',
      'Model to use. Short aliases: opus|opus_1m|sonnet|sonnet_1m|haiku. ' +
        'Any other value (e.g. `auto` for cursor-api-proxy, or a full `claude-*` ID) passes through to the SDK/proxy untouched.',
      getModel(),
    )
    .option('--max-turns <number>', 'Maximum conversation turns', '100')
    .option('--thinking <mode>', "Thinking mode: 'adaptive' | 'disabled' | 'enabled:<N>'", 'enabled:max')
    .option('--thinking-ui <mode>', 'Thinking display mode: summary|live|digest|off', parseThinkingUiMode, 'live')
    .option('--effort <level>', 'Effort level: low|medium|high|xhigh|max')
    .option('--max-output-tokens <n|max>', "Per-response output cap ('max' = model ceiling). Env: AFK_MAX_OUTPUT_TOKENS")
    .option('--resume <id>', 'Resume a persisted SDK session by id')
    .option('--continue', 'Continue the most recent persisted session in cwd')
    .option('--debug', 'Show SDK init metadata on startup; enables /debug command', false)
    .option(
      '-w, --worktree [branch]',
      'Create a git worktree for an isolated session. Optional value sets the branch name; otherwise auto-named. On clean exit (no uncommitted changes) the worktree and branch are auto-removed; on dirty exit the worktree is preserved.',
    )
    .option(
      '--no-worktree-autoname',
      'Disable mid-session rename of auto-named worktrees from the first user message via haiku. Default on. Also: AFK_WORKTREE_AUTONAME=0, or interactive.worktreeAutoname:false in afk.config.json.',
    )
    .option(
      '--worktree-base <ref>',
      'Base git ref for the worktree created by --worktree. Default: the remote\'s default branch (origin/main), fetched fresh. Pass HEAD to base on your local checkout instead. Also: AFK_WORKTREE_BASE, or interactive.worktreeBase in afk.config.json.',
    )
    .option(
      '--no-shell-passthrough',
      'Disable the ! shell-passthrough feature. When set, inputs beginning with ! are sent to the model as literal text instead of being executed as shell commands. Also: AFK_SHELL_PASSTHROUGH set to 0, false, off, or no.',
    )
    .option('--provider <name>', "Provider to use: anthropic|anthropic-direct|openai|openai-compatible. Default: auto-selected by model")
    .option('--dump-prompt [path]', 'Dump resolved SDK prompt+options+provenance to file (default: ~/.afk/logs/prompt-dump-<ISO>.json) or "stderr"')
    .option('--dangerously-skip-permissions', 'Force bypass mode (already the default for new installs): skip path-approval prompts; read/write ANY path with no confirmation. Toggle live with Shift+Tab (permission-mode cycle); disable persistently with `afk config set permissionMode default`. Does not affect ask_question.')
    .option(
      '--mcp-config <path>',
      'Path to an additional MCP config file (highest priority — merges over ~/.afk/config/mcp.json, project-local .mcp.json, and plugin-contributed configs). File format identical to mcp.json.',
    )
    .action(async (options: CliOptions) => {
      if (options.debug) {
        process.env['AFK_DEBUG'] = '1';
      }

      // --- prompt-dump activation ---
      if (options.dumpPrompt !== undefined) {
        const val: string = options.dumpPrompt === true
          ? path.join(os.homedir(), '.afk', 'logs', `prompt-dump-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
          : String(options.dumpPrompt);
        process.env['AFK_DUMP_PROMPT'] = val;
        // Provider coverage warning: dumpIfEnabled is only wired into AnthropicDirectProvider.
        // openai-compatible and other non-Anthropic providers will not produce a dump file.
        if (options.provider !== undefined && options.provider !== 'anthropic' && options.provider !== 'anthropic-direct') {
          console.error(`[--dump-prompt] WARNING: active provider (${options.provider}) does not support prompt dumping. No file will be written.`);
        }
      }


      const spinner = ora({ text: 'Initializing interactive session...', ...REPL_SPINNER_OPTIONS }).start();

      // Validate --resume / --continue early — before any side effects
      // (worktree setup, bootstrapSession, screen clear). Failure modes:
      //   - `--resume <id>` with unknown id: `resolveResumeTarget` returns
      //     a shell `{ id, resumeId }` without `stored` — we surface as a
      //     friendly error here.
      //   - `--continue` with no saved sessions: `resolveResumeTarget`
      //     THROWS `'No saved sessions found for --continue. ...'` (an
      //     asymmetric failure mode vs. --resume's shell-return). We
      //     catch and re-surface so it doesn't bubble out of the later
      //     `bootstrapSession` call AFTER worktree setup has already
      //     created (and leaked) a worktree directory.
      //   - `--resume <id> --continue` together: also throws ('Use either
      //     ... not both'). Same catch handles it.
      // Resolution is repeated inside `bootstrapSession`; the duplication
      // is intentional and cheap (filesystem read) and keeps every failure
      // path before any worktree side-effect. Mirrors the guard in
      // chat.ts:274–279 with the addition of the catch.
      //
      // The bad value is run through `JSON.stringify` before stderr
      // interpolation so any control bytes the user (or wrapper script)
      // accidentally passed surface as visible `\u001b` escapes instead
      // of being replayed live into their terminal.
      if (options.resume || options.continue) {
        try {
          const earlyTarget = resolveResumeTarget({
            resume: options.resume,
            continue: options.continue,
          });
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
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(
            `Error: ${msg}\n` +
              `Run \`afk i\` then \`/resume\` to list saved sessions.\n`,
          );
          process.exitCode = 1;
          return;
        }
      }

      // Resolve the branch-prefix override from config now so both setup
      // and (later) the first-turn rename use the same value. Env wins
      // over config; both yield to an explicit CLI string in `--worktree`.
      const cliConfig = loadConfig();
      const branchPrefixOverride =
        env.AFK_WORKTREE_BRANCH_PREFIX ??
        cliConfig.interactive?.worktreeBranchPrefix;
      // Base ref for the new worktree (--worktree-base / AFK_WORKTREE_BASE /
      // interactive.worktreeBase). CLI flag wins, then env, then config. When
      // set to a remote ref (origin/main) the worktree is fetched + based on
      // fresh upstream instead of the repo's current HEAD.
      const worktreeBaseOverride =
        options.worktreeBase ??
        env.AFK_WORKTREE_BASE ??
        cliConfig.interactive?.worktreeBase;
      // Shared opts for both the deferred and eager worktree-setup paths.
      // Built incrementally so an unset field is omitted entirely (rather than
      // passed as `undefined`) to satisfy exactOptionalPropertyTypes.
      const worktreeSetupOpts: { branchPrefix?: string; baseRef?: string } = {};
      if (branchPrefixOverride !== undefined) worktreeSetupOpts.branchPrefix = branchPrefixOverride;
      if (worktreeBaseOverride !== undefined) worktreeSetupOpts.baseRef = worktreeBaseOverride;
      const worktreeSetupArg =
        Object.keys(worktreeSetupOpts).length > 0 ? worktreeSetupOpts : undefined;

      // Boot-time worktree sweep — narrow allowlist (empty / orphaned /
      // dead-owner), 1.5s hard budget, silent on failure. Runs BEFORE
      // setupWorktree so the new worktree about to be created isn't
      // sitting in a list of ghost worktrees being judged. Disabled via
      // AFK_WORKTREE_BOOT_PRUNE=0.
      //
      // Constraint: this races against an open spinner. The boot pass
      // returns within its own deadline; we don't await any longer than
      // it permits. The spinner text isn't updated mid-pass to keep boot
      // noise minimal — only a one-line notice after success, and only
      // if removals happened.
      const bootPruneDisabled = env.AFK_WORKTREE_BOOT_PRUNE === '0';
      const bootPrune = await bootPruneWorktrees({ disabled: bootPruneDisabled });

      // Decide eager vs. deferred (born-named) worktree creation BEFORE setup.
      //   - Deferred: auto-named `-w` (no explicit branch) + autoname enabled +
      //     an Anthropic credential available. The worktree is created on the
      //     first message, with its final slug name — never `git worktree
      //     move`d (the move-during-turn-1 race was a session-killing bug).
      //   - Eager (everything else): explicit `--worktree <branch>`, autoname
      //     disabled, or no credential → create at startup as before.
      const autonameAllowed = isAutonameEnabled(options, cliConfig);
      const apiToken = getApiKey();
      const useDeferredWorktree =
        options.worktree === true && autonameAllowed && apiToken !== undefined;

      let worktreeCwd: string | undefined;
      // Set once the worktree exists: eager → at startup; deferred → by the
      // first-turn hook. The shutdown cleanup closure reads this at invocation
      // time, so a deferred worktree created mid-session is still cleaned up,
      // and a never-materialized one (zero-turn exit) is correctly skipped.
      let worktreeHandle: WorktreeHandle | undefined;
      let deferredWorktree: DeferredWorktree | undefined;
      if (options.worktree !== undefined) {
        try {
          if (useDeferredWorktree) {
            // Validate the repo root + ensure the .gitignore entry now so the
            // "not in a git repo" failure is still caught fail-fast at startup;
            // only the `git worktree add` is deferred. Bootstrap in the launch
            // cwd (worktreeCwd stays undefined) until the first message.
            deferredWorktree = await setupWorktreeDeferred(worktreeSetupArg);
            spinner.text = 'Worktree will be named from your first message';
          } else {
            worktreeHandle = await setupWorktree(options.worktree, worktreeSetupArg);
            worktreeCwd = worktreeHandle.path;
            spinner.text = `Worktree ready at ${worktreeHandle.path} (branch: ${worktreeHandle.branch})`;
          }
        } catch (err) {
          spinner.fail('Worktree setup failed');
          handleCommandError(err);
        }
      }

      // Surface the boot-prune notice once the spinner is finished but
      // before the welcome banner renders, so it appears in the user's
      // scrollback as a discrete line and not on top of any other status.
      // Silent when nothing happened.
      const bootPruneNotice =
        bootPrune.ran && bootPrune.removedCount > 0
          ? `Pruned ${bootPrune.removedCount} stale worktree(s). Run /worktree list for details.`
          : undefined;

      let ctx: InteractiveCtx;
      try {
        ctx = await bootstrapSession(options, worktreeCwd !== undefined ? { cwd: worktreeCwd } : undefined);
      } catch (err) {
        spinner.fail('Invalid options');
        handleCommandError(err);
      }

      // First-turn worktree hook — born-named creation. Wired only on the
      // deferred path (set above iff auto-named `-w` + autoname enabled +
      // credential). On the first non-slash message the REPL awaits this hook
      // BEFORE the turn runs (see InteractiveCtx.firstTurnHook contract), so
      // the worktree is created with its final name and the session cwd is
      // moved into it before any tool call fires — no race, no directory move.
      if (deferredWorktree !== undefined && apiToken !== undefined) {
        const deferred = deferredWorktree;
        const token = apiToken;
        ctx.firstTurnHook = async (firstMessage: string): Promise<void> => {
          // Surface the ~1-2s slug haiku + `git worktree add` so the pre-turn
          // wait doesn't read as a hang. The compositor is not armed yet (the
          // hook is awaited before runTurn), so a plain ora spinner is safe.
          const namingSpinner = ora({ text: 'Naming & creating worktree…', ...REPL_SPINNER_OPTIONS }).start();
          const outcome = await runFirstTurnAutoname({
            deferred,
            message: firstMessage,
            token,
            session: ctx.session.current,
            ...(branchPrefixOverride !== undefined ? { branchPrefix: branchPrefixOverride } : {}),
          }).finally(() => namingSpinner.stop());
          if (outcome.status === 'created' || outcome.status === 'created-fallback') {
            // Adopt the freshly-created handle so the shutdown cleanup closure
            // can preserve (dirty) or remove (clean / zero-turn) the worktree.
            worktreeHandle = deferred.handle();
            // Point session stats at the worktree too, so plugin-skill
            // preflights (which run with `cwd: stats.cwd`) and the saved-session
            // sidecar record the worktree rather than the launch cwd.
            ctx.stats.cwd = outcome.path;
            const rel = path.relative(process.cwd(), outcome.path) || outcome.path;
            if (outcome.status === 'created') {
              console.log(
                palette.dim('  ↪ worktree: ') +
                  `${rel} ` +
                  palette.dim(`(branch: ${outcome.branch})`),
              );
            } else {
              // Slug skipped or its named create failed → timestamp name. Show
              // why when the model/network misbehaved; stay quiet for the
              // benign empty/slash signals.
              const reasonText = formatAutonameSkipReason(outcome.reason, outcome.detail);
              const note = reasonText !== undefined ? palette.dim(` — ${reasonText}`) : '';
              console.log(
                palette.dim('  ↪ worktree: ') +
                  `${rel} ` +
                  palette.dim(`(branch: ${outcome.branch})`) +
                  note,
              );
            }
          } else {
            // status === 'failed' — even the timestamp fallback couldn't be
            // created (disk full, permissions). The session has no worktree;
            // it continues in the launch cwd, so isolation is lost. Loud.
            console.warn(
              palette.warning('⚠ ') +
                `Worktree creation failed: ${outcome.reason}. ` +
                palette.dim(`Continuing in ${formatCwd(process.cwd(), { maxWidth: 60 })} (no isolation).`),
            );
          }
        };
      }
      // Ordering matters: shut the SDK subprocess down BEFORE removing the
      // worktree directory. Cleanups run via `Promise.all`, so we sequence
      // session close → worktree cleanup inside a single registered cleanup.
      registerCleanup(async () => {
        ctx.teardownTrustedSkillEvents?.();
        // Uninstall the elicitation handler so in-flight ask_question calls
        // auto-decline rather than routing to a closed readline interface.
        elicitationRouter.uninstall();
        // Stop the background summarizer BEFORE cancelling jobs so any
        // in-flight Haiku calls are aborted cleanly before the registry drains.
        ctx.bgSummarizer?.stop();
        // Cancel any still-running background subagents BEFORE closing the
        // session: cancelAll() goes through SubagentHandle.cancel() which
        // depends on the parent's AbortGraph wiring, which session.close()
        // tears down. Background jobs are cancel-by-default on parent
        // teardown — there is no detach mechanism in v1.
        await ctx.backgroundRegistry.cancelAll().catch(() => { /* best-effort */ });
        await ctx.session.current.close();
        // MCP disconnect AFTER session close so the session can't issue
        // more tool calls into a torn-down client. BEFORE worktree cleanup
        // because some stdio MCP servers may have cwd anchored under the
        // worktree (removing the dir while the child is still alive is a
        // hang risk on macOS). Best-effort — disconnectAll() never throws.
        if (ctx.mcpManager) {
          await ctx.mcpManager.disconnectAll();
        }
        ctx.memoryStore.close();
        if (worktreeHandle !== undefined) {
          await worktreeHandle.cleanup({ force: ctx.stats.totalTurns === 0 });
        }
      });

      spinner.succeed('Session ready');

      // Item #1: Persist worktree context past the spinner so it survives in
      // scrollback. spinner.succeed() replaces the text set on line ~155
      // ("Worktree ready at …"), silently discarding it. Emit a static line
      // immediately after so the operator can always see which branch they're on.
      // External constraint: must come AFTER spinner.succeed so we don't race
      // the ora line-clearing flush.
      if (worktreeHandle !== undefined) {
        console.log(
          palette.dim('  ↪ worktree: ') +
            palette.dim(formatCwd(worktreeHandle.path, { maxWidth: 60 })) +
            palette.dim(` (branch: ${worktreeHandle.branch})`),
        );
      } else if (deferredWorktree !== undefined) {
        // Deferred (born-named): the worktree is created from the first
        // message. Tell the operator so the absence of a worktree line at
        // startup isn't mistaken for `-w` having silently failed.
        console.log(palette.dim('  ↪ worktree: named & created from your first message'));
      }

      // Autosaved markdown transcript. Per-turn appends happen inside
      // runTurn via the REPL loop's onTurnComplete; `/clear` rotates to
      // a new file via the handle; graceful exit writes an `_ended_`
      // footer via cleanup.
      const transcript = await initTranscript(() => ctx.stats.model);
      console.log(palette.dim(`  transcript: ${transcript.path()}`));
      registerCleanup(async () => { await transcript.appendEnded(); });

      // Autosave a session sidecar on graceful close so `/resume` can
      // discover it. Guard on totalTurns > 0 to avoid cluttering the
      // resume list with empty sessions that had no user input.
      let sessionSavedOnExit = false;
      const saveCurrentSession = (): string | undefined => {
        if (ctx.stats.totalTurns === 0) return undefined;
        const savedPath = saveSession(ctx.stats);
        sessionSavedOnExit = true;
        return savedPath;
      };
      registerCleanup(async () => {
        if (sessionSavedOnExit) return;
        try { saveCurrentSession(); } catch { /* session-sidecar best-effort */ }
      });

      // Ctrl+C state: first press interrupts in-flight turn, second within window exits.
      const turnState: TurnState = { turnInFlight: false, lastSigintAt: 0 };
      // Expose in-flight state to the swap closure so it can refuse mid-turn resumes.
      ctx.getInFlight = () => turnState.turnInFlight;
      const SIGINT_EXIT_WINDOW_MS = 1500;
      const handleSigint = () => {
        const now = Date.now();
        // Priority 1 — foreground `!cmd` shell. Set by the REPL while a
        // FG shell is in flight; the closure kills the shell's process
        // group and clears its FG slot, returning true. We swallow the
        // signal so the exit-cycle below doesn't also fire.
        if (turnState.tryAbortShellForeground && turnState.tryAbortShellForeground()) {
          turnState.lastSigintAt = now;
          return;
        }
        if (turnState.turnInFlight) {
          // First Ctrl+C during a turn = ESC soft-stop: stop cleanly, keep
          // completed work, and preserve the typed draft (the compositor no
          // longer auto-queues it on Ctrl+C). requestSoftStop sets
          // softStopRequested + interrupts, so the turn handler renders the
          // "⏸ Stopped — work so far kept" notice and skips recordTurn exactly
          // as ESC does. Falls back to a bare interrupt when no soft-stop
          // handler is published (non-REPL turn, or a gap between turns).
          if (turnState.requestSoftStop) {
            turnState.requestSoftStop();
          } else {
            ctx.session.current.interrupt().catch(() => { /* swallow during teardown */ });
          }
          turnState.lastSigintAt = now;
          // Surface a live "interrupting…" affordance in the overlay. The
          // renderer owns the OverlayComposer; this notifier was published by
          // the turn handler at arm time (null between turns → no-op).
          turnState.notifyInterrupting?.(true);
          // The "⏸ Stopped — work so far kept" notice prints from the turn
          // handler (the soft-stop path). Here we add ONLY the exit affordance:
          // a second Ctrl+C within SIGINT_EXIT_WINDOW_MS quits. Route it
          // through the active compositor's commitAbove when available — that
          // path clears the live overlay, writes the line into scrollback, and
          // repaints the overlay below, so the notice survives subsequent
          // log-update clears. A bare console.log races the still-armed
          // compositor's spinner-tick repaints and can be erased first.
          const msg = '\n' + palette.info('ℹ ') + 'Press Ctrl+C again to exit.';
          const c = turnState.activeCompositor;
          if (c && c.isArmed()) {
            try { c.commitAbove(msg); } catch { console.log(msg); }
          } else {
            console.log(msg);
          }
          return;
        }
        if (now - turnState.lastSigintAt < SIGINT_EXIT_WINDOW_MS) {
          // Pre-abort before rl.close() so deriveClosureReason sees 'sigint'
          // (a non-'closed' reason) and returns 'abort' instead of 'model_end_turn'.
          ctx.session.current?.abort('sigint');
          ctx.rl.close();
          return;
        }
        turnState.lastSigintAt = now;
        console.log('\n' + palette.info('ℹ ') + 'Press Ctrl+C again (or /exit) to quit.');
      };
      process.on('SIGINT', handleSigint);
      registerCleanup(async () => { process.removeListener('SIGINT', handleSigint); });

      // SIGTERM handler: graceful shutdown on container/init-system kill so
      // the witness layer's session_sealed + closure events still land.
      // Without this, the session is hard-killed and the trace ends mid-
      // stream (no terminal record), which a reader interprets as
      // sealed-crashed. Idempotency: a second SIGTERM during teardown is
      // a no-op (the cleanup registry clears itself on first run).
      let sigtermInFlight = false;
      const handleSigterm = (): void => {
        if (sigtermInFlight) return;
        sigtermInFlight = true;
        // Pre-abort before rl.close() so deriveClosureReason sees 'sigterm'
        // (a non-'closed' reason) and returns 'abort' instead of 'model_end_turn'.
        ctx.session.current?.abort('sigterm');
        // Close readline first so any in-progress prompt unwinds before
        // we close the session and run cleanups. rl.on('close') will
        // also fire and trigger the standard exit path; the guard above
        // prevents double-invocation.
        try { ctx.rl.close(); } catch { /* best-effort */ }
        // Belt-and-suspenders: if rl.on('close') doesn't reach the exit
        // path within a short window (e.g. when the REPL loop is awaiting
        // a long-running turn), run cleanups directly and exit.
        const GRACE_MS = 2000;
        setTimeout(() => {
          runCleanupFunctions().finally(() => process.exit(0));
        }, GRACE_MS).unref();
      };
      process.on('SIGTERM', handleSigterm);
      registerCleanup(async () => { process.removeListener('SIGTERM', handleSigterm); });

      // SIGHUP handler: terminal-disconnect graceful shutdown. Fires when the
      // controlling terminal goes away — macOS Terminal window closed, SSH
      // dropped, tmux session killed — at which point Node's default action
      // is immediate process termination with no cleanup. Without this
      // handler, readline never fires 'close', `session.close()` is never
      // called, and the trace ends mid-stream with no `closure` event.
      // Statistically the dominant cause of unsealed traces (see witness
      // data analysis 2026-05-25). Mirrors the SIGTERM handler shape: same
      // guard variable, same rl.close() + 2s grace + forced exit.
      let sighupInFlight = false;
      const handleSighup = (): void => {
        if (sighupInFlight) return;
        sighupInFlight = true;
        // Pre-abort before rl.close() so deriveClosureReason sees 'sighup'
        // (a non-'closed' reason) and returns 'abort' instead of 'model_end_turn'.
        ctx.session.current?.abort('sighup');
        try { ctx.rl.close(); } catch { /* best-effort */ }
        const GRACE_MS = 2000;
        setTimeout(() => {
          runCleanupFunctions().finally(() => process.exit(0));
        }, GRACE_MS).unref();
      };
      process.on('SIGHUP', handleSighup);
      registerCleanup(async () => { process.removeListener('SIGHUP', handleSighup); });

      process.stdout.write('\x1b[3J\x1b[2J\x1b[H');

      // Invariant: cursor is at (1,1) after the CUP-home (`\x1b[H`) above.
      // We need to know which row the cursor lands on AFTER the pre-arm
      // print block (banner + update notice + boot-prune notice + blank
      // line) so the persistent compositor can install that as its
      // `anchorRow` — the floor below which its CUP-positioned live frame
      // is allowed to grow without overwriting pre-arm content. Easiest
      // accurate measurement: monkey-patch stdout/stderr `write` for the
      // duration of these prints and count `\n` bytes that pass through.
      // The restore in the `finally` is unconditional so a thrown banner
      // formatter can never strand the patch on the global streams.
      //
      // Why both streams: `printUpdateBanner` writes to stderr and the
      // banner writes to stdout, but both advance the same terminal cursor
      // (they share the TTY). Counting only one stream would undershoot.
      let preArmAnchorRow = 1; // cursor row after `\x1b[H`
      const origStdoutWrite = process.stdout.write.bind(process.stdout);
      const origStderrWrite = process.stderr.write.bind(process.stderr);
      const countNewlines = (chunk: unknown): number => {
        const s = typeof chunk === 'string'
          ? chunk
          : (chunk instanceof Uint8Array ? Buffer.from(chunk).toString('utf8') : String(chunk));
        return (s.match(/\n/g)?.length ?? 0);
      };
      const wrapWrite = (orig: typeof process.stdout.write): typeof process.stdout.write =>
        ((chunk: unknown, ...rest: unknown[]): boolean => {
          preArmAnchorRow += countNewlines(chunk);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (orig as any)(chunk, ...rest);
        }) as typeof process.stdout.write;
      process.stdout.write = wrapWrite(origStdoutWrite);
      process.stderr.write = wrapWrite(origStderrWrite);

      try {
        // Re-emit update notices that were stashed before program.parse() — the
        // screen clear above erases anything written to stderr/stdout before this
        // point, so index.ts cannot print these directly.
        if (_pendingUpdateNotices !== null) {
          const { updateInfo, pendingMessage } = _pendingUpdateNotices;
          _pendingUpdateNotices = null;
          if (pendingMessage !== null) {
            process.stderr.write(pendingMessage);
          }
          if (updateInfo !== null) {
            printUpdateBanner(updateInfo);
          }
        }

        // Banner: hybrid mascot layout. The worktree row is emitted only when
        // running in a worktree session — surfaces AFK's most distinctive
        // feature without cluttering plain-cwd sessions. `cwd` reflects the
        // bootstrap'd session cwd (worktree path when applicable). When
        // /resume restored a prior session, surface the resume target +
        // prior-turn count via metaLine (Row E of the hybrid layout).
        const resumeMeta = ctx.resumeTarget
          ? `Resuming ${ctx.resumeTarget.id} · ${ctx.stats.totalTurns} prior turn${ctx.stats.totalTurns === 1 ? '' : 's'}`
          : undefined;
        console.log('\n' + welcomeBanner({
          mode: 'Interactive Mode',
          model: ctx.stats.model,
          version: getVersion(),
          ...(worktreeHandle !== undefined ? { worktree: worktreeHandle.branch } : {}),
          cwd: worktreeCwd ?? process.cwd(),
          ...(resumeMeta !== undefined ? { metaLine: resumeMeta } : {}),
          hintLine: startupHintLine(),
        }));
        // Surface boot-time prune outcome AFTER the banner so it lives at the
        // same scrollback rank as the status line — close enough to be seen,
        // not noisy enough to compete with welcome chrome.
        if (bootPruneNotice !== undefined) {
          console.log(palette.dim(`  ${bootPruneNotice}`));
        }
        // When resuming, surface a brief "where was I" cue (last user message
        // + first sentence of last assistant reply + /history pointer) so a
        // human reorienting in the wiped terminal has anchor context. Skips
        // silently for fresh sessions and for stored sessions with empty
        // turns arrays. Routes through ctx.completionWriter — at this point
        // the persistent compositor is not yet armed (runReplLoop will arm
        // it), so writer.fn is still the default console.log. See
        // printResumeBanner's docblock for the writer-transport rationale.
        // Emitted inside this try so its newlines are counted into
        // preArmAnchorRow — the compositor must arm BELOW this content.
        if (ctx.resumeTarget) {
          printResumeBanner(ctx.stats, ctx.completionWriter);
        }
        console.log();
      } finally {
        process.stdout.write = origStdoutWrite;
        process.stderr.write = origStderrWrite;
      }

      // Thread the captured cursor row into ctx so runReplLoop can hand it
      // to `surface.armCompositor({ anchorRow })`. We use the row AFTER all
      // the newlines as the safe ceiling — any value below this is owned by
      // pre-arm scrollback content (banner, notices) that the live frame
      // must not overwrite via CUP positioning.
      ctx.preArmAnchorRow = preArmAnchorRow;

      ctx.statusLine.start();
      ctx.slashCtx.ui.repaintStatusLine();

      ctx.rl.on('close', async () => {
        ctx.statusLine.stop();
        // printExitSummary is synchronous (execFileSync for git stat) so
        // order is guaranteed without an await on this particular call.
        printExitSummary(ctx, worktreeHandle, saveCurrentSession);
        console.log(palette.info('ℹ ') + 'Goodbye!');
        await runCleanupFunctions();
        process.exit(0);
      });

      await runReplLoop(ctx, transcript, turnState, handleSigint);
    });
}

/**
 * Expanded session-close summary (Item #8).
 *
 * Replaces the old printExitSummary + printResumeHint pair with a single
 * async function that emits up to 4 lines:
 *
 *   Line 1: N turns · Xs · $Y.YY · Ztokens
 *   Line 2: model: <model> · worktree: <name or 'none'>
 *   Line 3: edits: <git diff --shortstat> or 'no files changed'
 *             (omitted if not in a git repo; Promise.race with 2s timeout)
 *   Line 4: Continue with: afk --resume <id> -m <model>
 *
 * All lines are indented 2 spaces and dimmed. Line 4 uses palette.brand for
 * the command itself so the operator can copy-paste it clearly.
 *
 * External constraint: git diff --shortstat runs via execFileSync with a 2s
 * timeout so a huge repo or slow NFS mount can never delay process exit. Any
 * error (non-git-repo, git not on PATH, timeout) silently skips the line.
 */
function printExitSummary(
  ctx: InteractiveCtx,
  worktreeHandle: Awaited<ReturnType<typeof setupWorktree>> | undefined,
  saveCurrentSession: () => string | undefined,
): void {
  if (ctx.stats.totalTurns === 0) return;

  // Invariant (TUI rhythm contract): the last turn's footer (line ~520
  // of turn-handler.ts) already emitted its trailing blank, so the
  // divider lands one blank below the footer naturally. A leading `\n`
  // here would double-up. See docs/tui-rhythm.md.
  console.log(divider('Session Summary'));

  // Line 1: turns · duration · cost · tokens
  const parts = [
    `${ctx.stats.totalTurns} turn${ctx.stats.totalTurns === 1 ? '' : 's'}`,
    formatDuration(Date.now() - ctx.stats.sessionStartTime),
  ];
  if (ctx.stats.totalCostUsd > 0) parts.push(formatCost(ctx.stats.totalCostUsd));
  if (ctx.stats.totalTokens > 0) parts.push(formatTokens(ctx.stats.totalTokens) + ' tokens');
  console.log(palette.dim('  ' + parts.join(' · ')));

  // Line 2: model · worktree name (or 'none')
  const worktreeName = worktreeHandle ? path.basename(worktreeHandle.path) : 'none';
  console.log(palette.dim(`  model: ${ctx.stats.model} · worktree: ${worktreeName}`));

  // Line 3: git diff --shortstat (best-effort, synchronous with 2s timeout).
  // External constraint: execFileSync with a timeout kills the child process
  // if git hangs (e.g. on a slow NFS mount). Any error (non-git-repo, git
  // not on PATH, timeout, or HEAD not existing on initial worktree) silently
  // skips the line so process exit is never blocked.
  try {
    const cwd = ctx.stats.cwd ?? process.cwd();
    const stdout = execFileSync('git', ['diff', '--shortstat', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      timeout: 2000,
    });
    const stat = stdout.trim();
    console.log(palette.dim(`  edits: ${stat || 'no files changed'}`));
  } catch {
    // Not a git repo, git not on PATH, timed out, or HEAD doesn't exist —
    // skip the line entirely rather than showing a confusing error.
  }

  // Line 4: resume hint (absorbs former printResumeHint)
  let resumeTarget = ctx.stats.sessionId;
  try {
    const savedPath = saveCurrentSession();
    if (!resumeTarget && savedPath) {
      resumeTarget = path.basename(savedPath, '.json');
    }
  } catch {
    // The command can still be useful when the SDK/session id is known and
    // the cleanup autosave failed for an unrelated filesystem reason.
  }
  if (resumeTarget) {
    console.log(
      palette.dim('  Continue with: ') +
        palette.brand(formatResumeCommand(resumeTarget, ctx.stats.model)),
    );
  }

  console.log();
}
