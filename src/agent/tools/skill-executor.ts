/**
 * SkillExecutor: provider-level handler for the `skill` tool.
 *
 * Receives a ToolCall from the SessionToolDispatcher, looks up the skill
 * by name in the global skill registry (built-in + user-space) or in
 * plugin SKILL.md bodies, runs it, and returns a ToolResult.
 *
 * Mirrors the {@link SubagentExecutor} pattern: dedicated executor class,
 * injected via dispatcher options, special-cased in execute()/executeCore().
 *
 * @module agent/tools/skill-executor
 */

import { getSkill } from '../../skills/index.js';
import { SubagentManager } from '../subagent.js';
import type { AgentModelInput, IAgentSession } from '../types.js';
import type { ModelProvider } from '../provider.js';
import type { ToolCall, ToolResult } from './types.js';
import type { AgentConfig } from '../types/config-types.js';
import type { TraceWriter } from '../trace/index.js';
import type { BackgroundAgentRegistry } from '../background-registry.js';
import { collectSkillEntries, discoverPluginSkillBodies, type PluginSkillBody } from './skill-bridge.js';
import type { SdkPluginConfig } from '../types/sdk-types.js';
import {
  DEFAULT_MAX_NESTING_DEPTH,
  DEFAULT_READ_ONLY_SKILLS,
  RECON_ALLOWED_TOOLS,
  buildReadOnlyReconProvider,
  createStubParentSession,
  type ChildProviderFactoryArgs,
} from './nesting.js';
import { SubagentExecutor } from './subagent-executor.js';
import { buildSkillMaxDepthRefusal } from './skill-depth-message.js';
import { applyParentCredentialFallback } from './child-credential.js';
import { resolveCredentialForModel } from '../auth/credential-resolver.js';
import { getCurrentSink } from '../_lib/skill-sink-channel.js';
import { loadSkillPrompts } from '../../skills/_lib/prompt-loader.js';
import { appendRoutingDecision } from '../routing-telemetry.js';
import { isTrustedSkill } from '../_lib/trusted-skill-registry.js';
import { emitTrustedSkillComplete, emitTrustedSkillStart } from '../_lib/trusted-skill-events.js';
import { debugLog } from '../../utils/debug.js';

export interface SkillExecutorContext {
  parentSession: Pick<IAgentSession, 'sessionId' | 'getInputStreamRef' | 'abortSignal'> &
    // Optional: a skill orchestrator forked under a parent that exposes its
    // hook registry dispatches SubagentStop (incl. the shadow-verify nudge)
    // back to that parent. See SubagentManager.forkSubagent's parent fallback.
    Partial<Pick<IAgentSession, 'hookRegistry'>>;
  defaultModel?: string;
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
  childSkillExecutorFactory?: (depth: number, maxDepth: number, signal: AbortSignal) => SkillExecutor;
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
}

interface SkillInput {
  name: string;
  arguments?: string;
}

/**
 * Maximum length of `error_message` written to routing-decisions.jsonl.
 * Honors the routing-telemetry privacy contract (§G.4: short error message,
 * no stack traces, no user content). Mirrors subagent-executor's local
 * `truncate` (subagent-executor.ts:158) — kept local so each emitter owns
 * its own bounds and the telemetry helper stays schema-only.
 */
const MAX_TELEMETRY_ERROR_CHARS = 240;

function truncateTelemetryString(s: string, max = MAX_TELEMETRY_ERROR_CHARS): string {
  return s.length <= max ? s : s.slice(0, max) + '…';
}

/**
 * Best-effort lookup of the requested skill name from raw tool input — used
 * for telemetry at the depth-refusal site, where we want a `requested_name`
 * field without changing the order of error precedence (parse errors come
 * after the depth check). Returns undefined if the input shape is wrong.
 */
function extractRequestedSkillName(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const name = (input as Record<string, unknown>)['name'];
  if (typeof name !== 'string') return undefined;
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseSkillInput(input: unknown): SkillInput {
  if (typeof input !== 'object' || input === null) {
    throw new Error('Skill tool input must be an object');
  }

  const obj = input as Record<string, unknown>;

  const name = obj['name'];
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new Error('Skill tool input must have a non-empty "name" field');
  }

  let args: string | undefined;
  const argsValue = obj['arguments'];
  if (argsValue !== undefined) {
    if (typeof argsValue !== 'string') {
      throw new Error('Skill tool "arguments" must be a string');
    }
    args = argsValue;
  }

  return { name: name.trim(), arguments: args };
}

export class SkillExecutor {
  private pluginBodies: Map<string, PluginSkillBody> | null = null;

  constructor(private readonly ctx: SkillExecutorContext) {}

