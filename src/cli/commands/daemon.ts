import { Command } from 'commander';
import { env } from '../../config/env.js';
import path from 'path';
import { palette } from '../palette.js';
import { handleCommandError } from '../errors/index.js';
import os from 'os';
import { startDaemon } from '../../agent/daemon.js';
import { getQueueDir } from '../../paths.js';
import { pushIfConfigured } from '../../telegram/push.js';
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
import type { AgentConfig, ThinkingConfig, EffortLevel, AgentModelInput } from '../../agent/types.js';
import type { ScheduledTask } from '../../agent/daemon/triggers.js';
import { parseThinking, parseEffort, getApiKey, getApiKeyForModel, getModel, getThinking, getEffort, parseProvider, getDefaultSubagentModel, getMaxToolUseIterations } from '../shared-helpers.js';
import { loadSchedules, toScheduledTask } from '../../agent/daemon/schedule-store.js';
import { AgentSession } from '../../agent/session.js';
import { MemoryStore, injectHotMemory } from '../../agent/memory/index.js';
import { SubagentManager } from '../../agent/subagent.js';
import { SubagentExecutor } from '../../agent/tools/subagent-executor.js';
import { SkillExecutor } from '../../agent/tools/skill-executor.js';
import { ComposeExecutor } from '../../agent/tools/compose-executor.js';
import { ensurePluginEntrypointsLoaded, discoverPluginAgents } from '../../agent/tools/skill-bridge.js';
import { createChildProviderFactory, createChildSkillExecutorFactory, createStubParentSession } from '../../agent/tools/nesting.js';
import { loadAgentRegistry } from '../../agent/agents/index.js';
import { AnthropicDirectProvider } from '../../agent/providers/anthropic-direct/index.js';
import { BUILTIN_TOOL_NAMES } from '../../agent/tools/schemas.js';
import { MEMORY_TOOL_NAMES } from '../../agent/memory/index.js';
import { AWARENESS_TOOL_NAMES } from '../../agent/awareness/index.js';

/**
 * Options for {@link buildDaemonSessionFactory}.
 */
export interface BuildDaemonSessionFactoryOpts {
  model: AgentModelInput;
  apiKey?: string;
  baseUrl?: string;
  openaiBaseUrl?: string;
  cwd?: string;
}

/**
 * Build the fully-wired session factory daemon tasks need so that
 * skill-dispatching commands like `/forge-friction --auto` or `/review pr 123`
 * can call the `skill`, `agent`, and `compose` tools.
 *
 * // Invariant: mirrors the executor-wiring order in chat.ts.
 * // The order matters because each executor closes over the ones constructed
 * // above it:
 * //   1. SubagentManager  — root manager for all forked children
 * //   2. childProviderFactory — routes child model → AnthropicDirect / OpenAICompatible
 * //   3. childSkillExecutorFactory — depth-aware factory for nested skill children
 * //   4. SubagentExecutor — wires the `agent` tool
 * //   5. SkillExecutor    — wires the `skill` tool
 * //   6. ComposeExecutor  — wires the `compose` tool
 * //   7. parseProvider()  — builds the root provider with all three executors,
 * //      falling back to AnthropicDirectProvider for Anthropic-routed models.
 * //
 * // The returned factory receives a config that spawnSession() has already
 * // populated (including permissionMode:'bypassPermissions'). The config is
 * // preserved via spread so no caller-set field is lost.
 */
