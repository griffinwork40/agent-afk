#!/usr/bin/env node

/**
 * Agent AFK CLI - Main Entry Point (Thin Dispatcher)
 */

// Load environment variables FIRST before any other imports
import { config as loadEnv } from 'dotenv';
import { getEnvConfigPath, getAgentFrameworkDir } from '../paths.js';
import { clearCdIntent } from '../utils/cd-on-exit.js';
// Load project .env (ANTHROPIC_API_KEY, CLAUDE_MODEL, etc).
// Do NOT load ~/.claude/.env — that file can hold stale OAuth tokens
// that interfere with the subprocess's native keychain auth.
// quiet:true suppresses the "injecting env" log added in dotenv v17+ so
// it never leaks into CLI stdout or piped output (e.g. `afk chat`).
loadEnv({ quiet: true });
// Also load ~/.afk/config/afk.env with override: false so project .env takes precedence
loadEnv({ path: getEnvConfigPath(), override: false, quiet: true });

// Invariant: Guard against multi-terminal race — `afk shell-init` must NOT
// clear a marker another terminal's wrapper is about to read. The race:
//   Terminal A: runs `afk i -w`, exits, wrapper reads marker and is about
//               to cd — but hasn't consumed it yet.
//   Terminal B: runs `afk shell-init` at startup, unconditionally calls
//               clearCdIntent(), deletes the marker under Terminal A's
//               wrapper, leaving A's shell in the wrong directory forever.
// Mitigation: skip clearCdIntent when the current invocation is shell-init.
// shell-init only writes to stdout (the wrapper text) and never records a
// cd-intent itself, so there is nothing to clear. Any marker present
// belongs to a concurrent terminal running a real afk session.
if (!process.argv.includes('shell-init')) {
  // Clear any stale cd-on-exit marker from a prior `afk` invocation. The
  // optional shell wrapper installed via `afk shell-init` reads this file
  // to auto-cd the parent shell into preserved worktrees; clearing it at
  // startup guarantees an old marker can never hijack a later session
  // that has nothing to do with worktrees.
  clearCdIntent();
}

// Expose AFK_FRAMEWORK_DIR so agent prompts that write telemetry use
// ~/.afk/agent-framework/, not ~/.claude/agent-framework/.
process.env['AFK_FRAMEWORK_DIR'] ??= getAgentFrameworkDir();

// Expose AGENT_SURFACE so subprocesses (e.g. Python plugin scripts) can
// detect the calling surface for telemetry attribution. Always 'afk' at
// runtime -- per-surface discrimination (cli/telegram/daemon) lives on
// AgentConfig.surface, not this env var. Uses ??= to respect pre-set
// values in tests.
process.env['AGENT_SURFACE'] ??= 'afk';

import { Command } from 'commander';
import { configureColor } from './color-config.js';
import { env } from '../config/env.js';
import { applyTheme, resolveTheme, parseThemeMode } from './theme.js';
configureColor();
// Apply the color theme (dark | light | umber | auto) before any command registers
// or renders. This sets the env/default baseline for EVERY surface (chat,
// daemon, telegram banners); the interactive/chat bootstraps refine it with
// the config `theme` key and the `--theme` flag. Default is dark, so an
// unset AFK_THEME leaves every existing user's colors unchanged.
applyTheme(resolveTheme(parseThemeMode(env.AFK_THEME)));
import { registerChatCommand } from './commands/chat.js';
import { registerInteractiveCommand } from './commands/interactive.js';
import { registerStatusCommand } from './commands/status.js';
import { registerUsageCommand } from './commands/usage.js';
import { registerConfigCommand } from './commands/config-command.js';
import { registerDaemonCommand } from './commands/daemon.js';
import { registerWebCommand } from './commands/web.js';
import { registerQueueCommand } from './commands/queue.js';
import { registerEventsCommand } from './commands/events.js';
import { registerLoginCommand } from './commands/login-command.js';
import { registerPluginCommand } from './commands/plugin.js';
import { registerMarketplaceCommand } from './commands/marketplace.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerMigrateCommand } from './commands/migrate.js';
import { registerProviderCommand } from './commands/provider.js';
import { registerCompletionCommand } from './commands/completion.js';
import { registerTelegramCommand } from './commands/telegram.js';
import { registerFarmCommand } from './commands/farm.js';
import { registerWorktreeCommand } from './commands/worktree.js';
import { registerBranchCommand } from './commands/branch.js';
import { registerUpdateCommand } from './commands/update.js';
import { registerScheduleCommand } from './commands/schedule.js';
import { registerBgCommand } from './commands/bg.js';
import { registerTraceCommand } from './commands/trace.js';
import { registerWhatifCommand } from './commands/whatif.js';
import { registerWitnessCommand } from './commands/witness.js';
import { registerServiceCommand } from './commands/service.js';
import { registerRestartCommand } from './commands/restart.js';
import { registerBrowserCommand } from './commands/browser.js';
import { registerImproveCommand } from './commands/improve/index.js';
import { registerShellInitCommand } from './commands/shell-init.js';
import { registerTranscriptCommand } from './commands/transcript.js';
import { registerInsightsCommand } from './commands/insights.js';
import { registerCapturesCommand } from './commands/captures.js';
import { registerDefectsCommand } from './commands/defects.js';
import { registerReceiptCommand } from './commands/receipt.js';
import { registerAcpCommand } from './commands/acp.js';
import { setInteractiveUpdateNotices } from './commands/interactive.js';
import { loadConfig } from './config.js';
import { deferAfkMdSizeWarnings, flushDeferredAfkMdSizeWarnings } from './config/afk-md-tier.js';
import { installCredentialGate } from './first-run.js';
import { getVersion } from './version.js';
import {
  checkForUpdates,
  coldStartUpdateCheck,
  hasUpdateCache,
  printUpdateBanner,
  triggerAutoUpdate,
  checkPendingUpdate,
} from './update-checker.js';

