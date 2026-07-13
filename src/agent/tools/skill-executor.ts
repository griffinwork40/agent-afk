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
 * The implementation is split across `skill-executor/` siblings (#363):
 *   - `skill-executor/types.ts`             — SkillExecutorContext + internals seam
 *   - `skill-executor/telemetry.ts`         — gate roster, truncation, session identity
 *   - `skill-executor/load-mode.ts`         — in-context load paths + $ARGUMENT substitution
 *   - `skill-executor/fork-child-config.ts` — permission/allowlist propagation for forks
 *   - `skill-executor/fork-dispatch.ts`     — forked registry/plugin paths + run/teardown driver
 * This file remains the stable import path (`./skill-executor.js`): it keeps
 * the top-level `execute()` router, the inline registry path, and
 * `createDispatchSkillCallback`, and re-exports the public surface so no
 * consumer's import changes.
 *
 * @module agent/tools/skill-executor
 */

import { getSkill } from '../../skills/index.js';
import type { IAgentSession } from '../types.js';
import type { ToolCall, ToolResult } from './types.js';
import { collectSkillEntries, discoverPluginSkillBodies, type PluginSkillBody } from './skill-bridge.js';
import { DEFAULT_MAX_NESTING_DEPTH, DEFAULT_READ_ONLY_SKILLS } from './nesting.js';
import { buildSkillMaxDepthRefusal } from './skill-depth-message.js';
import { appendRoutingDecision } from '../routing-telemetry.js';
import { isTrustedSkill } from '../_lib/trusted-skill-registry.js';
import { emitTrustedSkillComplete, emitTrustedSkillStart } from '../_lib/trusted-skill-events.js';
import type { SkillExecutorContext, SkillExecutorInternals, SkillInput } from './skill-executor/types.js';
import { isGateSkill, sessionIdentity, truncateTelemetryString } from './skill-executor/telemetry.js';
import { executeLoadedPluginSkill, executeLoadedRegistrySkill } from './skill-executor/load-mode.js';
import { executeForkedRegistrySkill, executePluginSkill } from './skill-executor/fork-dispatch.js';

export type { SkillExecutorContext } from './skill-executor/types.js';

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
  // Current worktree cwd. Seeded from ctx.cwd; updated by setCwd when the
  // session's cwd changes (born-named `afk -w` worktree created on turn 1) so
  // skill-forked sub-agents anchor to the worktree, not the host process.cwd().
  private currentCwd: string | undefined;

  constructor(private readonly ctx: SkillExecutorContext) {
    this.currentCwd = ctx.cwd;
  }

  /**
   * Re-anchor the cwd used for skill-forked sub-agents after a cwd change.
   *
   * Invariant: also drops the lazily-populated `pluginBodies` cache. That
   * cache is keyed implicitly by whatever `currentCwd` was at first
   * population (see `getPluginSkillBody()`); without clearing it here, a
   * plugin skill dispatched after this cwd change would keep resolving the
   * OLD cwd's plugin bodies (returning stale content for a same-named
   * skill, or a false "not found" for a skill that only exists at the new
   * cwd) even though `currentCwd` itself is correctly updated below. The
   * next `getPluginSkillBody()` call re-populates via a fresh
   * `discoverPluginSkillBodies()` scan against the new `currentCwd`.
   */
  setCwd(cwd: string): void {
    this.currentCwd = cwd;
    this.pluginBodies = null;
  }

  /**
   * Snapshot of the executor state the extracted per-strategy modules read
   * (`ctx` + `currentCwd`). Built fresh at each call site so `currentCwd`
   * reflects any intervening `setCwd()` re-anchor. See
   * {@link SkillExecutorInternals}.
   */
  private internals(): SkillExecutorInternals {
    return { ctx: this.ctx, currentCwd: this.currentCwd };
  }

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
        ...sessionIdentity(this.ctx),
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
    //    Only the getSkill LOOKUP is guarded: it throws "Skill not found" when
    //    the name isn't in the registry, which is the legitimate fall-through
    //    to plugin lookup. executeRegistrySkill() must run OUTSIDE the try so a
    //    genuine setup/execution failure (e.g. a forked/loaded skill throwing)
    //    propagates instead of being misrouted to plugin lookup and surfacing a
    //    misleading `Skill "<name>" not found`.
    let skill: ReturnType<typeof getSkill> | undefined;
    try {
      skill = getSkill(parsed.name);
    } catch {
      // not a registry skill — fall through to plugin lookup.
    }
    if (skill) {
      return await this.executeRegistrySkill(skill, parsed.arguments, call);
    }

    // 2. Try plugin skills (SKILL.md body). Default is in-context LOAD; a
    //    plugin skill forks a subagent ONLY when its frontmatter explicitly
    //    declares `context: fork`. The SKILL.md `context:` field is the single
    //    source of truth — there is no name-keyed override, so a `context: load`
    //    or absent field always loads, even for a copy that shadows a bundled
    //    skill. (History: the default was fork until 2026-06; flipped to load
    //    so authored skills act in-context by default. Isolation-critical
    //    bundled skills are pinned to `context: fork` in their own SKILL.md.
    //    See docs/skill-load-mode.md.)
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
        return await executePluginSkill(
          this.internals(),
          parsed.name,
          pluginSkill.body,
          pluginSkill.pluginPath,
          parsed.arguments,
          call,
          readOnly,
          pluginSkill.allowedTools,
          pluginSkill.model,
        );
      }
      // Default: in-context LOAD (2026-06 load-by-default flip). No readOnly —
      // loaded skills execute in the caller's context, not a restrictable child.
      // Expand PLUGIN_ROOT so shell commands in the body resolve to the plugin
      // dir. Handles `$PLUGIN_ROOT`, `${PLUGIN_ROOT}`, and the Claude-Code
      // portability idiom `${PLUGIN_ROOT:-<default>}` (default may hold one
      // nested `${...}`, e.g. `${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}`) — in AFK
      // PLUGIN_ROOT is always known so the whole reference collapses to
      // pluginPath. (Fork skills instead get PLUGIN_ROOT as a shell env var via
      // executePluginSkill, so the shell expands the `:-` fallback natively.)
      const bodyWithRoot = pluginSkill.body.replace(
        /\$\{PLUGIN_ROOT(?::-(?:[^{}]|\$\{[^{}]*\})*)?\}|\$PLUGIN_ROOT\b/g,
        () => pluginSkill.pluginPath,
      );
      return executeLoadedPluginSkill(
        this.internals(),
        parsed.name,
        bodyWithRoot,
        parsed.arguments,
        call,
      );
    }

    // 3. Not found — return available skills list. Resolve project skills
    // against the session cwd (worktree / daemon-task / Telegram-chat dir),
    // not the host process cwd — mirrors the manifest build in the provider.
    const entries = collectSkillEntries(
      this.ctx.pluginConfigs,
      this.currentCwd !== undefined ? { cwd: this.currentCwd } : undefined,
    );
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
      return executeForkedRegistrySkill(this.internals(), skill, args, call);
    }

    // If context is 'load', return the skill body for in-context execution by
    // the CURRENT agent — no fork, no handler call (see docs/skill-load-mode.md).
    if (skill.context === 'load') {
      return executeLoadedRegistrySkill(this.internals(), skill, args, call);
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
    // without this `skill.dispatched` row the 5 inline skills (mint, forge,
    // diagnose, audit-fit, score) are invisible to operator usage queries.
    // (skill-invocations.jsonl writer removed — routing-decisions.jsonl is the
    // canonical skill-usage source; see chore/deprecate-skill-invocations-writer.)
    const depth = this.ctx.depth ?? 0;
    void appendRoutingDecision({
      ...sessionIdentity(this.ctx),
      event: 'skill.dispatched',
      requested_name: skill.name,
      parent_session_id: this.ctx.parentSession.sessionId,
      depth,
      ...(isGateSkill(skill.name) ? { is_gate: true } : {}),
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
          // Forward the witness writer so inline handlers that fork their own
          // SubagentManager (e.g. /diagnose, /audit-fit) make the forked
          // sub-agents' tool activity AND permission-denials land in the
          // parent trace — see SkillExecutionContext.traceWriter.
          ...(this.ctx.traceWriter !== undefined
            ? { traceWriter: this.ctx.traceWriter }
            : {}),
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
        ...sessionIdentity(this.ctx),
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

  private getPluginSkillBody(name: string): PluginSkillBody | undefined {
    if (!this.pluginBodies) {
      this.pluginBodies = discoverPluginSkillBodies(
        this.ctx.pluginConfigs,
        this.currentCwd !== undefined ? { cwd: this.currentCwd } : undefined,
      );
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
