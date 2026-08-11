/**
 * Shared type surface for the ghost-text suggestion engine.
 *
 * Holds the interfaces every suggestion module needs — the injected session
 * context, the completion-call shape, and the engine's public contract. They
 * live here rather than in `./suggest` so the tier modules can depend on the
 * types without importing the composition root (and so the composition root
 * stays a composition root). `suggest.ts` re-exports everything in this file,
 * so `./input/suggest.js` remains the public import path.
 *
 * @module cli/input/suggest-types
 */

import type { ModelProvider } from '../../agent/provider.js';
import type { ProviderRouteHints } from '../../agent/providers/index.js';

/**
 * Context supplied by the REPL compositor wiring. The engine does NOT reach
 * into the session or REPL directly — everything it needs comes through here.
 * This makes the engine unit-testable without any live infrastructure.
 */
export interface SuggestContext {
  /** Model id in use for the current session (e.g. `'claude-sonnet-4-5'`). */
  model: string;
  /** Explicit API key to forward to the provider, if available. */
  apiKey?: string;
  /** Endpoint override (local shim / Anthropic-shim baseURL), if set. */
  baseUrl?: string;
  /** Absolute working directory for the session (basename used in prompt). */
  cwd: string;
  /**
   * Return the REPL history list, newest entry first.
   * Used for Tier 1 prefix-match.
   */
  getHistory(): string[];
  /**
   * Return the top dropdown candidate's `.value` for the current buffer, or
   * null when the dropdown is closed or has no entries.
   * Used for Tier 1 prefix-match against slash / @file / --flag completions.
   */
  getDropdownTopCandidate(buffer: string): string | null;
  /**
   * Return the last 1–2 transcript turns, truncated, for the LLM prompt.
   * Returning an empty string is fine.
   */
  getTranscriptTail(): string;
  /**
   * The most-recently submitted user input (the entry at the top of the
   * history ring, pushed at the start of the previous turn). Used by
   * `getDeterministicGhost` to skip echoing the last submission as a
   * Tier-1 history suggestion. Optional so existing test doubles that
   * predate the field stay valid; an absent value means "unknown".
   */
  lastSubmitted?: string;
  /** Return recent submitted commands (newest first, up to ~5). */
  getRecentCommands(): string[];
  /** Whether the LLM suggestion tier is active (`AFK_SUGGEST_ENABLED` truthy). */
  llmEnabled(): boolean;
  /**
   * Whether empty-prompt suggestions are active (`AFK_SUGGEST_PROMPT` truthy).
   * Optional so existing test doubles that predate the feature stay valid; an
   * absent implementation means "disabled".
   */
  promptSuggestEnabled?(): boolean;
}

/** Arguments accepted by a suggestion-class completion call. */
export interface CompleteRequest {
  system: string;
  user: string;
  model: string;
  maxTokens: number;
  signal: AbortSignal;
  apiKey?: string;
  baseUrl?: string;
}

/** Minimal completion call shape shared by both suggestion producers. */
export type CompleteFn = (req: CompleteRequest) => Promise<string>;

/**
 * Options accepted by `createSuggestEngine`. All optional; defaults apply.
 */
export interface SuggestEngineOptions {
  /**
   * Inject a `completeFn` to replace the real provider call in tests.
   * Signature mirrors `ModelProvider.complete` but takes only the args the
   * engine uses. Returning `null` or throwing causes Tier 2 to return null.
   */
  completeFn?: CompleteFn;

  /**
   * Inject the provider resolver (tests). Defaults to the real `resolveProvider`.
   * The engine memoizes the resolved provider per kind and closes it on
   * `dispose()`, so production constructs at most one provider per kind instead
   * of a fresh one (each opening a SQLite MemoryStore) per debounced keystroke.
   */
  resolveProviderFn?: (
    model: string | undefined,
    hints: ProviderRouteHints | undefined,
  ) => ModelProvider;

  /** Override debounce delay (ms). Useful in tests to set 0. */
  debounceMs?: number;

  /** Override abort timeout (ms). */
  timeoutMs?: number;

  /**
   * Invoked when a suggestion completion throws (auth failure, network error,
   * 404 model, unreachable endpoint). Default: no-op. The REPL wires this to
   * `debugLog` so failures are visible under `AFK_DEBUG=1` instead of being
   * silently swallowed. NOT called for the expected abort/timeout path.
   */
  onError?: (err: unknown) => void;
}

export interface SuggestEngine {
  /**
   * Tier 1: synchronous deterministic ghost.
   * Returns the full candidate string if `buffer` is a strict non-empty prefix,
   * or null when no match is found.
   */
  getDeterministicGhost(buffer: string, ctx: SuggestContext): string | null;

  /**
   * Combined entry point. Runs Tier 1 first; falls through to Tier 2 when
   * Tier 1 misses and `ctx.llmEnabled()` is true.
   * Never throws — all errors resolve to null.
   */
  getGhost(buffer: string, ctx: SuggestContext): Promise<string | null>;

  /**
   * Generate an empty-prompt suggestion from session context and hold it for
   * the next {@link SuggestEngine.peekPromptSuggestion}. Call when the prompt
   * is handed back to the user at the start of a turn. No-op unless both
   * `llmEnabled()` and `promptSuggestEnabled()` are true. Never throws.
   */
  primePromptSuggestion(ctx: SuggestContext): Promise<void>;

  /**
   * The suggestion primed for an empty buffer, or null. Synchronous so
   * `updateGhost` can consult it on the render path.
   */
  peekPromptSuggestion(): string | null;

  /** Drop any primed suggestion (accepted, dismissed, or superseded). */
  clearPromptSuggestion(): void;

  /** Cancel any pending debounce timer. Call on REPL cleanup. */
  dispose(): void;
}
