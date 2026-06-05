/**
 * Ghost-text suggestion engine for the interactive REPL.
 *
 * Two tiers:
 *
 *   Tier 1 — deterministic, synchronous, always active.
 *     Returns the full completion candidate when `buffer` is a strict non-empty
 *     prefix of a known entry. Sources in priority order:
 *       (a) the top dropdown candidate exposed by `ctx.getDropdownTopCandidate`
 *       (b) the most-recent history entry that starts with `buffer`
 *     Returns the FULL candidate string; the caller renders the suffix as ghost
 *     text. Never returns a string equal to buffer.
 *
 *   Tier 2 — LLM fallback, opt-in via `ctx.llmEnabled()`.
 *     Only fires when Tier 1 has no match AND `buffer.length >= MIN_LLM_CHARS`.
 *     Debounced (DEBOUNCE_MS idle), hard-aborted (TIMEOUT_MS), result cached
 *     by buffer. Never throws — any error resolves to null.
 *
 * Design: pure and dependency-injected. The engine holds no global state
 * except its own debounce timer and a bounded result cache. Construct one per
 * REPL session.
 *
 * @module cli/input/suggest
 */

import { providerForModel, resolveProvider, type ProviderRouteHints } from '../../agent/providers/index.js';
import type { ModelProvider } from '../../agent/provider.js';
import { env } from '../../config/env.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Minimum buffer length before Tier 2 (LLM) fires. */
const MIN_LLM_CHARS = 3;

/** Idle delay before the LLM request is dispatched (ms). */
const DEBOUNCE_MS = 250;

/**
 * Hard abort deadline for a single LLM request (ms). Must comfortably exceed
 * the round-trip latency of a suggestion-class model — a value too close to
 * DEBOUNCE_MS aborts most real-API calls before they return (wasted spend and
 * no ghost). The request is fully async, so a longer ceiling never blocks
 * input; the only cost is a slightly later-appearing ghost.
 */
const TIMEOUT_MS = 1500;

/** Upper bound on cached suggestion results; FIFO eviction beyond this. */
const MAX_CACHE_ENTRIES = 500;

// ── Context interface ─────────────────────────────────────────────────────────

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
  /** Return recent submitted commands (newest first, up to ~5). */
  getRecentCommands(): string[];
  /** Whether the LLM suggestion tier is active (`AFK_SUGGEST_ENABLED` truthy). */
  llmEnabled(): boolean;
}

// ── Prompt helpers ────────────────────────────────────────────────────────────

function buildSystem(): string {
  return (
    'Predict the single most likely completion of the user\'s in-progress REPL input. ' +
    'Return ONLY the completed line — no explanation, no preamble, no trailing newline.'
  );
}

function buildUser(buffer: string, ctx: SuggestContext): string {
  const cwdBase = ctx.cwd.split('/').filter(Boolean).pop() ?? ctx.cwd;
  const recentCmds = ctx.getRecentCommands().slice(0, 5);
  const transcript = ctx.getTranscriptTail();
  const parts: string[] = [];
  parts.push(`cwd: ${cwdBase}`);
  if (recentCmds.length > 0) {
    parts.push(`recent: ${recentCmds.join(' | ')}`);
  }
  if (transcript.length > 0) {
    parts.push(`context: ${transcript.slice(0, 200)}`);
  }
  parts.push(`input: ${buffer}`);
  return parts.join('\n');
}

// ── Sanitization ────────────────────────────────────────────────────────────

/**
 * Strip terminal control sequences and control characters from untrusted
 * model output before it is rendered as ghost text or seeded into the input
 * buffer.
 *
 * Contract: LLM completions are untrusted input. A malicious or buggy
 * completion endpoint (a local OpenAI shim, a compromised proxy) could emit
 * ANSI/CSI cursor moves, `ESC[2J` screen clears, or OSC sequences (e.g. OSC 52
 * clipboard writes). Even a well-behaved model can return an embedded newline,
 * which would break the compositor's single-line input render and corrupt its
 * DECSTBM scroll-region accounting. We remove all of it at this boundary so
 * both the render path AND the Tab/→ accept-into-buffer path are covered.
 *
 * Order matters: full escape sequences are removed before lone control bytes —
 * stripping the leading ESC first would leave the payload (e.g. `[2J`) behind
 * as visible text.
 */
export function stripGhostControlChars(text: string): string {
  return text
    // CSI: ESC [ … final-byte  (cursor moves, SGR, erase line/screen, …)
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    // OSC: ESC ] … (BEL- or ST-terminated)  (title set, clipboard, hyperlinks)
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, '')
    // Other two-byte Fe escapes (ESC followed by one byte in @–_)
    .replace(/\u001b[@-_]/g, '')
    // Remaining C0 controls (incl. \n \r \t \b), DEL, and C1 controls
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
}

// ── Safety guard ──────────────────────────────────────────────────────────────

/**
 * Verify the LLM reply is a valid continuation of `buffer`.
 * The reply must start with `buffer` exactly (case-sensitive) and be strictly
 * longer, or equal to `buffer` (which we then reject as not a completion).
 */
