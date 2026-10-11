import { Command } from 'commander';
import { env } from '../../config/env.js';
import { pushIfConfigured } from '../../telegram/push.js';
import { resolveChatTarget, loadChatAliases } from '../../telegram/notify-routing.js';
import { parseAllowedChatIds, isChatAllowed } from '../../telegram/allowlist.js';
import type { TaskCompletionDetails, TelemetryRecord } from '../../agent/daemon/scheduler.js';
import { COMPILED_DEFAULT_TASK_ID } from '../daemon-options.js';
import { installCrashNotifier } from '../../utils/crash-notifier.js';
import { runDaemonAction } from './daemon.action.js';
export type { BuildDaemonSessionFactoryOpts } from './daemon-session-factory.js';
export { buildDaemonSessionFactory } from './daemon-session-factory.js';

/**
 * Caveat line appended to a downgraded "Done (unverified)" daemon push. Kept
 * byte-identical to the REPL's afk-push wording (minus that surface's leading
 * "• " bullet, which the daemon message shape doesn't use) so the operator sees
 * one consistent self-honesty message across surfaces. See
 * `formatTerminalStateForTelegram` in `interactive/afk-push.ts`.
 */
const DAEMON_DONE_UNVERIFIED_CAVEAT =
  '⚠️ Unverified: no file write/edit or successful command recorded this turn — confirm before relying on this.';

/**
 * Resolve a scheduled task's `notifyChat` to a concrete, allowlisted chat id for
 * the completion push, or `undefined` to fall back to the default notify routing.
 *
 * Two-step, both FAIL-CLOSED to the default target (never drops the notification):
 *   1. Resolve the alias/number via `telegram.chatAliases` (`resolveChatTarget`).
 *   2. Enforce the inbound allowlist (`isChatAllowed`) — the agent may only push
 *      to a chat the operator has already authorized.
 * A resolution or allowlist failure logs one stderr warning (so a misconfigured
 * notifyChat is visible in daemon logs) and returns `undefined`, letting
 * `pushIfConfigured` deliver to the configured default instead.
 */
export function resolveNotifyChatTarget(
  notifyChat: number | string | undefined,
  taskId: string,
): number | undefined {
  if (notifyChat === undefined) return undefined;
  const resolved = resolveChatTarget(notifyChat, loadChatAliases());
  if (!resolved.ok) {
    // eslint-disable-next-line no-console
    console.error(`[daemon] task ${taskId}: ignoring notifyChat — ${resolved.message} Falling back to default routing.`);
    return undefined;
  }
  const allowlist = parseAllowedChatIds(env.AFK_TELEGRAM_ALLOWED_CHAT_IDS);
  if (!isChatAllowed(resolved.id, allowlist)) {
    // eslint-disable-next-line no-console
    console.error(`[daemon] task ${taskId}: ignoring notifyChat ${resolved.id} — not in AFK_TELEGRAM_ALLOWED_CHAT_IDS. Falling back to default routing.`);
    return undefined;
  }
  return resolved.id;
}

/**
 * Format a daemon telemetry record for an out-of-band notification
 * (e.g. Telegram push). Short, scannable, status-first.
 *
 * `verifyDone` gates the "Done"-verification downgrade (mirrors
 * `daemon.verifyDone` in config — default: true since the daemon surface is
 * unattended). When it is `true` AND `details.doneUnverified` is `true`, the
 * ✅ success header is downgraded to a "⚠️ Done (unverified)" header and the
 * {@link DAEMON_DONE_UNVERIFIED_CAVEAT} line is appended. When `verifyDone`
 * is explicitly `false`, the output is byte-identical to before this feature
 * existed.
 */
