/**
 * Stable tool-list ordering helpers for prefix-cache reuse (#4198).
 *
 * The assembled `schemas[]` array sent to the model is partitioned into four
 * deterministic segments so that removing any optional tool from its segment
 * never shifts tools in an earlier segment:
 *
 *   1. Invariant core builtins  (fixed order, always present)
 *   2. Optional/disableable builtins (tail of builtinToolSchemas)
 *   3. MCP tools sorted by name (deterministic across connection orders)
 *   4. plan-exit tool (always last when present)
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
 * Number of leading entries in `builtinToolSchemas` that are invariant core
 * tools -- always present, never disabled, never surface-filtered.
 *
 * These tools appear before any optional/disableable tool so that two sessions
 * differing only in which optional tools are enabled produce a byte-identical
 * serialized prefix for all invariant tools.
 *
 * Invariant core tools (indices 0..INVARIANT_CORE_COUNT-1):
 *   bash, read_file, view_image, extract_document, write_file, edit_file,
 *   glob, grep, list_directory,
 *   wait_for, patch_apply, test_run, get_facet, json_query, model_complete,
 *   worktree, config_get, config_set,
 *   read_witness, search_witness,
 *   cancel_background_job, send_message_to_agent, get_background_job_health,
 *   remote_agent, web_scrape, web_request
 *
 * Decision notes:
 *   - `web_scrape` / `web_request`: not in any disable group; no surface filter
 *     removes them; treated as invariant core.
 *   - `worktree` / `config_get` / `config_set`: not in any disable group.
 *   - `remote_agent`: not in any disable group.
 *   - `gitReadTool` is opt-in (AFK_READONLY_GIT_TOOL flag) and lives in
 *     ALL_TOOL_SCHEMAS but not builtinToolSchemas, so it is NOT counted here.
 *   - Nesting tools (agentTool, skillTool, composeTool) are NOT in
 *     builtinToolSchemas; they are appended conditionally at provider-
 *     construction time and placed after ALL builtins. They do not affect the
 *     invariant core prefix of builtinToolSchemas itself.
 *
 * Optional tail (indices INVARIANT_CORE_COUNT..44):
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
export const INVARIANT_CORE_COUNT = 26;

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
