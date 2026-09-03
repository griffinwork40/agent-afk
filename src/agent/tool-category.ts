/**
 * Tool-category taxonomy — pure classification logic.
 *
 * Tool-use chunks arriving from the SDK only carry a flat `content` string
 * (see ToolUseChunk in src/agent/types/message-types.ts). The leading
 * identifier in that string is the tool name. We bucket tool names into
 * ten semantic categories. Downstream consumers map categories to visuals:
 *
 *   - The CLI renderer attaches color + glyph metadata
 *     (`src/cli/tool-category.ts` re-exports + extends this module).
 *   - The session phase reducer maps categories to operator-visible phases
 *     (`src/agent/session/phase-reducer.ts`).
 *
 * Two name conventions show up in the stream:
 *   - PascalCase Anthropic-SDK names: `Read`, `Write`, `Bash`, `Agent`, ...
 *   - snake_case agent-afk built-in tool names from src/agent/tools/schemas.ts
 *     and src/agent/memory/memory-tools.ts:
 *     `read_file`, `extract_document`, `write_file`, `edit_file`, `bash`,
 *     `agent`, `skill`, `compose`, `send_telegram`, `web_scrape`, `glob`,
 *     `grep`, `list_directory`,
 *     `memory_search`, `memory_update`, `procedure_write`,
 *     `create_schedule`, `list_schedules`, `get_schedule_history`, `cancel_schedule`,
 *     `terminal_font_size`, `config_get`, `config_set`.
 * Both sets are enumerated explicitly to avoid silent fall-through to `other`.
 *
 * This file lives under `src/agent/` because tool-name classification is
 * provider-protocol concern — it does not depend on any rendering surface.
 * Keeping it in the agent layer means the phase reducer (and any other
 * non-CLI consumer) can categorize tools without reaching upward into the
 * CLI module.
 *
 * @module agent/tool-category
 */

// Import + re-export from the provider-boundary type so both layers share the
// same definition without introducing a layering inversion.
import type { ToolCategory } from './providers/anthropic-direct/types.js';
// Read-only, in-memory introspection (get_runtime_state). Imported from the leaf
// `./awareness/tool.js` rather than the `./awareness/index.js` barrel so the
// eval-time spread into READ_ONLY_PHASE_TOOLS below cannot form an ESM init cycle
// (tool.js's only runtime dep is the type-only runtime-snapshot.js leaf).
import { AWARENESS_TOOL_NAMES } from './awareness/tool.js';
export type { ToolCategory };

