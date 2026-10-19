/**
 * Child AgentSession config construction + nesting/depth wiring.
 *
 * Extracted from `subagent-executor.ts` `execute()`: everything between
 * named-agent resolution and `forkSubagent` — model resolution, named-agent
 * tool-access composition, turn-budget resolution, per-model credential
 * resolution, the `childConfig` object, and the recursive nesting wiring
 * (child SubagentManager + child SubagentExecutor + child provider, or the
 * depth-cap restricted-provider fallback).
 *
 * Pure-ish: receives everything it needs as explicit parameters (the parsed
 * input, the resolved named agent, the relevant executor-context fields, and
 * two factory callbacks) and returns the built config plus the mutable child
 * parent-session stub the caller must backfill after `forkSubagent`. The
 * recursive `new SubagentExecutor(...)` is injected as `createChildExecutor`
 * so this module does not import the executor at runtime (avoids a circular
 * import) — mirroring the `import type` seam `nesting.ts` already uses.
 *
 * @module agent/tools/subagent/child-config
 */

import { defaultTierModelFallback, type ChildModelSource } from '../../subagent/resolve-child-model.js';
import type { ForkSubagentOptions } from '../../subagent/fork-types.js';
import { SubagentManager } from '../../subagent.js';
import type { ReadScopeInputs } from '../../subagent-read-scope.js';
import type { ModelProvider } from '../../provider.js';
import type { AgentModelInput } from '../../types.js';
import type { AgentConfig } from '../../types/config-types.js';
import type { MessageJournal } from '../../journal/types.js';
import type { JournalParent } from '../../subagent/fork-types.js';
import { createStubParentSession } from '../nesting.js';
import type { RegisteredAgent } from '../../agents/index.js';
import type { AgentRegistry } from '../../agents/index.js';
import type { SkillExecutor } from '../skill-executor.js';
import type { Surface } from '../../awareness/types.js';
import type { TraceSink } from '../../trace/index.js';
import type { SubagentExecutor, SubagentExecutorContext } from '../subagent-executor.js';
import type { AgentInput } from './input-parse.js';
import type { ChildProviderFactoryArgs } from '../nesting.js';
import {
  resolveChildModelAndProvider,
  resolveChildToolAccess,
  resolveChildBudgets,
  resolveChildCredential,
  buildBaseChildConfig,
  wireChildNesting,
} from './child-config.helpers.js';

/**
 * Mutable child parent-session stub: `sessionId` is backfilled to `handle.id`
 * and `messageJournal` to the child's own (subagent) journal, so depth-2+
 * forks journal via `child.messageJournal.forSubagent(grandchildId)`.
 */
export type ChildParentSession = ReturnType<typeof createStubParentSession> & {
  sessionId: string | undefined;
  messageJournal?: MessageJournal;
};

/**
 * The subset of {@link SubagentExecutorContext} `buildChildConfig` reads, plus
 * the resolved `depth`/`maxDepth` and the two factory callbacks. Passed
 * explicitly (rather than the whole `ctx` + `this`) so the data this module
 * depends on is visible at the call site — no hidden coupling.
 */