function isValidContinuation(buffer: string, reply: string): boolean {
  const trimmed = reply.trim();
  return trimmed.startsWith(buffer) && trimmed.length > buffer.length;
}

// ── Engine ────────────────────────────────────────────────────────────────────

/**
 * Options accepted by `createSuggestEngine`. All optional; defaults apply.
 */
export interface SuggestEngineOptions {
  /**
   * Inject a `completeFn` to replace the real provider call in tests.
   * Signature mirrors `ModelProvider.complete` but takes only the args the
   * engine uses. Returning `null` or throwing causes Tier 2 to return null.
   */
  completeFn?: (args: {
    system: string;
    user: string;
    model: string;
    maxTokens: number;
    signal: AbortSignal;
    apiKey?: string;
    baseUrl?: string;
  }) => Promise<string>;

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
   * Invoked when a Tier-2 completion throws (auth failure, network error, 404
   * model, unreachable endpoint). Default: no-op. The REPL wires this to
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

  /** Cancel any pending debounce timer. Call on REPL cleanup. */
  dispose(): void;
}

/**
 * Construct a fresh `SuggestEngine`. One instance per REPL session.
 */
export function createSuggestEngine(opts: SuggestEngineOptions = {}): SuggestEngine {
  const debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;

  // Tier 2 state
  let debounceHandle: ReturnType<typeof setTimeout> | null = null;
  let pendingResolve: ((v: string | null) => void) | null = null;
  let pendingController: AbortController | null = null;
  const cache = new Map<string, string | null>();

  // Resolve + memoize Tier-2 providers, keyed by provider kind.
  //
  // resolveProvider() returns a FRESH provider on every call, and each provider
  // constructor opens a SQLite MemoryStore (mkdirSync + DB open + WAL replay —
  // all synchronous). Resolving per debounced keystroke therefore did blocking
  // disk I/O on the input hot path AND leaked an unclosed DB handle per novel
  // prefix for the REPL session's lifetime. Memoize (at most one per kind) and
  // close them all in dispose().
  const resolveProviderFn = opts.resolveProviderFn ?? resolveProvider;
  const providerCache = new Map<string, ModelProvider>();
  function resolveSuggestProvider(
    model: string | undefined,
    hints: ProviderRouteHints | undefined,
  ): ModelProvider {
    const kind = providerForModel(model, hints);
    let provider = providerCache.get(kind);
    if (provider === undefined) {
      provider = resolveProviderFn(model, hints);
      providerCache.set(kind, provider);
    }
    return provider;
  }

  /**
   * Insert into the result cache with bounded FIFO eviction. `Map` preserves
   * insertion order, so the first key is the oldest. Without this cap the
   * cache would grow by one entry per unique buffer that reaches Tier 2, for
   * the entire lifetime of the REPL session.
   */
  function cacheSet(key: string, value: string | null): void {
    if (cache.size >= MAX_CACHE_ENTRIES && !cache.has(key)) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, value);
  }

  function getDeterministicGhost(buffer: string, ctx: SuggestContext): string | null {
    if (buffer.length === 0) return null;

    // (a) Dropdown top candidate
    const dropdownCandidate = ctx.getDropdownTopCandidate(buffer);
    if (
      dropdownCandidate !== null &&
      dropdownCandidate.startsWith(buffer) &&
      dropdownCandidate.length > buffer.length
    ) {
      return dropdownCandidate;
    }

    // (b) History prefix-match (newest first)
    const history = ctx.getHistory();
    for (const entry of history) {
      if (entry.startsWith(buffer) && entry.length > buffer.length) {
        return entry;
      }
    }

    return null;
  }

  async function getGhost(buffer: string, ctx: SuggestContext): Promise<string | null> {
    // Always try Tier 1 first
    const deterministic = getDeterministicGhost(buffer, ctx);
    if (deterministic !== null) {
      return deterministic;
    }

    // Tier 2 guard conditions
    if (!ctx.llmEnabled()) return null;
    if (buffer.length < MIN_LLM_CHARS) return null;

    // Cache hit
    if (cache.has(buffer)) {
      return cache.get(buffer) ?? null;
    }

    // Abort any in-flight request and clear pending debounce
    if (pendingController !== null) {
      pendingController.abort();
      pendingController = null;
    }
    // Invariant: superseding a pending debounce resolves its promise with null
    // so callers awaiting the prior getGhost() never hang.
    if (debounceHandle !== null) {
      clearTimeout(debounceHandle);
      debounceHandle = null;
      if (pendingResolve !== null) {
        const prior = pendingResolve;
        pendingResolve = null;
        prior(null);
      }
    }

    // Invariant: the debounce promise resolves to null (not rejects) on any
    // error, timeout, or abort — callers must never await a throw from getGhost.
    return new Promise<string | null>((resolve) => {
      pendingResolve = resolve;
      debounceHandle = setTimeout(() => {
        debounceHandle = null;
        pendingResolve = null;
        void runLlmTier(buffer, ctx, resolve);
      }, debounceMs);
    });
  }

  async function runLlmTier(
    buffer: string,
    ctx: SuggestContext,
    resolve: (v: string | null) => void,
  ): Promise<void> {
    const controller = new AbortController();
    pendingController = controller;
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    // Invariant: abortPromise races with the completeFn so that the engine
    // resolves null as soon as the AbortController fires, even when completeFn
    // ignores the signal and never rejects (test stubs, hung network calls).
    const abortPromise = new Promise<null>((res) => {
      if (controller.signal.aborted) {
        res(null);
      } else {
        controller.signal.addEventListener('abort', () => res(null), { once: true });
      }
    });

    try {
      let result: string | null = null;
      // `settled` is true only when the model actually returned a reply. On
      // abort/timeout it stays false — see the caching invariant below.
      let settled = false;

      if (opts.completeFn) {
        // Injected completer (tests) — race against abort so stubs that never
        // resolve don't hang the test.
        const raced = await Promise.race([
          opts.completeFn({
            system: buildSystem(),
            user: buildUser(buffer, ctx),
            model: pickModel(ctx),
            maxTokens: 24,
            signal: controller.signal,
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          }).then((r) => ({ ok: true as const, raw: r })),
          abortPromise.then(() => ({ ok: false as const })),
        ]);
        if (raced.ok) {
          settled = true;
          const cleaned = stripGhostControlChars(raced.raw).trim();
          result = isValidContinuation(buffer, cleaned) ? cleaned : null;
        }
      } else {
        // Real provider path
        const suggestModel = pickModel(ctx);
        const hints = ctx.baseUrl ? { openaiBaseUrl: ctx.baseUrl } : undefined;
        const provider = resolveSuggestProvider(suggestModel, hints);
        if (typeof provider.complete !== 'function') {
          // The provider permanently cannot suggest. Cache the null so we skip
          // the complete()-capability probe on every later keystroke for this
          // same buffer.
          cacheSet(buffer, null);
          resolve(null);
          return;
        }
        const raced = await Promise.race([
          provider.complete({
            system: buildSystem(),
            user: buildUser(buffer, ctx),
            model: suggestModel,
            maxTokens: 24,
            signal: controller.signal,
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          }).then((r) => ({ ok: true as const, raw: r })),
          abortPromise.then(() => ({ ok: false as const })),
        ]);
        if (raced.ok) {
          settled = true;
          const cleaned = stripGhostControlChars(raced.raw).trim();
          result = isValidContinuation(buffer, cleaned) ? cleaned : null;
        }
      }

      // Invariant: only a genuine model answer is cached. An abort or timeout
      // (settled=false) must never be cached — otherwise a single slow
      // round-trip would poison this prefix for the rest of the session and
      // silently stop suggestions from ever appearing for it.
      if (settled) cacheSet(buffer, result);
      resolve(result);
    } catch (err) {
      // Never-throws: any provider/network/abort error resolves null. Surface
      // the cause through the injected onError sink (a no-op by default, wired
      // to debugLog in the REPL) so misconfiguration — bad auth, 404 model,
      // unreachable shim — is diagnosable instead of silently yielding zero
      // ghost text. Not cached, so a transient error retries on the next fire.
      opts.onError?.(err);
      resolve(null);
    } finally {
      clearTimeout(timeoutHandle);
      if (pendingController === controller) {
        pendingController = null;
      }
    }
  }

  function dispose(): void {
    if (debounceHandle !== null) {
      clearTimeout(debounceHandle);
      debounceHandle = null;
      // Invariant: supersede/dispose resolve the prior promise with null so callers never hang.
      if (pendingResolve !== null) {
        const prior = pendingResolve;
        pendingResolve = null;
        prior(null);
      }
    }
    if (pendingController !== null) {
      pendingController.abort();
      pendingController = null;
    }
    // Close memoized providers — each holds an open SQLite handle that would
    // otherwise leak for the process lifetime. Best-effort: a failed close
    // must not break REPL teardown.
    for (const provider of providerCache.values()) {
      try {
        void provider.close?.();
      } catch {
        // ignore — teardown continues
      }
    }
    providerCache.clear();
  }

  return { getDeterministicGhost, getGhost, dispose };
}

// ── Model selection ───────────────────────────────────────────────────────────

/**
 * Pick the model for Tier 2 suggestions.
 *
 * Priority:
 *   1. `AFK_SUGGEST_MODEL` env override
 *   2. For anthropic-routed sessions: `AFK_COMPACT_MODEL ?? 'haiku'`
 *   3. For other providers: the session model (`ctx.model`)
 */
export function pickModel(ctx: SuggestContext): string {
  const suggestModel = env.AFK_SUGGEST_MODEL;
  if (suggestModel) return suggestModel;

  const providerName = providerForModel(ctx.model);
  if (providerName === 'anthropic-direct' || providerName === 'anthropic') {
    return env.AFK_COMPACT_MODEL ?? 'haiku';
  }

  return ctx.model;
}