export function formatTaskCompletion(
  record: TelemetryRecord,
  details: TaskCompletionDetails = {},
  verifyDone = false,
): string {
  // Downgrade only when the config gate is on AND this tick self-certified an
  // unbacked Done. `doneUnverified` is only ever set on `status: 'success'`
  // ticks (a `Done` response), so the header swap can't collide with the
  // skipped/error icons.
  const downgraded = verifyDone === true && details.doneUnverified === true;
  // Resolve response text before building the header so emptySuccess can
  // influence the icon. Whitespace-only counts as empty.
  const responseText = details.responseText ?? record.responseExcerpt;
  const hasOutput = (responseText ?? '').trim().length > 0;
  // Flag a success tick that produced no output — only when the downgraded
  // header is not already active (the downgrade warning takes priority and
  // already signals a problem to the operator).
  const emptySuccess = record.status === 'success' && !downgraded && !hasOutput;
  const icon =
    record.status === 'success' ? '✅' : record.status === 'skipped' ? '⏭️' : '❌';
  const durationSec = (record.durationMs / 1000).toFixed(1);
  const header = downgraded
    ? `⚠️ Done (unverified) — daemon task: ${record.taskId} (${record.status})`
    : emptySuccess
      ? `⚠️ daemon task: ${record.taskId} (success, no output)`
      : `${icon} daemon task: ${record.taskId} (${record.status})`;
  const lines = [
    header,
    `trigger=${record.trigger} duration=${durationSec}s`,
  ];
  if (record.skipReason) lines.push(`skipReason=${record.skipReason}`);
  if (record.errorMessage) lines.push(`error: ${record.errorMessage.slice(0, 400)}`);
  if (hasOutput) {
    lines.push('', responseText as string);
  }
  if (downgraded) {
    lines.push('', DAEMON_DONE_UNVERIFIED_CAVEAT);
  }
  return lines.join('\n');
}

/**
 * Module-scoped crash-handler guard state.  Grouping the three guards makes
 * the reset surface explicit and keeps `_resetDaemonCrashHandlersForTest`
 * the single place that clears all of them.
 *
 * - `handle` — CrashNotifierHandle returned by installCrashNotifier; undefined
 *   until `registerDaemonCrashHandlers` is first called.
 * - `earlyHandlersInstalled` — duplicate-listener guard for `registerEarlyDaemonCrashHandlers`.
 * - `earlyInFlightSource` — module-scoped in-flight snapshot provider shared
 *   between `registerEarlyDaemonCrashHandlers` calls so a second call (e.g.
 *   after `_resetDaemonCrashHandlersForTest` in tests) re-uses the same closure
 *   slot and `bindInFlightSource` still updates the getter the registered crash
 *   handler reads.
 */
const daemonCrashState = {
  handle: undefined as { reset: () => void } | undefined,
  earlyHandlersInstalled: false,
  earlyInFlightSource: undefined as (() => InFlightTaskSnapshot[]) | undefined,
};

/**
 * Reset the re-entry guards. Exported for testing only — do not call in
 * production code.
 *
 * @internal
 */
export function _resetDaemonCrashHandlersForTest(): void {
  daemonCrashState.handle?.reset();
  daemonCrashState.handle = undefined;
  daemonCrashState.earlyHandlersInstalled = false;
  daemonCrashState.earlyInFlightSource = undefined;
}

/**
 * Maximum number of in-flight task entries appended to a crash notice. Caps
 * Telegram message length when many tasks are simultaneously in-flight.
 * Tasks beyond this limit are silently omitted (the count is still shown).
 */
const CRASH_NOTICE_IN_FLIGHT_LIMIT = 10;

/** Shape of a single in-flight task snapshot for crash-notice inclusion (#3248). */
export interface InFlightTaskSnapshot {
  taskId: string;
  /** Redacted form of taskId, safe to include verbatim in Telegram crash notices. */
  displayId: string;
  commandHead: string;
  elapsedMs: number;
}

/**
 * Register uncaughtException / unhandledRejection process handlers that push a
 * best-effort Telegram crash notice before exiting. Delegates to the shared
 * `installCrashNotifier` helper; see `src/utils/crash-notifier.ts` for the
 * rate-limiting, exit-deferral, and re-entry-safety contracts.
 *
 * @param getInFlightTasks - Optional provider of the current in-flight task
 *   snapshot. When present, the crash notice includes task ids, command heads,
 *   and elapsed time for every task that was running at crash time (#3248).
 */
