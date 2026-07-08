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

import { SubagentManager } from '../../subagent.js';
import type { ModelProvider } from '../../provider.js';
import type { AgentModelInput, IAgentSession } from '../../types.js';
import type { AgentConfig } from '../../types/config-types.js';
import { providerForModel } from '../../providers/index.js';
import { applyParentCredentialFallback } from '../child-credential.js';
import { resolveCredentialForModel } from '../../auth/credential-resolver.js';
import {
  CHILD_ALLOWED_TOOLS,
  buildSkillRestrictedProvider,
  createStubParentSession,
  type ChildProviderFactoryArgs,
} from '../nesting.js';
import { resolveAgentToolAccess } from '../../agents/index.js';
import type { RegisteredAgent } from '../../agents/index.js';
import type { AgentRegistry } from '../../agents/index.js';
import type { SkillExecutor } from '../skill-executor.js';
import type { Surface } from '../../awareness/types.js';
import type { TraceWriter } from '../../trace/index.js';
import type { SubagentExecutor, SubagentExecutorContext } from '../subagent-executor.js';
import type { AgentInput } from './input-parse.js';

/** Mutable child parent-session stub: `sessionId` is backfilled to `handle.id`. */
export type ChildParentSession = ReturnType<typeof createStubParentSession> & {
  sessionId: string | undefined;
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
  /** The dispatching tool-call's abort signal (owns the child manager lifetime). */
  signal: AbortSignal;
  defaultConfig: Pick<AgentConfig, 'apiKey' | 'systemPrompt' | 'baseUrl' | 'openaiBaseUrl'>;
  resolveApiKeyForModel?: (model: string) => string | undefined;
  defaultSubagentModel?: AgentModelInput;
  childProviderFactory?: (args: ChildProviderFactoryArgs) => ModelProvider;
  childSkillExecutorFactory?: (depth: number, maxDepth: number, signal: AbortSignal, inheritedCwd?: string) => SkillExecutor;
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
  traceWriter?: TraceWriter;
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
}

/**
 * Build the child `AgentConfig` and wire nested dispatch (child manager +
 * executor + provider). Returns the config plus the mutable child parent
 * session the caller backfills with `handle.id` after `forkSubagent`.
 */
