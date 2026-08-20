/**
 * Invariant: shared executor wiring for every top-level surface (REPL,
 * `afk chat`, Telegram, daemon). The construction ORDER below is load-bearing —
 * each step closes over the ones above it:
 *   1. SubagentManager          — the single root manager for all forked children
 *   2. childProviderFactory     — routes child model → AnthropicDirect / OpenAICompatible
 *   3. agentRegistry            — named-agent scan (builtin + user + project)
 *   4. childSkillExecutorFactory— depth-aware factory for nested skill children
 *   5. SubagentExecutor         — wires the `agent` tool
 *   6. SkillExecutor            — wires the `skill` tool
 *   7. ComposeExecutor          — wires the `compose` tool
 *
 * Exactly ONE {@link SubagentManager} is constructed per call and shared by
 * every executor. Callers must reuse the returned `rootManager` rather than
 * building a second one: read-scope inheritance (#547), the abort graph, and
 * the subagent-success rollup are all keyed to that single instance.
 *
 * Per-surface differences are expressed as explicit parameters on
 * {@link WireExecutorsOptions} — never as `if (surface === …)` branching in
 * here. Three pairs of fields exist purely to preserve pre-existing per-surface
 * wiring asymmetries (`model`/`managerParentModel`, `cwd`/`nestedCwd`,
 * `traceWriter`/`skillTraceWriter`); each is documented at its declaration.
 */
import { SubagentManager } from '../subagent.js';
import { SubagentExecutor } from '../tools/subagent-executor.js';
import { SkillExecutor } from '../tools/skill-executor.js';
import { ComposeExecutor } from '../tools/compose-executor.js';
import {
  createChildProviderFactory,
  createChildSkillExecutorFactory,
  resolveMaxNestingDepth,
} from '../tools/nesting.js';
import { loadAgentRegistry } from '../agents/index.js';
import { discoverPluginAgents } from '../tools/skill-bridge.js';
import type { SubagentExecutorContext } from '../tools/subagent-executor.js';
import type { BackgroundAgentRegistry } from '../background-registry.js';
import type { TraceSink } from '../trace/writer.js';
import type { Surface } from '../awareness/types.js';
import type { AgentModelInput } from '../types.js';
import type { WorkspaceStore } from '../workspace/index.js';
import { inboundAttachmentRegistry } from '../content/attachment-registry.js';

/** Options for {@link wireExecutors}. */
export interface WireExecutorsOptions {
  /**
   * User-facing surface that owns these executors. Threaded into the root
   * manager (so forked `agent`-tool children inherit `origin` instead of
   * `'unknown'`) and onto every executor for routing-decision telemetry.
   */
  surface: Surface;
  /**
   * The parent-session view the executors fork from. Surfaces that construct
   * their session AFTER the executors pass a deferred proxy whose getters read
   * through a mutable ref, so a mid-session swap stays transparent; the daemon
   * passes a stub bound to its own abort signal.
   */
  parentSession: SubagentExecutorContext['parentSession'];
  /** Parent credential. May be undefined when only per-model resolution applies. */
  apiKey: string | undefined;
  /**
   * The dispatching session's model. Used as `defaultModel` (skill/compose)
   * and as the `inherit` anchor for named-agent model resolution.
   */
  model: AgentModelInput;
  /**
   * The model that {@link WireExecutorsOptions.apiKey} was resolved FROM.
   * Distinct from `model` on purpose: the root manager derives its fork-time
   * credential-fallback provider via `providerForModel(parentModel)`, so it
   * must key off the credential's own model (`getModel()` on the CLI surfaces,
   * which may differ from a `--model`-overridden session model) or the
   * fallback can cross the provider boundary.
   */
  managerParentModel: AgentModelInput;
  /** Resolved default model for dispatches that omit one. */
  defaultSubagentModel: AgentModelInput;
  /**
   * Per-model credential resolver (canonically `getApiKeyForModel`). Injected
   * rather than imported so this module stays free of a `src/cli` dependency.
   */
  resolveApiKeyForModel: (model: string) => string | undefined;
  /**
   * Raw base system prompt (pre-assembly) inherited by forked children and
   * compose nodes — intentionally excludes ROUTING_DIRECTIVE and
   * TOOL_SYSTEM_PROMPT so children stay task workers. Compose coerces
   * `undefined` to `''`.
   */
  systemPrompt?: string;
  /** Anthropic-compatible endpoint forwarded to children. */
  baseUrl?: string;
  /** OpenAI-compatible endpoint forwarded to OpenAI-routed children. */
  openaiBaseUrl?: string;
  /** xAI endpoint forwarded to xAI-routed children. */
  xaiBaseUrl?: string;
  /**
   * Session/worktree cwd. Anchors the root manager, the named-agent scan, the
   * nested skill-executor factory, and compose DAG nodes.
   */
  cwd?: string;
  /**
   * Cwd for the `agent`/`skill` executors themselves, which anchors depth ≥ 2
   * forks and skill-dispatched subagents.
   *
   * Contract: separate from {@link WireExecutorsOptions.cwd} because Telegram
   * historically set cwd on the manager/registry/compose path but NOT on these
   * two executors. Surfaces that want uniform anchoring pass the same value for
   * both; Telegram passes `undefined` here to preserve its existing (narrower)
   * behaviour. Collapsing the two would be a behaviour change, not a refactor.
   */
  nestedCwd?: string;
  /**
   * Witness-layer writer for the root manager, the `agent` executor, and
   * compose DAG nodes.
   */
  traceWriter?: TraceSink;
  /**
   * Witness-layer writer for the `skill` executor and the nested
   * skill-executor factory.
   *
   * Contract: separate from {@link WireExecutorsOptions.traceWriter} because
   * Telegram traces its manager/agent/compose paths but leaves skill forks
   * untraced. Other surfaces pass the same writer for both.
   */
  skillTraceWriter?: TraceSink;
  /**
   * Registry backing `agent` dispatches with `mode: 'background'`. Only the
   * REPL wires one; elsewhere background dispatch reports as unconfigured
   * rather than silently downgrading to foreground.
   */
  backgroundRegistry?: BackgroundAgentRegistry;
  /**
   * Sink for named-agent scan warnings (e.g. a user agent file shadowing a
   * tool-restricted builtin). When omitted, `loadAgentRegistry` uses its
   * default writer.
   */
  agentRegistryWarn?: (message: string) => void;
  /** Shared workspace store forwarded to compose DAG nodes. */
  workspaceStore?: WorkspaceStore;
}

