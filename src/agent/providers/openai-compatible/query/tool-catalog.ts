import type { ToolDispatcher } from '../../anthropic-direct/tool-dispatcher.js';
import { toolDefsToOpenAIFunctions, type OpenAIFunctionTool } from '../loop.js';

/** Derive the advertised wire catalog from the same dispatcher that executes calls. */
export function dispatcherCatalog(dispatcher: ToolDispatcher | undefined): OpenAIFunctionTool[] | undefined {
  const defs = (dispatcher as { toolDefs?: readonly unknown[] } | undefined)?.toolDefs;
  return Array.isArray(defs) && defs.length > 0
    ? toolDefsToOpenAIFunctions(defs as Parameters<typeof toolDefsToOpenAIFunctions>[0])
    : undefined;
}
