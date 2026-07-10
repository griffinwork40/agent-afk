/**
 * In-context ("load") execution strategy for the `skill` tool.
 *
 * Extracted verbatim from `SkillExecutor` (#363): the two load paths
 * (`executeLoadedRegistrySkill`, `executeLoadedPluginSkill`), their shared
 * framing/telemetry helpers (`formatLoadedSkillResult`, `emitLoadTelemetry`),
 * and `substituteSkillArgs` (also consumed by the forked plugin path in
 * `fork-dispatch.ts`). Free functions receive {@link SkillExecutorInternals}
 * in place of `this` — read-only by contract.
 *
 * @module agent/tools/skill-executor/load-mode
 */

import type { ToolCall, ToolResult } from '../types.js';
import { loadSkillPrompts } from '../../../skills/_lib/prompt-loader.js';
import { appendRoutingDecision } from '../../routing-telemetry.js';
import { isGateSkill, sessionIdentity } from './telemetry.js';
import type { SkillExecutorInternals } from './types.js';

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
export function formatLoadedSkillResult(
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
export function emitLoadTelemetry(
  internals: SkillExecutorInternals,
  name: string,
  contentChars: number,
  durationMs: number,
  model: string | undefined,
): void {
  const { ctx } = internals;
  const depth = ctx.depth ?? 0;
  const base = {
    ...sessionIdentity(ctx),
    requested_name: name,
    parent_session_id: ctx.parentSession.sessionId,
    depth,
    mode: 'load',
    ...(model !== undefined ? { model } : {}),
  };
  // `is_gate` rides only the `skill.dispatched` row — not the shared `base`,
  // which also feeds the `skill.completed` emit below. Matches the field doc
  // ("on skill.dispatched rows") and the fork path, keeping the gate flag on
  // a single canonical row across both dispatch paths.
  void appendRoutingDecision({
    event: 'skill.dispatched',
    ...base,
    ...(isGateSkill(name) ? { is_gate: true } : {}),
  }).catch(() => {});
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
export function executeLoadedRegistrySkill(
  internals: SkillExecutorInternals,
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
  const substituted = substituteSkillArgs(body, args);
  emitLoadTelemetry(internals, skill.name, substituted.length, Date.now() - startMs, skill.model);
  return formatLoadedSkillResult(skill.name, substituted, args);
}

/**
 * Load path for a plugin skill whose SKILL.md frontmatter declares
 * `context: load`. Substitutes args into the body and returns it framed for
 * in-context execution. Never forks; `$PLUGIN_ROOT` / `\${PLUGIN_ROOT}` placeholders
 * are expanded to the plugin's install path at the call site before this method
 * receives the body, so shell commands that reference the plugin directory
 * resolve correctly when the current agent executes them.
 */
export function executeLoadedPluginSkill(
  internals: SkillExecutorInternals,
  skillName: string,
  body: string,
  args: string | undefined,
  call: ToolCall,
): ToolResult {
  if (call.signal.aborted) {
    return { content: 'Skill call aborted', isError: true };
  }
  const startMs = Date.now();
  const substituted = substituteSkillArgs(body, args);
  emitLoadTelemetry(internals, skillName, substituted.length, Date.now() - startMs, undefined);
  return formatLoadedSkillResult(skillName, substituted, args);
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
export function substituteSkillArgs(body: string, args: string | undefined): string {
  const replacement = args ?? '';
  return body.replace(/\$ARGUMENTS?\b/g, () => replacement);
}
