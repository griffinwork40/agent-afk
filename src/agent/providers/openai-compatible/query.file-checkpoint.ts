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
import { rewindFiles } from '../../file-checkpoint/rewind-files.js';
import type { ProviderEvent, ProviderRewindResult } from '../../provider.js';

interface CheckpointWiringHost {
  fileCheckpointWiring: { set: (r: FileCheckpointRegistry | undefined) => void };
}

function wiringOf(dispatcher: object | undefined): CheckpointWiringHost['fileCheckpointWiring'] | undefined {
  if (dispatcher === undefined || !('fileCheckpointWiring' in dispatcher)) return undefined;
  return (dispatcher as CheckpointWiringHost).fileCheckpointWiring;
}

/**
 * Encapsulates per-turn file-checkpoint state for the OpenAI-compatible
 * provider. Extracted from `query.ts` to keep it within the 350-code-line
 * ceiling — holds `enabled` + `currentTurnId` and exposes begin/end/rewind.
 */
export class FileCheckpointState {
  private currentTurnId: string | undefined;
  constructor(
    private readonly enabled: boolean,
    private readonly sessionId: string,
  ) {}

  /** Wire a fresh registry for a new turn; stores the generated turnId. */
  begin(dispatcher: object | undefined, userMessageId?: string): string | undefined {
    if (!this.enabled) return;
    const wiring = wiringOf(dispatcher);
    if (wiring === undefined) return;
    const turnId = userMessageId ?? randomUUID();
    this.currentTurnId = turnId;
    wiring.set(createFileCheckpointRegistry(this.sessionId, turnId));
    return turnId;
  }

  /** Clear the per-turn registry (called from the turn's finally block). */
  end(dispatcher: object | undefined): void {
    if (!this.enabled) return;
    wiringOf(dispatcher)?.set(undefined);
    this.currentTurnId = undefined;
  }

  /** Publish completion only after clearing mutation wiring. */
  async *events(
    events: AsyncIterable<ProviderEvent>, dispatcher: object | undefined, checkpointId: string | undefined,
  ): AsyncGenerator<ProviderEvent> {
    for await (const event of events) {
      // Invariant: consumers may rewind on completion without advancing the
      // generator again, so release the registry before publishing the event.
      if (event.type === 'turn.completed') this.end(dispatcher);
      yield event.type === 'turn.completed' && checkpointId !== undefined
        ? { ...event, userMessageId: checkpointId } : event;
    }
  }

  /** Delegate rewindFiles for the enclosing provider query. */
  rewind(userMessageId: string, options?: { dryRun?: boolean }): Promise<ProviderRewindResult> {
    if (this.currentTurnId !== undefined) {
      return Promise.resolve({ canRewind: false, error: 'Cannot rewind files while a turn is in flight.' });
    }
    return rewindFiles(
      { sessionId: this.sessionId, enableFileCheckpointing: this.enabled },
      userMessageId,
      options,
    );
  }
}
