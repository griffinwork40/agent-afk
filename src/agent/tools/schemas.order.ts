/**
 * Stable tool-list ordering helpers for prefix-cache reuse (#4198).
 *
 * The assembled `schemas[]` array sent to the model is partitioned into four
 * deterministic segments so that removing any optional tool from its segment
 * never shifts tools in an earlier segment:
 *
 *   1. Invariant core builtins  (fixed order; present in every session by
 *      default, though individually disableable via tools.disabled)
 *   2. Optional/disableable builtins (tail of builtinToolSchemas; may be
 *      absent due to toolGroups(), surface filtering, or registry filtering)
 *   3. MCP tools sorted by name (deterministic across connection orders)
 *   4. plan-exit tool (always last when present)
 *
 * Invariant: every tool in the core segment (indices 0..INVARIANT_CORE_COUNT-1)
 * must NOT appear in any toolGroups() group, NOT be surface-filtered (e.g.
 * ask_question / terminal_font_size / clipboard_*), NOT be registry-filtered
 * (e.g. cancel_background_job / send_message_to_agent /
 * get_background_job_health are removed by filterBackgroundToolDefs when no
 * background registry is wired), and NOT be send_telegram (tail by
 * convention). A test in schemas.test.ts mechanically enforces this boundary.
 *
 * `INVARIANT_CORE_COUNT` pins how many leading entries of `builtinToolSchemas`
 * are invariant. A test asserts this value equals the actual count of tools
 * that appear before the first optional tool in the array.
 *
 * `sortMcpSchemas()` is the single sort contract shared by both providers so
 * they cannot drift. Using plain `<` comparison (lexicographic, locale-
 * independent) keeps the order stable across machines and Node versions.
 *
 * @module agent/tools/schemas.order
 */

import type { AnthropicToolDef } from './types.js';

/**
 * Number of leading entries in `builtinToolSchemas` that form the invariant
 * core segment.
 *
 * Contract: the core segment = builtins not in any toolGroups() group, not
 * surface-filtered (ask_question / terminal_font_size / clipboard_read /
 * clipboard_write are dropped on some surfaces), not registry-filtered
 * (cancel_background_job / send_message_to_agent / get_background_job_health
 * are removed by filterBackgroundToolDefs when no background registry is
 * wired), and not send_telegram (placed in the optional tail by convention).
 * These tools appear before any optional tool so that two sessions differing
 * only in which optional tools are enabled produce a byte-identical serialized
 * prefix for all core tools, maximising prefix-cache reuse.
 *
 * The first six entries are the LOCKED_TOOLS builtins:
 *   read_file, write_file, edit_file, grep, glob, list_directory
 * LOCKED_TOOLS (operator-denied.ts) guarantees these can never be disabled by
 * operator config, so they form the maximal guaranteed-stable prefix head.
 *
 * The remaining 17 core tools (indices 6..22) are individually disableable via
 * tools.disabled / tools.disabledBySlot. Disabling any one truncates the
 * shared prefix at that tool's index. What is invariant by default (absent any
 * disable config) is the membership and order of all 23 core tools.
 *
 * Core tools (indices 0..INVARIANT_CORE_COUNT-1):
 *   read_file, write_file, edit_file, grep, glob, list_directory,  <- LOCKED
 *   bash, view_image, extract_document,
 *   wait_for, patch_apply, test_run, get_facet, json_query, model_complete,
 *   worktree, config_get, config_set,
 *   read_witness, search_witness,
 *   remote_agent, web_scrape, web_request
 *
 * Decision notes:
 *   - `web_scrape` / `web_request`: not in any disable group; no surface filter
 *     removes them; placed in core.
 *   - `worktree` / `config_get` / `config_set`: not in any disable group.
 *   - `remote_agent`: not in any disable group.
 *   - `cancel_background_job`, `send_message_to_agent`,
 *     `get_background_job_health`: removed by filterBackgroundToolDefs when no
 *     background registry is wired — they cannot be in the invariant core.
 *     Placed at the head of the optional tail instead.
 *   - `gitReadTool` is opt-in (AFK_READONLY_GIT_TOOL flag) and lives in
 *     ALL_TOOL_SCHEMAS but not builtinToolSchemas, so it is NOT counted here.
 *   - Nesting tools (agentTool, skillTool, composeTool) are NOT in
 *     builtinToolSchemas; they are appended conditionally at provider-
 *     construction time and placed after ALL builtins. They do not affect the
 *     core prefix of builtinToolSchemas itself.
 *
 * Optional tail (indices INVARIANT_CORE_COUNT..44):
 *   cancel_background_job, send_message_to_agent, get_background_job_health,
 *   send_telegram,
 *   image_generate, image_edit,
 *   create_schedule, update_schedule, list_schedules, get_schedule_history,
 *   cancel_schedule,
 *   browser_open, browser_observe, browser_act, browser_screenshot,
 *   browser_close,
 *   clipboard_write, clipboard_read,
 *   list_sessions, send_to_session,
 *   terminal_font_size,
 *   ask_question
 */
export const INVARIANT_CORE_COUNT = 23;

/**
 * Sort a copy of the MCP schema array by tool name using a locale-independent
 * lexicographic comparator so both providers produce an identical MCP segment
 * regardless of the order servers connected and registered their tools.
 *
 * Returns a new array; the input is not mutated.
 */
export function sortMcpSchemas(schemas: AnthropicToolDef[]): AnthropicToolDef[] {
  return schemas.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
