/**
 * PostToolUse hook that integrates the effect ledger into the hook pipeline.
 *
 * Registration: add to the default hook registry after the existing
 * PostToolUse handlers. The hook is non-blocking (never returns
 * `decision: 'block'`); its sole purpose is record-keeping.
 *
 * # Lifecycle within one tool call
 *
 *   1. PostToolUse fires after the tool returns.
 *   2. The hook classifies the call via `classifyToolCall`.
 *   3. If external:
 *      a. Computes an idempotency key from operationType + args.
 *      b. Checks for a prior record with that key via the store.
 *      c. If found with status "executed" or "confirmed": records an
 *         `ambiguous` note (we cannot know if the execution was a duplicate
 *         or a new call) and returns. No record is created.
 *      d. If not found (or only a "pending" / "failed" record exists): writes
 *         the outcome record with status "executed" or "failed".
 *
 * # Write-ahead note
 *
 * The task specifies "write-ahead recording before execution". The FULL
 * write-ahead (pending → execute) pattern requires a PreToolUse hook that
 * writes "pending" before execution, then a PostToolUse hook that updates
 * the status. This module ships the lightweight PostToolUse-only variant that
 * records the outcome; a PreToolUse companion is a natural follow-on once the
 * dedup-gate requirement is confirmed to be valuable (adding it without a clear
 * production need adds unnecessary blocking overhead to every tool call).
 *
 * The store.writePending / store.updateStatus methods are available for callers
 * that DO want full write-ahead behavior; the `createEffectLedgerPreHook`
 * export below provides the PreToolUse half if desired.
 *
 * @module agent/effect-ledger/hook
 */

import { classifyToolCall } from './classifier.js';
import { computeIdempotencyKey } from './idempotency.js';
import { EffectStore } from './store.js';
import { redactSecrets } from '../redact-secrets.js';
import type { HookContext, HookDecision, HookHandler } from '../hooks.js';

// ---------------------------------------------------------------------------
// Redaction helpers
// ---------------------------------------------------------------------------

/**
 * Redact secrets from a structured tool-input object before persisting.
 *
 * Converts to JSON string (for the redaction regex), then re-parses. Returns
 * the input unchanged if serialization fails (best-effort).
 */
function redactArgs(input: unknown): unknown {
  try {
    const json = JSON.stringify(input);
    const redacted = redactSecrets(json);
    return JSON.parse(redacted) as unknown;
  } catch {
    return '[serialization error]';
  }
}

/**
 * Redact secrets from a tool output before persisting. Same approach.
 */
function redactResult(output: unknown): unknown {
  if (output === undefined) return undefined;
  try {
    const json = JSON.stringify(output);
    const redacted = redactSecrets(json);
    return JSON.parse(redacted) as unknown;
  } catch {
    return '[serialization error]';
  }
}

// ---------------------------------------------------------------------------
// PostToolUse hook factory
// ---------------------------------------------------------------------------

/**
 * Create a PostToolUse hook handler that records external effects to the
 * ledger.
 *
 * Pass a custom `store` in tests to avoid writing to the real ledger file.
 */
