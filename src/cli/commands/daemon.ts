import { Command } from 'commander';
import { env } from '../../config/env.js';
import path from 'path';
import { runNonInteractiveReconcile } from '../../agent/manifest/startup-reconcile.js';
import { palette } from '../palette.js';
import { handleCommandError } from '../errors/index.js';
import os from 'os';
import { startDaemon } from '../../agent/daemon.js';
import { getQueueDir } from '../../paths.js';
import { pushIfConfigured } from '../../telegram/push.js';
import { resolveChatTarget, loadChatAliases } from '../../telegram/notify-routing.js';
import { parseAllowedChatIds, isChatAllowed } from '../../telegram/allowlist.js';
import { parseTerminalState } from './interactive/terminal-state.js';
import { DONE_EVIDENCE_TOOLS } from './interactive/afk-push.js';
import type { TaskCompletionDetails, TelemetryRecord } from '../../agent/daemon/scheduler.js';
import {
  COMPILED_DEFAULT_TASK_ID,
  resolveDaemonHost,
  resolveDaemonTimeoutMs,
  resolveDefaultTask,
  resolveDefaultTaskId,
  resolveSessionStartCooldownMs,
  resolveTriggerMode,
  isLoopbackHost,
} from '../daemon-options.js';
import { loadConfig } from '../config.js';
import type { ThinkingConfig, EffortLevel } from '../../agent/types.js';
import type { ScheduledTask } from '../../agent/daemon/triggers.js';
import { parseThinking, parseEffort, getApiKey, getModel, getThinking, getEffort } from '../shared-helpers.js';
import { loadSchedules, toScheduledTask } from '../../agent/daemon/schedule-store.js';
import { ensurePluginEntrypointsLoaded } from '../../agent/tools/skill-bridge.js';
import { providerForModel } from '../../agent/providers/index.js';
import { buildDaemonSessionFactory } from './daemon-session-factory.js';
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
  const icon =
    record.status === 'success' ? '✅' : record.status === 'skipped' ? '⏭️' : '❌';
  const durationSec = (record.durationMs / 1000).toFixed(1);
  const header = downgraded
    ? `⚠️ Done (unverified) — daemon task: ${record.taskId} (${record.status})`
    : `${icon} daemon task: ${record.taskId} (${record.status})`;
  const lines = [
    header,
    `trigger=${record.trigger} duration=${durationSec}s`,
  ];
  if (record.skipReason) lines.push(`skipReason=${record.skipReason}`);
  if (record.errorMessage) lines.push(`error: ${record.errorMessage.slice(0, 400)}`);
  const responseText = details.responseText ?? record.responseExcerpt;
  if (responseText) {
    lines.push('', responseText);
  }
  if (downgraded) {
    lines.push('', DAEMON_DONE_UNVERIFIED_CAVEAT);
  }
  return lines.join('\n');
}