// Re-export shared helpers for tests
export {
  parseThinking,
  parseEffort,
  parseBudget,
  parseMaxOutputTokens,
  getMaxBudgetUsd,
  getTaskBudget,
  getMaxOutputTokens,
} from './shared-helpers.js';

const program = new Command();

program
  .name('afk')
  .description('AI agent CLI. Starts interactive REPL by default; use `afk chat` for one-shot.')
  .version(getVersion())
  .option('--no-update-check', 'Skip update version check');

// Register commands
registerChatCommand(program);
registerConfigCommand(program);
registerDaemonCommand(program);
registerWebCommand(program);
registerQueueCommand(program);
registerEventsCommand(program);
registerInteractiveCommand(program);
registerLoginCommand(program);
registerPluginCommand(program);
registerMarketplaceCommand(program);
registerStatusCommand(program);
registerUsageCommand(program);
registerDoctorCommand(program);
registerMigrateCommand(program);
registerProviderCommand(program);
registerCompletionCommand(program);
registerTelegramCommand(program);
registerFarmCommand(program);
registerWorktreeCommand(program);
registerBranchCommand(program);
registerUpdateCommand(program);
registerScheduleCommand(program);
registerBgCommand(program);
registerTraceCommand(program);
registerWhatifCommand(program);
registerWitnessCommand(program);
registerServiceCommand(program);
registerRestartCommand(program);
registerBrowserCommand(program);
registerImproveCommand(program);
registerShellInitCommand(program);
registerTranscriptCommand(program);
registerInsightsCommand(program);
registerCapturesCommand(program);
registerDefectsCommand(program);
registerReceiptCommand(program);
registerAcpCommand(program);

// Add aliases
program.commands.find((c) => c.name() === 'chat')?.alias('c');
program.commands.find((c) => c.name() === 'interactive')?.alias('i');
program.commands.find((c) => c.name() === 'status')?.alias('s');

// Add help examples
program.addHelpText(
  'after',
  `
Examples:
  $ afk                          # start interactive REPL
  $ afk "what does this do?"     # REPL, auto-submits the prompt as the first turn
  $ afk /review                  # REPL, runs a slash command / skill on launch
  $ afk --model opus             # REPL with specific model
  $ afk chat "What is 2+2?"     # one-shot message (prints and exits)
  $ afk status --format json`,
);

// Commander parses options before this hook and before command action side effects.
installCredentialGate(program);

// Non-REPL commands print deferred AFK.md size warnings before their own
// output; the REPL drains them itself after its screen clear.
program.hook('preAction', (_thisCommand, actionCommand) => {
  if (actionCommand.name() !== 'interactive') flushDeferredAfkMdSizeWarnings();
});

export { needsCredentialGate, runFirstRunDetector } from './first-run.js';

// Parse and execute — only when run directly as CLI (not imported by tests)
import { realpathSync } from 'fs';
import { pathToFileURL } from 'url';
const argv1 = process.argv[1] ?? '';
// pathToFileURL normalizes backslashes → forward slashes and applies
// percent-encoding, so `file:///D:/path` matches on Windows where a
// naive `file://${argv1}` would produce `file:///D:\path` and miss.
const isDirectRun =
  import.meta.url === pathToFileURL(argv1).href ||
  import.meta.url === pathToFileURL(realpathSync(argv1)).href;