  async execute(call: ToolCall): Promise<ToolResult> {
    if (call.signal.aborted) {
      return { content: 'Skill tool call aborted', isError: true };
    }

    const depth = this.ctx.depth ?? 0;
    const maxDepth = this.ctx.maxDepth ?? DEFAULT_MAX_NESTING_DEPTH;
    if (depth >= maxDepth) {
      // Best-effort: surface a name for the telemetry payload without
      // changing the error precedence (parse errors still come later).
      const requestedName = extractRequestedSkillName(call.input);
      void appendRoutingDecision({
        event: 'delegation.skipped',
        parent_session_id: this.ctx.parentSession.sessionId,
        reason: 'max_depth',
        depth,
        requested_name: requestedName,
      }).catch(() => {});
      return {
        content: buildSkillMaxDepthRefusal(depth, maxDepth),
        isError: true,
      };
    }

    let parsed: SkillInput;
    try {
      parsed = parseSkillInput(call.input);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: `Skill tool input validation failed: ${message}`,
        isError: true,
      };
    }

    // 1. Try the global skill registry (built-in + user-space skills).
    //    These already have handlers that dispatch subagents internally.
    try {
      const skill = getSkill(parsed.name);
      return await this.executeRegistrySkill(skill, parsed.arguments, call);
    } catch {
      // getSkill throws on not-found — fall through to plugin lookup.
    }

    // 2. Try plugin skills (SKILL.md body). Default is in-context LOAD; a
    //    plugin skill forks a subagent ONLY when its frontmatter explicitly
    //    declares `context: fork`. (History: the default was fork until
    //    2026-06; flipped to load so authored skills act in-context by
    //    default. Isolation-critical bundled skills are pinned to
    //    `context: fork`. See docs/skill-load-mode.md.)
    const pluginSkill = this.getPluginSkillBody(parsed.name);
    if (pluginSkill) {
      if (pluginSkill.context === 'fork') {
        // Read-only enforcement: a plugin skill is read-only when its SKILL.md
        // frontmatter declares `read-only: true` (surfaced as `pluginSkill.readOnly`)
        // OR its name is in DEFAULT_READ_ONLY_SKILLS (name-keyed so any copy of
        // the SKILL.md is protected — e.g. the bundled `ground-state`). Only the
        // forked path takes readOnly: a loaded skill runs in the caller's context,
        // so there is no child whose tool surface could be restricted.
        const readOnly =
          pluginSkill.readOnly === true || DEFAULT_READ_ONLY_SKILLS.has(parsed.name);
        return await this.executePluginSkill(
          parsed.name,
          pluginSkill.body,
          pluginSkill.pluginPath,
          parsed.arguments,
          call,
          readOnly,
        );
      }
      // Default: in-context LOAD (2026-06 load-by-default flip). No readOnly —
      // loaded skills execute in the caller's context, not a restrictable child.
      const bodyWithRoot = pluginSkill.body.replace(
        /\$\{?PLUGIN_ROOT\}?/g,
        () => pluginSkill.pluginPath,
      );
      return this.executeLoadedPluginSkill(
        parsed.name,
        bodyWithRoot,
        parsed.arguments,
        call,
      );
    }

