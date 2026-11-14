/**
 * Named helpers extracted from `buildChildConfig` (function-size ceiling).
 * Each takes only the inputs it needs as explicit parameters — no closures
 * over the enclosing locals of `buildChildConfig`.
 *
 * @module agent/tools/subagent/child-config.helpers
 */

import type { ModelProvider } from '../../provider.js';
import { CHILD_ALLOWED_TOOLS, buildSkillRestrictedProvider, createStubParentSession } from '../nesting.js';
import { resolveAgentToolAccess } from '../../agents/index.js';
import { composeUnnamedWorkerPrompt } from '../system-prompt.js';
import { isChildReplaySafe } from './retry-safety.js';
import { isChildWriteCapable } from './write-capability.js';
import { SubagentManager } from '../../subagent.js';
import type { RegisteredAgent, AgentRegistry } from '../../agents/index.js';
import type { AgentDefinition } from '../../types/sdk-types.js';
import type { IAgentSession } from '../../types.js';
import type { AgentConfig } from '../../types/config-types.js';
import type { ReadScopeInputs } from '../../subagent-read-scope.js';
import type { SubagentExecutor, SubagentExecutorContext } from '../subagent-executor.js';
import type { AgentInput } from './input-parse.js';
import type { BuildChildConfigArgs, ChildParentSession } from './child-config.js';

// ─── Tool access ─────────────────────────────────────────────────────────────

export interface ResolvedChildToolAccess {
  resolvedAccess: ReturnType<typeof resolveAgentToolAccess> | undefined;
  effectiveAllowedTools: string[] | undefined;
  effectiveReadOnlyBash: boolean;
  childWriteCapable: boolean;
  childSideEffectFree: boolean;
}

/**
 * Resolve the child's tool allowlist, bash-read-only gate, write-capability
 * flag, and side-effect-free flag. Composition is fail-closed:
 *   allowlist = def ∩ cage  (when both exist; either alone otherwise)
 *   bash gate = def ∨ cage
 * Also emits a stderr warning for any fail-closed token drops.
 */
export function resolveChildToolAccess(
  namedAgent: RegisteredAgent | undefined,
  cageAllowedTools: string[] | undefined,
  cageReadOnlyBash: boolean | undefined,
  agentRegistry: AgentRegistry | undefined,
): ResolvedChildToolAccess {
  const resolvedAccess =
    namedAgent !== undefined
      ? resolveAgentToolAccess(namedAgent, CHILD_ALLOWED_TOOLS)
      : undefined;

  let effectiveAllowedTools: string[] | undefined = cageAllowedTools;
  if (resolvedAccess?.allowedTools !== undefined) {
    effectiveAllowedTools =
      cageAllowedTools !== undefined
        ? resolvedAccess.allowedTools.filter((t) => cageAllowedTools.includes(t))
        : resolvedAccess.allowedTools;
  }
  const effectiveReadOnlyBash =
    cageReadOnlyBash === true || resolvedAccess?.bashReadOnly === true;

  const childWriteCapable = isChildWriteCapable(effectiveAllowedTools, effectiveReadOnlyBash);

  const childSideEffectFree = isChildReplaySafe({
    effectiveAllowedTools,
    nestedAgentTypes: resolvedAccess?.nestedAgentTypes,
    ...(agentRegistry !== undefined
      ? {
          resolveNestedAgent: (name: string) => {
            const leaf = agentRegistry.get(name);
            if (leaf === undefined) return undefined;
            const leafAccess = resolveAgentToolAccess(leaf, CHILD_ALLOWED_TOOLS);
            return {
              allowedTools: leafAccess.allowedTools,
              bashReadOnly: leafAccess.bashReadOnly,
              nestedAgentTypes: leafAccess.nestedAgentTypes,
            };
          },
        }
      : {}),
  });

  if (resolvedAccess !== undefined && resolvedAccess.droppedTokens.length > 0) {
    process.stderr.write(
      `[afk] agents: agent_type ${JSON.stringify(namedAgent?.name)}: ` +
        `unknown tool token(s) dropped fail-closed: ${resolvedAccess.droppedTokens.join(', ')}\n`,
    );
  }

  return { resolvedAccess, effectiveAllowedTools, effectiveReadOnlyBash, childWriteCapable, childSideEffectFree };
}

