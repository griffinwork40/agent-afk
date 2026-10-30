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

import { prepareDispatchModel } from '../dispatch-preparation.js';
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
  resolveChildToolAccess,
  resolveChildBudgets,
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
  /** Root-session continuation chains (D2); nested executors share the root's. */
  continuationRegistry?: import('../../subagent/continuation-registry.js').ContinuationRegistry;
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
 * Steps 1-5 of child config construction (model, tools, budgets, credential,
 * base config) WITHOUT nesting wiring. Use with {@link completeChildConfigNesting}
 * when isolation setup must run between config construction and nesting wiring
 * so the nesting objects receive the resolved worktree cwd, not the
 * pre-isolation parent cwd (#4374).
 */
export function buildChildConfigWithoutNesting(args: BuildChildConfigArgs) {
  const { parsed, namedAgent, depth, maxDepth, defaultConfig } = args;

  const namedModel = namedAgent?.definition.model;
  const { model: childModel, isOpenAI: childIsOpenAI, source: childModelSource, apiKey } = prepareDispatchModel({
    modelIntent: {
      callSiteModel: parsed.model,
      namedAgentModel: namedModel === 'inherit' ? args.parentModel : namedModel,
      defaultSubagentModel: args.defaultSubagentModel,
      // Unlike compose, parent inheritance here is opt-in via model: 'inherit'.
    },
    credentialPolicy: 'resolve-then-omit-openai',
    resolveApiKeyForModel: args.resolveApiKeyForModel,
    parentApiKey: defaultConfig.apiKey,
  });
  const { resolvedAccess, effectiveAllowedTools, effectiveReadOnlyBash, childWriteCapable, childSideEffectFree } =
    resolveChildToolAccess(namedAgent, args.allowedTools, args.readOnlyBash, args.agentRegistry);
  const { effectiveMaxTurns, effectiveMaxToolUseIterations } = resolveChildBudgets(parsed, namedAgent);
  const childConfig = buildBaseChildConfig(
    parsed, namedAgent, defaultConfig,
    childModel, childIsOpenAI, apiKey,
    effectiveMaxTurns, effectiveMaxToolUseIterations,
    depth, maxDepth,
  );

  return { childConfig, childModel, childWriteCapable, childSideEffectFree, resolvedAccess, effectiveAllowedTools, effectiveReadOnlyBash, childModelSource };
}

/**
 * Complete child config construction by wiring depth-2+ nesting (child
 * SubagentManager + SubagentExecutor + provider) and assembling the
 * model-fallback descriptor.
 *
 * `nestingCwd` is the cwd the nesting objects should inherit. For worktree-
 * isolated dispatches, pass the worktree path (set by
 * {@link setupIsolationWorktree}) so depth-2+ forks inherit the worktree,
 * not the parent repo root (#4374). For non-isolated dispatches, pass
 * `args.currentCwd` (unchanged).
 */
export function completeChildConfigNesting(
  args: BuildChildConfigArgs,
  pre: ReturnType<typeof buildChildConfigWithoutNesting>,
  nestingCwd: string | undefined,
): BuildChildConfigResult {
  const { childConfig, childModel, childWriteCapable, childSideEffectFree, resolvedAccess, effectiveAllowedTools, effectiveReadOnlyBash, childModelSource } = pre;

  const { childParentSession, childManager, rebuildProvider } = wireChildNesting({
    args, childConfig, effectiveAllowedTools, effectiveReadOnlyBash,
    resolvedAccess, depth: args.depth, maxDepth: args.maxDepth,
    signal: args.signal, currentCwd: nestingCwd, createChildExecutor: args.createChildExecutor,
  });

  const fallback = defaultTierModelFallback({ model: childModel, source: childModelSource }, args.parentModel);
  const modelFallback = fallback === undefined
    ? undefined
    : { ...fallback, ...(rebuildProvider !== undefined ? { buildProvider: rebuildProvider } : {}) };

  return { childConfig, childParentSession, childManager, childWriteCapable, childSideEffectFree, nestedAgentAllowlist: resolvedAccess?.nestedAgentTypes, childModelSource, modelFallback };
}

/**
 * Build the child `AgentConfig` and wire nested dispatch (child manager +
 * executor + provider). Returns the config plus the mutable child parent
 * session the caller backfills with `handle.id` after `forkSubagent`.
 *
 * Convenience wrapper that calls {@link buildChildConfigWithoutNesting} +
 * {@link completeChildConfigNesting} in sequence. Use the two-phase API
 * directly when isolation setup must interleave (#4374).
 */
export function buildChildConfig(args: BuildChildConfigArgs): BuildChildConfigResult {
  const pre = buildChildConfigWithoutNesting(args);
  return completeChildConfigNesting(args, pre, args.parsed.cwd ?? args.currentCwd);
}
