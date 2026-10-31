/* Write-ahead hooks for the existing external-effect ledger. */
import { classifyToolCall } from './classifier.js';
import { computeIdempotencyKey } from './idempotency.js';
import { remoteIdempotencyInput } from './remote-idempotency.js';
import { EffectStore } from './store.js';
import { redactSecrets } from '../redact-secrets.js';
import type { HookContext, HookDecision, HookHandler } from '../hooks.js';
import type { EffectRecord, EffectStatus } from './types.js';

function redact(value: unknown): unknown {
  if (value === undefined) return undefined;
  try { return JSON.parse(redactSecrets(JSON.stringify(value))) as unknown; }
  catch { return '[serialization error]'; }
}

function identity(context: HookContext): { key: string; operationType: string } | null {
  if (context.event !== 'PreToolUse' && context.event !== 'PostToolUse' && context.event !== 'PostToolUseFailure') return null;
  try {
    const classification = classifyToolCall(context.toolName, context.input);
    if (!classification.isExternal) return null;
    return {
      key: computeIdempotencyKey(classification.operationType, context.input),
      operationType: classification.operationType,
    };
  } catch { return null; }
}

/** Only explicit pre-send refusals or a definitive HTTP 4xx prove non-application. */
function definitiveFailure(context: HookContext): boolean {
  if (context.event === 'PostToolUseFailure') {
    return /^(?:web_request blocked:|web_request credential error:|Telegram is not configured)/i.test(context.error);
  }
  if (context.event !== 'PostToolUse') return false;
  const output = context.output;
  if (context.toolName === 'web_request' && typeof output === 'string') {
    try {
      const response = JSON.parse(output) as { status?: number };
      // 408/409/425/429 do not establish non-application (timeout, conflict,
      // early-data retry or rate-limit may follow a prior applied request).
      if (typeof response.status === 'number' && response.status >= 400 && response.status < 500 &&
          ![408, 409, 425, 429].includes(response.status)) return true;
    } catch { /* An unparseable response is not a definitive rejection. */ }
  }
  if (context.isError !== true && !(output && typeof output === 'object' && (output as { isError?: boolean }).isError)) return false;
  const text = typeof output === 'string' ? output : JSON.stringify(output);
  return /^(?:web_request blocked:|web_request credential error:|Telegram is not configured)/i.test(text);
}

function outcome(context: HookContext): Exclude<EffectStatus, 'pending'> {
  if (definitiveFailure(context)) return 'failed';
  if (context.event === 'PostToolUseFailure') return 'unknown';
  if (context.event === 'PostToolUse') {
    const output = context.output;
    if (context.toolName === 'web_request' && typeof output === 'string') {
      try {
        const { status } = JSON.parse(output) as { status?: number };
        // Treat any HTTP >= 400 as unknown here. definitiveFailure() carves out
        // the narrow set of statuses that prove non-application (400-class
        // excluding 408/409/425/429). Keep the two in sync: if definitiveFailure
        // is updated to include new statuses, this branch may need updating too.
        if (typeof status === 'number' && status >= 400) return 'unknown';
      } catch { /* Unparseable errors remain uncertain when flagged below. */ }
    }
    if (context.isError || (output && typeof output === 'object' && (output as { isError?: boolean }).isError)) return 'unknown';
  }
  return 'executed';
}

