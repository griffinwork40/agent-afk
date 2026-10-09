/**
 * File-checkpoint wiring concern for {@link SessionToolDispatcher}.
 *
 * Extracted from `dispatcher.ts` to bring it within the 350-code-line
 * ceiling. Owns the per-turn {@link FileCheckpointRegistry} state that
 * write-class tool handlers use to snapshot files before mutation, the
 * setter the provider calls once per turn, and the context-spread fragment
 * that injects the registry into every {@link ToolHandlerContext}.
 *
 * The owning dispatcher holds one {@link FileCheckpointWiring} instance
 * and delegates both `setFileCheckpoint()` and the handlerContext spread
 * fragment through it.
 *
 * @module agent/tools/dispatcher.file-checkpoint
 */

import type { FileCheckpointRegistry } from '../file-checkpoint/file-checkpoint.js';
export type { FileCheckpointRegistry };

/**
 * Minimal state object carrying the per-turn file-checkpoint registry for a
 * single {@link SessionToolDispatcher} instance. Never shared across sessions.
 */
export class FileCheckpointWiring {
  private _registry: FileCheckpointRegistry | undefined = undefined;

  /** Swap in (or clear) the current turn's file-checkpoint registry. */
  set(registry: FileCheckpointRegistry | undefined): void {
    this._registry = registry;
  }

  /**
   * Return the partial {@link ToolHandlerContext} spread fragment that
   * injects the current registry into handler context. Returns an empty
   * object when no checkpoint is active (checkpointing disabled or between
   * turns).
   */
  contextSpread(): { fileCheckpoint: FileCheckpointRegistry } | Record<never, never> {
    return this._registry !== undefined ? { fileCheckpoint: this._registry } : {};
  }
}
