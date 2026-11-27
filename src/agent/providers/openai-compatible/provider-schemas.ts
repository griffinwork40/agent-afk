import type { OpenAICompatibleProviderOptions } from './index.options.js';
import type { AnthropicToolDef } from '../anthropic-direct/types.js';
import { builtinToolSchemas, agentTool, skillTool, composeTool } from '../../tools/schemas.js';
import { memoryToolSchemas, memorySearchTool } from '../../memory/index.js';
import { workspacePublishTool, workspaceQueryTool, workspaceSubscribeTool } from '../../workspace/index.js';
import { getRuntimeStateTool } from '../../awareness/index.js';
import { readOnlyGitSchemas } from '../../tools/readonly-git-surface.js';
import { desktopSchemas } from '../../tools/desktop-surface.js';
import { isStateRestricted, stateToolSchemas, stateReadToolSchemas } from './index.child-session.js';

/** Construction and fork-time catalogs share the same schema/handler gate. */
export function buildProviderSchemas(opts: OpenAICompatibleProviderOptions): AnthropicToolDef[] {
  const schemas: AnthropicToolDef[] = [...builtinToolSchemas, ...readOnlyGitSchemas(), ...desktopSchemas()];
  schemas.push(...(opts.readOnlyMemory === true ? [memorySearchTool] : memoryToolSchemas));
  schemas.push(...(isStateRestricted(opts.readOnlyMemory, opts.readOnlyState) ? stateReadToolSchemas : stateToolSchemas));
  // A store alone enables publish/query, not subscriptions: only forked children
  // have a handler bound to a SubagentHandle's delivery buffer.
  if (opts.workspaceStore !== undefined) {
    schemas.push(workspacePublishTool, workspaceQueryTool);
    if (opts.subscribeHandler !== undefined) schemas.push(workspaceSubscribeTool);
  }
  schemas.push(getRuntimeStateTool);
  // Nesting remains after memory/state/awareness for prefix-cache stability (#4217).
  if (opts.subagentExecutor) {
    // describeAgentTool() has three return states (#4873):
    //   undefined  — method absent (test stub); fall back to static schema.
    //   null       — allowlist is empty (scoped child must not dispatch agents); omit entirely.
    //   object     — registry-described schema; push as-is.
    // `?? agentTool` must NOT be used here: nullish coalescing treats null and
    // undefined identically, destroying the null sentinel before the guard runs.
    const agentToolDef = opts.subagentExecutor.describeAgentTool?.();
    if (agentToolDef === undefined) schemas.push(agentTool);
    else if (agentToolDef !== null) schemas.push(agentToolDef);
  }
  if (opts.skillExecutor) schemas.push(skillTool);
  if (opts.composeExecutor) schemas.push(opts.subagentExecutor?.describeComposeTool?.() ?? composeTool);
  // Builtins win over custom collisions; never send duplicate wire tool names.
  for (const t of opts.customTools ?? []) {
    if (!schemas.some((s) => s.name === t.schema.name)) schemas.push(t.schema);
  }
  return schemas;
}