const READ_TOOLS = new Set([
  // Anthropic SDK PascalCase
  'Read', 'Glob', 'Grep', 'NotebookRead', 'LS',
  // agent-afk built-in snake_case (src/agent/tools/schemas.ts)
  'read_file', 'extract_document', 'glob', 'grep', 'list_directory',
  // config_get reads ~/.afk/config (afk.env / afk.config.json); secrets are
  // masked by the handler. Read-only by construction — no mutation surface.
  'config_get',
  // memory-tools.ts — read-only query against the fact archive.
  // Also classed read-only in the dispatcher's SAFE_TOOLS concurrency set
  // (src/agent/tools/dispatcher.ts:31).
  'memory_search',
  // workspace-tools.ts — read-only query against the ephemeral per-session
  // workspace. Mirrors memory_search in classification.
  'workspace_query',
  // witness-layer search: read-only scan of trace.jsonl files.
  'read_witness', 'search_witness',
  // get_facet — read-only: derives or loads the session facet sidecar; no
  // mutation surface. Schema declares category='read'; this entry makes
  // categorizeTool() agree so the schema-as-source-of-truth test passes.
  'get_facet',
  // json_query — read-only: reads a JSON file and evaluates a bounded query.
  'json_query',
]);
const WRITE_TOOLS = new Set([
  'Write', 'Edit', 'NotebookEdit', 'MultiEdit',
  'write_file', 'edit_file',
  // patch_apply atomically writes structured multi-file changes to disk.
  'patch_apply',
  // memory-tools.ts — both mutate persistent state on disk (the fact
  // archive / HOT.md and ~/.afk/procedures/<name>.md respectively), so
  // they belong in the write bucket alongside file edits.
  'memory_update', 'procedure_write',
  // Mutates VS Code / Cursor settings.json files on disk.
  'terminal_font_size',
  // Mutates ~/.afk/config/{afk.env,afk.config.json}. WRITE classification is
  // load-bearing: it makes config_set plan-mode-blocked (excluded from
  // READ_ONLY_PHASE_TOOLS) and sequential (not concurrency-safe).
  'config_set',
  // workspace-tools.ts — workspace_publish mutates ephemeral per-session
  // state that influences sibling-agent system prompts.
  'workspace_publish',
]);
// These categorization sets intentionally list BOTH the Claude Code / SDK
// PascalCase tool names (Bash, Agent, Task, Skill, Compose) and AFK's lowercase
// runtime names (bash, agent, skill, compose). They drive display/categorization
// only (e.g. TUI lane routing) and match a tool call in EITHER namespace — the
// PascalCase entries are NOT evidence that AFK dispatches PascalCase tools; AFK
// dispatches only the lowercase names.
const SHELL_TOOLS = new Set([
  'Bash', 'BashOutput', 'KillBash',
  'bash',
  // test_run discovers and spawns test runners via child_process.
  'test_run',
  'wait_for',
]);
export const SUBAGENT_TOOLS = new Set([
  'Agent', 'Task',
  'agent', 'cancel_background_job',
]);
export const SKILL_TOOLS = new Set([
  'Skill',
  'skill',
]);
export const DAG_TOOLS = new Set([
  'Compose',
  'compose',
]);

/**
 * Tools that own nested children in the tool-lane overlay. Union of
 * `SUBAGENT_TOOLS` (single-dispatch — `Agent`, `Task`, `agent`),
 * `DAG_TOOLS` (multi-dispatch — `compose`), and `SKILL_TOOLS` (skill
 * dispatcher — forks a child subagent that runs the skill body and emits
 * its own events). Renderer code that decides "does this entry get an
 * indented children block?" gates on this set rather than on either
 * subset alone, so future dispatch tools can opt into the same visual
 * treatment by joining one of the contributing sets.
 *
 * Why `SKILL_TOOLS` is here: `SkillExecutor` forks a child subagent via
 * `SubagentManager.forkSubagent` and threads `parentId: call.id` so the
 * synthesized `Agent(<label>)` entry resolves to path 2 in
 * `StreamRenderer.process()` and nests under the skill entry. That nesting
 * is invisible to the user unless the renderer also treats the skill entry
 * as a nesting parent — exactly what this set does. Same contract
 * `ComposeExecutor` already honors with `compose`.
 */
export const NESTING_TOOLS = new Set<string>([...SUBAGENT_TOOLS, ...DAG_TOOLS, ...SKILL_TOOLS]);
const WEB_TOOLS = new Set([
  'WebFetch', 'WebSearch',
  // send_telegram is an outbound HTTP call to a third-party API —
  // same conceptual shape as a web fetch, so it shares the web bucket.
  'send_telegram',
  // agent-afk's native web tools.
  'web_scrape',
  // web_request: structured HTTP tool (all methods, SSRF-guarded, #1413).
  'web_request',
]);
const BROWSER_TOOLS = new Set([
  // agent-afk native browser-control tools (src/browser/, src/agent/tools/handlers/browser-*.ts).
  // Distinct from WEB_TOOLS because browser tools drive a stateful headed
  // session (cookies, history, DOM) rather than issuing a single HTTP request.
  'browser_open',
  'browser_observe',
  'browser_act',
  'browser_screenshot',
  'browser_extract',
  'browser_close',
]);
const PLANNING_TOOLS = new Set([
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'TaskOutput',
  'TaskStop',
  'EnterPlanMode',
  'ExitPlanMode',
  'ToolSearch',
]);

const SCHEDULE_TOOLS = new Set([
  // agent-afk daemon lifecycle tools (src/agent/tools/schemas.ts).
  // Previously fell through to 'other' — now classified explicitly.
  'create_schedule',
  'list_schedules',
  'get_schedule_history',
  'cancel_schedule',
]);