    // 3. Not found — return available skills list.
    const entries = collectSkillEntries(this.ctx.pluginConfigs);
    const available = entries.map((e) => e.name).join(', ');
    return {
      content: `Skill "${parsed.name}" not found. Available skills: ${available || '(none)'}`,
      isError: true,
    };
  }

  private async executeRegistrySkill(
    skill: {
      handler: (
        input: unknown,
        parentSession?: IAgentSession,
        ctx?: import('../../skills/index.js').SkillExecutionContext,
      ) => Promise<unknown>;
      name: string;
      context?: 'inline' | 'fork' | 'load';
      model?: string;
      readOnly?: boolean;
      loadBody?: string;
    },
    args: string | undefined,
    call: ToolCall,
  ): Promise<ToolResult> {
    if (call.signal.aborted) {
      return { content: 'Skill call aborted', isError: true };
    }

    // If context is 'fork', route through subagent instead of calling handler directly
    if (skill.context === 'fork') {
      return this.executeForkedRegistrySkill(skill, args, call);
    }

    // If context is 'load', return the skill body for in-context execution by
    // the CURRENT agent — no fork, no handler call (see docs/skill-load-mode.md).
    if (skill.context === 'load') {
      return this.executeLoadedRegistrySkill(skill, args, call);
    }

    // Default inline execution. Pass execution context so handlers that fork
    // sub-agents can inherit the parent's apiKey — without it, child sessions
    // hit AnthropicDirectProvider's "requires config.apiKey" error when AFK
    // auth comes from the macOS keychain instead of an env var.
    const trusted = isTrustedSkill(skill.name);
    if (trusted) emitTrustedSkillStart(skill.name);

    // Lifecycle telemetry — inline registry path. Fork + plugin paths emit
    // `subagent.dispatched` rows with `skill-fork-<name>` / `skill-<name>`
    // id_prefix via SubagentManager.forkSubagent (subagent.ts:385), so they
    // are already countable. The inline path runs the handler directly, so
    // without these two events the 5 inline skills (mint, forge, diagnose,
    // audit-fit, score) are invisible to operator usage queries.
    const depth = this.ctx.depth ?? 0;
    void appendRoutingDecision({
      event: 'skill.dispatched',
      requested_name: skill.name,
      parent_session_id: this.ctx.parentSession.sessionId,
      depth,
      ...(skill.model !== undefined ? { model: skill.model } : {}),
    }).catch(() => {});

    const startMs = Date.now();
    let handlerError: unknown = undefined;
    let result: unknown;
    try {
      result = await skill.handler(
        args && args.length > 0 ? args : undefined,
        this.ctx.parentSession as IAgentSession,
        {
          apiKey: this.ctx.apiKey,
          defaultModel: this.ctx.defaultModel,
          defaultSubagentModel: this.ctx.defaultSubagentModel,
          // `callId` lets inline handlers forward `parentId: callId` to
          // every `manager.forkSubagent(...)` they make — anchoring forked
          // subagents under this skill's tool-lane entry instead of letting
          // them orphan at root the moment their Done block commits.
          // Mirrors the explicit `parentId: call.id` pass in the forked
          // (context: 'fork') registry/plugin paths below.
          callId: call.id,
          dispatchSkill: this.createDispatchSkillCallback(call),
        },
      );
    } catch (err) {
      handlerError = err;
    } finally {
      const durationMs = Date.now() - startMs;
      if (trusted) {
        emitTrustedSkillComplete({
          skillName: skill.name,
          durationMs,
          ...(handlerError !== undefined ? { isError: true } : {}),
        });
      }
      // Emit completion telemetry. Mirrors subagent-executor's privacy
      // contract: content_chars on success, truncated error_message on
      // failure — never the result body or the full error.
      const errorMessage =
        handlerError !== undefined
          ? handlerError instanceof Error
            ? handlerError.message
            : String(handlerError)
          : undefined;
      const contentChars =
        handlerError === undefined
          ? typeof result === 'string'
            ? result.length
            : result !== undefined && result !== null
              ? JSON.stringify(result).length
              : 0
          : undefined;
      void appendRoutingDecision({
        event: 'skill.completed',
        requested_name: skill.name,
        parent_session_id: this.ctx.parentSession.sessionId,
        status: handlerError !== undefined ? 'failed' : 'succeeded',
        duration_ms: durationMs,
        depth,
        ...(contentChars !== undefined ? { content_chars: contentChars } : {}),
        ...(errorMessage !== undefined
          ? { error_message: truncateTelemetryString(errorMessage) }
          : {}),
        ...(skill.model !== undefined ? { model: skill.model } : {}),
      }).catch(() => {});
    }
    if (handlerError !== undefined) {
      const message = handlerError instanceof Error ? handlerError.message : String(handlerError);
      return { content: `Skill execution error: ${message}`, isError: true };
    }
    const content = typeof result === 'string'
      ? result
      : result !== undefined && result !== null
        ? JSON.stringify(result)
        : 'Skill completed successfully.';
    return { content };
  }

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
  private buildForkedChildConfig(
    baseConfig: AgentConfig,
    signal: AbortSignal,
    // When true, this is a read-only skill (frontmatter `read-only: true` or a
    // name in DEFAULT_READ_ONLY_SKILLS). The forked child is built with the
    // RECON tool allowlist (no write_file/edit_file) and the mutating-bash
    // gate — on BOTH the factory path and the depth-cap/no-factory fallback.
    readOnly = false,
  ): { childConfig: AgentConfig; childManager: SubagentManager | undefined } {
    const depth = this.ctx.depth ?? 0;
    const maxDepth = this.ctx.maxDepth ?? DEFAULT_MAX_NESTING_DEPTH;
    const childConfig: AgentConfig = { ...baseConfig };

    if (!this.ctx.childProviderFactory || depth >= maxDepth) {
      // Depth-cap / no-factory fallback. The child would otherwise inherit the
      // bare provider singleton with the full write surface and no bash gate,
      // silently defeating read-only enforcement. Build an explicit read-only
      // recon provider so the constraint holds even here (no agent/skill fan-out
      // is possible at the cap anyway, so the missing executors are harmless).
      if (readOnly) {
        childConfig.provider = buildReadOnlyReconProvider(childConfig.model);
      }
      return { childConfig, childManager: undefined };
    }

    const childManager = new SubagentManager({
      parentAbortSignal: signal,
      ...(this.ctx.traceWriter !== undefined ? { traceWriter: this.ctx.traceWriter } : {}),
      // Worktree isolation: forward cwd so when the skill-forked child
      // dispatches its own `agent` calls (grandchild forks), the manager's
      // forkSubagent injects cwd into the grandchild's config. Mirrors
      // subagent-executor.ts:294.
      ...(this.ctx.cwd !== undefined ? { cwd: this.ctx.cwd } : {}),
    });
    const childExecutor = new SubagentExecutor({
      subagentManager: childManager,
      parentSession: createStubParentSession(signal),
      defaultConfig: {
        model: childConfig.model,
        apiKey: this.ctx.apiKey,
        ...(this.ctx.baseUrl !== undefined ? { baseUrl: this.ctx.baseUrl } : {}),
      } as AgentConfig,
      defaultSubagentModel: this.ctx.defaultSubagentModel,
      childProviderFactory: this.ctx.childProviderFactory,
      childSkillExecutorFactory: this.ctx.childSkillExecutorFactory,
      // Propagate resolver so grandchild `agent` dispatches (skill-forked
      // child calling the `agent` tool) also resolve credentials by child
      // model rather than forwarding the skill-child's pre-captured apiKey.
      ...(this.ctx.resolveApiKeyForModel !== undefined
        ? { resolveApiKeyForModel: this.ctx.resolveApiKeyForModel }
        : {}),
      depth: depth + 1,
      maxDepth,
      // Forward cwd so the grandchild executor's own childManager (when it
      // recursively constructs one for great-grandchild forks) is also cwd-anchored.
      ...(this.ctx.cwd !== undefined ? { cwd: this.ctx.cwd } : {}),
      // Invariant: background dispatch requires the registry to be present
      // in every SubagentExecutor in the chain — root → skill-forked child →
      // skill-forked grandchild. Without forwarding, a plugin skill's
      // subagent calling `agent` with `mode:"background"` (the SKILL.md
      // "Dispatch N sub-agents in parallel" idiom) fast-fails synchronously
      // with the 163-byte "BackgroundAgentRegistry is not wired" error
      // before any model call. Skip forwarding only when the host surface
      // (chat / threads / telegram) intentionally omits the registry.
      ...(this.ctx.backgroundRegistry !== undefined
        ? { backgroundRegistry: this.ctx.backgroundRegistry }
        : {}),
      // Propagate read-only constraints into the SubagentExecutor that will
      // handle `agent` tool calls from this skill-forked child. Without this,
      // a depth-2 fan-out (`ground-state → agent → depth-2`) loses the
      // allowlist — the grandchild SubagentExecutor's `childProviderFactory`
      // call omits allowedTools/readOnlyBash and falls back to CHILD_ALLOWED_TOOLS.
      ...(readOnly ? { allowedTools: [...RECON_ALLOWED_TOOLS], readOnlyBash: true as const } : {}),
    });
    const childSkillExecutor = this.ctx.childSkillExecutorFactory
      ? this.ctx.childSkillExecutorFactory(depth + 1, maxDepth, signal)
      : undefined;
    // Pass `model` so the factory routes between AnthropicDirect /
    // OpenAICompatible per `providerForModel(model)`. Without this, every
    // skill-forked child inherits the legacy hardcoded
    // AnthropicDirectProvider — meaning an OpenAI-routed parent silently
    // dispatches every skill subagent to api.anthropic.com.
    childConfig.provider = this.ctx.childProviderFactory({
      childExecutor,
      ...(childSkillExecutor !== undefined ? { childSkillExecutor } : {}),
      ...(childConfig.model !== undefined ? { model: childConfig.model } : {}),
      // Read-only enforcement: hand the factory the RECON allowlist (strips
      // write_file/edit_file) and turn on the mutating-bash gate. The child
      // keeps `agent`/`skill` (so surveyor fan-out still works) and read-only
      // bash (git status/log/diff for dirty-tree detection).
      ...(readOnly ? { allowedTools: [...RECON_ALLOWED_TOOLS], readOnlyBash: true } : {}),
    });

    return { childConfig, childManager };
  }

  private async executeForkedRegistrySkill(
    skill: {
      name: string;
      context?: 'inline' | 'fork' | 'load';
      model?: string;
      readOnly?: boolean;
    },
    args: string | undefined,
    call: ToolCall,
  ): Promise<ToolResult> {
    if (call.signal.aborted) {
      return { content: 'Skill call aborted', isError: true };
    }

    // A skill is enforced read-only when its frontmatter declares it OR its
    // name is in DEFAULT_READ_ONLY_SKILLS (keying on name protects any copy of
    // the SKILL.md). Threaded into buildForkedChildConfig below.
    const readOnly = skill.readOnly === true || DEFAULT_READ_ONLY_SKILLS.has(skill.name);

    // Load prompts from the skill's directory
    let systemPrompt: string | undefined;
    try {
      const prompts = loadSkillPrompts(skill.name);
      systemPrompt = prompts['system.md'];
      if (!systemPrompt) {
        return {
          content: `Skill "${skill.name}" has context: "fork" but no prompts/system.md found`,
          isError: true,
        };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: `Failed to load skill prompts: ${message}`, isError: true };
    }

    // Resolve the skill child's model first so we can derive the correct
    // credential for this specific child. The resolver is now available
    // directly from the agent layer (resolveCredentialForModel), so no
    // injection is required. `this.ctx.resolveApiKeyForModel` acts as an
    // optional override for callers that need a custom strategy (e.g. tests).
    const skillChildModel = skill.model ?? this.ctx.defaultSubagentModel ?? this.ctx.defaultModel ?? 'sonnet';
    const skillChildApiKey = applyParentCredentialFallback({
      childModel: skillChildModel,
      resolved: this.ctx.resolveApiKeyForModel
        ? this.ctx.resolveApiKeyForModel(skillChildModel)
        : resolveCredentialForModel(skillChildModel),
      parentApiKey: this.ctx.apiKey,
    });

    const manager = new SubagentManager({
      parentAbortSignal: call.signal,
      apiKey: skillChildApiKey,
      ...(this.ctx.baseUrl !== undefined ? { baseUrl: this.ctx.baseUrl } : {}),
      ...(this.ctx.traceWriter !== undefined ? { traceWriter: this.ctx.traceWriter } : {}),
      progressSink: getCurrentSink(),
      // Worktree isolation: this manager forks the skill subagent. cwd
      // forwarding here is what gives the skill subagent's bash/grep/file
      // tools the worktree anchor. Without it, every `/diagnose`, `/mint`,
      // etc. run their first-tier subagents against the host repo.
      ...(this.ctx.cwd !== undefined ? { cwd: this.ctx.cwd } : {}),
    });

    // Thread traceWriter into the child's AgentConfig so its tool_use, hook,
    // and lifecycle events emit into the parent's trace. Without this,
    // SubagentManager.forkSubagent's emitSubagentLifecycle no-ops (it reads
    // options.config.traceWriter, not the manager's).
    const { childConfig, childManager } = this.buildForkedChildConfig(
      {
        model: skillChildModel,
        systemPrompt,
        // Invariant: skill-dispatch sub-agents must not inherit the
        // SLASH_COMMAND_ROUTING_PROMPT paragraph. They receive a "Run the
        // <name> skill" directive with no <command-name> tag, so the routing
        // instruction (which keys off that tag) would push them to ask
        // "which skill?" instead of engaging with their SKILL.md body.
        isSkillDispatch: true,
        ...(this.ctx.traceWriter !== undefined ? { traceWriter: this.ctx.traceWriter } : {}),
      } as AgentConfig,
      call.signal,
      readOnly,
    );

    // Invariant: `handle` is declared OUTSIDE the try so finally can call
    // `handle.teardown()` — the only path that runs `session.close()` →
    // `dispatchSessionEndOnce()` → `emitClosure()` + `sealTraceWriter()`.
    // `manager.teardownAll()` is NOT sufficient: per subagent.ts:412-414
    // (its own JSDoc), `teardownAll()` iterates `this.active.values()` but
    // a handle that completed a run has already self-removed via the
    // `onTerminal` closure (subagent.ts:340-343). Without an explicit
    // `handle.teardown()` the child's traceWriter never seals, blinding
    // every closure-event-dependent improve detector.
    // Mirrors the pattern in subagent-executor.ts:321,533.
    let handle: Awaited<ReturnType<typeof manager.forkSubagent>> | undefined;
    try {
      // `parentId: call.id` anchors the synthesized `Agent(<label>)` entry as
      // a child of THIS skill's tool-lane entry rather than at root. Mirrors
      // `ComposeExecutor` (see compose-executor.ts:227-232). Path 2 of
      // `StreamRenderer.process()`'s parentId resolver fires because
      // `toolLane.hasEntry(call.id)` is true — the parent already registered
      // the skill entry when it processed the `tool_use_detail` chunk before
      // dispatching this executor. Paired with `'skill'` in `NESTING_TOOLS`
      // (tool-category.ts) so the renderer recurses into the children block.
      handle = await manager.forkSubagent({
        parent: this.ctx.parentSession,
        config: childConfig,
        idPrefix: `skill-fork-${skill.name}`,
        parentId: call.id,
        agentType: skill.name,
      });

      // Invariant: name the skill explicitly. A bare "Run the skill." is
      // ambiguous — combined with the injected skill manifest and the
      // memory-search-on-turn-1 guidance, the sub-agent can resolve the
      // ambiguity by asking the operator "which skill?" instead of executing
      // its own SKILL.md body. Naming the skill removes that ambiguity.
      const userMessage =
        args && args.length > 0
          ? args
          : `Run the ${skill.name} skill now, following the instructions in your system prompt.`;
      const result = await handle.runToResult(userMessage);

      if (result.status === 'succeeded' && result.message) {
        return { content: result.message.content };
      }

      // When the subagent was cancelled mid-flight but produced text before
      // cancellation, surface the partial output to the model with a clear
      // marker rather than discarding it. The model can decide what to do.
      if (
        result.status === 'cancelled' &&
        typeof result.partialOutput === 'string' &&
        result.partialOutput.length > 0
      ) {
        const marker = '[skill cancelled mid-flight — partial output preserved below]';
        return { content: `${marker}\n\n${result.partialOutput}` };
      }

      const errorMessage = result.error?.message ?? 'Forked skill failed with no output';
      return { content: errorMessage, isError: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: `Forked skill execution error: ${message}`, isError: true };
    } finally {
      // Order: per-handle teardown (seals child trace) → child manager (any
      // grandchildren) → outer manager (any siblings that never ran).
      // Guard against `forkSubagent` having thrown before assignment —
      // see subagent.ts:316-320 for the construction-failure throw path.
      if (handle) await handle.teardown().catch(debugLog);
      await childManager?.teardownAll();
      await manager.teardownAll();
    }
  }

  /**
   * Frame a skill body for in-context ("load") execution and return it as the
   * tool result.
   *
   * Invariant: the current agent must EXECUTE the body as its immediate task,
   * not summarize it. In `load` mode there is no forked sub-agent and no
   * separate system prompt — the body becomes a tool_result the caller acts on
   * directly — so the header states intent explicitly and echoes the args.
   * This is the in-context / progressive-disclosure counterpart to the fork
   * paths (executeForkedRegistrySkill / executePluginSkill); see
   * docs/skill-load-mode.md.
   */
  private formatLoadedSkillResult(
    name: string,
    body: string,
    args: string | undefined,
  ): ToolResult {
    const argLine = args && args.trim().length > 0 ? args.trim() : '(none)';
    const header =
      `[Skill "${name}" loaded into your current context — act on it now]\n` +
      'The instructions below are your operating procedure for THIS task. ' +
      'Execute them immediately, in this session, using the tools you already ' +
      'have. This is an instruction set, not reference material: follow it ' +
      'directly — do not merely summarize or describe it. No sub-agent was ' +
      'forked; you are the one carrying it out.\n' +
      `Arguments: ${argLine}`;
    return { content: `${header}\n\n----- skill: ${name} -----\n\n${body}` };
  }

  /**
   * Emit `skill.dispatched` + `skill.completed` telemetry for an in-context
   * load. Mirrors the inline path's privacy contract (content_chars only, no
   * body) and tags `mode: 'load'` so usage queries can distinguish load
   * dispatches from forked ones.
   */
  private emitLoadTelemetry(
    name: string,
    contentChars: number,
    durationMs: number,
    model: string | undefined,
  ): void {
    const depth = this.ctx.depth ?? 0;
    const base = {
      requested_name: name,
      parent_session_id: this.ctx.parentSession.sessionId,
      depth,
      mode: 'load',
      ...(model !== undefined ? { model } : {}),
    };
    void appendRoutingDecision({ event: 'skill.dispatched', ...base }).catch(() => {});
    void appendRoutingDecision({
      event: 'skill.completed',
      status: 'succeeded',
      duration_ms: durationMs,
      content_chars: contentChars,
      ...base,
    }).catch(() => {});
  }

  /**
   * Load path for a registry skill (`context: 'load'`). Resolves the body in
   * priority order:
   *   1. `skill.loadBody` — set by disk-scanned user/project skills, whose
   *      body is the SKILL.md content (not the built-in prompts/ convention).
   *      `${SKILL_ROOT}` is already expanded by the registrant.
   *   2. `loadSkillPrompts(name)['system.md']` — the built-in convention.
   * Substitutes `$ARGUMENT(S)` and returns the framed body for in-context
   * execution. Never forks and never calls the skill's `handler`.
   */
  private executeLoadedRegistrySkill(
    skill: { name: string; model?: string; loadBody?: string },
    args: string | undefined,
    call: ToolCall,
  ): ToolResult {
    if (call.signal.aborted) {
      return { content: 'Skill call aborted', isError: true };
    }
    const startMs = Date.now();
    let body: string;
    if (skill.loadBody !== undefined) {
      body = skill.loadBody;
    } else {
      try {
        const prompts = loadSkillPrompts(skill.name);
        const system = prompts['system.md'];
        if (!system) {
          return {
            content: `Skill "${skill.name}" has context: "load" but no prompts/system.md found`,
            isError: true,
          };
        }
        body = system;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: `Failed to load skill prompts: ${message}`, isError: true };
      }
    }
    const substituted = this.substituteSkillArgs(body, args);
    this.emitLoadTelemetry(skill.name, substituted.length, Date.now() - startMs, skill.model);
    return this.formatLoadedSkillResult(skill.name, substituted, args);
  }

  /**
   * Load path for a plugin skill whose SKILL.md frontmatter declares
   * `context: load`. Substitutes args into the body and returns it framed for
   * in-context execution. Never forks; `$PLUGIN_ROOT` / `\${PLUGIN_ROOT}` placeholders
   * are expanded to the plugin's install path at the call site before this method
   * receives the body, so shell commands that reference the plugin directory
   * resolve correctly when the current agent executes them.
   */
  private executeLoadedPluginSkill(
    skillName: string,
    body: string,
    args: string | undefined,
    call: ToolCall,
  ): ToolResult {
    if (call.signal.aborted) {
      return { content: 'Skill call aborted', isError: true };
    }
    const startMs = Date.now();
    const substituted = this.substituteSkillArgs(body, args);
    this.emitLoadTelemetry(skillName, substituted.length, Date.now() - startMs, undefined);
    return this.formatLoadedSkillResult(skillName, substituted, args);
  }

  /**
   * Substitute `$ARGUMENT` and `$ARGUMENTS` placeholders in a SKILL.md body
   * with the caller-supplied args string.
   *
   * Contract:
   * - Both `$ARGUMENT` and `$ARGUMENTS` (word-boundary, single-pass regex) are
   *   replaced with `args`. Using a single pattern `/\$ARGUMENTS?\b/g` handles
   *   both forms without double-substitution.
   * - When `args` is undefined or empty, the placeholder is replaced with an
   *   empty string — matching the slash-command semantics SKILL.md authors
   *   expect (e.g. `/ship` with no arguments produces an empty `$ARGUMENT`).
   * - Bodies that contain neither placeholder are returned unchanged.
   * - Substitution uses a replacement *function*, not a replacement
   *   string, so `$` sequences in `args` ($$, $&, $`, $', $n) are
   *   inserted verbatim rather than being interpreted as
   *   `String.prototype.replace` special patterns.
   * - Applied to every body that runs without a forked sub-agent's user
   *   message to carry the args: both plugin paths (`executePluginSkill`,
   *   `executeLoadedPluginSkill`) and the registry load path
   *   (`executeLoadedRegistrySkill`). The forked registry path
   *   (`executeForkedRegistrySkill`) is NOT patched — it passes args as the
   *   child's user message, and its `system.md` bodies do not reference
   *   `$ARGUMENT` by convention.
   */
  private substituteSkillArgs(body: string, args: string | undefined): string {
    const replacement = args ?? '';
    return body.replace(/\$ARGUMENTS?\b/g, () => replacement);
  }

  private async executePluginSkill(
    skillName: string,
    body: string,
    pluginPath: string,
    args: string | undefined,
    call: ToolCall,
    // Read-only enforcement flag, computed at the call site from the plugin
    // body's `readOnly` frontmatter OR DEFAULT_READ_ONLY_SKILLS membership.
    readOnly = false,
  ): Promise<ToolResult> {
    if (call.signal.aborted) {
      return { content: 'Skill call aborted', isError: true };
    }

    // Resolve the plugin skill child's model first (same resolver pattern as
    // executeForkedRegistrySkill) so we can derive the correct credential.
    // The resolver is now available directly from the agent layer
    // (resolveCredentialForModel), so no injection is required.
    const pluginChildModel = this.ctx.defaultSubagentModel ?? this.ctx.defaultModel ?? 'sonnet';
    const pluginChildApiKey = applyParentCredentialFallback({
      childModel: pluginChildModel,
      resolved: this.ctx.resolveApiKeyForModel
        ? this.ctx.resolveApiKeyForModel(pluginChildModel)
        : resolveCredentialForModel(pluginChildModel),
      parentApiKey: this.ctx.apiKey,
    });

    const manager = new SubagentManager({
      parentAbortSignal: call.signal,
      apiKey: pluginChildApiKey,
      ...(this.ctx.baseUrl !== undefined ? { baseUrl: this.ctx.baseUrl } : {}),
      ...(this.ctx.traceWriter !== undefined ? { traceWriter: this.ctx.traceWriter } : {}),
      progressSink: getCurrentSink(),
      // Worktree isolation — same rationale as executeForkedRegistrySkill above.
      ...(this.ctx.cwd !== undefined ? { cwd: this.ctx.cwd } : {}),
    });

    // PLUGIN_ROOT is injected here so shell commands in the plugin SKILL.md
    // body — e.g. `python3 "${PLUGIN_ROOT}/scripts/foo.py"` — resolve to the
    // plugin's actual install path. The plugin's own Phase-1 fallback
    // (`${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}`) means Claude Code keeps
    // working unchanged; AFK wins because it sets PLUGIN_ROOT directly.
    //
    // traceWriter on childConfig is what makes the fork visible in the
    // witness trace — SubagentManager.forkSubagent reads it off
    // options.config, not off the manager. Mirror in executeForkedRegistrySkill.
    const { childConfig, childManager } = this.buildForkedChildConfig(
      {
        model: pluginChildModel,
        systemPrompt: this.substituteSkillArgs(body, args),
        env: { PLUGIN_ROOT: pluginPath },
        // Invariant: skill-dispatch sub-agents must not inherit the
        // SLASH_COMMAND_ROUTING_PROMPT paragraph. They receive a "Run the
        // <name> skill" directive with no <command-name> tag, so the routing
        // instruction (which keys off that tag) would push them to ask
        // "which skill?" instead of engaging with their SKILL.md body.
        isSkillDispatch: true,
        ...(this.ctx.traceWriter !== undefined ? { traceWriter: this.ctx.traceWriter } : {}),
      } as AgentConfig,
      call.signal,
      readOnly,
    );

    // Invariant: same trace-sealing rule as executeForkedRegistrySkill above.
    // `handle.teardown()` is the only path to `session.close()` → closure
    // event + `session_sealed`. `manager.teardownAll()` misses completed
    // handles per subagent.ts:412-414.
    let handle: Awaited<ReturnType<typeof manager.forkSubagent>> | undefined;
    try {
      // `parentId: call.id` anchors the synthesized `Agent(<label>)` entry as
      // a child of THIS skill's tool-lane entry rather than at root. Mirrors
      // `ComposeExecutor` (see compose-executor.ts:227-232). Path 2 of
      // `StreamRenderer.process()`'s parentId resolver fires because
      // `toolLane.hasEntry(call.id)` is true — the parent already registered
      // the skill entry when it processed the `tool_use_detail` chunk before
      // dispatching this executor. Paired with `'skill'` in `NESTING_TOOLS`
      // (tool-category.ts) so the renderer recurses into the children block.
      handle = await manager.forkSubagent({
        parent: this.ctx.parentSession,
        config: childConfig,
        idPrefix: `skill-${skillName}`,
        parentId: call.id,
        agentType: skillName,
      });

      // Invariant: name the skill explicitly. See executeForkedRegistrySkill —
      // a bare "Run the skill." lets the sub-agent ask the operator "which
      // skill?" instead of executing its own SKILL.md body.
      const userMessage =
        args && args.length > 0
          ? args
          : `Run the ${skillName} skill now, following the instructions in your system prompt.`;
      const result = await handle.runToResult(userMessage);

      if (result.status === 'succeeded' && result.message) {
        return { content: result.message.content };
      }

      // When the subagent was cancelled mid-flight but produced text before
      // cancellation, surface the partial output to the model with a clear
      // marker rather than discarding it. The model can decide what to do.
      if (
        result.status === 'cancelled' &&
        typeof result.partialOutput === 'string' &&
        result.partialOutput.length > 0
      ) {
        const marker = '[skill cancelled mid-flight — partial output preserved below]';
        return { content: `${marker}\n\n${result.partialOutput}` };
      }

      const errorMessage = result.error?.message ?? 'Plugin skill failed with no output';
      return { content: errorMessage, isError: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: `Plugin skill execution error: ${message}`, isError: true };
    } finally {
      if (handle) await handle.teardown().catch(debugLog);
      await childManager?.teardownAll();
      await manager.teardownAll();
    }
  }

  private getPluginSkillBody(name: string): PluginSkillBody | undefined {
    if (!this.pluginBodies) {
      this.pluginBodies = discoverPluginSkillBodies(this.ctx.pluginConfigs);
    }
    return this.pluginBodies.get(name);
  }

  /**
   * Build a `dispatchSkill` callback for a TypeScript handler. The callback
   * re-enters {@link execute} with a synthesized {@link ToolCall}, so the
   * registry → plugin-body lookup is used — plugin skills (`shadow-verify`,
   * etc.) are reachable from inline handlers that have no direct access to
   * the executor.
   *
   * The parent call's `signal` is reused so user-interrupt cancellation
   * propagates into the child dispatch. Depth tracking is enforced by
   * {@link execute}; a depth refusal surfaces as a thrown Error.
   *
   * Returns the dispatched skill's `content` on success. Throws when the
   * dispatched skill returns `isError: true` (content becomes the error
   * message), letting handlers `try/catch` for graceful degradation.
   */
  private createDispatchSkillCallback(
    parentCall: ToolCall,
  ): (name: string, args?: string) => Promise<string> {
    return async (name, args) => {
      const childCall: ToolCall = {
        id: `${parentCall.id}-dispatch-${name}`,
        name: 'skill',
        input: { name, ...(args !== undefined ? { arguments: args } : {}) },
        signal: parentCall.signal,
      };
      const result = await this.execute(childCall);
      if (result.isError) {
        throw new Error(result.content);
      }
      return result.content;
    };
  }
}
