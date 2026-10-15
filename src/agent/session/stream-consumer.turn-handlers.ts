/**
 * Named helpers for the two largest `transformProviderEvent` switch arms:
 * `session.init` and `turn.completed`. Extracted to keep `stream-consumer.ts`
 * within the 350-code-line file ceiling while preserving all inline
 * `Invariant:` / `Contract:` comments next to the logic they govern.
 *
 * @module agent/session/stream-consumer.turn-handlers
 */

import type { ProviderEvent } from '../provider.js';
import type { OutputEvent, PermissionMode, SessionMetadata } from '../types.js';
import { BudgetExceededError } from '../../utils/errors.js';
import { emitBudget } from '../trace/emit.js';
import { usageToMetadata, type TransformDeps } from './stream-consumer.js';

/**
 * Apply a `session.init` event: merge provider-supplied info into session
 * metadata, update the session identity, and resolve the initialization
 * promise. Returns null — the event produces no output chunk.
 *
 * @param info   Destructured from `event.info` by the caller.
 * @param deps   The same `TransformDeps` passed to `transformProviderEvent`.
 */
export function handleSessionInit(
  info: Extract<ProviderEvent, { type: 'session.init' }>['info'],
  deps: TransformDeps,
): null {
  deps.setSessionMetadata((prev) => ({
    ...prev,
    sessionId: info.sessionId,
    model: info.model ?? prev.model,
    ...(info.permissionMode !== undefined
      ? { permissionMode: info.permissionMode as PermissionMode }
      : {}),
    ...(info.cwd !== undefined ? { cwd: info.cwd } : {}),
    tools: info.tools ? [...info.tools] : prev.tools,
    slashCommands: info.slashCommands ? [...info.slashCommands] : prev.slashCommands,
    skills: info.skills ? [...info.skills] : prev.skills,
    plugins: info.plugins ? info.plugins.map((p) => ({ ...p })) : prev.plugins,
    mcpServers: info.mcpServers ? info.mcpServers.map((s) => ({ ...s })) : prev.mcpServers,
    ...(info.apiKeySource !== undefined
      ? { apiKeySource: info.apiKeySource as SessionMetadata['apiKeySource'] }
      : {}),
    ...(info.version !== undefined ? { claudeCodeVersion: info.version } : {}),
    ...(info.outputStyle !== undefined ? { outputStyle: info.outputStyle } : {}),
  }));
  deps.updateSessionIdentity(info.sessionId);
  deps.resolveInitialization();
  return null;
}

/**
 * Apply a `turn.completed` event: drain the successful-tool accumulator onto
 * metadata, stamp the last assistant message, enforce the monetary budget
 * ceiling (C6), and return either a budget-error event or a `done` event.
 *
 * Budget enforcement (C6): accumulate cost across turns and abort once the
 * session-level running total crosses the ceiling. `_runningCostUsd` is
 * tracked on `deps` so it persists across calls within one session loop.
 *
 * `metadata.totalCostUsd` is populated by `toProviderUsage()` from the model
 * pricing table when the model id is known. When cost is unavailable (unknown
 * model / openai-compatible adapter) it will be `undefined` and we skip the
 * gate.
 *
 * @param event  The `turn.completed` provider event.
 * @param deps   The same `TransformDeps` passed to `transformProviderEvent`.
 */
export function handleTurnCompleted(
  event: Extract<ProviderEvent, { type: 'turn.completed' }>,
  deps: TransformDeps,
): OutputEvent {
  const metadata = usageToMetadata(event.usage, event.sessionId ?? deps.getSessionMetadata().sessionId, event.userMessageId);
  // Drain the per-turn successful-tool accumulator onto the metadata so the
  // returned Message carries the raw observation (empty list ⇒ omit the
  // field, keeping the shape identical to today for tool-less turns).
  if (deps._successfulToolNames !== undefined && deps._successfulToolNames.length > 0) {
    metadata.successfulToolNames = [...deps._successfulToolNames];
  }
  deps.setLastResponseMetadata(metadata);

  for (let i = deps.conversationHistory.length - 1; i >= 0; i--) {
    const msg = deps.conversationHistory[i];
    if (msg?.role === 'assistant') {
      msg.metadata = metadata;
      break;
    }
  }

  if (
    deps.maxBudgetUsd !== undefined &&
    deps.abortBudget !== undefined &&
    typeof metadata.totalCostUsd === 'number'
  ) {
    deps._runningCostUsd = (deps._runningCostUsd ?? 0) + metadata.totalCostUsd;
    if (deps._runningCostUsd >= deps.maxBudgetUsd) {
      // Witness layer: emit the threshold-breach record BEFORE the
      // controller aborts. Three reasons for the ordering:
      //   1. The abort cascade (and its own `abort` event) follows
      //      naturally; a trace reader can correlate the budget
      //      breach to the abort that immediately succeeds it.
      //   2. abortBudget short-circuits the stream — if we emitted
      //      after the abort, a fast-cancelling provider could close
      //      before the budget event lands.
      //   3. The closure event (reason: 'budget_exceeded') fires at
      //      session termination; the budget event is the in-flight
      //      record of the threshold being crossed, distinct from
      //      the terminal record.
      void emitBudget(deps.traceWriter, {
        kind: 'monetary',
        runningCostUsd: deps._runningCostUsd,
        maxBudgetUsd: deps.maxBudgetUsd,
        lastTurnCostUsd: metadata.totalCostUsd,
      });
      const err = new BudgetExceededError(deps._runningCostUsd, deps.maxBudgetUsd);
      deps.abortBudget(err);
      return { type: 'error', error: err };
    }
  }

  return { type: 'done', metadata };
}
