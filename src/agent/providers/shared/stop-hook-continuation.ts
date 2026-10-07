/**
 * Provider-side seam: blocking Stop hook → same-turn continuation (issue #2714).
 *
 * Called BEFORE `turn.completed` is emitted, i.e. inside the provider loop
 * between the assistant-message push and the journal sync / turn.completed
 * yield. The session-layer Stop dispatch (turn-stream-runner.stop.ts) moved
 * here from the session `done` event because `done` IS the surface boundary —
 * continuation must happen before the surface ever sees the completed turn.
 *
 * Ordering invariant (referenced in callers as "stop-hook-continuation rule"):
 *   1. Push assistant content to messages (done by the provider before calling us).
 *   2. Call `runBeforeTurnEnd` — dispatches Stop, returns continueWith if blocked.
 *   3. If continueWith: push the framework user message, return it for re-entry.
 *   4. If no continueWith: return undefined — caller proceeds to journal sync
 *      and `turn.completed` normally.
 *
 * Cap enforcement: AFK_STOP_HOOK_MAX_CONTINUATIONS (default 2, 0 = no
 * continuation). At 0 the seam does not dispatch at all and reports
 * `dispatched: false`, so the session-layer fallback still fires Stop once.
 * The cap is per-turn and shared across all hooks — two blocking hooks each
 * consume from the same counter. On cap the hook result is treated as
 * non-blocking and the turn ends normally.
 *
 * Never continues on a runtime-imposed end. The caller gates the call:
 * aborts, refusals, max_tokens, overload exhaustion, tool-loop cap, and
 * wind-down rounds are all distinguished by the caller and bypass this seam.
 *
 * @module agent/providers/shared/stop-hook-continuation
 */

import { env } from '../../../config/env.js';
import { debugLog } from '../../../utils/debug.js';
import { redactSecrets } from '../../redact-secrets.js';
import { emitSessionPhase } from '../../trace/emit.js';
import type { HookRegistry, StopContext } from '../../hooks.js';
import { dispatchStopHook } from '../../session/hooks-dispatch.js';
import { classifyDoneEvidence, doneHasCorroboratingEvidence, type ToolEventMin } from '../../done-evidence.js';
import { parseTerminalState } from '../../outcomes/terminal-state.js';
import type { AgentConfig } from '../../types.js';
import type { Message } from '../../types.js';

// ---------------------------------------------------------------------------
// Cap resolution
// ---------------------------------------------------------------------------

/** Default continuation cap per turn. CC has no cap; ours must. */
const DEFAULT_MAX_CONTINUATIONS = 2;

/** Max chars of the block reason to include in the trace. */
const REASON_HEAD_MAX = 200;

/**
 * Max chars of the block reason forwarded to the provider as the
 * continuation user message. Hook output is operator-authored, but an
 * unbounded reason can push the request past provider limits (HTTP 400).
 */
export const CONTINUE_WITH_MAX_CHARS = 4_000;

/** Bound `text` to {@link CONTINUE_WITH_MAX_CHARS}, appending a marker when cut. */
export function capContinueWith(text: string): string {
  if (text.length <= CONTINUE_WITH_MAX_CHARS) return text;
  const dropped = text.length - CONTINUE_WITH_MAX_CHARS;
  return `${text.slice(0, CONTINUE_WITH_MAX_CHARS)}\n… [stop hook reason truncated: ${dropped} more chars]`;
}

/**
 * Resolve the per-turn continuation cap from AFK_STOP_HOOK_MAX_CONTINUATIONS.
 * 0 disables continuation. Out-of-range / non-numeric falls back to default.
 */
export function resolveMaxContinuations(): number {
  const raw = env.AFK_STOP_HOOK_MAX_CONTINUATIONS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_CONTINUATIONS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MAX_CONTINUATIONS;
}

// ---------------------------------------------------------------------------
// BeforeTurnEnd context
// ---------------------------------------------------------------------------

