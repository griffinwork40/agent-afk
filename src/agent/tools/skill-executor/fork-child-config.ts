/**
 * Permission/allowlist propagation for forked skill children.
 *
 * Extracted verbatim from `SkillExecutor.buildForkedChildConfig` (#363): the
 * self-contained block shared by the two forked dispatch paths
 * (`executeForkedRegistrySkill` + `executePluginSkill` in
 * `fork-dispatch.ts`). Receives {@link SkillExecutorInternals} in place of
 * `this` — read-only by contract; mirrors the `buildChildConfig` seam in
 * `subagent/child-config.ts`.
 *
 * @module agent/tools/skill-executor/fork-child-config
 */

import { SubagentManager } from '../../subagent.js';
import { resolveChildManagerReadRoots } from '../../subagent-read-scope.js';
import type { AgentConfig } from '../../types/config-types.js';
import {
  DEFAULT_MAX_NESTING_DEPTH,
  RECON_ALLOWED_TOOLS,
  buildReadOnlyReconProvider,
  createStubParentSession,
  buildSkillRestrictedProvider,
} from '../nesting.js';
import { SubagentExecutor } from '../subagent-executor.js';
import type { SkillExecutorInternals } from './types.js';

/**
 * Wire a forked skill child for nested dispatch.
 *
 * Mirrors {@link SubagentExecutor.execute} lines that build a grandchild
 * SubagentManager + child executors + child provider. When the parent
 * session passes `childProviderFactory` (and we are under `maxDepth`),
 * the forked skill child receives a provider whose tool schema includes
 * `agent` and `skill`, so SKILL.md-prescribed parallel dispatch
 * ("Phase 2: dispatch 20 sub-agents via the Agent tool") is actually
 * implementable. Without this wiring, the skill child falls back to the
 * bare `AnthropicDirectProvider` singleton, which omits `agent`/`skill`
 * (see anthropic-direct/index.ts:108–110) — and the SKILL.md becomes
 * un-executable as written.
 *
 * Returns the augmented child config plus an optional `childManager`
 * that the caller MUST tear down in its finally block.
 */