export function buildDaemonSessionFactory(
  opts: BuildDaemonSessionFactoryOpts,
): (config: AgentConfig) => AgentSession {
  // Invariant: exactly one MemoryStore per daemon process. The constructor
  // opens a SQLite handle synchronously (see memory-store.ts), so building a
  // fresh store inside the per-task closure would leak one file descriptor on
  // every cron tick for the daemon's (long) lifetime AND violate the
  // single-instance-per-DB-file rule chat.ts documents as the "C7 fix". We
  // lazily create the store on the first task spawn and reuse it across every
  // task session, which also gives cross-task memory continuity for free. The
  // store is intentionally not closed here: the daemon owns it for its whole
  // process lifetime and the SIGINT/SIGTERM shutdown path ends in
  // process.exit(), which reclaims the descriptor.
  let memoryStore: MemoryStore | undefined;
  return (config: AgentConfig): AgentSession => {
    // Ephemeral abort controller — the daemon root session has no parent
    // to propagate cancellation from.
    const abortCtrl = new AbortController();
    const stubParent = createStubParentSession(abortCtrl.signal);

    const rootManager = new SubagentManager({
      ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
      // Parent model → provider, so the fork-time credential fallback never
      // crosses the provider boundary (see SubagentManager.parentProvider).
      parentModel: opts.model,
      ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      // Origin attribution: the daemon is a `daemon` entrypoint. Thread the
      // surface so forked `agent`-tool children inherit origin 'daemon' (not
      // 'unknown') via forkSubagent's parentSurface fill. Mirrors farm.ts.
      surface: 'daemon',
    });

    const childProviderFactory = createChildProviderFactory(
      opts.openaiBaseUrl !== undefined ? { openaiBaseUrl: opts.openaiBaseUrl } : {},
    );

    // Named-agent registry: session-static scan enabling `agent_type`
    // dispatch for daemon-run tasks (builtin + user + project scopes).
    const agentRegistry = loadAgentRegistry({
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      pluginAgents: discoverPluginAgents(),
    });

    const childSkillExecutorFactory = createChildSkillExecutorFactory(
      opts.model,
      opts.apiKey,
      childProviderFactory,
      opts.baseUrl,
      // traceWriter: daemon has no trace writer — pass undefined
      undefined,
      // backgroundRegistry: daemon has no background registry — pass undefined
      undefined,
      opts.cwd,
      // Per-model credential resolver — see bootstrap.ts for rationale.
      getApiKeyForModel,
      // Surface: daemon skill executor children inherit origin 'daemon'.
      'daemon',
      // Resolved default-subagent model threaded into nested skill executors
      // so skill→skill / skill→agent chains inherit the SAME policy as the
      // top-level executors — closing the leak where a nested subagent
      // silently defaulted to Anthropic `sonnet` under an OpenAI-routed parent.
      getDefaultSubagentModel(opts.model),
      // Named-agent registry propagates to nested skill executors.
      agentRegistry,
      // OpenAI endpoint → nested restricted/depth-cap provider builders.
      opts.openaiBaseUrl,
    );

    const subagentExecutor = new SubagentExecutor({
      subagentManager: rootManager,
      parentSession: stubParent,
      // Session origin for routing-decision telemetry (daemon/scheduler → daemon).
      surface: 'daemon',
      defaultConfig: {
        ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
        ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
        ...(opts.openaiBaseUrl !== undefined ? { openaiBaseUrl: opts.openaiBaseUrl } : {}),
      },
      defaultSubagentModel: getDefaultSubagentModel(opts.model),
      childProviderFactory,
      childSkillExecutorFactory,
      // Per-model credential resolver — see bootstrap.ts for rationale.
      resolveApiKeyForModel: getApiKeyForModel,
      depth: 0,
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      // Named-agent dispatch: registry + `inherit` anchor.
      agentRegistry,
      parentModel: opts.model,
    });

    const skillExecutor = new SkillExecutor({
      parentSession: stubParent,
      // Session origin for skill-invocation + routing telemetry (daemon → daemon).
      surface: 'daemon',
      defaultModel: opts.model,
      defaultSubagentModel: getDefaultSubagentModel(opts.model),
      ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
      childProviderFactory,
      childSkillExecutorFactory,
      // Named-agent registry for skill-forked orchestrator children.
      agentRegistry,
      // Per-model credential resolver — mirrors bootstrap.ts / chat.ts.
      resolveApiKeyForModel: getApiKeyForModel,
      ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
      ...(opts.openaiBaseUrl !== undefined ? { openaiBaseUrl: opts.openaiBaseUrl } : {}),
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      // Read-scope inheritance (#547): skill-forked children inherit the parent
      // session's read scope via the root manager. See bootstrap.ts.
      getReadScopeInputs: () => rootManager.getReadScopeInputs(),
    });

    const composeExecutor = new ComposeExecutor({
      parentSession: stubParent,
      defaultModel: opts.model,
      defaultSubagentModel: getDefaultSubagentModel(opts.model),
      ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
      // Per-model credential resolver — mirrors #640 for the compose fork-path.
      resolveApiKeyForModel: getApiKeyForModel,
      // Read-scope inheritance (#547): DAG nodes inherit the parent session's
      // read scope via the root manager. See bootstrap.ts.
      getReadScopeInputs: () => rootManager.getReadScopeInputs(),
      ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
      // Anchor DAG nodes to the worktree (re-anchored via composeExecutor.setCwd).
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      systemPrompt: '',
      // Session identity for routing-decision rows (daemon/scheduler → daemon).
      surface: 'daemon',
      depth: 0,
    });

    memoryStore ??= new MemoryStore();
    const mcpManager = config.mcpManager;
    const mcpToolWireNames = mcpManager?.getMcpToolWireNames() ?? [];

    const provider = parseProvider(undefined, {
      subagentExecutor,
      skillExecutor,
      composeExecutor,
      memoryStore,
      model: String(opts.model),
      ...(opts.openaiBaseUrl !== undefined ? { openaiBaseUrl: opts.openaiBaseUrl } : {}),
      ...(mcpManager !== undefined ? { mcpManager } : {}),
    }) ?? new AnthropicDirectProvider({
      permissions: {
        allowedTools: [...BUILTIN_TOOL_NAMES, ...MEMORY_TOOL_NAMES, ...AWARENESS_TOOL_NAMES, 'agent', 'skill', 'compose', ...mcpToolWireNames],
      },
      subagentExecutor,
      skillExecutor,
      composeExecutor,
      memoryStore,
      surface: 'daemon',
      ...(mcpManager !== undefined ? { mcpManager } : {}),
    });

    // Opt-in top-level tool-use-round ceiling. Explicit caller config wins;
    // AFK_MAX_TOOL_USE_ITERATIONS is the fallback (undefined/<=0 → unlimited, no
    // behavior change). Resolved after `...config` so an explicit value on the
    // caller's config takes precedence over the env default. This is the
    // production chokepoint the scheduler routes every task through, so it also
    // caps scheduler/cron-spawned top-level sessions.
    const daemonMaxToolUseIterations = config.maxToolUseIterations ?? getMaxToolUseIterations();
    return new AgentSession(injectHotMemory({
      ...config,
      provider,
      // Daemon sessions are headless: no human watches to answer ask_question.
      // Stamped after `...config` so it is forced regardless of caller config;
      // this is the production chokepoint the scheduler routes every task
      // through, so it also covers scheduler/cron-spawned sessions.
      isNonInteractive: true,
      // User-facing surface for trace `origin` attribution. Forced after
      // `...config` for the same reason as `isNonInteractive`: every daemon +
      // scheduler/cron session routes through here → 'daemon'.
      surface: 'daemon',
      ...(daemonMaxToolUseIterations !== undefined
        ? { maxToolUseIterations: daemonMaxToolUseIterations }
        : {}),
    }));
  };
}