export interface BuildChildConfigArgs {
  parsed: AgentInput;
  namedAgent: RegisteredAgent | undefined;
  depth: number;
  maxDepth: number;
  currentCwd: string | undefined;
  /**
   * This child's own inherited read roots, precomputed by the dispatching
   * executor from the manager that forks it (see ../subagent-read-scope). Passed
   * to the nested grandchild {@link SubagentManager} as its `parentReadRoots` so
   * a read-open (or `/allow-dir`-widened) read scope propagates transitively
   * instead of being silently re-narrowed to the child's cwd one level down.
   */
  childInheritedReadRoots?: string[];
  /** The dispatching tool-call's abort signal (owns the child manager lifetime). */
  signal: AbortSignal;
  /** See SubagentExecutorContext.defaultConfig (incl. the bare `operatorOverlay`). */
  defaultConfig: SubagentExecutorContext['defaultConfig'];
  resolveApiKeyForModel?: (model: string) => string | undefined;
  defaultSubagentModel: AgentModelInput;
  childProviderFactory?: (args: ChildProviderFactoryArgs) => ModelProvider;
  childSkillExecutorFactory?: (
    depth: number,
    maxDepth: number,
    signal: AbortSignal,
    inheritedCwd?: string,
    inheritedReadScope?: ReadScopeInputs,
    skillDispatchName?: string,
    // Forking child's journal view (read lazily): nested skill forks journal
    // via its `forSubagent(id)`. Absent → nested skill forks run unjournaled.
    journalParent?: JournalParent,
    // Root (depth-0) session id for child-attribution (#2442); becomes the
    // nested executor's `parentRootSessionId`.
    rootSessionId?: string,
  ) => SkillExecutor;
  surface?: Surface;
  allowedTools?: string[];
  readOnlyBash?: boolean;
  agentRegistry?: AgentRegistry;
  parentModel?: AgentModelInput;
  /**
   * Witness-layer trace writer inherited from the dispatching executor.
   * Applied at TWO points so nested `agent` forks stay visible in
   * `afk trace show`:
   *   1. the depth-2+ child {@link SubagentManager} (manager-level
   *      inheritance → subagent_lifecycle events for grandchild forks), and
   *   2. the recursive child executor's ctx (so the chain holds to maxDepth,
   *      mirroring `cwd`).
   */
  traceWriter?: TraceSink;
  /** Tree-wide accounting sink: forward each descendant's own report, not subtree totals. */
  onSubagentSucceeded?: import('../../subagent/fork-types.js').SubagentManagerOptions['onSubagentSucceeded'];
  /**
   * Shared workspace store. Threaded into the same TWO places as `traceWriter`
   * above, for the same reason: (1) the depth-2+ child {@link SubagentManager},
   * so grandchild forks get the sibling-findings preamble
   * (`injectWorkspacePreamble`), and (2) the recursive child executor's ctx, so
   * the chain holds to maxDepth. See SubagentExecutorContext.workspaceStore.
   */
  workspaceStore?: import('../../workspace/index.js').WorkspaceStore; delegationBudget?: import('../../tools/delegation-budget.js').DelegationBudget;
  /**
   * Hook registry (#3442) for the depth-2+ child {@link SubagentManager}
   * (whose stub parent carries none) and the recursive child executor's ctx,
   * so SubagentStart/Stop fire at every depth. Undefined => unchanged.
   */
  hookRegistry?: import('../../hooks.js').HookRegistry;
  /**
   * Root (depth-0) session id, forwarded from the dispatching executor's
   * parent session id when the executor sits at depth 1, or from the
   * executor context's own `parentRootSessionId` at depth 2+. Threaded into
   * the grandchild {@link SubagentManager} as `parentRootSessionId` so
   * depth-2+ forks inherit the real root id for child-attribution.
   */
  parentRootSessionId?: string;
  /**
   * Shared billing-stream registry owned by the root manager (#3961).
   * Threaded into every nested {@link SubagentManager} so abandoned streams
   * from depth-2+ children surface in `rootManager.getPendingChildBillingStreams()`
   * at shutdown, matching the depth-1 behaviour for the root manager's own children.
   */
  parentBillingStreams?: Set<Promise<void>>;
  /**
   * Construct the recursive child executor. Injected by the owning
   * `SubagentExecutor.execute()` as `(ctx) => new SubagentExecutor(ctx)` so
   * this module never imports the executor at runtime (circular-import seam;
   * the `SubagentExecutor` reference here is type-only, mirroring nesting.ts).
   */
  createChildExecutor: (ctx: SubagentExecutorContext) => SubagentExecutor;
}