export function buildForkedChildConfig(
  internals: SkillExecutorInternals,
  baseConfig: AgentConfig,
  signal: AbortSignal,
  // When true, this is a read-only skill (frontmatter `read-only: true` or a
  // name in DEFAULT_READ_ONLY_SKILLS). The forked child is built with the
  // RECON tool allowlist (no write_file/edit_file) and the mutating-bash
  // gate — on BOTH the factory path and the depth-cap/no-factory fallback.
  readOnly = false,
  // Plugin SKILL.md `tools:` allowlist. When set, restricts the child to this
  // exact tool set (single source of truth — no post-fork provider override).
  // Undefined for the registry path (executeForkedRegistrySkill), which must
  // stay unchanged.
  allowedTools?: string[],
): { childConfig: AgentConfig; childManager: SubagentManager | undefined } {
  const { ctx, currentCwd } = internals;
  const depth = ctx.depth ?? 0;
  const maxDepth = ctx.maxDepth ?? DEFAULT_MAX_NESTING_DEPTH;
  const childConfig: AgentConfig = { ...baseConfig };

  // Invariant (single source of truth for effective allowlist):
  //   readOnly && allowedTools  → intersection(allowedTools, RECON_ALLOWED_TOOLS) + readOnlyBash
  //   readOnly && !allowedTools → RECON_ALLOWED_TOOLS + readOnlyBash  (unchanged)
  //   !readOnly && allowedTools → allowedTools, no readOnlyBash
  //   !readOnly && !allowedTools → no override (factory default CHILD_ALLOWED_TOOLS)
  // This keeps subagentExecutor/skillExecutor/readOnlyMemory/readOnlyBash intact
  // through the factory — the previous post-fork buildSkillRestrictedProvider
  // override is gone from executePluginSkill.
  const effectiveAllowed: string[] | undefined =
    readOnly && allowedTools !== undefined
      ? allowedTools.filter((t) => (RECON_ALLOWED_TOOLS as readonly string[]).includes(t))
      : readOnly
        ? [...RECON_ALLOWED_TOOLS]
        : allowedTools;
  const effectiveReadOnlyBash = readOnly;

  if (!ctx.childProviderFactory || depth >= maxDepth) {
    // Depth-cap / no-factory fallback. At the cap no executors are possible,
    // so missing subagentExecutor/skillExecutor is harmless — but readOnlyBash
    // and readOnlyMemory still matter: `bash` is a builtin gated by the
    // dispatcher's readOnlyBash classifier, NOT routed through an executor, so
    // dropping that gate here would re-open mutating bash even at the cap.
    if (readOnly) {
      // readOnly (with OR without a tools: list): buildReadOnlyReconProvider
      // carries readOnlyBash + readOnlyMemory. Pass effectiveAllowed so a
      // read-only skill that DECLARED `tools:` is restricted to its declared
      // subset (the RECON intersection) instead of the full RECON superset —
      // matching the factory path below (issue #499, finding 2: the cap path
      // previously ignored effectiveAllowed and granted the whole RECON set,
      // e.g. web_scrape egress to a `tools: [bash]` skill). When the skill
      // declared no `tools:`, effectiveAllowed is the full RECON set, so the
      // historical behavior is unchanged. Either branch preserves the
      // mutating-bash gate, closing the cap-path readOnlyBash fail-open for a
      // `read-only: true` + `tools: bash` skill forked at the depth cap.
      childConfig.provider = buildReadOnlyReconProvider(
        childConfig.model,
        ctx.openaiBaseUrl,
        effectiveAllowed,
      );
    } else if (effectiveAllowed !== undefined) {
      // Non-readOnly tools: allowlist at the cap. Restrict to the declared
      // tools (no readOnlyBash — the skill did not declare read-only).
      childConfig.provider = buildSkillRestrictedProvider(
        effectiveAllowed,
        childConfig.model,
        effectiveReadOnlyBash,
        ctx.openaiBaseUrl,
      );
    }
    return { childConfig, childManager: undefined };
  }

  // Read-scope inheritance (#547): THIS skill child's inherited read roots,
  // computed from the parent session scope + the child's cwd — the same value
  // the child's own fork manager (fork-dispatch.ts) carries. Seeded as the
  // grandchild manager's parentReadRoots so a read-open (or `/allow-dir`-
  // widened) scope propagates transitively to grandchild `agent` forks —
  // notably the hypothesis agents `/diagnose` dispatches via the `agent` tool
  // with per-call worktree cwds. Mirrors subagent/child-config.ts:305.
  const childInheritedReadRoots = resolveChildManagerReadRoots(
    ctx.getReadScopeInputs?.(),
    currentCwd,
  );
  const childManager = new SubagentManager({
    parentAbortSignal: signal,
    ...(ctx.traceWriter !== undefined ? { traceWriter: ctx.traceWriter } : {}),
    // Trace origin (#469): inherit the owning surface like traceWriter/cwd so
    // grandchild forks made directly off this manager report the real origin.
    // The recursive SubagentExecutor ctx below already carries surface (:157);
    // this keeps the manager itself consistent, mirroring subagent/child-config.ts.
    ...(ctx.surface !== undefined ? { surface: ctx.surface } : {}),
    // Worktree isolation: forward cwd so when the skill-forked child
    // dispatches its own `agent` calls (grandchild forks), the manager's
    // forkSubagent injects cwd into the grandchild's config. Mirrors
    // subagent-executor.ts:294.
    ...(currentCwd !== undefined ? { cwd: currentCwd } : {}),
    // Read-scope inheritance (#547): see childInheritedReadRoots above.
    ...(childInheritedReadRoots !== undefined
      ? { parentReadRoots: childInheritedReadRoots }
      : {}),
  });
  const childExecutor = new SubagentExecutor({
    subagentManager: childManager,
    parentSession: createStubParentSession(signal),
    defaultConfig: {
      model: childConfig.model,
      apiKey: ctx.apiKey,
      ...(ctx.baseUrl !== undefined ? { baseUrl: ctx.baseUrl } : {}),
      // OpenAI endpoint peer of `baseUrl`. Without it, when this skill-forked
      // grandchild SubagentExecutor dispatches an `agent` at the depth cap,
      // its restricted-provider fallback (subagent-executor.ts
      // buildSkillRestrictedProvider, which reads `defaultConfig.openaiBaseUrl`)
      // gets no baseURL and an OpenAI-routed great-grandchild POSTs to
      // api.openai.com. Mirrors the CLI SubagentExecutor wiring (chat/daemon/bootstrap).
      ...(ctx.openaiBaseUrl !== undefined ? { openaiBaseUrl: ctx.openaiBaseUrl } : {}),
    } as AgentConfig,
    // Inherit origin from the skill executor; `depth + 1` makes grandchild
    // `agent`-dispatch rows carry actor:'subagent'.
    ...(ctx.surface !== undefined ? { surface: ctx.surface } : {}),
    defaultSubagentModel: ctx.defaultSubagentModel,
    childProviderFactory: ctx.childProviderFactory,
    childSkillExecutorFactory: ctx.childSkillExecutorFactory,
    // Propagate resolver so grandchild `agent` dispatches (skill-forked
    // child calling the `agent` tool) also resolve credentials by child
    // model rather than forwarding the skill-child's pre-captured apiKey.
    ...(ctx.resolveApiKeyForModel !== undefined
      ? { resolveApiKeyForModel: ctx.resolveApiKeyForModel }
      : {}),
    depth: depth + 1,
    maxDepth,
    // Forward cwd so the grandchild executor's own childManager (when it
    // recursively constructs one for great-grandchild forks) is also cwd-anchored.
    ...(currentCwd !== undefined ? { cwd: currentCwd } : {}),
    // Witness layer: forward the trace writer so the grandchild executor's
    // own childManager (depth-2+ `agent` forks under this skill child) emits
    // subagent_lifecycle events into the session trace. Mirrors cwd above.
    ...(ctx.traceWriter !== undefined ? { traceWriter: ctx.traceWriter } : {}),
    // Invariant: background dispatch requires the registry to be present
    // in every SubagentExecutor in the chain — root → skill-forked child →
    // skill-forked grandchild. Without forwarding, a plugin skill's
    // subagent calling `agent` with `mode:"background"` (the SKILL.md
    // "Dispatch N sub-agents in parallel" idiom) fast-fails synchronously
    // with the 163-byte "BackgroundAgentRegistry is not wired" error
    // before any model call. Skip forwarding only when the host surface
    // (chat / threads / telegram) intentionally omits the registry.
    ...(ctx.backgroundRegistry !== undefined
      ? { backgroundRegistry: ctx.backgroundRegistry }
      : {}),
    // Propagate effective allowlist into the grandchild SubagentExecutor so
    // depth-2 fan-out (skill → agent → depth-2) inherits the same constraints.
    // Without this, the grandchild's childProviderFactory call omits
    // allowedTools/readOnlyBash and falls back to CHILD_ALLOWED_TOOLS.
    ...(effectiveAllowed !== undefined ? { allowedTools: effectiveAllowed } : {}),
    ...(effectiveReadOnlyBash ? { readOnlyBash: true as const } : {}),
    // Named-agent registry: the skill-forked child is the primary
    // orchestrator shape (review waves, verifiers) — it must be able to
    // dispatch `agent_type`-named sub-agents. The child's model becomes
    // the grandchildren's `inherit` anchor.
    ...(ctx.agentRegistry !== undefined ? { agentRegistry: ctx.agentRegistry } : {}),
    ...(childConfig.model !== undefined ? { parentModel: childConfig.model } : {}),
  });
  const childSkillExecutor = ctx.childSkillExecutorFactory
    ? ctx.childSkillExecutorFactory(depth + 1, maxDepth, signal, currentCwd, {
        // Read-scope inheritance (#547): hand the grandchild SkillExecutor
        // THIS child's read scope so its own skill forks (great-grandchildren)
        // inherit ⊇ it instead of the frozen bootstrap session scope.
        parentReadRoots: childInheritedReadRoots,
        parentCwd: currentCwd,
      })
    : undefined;
  // Pass `model` so the factory routes between AnthropicDirect /
  // OpenAICompatible per `providerForModel(model)`. Without this, every
  // skill-forked child inherits the legacy hardcoded
  // AnthropicDirectProvider — meaning an OpenAI-routed parent silently
  // dispatches every skill subagent to api.anthropic.com.
  //
  // Invariant: effective allowlist and readOnlyBash are passed through the
  // factory — keeping subagentExecutor, skillExecutor, readOnlyMemory, and
  // readOnlyBash intact in the resulting provider. No post-fork provider
  // override; this is the single source of truth for the child's permissions.
  childConfig.provider = ctx.childProviderFactory({
    childExecutor,
    ...(childSkillExecutor !== undefined ? { childSkillExecutor } : {}),
    ...(childConfig.model !== undefined ? { model: childConfig.model } : {}),
    ...(effectiveAllowed !== undefined ? { allowedTools: effectiveAllowed } : {}),
    ...(effectiveReadOnlyBash ? { readOnlyBash: true } : {}),
  });

  return { childConfig, childManager };
}
