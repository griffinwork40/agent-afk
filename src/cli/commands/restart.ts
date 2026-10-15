/**
 * `afk restart [name]` — restart AFK's OS-supervised background services.
 *
 * With a name, restarts that one service (same as `afk service restart
 * <name>`). With no name, restarts every service that is currently
 * installed and skips the rest, so the common "I just upgraded, bounce
 * everything" case is one short command.
 *
 * `afk service restart [name]` routes through {@link runRestart} as well,
 * so both entry points share one implementation and one output format.
 *
 * Why a top-level verb at all: `interactive` is commander's default
 * command with a variadic `[input...]`, so before this existed a bare
 * `afk restart` was silently reinterpreted as a REPL prompt and launched
 * an agent session instead of restarting anything.
 *
 * Scope: only services installed through `afk service install` (launchd,
 * systemd --user, Task Scheduler). A Telegram bot started by hand with
 * `afk telegram start` is not an OS service; `afk telegram restart`
 * covers that case and the no-services hint says so.
 *
 * @module cli/commands/restart
 */

import { Command } from 'commander';
import { palette } from '../palette.js';
import { handleCommandError } from '../errors/index.js';
import {
  SERVICE_NAMES,
  SUPPORTED_SERVICE_PLATFORMS,
  serviceManagerFor,
  type ServiceManager,
  type ServiceName,
} from '../../service/index.js';

/** One rendered line of restart output, tagged with its palette role. */
export interface RestartLine {
  level: 'success' | 'warning' | 'error' | 'meta';
  text: string;
}

/** Result of {@link restartServices}: what to print and how to exit. */
export interface RestartReport {
  lines: RestartLine[];
  /** 0 when every attempted restart succeeded, 1 otherwise. */
  exitCode: 0 | 1;
}

/** Parse a user-supplied service name, case-insensitively. Throws on unknown names. */
export function parseServiceName(input: string): ServiceName {
  const lower = input.toLowerCase();
  if ((SERVICE_NAMES as readonly string[]).includes(lower)) return lower as ServiceName;
  throw new Error(`Unknown service '${input}'. Supported: ${SERVICE_NAMES.join(', ')}.`);
}

/** Restart one service and append its outcome lines. Returns true on success. */
function restartOne(mgr: ServiceManager, name: ServiceName, lines: RestartLine[]): boolean {
  const result = mgr.restart(name);
  if (result.kind === 'not-installed') {
    lines.push({
      level: 'error',
      text: `✗ ${mgr.label(name)} is not installed. Run 'afk service install ${name}' first.`,
    });
    return false;
  }
  if (result.kind === 'failed') {
    lines.push({ level: 'error', text: `✗ Restart of ${mgr.label(name)} failed: ${result.reason}` });
    return false;
  }
  lines.push({ level: 'success', text: `✓ Restarted ${result.label}` });
  for (const note of result.notes ?? []) {
    lines.push({ level: 'warning', text: `  ⚠ ${note}` });
  }
  return true;
}

/**
 * Restart `target`, or every installed service when `target` is undefined.
 *
 * Contract: never throws for supervisor failures (those become error lines
 * and exitCode 1). In all-services mode every installed service is
 * attempted even if an earlier one fails, so one broken unit cannot
 * strand the others on the old version. Having nothing installed is
 * exitCode 1: the caller asked for a restart and none happened.
 */
export function restartServices(mgr: ServiceManager, target?: ServiceName): RestartReport {
  const lines: RestartLine[] = [];
  if (target !== undefined) {
    const ok = restartOne(mgr, target, lines);
    return { lines, exitCode: ok ? 0 : 1 };
  }

  const installed = SERVICE_NAMES.filter((name) => mgr.isInstalled(name));
  if (installed.length === 0) {
    lines.push({ level: 'warning', text: `No AFK services are installed (${mgr.backend}).` });
    lines.push({ level: 'meta', text: `  Install one with: afk service install <${SERVICE_NAMES.join('|')}>` });
    lines.push({ level: 'meta', text: `  Bot started by hand? Use: afk telegram restart` });
    return { lines, exitCode: 1 };
  }

  let allOk = true;
  for (const name of SERVICE_NAMES) {
    if (!installed.includes(name)) {
      lines.push({ level: 'meta', text: `○ Skipped ${name} (not installed)` });
      continue;
    }
    if (!restartOne(mgr, name, lines)) allOk = false;
  }
  return { lines, exitCode: allOk ? 0 : 1 };
}

function printLine(line: RestartLine): void {
  if (line.level === 'error') {
    console.error(palette.error(line.text));
    return;
  }
  const style = line.level === 'success' ? palette.success : line.level === 'warning' ? palette.warning : palette.meta;
  console.log(style(line.text));
}

/**
 * CLI action shared by `afk restart [name]` and `afk service restart [name]`.
 * Resolves the platform backend, restarts, prints, and exits non-zero on failure.
 */
export function runRestart(nameArg: string | undefined): void {
  try {
    const mgr = serviceManagerFor();
    if (!mgr) {
      throw new Error(
        `Restarting AFK services is not supported on ${process.platform}. Supported: ${SUPPORTED_SERVICE_PLATFORMS}.`,
      );
    }
    const target = nameArg === undefined ? undefined : parseServiceName(nameArg);
    const report = restartServices(mgr, target);
    for (const line of report.lines) printLine(line);
    if (report.exitCode !== 0) process.exit(report.exitCode);
  } catch (err) {
    handleCommandError(err);
  }
}

export function registerRestartCommand(program: Command): void {
  program
    .command('restart [name]')
    .description(
      `Restart AFK background services (<${SERVICE_NAMES.join('|')}>); with no name, restarts every installed service`,
    )
    .action((nameArg: string | undefined) => {
      runRestart(nameArg);
    });
}
