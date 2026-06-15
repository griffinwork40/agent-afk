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
 *     `read_file`, `write_file`, `edit_file`, `bash`, `agent`, `skill`,
 *     `compose`, `send_telegram`, `web_scrape`, `glob`, `grep`, `list_directory`,
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
  'read_file', 'glob', 'grep', 'list_directory',
  // config_get reads ~/.afk/config (afk.env / afk.config.json); secrets are
  // masked by the handler. Read-only by construction — no mutation surface.
  'config_get',
  // memory-tools.ts — read-only query against the fact archive.
  // Also classed read-only in the dispatcher's SAFE_TOOLS concurrency set
  // (src/agent/tools/dispatcher.ts:31).
  'memory_search',
]);
const WRITE_TOOLS = new Set([
  'Write', 'Edit', 'NotebookEdit', 'MultiEdit',
  'write_file', 'edit_file',
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
]);
const SHELL_TOOLS = new Set([
  'Bash', 'BashOutput', 'KillBash',
  'bash',
]);
export const SUBAGENT_TOOLS = new Set([
  'Agent', 'Task',
  'agent',
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
  // agent-afk's native web tool (local Readability/Turndown scrape + Exa search, plus raw GET).
  'web_scrape',
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
// always-on awareness introspection tools (AWARENESS_TOOL_NAMES) — kept narrow
// because the post-spec approval gate is the user's chance to stop wrong work
// BEFORE writes happen. Awareness qualifies: get_runtime_state is a pure
// in-memory read with zero side-effects, and excluding it left phase-restricted
// forks (mint spec/research/plan) staring at a tool the schema offered but the
// allowlist rejected.
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
  'glob',
  'grep',
  'list_directory',
  // config_get — masked read of ~/.afk/config; no mutation surface.
  'config_get',
  // Memory query — read-only by construction (no mutation surface).
  'memory_search',
  // Awareness introspection (get_runtime_state) — read-only, in-memory, zero
  // side-effects. Mirrors CHILD_ALLOWED_TOOLS (nesting.ts), which already appends
  // these. Single source of truth: AWARENESS_TOOL_NAMES (awareness/tool.ts).
  ...AWARENESS_TOOL_NAMES,
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
 * tag (`[subagent]`, `[skill]`, `[dag]`) to entries in these categories so
 * the dispatch class is legible as text alongside the glyph + color cues —
 * survives monochrome terminals and makes the taxonomy self-documenting in
 * the stream.
 */
const DISPATCH_CATEGORIES: Partial<Record<ToolCategory, string>> = {
  subagent: 'subagent',
  skill: 'skill',
  dag: 'dag',
};

export function dispatchTagForCategory(cat: ToolCategory): string | undefined {
  return DISPATCH_CATEGORIES[cat];
}
