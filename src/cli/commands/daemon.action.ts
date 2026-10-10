/**
 * Action handler for the `afk daemon` command.
 *
 * Extracted from `registerDaemonCommand` to keep that registration function
 * under the 200-line ceiling. All CLI behaviour, flags, option parsing, and
 * startup logic are preserved byte-identically; this module is simply the body
 * of the `.action()` callback lifted into a named, testable function.
 *
 * @module cli/commands/daemon.action
 */

import { palette } from '../palette.js';
import { env } from '../../config/env.js';
import { runDaemonReconcile } from '../../agent/manifest/startup-reconcile.js';
import { handleCommandError } from '../errors/index.js';
import { startDaemon } from '../../agent/daemon.js';
import { getQueueDir } from '../../paths.js';
import { pushIfConfigured } from '../../telegram/push.js';
import {
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
import {
  parseThinking,
  parseEffort,
  getApiKey,
  getModel,
  getThinking,
  getEffort,
  activateDumpPrompt,
} from '../shared-helpers.js';
import { loadSchedules, toScheduledTask } from '../../agent/daemon/schedule-store.js';
import { appendBuiltinTasks } from './daemon-builtin-tasks.js';
import { ensurePluginEntrypointsLoaded } from '../../agent/tools/skill-bridge.js';
import { providerForModel } from '../../agent/providers/index.js';
import { buildDaemonSessionFactory } from './daemon-session-factory.js';
import { daemonTurnHooks } from './daemon-session-persist.js';
import {
  resolveNotifyChatTarget,
  formatTaskCompletion,
  registerEarlyDaemonCrashHandlers,
} from './daemon.js';
import { parseTerminalState } from './interactive/terminal-state.js';
import { DONE_EVIDENCE_TOOLS } from './interactive/afk-push.js';
import type { TaskCompletionDetails, TelemetryRecord } from '../../agent/daemon/scheduler.js';

/** "Done"-verification probe for the daemon gate. Pure and total — never throws. */
const isDoneUnverified = ({
  responseText,
  successfulToolNames,
}: {
  responseText: string;
  successfulToolNames: readonly string[];
}): boolean => {
  const v = parseTerminalState(responseText);
  return (
    v !== null &&
    v.kind === 'done' &&
    !successfulToolNames.some((n) => DONE_EVIDENCE_TOOLS.has(n))
  );
};

/** Options parsed by Commander for `afk daemon`. */
export interface DaemonActionOptions {
  port: string;
  host?: string;
  task?: string;
  cron?: string;
  taskId?: string;
  once: boolean;
  timeoutMs?: string;
  thinking?: string;
  effort?: string;
  trigger?: string;
  sessionstartCooldownMs?: string;
  dumpPrompt?: string | boolean | undefined;
}

/**
 * Body of the `afk daemon` `.action()` callback, extracted as a named function
 * so `registerDaemonCommand` stays under 200 lines.
 *
 * All argument types, validation logic, startup sequence, and side-effects are
 * identical to the original inline action — nothing is trimmed or reordered.
 */
export async function runDaemonAction(options: DaemonActionOptions): Promise<void> {
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
  if ((trigger === 'cron' || trigger === 'both') && command.trim() === '') {
    handleCommandError(
      new Error(
        'A daemon task is required for the cron and both triggers. Provide one via ' +
          '--task, the AFK_DAEMON_TASK env var, or daemon.task in afk.config.json.',
      ),
    );
  }

  let thinking: ThinkingConfig | undefined;
  let effort: EffortLevel | undefined;
  try {
    thinking = parseThinking(options.thinking) ?? getThinking();
    effort = parseEffort(options.effort) ?? getEffort();
  } catch (err) {
    handleCommandError(err);
  }

  const tasks: ScheduledTask[] =
    trigger === 'pull' || command.trim() === ''
      ? []
      : [
          {
            taskId,
            command,
            trigger,
            ...(options.cron !== undefined ? { cronExpression: options.cron } : {}),
          },
        ];
  const builtinInfo = appendBuiltinTasks(tasks, config, env);

  const persistedSchedules = loadSchedules();
  for (const cfg of persistedSchedules) {
    if (cfg.enabled) {
      tasks.push(toScheduledTask(cfg));
    }
  }

  const bindInFlightSource = registerEarlyDaemonCrashHandlers();
  activateDumpPrompt(options.dumpPrompt);

  const daemonCwd = env.AFK_DAEMON_CWD;
  const daemonModel = getModel();
  const daemonApiKey = getApiKey();
  const daemonCwdResolved =
    daemonCwd !== undefined && daemonCwd.length > 0 ? daemonCwd : undefined;

  await ensurePluginEntrypointsLoaded();

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
      ...(trigger === 'pull'
        ? { pullPollIntervalMs: 30_000, queueDir: getQueueDir() }
        : {}),
      tasks,
      ...(providerForModel(String(daemonModel)) === 'anthropic-direct' &&
      !env.ANTHROPIC_API_KEY &&
      !env.CLAUDE_CODE_OAUTH_TOKEN
        ? {
            oauthRefresher: async () => {
              const { refreshClaudeCodeOauthToken } = await import(
                '../../agent/auth/keychain.js'
              );
              await refreshClaudeCodeOauthToken();
            },
          }
        : {}),
      ...daemonTurnHooks(daemonModel, isDoneUnverified),
      onTaskComplete: (record: TelemetryRecord, details?: TaskCompletionDetails) => {
        const target = resolveNotifyChatTarget(details?.notifyChat, record.taskId);
        void pushIfConfigured(
          formatTaskCompletion(record, details, config.daemon?.verifyDone !== false),
          { markdown: true, ...(target !== undefined ? { target } : {}) },
        ).catch(() => undefined);
      },
    });

    bindInFlightSource(() => handle.scheduler.getInFlightTasks());
    void runDaemonReconcile('');

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
      console.log(
        palette.dim(
          `  task='${taskId}' command='${command}' trigger='${trigger}'${options.cron ? ` cron='${options.cron}'` : ''}`,
        ),
      );
    }
    if (builtinInfo.worktreePruneEnabled) {
      console.log(
        palette.meta(`  + built-in: worktree-prune (cron: ${builtinInfo.worktreePruneCron})`),
      );
    }
    if (builtinInfo.toolHealthEnabled) {
      console.log(palette.meta(`  + built-in: tool-health (cron: ${builtinInfo.toolHealthCron})`));
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
}