export interface BuildChildConfigResult {
  childConfig: AgentConfig;
  /** Present only when nesting wiring built a child executor; caller backfills its sessionId. */
  childParentSession: ChildParentSession | undefined;
  /**
   * The depth-2+ child manager, present only when nesting wiring ran. The
   * caller (foreground branch) MUST `teardownAll()` it in its finally unless
   * the run was promoted — the registry then owns the detached lifetime.
   */
  childManager: SubagentManager | undefined;
  /**
   * Whether the dispatched child can mutate the filesystem (write/edit files
   * or run mutating bash). The executor reads this to decide whether
   * `isolation:"worktree"` is meaningful — a read-only child has nothing to
   * isolate, so its worktree is skipped with a debug note.
   */
  childWriteCapable: boolean;
  /** True only when every granted tool is proven free of persistent side effects. */
  childSideEffectFree: boolean;
  /**
   * The nested-dispatch allowlist for the child just built. Equals
   * `resolvedAccess.nestedAgentTypes` when a named agent declared a scoped
   * `Agent(x)` grant; `undefined` otherwise (unscoped / no-registry dispatch).
   *
   * The executor must pass this value as `ForkSubagentOptions.nestedAgentAllowlist`
   * when calling `forkSubagent`, so it reaches `assembleChildConfig` and is
   * included in the child's identity preamble. The executor ALSO stamps the
   * same value onto the child executor's `SubagentExecutorContext.nestedAgentAllowlist`
   * (at line ~460 in this file), ensuring text and enforcement derive from one
   * resolved value.
   */
  nestedAgentAllowlist: readonly string[] | undefined;
  /** Provenance tier that chose childConfig.model — for default-tier fallback. */
  childModelSource: ChildModelSource;
  /** `forkSubagent({ modelFallback })` value: set only for a default-tier child (see handle.model-fallback.ts). */
  modelFallback: ForkSubagentOptions['modelFallback'];
}

/**
 * Build the child `AgentConfig` and wire nested dispatch (child manager +
 * executor + provider). Returns the config plus the mutable child parent
 * session the caller backfills with `handle.id` after `forkSubagent`.
 */
export function buildChildConfig(args: BuildChildConfigArgs): BuildChildConfigResult {
  const { parsed, namedAgent, depth, maxDepth, currentCwd, signal, defaultConfig, createChildExecutor } = args;

  // 1. Model + provider family
  const { childModel, childIsOpenAI, childModelSource } = resolveChildModelAndProvider(
    parsed, namedAgent, args.defaultSubagentModel, args.parentModel,
  );

  // 2. Tool allowlist, bash gate, write-capability, side-effect-free
  const { resolvedAccess, effectiveAllowedTools, effectiveReadOnlyBash, childWriteCapable, childSideEffectFree } =
    resolveChildToolAccess(namedAgent, args.allowedTools, args.readOnlyBash, args.agentRegistry);

  // 3. Turn + tool-round budgets
  const { effectiveMaxTurns, effectiveMaxToolUseIterations } = resolveChildBudgets(parsed, namedAgent);

  // 4. API key
  const resolvedChildApiKey = resolveChildCredential(childModel, args.resolveApiKeyForModel, defaultConfig.apiKey);

  // 5. Base config object (provider wired below)
  const childConfig = buildBaseChildConfig(
    parsed, namedAgent, defaultConfig,
    childModel, childIsOpenAI, resolvedChildApiKey,
    effectiveMaxTurns, effectiveMaxToolUseIterations,
    depth, maxDepth,
  );

  // 6. Nesting wiring: child manager + executor + provider (or restricted fallback)
  const { childParentSession, childManager, rebuildProvider } = wireChildNesting({
    args, childConfig, effectiveAllowedTools, effectiveReadOnlyBash,
    resolvedAccess, depth, maxDepth, signal, currentCwd, createChildExecutor,
  });

  const fallback = defaultTierModelFallback({ model: childModel, source: childModelSource }, args.parentModel);
  const modelFallback = fallback === undefined
    ? undefined
    : { ...fallback, ...(rebuildProvider !== undefined ? { buildProvider: rebuildProvider } : {}) };

  return { childConfig, childParentSession, childManager, childWriteCapable, childSideEffectFree, nestedAgentAllowlist: resolvedAccess?.nestedAgentTypes, childModelSource, modelFallback };
}
