/**
 * Tier 2 of the ghost-text engine: the debounced LLM completion tier.
 *
 * Owns the debounce timer, the abort/timeout race, the bounded result cache,
 * and the egress-scrubbed prompt construction for "complete the line the user
 * is typing". Split out of `./suggest`, which now composes the tiers.
 *
 * Contract: never throws and never rejects — every failure path resolves null.
 *
 * @module cli/input/suggest-tier2
 */

import { redactSecrets } from '../../agent/redact-secrets.js';
import { stripGhostControlChars } from './suggest-sanitize.js';
import type { CompleteFn } from './suggest-types.js';
import type { SuggestContext } from './suggest.js';

/** Minimum buffer length before Tier 2 fires. */
export const MIN_LLM_CHARS = 3;

/** Idle delay before the LLM request is dispatched (ms). */
export const DEBOUNCE_MS = 250;

/**
 * Hard abort deadline for a single LLM request (ms). Must comfortably exceed
 * the round-trip latency of a suggestion-class model — a value too close to
 * DEBOUNCE_MS aborts most real-API calls before they return (wasted spend and
 * no ghost). The request is fully async, so a longer ceiling never blocks
 * input; the only cost is a slightly later-appearing ghost.
 */
export const TIMEOUT_MS = 1500;

/** Upper bound on cached suggestion results; FIFO eviction beyond this. */
const MAX_CACHE_ENTRIES = 500;

export function buildSystem(): string {
  return (
    'Predict the single most likely completion of the user\'s in-progress REPL input. ' +
    'Return ONLY the completed line — no explanation, no preamble, no trailing newline.'
  );
}

export function buildUser(buffer: string, ctx: SuggestContext): string {
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
  // DATA-EGRESS CONTRACT: this assembled prompt is the only content sent to the
  // Tier-2 suggestion model, which may be a cheaper model at a DIFFERENT endpoint
  // (baseUrl override) than the session. Scrub secrets from the whole prompt —
  // cwd + recent commands + transcript + input — before it leaves the process,
  // mirroring background-summarizer.ts's redactSecrets() egress boundary. This is
  // the single chokepoint covering BOTH the completeFn (test) and real-provider
  // dispatch paths, since both build their `user` field here.
  // Invariant: redact the RETURNED prompt only — never the raw `buffer`, which is
  // the result-cache key and the isValidContinuation(buffer, reply) guard input.
  // Redacting `buffer` would collapse distinct prefixes onto one poisoned cache
  // key and make every real completion fail the prefix guard (silent no-ghost).
  return redactSecrets(parts.join('\n'));
}

/**
 * Verify the LLM reply is a valid continuation of `buffer`.
 * The reply must start with `buffer` exactly (case-sensitive) and be strictly
 * longer, or equal to `buffer` (which we then reject as not a completion).
 */
function isValidContinuation(buffer: string, reply: string): boolean {
  const trimmed = reply.trim();
  return trimmed.startsWith(buffer) && trimmed.length > buffer.length;
}

/** Collaborators the tier needs from the engine. */
export interface Tier2Deps {
  /** Suggestion-class model id for the given context. */
  pickModel(ctx: SuggestContext): string;
  /**
   * Resolve the completion function for `model`, or null when the provider
   * permanently cannot complete.
   */
  resolveComplete(model: string, ctx: SuggestContext): CompleteFn | null;
  /** Idle debounce delay (ms). */
  debounceMs: number;
  /** Hard abort budget (ms). */
  timeoutMs: number;
  /** Diagnostic sink for a thrown completion (NOT called on abort/timeout). */
  onError?: (err: unknown) => void;
}

export interface Tier2Runner {
  /**
   * Debounced completion for `buffer`. Resolves the full candidate line, or
   * null on miss/abort/timeout/error. Superseding an in-flight request resolves
   * its promise with null so no caller ever hangs.
   */
  request(buffer: string, ctx: SuggestContext): Promise<string | null>;
  /** Cancel any pending debounce/in-flight request; resolve waiters with null. */
  cancel(): void;
}