// ─── Budgets ─────────────────────────────────────────────────────────────────

export interface ResolvedChildBudgets {
  effectiveMaxTurns: number;
  effectiveMaxToolUseIterations: number;
}

/**
 * Minimal structural type covering the two fields `resolveChildBudgets` reads
 * from a named-agent definition. Wider callers that pass a full `RegisteredAgent`
 * are structurally compatible because `RegisteredAgent.definition` satisfies
 * `Pick<AgentDefinition, 'maxTurns' | 'maxToolUseIterations'>`.
 */
export type BudgetHint = { definition: Pick<AgentDefinition, 'maxTurns' | 'maxToolUseIterations'> };

/**
 * Resolve turn and tool-use-round budgets.
 * Precedence: explicit call-site > named-agent frontmatter > parse default (0 = unlimited).
 */
export function resolveChildBudgets(
  parsed: Pick<AgentInput, 'max_turns' | 'max_turns_explicit' | 'max_tool_use_iterations' | 'max_tool_use_iterations_explicit'>,
  namedAgent: BudgetHint | undefined,
): ResolvedChildBudgets {
  const effectiveMaxTurns: number =
    !parsed.max_turns_explicit && namedAgent?.definition.maxTurns !== undefined
      ? Math.max(1, Math.floor(namedAgent.definition.maxTurns))
      : (parsed.max_turns ?? 0);

  const effectiveMaxToolUseIterations: number =
    !parsed.max_tool_use_iterations_explicit &&
    namedAgent?.definition.maxToolUseIterations !== undefined
      ? Math.max(1, Math.floor(namedAgent.definition.maxToolUseIterations))
      : (parsed.max_tool_use_iterations ?? 0);

  return { effectiveMaxTurns, effectiveMaxToolUseIterations };
}

// ─── Base config object ───────────────────────────────────────────────────────

/**
 * Construct the base `AgentConfig` object from resolved fields. Provider
 * wiring happens separately in `wireChildNesting`.
 */
export function buildBaseChildConfig(
  parsed: Pick<AgentInput, 'cwd' | 'writeRoots' | 'readRoots'>,
  namedAgent: RegisteredAgent | undefined,
  defaultConfig: SubagentExecutorContext['defaultConfig'],
  childModel: string,
  childIsOpenAI: boolean,
  resolvedChildApiKey: string | undefined,
  effectiveMaxTurns: number,
  effectiveMaxToolUseIterations: number,
  depth: number,
  maxDepth: number,
): AgentConfig {
  const systemPromptParts =
    namedAgent !== undefined
      ? { systemPrompt: namedAgent.definition.prompt }
      : { systemPrompt: composeUnnamedWorkerPrompt(defaultConfig.operatorOverlay), isUnnamedWorker: true as const };

  return {
    model: childModel,
    apiKey: childIsOpenAI ? undefined : resolvedChildApiKey,
    ...systemPromptParts,
    baseUrl: childIsOpenAI ? undefined : defaultConfig.baseUrl,
    ...(defaultConfig.xaiBaseUrl !== undefined ? { xaiBaseUrl: defaultConfig.xaiBaseUrl } : {}),
    maxTurns: effectiveMaxTurns,
    maxToolUseIterations: effectiveMaxToolUseIterations,
    depth: depth + 1,
    maxDepth,
    ...(parsed.cwd !== undefined ? { cwd: parsed.cwd } : {}),
    ...(parsed.writeRoots !== undefined ? { writeRoots: parsed.writeRoots } : {}),
    ...(parsed.readRoots !== undefined ? { extraReadRoots: parsed.readRoots } : {}),
    ...(namedAgent === undefined && defaultConfig.skillDispatchName !== undefined
      ? { skillDispatchName: defaultConfig.skillDispatchName }
      : {}),
  } as AgentConfig;
}