/** All the context the seam needs from the provider at turn-end time. */
export interface BeforeTurnEndContext {
  /** The session-wide config — provides hookRegistry, traceWriter, parentSessionId. */
  readonly config: AgentConfig;
  /** Session id for trace attribution. */
  readonly sessionId: string;
  /** Live abort signal — abort beats a block decision (non-negotiable). */
  readonly signal: AbortSignal;
  /** Full conversation history including the just-pushed assistant turn. */
  readonly messages: readonly Message[];
  /**
   * The just-finished assistant turn's text, passed directly from the provider.
   * When set, `buildStopContext` uses this instead of scanning `messages` for
   * the last assistant entry — avoids the stale-history bug where the provider
   * seam fires before the session conversation history is updated (Finding 3).
   */
  readonly assistantText?: string;
  /** This turn's tool events (for Done evidence classification). */
  readonly toolEvents: readonly ToolEventMin[];
  /** Surface name for trace metadata. */
  readonly surface?: string;
  /**
   * Whether the surface has a next user turn for injectContext delivery.
   * REPL and Telegram: true. Daemon / afk chat: false.
   */
  readonly hasNextTurn: boolean;
  /** Callbacks for non-blocking results (injectContext, block notice on REPL). */
  readonly wiring: BeforeTurnEndWiring | undefined;
  /** 0-based continuation round index within this turn. 0 = first dispatch. */
  readonly continuation: number;
}

/**
 * Surface-side callbacks for non-blocking Stop results at the turn-end seam.
 * Mirrors the StopWiring in session-types.ts but lives at the provider layer
 * because the seam sits before `turn.completed`.
 */
export interface BeforeTurnEndWiring {
  /** Stash injectContext for the next user turn (REPL/Telegram only). */
  onStopInjectContext?: (text: string) => void;
  /** The Stop handler blocked but the cap was already reached — log only. */
  onStopBlocked?: (reason: string | undefined) => void;
  /** A Stop handler exceeded STOP_HOOK_HANDLER_TIMEOUT_MS. */
  onStopTimeout?: () => void;
}

/** Returned by `runBeforeTurnEnd`. */
export interface BeforeTurnEndResult {
  /**
   * When set, the caller MUST push this as a user message and run another
   * model round in the same turn (i.e. `continue` the provider loop).
   * Undefined means proceed to journal sync and `turn.completed` normally.
   */
  readonly continueWith?: string;
  /** Updated continuation counter to thread into the next dispatch. */
  readonly nextContinuation: number;
  /**
   * `true` when this call actually dispatched the Stop hook chain. `false` /
   * absent on every early return (no registry, fork, cap already reached), so
   * the session layer can fall back to its own dispatch — e.g. with
   * AFK_STOP_HOOK_MAX_CONTINUATIONS=0, Stop still fires, it just never
   * continues the turn.
   */
  readonly dispatched?: boolean;
}

// ---------------------------------------------------------------------------
// Helper: build StopContext from turn state
// ---------------------------------------------------------------------------

/** The text of the most recent assistant message in `messages`, or ''. */
function lastAssistantText(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === 'assistant') return m.content;
  }
  return '';
}

function buildStopContext(ctx: BeforeTurnEndContext): StopContext {
  // Finding 3: prefer the directly-passed assistantText over scanning history,
  // because the provider seam may fire before the session conversation history
  // is updated with the just-finished assistant turn.
  const text = ctx.assistantText ?? lastAssistantText(ctx.messages);
  const terminalKind = parseTerminalState(text)?.kind;
  const isDone = terminalKind === 'done';
  const successfulToolNames = ctx.toolEvents
    .filter((e) => !e.isError)
    .map((e) => e.toolName);
  return {
    event: 'Stop' as const,
    sessionId: ctx.sessionId,
    ...(terminalKind !== undefined ? { terminalState: terminalKind } : {}),
    ...(isDone ? { doneHasCorroboratingEvidence: doneHasCorroboratingEvidence(ctx.toolEvents) } : {}),
    ...(isDone ? { doneEvidenceClassification: classifyDoneEvidence(ctx.toolEvents) } : {}),
    ...(ctx.continuation > 0 ? { stopHookActive: true } : {}),
    continuation: ctx.continuation,
    assistantText: text,
    successfulToolNames,
  };
}

// ---------------------------------------------------------------------------
// Core seam function
// ---------------------------------------------------------------------------

