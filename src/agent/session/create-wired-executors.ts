/**
 * SDK factory for the `agent` / `skill` / `compose` executor bundle (#3442).
 *
 * `createWiredExecutors(config, opts)` is the library-caller counterpart of the
 * per-surface wiring the REPL (`bootstrap-infra.ts`) and the web surface
 * (`web-server/session-owner.wiring.ts`) perform: ONE root manager and three
 * executors from {@link wireExecutors}, forking from a deferred parent proxy
 * that resolves to the owning `AgentSession` once the session binds the
 * bundle (`AgentConfig.executors` → `bindSessionExecutors` in the ctor).
 *
 * Invariant: this module lives in the agent layer and must not import
 * `src/cli` or `src/web-server`. Credentials come from the agent-layer
 * `resolveCredentialForModel`; the default subagent model from the relocated
 * {@link getDefaultSubagentModel}.
 *
 * Contract (SDK isolation defaults): unlike the CLI surfaces, the bundle does
 * NOT scan `~/.afk/plugins` or imported roots unless the caller passes
 * `pluginConfigs`, wires no background registry, writes no trace unless a
 * `traceWriter` is passed, and routes named-agent scan warnings to `warn`
 * (default: silent).
 *
 * @module agent/session/create-wired-executors
 */

import { wireExecutors, type WiredExecutors } from './wire-executors.js';
import { resolveCredentialForModel } from '../auth/credential-resolver.js';
import { getDefaultSubagentModel } from './default-subagent-model.js';
import { createSessionBindSlot, type SessionExecutors } from './session-executors.js';
import { makeDeferredParentProxy } from './deferred-parent-proxy.js';
import type { AgentConfig } from '../types.js';
import type { HookRegistry } from '../hooks.js';
import type { SdkPluginConfig } from '../types/sdk-types.js';
import type { TraceSink } from '../trace/writer.js';


/** Options for {@link createWiredExecutors}. */
export interface CreateWiredExecutorsOptions {
  /**
   * Expose the `agent` tool. Toggle semantics: when an options object is
   * passed, an omitted toggle means OFF; when `opts` itself is omitted, all
   * three tools are ON.
   */
  agent?: boolean;
  /**
   * Expose the `skill` tool. A `string[]` enables it AND restricts it to the
   * listed skill names (exact string equality at every nesting depth; see
   * `WireExecutorsOptions.skillAllowlist`).
   */
  skill?: boolean | readonly string[];
  /** Expose the `compose` tool. */
  compose?: boolean;
  /**
   * The SOLE plugin source for plugin agents and plugin skills at every depth.
   * Default `[]`: no `~/.afk/plugins` scan and no imported roots.
   */
  pluginConfigs?: SdkPluginConfig[];
  /**
   * Hook registry for the root manager and every nested manager. Falls back to
   * `config.hookRegistry`. One of the two (or `unattended: true`) is required.
   */
  hookRegistry?: HookRegistry;
  /**
   * Explicit opt-out of hooks. With no registry this proceeds WITHOUT one:
   * SubagentStart/Stop hooks (and the plugin hooks / SQLite memory store that
   * `createDefaultHookRegistry` would install) never run. Nothing is silently
   * constructed on the caller's behalf.
   */
  unattended?: boolean;
  /** Sink for scan / configuration warnings. Default: no-op. */
  warn?: (msg: string) => void;
  /** Witness writer for the manager, `agent`, `skill`, and compose paths. Default: none. */
  traceWriter?: TraceSink;
}

/** Return value of {@link createWiredExecutors}. */
export interface CreatedWiredExecutors {
  /** Pass as `AgentConfig.executors` (one bundle per `AgentSession`). */
  executors: SessionExecutors;
  /** Abort + drain in-flight children. Idempotent; safe before or after `session.close()`. */
  dispose(): Promise<void>;
}

interface ResolvedToggles {
  agent: boolean;
  skill: boolean;
  compose: boolean;
  skillAllowlist: readonly string[] | undefined;
}

/** Resolve the tool toggles: `opts` omitted => all on; passed => omitted = off. */
function resolveToggles(opts: CreateWiredExecutorsOptions | undefined): ResolvedToggles {
  if (opts === undefined) return { agent: true, skill: true, compose: true, skillAllowlist: undefined };
  const skill = opts.skill;
  const isList = Array.isArray(skill);
  return {
    agent: opts.agent === true,
    skill: isList || skill === true,
    compose: opts.compose === true,
    skillAllowlist: isList ? [...(skill as readonly string[])] : undefined,
  };
}

/**
 * Fail closed on hooks: a registry must be supplied (opts or config) unless the
 * caller explicitly opts out with `unattended: true`.
 */
