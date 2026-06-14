/**
 * Background task infrastructure for the interactive REPL.
 *
 * When the user presses Ctrl+B mid-turn (or uses `/bg`), the running
 * stream is detached into a floating promise. A {@link BackgroundTaskManager}
 * tracks all detached tasks, accumulates stats from the ongoing stream,
 * and emits events so the status bar and notification system can react.
 *
 * @module cli/commands/interactive/background
 */

import { EventEmitter } from 'node:events';
import type { OutputEvent, SubagentProgressMeta, ResponseMetadata } from '../../../agent/types.js';
import type { SessionStats, ToolEvent } from '../../slash/types.js';
import { recordTurn } from '../../slash/session-stats.js';

export type BackgroundTaskStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface BackgroundTaskStats {
  tokens: number;
  toolUses: number;
  durationMs: number;
}

export interface BackgroundTask {
  readonly id: string;
  readonly label: string;
  readonly startedAt: number;
  status: BackgroundTaskStatus;
  stats: BackgroundTaskStats;
  progressDescription?: string;
  resultText?: string;
  resultMeta?: ResponseMetadata;
  error?: Error;
}

export interface BackgroundTaskEvents {
  update: [task: BackgroundTask];
  complete: [task: BackgroundTask];
}

export class BackgroundTaskManager extends EventEmitter<BackgroundTaskEvents> {
  private readonly tasks = new Map<string, BackgroundTask>();
  private counter = 0;

  register(label: string): BackgroundTask {
    const id = `bg-${++this.counter}`;
    const task: BackgroundTask = {
      id,
      label,
      startedAt: Date.now(),
      status: 'running',
      stats: { tokens: 0, toolUses: 0, durationMs: 0 },
    };
    this.tasks.set(id, task);
    this.emit('update', task);
    return task;
  }

  updateStats(id: string, partial: Partial<BackgroundTaskStats>, description?: string): void {
    const task = this.tasks.get(id);
    if (!task || task.status !== 'running') return;
    if (partial.tokens !== undefined) task.stats.tokens = partial.tokens;
    if (partial.toolUses !== undefined) task.stats.toolUses = partial.toolUses;
    task.stats.durationMs = Date.now() - task.startedAt;
    if (description !== undefined) task.progressDescription = description;
    this.emit('update', task);
  }

  complete(id: string, text: string, meta?: ResponseMetadata): void {
    const task = this.tasks.get(id);
    if (!task || task.status !== 'running') return;
    task.status = 'succeeded';
    task.resultText = text;
    task.resultMeta = meta;
    task.stats.durationMs = Date.now() - task.startedAt;
    this.emit('update', task);
    this.emit('complete', task);
  }

  fail(id: string, error: Error): void {
    const task = this.tasks.get(id);
    if (!task || task.status !== 'running') return;
    task.status = 'failed';
    task.error = error;
    task.stats.durationMs = Date.now() - task.startedAt;
    this.emit('update', task);
    this.emit('complete', task);
  }

  cancel(id: string): void {
    const task = this.tasks.get(id);
    if (!task || task.status !== 'running') return;
    task.status = 'cancelled';
    task.stats.durationMs = Date.now() - task.startedAt;
    this.emit('update', task);
    this.emit('complete', task);
  }

  running(): BackgroundTask[] {
    return [...this.tasks.values()].filter(t => t.status === 'running');
  }

  all(): BackgroundTask[] {
    return [...this.tasks.values()];
  }

  get(id: string): BackgroundTask | undefined {
    return this.tasks.get(id);
  }
}

/**
 * Create a progress sink that routes OutputEvents to BackgroundTaskManager
 * stat updates instead of driving a TTY renderer.
 */
export function createBackgroundSink(
  task: BackgroundTask,
  manager: BackgroundTaskManager,
): (event: OutputEvent, meta: SubagentProgressMeta) => void {
  return (event: OutputEvent, _meta: SubagentProgressMeta) => {
    if (event.type === 'progress') {
      manager.updateStats(
        task.id,
        {
          tokens: event.progress.totalTokens,
          toolUses: event.progress.toolUses,
        },
        event.progress.description,
      );
    }
  };
}

/**
 * Detach the remaining async stream into a floating promise. The stream
 * keeps consuming events; stats flow to the BackgroundTaskManager; the
 * caller returns immediately so the REPL can show a new prompt.
 */
export function detachStreamToBackground(
  stream: AsyncIterable<OutputEvent>,
  partialResponseText: string,
  userInput: string,
  task: BackgroundTask,
  manager: BackgroundTaskManager,
  bgSink: (event: OutputEvent, meta: SubagentProgressMeta) => void,
  stats?: SessionStats,
  onTurnComplete?: (userInput: string, assistantText: string) => Promise<void>,
  abortSignal?: AbortSignal,
): void {
  void (async () => {
    let responseText = partialResponseText;
    let doneMeta: ResponseMetadata | undefined;
    const toolEvents: ToolEvent[] = [];
    const pendingTools = new Map<string, ToolEvent>();

    // Listener-based abort: AbortSignal fires synchronously on abort, but the
    // for-await loop only checks `abortSignal?.aborted` between yields. When
    // the SDK is mid-round-trip with no streaming chunks in flight, the abort
    // can be delayed by the full HTTP round-trip duration. Attaching a
    // listener here transitions the task to 'cancelled' the instant the
    // signal fires, regardless of stream state. manager.cancel() is
    // idempotent (guards on status !== 'running'), so the inline poll below
    // is safe to keep as a defense-in-depth check.
    const onAbort = (): void => { manager.cancel(task.id); };
    abortSignal?.addEventListener('abort', onAbort, { once: true });

    try {
      for await (const event of stream) {
        if (abortSignal?.aborted) {
          manager.cancel(task.id);
          return;
        }
        bgSink(event, { subagentId: '__main__' });

        if (event.type === 'chunk' && event.chunk.type === 'content') {
          responseText += event.chunk.content;
        } else if (event.type === 'chunk' && event.chunk.type === 'tool_use_detail') {
          const c = event.chunk;
          const te: ToolEvent = { toolName: c.toolName, toolUseId: c.toolUseId, input: c.toolInput, ...(c.toolInputRaw !== undefined && { inputRaw: c.toolInputRaw }) };
          pendingTools.set(c.toolUseId, te);
          toolEvents.push(te);
        } else if (event.type === 'chunk' && event.chunk.type === 'tool_result') {
          const c = event.chunk;
          const pending = pendingTools.get(c.toolUseId);
          if (pending) {
            pending.result = c.content;
            pending.isError = c.isError;
            pendingTools.delete(c.toolUseId);
          }
        }
        if (event.type === 'done') {
          doneMeta = event.metadata;
          break;
        }
        if (event.type === 'error') {
          manager.fail(task.id, event.error);
          return;
        }
      }
      manager.complete(task.id, responseText, doneMeta);
      if (stats && doneMeta) {
        recordTurn(stats, userInput, responseText, doneMeta, toolEvents);
      }
      if (onTurnComplete) {
        await onTurnComplete(userInput, responseText).catch(() => {});
      }
    } catch (err) {
      manager.fail(task.id, err instanceof Error ? err : new Error(String(err)));
    } finally {
      abortSignal?.removeEventListener('abort', onAbort);
    }
  })();
}
