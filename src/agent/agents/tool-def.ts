/**
 * Dynamic `agent` tool definition: advertises the session's named agent
 * types in the tool description (Claude Code advertises subagent types in
 * its Task tool the same way) and documents the `agent_type` parameter.
 *
 * Built once per provider construction — the registry is session-static, so
 * there is nothing to refresh mid-session.
 *
 * @module agent/agents/tool-def
 */

import { agentTool } from '../tools/schemas.js';
import type { AnthropicToolDef } from '../tools/types.js';
import type { AgentRegistry } from './types.js';

/** Truncate a description to one compact line for the tool-def listing. */
function oneLine(text: string, max = 160): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : collapsed.slice(0, max - 1) + '…';
}

/**
 * Build the `agent` tool definition for a session with named agents.
 *
 * Returns the static {@link agentTool} unchanged when the registry is empty
 * or absent, keeping the no-registry schema byte-identical to the legacy
 * surface. Otherwise returns a copy with:
 * - an `agent_type` input property (documented alias: `subagent_type`), and
 * - an "Available agent types" section appended to the description.
 */
export function buildAgentToolDef(registry: AgentRegistry | undefined): AnthropicToolDef {
  if (registry === undefined || registry.size === 0) return agentTool;

  const listing = [...registry.values()]
    .map((agent) => `- ${agent.name}: ${oneLine(agent.definition.description)}`)
    .join('\n');

  return {
    ...agentTool,
    description:
      (agentTool.description ?? '') +
      '\n\nAvailable agent types (pass via `agent_type`):\n' +
      listing +
      '\nWhen `agent_type` is omitted, a general child agent with the default tool surface is dispatched.',
    input_schema: {
      ...agentTool.input_schema,
      properties: {
        ...agentTool.input_schema.properties,
        agent_type: {
          type: 'string',
          description:
            'Named agent type to dispatch — one of the "Available agent types" listed in this ' +
            "tool's description. The type supplies the child's system prompt, tool allowlist " +
            '(mechanically enforced), and default model/turn budget. Explicit `model`/`max_turns` ' +
            'on this call override the type\'s defaults. Unknown types fail with the available ' +
            'list. Alias: `subagent_type`.',
        },
      },
    },
  };
}