function hasCI(set: Set<string>, name: string): boolean {
  if (set.has(name)) return true;
  const cap = name.charAt(0).toUpperCase() + name.slice(1);
  return cap !== name && set.has(cap);
}

// Invariant: this list is the SOLE source of truth for "tools that may run
// during a read-only orchestration phase" (mint spec/research/plan, and any
// future skill phases that take the same posture).
//
// Consumed by `SubagentManager.forkSubagent` when `phaseRole: 'read-only'` is
// set: the manager constructs a phase-restricted provider whose `permissions`
// field is `{ allowedTools: READ_ONLY_PHASE_TOOLS }`. That permissions object
// is then consumed by `SessionToolDispatcher.checkToolPermission` (the actual
// enforcement gate at `src/agent/tools/dispatcher.ts:348`).
//
// Membership rule: any tool whose handler MUST NOT mutate the repo, spawn
// subagents, send outbound network traffic, or otherwise produce a
// side-effect that survives the phase. This is the `READ_TOOLS` set plus the
// always-on awareness introspection tools (AWARENESS_TOOL_NAMES) and
// `workspace_publish` — kept narrow because the post-spec approval gate is the
// user's chance to stop wrong work BEFORE writes happen. Awareness qualifies:
// get_runtime_state is a pure in-memory read with zero side-effects, and
// excluding it left phase-restricted forks (mint spec/research/plan) staring at
// a tool the schema offered but the allowlist rejected.
//
// `workspace_publish` qualifies for the SAME reason, despite being categorized
// WRITE above: the two classifications answer different questions. The
// READ/WRITE buckets ask "does this mutate state?" (yes — the shared workspace),
// while this list asks "may this run before the approval gate?". Nothing the
// workspace holds survives the phase: the store is per-root-session and
// in-memory, closed when the session ends (provider-runtime.ts:238), so a
// publish cannot touch the repo, the fact archive, or any file on disk. It is
// admitted so mint's read-only spec/research/plan phases can seed findings for
// their siblings instead of seeing the tool in their schema (provider-schemas.ts
// registers it for every session) and being denied at the permission gate.
//
// Explicitly NOT included (and the failure mode if they were):
//   - `write_file`, `edit_file` — file mutation before approval
//   - `bash` — arbitrary write-intent shell, including `git commit`/`git push`
//   - `agent`, `skill`, `compose` — dispatch grandchildren with full tool
//     access (they go through `createChildProviderFactory` which uses
//     `CHILD_ALLOWED_TOOLS`, NOT this list)
//   - `memory_update`, `procedure_write` — persistent state mutation
//   - `send_telegram`, `web_scrape` — outbound network (exfiltration surface)
//   - `terminal_font_size` — settings.json mutation
//   - `config_set` — mutates ~/.afk/config before approval (config_get IS allowed)
//   - schedule tools — launchd job mutation
//
// Both PascalCase (Anthropic SDK subprocess path) and snake_case (AFK
// direct-provider path) names are included defensively. The direct
// providers only ever see snake_case names, but the PascalCase entries
// are harmless extras and keep the contract identical if AFK ever runs
// against the SDK subprocess again.
export const READ_ONLY_PHASE_TOOLS: readonly string[] = [
  // Anthropic SDK PascalCase
  'Read',
  'Glob',
  'Grep',
  'NotebookRead',
  'LS',
  // agent-afk snake_case (src/agent/tools/schemas.ts)
  'read_file',
  'extract_document',
  'glob',
  'grep',
  'list_directory',
  // config_get — masked read of ~/.afk/config; no mutation surface.
  'config_get',
  // Memory query — read-only by construction (no mutation surface).
  'memory_search',
  // Witness-layer search — read-only NDJSON scan of trace.jsonl files.
  'read_witness', 'search_witness',
  // Shared workspace publish — EPHEMERAL per-root-session state, not persistent
  // like memory. Deliberately admitted despite its WRITE categorization above;
  // see the membership-rule note in this block's header for why the two
  // classifications diverge here. Mirrors CHILD_ALLOWED_TOOLS /
  // RECON_ALLOWED_TOOLS (nesting.ts), which admit it for the same reason.
  'workspace_publish',
  // Shared workspace query — read-only poll of the ephemeral workspace.
  // Trivially qualifies: pure read, no mutation, no side-effects.
  'workspace_query',
  // json_query — read-only: reads a JSON file and evaluates a bounded query.
  'json_query',
  // Awareness introspection (get_runtime_state) — read-only, in-memory, zero
  // side-effects. Mirrors CHILD_ALLOWED_TOOLS (nesting.ts), which already appends
  // these. Single source of truth: AWARENESS_TOOL_NAMES (awareness/tool.ts).
  ...AWARENESS_TOOL_NAMES,
];