/** Pair hooks with one store and in-flight map, including calls made by child sessions. */
export function createEffectLedgerHooks(store: EffectStore = new EffectStore()): { pre: HookHandler; post: HookHandler } {
  const pendingIds = new Map<string, string>();
  const activeIds = new Set<string>();
  const admitting = new Set<string>();
  const duplicateIds = new Set<string>();

  const pre: HookHandler = async (context): Promise<HookDecision> => {
    if (context.event !== 'PreToolUse') return {};
    const effect = identity(context);
    if (!effect) return {};
    // Invariant: parallel batch admission must not both read an empty ledger
    // before either append completes. Reserve the key across the async read.
    const admissionKey = JSON.stringify([context.sessionId, effect.key]);
    if (admitting.has(admissionKey)) {
      return { decision: 'block', reason: 'An identical external action is being admitted. Wait for its outcome before retrying.' };
    }
    admitting.add(admissionKey);
    try {
      const prior = await store.findByIdempotencyKey(effect.key, context.sessionId);
      if (prior && (prior.status === 'unknown' || prior.status === 'pending')) {
        if (activeIds.has(prior.id)) {
          return { decision: 'block', reason: 'An identical external action is still in flight. Wait for its outcome before retrying.' };
        }
        if (prior.retryAcknowledgedAt === undefined) {
          await store.acknowledgeRetry(prior.id);
          return {
            decision: 'block',
            reason: `External action outcome unknown (ledger record ${prior.id}). Verify remote state first (for example check whether the PR or message exists). After verification, re-issue the identical call to proceed; that retry will be linked to this record.`,
          };
        }
      }
      const remote = remoteIdempotencyInput(context.toolName, context.input, prior);
      // Invariant: the intent append completes before the dispatcher can invoke the remote handler.
      const pending = store.writePending({
        idempotencyKey: effect.key,
        operationType: effect.operationType,
        args: redact(context.input),
        sessionId: context.sessionId,
        ...(prior && (prior.status === 'unknown' || prior.status === 'pending') ? { retryOf: prior.id } : {}),
        ...(remote.remoteIdempotencyKey !== undefined ? { remoteIdempotencyKey: remote.remoteIdempotencyKey } : {}),
      });
      activeIds.add(pending.id);
      if (context.toolUseId) pendingIds.set(context.toolUseId, pending.id);
      if (prior && (prior.status === 'executed' || prior.status === 'confirmed' || prior.status === 'ambiguous')) {
        duplicateIds.add(pending.id);
        return { ...(remote.updatedInput ? { updatedInput: remote.updatedInput } : {}), injectContext: 'An identical external action already executed in this session. This call is allowed because intentional repetition is possible; verify that another send is intended.' };
      }
      return remote.updatedInput ? { updatedInput: remote.updatedInput } : {};
    } catch {
      // Invariant: ledger I/O is best-effort; a broken ledger must never brick tool execution.
      return {};
    } finally {
      admitting.delete(admissionKey);
    }
    return {};
  };

  const post: HookHandler = async (context): Promise<HookDecision> => {
    if (context.event !== 'PostToolUse' && context.event !== 'PostToolUseFailure') return {};
    const effect = identity(context);
    if (!effect) return {};
    const id = context.toolUseId ? pendingIds.get(context.toolUseId) : undefined;
    if (context.toolUseId) pendingIds.delete(context.toolUseId);
    if (id) activeIds.delete(id);
    try {
      // Standalone post-hook callers without a pre-hook still get a recorded outcome.
      // Note: this path calls writePending + updateStatus — two fsynced appends per
      // invocation. The pre+post paired path pays the same cost spread across two
      // hook calls; this path pays it in one. Acceptable for correctness; callers
      // that need lower write amplification should prefer the paired hook API.
      const prior = id ? null : await store.findByIdempotencyKey(effect.key, context.sessionId);
      const record = id ? { id } : store.writePending({
        idempotencyKey: effect.key, operationType: effect.operationType,
        args: redact(context.input), sessionId: context.sessionId,
      });
      const duplicate = id ? duplicateIds.has(id) : !!prior &&
        (prior.status === 'executed' || prior.status === 'confirmed' || prior.status === 'ambiguous');
      await store.updateStatus({
        id: record.id, status: duplicate ? 'ambiguous' : outcome(context),
        result: redact(context.event === 'PostToolUseFailure' ? context.error : context.output),
      });
    } catch { /* An observer must not change the tool result. */ }
    finally { if (id) duplicateIds.delete(id); }
    return {};
  };
  return { pre, post };
}

/** Compatibility surface for standalone post-hook consumers. */
export function createEffectLedgerPostHook(store?: EffectStore): HookHandler {
  return createEffectLedgerHooks(store).post;
}

/** Compatibility surface for callers that provide their own in-flight id map. */
export function createEffectLedgerPreHook(pendingIds: Map<string, string>, store?: EffectStore): HookHandler {
  const effectStore = store ?? new EffectStore();
  return async (context): Promise<HookDecision> => {
    if (context.event !== 'PreToolUse' || !context.toolUseId) return {};
    const effect = identity(context);
    if (!effect) return {};
    try {
      const record: EffectRecord = effectStore.writePending({
        idempotencyKey: effect.key, operationType: effect.operationType,
        args: redact(context.input), sessionId: context.sessionId,
      });
      pendingIds.set(context.toolUseId, record.id);
    } catch { /* Best effort. */ }
    return {};
  };
}
