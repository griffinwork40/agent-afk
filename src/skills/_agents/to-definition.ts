import type { AgentDefinition } from '../../agent/types/sdk-types.js';

/**
 * Convert a vendored agent module into an SDK AgentDefinition for use with
 * Options.agents (nested subagent dispatch via the built-in Agent tool).
 */
export function toAgentDefinition(agent: {
  systemPrompt: string;
  description: string;
  allowedTools?: readonly string[];
  model?: string;
}): AgentDefinition {
  const def: AgentDefinition = {
    description: agent.description,
    prompt: agent.systemPrompt,
  };
  if (agent.allowedTools) def.tools = [...agent.allowedTools];
  if (agent.model) def.model = agent.model;
  return def;
}