/**
 * Tool surface for which a zero-output stream cut may safely re-run the full
 * child prompt. This is deliberately separate from READ_ONLY_PHASE_TOOLS:
 * retry authorization permits read-only network fetches and a mechanically
 * scoped nested-agent dispatch, while the pre-approval phase gate excludes
 * both capabilities for its stricter exfiltration/delegation contract.
 *
 * `bash` is intentionally absent. Its read-only classifier is best-effort and
 * therefore cannot prove that replaying a command is free of side effects.
 *
 * `web_scrape` is admitted with one accepted cost: its `search` mode POSTs to a
 * metered third-party API on a keyed account (`web/search.ts`), so a replay
 * double-charges that quota. Accepted — a bounded second query, not persistent
 * state. Its `raw`/`markdown` modes are plain GETs and carry no such cost.
 *
 * Membership is NECESSARY BUT NOT SUFFICIENT. `agent` is admitted here on the
 * strength of scoped grants only; the scoping itself is enforced by
 * `isChildReplaySafe` (`tools/subagent/retry-safety.ts`), which rejects an
 * unscoped grant. Never authorize a replay from this set alone.
 */
export const STREAM_CUT_RETRY_SAFE_TOOLS: readonly string[] = [
  ...READ_ONLY_PHASE_TOOLS,
  'web_scrape',
  'agent',
];

export function categorizeTool(name: string): ToolCategory {
  if (name.startsWith('mcp__') || name.startsWith('MCP__')) return 'mcp';
  if (hasCI(READ_TOOLS, name)) return 'read';
  if (hasCI(WRITE_TOOLS, name)) return 'write';
  if (hasCI(SHELL_TOOLS, name)) return 'shell';
  if (hasCI(SUBAGENT_TOOLS, name)) return 'subagent';
  if (hasCI(SKILL_TOOLS, name)) return 'skill';
  if (hasCI(DAG_TOOLS, name)) return 'dag';
  if (hasCI(WEB_TOOLS, name)) return 'web';
  if (BROWSER_TOOLS.has(name)) return 'browser';
  if (hasCI(PLANNING_TOOLS, name)) return 'planning';
  if (SCHEDULE_TOOLS.has(name)) return 'schedule';
  return 'other';
}

/**
 * Categories that represent "this call dispatches more work" rather than a
 * direct tool invocation. The tool-lane renderer appends a dim bracketed
 * tag (`[worker]`, `[skill]`, `[workflow]`) to entries in these categories so
 * the dispatch class is legible as text alongside the glyph + color cues —
 * survives monochrome terminals and makes the taxonomy self-documenting in
 * the stream.
 *
 * Invariant: tag values are plain-language words, not internal jargon. The
 * scrollback transcript is routinely read by non-technical observers, so
 * `subagent` renders as `worker` and `dag` as `workflow` — an everyday reader
 * should never need to know what a DAG is to follow the activity feed. The
 * category KEYS stay canonical (`subagent`/`skill`/`dag`); only the
 * user-facing tag text is humanized here, at the single owning map.
 */
const DISPATCH_CATEGORIES: Partial<Record<ToolCategory, string>> = {
  subagent: 'worker',
  skill: 'skill',
  dag: 'workflow',
};

export function dispatchTagForCategory(cat: ToolCategory): string | undefined {
  return DISPATCH_CATEGORIES[cat];
}