export function buildChildConfig(args: BuildChildConfigArgs): BuildChildConfigResult {
  const {
    parsed,
    namedAgent,
    depth,
    maxDepth,
    currentCwd,
    signal,
    defaultConfig,
    createChildExecutor,
  } = args;

  // Resolve the child's effective model and the provider it routes to FIRST,
  // so we can decide whether the parent's Anthropic-shaped `apiKey` /
  // `baseUrl` (sourced from `loadCredential()` + `AFK_LOCAL_BASE_URL`) should
  // be forwarded. Forwarding them to an OpenAI-routed child causes
  // `resolveOpenAIAuth()` to return the Anthropic key as if it were a config
  // OpenAI key (tier 1 wins) — the OpenAI API then 401s. Clearing them lets
  // the OpenAI auth resolver walk its env / codex precedence cleanly.
  // Model resolution.
  //   Unnamed dispatch (legacy, unchanged): call-site > policy default > 'sonnet'.
  //   Named dispatch (Claude Code parity): call-site > definition model
  //   ('inherit' → dispatching session's model) > inherit-by-default
  //   (omitted model also means inherit) > policy default > 'sonnet'.
  // `parentModel` is optional ctx wiring; when absent, inherit falls
  // through to the policy chain rather than guessing.
  let namedDefaultModel: string | undefined;
  if (namedAgent !== undefined) {
    const defModel = namedAgent.definition.model;
    namedDefaultModel =
      defModel !== undefined && defModel !== 'inherit'
        ? defModel
        : args.parentModel;
  }
  const childModel: string =
    parsed.model ?? namedDefaultModel ?? args.defaultSubagentModel ?? 'sonnet';
  const childIsOpenAI = providerForModel(childModel) === 'openai-compatible';

  // Named-agent tool access: resolve the definition's declared surface into
  // runtime terms, then compose with any cage this executor already sits in
  // (a read-only skill's fan-out). Composition is fail-closed:
  //   allowlist  = def ∩ cage   (when both exist; either alone otherwise)
  //   bash gate  = def ∨ cage
  // — mirroring skill-executor.ts buildForkedChildConfig's intersection
  // semantics, so a named dispatch can never widen an existing cage.
  const resolvedAccess =
    namedAgent !== undefined
      ? resolveAgentToolAccess(namedAgent, CHILD_ALLOWED_TOOLS)
      : undefined;
  let effectiveAllowedTools: string[] | undefined = args.allowedTools;
  if (resolvedAccess?.allowedTools !== undefined) {
    const cage = args.allowedTools;
    effectiveAllowedTools =
      cage !== undefined
        ? resolvedAccess.allowedTools.filter((t) => cage.includes(t))
        : resolvedAccess.allowedTools;
  }
  const effectiveReadOnlyBash =
    args.readOnlyBash === true || resolvedAccess?.bashReadOnly === true;
  if (resolvedAccess !== undefined && resolvedAccess.droppedTokens.length > 0) {
    // Fail-closed token drops silently NARROW the child's tool surface, so a
    // misconfigured agent file must be visible by default — not only under
    // AFK_DEBUG. Route through the same stderr sink the agent registry uses
    // for its load-time warnings (loadAgentRegistry's default `warn`).
    process.stderr.write(
      `[afk] agents: agent_type ${JSON.stringify(namedAgent?.name)}: ` +
        `unknown tool token(s) dropped fail-closed: ${resolvedAccess.droppedTokens.join(', ')}\n`,
    );
  }

  // Turn budget: explicit per-call max_turns wins; otherwise a named agent's
  // maxTurns frontmatter (floored to ≥1); otherwise the parse-time default
  // (0 = unlimited). No upper ceiling — uncapped by default, opt into a cap
  // via the call-site param or an agent definition's frontmatter.
  const effectiveMaxTurns =
    !parsed.max_turns_explicit && namedAgent?.definition.maxTurns !== undefined
      ? Math.max(1, Math.floor(namedAgent.definition.maxTurns))
      : parsed.max_turns;

  // Tool-use-round budget: same precedence as turns (explicit call-site >
  // named-agent frontmatter > parse default 0 = unlimited). Set explicitly on
  // the child config so this agent-tool dispatch path does NOT fall through to
  // SubagentManager's SUBAGENT_DEFAULT_MAX_TOOL_USE_ITERATIONS (50) — that
  // remains the anti-hang default for skill/compose internal forks, which do
  // not build config here.
  const effectiveMaxToolUseIterations =
    !parsed.max_tool_use_iterations_explicit &&
    namedAgent?.definition.maxToolUseIterations !== undefined
      ? Math.max(1, Math.floor(namedAgent.definition.maxToolUseIterations))
      : parsed.max_tool_use_iterations ?? 0;

  // Resolve the child's API key by its own model/provider. The resolver is
  // now available directly from the agent layer (resolveCredentialForModel),
  // so no injection is required — `this.ctx.resolveApiKeyForModel` acts as
  // an optional override for callers that need a custom strategy (e.g. tests).
  // When absent, the default agent-layer resolver is used. The
  // `childIsOpenAI ? undefined` guard below is preserved as a
  // defense-in-depth layer (cross-provider credential anti-leak invariant).
  //
  // applyParentCredentialFallback adds a second safety net: when fresh
  // per-model resolution comes up empty for an Anthropic child (the sync
  // keychain reader bailing on an expired OAuth token), reuse the parent's
  // bootstrap-captured credential IFF it is Anthropic-shaped — so the child
  // gets a token to attempt with and its own 401 refresher self-heals,
  // instead of dying at the provider pre-flight. See child-credential.ts.
  const resolvedChildApiKey = applyParentCredentialFallback({
    childModel,
    resolved: args.resolveApiKeyForModel
      ? args.resolveApiKeyForModel(childModel)
      : resolveCredentialForModel(childModel),
    parentApiKey: defaultConfig.apiKey,
  });

  const childConfig: AgentConfig = {
    model: childModel,
    apiKey: childIsOpenAI ? undefined : resolvedChildApiKey,
    // A named agent's markdown body IS the child's system prompt (Claude
    // Code parity: subagents receive the definition prompt, not the parent
    // surface's full prompt). Unnamed dispatches keep the raw base prompt.
    systemPrompt: namedAgent !== undefined ? namedAgent.definition.prompt : defaultConfig.systemPrompt,
    baseUrl: childIsOpenAI ? undefined : defaultConfig.baseUrl,
    maxTurns: effectiveMaxTurns,
    // Always set (default 0 = unlimited) so forkSubagent's `?? 50` fallback is
    // bypassed for agent-tool dispatches — see effectiveMaxToolUseIterations.
    maxToolUseIterations: effectiveMaxToolUseIterations,
    // Awareness metadata (Phase 1, get_runtime_state):
    // Thread depth + maxDepth into the child's AgentConfig so the
    // `self` view of the child's get_runtime_state snapshot reflects
    // its actual nesting position. `parentSessionId` is injected later
    // by SubagentManager.forkSubagent which has options.parent.sessionId
    // in scope; phaseRole is also handled there.
    depth: depth + 1,
    maxDepth,
    // Per-call cwd override. When set, `SubagentManager.forkSubagent`
    // applies this in preference to the manager's `parentCwd` fallback
    // (see src/agent/subagent.ts:291-297) — the child's dispatcher
    // resolveBase + read/write roots anchor at this path. When omitted,
    // the parent inheritance chain stays intact.
    ...(parsed.cwd !== undefined ? { cwd: parsed.cwd } : {}),
  } as AgentConfig;

  // Wire nesting: give the child its own executor + provider so it can
  // dispatch Agent and Skill tool calls. Skip when at maxDepth or no
  // factory — child gracefully loses both tools.
  //
  // childParentSession is a mutable stub: sessionId starts undefined and is
  // backfilled to handle.id once forkSubagent resolves. This ensures depth-2
  // forks (dispatched by childExecutor) see a real parentId rather than
  // undefined, so the stream-renderer can attribute them correctly.
  let childParentSession: ChildParentSession | undefined;
  let childManager: SubagentManager | undefined;
  if (args.childProviderFactory && depth < maxDepth) {
    // Forward cwd to the child manager so depth-2 forks (this depth-1
    // child calling the `agent` tool) inherit the worktree anchor.
    // Without this, `SubagentManager.forkSubagent` reads `this.parentCwd`
    // (undefined) and depth-2 child config.cwd is omitted — its
    // bash/grep/read_file fall back to process.cwd() (host repo).
    childManager = new SubagentManager({
      parentAbortSignal: signal,
      ...(currentCwd !== undefined ? { cwd: currentCwd } : {}),
      // Witness layer: without this, depth-2+ `agent` forks emit no
      // subagent_lifecycle events — the nested manager had no writer and
      // agent-tool dispatches never set config.traceWriter. Mirrors the
      // cwd chaining above; see BuildChildConfigArgs.traceWriter.
      ...(args.traceWriter !== undefined ? { traceWriter: args.traceWriter } : {}),
      // Origin attribution: thread the surface into the nested manager so
      // depth-2+ `agent` forks inherit the owning surface's origin
      // ('cli'/'telegram'/'daemon', not 'unknown') via forkSubagent's
      // parentSurface fill. Mirrors the traceWriter/cwd chaining above and the
      // recursive child executor ctx below (which already forwards args.surface).
      ...(args.surface !== undefined ? { surface: args.surface } : {}),
    });
    childParentSession = createStubParentSession(signal) as ChildParentSession;
    const childExecutor = createChildExecutor({
      subagentManager: childManager,
      parentSession: childParentSession as Pick<IAgentSession, 'sessionId' | 'getInputStreamRef' | 'abortSignal'>,
      defaultConfig,
      // Inherit origin from the parent; `depth + 1` below makes this child's
      // emitted rows carry actor:'subagent'.
      ...(args.surface !== undefined ? { surface: args.surface } : {}),
      defaultSubagentModel: args.defaultSubagentModel,
      childProviderFactory: args.childProviderFactory,
      childSkillExecutorFactory: args.childSkillExecutorFactory,
      // Propagate the resolver so depth ≥ 2 forks (this depth-1 child
      // calling the `agent` tool) also resolve credentials by child model.
      ...(args.resolveApiKeyForModel !== undefined
        ? { resolveApiKeyForModel: args.resolveApiKeyForModel }
        : {}),
      depth: depth + 1,
      maxDepth,
      // Forward cwd so the depth-1 child executor, when it constructs
      // ITS own childManager for depth-3+ forks, also receives cwd. The
      // chain holds for arbitrary depth up to maxDepth.
      ...(currentCwd !== undefined ? { cwd: currentCwd } : {}),
      // Forward the trace writer for the same reason — the child executor's
      // own childManager (depth-3+) needs it. See BuildChildConfigArgs.
      ...(args.traceWriter !== undefined ? { traceWriter: args.traceWriter } : {}),
      // Propagate read-only constraints so depth ≥ 2 forks (this depth-1
      // child calling the `agent` tool) keep the same tool allowlist and
      // bash gate that the originating read-only skill imposed.
      //
      // Deliberately the CAGE (ctx) values, not the named-agent effective
      // values: a named definition constrains the child it dispatches, not
      // that child's own descendants (Claude Code parity — nested spawns
      // resolve their own agent types). The cage, by contrast, cascades.
      ...(args.allowedTools !== undefined ? { allowedTools: args.allowedTools } : {}),
      ...(args.readOnlyBash ? { readOnlyBash: true } : {}),
      // Named-agent registry + the child's model (for grandchild `inherit`
      // resolution) thread through every depth.
      ...(args.agentRegistry !== undefined ? { agentRegistry: args.agentRegistry } : {}),
      // Scope the dispatched agent's OWN nested dispatches to the leaf types
      // its definition named (resolve.ts `nestedAgentTypes`). This is what
      // lets research-agent dispatch git-investigator and NOTHING else — the
      // gate at execute() top reads this from its ctx. Unset ⇒ unrestricted
      // (top-level, inherit-all, or bare-`Agent` agents).
      ...(resolvedAccess?.nestedAgentTypes !== undefined
        ? { nestedAgentAllowlist: resolvedAccess.nestedAgentTypes }
        : {}),
      parentModel: childModel,
    });
    const childSkillExecutor = args.childSkillExecutorFactory
      ? args.childSkillExecutorFactory(depth + 1, maxDepth, signal, currentCwd)
      : undefined;
    // Pass `model` so the factory routes between AnthropicDirect /
    // OpenAICompatible per `providerForModel(model)`. Without this, every
    // child inherits the legacy hardcoded AnthropicDirectProvider — which
    // means a gpt-4o parent silently dispatches subagents to
    // api.anthropic.com. See nesting.ts `createChildProviderFactory`.
    childConfig.provider = args.childProviderFactory({
      childExecutor,
      ...(childSkillExecutor !== undefined ? { childSkillExecutor } : {}),
      ...(childConfig.model !== undefined ? { model: childConfig.model } : {}),
      // Effective tool access for the dispatched child: the pre-existing
      // cage (read-only skill fan-out), intersected with the named agent's
      // resolved allowlist when one is in play (computed above). The
      // dispatcher both enforces this at the permission gate AND filters
      // the advertised schema to match (dispatcher.ts toolDefs), so a
      // research-agent child never even sees bash/write_file/agent.
      ...(effectiveAllowedTools !== undefined ? { allowedTools: effectiveAllowedTools } : {}),
      ...(effectiveReadOnlyBash ? { readOnlyBash: true } : {}),
    });
  } else if (effectiveAllowedTools !== undefined || effectiveReadOnlyBash) {
    // Restricted dispatch at the depth cap (or with no factory wired):
    // without an explicit provider the fork would inherit the default
    // UNRESTRICTED provider and the named agent's contract would silently
    // fail open. Build a minimal restricted provider instead — no nested
    // executors (at the cap the child cannot fan out anyway). Mirrors the
    // cap-path fix in skill-executor.ts buildForkedChildConfig.
    childConfig.provider = buildSkillRestrictedProvider(
      effectiveAllowedTools ?? [...CHILD_ALLOWED_TOOLS],
      childConfig.model,
      effectiveReadOnlyBash,
      defaultConfig.openaiBaseUrl,
    );
  }

  return { childConfig, childParentSession, childManager };
}