// ─── Nesting wiring ───────────────────────────────────────────────────────────

export interface WireChildNestingResult {
  childParentSession: ChildParentSession | undefined;
  childManager: SubagentManager | undefined;
  /** Rebuild the same provider for a different model (default-tier model fallback). */
  rebuildProvider?: (model: string) => ModelProvider;
}

interface WireChildNestingArgs {
  args: BuildChildConfigArgs;
  childConfig: AgentConfig;
  effectiveAllowedTools: string[] | undefined;
  effectiveReadOnlyBash: boolean;
  resolvedAccess: ReturnType<typeof resolveAgentToolAccess> | undefined;
  depth: number;
  maxDepth: number;
  signal: AbortSignal;
  currentCwd: string | undefined;
  createChildExecutor: (ctx: SubagentExecutorContext) => SubagentExecutor;
}

/**
 * Wire depth-2+ nesting: build the child `SubagentManager`, `SubagentExecutor`,
 * skill executor, and provider. When at the depth cap (or no factory), falls
 * back to a minimal restricted provider.
 *
 * **Side effect:** mutates `w.childConfig.provider` across a module boundary.
 * Callers must not assume `childConfig.provider` is stable after this call.
 */
export function wireChildNesting(w: WireChildNestingArgs): WireChildNestingResult {
  const { args, childConfig, effectiveAllowedTools, effectiveReadOnlyBash, resolvedAccess, depth, maxDepth, signal, currentCwd, createChildExecutor } = w;

  if (args.childProviderFactory && depth < maxDepth) {
    const childManager = buildNestedChildManager(args, signal, currentCwd);
    const childParentSession = createStubParentSession(signal) as ChildParentSession;

    const childExecutor = createChildExecutor({
      subagentManager: childManager,
      parentSession: childParentSession as Pick<IAgentSession, 'sessionId' | 'getInputStreamRef' | 'abortSignal'>,
      defaultConfig: args.defaultConfig,
      ...(args.surface !== undefined ? { surface: args.surface } : {}),
      defaultSubagentModel: args.defaultSubagentModel,
      childProviderFactory: args.childProviderFactory,
      childSkillExecutorFactory: args.childSkillExecutorFactory,
      ...(args.resolveApiKeyForModel !== undefined ? { resolveApiKeyForModel: args.resolveApiKeyForModel } : {}),
      depth: depth + 1,
      maxDepth,
      ...(currentCwd !== undefined ? { cwd: currentCwd } : {}),
      ...nestedExecutorInherits(args),
      ...(args.delegationBudget !== undefined ? { delegationBudget: args.delegationBudget } : {}),
      ...(args.continuationRegistry !== undefined ? { continuationRegistry: args.continuationRegistry } : {}),
      ...(args.allowedTools !== undefined ? { allowedTools: args.allowedTools } : {}),
      ...(args.readOnlyBash ? { readOnlyBash: true } : {}),
      ...(args.agentRegistry !== undefined ? { agentRegistry: args.agentRegistry } : {}),
      ...(resolvedAccess?.nestedAgentTypes !== undefined
        ? { nestedAgentAllowlist: resolvedAccess.nestedAgentTypes }
        : {}),
      parentModel: childConfig.model,
      ...(args.parentRootSessionId !== undefined ? { parentRootSessionId: args.parentRootSessionId } : {}),
    });

    const childReadScope: ReadScopeInputs = { parentReadRoots: args.childInheritedReadRoots, parentCwd: currentCwd };
    const childSkillExecutor = args.childSkillExecutorFactory
      ? args.childSkillExecutorFactory(
          depth + 1, maxDepth, signal, currentCwd, childReadScope,
          args.namedAgent === undefined ? args.defaultConfig.skillDispatchName : undefined,
          childParentSession,
          args.parentRootSessionId,
        )
      : undefined;

    const factory = args.childProviderFactory;
    const rebuildProvider = (model: string): ModelProvider => factory({
      childExecutor,
      ...(childSkillExecutor !== undefined ? { childSkillExecutor } : {}),
      model,
      ...(effectiveAllowedTools !== undefined ? { allowedTools: effectiveAllowedTools } : {}),
      ...(effectiveReadOnlyBash ? { readOnlyBash: true } : {}),
      ...(childConfig.customTools !== undefined && childConfig.customTools.length > 0
        ? { customTools: childConfig.customTools }
        : {}),
    });
    childConfig.provider = rebuildProvider(String(childConfig.model));

    return { childParentSession, childManager, rebuildProvider };
  }

  if (effectiveAllowedTools !== undefined || effectiveReadOnlyBash) {
    const rebuildProvider = (model: string): ModelProvider => buildSkillRestrictedProvider(
      effectiveAllowedTools ?? [...CHILD_ALLOWED_TOOLS],
      model,
      effectiveReadOnlyBash,
      args.defaultConfig.openaiBaseUrl,
      args.workspaceStore,
    );
    childConfig.provider = rebuildProvider(String(childConfig.model));
    return { childParentSession: undefined, childManager: undefined, rebuildProvider };
  }

  return { childParentSession: undefined, childManager: undefined };
}

