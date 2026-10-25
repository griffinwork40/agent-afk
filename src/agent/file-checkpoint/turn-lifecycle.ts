/**
 * Provider-agnostic per-turn checkpoint lifecycle, shared by the
 * anthropic-direct and openai-compatible turn drivers.
 *
 *   beginCheckpointTurn  — log the turn start and create its registry.
 *   endCheckpointTurn    — log post-turn hashes of touched paths (idempotent).
 *   linkCheckpointTurn / checkpointTurnIdFor — tie the in-memory user message
 *     object to its checkpoint turnId, so a rewind target picked by history
 *     position can find its file checkpoint.
 *
 * Invariant: the link is keyed by message OBJECT identity in a WeakMap, never
 * by history index. Rewind splices and compaction keep the surviving message
 * objects (their links stay valid) and drop or replace the rest (their links
 * vanish). A resumed or model-swapped history is built from new objects, so
 * it has no links and the files option is reported unavailable, never guessed.
 *
 * @module agent/file-checkpoint/turn-lifecycle
 */

import { createFileCheckpointRegistry, type FileCheckpointRegistry } from './file-checkpoint.js';
import { appendTurnLog, hashPaths } from './turn-log.js';
import { markCheckpointOwner } from './retention.js';
import type { RewindTarget } from '../provider.js';

const links = new WeakMap<object, string>();
const finished = new WeakSet<FileCheckpointRegistry>();

/** Start a checkpointed turn: append its `turn` entry, then return its registry. */
export function beginCheckpointTurn(sessionId: string, turnId: string, stateDir?: string): FileCheckpointRegistry {
  appendTurnLog(sessionId, { kind: 'turn', turnId, ts: Date.now() }, stateDir);
  markCheckpointOwner(sessionId, stateDir);
  return createFileCheckpointRegistry(sessionId, turnId, stateDir);
}

/**
 * Finish a checkpointed turn: record post-turn hashes for every touched path.
 * Safe to call more than once per turn (turn drivers call it on completion and
 * again in their `finally`); only the first call writes.
 */
export function endCheckpointTurn(
  sessionId: string, registry: FileCheckpointRegistry | undefined, stateDir?: string,
): void {
  if (registry === undefined || finished.has(registry)) return;
  finished.add(registry);
  const touched = registry.touchedPaths();
  if (touched.length === 0) return;
  appendTurnLog(sessionId, { kind: 'post', turnId: registry.turnId, paths: hashPaths(touched), ts: Date.now() }, stateDir);
}

/** Associate a user message object with the checkpoint turn it started. */
export function linkCheckpointTurn(message: object, turnId: string): void {
  links.set(message, turnId);
}

/** Checkpoint turnId for a user message object, when one was linked. */
export function checkpointTurnIdFor(message: object | undefined): string | undefined {
  return message === undefined ? undefined : links.get(message);
}

/** Decorate rewind targets with the checkpoint turnId of the message each points at. */
export function withCheckpointTurnIds(
  targets: RewindTarget[], history: readonly object[],
): RewindTarget[] {
  return targets.map((target) => {
    const checkpointTurnId = checkpointTurnIdFor(history[target.turnIndex]);
    return checkpointTurnId === undefined ? target : { ...target, checkpointTurnId };
  });
}