if (isDirectRun) {
  (async () => {
    // The `--no-update-check` flag must be detected here, BEFORE program.parse()
    // runs — program.opts() is empty until parse() executes. Commander turns
    // `--no-update-check` into `updateCheck: false`, not `noUpdateCheck: true`,
    // so checking opts after parse would also need the inverted key.
    // Restrict the search to args that start with `--` to avoid false matches
    // on a flag's value argument (e.g. `afk chat "--no-update-check"`).
    // Buffer AFK.md size warnings from this pre-parse load: the REPL would
    // erase them with its screen clear. Flushed by the preAction hook below
    // (non-REPL commands) or by drainBootWarnings after the clear (REPL).
    deferAfkMdSizeWarnings();
    const config = loadConfig();
    const noCheckArg = process.argv.slice(2).some((a) => a === '--no-update-check');
    const policy = noCheckArg ? ('off' as const) : config.updatePolicy;
    // Warm cache: the fully synchronous fast path (may spawn a background
    // refresh if the cache is stale). Cold cache: checkForUpdates() could only
    // fire a detached fetch and return null, so the banner would never appear
    // on the very first run — await one short bounded inline fetch instead so
    // that first run can surface it. Guards (off/CI/NO_UPDATE_NOTIFIER) are
    // applied inside both functions.
    const updateInfo = hasUpdateCache()
      ? checkForUpdates(policy)
      : await coldStartUpdateCheck(policy);

    // Intercept the pending-update message that checkPendingUpdate() would
    // write to stderr, so we can re-emit it AFTER the interactive mode screen
    // clear instead of before (where it would be erased).
    let capturedPending: string | null = null;
    const origWrite = process.stderr.write.bind(process.stderr);
    // Temporarily intercept stderr to capture the pending-update notice.
    (process.stderr.write as unknown as (s: string, ...a: unknown[]) => boolean) = (
      s: string,
      ...rest: unknown[]
    ) => {
      if (typeof s === 'string' && s.includes('Updated to agent-afk')) {
        capturedPending = (capturedPending ?? '') + s;
        return true;
      }
      return (origWrite as (s: string, ...a: unknown[]) => boolean)(s, ...rest);
    };
    checkPendingUpdate();
    (process.stderr.write as unknown) = origWrite;

    // Stash both the update banner and the captured pending message so the
    // interactive action can re-emit them after the screen clear.
    setInteractiveUpdateNotices(updateInfo, capturedPending);

    // For non-interactive commands (afk chat, afk status, etc.), print the
    // update banner immediately — those commands don't do a screen clear.
    //
    // Two detection strategies are used here intentionally:
    //   1. argv-based (argv.length <= 2, argv[2] === 'interactive'|'i'): runs
    //      BEFORE program.parseAsync() so Commander option/command state is not
    //      yet populated — this is the only mechanism available at this point.
    //   2. Commander name-based (actionCommand.name() !== 'interactive'): used
    //      in the preAction hook below, AFTER Commander has parsed the argv.
    //      Both strategies are correct for their respective call sites; argv is
    //      consulted only pre-parse, Commander state only post-parse.
    const isInteractiveInvocation =
      process.argv.length <= 2 ||
      process.argv[2] === 'interactive' ||
      process.argv[2] === 'i';
    if (!isInteractiveInvocation) {
      if (capturedPending !== null) {
        process.stderr.write(capturedPending);
      }
      if (updateInfo) {
        printUpdateBanner(updateInfo);
        if (policy === 'auto') {
          triggerAutoUpdate(updateInfo.latestVersion);
        }
      }
    } else if (updateInfo && policy === 'auto') {
      // Trigger the background auto-update even for interactive mode; the
      // confirmation notice will appear via the stashed notices above.
      triggerAutoUpdate(updateInfo.latestVersion);
    }

    // Early-exit version flag — must precede parseAsync() so Commander never
    // handles --version itself. Commander's internal handler calls
    // process.stdout.write then immediately process.exit(0), which can
    // race on some shells. We print and return without process.exit so
    // Node drains stdout naturally before the event loop terminates.
    if (process.argv.includes('--version') || process.argv.includes('-V')) {
      console.log(getVersion());
      return;
    }

    program.parseAsync(process.argv).catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
  })();
}