// ─── Shared private helpers (also used by child-config.ts top-level helpers) ─

/**
 * Build the depth-2+ {@link SubagentManager} a nested child uses for its own
 * `agent` forks. Every input is an explicit parameter.
 *
 * @internal Exported for `child-config.ts` only; not part of the public API.
 */
export function buildNestedChildManager(
  args: Pick<BuildChildConfigArgs,
    'childInheritedReadRoots' | 'traceWriter' | 'surface' | 'workspaceStore' |
    'parentRootSessionId' | 'hookRegistry' | 'onSubagentSucceeded' | 'parentBillingStreams'>,
  signal: AbortSignal,
  currentCwd: string | undefined,
): SubagentManager {
  return new SubagentManager({
    parentAbortSignal: signal,
    ...(args.onSubagentSucceeded !== undefined ? { onSubagentSucceeded: args.onSubagentSucceeded } : {}),
    ...(currentCwd !== undefined ? { cwd: currentCwd } : {}),
    ...(args.childInheritedReadRoots !== undefined ? { parentReadRoots: args.childInheritedReadRoots } : {}),
    ...(args.traceWriter !== undefined ? { traceWriter: args.traceWriter } : {}),
    ...(args.surface !== undefined ? { surface: args.surface } : {}),
    ...(args.workspaceStore !== undefined ? { workspaceStore: args.workspaceStore } : {}),
    ...(args.parentRootSessionId !== undefined ? { parentRootSessionId: args.parentRootSessionId } : {}),
    ...(args.hookRegistry !== undefined ? { hookRegistry: args.hookRegistry } : {}),
    // #3961: propagate the root's billing-stream registry so depth-2+ abandoned
    // streams surface in rootManager.getPendingChildBillingStreams() at shutdown.
    ...(args.parentBillingStreams !== undefined ? { parentBillingStreams: args.parentBillingStreams } : {}),
  });
}

/**
 * Tree-wide fields the recursive child executor inherits unchanged.
 *
 * @internal Exported for `child-config.ts` only; not part of the public API.
 */
export function nestedExecutorInherits(
  args: Pick<BuildChildConfigArgs, 'traceWriter' | 'workspaceStore' | 'hookRegistry'>,
): Pick<SubagentExecutorContext, 'traceWriter' | 'workspaceStore' | 'hookRegistry'> {
  return {
    ...(args.traceWriter !== undefined ? { traceWriter: args.traceWriter } : {}),
    ...(args.workspaceStore !== undefined ? { workspaceStore: args.workspaceStore } : {}),
    ...(args.hookRegistry !== undefined ? { hookRegistry: args.hookRegistry } : {}),
  };
}
