/**
 * Forked execution strategies for the `skill` tool.
 *
 * Extracted verbatim from `SkillExecutor` (#363): the two forked dispatch
 * paths — `executeForkedRegistrySkill` (registry skill with `context: fork`)
 * and `executePluginSkill` (plugin SKILL.md with `context: fork`) — plus
 * their shared fork → run → teardown driver `runForkedSkillToResult`. Free
 * functions receive {@link SkillExecutorInternals} in place of `this` —
 * read-only by contract. Permission wiring lives in `fork-child-config.ts`;
 * `$ARGUMENT` substitution comes from `load-mode.ts`.
 *
 * @module agent/tools/skill-executor/fork-dispatch
 */

import { SubagentManager } from '../../subagent.js';
import { resolveChildManagerReadRoots } from '../../subagent-read-scope.js';
import { annotateIfIncomplete } from '../../subagent/result.js';
import { appendInjectContext } from '../subagent/inject-context.js';
import type { ToolCall, ToolResult } from '../types.js';
import type { AgentConfig } from '../../types/config-types.js';
import { DEFAULT_READ_ONLY_SKILLS } from '../nesting.js';
import { applyParentCredentialFallback } from '../child-credential.js';
import { resolveCredentialForModel } from '../../auth/credential-resolver.js';
import { getCurrentSink } from '../../_lib/skill-sink-channel.js';
import { loadSkillPrompts } from '../../../skills/_lib/prompt-loader.js';
import { debugLog } from '../../../utils/debug.js';
import { buildForkedChildConfig } from './fork-child-config.js';
import { substituteSkillArgs } from './load-mode.js';
import type { SkillExecutorInternals } from './types.js';

export async function executeForkedRegistrySkill(
  internals: SkillExecutorInternals,
  skill: {
    name: string;
    context?: 'inline' | 'fork' | 'load';
    model?: string;
    readOnly?: boolean;
  },
  args: string | undefined,
  call: ToolCall,
): Promise<ToolResult> {
  const { ctx, currentCwd } = internals;
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
  // injection is required. `ctx.resolveApiKeyForModel` acts as an
  // optional override for callers that need a custom strategy (e.g. tests).
  const skillChildModel = skill.model ?? ctx.defaultSubagentModel ?? ctx.defaultModel ?? 'sonnet';
  const skillChildApiKey = applyParentCredentialFallback({
    childModel: skillChildModel,
    resolved: ctx.resolveApiKeyForModel
      ? ctx.resolveApiKeyForModel(skillChildModel)
      : resolveCredentialForModel(skillChildModel),
    parentApiKey: ctx.apiKey,
  });

  // Read-scope inheritance (#547): the skill-forked child's read scope ⊇ the
  // parent session's, mirroring the `agent` tool (subagent-executor.ts). Seed
  // parentReadRoots from the session scope + this fork's cwd; forkSubagent
  // folds in the worktree main root. Without it the fork derived read scope
  // from cwd alone and narrowed whenever the parent was read-open /
  // `/allow-dir`-widened. Writes stay confined to the worktree.
  const childReadRoots = resolveChildManagerReadRoots(ctx.getReadScopeInputs?.(), currentCwd);
  const manager = new SubagentManager({
    parentAbortSignal: call.signal,
    apiKey: skillChildApiKey,
    // `skillChildApiKey` was resolved for `skillChildModel`, so that model is
    // the provider source of truth for the fork-time credential fallback
    // (see SubagentManager.parentProvider).
    parentModel: skillChildModel,
    ...(ctx.baseUrl !== undefined ? { baseUrl: ctx.baseUrl } : {}),
    ...(ctx.traceWriter !== undefined ? { traceWriter: ctx.traceWriter } : {}),
    progressSink: getCurrentSink(),
    // Worktree isolation: this manager forks the skill subagent. cwd
    // forwarding here is what gives the skill subagent's bash/grep/file
    // tools the worktree anchor. Without it, every `/diagnose`, `/mint`,
    // etc. run their first-tier subagents against the host repo.
    ...(currentCwd !== undefined ? { cwd: currentCwd } : {}),
    // Read-scope inheritance (#547): see childReadRoots above.
    ...(childReadRoots !== undefined ? { parentReadRoots: childReadRoots } : {}),
  });

  // Thread traceWriter into the child's AgentConfig so its tool_use, hook,
  // and lifecycle events emit into the parent's trace. Without this,
  // SubagentManager.forkSubagent's emitSubagentLifecycle no-ops (it reads
  // options.config.traceWriter, not the manager's).
  const { childConfig, childManager } = buildForkedChildConfig(
    internals,
    {
      model: skillChildModel,
      systemPrompt,
      // Invariant: skill-dispatch sub-agents must not inherit the
      // SLASH_COMMAND_ROUTING_PROMPT paragraph. They receive a "Run the
      // <name> skill" directive with no <command-name> tag, so the routing
      // instruction (which keys off that tag) would push them to ask
      // "which skill?" instead of engaging with their SKILL.md body.
      isSkillDispatch: true,
      ...(ctx.traceWriter !== undefined ? { traceWriter: ctx.traceWriter } : {}),
    } as AgentConfig,
    call.signal,
    readOnly,
  );

  // Fork → run → teardown skeleton is shared with executePluginSkill via
  // runForkedSkillToResult (the setup above — model/credential resolution,
  // buildForkedChildConfig — is what differs between the two paths).
  return runForkedSkillToResult(internals, {
    manager,
    childManager,
    childConfig,
    label: skill.name,
    idPrefix: `skill-fork-${skill.name}`,
    parentId: call.id,
    args,
    noOutputError: 'Forked skill failed with no output',
    errorPrefix: 'Forked skill execution error',
  });
}