function resolveHookRegistry(
  config: AgentConfig,
  opts: CreateWiredExecutorsOptions | undefined,
): HookRegistry | undefined {
  const registry = opts?.hookRegistry ?? config.hookRegistry;
  if (registry !== undefined || opts?.unattended === true) return registry;
  throw new Error(
    'createWiredExecutors: no hook registry. Pass `opts.hookRegistry` or `config.hookRegistry`, ' +
      'or set `unattended: true` to run subagents without SubagentStart/Stop hooks.',
  );
}

/** Warn once each for config fields the SDK executor path does not honor. */
function warnIgnoredConfig(config: AgentConfig, warn: (msg: string) => void): void {
  if (config.agents !== undefined) {
    warn(
      'createWiredExecutors: `config.agents` is ignored on the SDK executor path; ' +
        'named agents come from the built-in/user/project registry and `pluginConfigs`.',
    );
  }
  if (config.mcpServers !== undefined) {
    warn(
      'createWiredExecutors: `config.mcpServers` is ignored on the SDK executor path; ' +
        'MCP tools require a caller-owned `config.mcpManager`.',
    );
  }
}

/** Optional endpoint + prompt fields copied from `config` (absent stays absent). */
function configPassThrough(config: AgentConfig): {
  systemPrompt?: string; cwd?: string; nestedCwd?: string;
  baseUrl?: string; openaiBaseUrl?: string; xaiBaseUrl?: string;
} {
  return {
    ...(typeof config.systemPrompt === 'string' ? { systemPrompt: config.systemPrompt } : {}),
    ...(config.cwd !== undefined ? { cwd: config.cwd, nestedCwd: config.cwd } : {}),
    ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
    ...(config.openaiBaseUrl !== undefined ? { openaiBaseUrl: config.openaiBaseUrl } : {}),
    ...(config.xaiBaseUrl !== undefined ? { xaiBaseUrl: config.xaiBaseUrl } : {}),
  };
}

/**
 * Build a wired `agent` / `skill` / `compose` executor bundle for an SDK
 * `AgentSession` (or `query()` / `queryText()` via `QueryOptions.executors`).
 *
 * Throws when no hook registry is available and `unattended` is not set.
 * The returned bundle binds to exactly one session (a second bind throws);
 * its `drain` runs on `session.close()` and `dispose()` is an idempotent
 * equivalent for callers that never construct or close a session.
 */
export function createWiredExecutors(
  config: AgentConfig,
  opts?: CreateWiredExecutorsOptions,
): CreatedWiredExecutors {
  const hookRegistry = resolveHookRegistry(config, opts);
  const toggles = resolveToggles(opts);
  const warn = opts?.warn ?? ((): void => {});
  warnIgnoredConfig(config, warn);

  const slot = createSessionBindSlot();
  // Invariant: every member is read lazily (at execute time) — `bind` runs in
  // the AgentSession ctor before the session's provider lifecycle exists.
  // The proxy is built by the shared helper; `slot` is kept solely to enforce
  // the one-bundle-per-session double-bind throw (see SessionExecutors.bind).
  const { proxy: parentSession, bind: bindParent } = makeDeferredParentProxy();

  const model = config.model;
  const wired: WiredExecutors = wireExecutors({
    surface: 'sdk',
    parentSession,
    apiKey: config.apiKey ?? resolveCredentialForModel(model),
    model,
    managerParentModel: model,
    defaultSubagentModel: getDefaultSubagentModel(model),
    resolveApiKeyForModel: (m) => resolveCredentialForModel(m),
    ...configPassThrough(config),
    ...(opts?.traceWriter !== undefined ? { traceWriter: opts.traceWriter, skillTraceWriter: opts.traceWriter } : {}),
    agentRegistryWarn: warn,
    pluginConfigs: opts?.pluginConfigs ?? [],
    ...(toggles.skillAllowlist !== undefined ? { skillAllowlist: toggles.skillAllowlist } : {}),
    ...(hookRegistry !== undefined ? { hookRegistry } : {}),
  });

  const drain = (reason: string): Promise<{ drained: number; timedOut: boolean }> =>
    wired.rootManager.abortAllAndDrain('session_end', 'user_signal', undefined, reason === 'reset');

  const executors: SessionExecutors = {
    ...(toggles.agent ? { subagentExecutor: wired.subagentExecutor } : {}),
    ...(toggles.skill ? { skillExecutor: wired.skillExecutor } : {}),
    ...(toggles.compose ? { composeExecutor: wired.composeExecutor } : {}),
    bind(session) {
      slot.bind(session); // throws on a second bind, before any rewiring
      bindParent(session);
      const record = (usage?: Parameters<typeof session.recordSubagentCompletion>[0], costUsd?: number): void => {
        session.recordSubagentCompletion(usage, costUsd);
      };
      wired.rootManager.setOnSubagentSucceeded(record);
      wired.composeExecutor.setOnSubagentSucceeded(record);
    },
    drain,
  };

  return {
    executors,
    async dispose() { await drain('close'); },
  };
}
