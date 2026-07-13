/**
 * Shared types for the skill-executor module family.
 *
 * `SkillExecutorContext` is the public wiring surface (re-exported through
 * the `skill-executor.ts` facade so consumer imports never change).
 * `SkillExecutorInternals` is the private deps object the extracted
 * per-strategy modules (`load-mode.ts`, `fork-child-config.ts`,
 * `fork-dispatch.ts`) receive from the `SkillExecutor` class — it exposes
 * exactly the executor state those free functions read (`ctx` +
 * `currentCwd`), keeping the coupling visible at the call site. Mirrors the
 * `BuildChildConfigArgs` seam in `subagent/child-config.ts`.
 *
 * @module agent/tools/skill-executor/types
 */

import type { AgentModelInput, IAgentSession } from '../../types.js';
import type { ModelProvider } from '../../provider.js';
import type { TraceWriter } from '../../trace/index.js';
import type { BackgroundAgentRegistry } from '../../background-registry.js';
import type { SdkPluginConfig } from '../../types/sdk-types.js';
import type { ChildProviderFactoryArgs } from '../nesting.js';
import type { Surface } from '../../awareness/types.js';
import type { ReadScopeInputs } from '../../subagent-read-scope.js';
import type { SkillExecutor } from '../skill-executor.js';