/** "Done"-verification probe for the daemon gate. Pure and total — never throws. */
const isDoneUnverified = ({ responseText, successfulToolNames }: { responseText: string; successfulToolNames: readonly string[] }): boolean => {
  const v = parseTerminalState(responseText);
  return v !== null && v.kind === 'done' && !successfulToolNames.some((n) => DONE_EVIDENCE_TOOLS.has(n));
};

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
      'Per-tick session timeout in ms. Overrides AFK_TIMEOUT_MS. Defaults to the session default (120000).',
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
      const port = parseInt(options.port, 10);
      if (Number.isNaN(port) || port <= 0) {
        handleCommandError(new Error(`Invalid port: ${options.port}`));
      }

      const config = loadConfig();
      const command = resolveDefaultTask(
        options.task,
        env.AFK_DAEMON_TASK,
        config.daemon?.task,
      );
      const taskId = resolveDefaultTaskId(
        options.taskId,
        env.AFK_DAEMON_TASK_ID,
        config.daemon?.taskId,
      );
      const host = resolveDaemonHost(options.host, env.AFK_DAEMON_HOST);

      let timeoutMs: number | undefined;
      let cooldownMs: number | undefined;
      let trigger: 'cron' | 'sessionstart' | 'both' | 'pull';
      try {
        timeoutMs = resolveDaemonTimeoutMs(options.timeoutMs, env.AFK_TIMEOUT_MS);
        cooldownMs = resolveSessionStartCooldownMs(
          options.sessionstartCooldownMs,
          env.AFK_SESSIONSTART_COOLDOWN_MS,
        );
        trigger = resolveTriggerMode(options.trigger, options.cron);
      } catch (err) {
        handleCommandError(err);
      }

      if ((trigger === 'cron' || trigger === 'both') && !options.cron) {
        handleCommandError(new Error(`--cron is required when --trigger is '${trigger}'.`));
      }
      // A task is mandatory for cron/both: the user scheduled a tick but, with
      // no --task / AFK_DAEMON_TASK / daemon.task, there is nothing to run. Fail
      // clearly instead of registering an empty default task (historically this
      // fell back to an internal-only skill a public build cannot execute).
      if ((trigger === 'cron' || trigger === 'both') && command.trim() === '') {
        handleCommandError(
          new Error(
            'A daemon task is required for the cron and both triggers. Provide one via ' +
              '--task, the AFK_DAEMON_TASK env var, or daemon.task in afk.config.json.',
          ),
        );
      }
      // pull mode: no cron expression needed — tasks are dequeued from the queue directory

      let thinking: ThinkingConfig | undefined;
      let effort: EffortLevel | undefined;
      try {
        thinking = parseThinking(options.thinking) ?? getThinking();
        effort = parseEffort(options.effort) ?? getEffort();
      } catch (err) {
        handleCommandError(err);
      }

      const worktreePruneConfig = config.daemon?.worktreePrune;
      const worktreePruneDisabled = env.AFK_WORKTREE_PRUNE_DISABLE === '1';
      const WORKTREE_PRUNE_CRON = worktreePruneConfig?.cron ?? '0 4 * * *';

      const worktreePruneTask: ScheduledTask = {
        taskId: 'worktree-prune',
        executor: 'builtin',
        command: 'worktree-prune',
        trigger: 'cron',
        cronExpression: WORKTREE_PRUNE_CRON,
      };

      // In pull mode, the task queue is file-driven — no ScheduledTask registered.
      // For other trigger modes, register the default task only when one is
      // actually configured: with an empty command the daemon runs just its
      // persisted schedules + worktree-prune rather than fabricating a task.
      // (cron/both with an empty task already errored above.)
      const tasks: ScheduledTask[] = (trigger === 'pull' || command.trim() === '')
        ? []
        : [{
            taskId,
            command,
            trigger,
            ...(options.cron !== undefined ? { cronExpression: options.cron } : {}),
          }];
      if (!worktreePruneDisabled && worktreePruneConfig?.enabled !== false) {
        tasks.push(worktreePruneTask);
      }

      // Load persisted schedules from ~/.afk/config/schedules.json
      const persistedSchedules = loadSchedules();
      for (const config of persistedSchedules) {
        if (config.enabled) {
          tasks.push(toScheduledTask(config));
        }
      }

      if (options.dumpPrompt !== undefined && options.dumpPrompt !== false) {
        const val = options.dumpPrompt === true
          ? path.join(os.homedir(), '.afk', 'logs', `prompt-dump-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
          : (options.dumpPrompt as string);
        process.env['AFK_DUMP_PROMPT'] = val;
      }

      // Crash-notification rate guard: at most one push per 60s, regardless
      // of how many uncaught errors fire (prevents crash-loop self-DOS that
      // would saturate Telegram's API rate limit and silence *all* future
      // notifications from this bot).
      let lastCrashPushAt = 0;
      const CRASH_PUSH_GUARD_MS = 60_000;
      const notifyCrash = (kind: string, err: unknown): void => {
        const nowMs = Date.now();
        if (nowMs - lastCrashPushAt < CRASH_PUSH_GUARD_MS) return;
        lastCrashPushAt = nowMs;
        const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        void pushIfConfigured(
          `🛑 agent-afk daemon ${kind}\n${msg.slice(0, 500)}`,
        ).catch((pushErr: unknown) => {
          console.error('[daemon] crash notification push failed:', pushErr instanceof Error ? pushErr.message : String(pushErr));
        });
      };
      process.on('uncaughtException', (err) => {
        notifyCrash('uncaughtException', err);
        process.exit(1);
      });
      process.on('unhandledRejection', (err) => {
        notifyCrash('unhandledRejection', err);
        process.exit(1);
      });

      // Optional working-directory override for daemon-spawned sessions.
      // When set, every scheduled task's AgentSession (and its forked
      // subagents) operates in this directory rather than the daemon
      // process's `process.cwd()`. Use this to point the daemon at a
      // specific repo/worktree without changing cwd before launch.
      const daemonCwd = env.AFK_DAEMON_CWD;

      const daemonModel = getModel(), daemonApiKey = getApiKey();
      const daemonCwdResolved = daemonCwd !== undefined && daemonCwd.length > 0 ? daemonCwd : undefined;

      // Import any plugin JS entrypoints (manifest `main`) once at daemon
      // startup, before the session factory is built and before the scheduler
      // spawns any task session. Each daemon-spawned session assembles its skill
      // manifest synchronously at construction, so a plugin's registerSkill()
      // side-effects must already have run for its code-backed skills (e.g. a
      // scheduled task command) to resolve. Idempotent + non-fatal; no-op
      // without plugins.
      await ensurePluginEntrypointsLoaded();

      // Build a fully-wired session factory so skill/agent/compose tools are
      // available in daemon-spawned sessions. Without this, commands like
      // `/forge-friction --auto` fail because the bare provider constructed by
      // resolveProvider() omits the three orchestration tools.
      const sessionFactory = buildDaemonSessionFactory({
        model: daemonModel,
        ...(daemonApiKey !== undefined ? { apiKey: daemonApiKey } : {}),
        ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
        ...(config.openaiBaseUrl !== undefined ? { openaiBaseUrl: config.openaiBaseUrl } : {}),
        ...(daemonCwdResolved !== undefined ? { cwd: daemonCwdResolved } : {}),
      });

      try {
        const handle = await startDaemon({
          port,
          host,
          // Transient one-tick runs must not claim (and on exit delete) the
          // shared port-discovery file the service daemon's live-sync needs.
          ...(options.once ? { writePortFile: false } : {}),
          sessionConfig: {
            model: daemonModel,
            ...(daemonApiKey !== undefined ? { apiKey: daemonApiKey } : {}),
            ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            ...(thinking !== undefined ? { thinking } : {}),
            ...(effort !== undefined ? { effort } : {}),
            ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
            ...(daemonCwdResolved !== undefined ? { cwd: daemonCwdResolved } : {}),
          },
          sessionFactory,
          ...(cooldownMs !== undefined ? { cooldownMs } : {}),
          ...(trigger === 'pull' ? { pullPollIntervalMs: 30_000, queueDir: getQueueDir() } : {}),
          tasks,
          // Proactive OAuth refresh (#1296) — only for OAuth-routed sessions.
          ...(providerForModel(String(daemonModel)) === 'anthropic-direct' && !env.ANTHROPIC_API_KEY && !env.CLAUDE_CODE_OAUTH_TOKEN ? { oauthRefresher: async () => { const { refreshClaudeCodeOauthToken } = await import('../../agent/auth/keychain.js'); await refreshClaudeCodeOauthToken(); } } : {}),
          // "Done"-verification probe — see `isDoneUnverified` above.
          doneUnverifiedProbe: isDoneUnverified,
          onTaskComplete: (record: TelemetryRecord, details?: TaskCompletionDetails) => {
            // markdown:true — task output is agent-authored markdown; render it
            // to Telegram HTML so **bold**/`code`/headers format instead of
            // showing their literal markers (plain-text fallback on parse error).
            // Invariant: in unattended execution, a self-certified Done with
            // no corroborating evidence is flagged by default. Opt-OUT via
            // daemon.verifyDone: false.
            //
            // notifyChat routing: when the triggering task set an explicit
            // notifyChat, resolve it (alias/number) and FAIL-CLOSED against the
            // allowlist here — the scheduler deliberately doesn't (layering).
            // A resolvable, allowlisted target overrides the default routing;
            // anything else logs a warning and falls back to the default target
            // (never silently drops the completion notification).
            const target = resolveNotifyChatTarget(details?.notifyChat, record.taskId);
            void pushIfConfigured(
              formatTaskCompletion(record, details, config.daemon?.verifyDone !== false),
              { markdown: true, ...(target !== undefined ? { target } : {}) },
            ).catch(() => undefined);
          },
        });

        // Wave-manifest reconciliation at daemon startup: surface resumption
        // offers for unfinished work. Non-interactive — requires
        // AFK_WAVE_RESUME_UNATTENDED=1. Fire-and-forget.
        runNonInteractiveReconcile('');

        if (options.once) {
          console.log(palette.info(`▶ Firing task '${taskId}' once...`));
          const record = await handle.tickOnce(taskId);
          console.log(JSON.stringify(record, null, 2));
          await handle.stop();
          process.exit(record.status === 'success' ? 0 : 1);
        }

        if (trigger === 'sessionstart' || trigger === 'both') {
          const records = await handle.fireOnStart();
          for (const record of records) {
            const marker =
              record.status === 'success' ? '✔' : record.status === 'skipped' ? '⏭' : '✗';
            console.log(palette.info(`${marker} sessionstart: ${JSON.stringify(record)}`));
          }
        }

        console.log(palette.success(`✔ Daemon listening on http://${handle.host}:${handle.port}`));
        if (!isLoopbackHost(handle.host)) {
          console.log(
            palette.warning(
              `⚠ Control surface bound to ${handle.host} (non-loopback) and is UNAUTHENTICATED — ` +
                `anyone who can reach this port can schedule commands the daemon will run. ` +
                `Ensure the port is firewalled / on a trusted network.`,
            ),
          );
        }
        if (trigger === 'pull') {
          console.log(palette.success(`✔ Daemon in pull mode`));
          console.log(palette.dim(`  polling queue: ${getQueueDir()} every 30s`));
        } else {
          console.log(palette.dim(`  task='${taskId}' command='${command}' trigger='${trigger}'${options.cron ? ` cron='${options.cron}'` : ''}`));
        }
        if (tasks.length > 1) {
          console.log(palette.meta(`  + built-in: worktree-prune (cron: ${WORKTREE_PRUNE_CRON})`));
        }
        console.log(palette.dim('  Press Ctrl+C to stop.'));

        const shutdown = async (): Promise<void> => {
          console.log(palette.dim('\n· Shutting down daemon...'));
          await handle.stop();
          process.exit(0);
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
      } catch (err) {
        handleCommandError(err);
      }
    });
}
