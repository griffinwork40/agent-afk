/**
 * Per-session mutable state bag for {@link AnthropicDirectQuery}.
 *
 * Pure data — no async, no behavior, no invariants beyond what the type
 * already enforces. The orchestrator holds exactly one instance and reads
 * / writes its fields directly; tests can construct one in isolation if
 * they ever need to.
 *
 * The split between this bag and the orchestrator's other collaborators
 * is by lifecycle:
 *
 *   - SessionState (this file)  — single source of truth for fields the
 *     loop body mutates between turns (history, current model, permission
 *     mode, accumulated usage, closed flag) plus the cwd-dependent pair
 *     (userSystem + toolDispatcher) that `setCwd()` rebuilds in place.
 *
 *   - AbortCoordinator (sibling) — owns the per-turn AbortController
 *     and the closed-promise plumbing.
 *
 *   - RetryLayer (sibling)      — owns the writable `client`, auth mode,
 *     and the two dedup'd refresh / usage-limit promises.
 *
 * Nothing in this file should ever import from siblings — keep it a leaf.
 *
 * @module agent/providers/anthropic-direct/query/session-state
 */

import type { MessageParam } from '@anthropic-ai/sdk/resources';
import type { ProviderUsage } from '../../../provider.js';
import type { ToolDispatcher } from '../tool-dispatcher.js';

/**
 * Per-session mutable state. Construct one with {@link createSessionState}
 * to keep field-init semantics in one place.
 */
export interface SessionState {
  /**
   * Full conversation history. Mutated in place by `runTurn` (which
   * receives the same array reference through `RunTurnInput.messages`)
   * to append assistant + tool_result rounds. `compact()` splices the
   * older portion away. Tests on this field rely on identity, so never
   * reassign — only mutate in place.
   */
  readonly messages: MessageParam[];

  /** Model id passed to `messages.create` next turn. Updated by `setModel()`. */
  currentModel: string;

  /**
   * The model the caller *requested* — a short alias (`opus_1m`, `sonnet`, …)
   * or a full id. Distinct from `currentModel` because alias resolution is
   * lossy: `opus_1m` and `opus` both resolve to the same wire id
   * (`claude-opus-5`). Opus 5 is natively 1M, so both now report the same
   * *window* — but the alias still selects the auto-compaction limit, because
   * the `_1m` suffix short-circuits the reduced working budget (base `opus`
   * compacts at 200k, `opus_1m` at the full 1M — see MODEL_AUTOCOMPACT_BUDGET
   * in model-limits.ts). `currentModel` carries the wire id sent to the
   * Messages API; `requestedModel` carries the alias so `contextLimitFor()` and
   * `autoCompactLimitFor()` can recover the correct limit for
   * `getContextUsage()` and the auto-compact threshold.
   * Updated by `setModel()` alongside `currentModel`.
   */
  requestedModel: string;

  /**
   * Permission mode read by `composeSystem()` each turn. When `'plan'`,
   * the plan-mode addendum is appended to the system payload. Updated by
   * `setPermissionMode()`.
   */
  currentPermissionMode: string;

  /**
   * User-supplied system prompt text. Mutable so `setCwd()` can flush a
   * fresh copy containing the new `# Environment\n- Working directory:`
   * line without resetting the session.
   */
  userSystem: string | null;

  /**
   * Tool dispatcher closed over the current cwd. Mutable so `setCwd()`
   * can swap in a fresh dispatcher whose bash/grep/glob handlers see
   * the new cwd. The orchestrator passes this reference through to
   * `runTurn` each turn via `RunTurnInput.toolDispatcher`.
   */
  toolDispatcher: ToolDispatcher;

  /**
   * `accumulatedUsage` from the last completed turn (loop.ts:230). After
   * the sibling fix in `sumProviderUsage`, the cache fields here hold the
   * latest iteration's footprint, so `input + output + cached + creation`
   * approximates the model's final-call context size — used by
   * `getContextUsage()` to surface the REPL status-line percentage.
   */
  lastUsage: ProviderUsage | null;

  /**
   * Set to `true` by `close()`. Every place that loops over the prompt
   * stream or yields from a sub-generator checks this so we don't keep
   * pulling new events after the consumer has detached.
   */
  closed: boolean;

  /**
   * Auto-compaction threshold as a fraction of the context window (0–1).
   * `undefined` means auto-compaction is disabled for this session.
   * Set at construction time from `AgentConfig.autoCompact`; never mutated
   * after session start.
   *
   * The query loop checks `shouldAutoCompact(usedTokens, contextLimit,
   * this.state.autoCompactThreshold)` after each turn completes and fires
   * `this.compact()` when truthy — subject to the `abort.isIdle()` guard.
   */
  autoCompactThreshold: number | undefined;
}

/**
 * Initial state for a fresh query. `initialMessages` is cloned (shallow)
 * so the caller's array isn't shared by reference — the loop mutates the
 * stored array, and we don't want that surfacing back through the input.
 */
export function createSessionState(opts: {
  model: string;
  /**
   * Requested alias/id (see {@link SessionState.requestedModel}). Defaults to
   * `model` when the caller has no distinct alias to preserve — for the
   * non-1M aliases and full ids this is equivalent, so existing callers and
   * tests keep their behaviour unchanged.
   */
  requestedModel?: string;
  permissionMode: string;
  userSystem: string | null;
  toolDispatcher: ToolDispatcher;
  initialMessages?: MessageParam[];
  autoCompactThreshold?: number;
  /**
   * Conservative token estimate seeded from the last completed turn of a
   * restored session (#1294). When non-zero, used as the initial `lastUsage`
   * so the context-overflow guard fires correctly on the first resumed turn
   * instead of being skipped (the guard skips when `lastUsage` is null,
   * treating it as a fresh session with no prior context to check against).
   *
   * Callers MUST over-estimate rather than under-estimate: a false positive
   * triggers compaction (recoverable) while a false negative lets an
   * already-full context reach the wire and get rejected with HTTP 400.
   */
  initialUsageInputTokens?: number;
}): SessionState {
  const initialLastUsage: ProviderUsage | null =
    opts.initialUsageInputTokens !== undefined && opts.initialUsageInputTokens > 0
      ? { inputTokens: opts.initialUsageInputTokens, stopReason: null, resultSubtype: 'success', isError: false }
      : null;
  return {
    messages: opts.initialMessages ? [...opts.initialMessages] : [],
    currentModel: opts.model,
    requestedModel: opts.requestedModel ?? opts.model,
    currentPermissionMode: opts.permissionMode,
    userSystem: opts.userSystem,
    toolDispatcher: opts.toolDispatcher,
    lastUsage: initialLastUsage,
    closed: false,
    autoCompactThreshold: opts.autoCompactThreshold,
  };
}