export interface SkillExecutorContext {
  parentSession: Pick<IAgentSession, 'sessionId' | 'getInputStreamRef' | 'abortSignal'> &
    // Optional: a skill orchestrator forked under a parent that exposes its
    // hook registry dispatches SubagentStop (incl. the shadow-verify nudge)
    // back to that parent. See SubagentManager.forkSubagent's parent fallback.
    Partial<Pick<IAgentSession, 'hookRegistry'>>;
  defaultModel?: string;
  /**
   * User-facing surface of the session that owns this executor (cli/telegram/
   * daemon). Set at top-level wiring sites. Recorded as `origin` on the
   * skill-invocation + routing rows this executor emits. `actor` is derived
   * from {@link SkillExecutorContext.depth}. Optional/back-compat: when unset,
   * rows omit `origin`/`actor`.
   */
  surface?: Surface;
  /**
   * Default model for forked skill subagents, overriding `defaultModel` when
   * set. Sourced from `AFK_DEFAULT_SUBAGENT_MODEL`; falls back to `'sonnet'`
   * when both are unset. Mirrors `SubagentExecutorContext.defaultSubagentModel`.
   */
  defaultSubagentModel?: AgentModelInput;
  /** API key / OAuth token forwarded to SubagentManager for child sessions. */
  apiKey?: string;
  /**
   * Per-model credential resolver. When provided, the executor calls this
   * with the child's effective model string to resolve the appropriate API
   * key at fork time — rather than forwarding `ctx.apiKey` verbatim.
   *
   * Fixes the same "Anthropic child starves when parent is OpenAI-routed"
   * bug that `SubagentExecutorContext.resolveApiKeyForModel` fixes for the
   * `agent` tool path. The cross-provider credential anti-leak invariant is enforced by the
   * resolver itself (`getApiKeyForModel` gates on `providerForModel`).
   *
   * Optional for backward compat: when absent, falls back to `ctx.apiKey`.
   */
  resolveApiKeyForModel?: (model: string) => string | undefined;
  /**
   * Local-server base URL forwarded to child skill subagents. Required so a
   * skill running under a local-model session keeps hitting the local server
   * instead of falling back to api.anthropic.com.
   */
  baseUrl?: string;
  /**
   * OpenAI-compatible endpoint forwarded to child skill subagents, so an
   * OpenAI-routed child built via the restricted/depth-cap provider builders
   * (buildReadOnlyReconProvider / buildSkillRestrictedProvider) points at the
   * configured endpoint instead of defaulting to api.openai.com. Sourced from
   * `cliConfig.openaiBaseUrl` (env `AFK_OPENAI_BASE_URL`); the OpenAI peer of `baseUrl`.
   */
  openaiBaseUrl?: string;
  pluginConfigs?: SdkPluginConfig[];
  depth?: number;
  maxDepth?: number;
  /**
   * Factory for building a child provider with `agent`/`skill` tools wired
   * in, so forked skill children can dispatch further subagents. Mirrors
   * {@link SubagentExecutorContext.childProviderFactory}. When unset (or
   * when depth >= maxDepth), the skill child falls back to the default
   * provider singleton, which has **no `agent` tool in its schema** — and
   * the SKILL.md's "dispatch sub-agents via the Agent tool" instructions
   * become unimplementable. Skill children silently lose the ability to
   * fan out and fall back to inline Write/Bash work.
   */
  childProviderFactory?: (args: ChildProviderFactoryArgs) => ModelProvider;
  /**
   * Factory for building a child {@link SkillExecutor} at depth+1, so a
   * skill child can in turn dispatch sibling skills. Mirrors
   * {@link SubagentExecutorContext.childSkillExecutorFactory}.
   */
  childSkillExecutorFactory?: (
    depth: number,
    maxDepth: number,
    signal: AbortSignal,
    inheritedCwd?: string,
    inheritedReadScope?: ReadScopeInputs,
  ) => SkillExecutor;
  /**
   * Witness-layer trace writer. When provided, the per-call
   * {@link SubagentManager} that wraps each skill fork is constructed with
   * it (so cascade aborts emit `abort` events) AND the child
   * {@link AgentConfig.traceWriter} is set so the forked subagent's own
   * tool_use, hook decision, and lifecycle events land in the parent's
   * trace. Without this, **every** skill-forked subagent is invisible to
   * `~/.afk/state/witness/<sessionLabel>/trace.jsonl` — the diagnostic
   * surface used to debug subagent behavior. (Confirmed empirically:
   * pre-wire, zero `subagent_lifecycle` events for any skill invocation
   * across 306 trace files.)
   */
  traceWriter?: TraceWriter;
  /**
   * Background-mode dispatch registry forwarded to forked child
   * {@link SubagentExecutor}s so a plugin/registry skill whose subagent
   * calls `agent` with `mode: "background"` can register the job rather
   * than fast-failing with "BackgroundAgentRegistry is not wired".
   *
   * Invariant: every `SubagentExecutor` in the dispatch chain — from the
   * REPL root down through skill-forked grandchildren — must share the
   * SAME registry instance, otherwise jobs spawned from inside a skill
   * are invisible to `/bgsub:list` / `/bgsub:join` on the parent REPL.
   *
   * Optional because one-shot surfaces (`afk chat`, threads) deliberately
   * do not run a registry — background dispatch is interactive-only by
   * contract (see subagent-executor.ts:387 error string).
   */
  backgroundRegistry?: BackgroundAgentRegistry;
  /**
   * Worktree cwd inherited from the parent session. Forwarded to each
   * per-call {@link SubagentManager} this executor constructs (the fork +
   * plugin + nested-child paths in {@link SkillExecutor.executeForkedRegistrySkill},
   * {@link SkillExecutor.executePluginSkill}, and
   * {@link SkillExecutor.buildForkedChildConfig}) and to the recursive
   * {@link SubagentExecutor} built for skill-forked-grandchild `agent`
   * dispatch.
   *
   * Without this field, skills invoked via the `skill` tool — `/diagnose`,
   * `/mint`, `/gather`, etc. — spawn their internal subagents through a
   * SubagentManager constructed with no `cwd`. SubagentManager.forkSubagent
   * (subagent.ts:291-297) then declines to inject `cwd` into the child
   * config, and the child's bash/grep/read_file tools fall back to the
   * Node host's `process.cwd()` — defeating worktree isolation for the
   * entire skill dispatch tree. Same shape as
   * {@link SubagentExecutorContext.cwd}.
   *
   * Optional: surfaces without a worktree (telegram) leave this unset.
   */
  cwd?: string;
  /**
   * Reads the parent session's read scope ({@link ReadScopeInputs}) at
   * dispatch time. Wired at each surface to the root
   * {@link SubagentManager.getReadScopeInputs}, so a skill-forked child
   * inherits the parent session's full read scope — the same invariant #544
   * established for the `agent` tool, now applied to `skill`-tool dispatch
   * (#547). Every `new SubagentManager(...)` this executor builds
   * (fork-dispatch.ts, fork-child-config.ts) computes its `parentReadRoots`
   * via {@link resolveChildManagerReadRoots} from this callback's result and
   * the child's cwd.
   *
   * A callback (not a snapshot) so it reflects mid-session `setCwd` re-anchors
   * — matching the `agent` tool, which reads `getReadScopeInputs()` fresh on
   * every dispatch. Optional/back-compat: when unset (older wiring, test
   * stubs), the fork paths fall back to cwd-only derivation, unchanged.
   */
  getReadScopeInputs?: () => ReadScopeInputs;
  /**
   * Session-wide named-agent registry, forwarded to the child
   * {@link SubagentExecutor}s this executor constructs so skill-forked
   * children (the primary orchestrators — review waves, shadow verifiers)
   * can dispatch `agent_type`-named sub-agents. Same reference at every
   * depth; see {@link SubagentExecutorContext.agentRegistry}.
   */
  agentRegistry?: import('../../agents/index.js').AgentRegistry;
}

export interface SkillInput {
  name: string;
  arguments?: string;
}

/**
 * The executor state the extracted per-strategy modules read. Built fresh by
 * `SkillExecutor.internals()` at each call site so `currentCwd` reflects any
 * intervening `setCwd()` re-anchor. Read-only by contract: the extracted
 * functions never mutate executor state (the `pluginBodies` cache stays
 * inside the class).
 */
export interface SkillExecutorInternals {
  readonly ctx: SkillExecutorContext;
  readonly currentCwd: string | undefined;
}
