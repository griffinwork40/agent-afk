/**
 * Concurrency batching for the session tool dispatcher.
 *
 * Pure helpers extracted from `dispatcher.ts` (#361): the concurrency-safety
 * classifier and the round-partitioner that groups a tool-call sequence into
 * runs of concurrency-safe vs. sequential batches. No dispatcher state — see
 * `SessionToolDispatcher.executeBatch` for the stateful consumer.
 *
 * @module agent/tools/dispatch-batching
 */

import { builtinToolSchemas } from './schemas.js';
import { agentTool, skillTool, composeTool } from './schemas.agent-tools.js';
import { gitReadTool } from './schemas.git-read.js';
import { codeSymbolsTool } from './schemas.lsp-symbols.js';
import { memoryToolSchemas } from '../memory/memory-tools.js';
import { stateToolSchemas } from '../state/state-schemas.js';
import { getRuntimeStateTool } from '../awareness/index.js';
import type { ToolCall } from '../providers/anthropic-direct/types.js';
import type { ConcurrencyClassifier } from './types.js';

/**
 * Derived at module load from the union of all built-in tool schemas.
 * A tool is concurrency-safe when its schema declares `concurrencySafe: true`.
 * This replaces the former hand-maintained list and stays automatically in sync
 * with schema changes.
 *
 * Imports `builtinToolSchemas` + the individual orchestration tools directly
 * rather than the aggregate `ALL_TOOL_SCHEMAS` re-export, so that test files
 * which vi.mock('schemas.js') with a minimal stub (builtinToolSchemas + named
 * tools, but no ALL_TOOL_SCHEMAS) do not trigger a missing-export error at
 * module-load time (#3812). The set of schemas covered is identical.
 *
 * External constraint: schemas.ts, memory-tools.ts, and state-schemas.ts are
 * the single source of truth. Mutations to those files propagate here without
 * any secondary edit.
 */
const SAFE_TOOLS: ReadonlySet<string> = new Set(
  [
    // builtins + agent/skill/compose + opt-in git_read (#3754).
    ...builtinToolSchemas,
    agentTool,
    skillTool,
    composeTool,
    gitReadTool,
    // codeSymbolsTool: concurrencySafe:true because each invocation spawns
    // its own isolated typescript-language-server process with no shared
    // state, making parallel calls independently safe.
    codeSymbolsTool,
    ...memoryToolSchemas,
    ...stateToolSchemas,
    getRuntimeStateTool,
  ]
    .filter((s) => s.concurrencySafe === true)
    .map((s) => s.name),
);

export function defaultConcurrencyClassifier(toolName: string): boolean {
  return SAFE_TOOLS.has(toolName);
}

export interface Batch {
  isConcurrencySafe: boolean;
  indices: number[];
}

export function partitionIntoBatches(
  calls: ToolCall[],
  classifier: ConcurrencyClassifier,
): Batch[] {
  return calls.reduce<Batch[]>((acc, call, i) => {
    const safe = classifier(call.name, call.input);
    const last = acc[acc.length - 1];
    if (last && safe && last.isConcurrencySafe) {
      last.indices.push(i);
    } else {
      acc.push({ isConcurrencySafe: safe, indices: [i] });
    }
    return acc;
  }, []);
}
