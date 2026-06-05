/**
 * Ambient sink channel for subagent progress streaming.
 *
 * Uses AsyncLocalStorage to provide context-aware progress sink propagation
 * across async boundaries. Enables parent sessions to receive subagent
 * progress events without explicit plumbing through call stacks.
 *
 * @module agent/_lib/skill-sink-channel
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { SubagentProgressSink } from '../types/session-types.js';

const channel = new AsyncLocalStorage<SubagentProgressSink>();

/**
 * Execute a function within a specific sink context.
 *
 * The sink becomes available to any code within the function via
 * getCurrentSink(), including across async boundaries (awaits, promises).
 *
 * @param sink The progress sink to set as current.
 * @param fn The async function to execute.
 * @returns The return value of fn.
 */
export function runWithSink<T>(
  sink: SubagentProgressSink,
  fn: () => Promise<T>,
): Promise<T> {
  return channel.run(sink, fn);
}

/**
 * Get the current progress sink, or undefined if none is active.
 *
 * @returns The sink set by the nearest runWithSink call, or undefined.
 */
export function getCurrentSink(): SubagentProgressSink | undefined {
  return channel.getStore();
}
