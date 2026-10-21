/**
 * Agent tool definition builder + agent-type listing formatter.
 *
 * `buildAgentToolDef(registry)` returns the `agent` tool schema.  The
 * **description is now static** — it no longer embeds the registry listing.
 * Two sessions whose agent sets differ therefore produce a byte-identical
 * `agent` tool schema, preserving the prefix cache across the tool block.
 *
 * `buildAgentTypeListing(registry)` produces the dynamic "Available agent
 * types" block that is injected into the **system prompt** (after the
 * `# Environment` / manifest section) instead of the tool description.
 * Moving the listing there is safe because:
 *   - The system prompt already varies per cwd (the `# Environment` block),
 *     so cache pressure from a different agent set lands in the already-volatile
 *     region.
 *   - Unknown `agent_type` values fail at execution time with the available
 *     list (`executeOnce`), so validation is unaffected.
 *
 * Built once per provider construction — the registry is session-static.
 *
 * @module agent/agents/tool-def
 */

import { agentTool } from '../tools/schemas.js';
import type { AnthropicToolDef } from '../tools/types.js';
import type { AgentRegistry } from './types.js';

/** Truncate a description to one compact line for the system-prompt listing. */
function oneLine(text: string, max = 160): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : collapsed.slice(0, max - 1) + '…';
}

/**
 * Static description suffix added to the `agent` tool when a named-agent
 * registry is present.  Points the model at the system prompt for the listing
 * instead of embedding it here.
 *
 * Contract: must stay byte-identical regardless of registry contents so the
 * tool block's prefix cache is never busted by agent-set differences.
 */
const AGENT_TYPE_STATIC_SUFFIX =
  '\n\nAvailable agent types (pass via `agent_type`):\n' +
  'See the agent types listed in the system prompt.\n' +
  'When `agent_type` is omitted, a general child agent with the default tool surface is dispatched.';

/**
 * Build the `agent` tool definition for a session.
 *
 * Returns the static {@link agentTool} unchanged when the registry is empty
 * or absent, keeping the no-registry schema byte-identical to the legacy
 * surface.  Otherwise returns a copy with:
 * - an `agent_type` input property (documented alias: `subagent_type`), and
 * - a **static** suffix in the description that tells the model to see the
 *   system prompt for the listing (never the dynamic listing itself).
 *
 * The dynamic listing belongs in the system prompt (see
 * {@link buildAgentTypeListing}) so that description differences between
 * sessions with different agent sets do not break the prefix cache.
 */
export function buildAgentToolDef(registry: AgentRegistry | undefined): AnthropicToolDef {
  if (registry === undefined || registry.size === 0) return agentTool;

  return {
    ...agentTool,
    description: (agentTool.description ?? '') + AGENT_TYPE_STATIC_SUFFIX,
    input_schema: {
      ...agentTool.input_schema,
      properties: {
        ...agentTool.input_schema.properties,
        agent_type: {
          type: 'string',
          description:
            'Named agent type to dispatch — one of the "Available agent types" listed in the ' +
            'system prompt. The type supplies the child\'s system prompt, tool allowlist ' +
            '(mechanically enforced), and default model/tool-round budget. Explicit `model`, ' +
            '`max_turns`, and `max_tool_use_iterations` on this call override the type\'s ' +
            'defaults. Unknown types fail with the available list. Alias: `subagent_type`.',
        },
      },
    },
  };
}

/**
 * Build the "Available agent types" system-prompt block for a session.
 *
 * Returns an empty string when the registry is absent or empty (no block is
 * injected).  Otherwise returns a multi-line string listing every registered
 * agent with its budget / model metadata and a one-line description, suitable
 * for appending to (or including in) the system-prompt manifest section.
 *
 * This is the counterpart to {@link buildAgentToolDef}: the tool description
 * stays static, while this block carries the session-specific listing into the
 * already-volatile region of the system prompt (after `# Environment`).
 */
export function buildAgentTypeListing(registry: AgentRegistry | undefined): string {
  if (registry === undefined || registry.size === 0) return '';

  const lines = [...registry.values()].map((agent) => {
    const def = agent.definition;
    const meta: string[] = [];
    if (def.maxToolUseIterations) meta.push(`budget: ${def.maxToolUseIterations} rounds`);
    if (def.model) meta.push(`model: ${def.model}`);
    const suffix = meta.length > 0 ? ` (${meta.join(', ')})` : '';
    return `- ${agent.name}${suffix}: ${oneLine(def.description)}`;
  });

  return (
    'Available agent types (pass via `agent_type`):\n' +
    lines.join('\n') +
    '\nWhen `agent_type` is omitted, a general child agent with the default tool surface is dispatched.'
  );
}
