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
 * `buildAgentModelParamDescription(parentModel?)` builds the dynamic `model`
 * parameter description for the `agent` tool (and the `compose` node `model`
 * field).  It reads the live slot bindings and the resolved subagent default so
 * the coordinating model learns:
 *   - which slot names are bound and to what concrete ids,
 *   - what the actual default is (and why — env var / slot / parent / medium).
 *
 * This is intentionally NOT baked into the static `agentTool` constant so the
 * schema bytes remain stable across unrelated code changes; the dynamic text is
 * injected at provider-construction time via `buildAgentToolDef` and
 * `buildComposeTool`.
 *
 * Built once per provider construction — the registry and slot bindings are
 * session-static.
 *
 * @module agent/agents/tool-def
 */

import { agentTool, composeTool } from '../tools/schemas.js';
import type { AnthropicToolDef } from '../tools/types.js';
import type { AgentRegistry } from './types.js';
import { getSlotBindings, SLOT_NAMES } from '../session/model-slots.js';
import { getDefaultSubagentModel } from '../session/default-subagent-model.js';
import { env } from '../../config/env.js';
import type { AgentModelInput } from '../types.js';

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
 * Build the dynamic `model` parameter description for the `agent` tool and
 * `compose` node `model` field, reflecting the live slot bindings and the
 * resolved subagent default.
 *
 * Called once at provider-construction time (session-static bindings).
 *
 * @param parentModel - The parent session's model string, forwarded to
 *   {@link getDefaultSubagentModel} so the "inherit parent" branch resolves
 *   correctly for non-Anthropic parents.
 */
export function buildAgentModelParamDescription(parentModel?: AgentModelInput): string {
  const bindings = getSlotBindings();
  const defaultModel = getDefaultSubagentModel(parentModel);

  // Describe the resolved default with its source for transparency.
  // Mirror getDefaultSubagentModel's precedence to label the source correctly.
  const defaultDesc = (() => {
    const raw = env.AFK_DEFAULT_SUBAGENT_MODEL;
    if (raw && raw.length > 0) return `\`${String(defaultModel)}\` (from AFK_DEFAULT_SUBAGENT_MODEL)`;
    const subagentId = bindings.subagent?.id;
    if (subagentId && subagentId.length > 0) return `\`subagent\` slot → \`${subagentId}\``;
    return `\`${String(defaultModel)}\``;
  })();

  // Enumerate bound slots (non-empty id, excluding subagent which is shown in default).
  const boundSlots: string[] = [];
  for (const slot of SLOT_NAMES) {
    if (slot === 'subagent') continue; // covered in default description
    const id = bindings[slot]?.id;
    if (id && id.length > 0) {
      const name = bindings[slot]?.name;
      const label = name ? `\`${slot}\` (alias: \`${name}\`)` : `\`${slot}\``;
      boundSlots.push(`${label} → \`${id}\``);
    }
  }

  const slotSection = boundSlots.length > 0
    ? `Bound slots: ${boundSlots.join(', ')}. `
    : 'Slots: `local` (unconfigured), `small`, `medium`, `large`. ';

  return (
    `Model for the agent. Default: ${defaultDesc}. ` +
    slotSection +
    'Override per-call to right-size cost vs. capability — pass a slot name ' +
    '(`local`, `small`, `medium`, `large`), a custom slot name, an identity alias ' +
    '(`haiku` (cheapest/fastest), `sonnet` (general-use), `opus` (most capable)), ' +
    'or a full model id. ' +
    'Append `_1m` (e.g. `sonnet_1m`) for 1M-context variants. ' +
    'OpenAI family aliases: `sol`, `luna`, `astra`, `terra` ' +
    '(pinned to a concrete flagship in each family). Full model IDs are also accepted.'
  );
}

/**
 * Build the `agent` tool definition for a session.
 *
 * Always returns a copy with the `model` parameter description reflecting the
 * live slot bindings and resolved subagent default (#4509).  When the registry
 * is non-empty it additionally:
 * - appends the **static** agent-type suffix to the top-level description
 *   (pointing the model at the system prompt), and
 * - adds the `agent_type` input property.
 *
 * The dynamic listing belongs in the system prompt (see
 * {@link buildAgentTypeListing}) so that description differences between
 * sessions with different agent sets do not break the prefix cache.
 *
 * @param registry - Named agent registry for the session (may be empty/absent).
 * @param parentModel - Parent session model; forwarded to
 *   {@link buildAgentModelParamDescription} so the "inherit parent" default
 *   resolves correctly for non-Anthropic parents.
 */
export function buildAgentToolDef(
  registry: AgentRegistry | undefined,
  parentModel?: AgentModelInput,
): AnthropicToolDef {
  const modelDesc = buildAgentModelParamDescription(parentModel);
  const baseProps = agentTool.input_schema.properties as Record<string, object>;

  if (registry === undefined || registry.size === 0) {
    return {
      ...agentTool,
      input_schema: {
        ...agentTool.input_schema,
        properties: {
          ...baseProps,
          model: { ...(baseProps['model'] ?? {}), description: modelDesc },
        },
      },
    };
  }

  return {
    ...agentTool,
    description: (agentTool.description ?? '') + AGENT_TYPE_STATIC_SUFFIX,
    input_schema: {
      ...agentTool.input_schema,
      properties: {
        ...baseProps,
        model: { ...(baseProps['model'] ?? {}), description: modelDesc },
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
 * Build the `compose` tool definition for a session, patching the per-node
 * `model` description with live slot and default information (#4509).
 *
 * Returns a shallow copy of {@link composeTool} with the node `model` field
 * description updated.  All other fields are byte-identical to the static
 * export so only the `model` description varies between sessions with different
 * slot configurations.
 *
 * @param parentModel - Parent session model; forwarded to
 *   {@link buildAgentModelParamDescription}.
 */
export function buildComposeTool(parentModel?: AgentModelInput): AnthropicToolDef {
  const modelDesc = buildAgentModelParamDescription(parentModel);
  const nodesSchema = (composeTool.input_schema.properties as Record<string, {
    type?: string;
    items?: { type?: string; properties?: Record<string, object>; required?: string[]; additionalProperties?: boolean };
    description?: string;
  }>)['nodes'];
  if (!nodesSchema?.items?.properties) return composeTool;

  return {
    ...composeTool,
    input_schema: {
      ...composeTool.input_schema,
      properties: {
        ...(composeTool.input_schema.properties as Record<string, object>),
        nodes: {
          ...nodesSchema,
          items: {
            ...nodesSchema.items,
            properties: {
              ...nodesSchema.items.properties,
              model: {
                ...(nodesSchema.items.properties['model'] ?? {}),
                description: modelDesc,
              },
            },
          },
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
