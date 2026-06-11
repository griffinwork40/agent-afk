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
loadEnv();
// Also load ~/.afk/config/afk.env with override: false so project .env takes precedence
loadEnv({ path: getEnvConfigPath(), override: false });

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

// Expose AGENT_SURFACE so Python plugin scripts invoked via the bash tool
// can detect the calling surface for telemetry attribution. Uses ??= to
// respect any pre-set value (e.g. for testing or alternative surfaces).
process.env['AGENT_SURFACE'] ??= 'afk';

import { Command } from 'commander';
import { configureColor } from './color-config.js';
configureColor();
import { registerChatCommand } from './commands/chat.js';
import { registerInteractiveCommand } from './commands/interactive.js';
import { registerStatusCommand } from './commands/status.js';
import { registerConfigCommand } from './commands/config-command.js';
import { registerDaemonCommand } from './commands/daemon.js';
import { registerQueueCommand } from './commands/queue.js';
import { registerLoginCommand } from './commands/login-command.js';
import { registerPluginCommand } from './commands/plugin.js';
import { registerMarketplaceCommand } from './commands/marketplace.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerProviderCommand } from './commands/provider.js';
import { registerCompletionCommand } from './commands/completion.js';
import { registerTelegramCommand } from './commands/telegram.js';
import { registerFarmCommand } from './commands/farm.js';
import { registerWorktreeCommand } from './commands/worktree.js';
import { registerUpdateCommand } from './commands/update.js';
import { registerScheduleCommand } from './commands/schedule.js';
import { registerBgCommand } from './commands/bg.js';
import { registerTraceCommand } from './commands/trace.js';
import { registerServiceCommand } from './commands/service.js';
import { registerBrowserCommand } from './commands/browser.js';
import { registerImproveCommand } from './commands/improve.js';
import { registerShellInitCommand } from './commands/shell-init.js';
import { setInteractiveUpdateNotices } from './commands/interactive.js';
import { loadConfig, loadCredential } from './config.js';
import { providerForModel } from '../agent/providers/index.js';
import { getModel } from './shared-helpers.js';
import { runAuthWizard } from './auth-wizard.js';
import { getVersion } from './version.js';
import { checkForUpdates, printUpdateBanner, triggerAutoUpdate, checkPendingUpdate } from './update-checker.js';

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
registerQueueCommand(program);
registerInteractiveCommand(program);
registerLoginCommand(program);
registerPluginCommand(program);
registerMarketplaceCommand(program);
registerStatusCommand(program);
registerDoctorCommand(program);
registerProviderCommand(program);
registerCompletionCommand(program);
registerTelegramCommand(program);
registerFarmCommand(program);
registerWorktreeCommand(program);
registerUpdateCommand(program);
registerScheduleCommand(program);
registerBgCommand(program);
registerTraceCommand(program);
registerServiceCommand(program);
registerBrowserCommand(program);
registerImproveCommand(program);
registerShellInitCommand(program);

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
  $ afk --model opus             # REPL with specific model
  $ afk chat "What is 2+2?"     # one-shot message
  $ afk status --format json`,
);

/**
 * Commands that cannot do anything useful without an Anthropic credential.
 * Everything else (login, doctor, --version, --help, config, …) must work
 * pre-auth — a fresh install's first commands are exactly those.
 */
const AUTH_GATED_COMMANDS = new Set(['chat', 'c', 'interactive', 'i', 'daemon', 'farm']);

/**
 * Pure function. Decides whether the invoked command needs the credential
 * gate. `--version`/`--help` never gate. A leading non-flag arg is the
 * subcommand (commander convention); only AUTH_GATED_COMMANDS gate. No
 * subcommand (bare `afk`, or program flags like `--model opus`) means the
 * REPL is starting, which needs auth.
 *
 * Exported for unit testing.
 */
export function needsCredentialGate(argv: string[]): boolean {
  const args = argv.slice(2);
  if (args.some((a) => a === '--version' || a === '-V' || a === '--help' || a === '-h')) {
    return false;
  }
  const first = args[0];
  const sub = first && !first.startsWith('-') ? first : undefined;
  if (sub === undefined) return true; // bare `afk` → REPL → needs auth
  return AUTH_GATED_COMMANDS.has(sub);
}

/**
 * First-run detector. When no credential is present and the resolved provider
 * is anthropic-direct, offers an interactive wizard (TTY) or prints a helpful
 * error (non-TTY) instead of surfacing a cryptic provider error.
 *
 * Only fires for commands that actually need a credential (see
 * needsCredentialGate) — `afk --version`, `afk login`, `afk doctor` etc. must
 * never be blocked by the gate they would be used to satisfy or diagnose.
 *
 * Exported so it can be tested independently without running program.parse().
 */
export async function runFirstRunDetector(argv: string[] = process.argv): Promise<void> {
  if (!needsCredentialGate(argv)) return;
  const credential = loadCredential();
  const provider = providerForModel(getModel() as string);
  if (!credential && provider === 'anthropic-direct') {
    if (!process.stdin.isTTY) {
      process.stderr.write(
        'agent-afk: No Anthropic credential found. Run `afk login` to authenticate.\n',
      );
      process.exit(1);
      return; // guard for test environments where process.exit is mocked
    }
    try {
      await runAuthWizard();
      loadEnv({ path: getEnvConfigPath(), override: true });
    } catch {
      // swallow — let program.parse() surface auth error naturally
    }
  }
}

// Parse and execute — only when run directly as CLI (not imported by tests)
import { realpathSync } from 'fs';
const argv1 = process.argv[1] ?? '';
const isDirectRun =
  import.meta.url === `file://${argv1}` ||
  import.meta.url === `file://${realpathSync(argv1)}`;
if (isDirectRun) {
  (async () => {
    await runFirstRunDetector();

    // The `--no-update-check` flag must be detected here, BEFORE program.parse()
    // runs — program.opts() is empty until parse() executes. Commander turns
    // `--no-update-check` into `updateCheck: false`, not `noUpdateCheck: true`,
    // so checking opts after parse would also need the inverted key.
    // Restrict the search to args that start with `--` to avoid false matches
    // on a flag's value argument (e.g. `afk chat "--no-update-check"`).
    const config = loadConfig();
    const noCheckArg = process.argv.slice(2).some((a) => a === '--no-update-check');
    const policy = noCheckArg ? ('off' as const) : config.updatePolicy;
    const updateInfo = checkForUpdates(policy);

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

    program.parseAsync(process.argv).catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
  })();
}
