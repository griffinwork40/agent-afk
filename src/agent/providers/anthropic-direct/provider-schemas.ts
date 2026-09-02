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
import { workspaceToolSchemas } from '../../workspace/index.js';
import { getRuntimeStateTool } from '../../awareness/index.js';
import { stateToolSchemas, stateReadToolSchemas } from '../../state/state-schemas.js';
import type { AnthropicDirectProviderOptions } from './provider-options.js';
import type { AnthropicToolDef } from '../../tools/types.js';

/**
 * Build the provider's static tool-schema list.
 *
 * Order is load-bearing and preserved exactly as the constructor had it:
 * builtins, then executor-gated tools (`agent`/`skill`/`compose`), then the
 * memory trio (or `memory_search` alone for a read-only child), then
 * `get_runtime_state`, then consumer-registered custom tools LAST so their
 * names never silently shadow a builtin.
 *
 * MCP tools are intentionally NOT included here. `buildDispatcher()` serves
 * them from `_mcpToolsCache` / `_mcpHandlersCache`, which are populated on
 * first use and invalidated by `onToolsRefreshed` whenever `refreshServer()` or
 * `completeAuth()` mutates the nameRegistry (Option A — see PR 3 design doc),
 * so `notifications/tools/list_changed` refreshes are picked up automatically
 * without restarting the session.
 */
export function buildProviderSchemas(opts: AnthropicDirectProviderOptions): AnthropicToolDef[] {
  const schemas = [...builtinToolSchemas];
  // The executor supplies the `agent` tool def so a named-agent registry
  // can advertise its types in the description (see agents/tool-def.ts).
  // Optional chaining: test stubs without describeAgentTool fall back to
  // the static schema.
  if (opts.subagentExecutor) schemas.push(opts.subagentExecutor.describeAgentTool?.() ?? agentTool);
  if (opts.skillExecutor) schemas.push(skillTool);
  if (opts.composeExecutor) schemas.push(composeTool);
  // Read-only memory child sessions get only `memory_search`; full sessions
  // get the complete trio (search + update + procedure_write).
  if (opts.readOnlyMemory === true) {
    schemas.push(memorySearchTool);
  } else {
    schemas.push(...memoryToolSchemas);
  }
  // State store tools: read-only sessions get only the two query tools;
  // full sessions get all five (get, put, cas, delete, query).
  // Same read/write gating pattern as memory tools above.
  if (opts.readOnlyMemory === true) {
    schemas.push(...stateReadToolSchemas);
  } else {
    schemas.push(...stateToolSchemas);
  }
  // Awareness layer (Phase 1): the `get_runtime_state` tool is always
  // available — it reads in-memory state only, so there is no executor
  // gating like `agent`/`skill`/`compose`. The source is constructed
  // per-query in `query()` and merged into the dispatcher handler map.
  // Workspace tool: workspace_publish. Children and parents can publish when
  // the shared store is enabled; omit the schema alongside its handler when
  // AFK_WORKSPACE_DISABLED leaves the provider without a store.
  if (opts.workspaceStore !== undefined) schemas.push(...workspaceToolSchemas);
  schemas.push(getRuntimeStateTool);
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
