/**
 * Named agents: public module surface.
 *
 * @module agent/agents
 */

export type {
  AgentRegistry,
  AgentSource,
  RegisteredAgent,
  ResolvedAgentToolAccess,
} from './types.js';
export { parseAgentMarkdown, type ParsedAgentFile } from './parser.js';
export { resolveAgentToolAccess } from './resolve.js';
export { builtinAgents } from './builtins.js';
export { loadAgentRegistry, type LoadAgentRegistryOptions } from './registry.js';
export { buildAgentToolDef } from './tool-def.js';
