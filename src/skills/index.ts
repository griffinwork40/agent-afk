/**
 * Skill registry and metadata.
 *
 * Provides SkillMetadata interface and registration functions for discovered skills.
 * Keeps registry under ~100 LOC. If metadata accumulates beyond ~50 LOC,
 * future skills split to src/skills/_lib/registry.ts with barrel re-export.
 */

import type { AgentModelInput, IAgentSession } from '../agent/types.js';
import type { TraceWriter } from '../agent/trace/index.js';

/**
 * Execution context handed to inline-registry skill handlers by the
 * SkillExecutor. Carries credentials and default-model hints so handlers can
 * fork sub-agents with the same auth the parent session uses.
 *
 * Optional in the handler signature — existing handlers that ignore it keep
 * working. Handlers that fork sub-agents should forward `apiKey` to
 * `new SubagentManager({ apiKey })` to avoid the "anthropic-direct provider
 * requires config.apiKey" error when AFK auth comes from a non-env source
 * (e.g. macOS keychain OAuth).
 */
export interface SkillExecutionContext {
  /** API key or OAuth token resolved by the parent session. */
  apiKey?: string;
  /** Default model for the parent session (advisory). */
  defaultModel?: AgentModelInput;
  /** Default model for forked sub-agents (advisory). */
  defaultSubagentModel?: AgentModelInput;
  /**
   * The tool-use ID of the `skill` ToolCall that invoked this handler. When
   * present, inline-handler implementations SHOULD forward it as
   * `parentId: callId` on every `manager.forkSubagent(...)` call they make,
   * so the stream-renderer can nest the forked subagent's synthetic
   * `Agent(<label>)` entry under the skill's tool-lane entry instead of
   * orphaning it at root.
   *
   * Without this, regular subagents forked from an inline skill handler land
   * at the lane root the moment they emit their first event (because
   * `meta.parentId` falls back to the parent's raw session UUID, which the
   * renderer's Path 3 cannot resolve to a tool-lane entry — see
   * stream-renderer.ts:262-280). The Agent header looks fine in the LIVE
   * overlay because `agentContext` propagation hides the orphan, but on Done
   * the scrollback block lands at root indent — the visible artifact.
   *
   * Optional: callers must handle `undefined` (older SkillExecutor versions
   * or test stubs may not provide it). In `undefined` mode the historical
   * behavior is preserved (`parentId` defaults to `parent.sessionId` inside
   * `SubagentManager.forkSubagent`).
   */
  callId?: string;
  /**
   * Dispatch another skill by name from inside a handler. Resolves through
   * the same registry → plugin-body lookup the `skill` tool uses, so plugin
   * skills (e.g. `shadow-verify`) are reachable from built-in TS handlers.
   *
   * Returns the skill's text output on success. Throws an `Error` whose
   * message is the dispatch error or the skill's `isError: true` content —
   * callers can catch and degrade gracefully.
   *
   * Optional: callers must handle `undefined` (older SkillExecutor versions
   * or test stubs may not provide it). Nesting depth is enforced by the
   * underlying SkillExecutor; dispatch failures from a depth refusal surface
   * as throws.
   */
  dispatchSkill?: (name: string, args?: string) => Promise<string>;
  /**
   * The parent session's witness trace writer, when one is open. Inline
   * handlers that fork sub-agents via their OWN `new SubagentManager(...)`
   * MUST forward this so the forked sub-agents inherit the writer and their
   * tool activity — including `canUseTool` permission-denials, emitted as
   * `hook_decision` block + `tool_call` (failureClass: 'permission-denied')
   * events — lands in the parent's `trace.jsonl`. Without it the child
   * dispatcher's `traceWriter` is undefined and every `emitHookDecision` /
   * `emitToolCall` no-ops, so the denials a restrictive allowlist produces are
   * visible only in the live TUI and are lost from the durable witness record
   * (and therefore from the run receipt's refusal tally).
   *
   * Optional: callers must handle `undefined` (tracing disabled via
   * `AFK_TRACE_DISABLED=1`, or older SkillExecutor versions / test stubs that
   * do not provide it). In that case forking proceeds untraced, as before.
   */
  traceWriter?: TraceWriter;
}

