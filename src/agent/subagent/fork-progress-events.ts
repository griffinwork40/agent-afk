/**
 * Progress-events opt-in wiring for forked subagents.
 *
 * When a parent dispatches a child with `progressEvents: true`, the child's
 * `AgentConfig.customTools` is extended with the `emit_progress` tool. This
 * module owns that injection so the main `SubagentManager.forkSubagent` method
 * does not grow unbounded.
 *
 * The injection must happen BEFORE `new AgentSession(childConfig)` but the
 * tool handler requires access to the not-yet-constructed `SubagentHandleImpl`.
 * A mutable ref object bridges the two: `applyProgressEventsToConfig` returns
 * both the augmented config and a ref whose `.current` field must be set by the
 * caller immediately after `SubagentHandleImpl` is constructed.
 *
 * @module agent/subagent/fork-progress-events
 */

import { z } from 'zod';
import type { AgentConfig } from '../types.js';
import type { InputStreamRef } from '../types/permission-types.js';
import { tool } from '../tools/custom-tool.js';
import {
  createEmitProgressHandler,
  PROGRESS_MAX_MESSAGE_BYTES,
} from '../tools/subagent/emit-progress.js';
import type { SubagentHandleImpl } from './handle.js';

/** Callback returned by {@link wireProgressEvents} -- binds the handle after construction. */
export type BindProgressHandle = (handle: SubagentHandleImpl<unknown>) => void;

/**
 * Conditionally inject the `emit_progress` custom tool into a child's config.
 *
 * Mutates `config.customTools` in place (the spread inside `assembleChildConfig`
 * already produced a fresh object, so mutation is safe). Returns a `bindHandle`
 * callback that the caller MUST invoke with the constructed `SubagentHandleImpl`.
 *
 * When `enabled` is falsy, the config is untouched and `bindHandle` is a no-op,
 * so the caller needs no conditional branching.
 */
export function wireProgressEvents(
  config: AgentConfig,
  enabled: boolean | undefined,
  parentInputStreamRef: InputStreamRef | undefined,
  parentAbortSignal: AbortSignal | undefined,
): BindProgressHandle {
  if (!enabled) return () => {};
  return applyProgressEventsToConfig(config, parentInputStreamRef, parentAbortSignal);
}

/**
 * Inject the `emit_progress` custom tool into a child's `AgentConfig`.
 * Internal -- callers should use `wireProgressEvents` which handles the opt-in guard.
 */
function applyProgressEventsToConfig(
  config: AgentConfig,
  parentInputStreamRef: InputStreamRef | undefined,
  parentAbortSignal: AbortSignal | undefined,
): BindProgressHandle {
  const handleRef: { current: SubagentHandleImpl<unknown> | undefined } = { current: undefined };
  const capturedRef = handleRef;

  const emitProgressTool = tool(
    'emit_progress',
    'Emit a structured progress event to the parent agent. ' +
      'The event is delivered to the parent at its next user-turn boundary, ' +
      'wrapped in a <child-progress> envelope. ' +
      'Use to report phase transitions, intermediate findings, or status updates ' +
      'so the parent stays informed without waiting for the full result. ' +
      `The "message" field is required (max ${PROGRESS_MAX_MESSAGE_BYTES} bytes). ` +
      '"phase" and "metadata" are optional. ' +
      'This tool does NOT count against maxToolUseIterations — it is meta, not work.',
    z.object({
      message: z.string().describe('Progress message to deliver to the parent (required).'),
      phase: z
        .string()
        .optional()
        .describe('Optional phase label (e.g. "research", "planning", "done").'),
      metadata: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Optional structured metadata for machine consumers.'),
    }),
    async (input, signal) => {
      if (capturedRef.current === undefined) {
        return { content: 'emit_progress: handle not yet initialized.', isError: true };
      }
      const handlerFn = createEmitProgressHandler(
        capturedRef.current,
        (text) => {
          if (parentInputStreamRef?.queueFrameworkContext) {
            parentInputStreamRef.queueFrameworkContext(text);
          } else if (parentInputStreamRef) {
            parentInputStreamRef.pushUserMessage(text);
          }
        },
        parentAbortSignal,
      );
      return handlerFn(input, signal);
    },
  );

  // Mutate in place -- the config object is already a fresh shallow copy
  // produced by assembleChildConfig's spread.
  config.customTools = [...(config.customTools ?? []), emitProgressTool];
  return (handle: SubagentHandleImpl<unknown>) => { capturedRef.current = handle; };
}