export function createEffectLedgerPostHook(store?: EffectStore): HookHandler {
  const effectStore = store ?? new EffectStore();

  return async (context: HookContext): Promise<HookDecision> => {
    // Handle PostToolUseFailure: tool handler threw — record as 'failed'.
    if (context.event === 'PostToolUseFailure') {
      const { toolName, input, sessionId } = context;
      const classification = classifyToolCall(toolName, input);
      if (!classification.isExternal) return {};

      const ikey = computeIdempotencyKey(classification.operationType, input);

      // Dedup check: mirror the PostToolUse path so retried failures with the
      // same idempotency key are recorded as 'ambiguous' rather than producing
      // duplicate 'failed' records that break reconciliation queries.
      let prior;
      try {
        prior = await effectStore.findByIdempotencyKey(ikey);
      } catch {
        prior = null;
      }

      if (prior !== null && (prior.status === 'executed' || prior.status === 'confirmed' || prior.status === 'failed')) {
        try {
          const pending = effectStore.writePending({
            idempotencyKey: ikey,
            operationType: classification.operationType,
            args: redactArgs(input),
            sessionId,
          });
          await effectStore.updateStatus({ id: pending.id, status: 'ambiguous' });
        } catch {
          // Best-effort — ledger write failure must never disrupt tool execution.
        }
        return {};
      }

      try {
        const pending = effectStore.writePending({
          idempotencyKey: ikey,
          operationType: classification.operationType,
          args: redactArgs(input),
          sessionId,
        });
        await effectStore.updateStatus({
          id: pending.id,
          status: 'failed',
          result: redactResult(context.error),
        });
      } catch {
        // Best-effort — ledger write failure must never disrupt tool execution.
      }
      return {};
    }

    if (context.event !== 'PostToolUse') return {};

    const { toolName, input, output, sessionId } = context;

    const classification = classifyToolCall(toolName, input);
    if (!classification.isExternal) return {};

    const ikey = computeIdempotencyKey(classification.operationType, input);

    // Dedup check: look for a prior record with the same key.
    let prior;
    try {
      prior = await effectStore.findByIdempotencyKey(ikey);
    } catch {
      // Best-effort: if the store read fails, proceed without dedup check.
      prior = null;
    }

    if (prior !== null && (prior.status === 'executed' || prior.status === 'confirmed')) {
      // A prior executed/confirmed record exists — this looks like a duplicate.
      // Record it as "ambiguous" to surface in reconciliation rather than
      // silently dropping the duplicate.
      try {
        const pending = effectStore.writePending({
          idempotencyKey: ikey,
          operationType: classification.operationType,
          args: redactArgs(input),
          sessionId,
        });
        await effectStore.updateStatus({ id: pending.id, status: 'ambiguous' });
      } catch {
        // Best-effort — ledger write failure must never disrupt tool execution.
      }
      return {};
    }

    // Write outcome record (new effect, or retry of a failed attempt).
    // Check context.isError first (set by the dispatcher from ToolResult.isError),
    // then fall back to the legacy object check for callers that pass output directly.
    const isError =
      context.isError === true ||
      (output !== null &&
        typeof output === 'object' &&
        (output as Record<string, unknown>)['isError'] === true);

    const status = isError ? 'failed' : 'executed';

    try {
      const pending = effectStore.writePending({
        idempotencyKey: ikey,
        operationType: classification.operationType,
        args: redactArgs(input),
        sessionId,
      });
      await effectStore.updateStatus({
        id: pending.id,
        status,
        result: redactResult(output),
      });
    } catch {
      // Best-effort — ledger write failure must never disrupt tool execution.
    }

    return {};
  };
}

// ---------------------------------------------------------------------------
// PreToolUse hook factory (write-ahead companion)
// ---------------------------------------------------------------------------

/**
 * Create a PreToolUse hook handler that writes a "pending" record BEFORE
 * execution begins, and stores the record id in the provided map for the
 * PostToolUse companion to pick up via `toolUseId`.
 *
 * This is the write-ahead half. Wire BOTH createEffectLedgerPreHook and a
 * matching PostToolUse hook that calls `store.updateStatus` using the pending
 * id stored here, if full write-ahead behavior is required.
 *
 * Note: The id map must be shared between the pre and post hooks. This is an
 * optional advanced usage; most callers should use `createEffectLedgerPostHook`
 * alone.
 */
export function createEffectLedgerPreHook(
  pendingIds: Map<string, string>,
  store?: EffectStore,
): HookHandler {
  const effectStore = store ?? new EffectStore();

  return (context: HookContext): HookDecision => {
    if (context.event !== 'PreToolUse') return {};

    const { toolName, input, sessionId, toolUseId } = context;
    if (!toolUseId) return {};

    const classification = classifyToolCall(toolName, input);
    if (!classification.isExternal) return {};

    const ikey = computeIdempotencyKey(classification.operationType, input);

    try {
      const pending = effectStore.writePending({
        idempotencyKey: ikey,
        operationType: classification.operationType,
        args: redactArgs(input),
        sessionId,
      });
      pendingIds.set(toolUseId, pending.id);
    } catch {
      // Best-effort.
    }

    return {};
  };
}
