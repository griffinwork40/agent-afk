import { SUBAGENT_TOOLS } from '../../tool-category.js';
import { sanitizeForDisplay } from '../../../utils/terminal-sanitize.js';
import { formatToolLine } from './tool-lane-format.js';
import type { Entry } from './tool-lane-render.js';

/**
 * Mutate an existing `agent`/`Task` ToolEntry to display as `Agent(<label>)`.
 * Returns `true` if the entry was found, is a tool entry, belongs to
 * SUBAGENT_TOOLS, and has NOT already been merged (toolName !== 'Agent').
 * Returns `false` otherwise. Callers use the return value as a merge-happened
 * guard to decide whether to create a synthetic child entry.
 *
 * Invariants: toolUseId key, agentContext, and agentIdStack are all
 * unchanged. Only toolName, toolInput, and prefix are mutated.
 */
export function mergeAgentLabel(entries: ReadonlyMap<string, Entry>, parentToolUseId: string, label: string, maxWidth?: number): boolean {
  const entry = entries.get(parentToolUseId);
  if (entry?.kind !== 'tool') return false;
  if (!SUBAGENT_TOOLS.has(entry.toolName)) return false;
  if (entry.toolName === 'Agent') return false; // already merged — prevent grandchild overwrite
  // sanitizeForDisplay covers both 7-bit ANSI escapes and 8-bit C1 controls
  // (e.g. 0x9B CSI, 0x9C ST) that stripAnsi misses, preventing LLM-emitted
  // C1 bytes in the subagent label from reaching palette.dim() on any
  // downstream render surface (overlay or flush).
  const safeLabel = sanitizeForDisplay(label);
  const input = `(${safeLabel})`;
  entry.toolName = 'Agent';
  entry.toolInput = input;
  entry.prefix = formatToolLine('Agent' + input, maxWidth);
  return true;
}