/**
 * Provider-side stop-hook seam: dispatch Stop and, when blocked, return the
 * block reason as `continueWith` so the provider loop can re-enter.
 *
 * Ordering (stop-hook-continuation rule):
 *   caller pushes assistant turn → calls runBeforeTurnEnd → if continueWith
 *   returned, caller pushes the user continuation message and re-runs the
 *   model → otherwise caller proceeds to journal sync + turn.completed.
 *
 * Guards:
 *   - No-op when hookRegistry or config.parentSessionId is set (forks excluded).
 *   - 0 = no continuation (seam does not dispatch); already-reached cap also skips.
 *   - AbortError propagates; all other errors are swallowed and treated as pass.
 *
 * @param ctx   Turn-end context from the provider.
 * @returns     `continueWith` when a continuation should run, else undefined.
 *              Always returns `nextContinuation` for the caller to thread forward.
 */
export async function runBeforeTurnEnd(ctx: BeforeTurnEndContext): Promise<BeforeTurnEndResult> {
  const noop: BeforeTurnEndResult = { nextContinuation: ctx.continuation };
  const registry: HookRegistry | undefined = ctx.config.hookRegistry;

  // Ordering invariant: forks get SubagentStop, not Stop. parentSessionId is
  // the canonical gate (same as turn-stream-runner.stop.ts).
  if (!registry || ctx.config.parentSessionId !== undefined) return noop;

  const maxContinuations = resolveMaxContinuations();

  // If continuation is already at the cap, emit cap event and end normally.
  // This path is hit when the PREVIOUS round's Stop blocked and we continued,
  // and now Stop blocks AGAIN at the cap boundary.
  if (maxContinuations === 0 || ctx.continuation >= maxContinuations) {
    if (ctx.continuation > 0) {
      // Only emit cap event when we actually HAD continuations (not on plain 0-cap).
      void emitSessionPhase(ctx.config.traceWriter, {
        phase: 'stop_hook_cap_reached',
        metadata: { cap: maxContinuations },
      });
      debugLog('[stop-hook-continuation] cap reached', {
        sessionId: ctx.sessionId,
        continuation: ctx.continuation,
        cap: maxContinuations,
      });
    }
    return noop;
  }

  const stopCtx = buildStopContext(ctx);
  const surface = typeof ctx.config.surface === 'string' ? ctx.config.surface : undefined;
  const result = await dispatchStopHook(registry, stopCtx, {
    hasNextTurn: ctx.hasNextTurn,
    surface,
    signal: ctx.signal,
    traceWriter: ctx.config.traceWriter,
  });
  const dispatchedNoop: BeforeTurnEndResult = { ...noop, dispatched: true };

  // Non-blocking paths: deliver injectContext / timeout to surface callbacks.
  if (!result.wasBlocked) {
    if (result.wasTimeout) {
      ctx.wiring?.onStopTimeout?.();
    } else if (result.injectContext) {
      ctx.wiring?.onStopInjectContext?.(result.injectContext);
    }
    return dispatchedNoop;
  }

  // --- Block path: attempt same-turn continuation ---
  const nextContinuation = ctx.continuation + 1;

  // Cap check at new value — the round after this one will hit the cap check above.
  if (nextContinuation > maxContinuations) {
    // Emit cap event and treat as non-blocking (turn ends normally).
    void emitSessionPhase(ctx.config.traceWriter, {
      phase: 'stop_hook_cap_reached',
      metadata: { cap: maxContinuations },
    });
    ctx.wiring?.onStopBlocked?.(result.blockedReason);
    debugLog('[stop-hook-continuation] block cap hit — ending turn', {
      sessionId: ctx.sessionId,
      nextContinuation,
      cap: maxContinuations,
    });
    return { nextContinuation, dispatched: true };
  }

  // Build the framework user message from the block reason, bounded so an
  // oversized hook reason cannot 400 the provider request.
  const reasonText = result.blockedReason ?? 'Stop hook blocked this turn.';
  const continueWith = capContinueWith(reasonText);

  // Observability: truncate + redact the reason for the trace.
  const rawReasonHead = reasonText.length > REASON_HEAD_MAX
    ? reasonText.slice(0, REASON_HEAD_MAX) + '… (truncated)'
    : reasonText;
  const reasonHead = redactSecrets(rawReasonHead.replace(/\r?\n/g, ' '));

  void emitSessionPhase(ctx.config.traceWriter, {
    phase: 'stop_hook_continuation',
    metadata: {
      continuation: nextContinuation,
      reasonHead,
    },
  });

  debugLog('[stop-hook-continuation] continuing turn', {
    sessionId: ctx.sessionId,
    continuation: nextContinuation,
    cap: maxContinuations,
    reasonHead,
  });

  return { continueWith, nextContinuation, dispatched: true };
}
