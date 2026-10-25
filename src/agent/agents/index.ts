/**
 * Named agents: public module surface.
 *
 * @module agent/agents
 */

export type {
  AgentRegistry,
  RegisteredAgent,
} from './types.js';
export { resolveAgentToolAccess } from './resolve.js';
export { loadAgentRegistry } from './registry.js';
export { buildAgentToolDef, buildAgentTypeListing } from './tool-def.js';