export interface SkillMetadata {
  name: string;
  description: string;
  handler: (
    input: unknown,
    parentSession?: IAgentSession,
    ctx?: SkillExecutionContext,
  ) => Promise<unknown>;
  /** Short hint shown alongside the skill name in the manifest, e.g. "<plan>". */
  argumentHint?: string;
  /** When the model should reach for this skill — surfaced in the skill manifest. */
  whenToUse?: string;
  /** Per-skill model override (advisory; honored where supported). */
  model?: string;
  /**
   * Execution context (default `'inline'`):
   * - `'inline'` — call the handler directly in-process (TS orchestrators).
   * - `'fork'` — route through a subagent fork using the skill's
   *   `prompts/system.md` (delegation; isolated child context).
   * - `'load'` — load `prompts/system.md` (or {@link loadBody}, when set) into
   *   the CURRENT session as the tool result; the calling agent executes it
   *   with its existing tools (progressive disclosure; no fork). See
   *   docs/skill-load-mode.md.
   */
  context?: 'inline' | 'fork' | 'load';
  /**
   * In-context body for `context: 'load'` skills whose body does NOT live at
   * the built-in `src/skills/<name>/prompts/system.md` convention — i.e.
   * disk-scanned user/project skills, whose body is the SKILL.md content.
   *
   * When set, {@link SkillExecutor.executeLoadedRegistrySkill} returns this
   * string (after `$ARGUMENT(S)` substitution) instead of calling
   * `loadSkillPrompts(name)`. Built-in load skills leave it unset and keep
   * resolving their body from the prompts/ directory. `${SKILL_ROOT}` /
   * `$SKILL_ROOT` placeholders MUST already be expanded by the registrant,
   * because load mode runs in the current agent (no subagent env injection).
   */
  loadBody?: string;
  /** Where the skill came from. Absent or 'builtin' = vendored TS skill; 'user' = scanned from ~/.afk/skills/; 'project' = scanned from <cwd>/.afk/skills/; `imported:<binary>` = live-read from a trusted source binary's skills dir (e.g. `imported:claude-code`) via `importFrom`. Plugin skills don't enter this registry. */
  origin?: 'builtin' | 'user' | 'project' | `imported:${string}`;
  /** Long-form CLI flags this skill accepts (e.g. ['--auto', '--ship']). Surfaces in tab completion and `/help`. */
  flags?: readonly string[];
  /**
   * Read-only enforcement flag (default absent → read-write). When `true`, a
   * forked subagent for this skill (`context: 'fork'`) is built with the
   * RECON tool allowlist (no `write_file`/`edit_file`) and a mutating-bash
   * guard. A skill is ALSO treated read-only when its name is in
   * `DEFAULT_READ_ONLY_SKILLS` (nesting.ts) regardless of this flag — keying
   * on name protects users running any copy of the SKILL.md.
   */
  readOnly?: boolean;
  /**
   * Public/internal tier gate.
   *
   * Invariant: skills tagged 'internal' are filtered from end-user surfaces
   * (slash-command list, `--help`, tab-complete, system-prompt skill manifest)
   * unless the runtime tier is unlocked via `AFK_INTERNAL=1`. Internal-tagged
   * skills remain dispatchable via `getSkill()` from internal code paths even
   * when filtered — the gate is on surfacing, not on the registry itself.
   *
   * Absent or 'public' = visible to everyone (default). 'internal' = hidden
   * unless the maintainer opts in. Use 'internal' for maintainer-loop skills
   * (forge, audit-fit), scaffolding templates (example-template), and any
   * skill whose normal operation depends on private plugin infrastructure
   * the end user does not have installed.
   */
  audience?: 'public' | 'internal';
}

/**
 * Test whether a registered skill should be visible at end-user surfaces
 * given the current runtime tier.
 *
 * Returns true when the skill is public-audience (or absent — public is the
 * default) OR when `internalUnlocked` is true. Returns false only when the
 * skill is explicitly tagged 'internal' AND the runtime tier is locked.
 *
 * Callers wire `internalUnlocked` from `env.AFK_INTERNAL === '1'` at the
 * surfacing boundary (slash-command registrar, system-prompt manifest
 * builder). Centralising the check here keeps the gate semantics single-
 * sourced — if the policy ever changes (e.g. config-file flag instead of
 * env var) only this function moves.
 */
export function isSkillVisible(
  skill: Pick<SkillMetadata, 'audience'>,
  internalUnlocked: boolean,
): boolean {
  if (internalUnlocked) return true;
  return (skill.audience ?? 'public') === 'public';
}

const registry = new Map<string, SkillMetadata>();

/**
 * Register a skill in the global registry.
 */
export function registerSkill(meta: SkillMetadata): void {
  registry.set(meta.name, meta);
}

/**
 * Get a registered skill by name.
 * @throws Error if skill not found, with list of available skills
 */
export function getSkill(name: string): SkillMetadata {
  const skill = registry.get(name);
  if (skill) {
    return skill;
  }

  const available = Array.from(registry.keys()).sort();
  const availableMsg = available.length > 0 ? `\nAvailable skills: ${available.join(', ')}` : '';
  throw new Error(`Skill not found: ${name}${availableMsg}`);
}

/**
 * List all registered skill names.
 */
export function listSkills(): string[] {
  return Array.from(registry.keys()).sort();
}

/**
 * List registered skill names visible at end-user surfaces given the current
 * runtime tier.
 *
 * Centralises the audience gate so all surfacing call sites (slash-command
 * listing, detail lookup, loading tips, tab-complete) share one filtered
 * accessor rather than each inlining the isSkillVisible() predicate.
 *
 * Pass `internalUnlocked = env.AFK_INTERNAL === '1'` at the call site so the
 * env-var read is always live (matches the lazy-getter contract in env.ts).
 */
export function listVisibleSkills(internalUnlocked: boolean): string[] {
  return listSkills().filter((name) => isSkillVisible(getSkill(name), internalUnlocked));
}

/**
 * Internal: reset registry for testing.
 * Marked with underscore to indicate test-only usage.
 */
export function _resetRegistry(): void {
  registry.clear();
}