export function registerDaemonCrashHandlers(
  getInFlightTasks?: () => InFlightTaskSnapshot[],
): void {
  if (daemonCrashState.handle !== undefined) return;

  const extraLines = getInFlightTasks !== undefined
    ? (): string[] => {
        const tasks = getInFlightTasks();
        if (tasks.length === 0) return [];
        const lines: string[] = ['', `in-flight (${tasks.length}):` ];
        const listed = tasks.slice(0, CRASH_NOTICE_IN_FLIGHT_LIMIT);
        for (const t of listed) {
          const elapsedSec = (t.elapsedMs / 1000).toFixed(1);
          lines.push(`  • ${t.displayId}: ${t.commandHead} (${elapsedSec}s)`);
        }
        if (tasks.length > CRASH_NOTICE_IN_FLIGHT_LIMIT) {
          lines.push(`  … and ${tasks.length - CRASH_NOTICE_IN_FLIGHT_LIMIT} more`);
        }
        return lines;
      }
    : undefined;

  daemonCrashState.handle = installCrashNotifier('daemon', pushIfConfigured, { extraLines });
}

/**
 * Install the daemon crash handlers up front — before any async startup work
 * (plugin loading, `startDaemon`) — so a crash DURING startup still pushes a
 * notice (#3323 review). The in-flight getter is late-bound: it yields `[]`
 * until the caller binds the live scheduler snapshot via the returned setter.
 * Idempotency is unchanged: `registerDaemonCrashHandlers` still installs at
 * most one listener pair per process.
 *
 * Single-call contract: this function must be called at most once per process.
 * If called again (e.g. after `_resetDaemonCrashHandlersForTest` in tests),
 * the `daemonCrashState.earlyInFlightSource` slot is reused by the same getter
 * closure registered in `registerDaemonCrashHandlers`, so the returned binder
 * still updates the live snapshot provider.
 */
export function registerEarlyDaemonCrashHandlers(): (source: () => InFlightTaskSnapshot[]) => void {
  if (!daemonCrashState.earlyHandlersInstalled) {
    daemonCrashState.earlyHandlersInstalled = true;
    registerDaemonCrashHandlers(() => daemonCrashState.earlyInFlightSource?.() ?? []);
  }
  return (source) => {
    daemonCrashState.earlyInFlightSource = source;
  };
}

export function registerDaemonCommand(program: Command): void {
  program
    .command('daemon')
    .description('Run agent-afk as a daemon that fires scheduled tasks (e.g. /forge-friction --auto)')
    .option('-p, --port <number>', 'Control HTTP port', '7777')
    .option(
      '--host <address>',
      'Bind address for the control HTTP surface. Overrides AFK_DAEMON_HOST. Defaults to 127.0.0.1 (loopback only). The control surface is UNAUTHENTICATED — bind a non-loopback address (e.g. 0.0.0.0) only on a trusted or firewalled network.',
    )
    .option('-t, --task <command>', 'Command to fire on each tick. Required for the cron and both triggers; optional otherwise.')
    .option('-c, --cron <expression>', 'Cron expression (e.g. "0 */6 * * *"). Required when --trigger includes cron.')
    .option('-i, --task-id <id>', `Task identifier (default: ${COMPILED_DEFAULT_TASK_ID})`)
    .option('--once', 'Fire one tick and exit (for testing)', false)
    .option(
      '--timeout-ms <ms>',
      'Per-tick session timeout in ms. Overrides AFK_TIMEOUT_MS. Defaults to no timeout (0 = unlimited) when unset.',
    )
    .option('--thinking <mode>', "Thinking mode: 'adaptive' | 'disabled' | 'max' | 'enabled:<N>'")
    .option('--effort <level>', "Effort level: low|medium|high|xhigh|max")
    .option(
      '--trigger <mode>',
      "Trigger mode: cron | sessionstart | both | pull. Defaults to 'cron' when --cron is set, else 'sessionstart'.",
    )
    .option(
      '--sessionstart-cooldown-ms <ms>',
      'Cooldown between Phase 6 sessionstart fires. Overrides AFK_SESSIONSTART_COOLDOWN_MS. Defaults to 6h.',
    )
    .option('--dump-prompt [path]', 'Dump resolved SDK prompt+options+provenance to file (default: ~/.afk/logs/prompt-dump-<ISO>.json) or "stderr"')
    .action(async (options: { port: string; host?: string; task?: string; cron?: string; taskId?: string; once: boolean; timeoutMs?: string; thinking?: string; effort?: string; trigger?: string; sessionstartCooldownMs?: string; dumpPrompt?: string | boolean | undefined }) => {
      await runDaemonAction(options);
    });
}