/**
 * Format a daemon telemetry record for an out-of-band notification
 * (e.g. Telegram push). Short, scannable, status-first.
 */
export function formatTaskCompletion(
  record: TelemetryRecord,
  details: TaskCompletionDetails = {},
): string {
  const icon =
    record.status === 'success' ? '✅' : record.status === 'skipped' ? '⏭️' : '❌';
  const durationSec = (record.durationMs / 1000).toFixed(1);
  const lines = [
    `${icon} daemon task: ${record.taskId} (${record.status})`,
    `trigger=${record.trigger} duration=${durationSec}s`,
  ];
  if (record.skipReason) lines.push(`skipReason=${record.skipReason}`);
  if (record.errorMessage) lines.push(`error: ${record.errorMessage.slice(0, 400)}`);
  const responseText = details.responseText ?? record.responseExcerpt;
  if (responseText) {
    lines.push('', responseText);
  }
  return lines.join('\n');
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
      'Per-tick session timeout in ms. Overrides AFK_TIMEOUT_MS. Defaults to the session default (120000).',
    )
    .option('--thinking <mode>', "Thinking mode: 'adaptive' | 'disabled' | 'enabled:<N>'")
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
        command: '__BUILTIN_WORKTREE_PRUNE__',
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

      const daemonModel = getModel();
      const daemonApiKey = getApiKey();
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
            ...(daemonCwdResolved !== undefined ? { cwd: daemonCwdResolved } : {}),
          },
          sessionFactory,
          ...(cooldownMs !== undefined ? { cooldownMs } : {}),
          ...(trigger === 'pull' ? { pullPollIntervalMs: 30_000, queueDir: getQueueDir() } : {}),
          tasks,
          onTaskComplete: (record: TelemetryRecord, details?: TaskCompletionDetails) => {
            // markdown:true — task output is agent-authored markdown; render it
            // to Telegram HTML so **bold**/`code`/headers format instead of
            // showing their literal markers (plain-text fallback on parse error).
            void pushIfConfigured(formatTaskCompletion(record, details), { markdown: true }).catch(() => undefined);
          },
        });

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