export function createTier2Runner(deps: Tier2Deps): Tier2Runner {
  let debounceHandle: ReturnType<typeof setTimeout> | null = null;
  let pendingResolve: ((v: string | null) => void) | null = null;
  let pendingController: AbortController | null = null;
  const cache = new Map<string, string | null>();

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

  /** Abort the in-flight request and resolve any debounced waiter with null. */
  function supersede(): void {
    if (pendingController !== null) {
      pendingController.abort();
      pendingController = null;
    }
    // Invariant: superseding a pending debounce resolves its promise with null
    // so callers awaiting the prior request() never hang.
    if (debounceHandle !== null) {
      clearTimeout(debounceHandle);
      debounceHandle = null;
      if (pendingResolve !== null) {
        const prior = pendingResolve;
        pendingResolve = null;
        prior(null);
      }
    }
  }

  async function run(
    buffer: string,
    ctx: SuggestContext,
    resolve: (v: string | null) => void,
  ): Promise<void> {
    const controller = new AbortController();
    pendingController = controller;
    const timeoutHandle = setTimeout(() => controller.abort(), deps.timeoutMs);

    // Invariant: abortPromise races with the completion so that the engine
    // resolves null as soon as the AbortController fires, even when the
    // completer ignores the signal and never rejects (test stubs, hung calls).
    const abortPromise = new Promise<null>((res) => {
      if (controller.signal.aborted) {
        res(null);
      } else {
        controller.signal.addEventListener('abort', () => res(null), { once: true });
      }
    });

    try {
      const model = deps.pickModel(ctx);
      const complete = deps.resolveComplete(model, ctx);
      if (complete === null) {
        // The provider permanently cannot suggest. Cache the null so we skip
        // the complete()-capability probe on every later keystroke for this
        // same buffer.
        cacheSet(buffer, null);
        resolve(null);
        return;
      }

      const raced = await Promise.race([
        complete({
          system: buildSystem(),
          user: buildUser(buffer, ctx),
          model,
          maxTokens: 24,
          signal: controller.signal,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        }).then((raw) => ({ ok: true as const, raw })),
        abortPromise.then(() => ({ ok: false as const })),
      ]);

      // Invariant: only a genuine model answer is cached. An abort or timeout
      // (raced.ok === false) must never be cached — otherwise a single slow
      // round-trip would poison this prefix for the rest of the session and
      // silently stop suggestions from ever appearing for it.
      if (!raced.ok) {
        resolve(null);
        return;
      }
      const cleaned = stripGhostControlChars(raced.raw).trim();
      const result = isValidContinuation(buffer, cleaned) ? cleaned : null;
      cacheSet(buffer, result);
      resolve(result);
    } catch (err) {
      // Never-throws: any provider/network/abort error resolves null. Surface
      // the cause through the injected onError sink (a no-op by default, wired
      // to debugLog in the REPL) so misconfiguration — bad auth, 404 model,
      // unreachable shim — is diagnosable instead of silently yielding zero
      // ghost text. Not cached, so a transient error retries on the next fire.
      deps.onError?.(err);
      resolve(null);
    } finally {
      clearTimeout(timeoutHandle);
      if (pendingController === controller) {
        pendingController = null;
      }
    }
  }

  return {
    async request(buffer, ctx) {
      if (buffer.length < MIN_LLM_CHARS) return null;
      if (cache.has(buffer)) return cache.get(buffer) ?? null;

      supersede();

      // Invariant: the debounce promise resolves to null (not rejects) on any
      // error, timeout, or abort — callers must never await a throw.
      return new Promise<string | null>((resolve) => {
        pendingResolve = resolve;
        debounceHandle = setTimeout(() => {
          debounceHandle = null;
          pendingResolve = null;
          void run(buffer, ctx, resolve);
        }, deps.debounceMs);
      });
    },
    cancel: supersede,
  };
}
