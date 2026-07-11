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

import { builtinToolSchemas, agentTool, skillTool, composeTool } from './schemas.js';
import { memoryToolSchemas } from '../memory/memory-tools.js';
import { getRuntimeStateTool } from '../awareness/index.js';
import type { ToolCall } from '../providers/anthropic-direct/types.js';
import type { ConcurrencyClassifier } from './types.js';

/**
 * Derived at module load from the union of all built-in tool schemas.
 * A tool is concurrency-safe when its schema declares `concurrencySafe: true`.
 * This replaces the former hand-maintained list and stays automatically in sync
 * with schema changes.
 *
 * External constraint: schemas.ts and memory-tools.ts are the single source
 * of truth. Mutations to those files propagate here without any secondary edit.
 */
const SAFE_TOOLS: ReadonlySet<string> = new Set(
  [
    ...builtinToolSchemas,
    agentTool,
    skillTool,
    composeTool,
    ...memoryToolSchemas,
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
