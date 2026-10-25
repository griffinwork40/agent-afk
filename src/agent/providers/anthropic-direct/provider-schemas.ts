/**
 * Tool-schema assembly for {@link AnthropicDirectProvider}.
 *
 * Extracted verbatim from the provider constructor (#824 split) so the class
 * file stays under the 350-LOC budget. This is a pure function of the
 * constructor options — it reads no instance state and has no side effects, so
 * the ordering guarantees below are the whole contract.
 *
 * @module agent/providers/anthropic-direct/provider-schemas
 */

import { builtinToolSchemas, agentTool, skillTool, composeTool } from '../../tools/schemas.js';
import { memoryToolSchemas, memorySearchTool } from '../../memory/index.js';
import { workspacePublishTool, workspaceQueryTool, workspaceSubscribeTool } from '../../workspace/index.js';
import { getRuntimeStateTool } from '../../awareness/index.js';
import { stateToolSchemas, stateReadToolSchemas } from '../../state/state-schemas.js';
import type { AnthropicDirectProviderOptions } from './provider-options.js';
import { readOnlyGitSchemas } from '../../tools/readonly-git-surface.js';
import type { AnthropicToolDef } from '../../tools/types.js';

/**
 * Build the provider's static tool-schema list.
 *
 * Order (#4198, #4217):
 *   1. builtins (invariant core + optional tail)
 *   2. memory trio (`memory_search` / full set)   ← stable across sessions
 *   3. state-store tools                           ← stable across sessions
 *   4. `get_runtime_state` + workspace tools       ← stable across sessions
 *   5. nesting tools (`agent` / `skill` / `compose`) — placed AFTER the
 *      stable block so that variation in their schemas (e.g. present vs
 *      absent at max depth, or a different `agent_type` property when a
 *      registry is wired) invalidates the fewest cached tokens.
 *   6. consumer-registered custom tools LAST so their names never silently
 *      shadow a builtin.
 *
 * MCP tools are intentionally NOT included here. `buildDispatcher()` serves
 * them from `_mcpToolsCache` / `_mcpHandlersCache`, which are populated on
 * first use and invalidated by `onToolsRefreshed` whenever `refreshServer()` or
 * `completeAuth()` mutates the nameRegistry (Option A — see PR 3 design doc),
 * so `notifications/tools/list_changed` refreshes are picked up automatically
 * without restarting the session.
 */
export function buildProviderSchemas(opts: AnthropicDirectProviderOptions): AnthropicToolDef[] {
  // `git_read` (#3754) joins the builtins only while AFK_READONLY_GIT_TOOL is on.
  const schemas = [...builtinToolSchemas, ...readOnlyGitSchemas()];
  // Recon sessions (readOnlyMemory=true) get only `memory_search`. Child
  // sessions (readOnlyMemory=false, readOnlyState=true) get search +
  // memory_update; hot-write is blocked at hook time, not schema time. Full
  // parent sessions get all three (search + update + procedure_write).
  if (opts.readOnlyMemory === true) {
    schemas.push(memorySearchTool);
  } else {
    schemas.push(...memoryToolSchemas);
  }
  // State store tools: read-only sessions get only the two query tools;
  // full sessions get all five (get, put, cas, delete, query).
  // readOnlyState is independent of readOnlyMemory so child sessions can
  // write facts (memory_update target:"fact") while still being denied
  // state-store mutations (state_put/cas/delete).
  if (opts.readOnlyMemory === true || opts.readOnlyState === true) {
    schemas.push(...stateReadToolSchemas);
  } else {
    schemas.push(...stateToolSchemas);
  }
  // Awareness layer (Phase 1): the `get_runtime_state` tool is always
  // available — it reads in-memory state only, so there is no executor
  // gating like `agent`/`skill`/`compose`. The source is constructed
  // per-query in `query()` and merged into the dispatcher handler map.
  // Workspace tools: workspace_publish and workspace_query are available
  // whenever a shared store is enabled (both children and parents).
  // workspace_subscribe is only advertised for forked children — those
  // have a subscribeHandler in opts — because the schema implies the model
  // can subscribe, but top-level sessions have no handle to deliver to.
  if (opts.workspaceStore !== undefined) {
    schemas.push(workspacePublishTool);
    schemas.push(workspaceQueryTool);
    if (opts.subscribeHandler !== undefined) schemas.push(workspaceSubscribeTool);
  }
  schemas.push(getRuntimeStateTool);
  // Nesting tools — placed AFTER memory/state/get_runtime_state (#4217) so
  // variation in their schemas (present vs absent at max depth, or a
  // different `agent_type` property when a registry is wired) invalidates
  // the fewest cached tokens. The executor supplies the `agent` tool def so
  // a named-agent registry can advertise its types; optional chaining lets
  // test stubs without describeAgentTool fall back to the static schema.
  if (opts.subagentExecutor) schemas.push(opts.subagentExecutor.describeAgentTool?.() ?? agentTool);
  if (opts.skillExecutor) schemas.push(skillTool);
  if (opts.composeExecutor) schemas.push(composeTool);
  // Custom (consumer-registered) tool schemas are appended last so their
  // names never silently shadow a builtin. A custom schema whose name
  // collides with an already-present builtin (or an earlier custom tool) is
  // SKIPPED: otherwise the wire `tools` array carries a duplicate name and
  // providers that require unique tool names reject the whole request. This
  // mirrors the handler-map precedence in buildDispatcher (builtins win).
  for (const t of opts.customTools ?? []) {
    if (!schemas.some((s) => s.name === t.schema.name)) schemas.push(t.schema);
  }
  return schemas;
}