/** The wired executor set returned by {@link wireExecutors}. */
export interface WiredExecutors {
  /**
   * The single root manager shared by all three executors. Reuse it — do not
   * construct another for the same session.
   */
  rootManager: SubagentManager;
  subagentExecutor: SubagentExecutor;
  skillExecutor: SkillExecutor;
  composeExecutor: ComposeExecutor;
}

/**
 * Construct the `agent` / `skill` / `compose` executor trio plus the single
 * root {@link SubagentManager} they share.
 *
 * @see WireExecutorsOptions for the per-surface parameters.
 */
export function wireExecutors(opts: WireExecutorsOptions): WiredExecutors {
  const {
    surface,
    parentSession,
    apiKey,
    model,
    managerParentModel,
    defaultSubagentModel,
    resolveApiKeyForModel,
    systemPrompt,
    baseUrl,
    openaiBaseUrl,
    xaiBaseUrl,
    cwd,
    nestedCwd,
    traceWriter,
    skillTraceWriter,
    backgroundRegistry,
    agentRegistryWarn,
  } = opts;

  // Conditional spreads (rather than `field: value` with a possibly-undefined
  // value) are preserved from the original call sites so an absent option stays
  // an absent key.
  const baseUrlOpt = baseUrl !== undefined ? { baseUrl } : {};
  const openaiBaseUrlOpt = openaiBaseUrl !== undefined ? { openaiBaseUrl } : {};
  const xaiBaseUrlOpt = xaiBaseUrl !== undefined ? { xaiBaseUrl } : {};
  const cwdOpt = cwd !== undefined ? { cwd } : {};
  const nestedCwdOpt = nestedCwd !== undefined ? { cwd: nestedCwd } : {};
  const traceOpt = traceWriter !== undefined ? { traceWriter } : {};
  const skillTraceOpt = skillTraceWriter !== undefined ? { traceWriter: skillTraceWriter } : {};
  const apiKeyOpt = apiKey !== undefined ? { apiKey } : {};
  const bgRegistryOpt = backgroundRegistry !== undefined ? { backgroundRegistry } : {};
  // Match loadAgentRegistry's default sink so plugin discovery remains audible
  // on non-interactive surfaces that do not provide a boot-warning collector.
  const registryWarn =
    agentRegistryWarn ?? ((message: string) => process.stderr.write(message + '\n'));
  // Session-static snapshot shared by all root executors and inherited by
  // descendants. Do not resolve inside execute(): sibling calls must not see
  // different caps if the process environment changes during the session.
  const maxDepth = resolveMaxNestingDepth();

  // 1. The single root manager. Every executor below reads through this
  //    instance; a second manager would fork children outside the abort graph
  //    and outside the parent's read scope.
  //
  //    Workspace READ channel: the store must reach the MANAGER, not just the
  //    child providers below. The two channels are separate and each is
  //    load-bearing — the provider factory (step 2) registers the
  //    `workspace_publish` handler against the shared store (WRITE), while the
  //    manager is what feeds `assembleChildConfig` → `injectWorkspacePreamble`
  //    (subagent/fork-child-config.ts:107), which queries relevant entries and
  //    injects them into the child's system prompt (READ). Omitting it here left
  //    every depth-1 `agent`/`skill` fork on every surface able to publish but
  //    blind to what its siblings had already published.
  const rootManager = new SubagentManager({
    ...apiKeyOpt,
    parentModel: managerParentModel,
    ...baseUrlOpt,
    ...cwdOpt,
    ...traceOpt,
    surface,
    ...(opts.workspaceStore !== undefined ? { workspaceStore: opts.workspaceStore } : {}),
  });

  // 2. Routes each child model to AnthropicDirect / OpenAICompatible, pointing
  //    OpenAI-routed children at the configured local shim when set.
  const childProviderFactory = createChildProviderFactory({
    ...openaiBaseUrlOpt,
    ...(opts.workspaceStore !== undefined ? { workspaceStore: opts.workspaceStore } : {}),
  });

  // 3. Named-agent registry: session-static scan enabling `agent_type`
  //    dispatch at every depth.
  const agentRegistry = loadAgentRegistry({
    ...cwdOpt,
    // Same sink both scanners report through: a malformed plugin agent file
    // now warns exactly like a malformed user/project one (#752) instead of
    // vanishing silently ahead of the merge below.
    pluginAgents: discoverPluginAgents(undefined, registryWarn),
    warn: registryWarn,
  });

  // 4. Shared by the `agent` and `skill` executors so plugin skill children
  //    nest with identical depth-aware wiring at every hop.
  const childSkillExecutorFactory = createChildSkillExecutorFactory(
    model,
    apiKey,
    childProviderFactory,
    baseUrl,
    skillTraceWriter,
    backgroundRegistry,
    cwd,
    resolveApiKeyForModel,
    surface,
    defaultSubagentModel,
    agentRegistry,
    openaiBaseUrl,
    xaiBaseUrl,
    // Workspace READ channel at every nesting depth — a skill dispatched BY a
    // skill otherwise gets a store-less executor and its forks lose the preamble.
    opts.workspaceStore,
  );

  // 5. `agent` tool.
  const subagentExecutor = new SubagentExecutor({
    subagentManager: rootManager,
    parentSession,
    surface,
    defaultConfig: {
      ...apiKeyOpt,
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      ...baseUrlOpt,
      ...openaiBaseUrlOpt,
      ...xaiBaseUrlOpt,
    },
    defaultSubagentModel,
    childProviderFactory,
    childSkillExecutorFactory,
    ...bgRegistryOpt,
    resolveApiKeyForModel,
    // Top-level wiring → explicit depth 0. See SubagentExecutorContext.depth
    // for why this is required rather than defaulted.
    depth: 0,
    maxDepth,
    ...nestedCwdOpt,
    agentRegistry,
    inboundAttachmentRegistry,
    parentModel: model,
    ...traceOpt,
    // Workspace READ channel for depth ≥ 2 `agent` forks. The root manager above
    // covers depth 1; this covers the nested managers buildChildConfig creates,
    // exactly as traceOpt does. See SubagentExecutorContext.workspaceStore.
    ...(opts.workspaceStore !== undefined ? { workspaceStore: opts.workspaceStore } : {}),
  });

  // 6. `skill` tool.
  const skillExecutor = new SkillExecutor({
    parentSession,
    surface,
    defaultModel: model,
    defaultSubagentModel,
    ...apiKeyOpt,
    childProviderFactory,
    childSkillExecutorFactory,
    agentRegistry,
    ...bgRegistryOpt,
    ...baseUrlOpt,
    ...openaiBaseUrlOpt,
    ...xaiBaseUrlOpt,
    resolveApiKeyForModel,
    ...skillTraceOpt,
    ...nestedCwdOpt,
    maxDepth,
    // Read-scope inheritance (#547): skill-forked children inherit the parent
    // session's read scope via the root manager — symmetric with the `agent`
    // tool. Read fresh so mid-session setCwd re-anchors are reflected.
    getReadScopeInputs: () => rootManager.getReadScopeInputs(),
    // Workspace READ channel for INLINE skill handlers only. Fork-path skill
    // children already inherit it via childProviderFactory + rootManager; an
    // inline handler (`/mint` phases, `/audit-fit`) builds its own manager, so
    // the store has to reach it as data on SkillExecutionContext.
    ...(opts.workspaceStore !== undefined ? { workspaceStore: opts.workspaceStore } : {}),
  });

  // 7. `compose` tool. Nodes receive the raw base prompt so they stay task
  //    workers that cannot spawn nested DAGs or recurse into skills.
  const composeExecutor = new ComposeExecutor({
    parentSession,
    defaultModel: model,
    defaultSubagentModel,
    ...apiKeyOpt,
    resolveApiKeyForModel,
    getReadScopeInputs: () => rootManager.getReadScopeInputs(),
    ...baseUrlOpt,
    ...openaiBaseUrlOpt,
    ...cwdOpt,
    systemPrompt: systemPrompt ?? '',
    surface,
    depth: 0,
    maxDepth,
    ...traceOpt,
    ...(opts.workspaceStore !== undefined ? { workspaceStore: opts.workspaceStore } : {}),
  });

  return { rootManager, subagentExecutor, skillExecutor, composeExecutor };
}