export async function executePluginSkill(
  internals: SkillExecutorInternals,
  skillName: string,
  body: string,
  pluginPath: string,
  args: string | undefined,
  call: ToolCall,
  // Read-only enforcement flag, computed at the call site from the plugin
  // body's `readOnly` frontmatter OR DEFAULT_READ_ONLY_SKILLS membership.
  readOnly = false,
  allowedTools?: string[],
  // Per-skill model override from the SKILL.md `model:` frontmatter field.
  // Threaded from `pluginSkill.model` at the call site (skill-executor.ts).
  model?: string,
): Promise<ToolResult> {
  const { ctx, currentCwd } = internals;
  if (call.signal.aborted) {
    return { content: 'Skill call aborted', isError: true };
  }

  // Resolve the plugin skill child's model first (same resolver pattern as
  // executeForkedRegistrySkill) so we can derive the correct credential.
  // The resolver is now available directly from the agent layer
  // (resolveCredentialForModel), so no injection is required.
  //
  // The SKILL.md `model:` override (`model`) wins over the session defaults —
  // mirroring the registry fork path (executeForkedRegistrySkill:72
  // `skill.model ?? ...`). Without the leading `model ??` term a plugin skill
  // pinned to e.g. `model: opus` was silently downgraded to the session
  // default subagent model.
  const pluginChildModel = model ?? ctx.defaultSubagentModel ?? ctx.defaultModel ?? 'sonnet';
  const pluginChildApiKey = applyParentCredentialFallback({
    childModel: pluginChildModel,
    resolved: ctx.resolveApiKeyForModel
      ? ctx.resolveApiKeyForModel(pluginChildModel)
      : resolveCredentialForModel(pluginChildModel),
    parentApiKey: ctx.apiKey,
  });

  // Read-scope inheritance (#547) — same rationale as executeForkedRegistrySkill.
  const childReadRoots = resolveChildManagerReadRoots(ctx.getReadScopeInputs?.(), currentCwd);
  const manager = new SubagentManager({
    parentAbortSignal: call.signal,
    apiKey: pluginChildApiKey,
    // `pluginChildApiKey` was resolved for `pluginChildModel`, so that model
    // is the provider source of truth for the fork-time credential fallback
    // (see SubagentManager.parentProvider).
    parentModel: pluginChildModel,
    ...(ctx.baseUrl !== undefined ? { baseUrl: ctx.baseUrl } : {}),
    ...(ctx.traceWriter !== undefined ? { traceWriter: ctx.traceWriter } : {}),
    progressSink: getCurrentSink(),
    // Worktree isolation — same rationale as executeForkedRegistrySkill above.
    ...(currentCwd !== undefined ? { cwd: currentCwd } : {}),
    // Read-scope inheritance (#547): see childReadRoots above.
    ...(childReadRoots !== undefined ? { parentReadRoots: childReadRoots } : {}),
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
  const baseAgentConfig: AgentConfig = {
    model: pluginChildModel,
    // Invariant: $ARGUMENT/$ARGUMENTS placeholders in the SKILL.md body are
    // substituted with the caller-supplied args before the fork is configured,
    // matching slash-command semantics SKILL.md authors expect.
    systemPrompt: substituteSkillArgs(body, args),
    env: { PLUGIN_ROOT: pluginPath },
    // Invariant: skill-dispatch sub-agents must not inherit the
    // SLASH_COMMAND_ROUTING_PROMPT paragraph. They receive a "Run the <name>
    // skill" directive with no <command-name> tag, so the routing instruction
    // (which keys off that tag) would push them to ask "which skill?" instead
    // of engaging with their SKILL.md body.
    isSkillDispatch: true,
    ...(ctx.traceWriter !== undefined ? { traceWriter: ctx.traceWriter } : {}),
  } as AgentConfig;

  // Invariant (single source of truth): allowedTools is threaded into
  // buildForkedChildConfig so the factory-built provider keeps
  // subagentExecutor / skillExecutor / readOnlyMemory / readOnlyBash intact
  // while applying the correct effective allowlist. No post-fork provider
  // override — buildForkedChildConfig is the only place permissions are set.
  const { childConfig, childManager } = buildForkedChildConfig(
    internals,
    baseAgentConfig,
    call.signal,
    readOnly,
    allowedTools,
  );

  // Fork → run → teardown skeleton is shared with executeForkedRegistrySkill
  // via runForkedSkillToResult (the setup above — model/credential
  // resolution, PLUGIN_ROOT + $ARGUMENT substitution — is plugin-specific).
  return runForkedSkillToResult(internals, {
    manager,
    childManager,
    childConfig,
    label: skillName,
    idPrefix: `skill-${skillName}`,
    parentId: call.id,
    args,
    noOutputError: 'Plugin skill failed with no output',
    errorPrefix: 'Plugin skill execution error',
  });
}

/**
 * Shared fork → run → teardown driver for the two forked-skill dispatch
 * paths (executeForkedRegistrySkill + executePluginSkill). Their SETUP
 * differs (model/credential resolution, buildForkedChildConfig arity, plugin
 * PLUGIN_ROOT + $ARGUMENT substitution) and stays per-caller; the identical
 * run/teardown skeleton lives here so it has one source of truth.
 *
 * Invariant: `handle` is declared OUTSIDE the try so the finally can call
 * `handle.teardown()` — the only path that runs `session.close()` →
 * `dispatchSessionEndOnce()` → `emitClosure()` + `sealTraceWriter()`.
 * `manager.teardownAll()` alone is NOT sufficient: a handle that completed a
 * run has already self-removed from `active` (subagent.ts:340-343,412-414),
 * so without an explicit `handle.teardown()` the child's traceWriter never
 * seals — blinding every closure-event-dependent improve detector.
 *
 * Invariant: in-turn SubagentStop delivery. SubagentStop fires from
 * `handle.teardown()` in the finally, before this resolves, so the stop
 * hook's injectContext (e.g. the shadow-verify nudge) rides THIS skill's
 * tool_result in-turn instead of the deferred queue. The completion
 * ToolResult is hoisted into `toolResult` and the note appended after
 * teardown. Exactly-once: `deferInjectContextToCaller` suppresses the queue
 * push for this stop.
 */
export async function runForkedSkillToResult(
  internals: SkillExecutorInternals,
  params: {
    manager: SubagentManager;
    childManager: SubagentManager | undefined;
    childConfig: AgentConfig;
    label: string;
    idPrefix: string;
    parentId: string;
    args: string | undefined;
    noOutputError: string;
    errorPrefix: string;
  },
): Promise<ToolResult> {
  const {
    manager,
    childManager,
    childConfig,
    label,
    idPrefix,
    parentId,
    args,
    noOutputError,
    errorPrefix,
  } = params;
  let handle: Awaited<ReturnType<typeof manager.forkSubagent>> | undefined;
  let toolResult: ToolResult | undefined;
  try {
    // `parentId` (the skill's call.id) anchors the synthesized `Agent(<label>)`
    // entry as a child of THIS skill's tool-lane entry rather than at root.
    // Mirrors `ComposeExecutor` (compose-executor.ts:227-232); paired with
    // `'skill'` in NESTING_TOOLS so the renderer recurses into the children.
    handle = await manager.forkSubagent({
      parent: internals.ctx.parentSession,
      config: childConfig,
      idPrefix,
      parentId,
      agentType: label,
    });

    // Invariant: name the skill explicitly. A bare "Run the skill." is
    // ambiguous — the sub-agent could ask the operator "which skill?" instead
    // of executing its own SKILL.md body. Naming it removes that ambiguity.
    const userMessage =
      args && args.length > 0
        ? args
        : `Run the ${label} skill now, following the instructions in your system prompt.`;
    const result = await handle.runToResult(userMessage);

    // Assign (don't return) so the finally can append the in-turn
    // SubagentStop injectContext after teardown.
    if (result.status === 'succeeded' && result.message) {
      // A `succeeded` result can still be an incomplete partial (capped or
      // stream-truncated). annotateIfIncomplete prepends a parent-visible
      // marker in that case and is a no-op for clean completions.
      toolResult = {
        content: annotateIfIncomplete(result.message.content, result.stopReason),
      };
      return toolResult;
    }

    // Cancelled mid-flight but produced text: surface the partial output with
    // a clear marker rather than discarding it.
    if (
      result.status === 'cancelled' &&
      typeof result.partialOutput === 'string' &&
      result.partialOutput.length > 0
    ) {
      const marker = '[skill cancelled mid-flight — partial output preserved below]';
      toolResult = { content: `${marker}\n\n${result.partialOutput}` };
      return toolResult;
    }

    const errorMessage = result.error?.message ?? noOutputError;
    toolResult = { content: errorMessage, isError: true };
    return toolResult;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: `${errorPrefix}: ${message}`, isError: true };
  } finally {
    // Order: per-handle teardown (seals child trace) → child manager (any
    // grandchildren) → outer manager (any siblings that never ran). Guard
    // against `forkSubagent` throwing before assignment (subagent.ts:316-320).
    if (handle) await handle.teardown({ deferInjectContextToCaller: true }).catch(debugLog);
    // In-turn append: only when this run produced a completion ToolResult.
    // The catch path leaves toolResult unset — nothing to append to, note
    // dropped for that stop by design (the error string is the signal).
    const injectContext = handle?.getLastStopInjectContext?.();
    appendInjectContext(toolResult, injectContext);
    await childManager?.teardownAll();
    await manager.teardownAll();
  }
}
