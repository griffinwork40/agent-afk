/**
 * Per-turn file-checkpoint wiring for the OpenAI-compatible provider query.
 *
 * Extracted from `query.ts` to keep it within the 350-code-line ceiling.
 * Mirrors `beginTurnCheckpoint` / `endTurnCheckpoint` in
 * `anthropic-direct/query-turn-driver.ts`: at turn start a fresh
 * {@link FileCheckpointRegistry} is wired onto the dispatcher so write-class
 * tool handlers snapshot files before mutation; at turn end it is cleared.
 *
 * @module agent/providers/openai-compatible/query.file-checkpoint
 */

import { randomUUID } from 'node:crypto';
import {
  createFileCheckpointRegistry,
  type FileCheckpointRegistry,
} from '../../file-checkpoint/file-checkpoint.js';

interface CheckpointWiringHost {
  fileCheckpointWiring: { set: (r: FileCheckpointRegistry | undefined) => void };
}

function wiringOf(dispatcher: object | undefined): CheckpointWiringHost['fileCheckpointWiring'] | undefined {
  if (dispatcher === undefined || !('fileCheckpointWiring' in dispatcher)) return undefined;
  return (dispatcher as CheckpointWiringHost).fileCheckpointWiring;
}

/**
 * Wire a fresh registry for a new turn. No-op when checkpointing is disabled
 * or the dispatcher does not carry file-checkpoint wiring.
 */
export function beginTurnFileCheckpoint(
  enabled: boolean,
  dispatcher: object | undefined,
  sessionId: string,
): void {
  if (!enabled) return;
  const wiring = wiringOf(dispatcher);
  if (wiring === undefined) return;
  wiring.set(createFileCheckpointRegistry(sessionId, randomUUID()));
}

/** Clear the per-turn registry (called from the turn's finally block). */
export function endTurnFileCheckpoint(enabled: boolean, dispatcher: object | undefined): void {
  if (!enabled) return;
  wiringOf(dispatcher)?.set(undefined);
}
