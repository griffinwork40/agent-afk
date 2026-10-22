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
import type { FileCheckpointRegistry } from '../../file-checkpoint/file-checkpoint.js';
import { beginCheckpointTurn, endCheckpointTurn, linkCheckpointTurn } from '../../file-checkpoint/turn-lifecycle.js';
import { rewindFiles } from '../../file-checkpoint/rewind-files.js';
import type { ToolHandlerContext } from '../../tools/types.js';
import type { ProviderEvent, ProviderRewindResult, RewindFilesOptions } from '../../provider.js';
import type { MessageJournal } from '../../journal/types.js';

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
  private registry: FileCheckpointRegistry | undefined;
  private markedTurnId: string | undefined;
  constructor(
    private readonly enabled: boolean,
    private readonly sessionId: string,
    private readonly journal?: MessageJournal,
  ) {}

  /** Wire a fresh registry for a new turn; stores the generated turnId. */
  begin(dispatcher: object | undefined, userMessageId?: string): string | undefined {
    if (!this.enabled) return;
    const wiring = wiringOf(dispatcher);
    if (wiring === undefined) return;
    const turnId = userMessageId ?? randomUUID();
    this.currentTurnId = turnId;
    this.registry = beginCheckpointTurn(this.sessionId, turnId);
    wiring.set(this.registry);
    return turnId;
  }

  /**
   * Link the user message pushed for the current turn to its checkpoint
   * (called from `pushUserTurn`, which runs after {@link begin}). A token
   * refresh retry re-pushes a fresh message object; it is linked too, and the
   * journal mark is written once per turn.
   */
  linkUserTurn(message: object, messageIndex: number): void {
    const turnId = this.currentTurnId;
    if (turnId === undefined) return;
    linkCheckpointTurn(message, turnId);
    if (this.markedTurnId === turnId) return;
    this.markedTurnId = turnId;
    this.journal?.mark('checkpoint', { checkpointTurnId: turnId, messageIndex });
  }

  /** Clear the per-turn registry (called on completion and from the turn's finally block). */
  end(dispatcher: object | undefined): void {
    if (!this.enabled) return;
    wiringOf(dispatcher)?.set(undefined);
    endCheckpointTurn(this.sessionId, this.registry);
    this.registry = undefined;
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
  rewind(userMessageId: string, options?: RewindFilesOptions, writePolicy?: ToolHandlerContext): Promise<ProviderRewindResult> {
    if (this.currentTurnId !== undefined) {
      return Promise.resolve({ canRewind: false, error: 'Cannot rewind files while a turn is in flight.' });
    }
    return rewindFiles(
      { sessionId: this.sessionId, enableFileCheckpointing: this.enabled, ...(writePolicy ? { writePolicy } : {}) },
      userMessageId,
      options,
    );
  }
}
