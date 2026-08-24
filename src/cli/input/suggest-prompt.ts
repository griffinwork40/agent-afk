/**
 * Empty-prompt suggestion: the "what should I do next" ghost text offered when
 * the user is sitting at a blank prompt after a turn. Never at the STARTUP
 * prompt — see {@link hasSuggestionGrounding} for why the first prompt of a
 * session is deliberately left clean.
 *
 * This is a distinct concern from the Tier-1/Tier-2 completion engine in
 * `./suggest`. Those tiers COMPLETE something the user is already typing and
 * are guarded off at an empty buffer on purpose. This module instead PROPOSES a
 * whole next action from session context, and is the only path allowed to
 * produce a ghost when the buffer is empty.
 *
 * Scope: this module PRODUCES one proposal — prompt construction, acceptance
 * guard, a single provider round-trip. It deliberately owns no lifecycle:
 * which invocation is authoritative, when a late reply may publish, and when
 * the stored value is dropped all live in `./suggest-prompt-state`. Keeping
 * production separate from lifecycle is what lets prompt construction stay
 * unit-testable without a provider, a REPL, or a session.
 *
 * @module cli/input/suggest-prompt
 */

import { basename } from 'node:path';
import { redactSecrets } from '../../agent/redact-secrets.js';
import { buildUserArc, extractOutcome } from './suggest-prompt.context.js';
import type { CompleteRequest, SuggestContext } from './suggest-types.js';

// Re-export so callers that imported extractOutcome from here still work.
export { extractOutcome } from './suggest-prompt.context.js';

/**
 * Hard ceiling on an accepted suggestion. Anything longer is treated as the
 * model ignoring the brief (prose, a list, an explanation) rather than as a
 * usable prompt, and is discarded.
 */
const MAX_SUGGESTION_CHARS = 120;

/** Transcript budget. Fallback path only — enough to see the last exchange. */
const TRANSCRIPT_BUDGET = 600;

/**
 * Cap on the last-request field. A user who pastes a long log, document, or
 * prompt into the REPL would otherwise send unbounded text to the suggestion
 * model — exceeding its context window, timing out, or incurring unexpected
 * cost. The first ~200 chars carry the intent; the rest is noise.
 */
const LAST_REQUEST_CAP = 200;

/** Recent commands considered in the fallback path. */
const RECENT_COMMAND_LIMIT = 5;

/**
 * Refusal/hedge openers. A model with nothing useful to say tends to narrate
 * that fact; those replies are never a valid thing to type at a prompt.
 */
const REFUSAL_PREFIXES = [
  'i cannot',
  "i can't",
  'i am unable',
  "i'm unable",
  'sorry',
  'as an ai',
  'there is no',
  "there isn't",
  'no suggestion',
  'none',
  'n/a',
  'unable to',
];

export function buildPromptSuggestionSystem(): string {
  return (
    'You suggest the single next thing a developer would type at their terminal ' +
    'agent prompt. You are given the session arc (what the user has been doing), ' +
    'their last request, and the outcome (what the agent did). ' +
    'Infer the most natural next step from the outcome — what would a developer ' +
    'typically say or tell the agent to do in this situation? ' +
    'Reply with ONE short imperative instruction and nothing else. ' +
    'No quotes, no markdown, no preamble, no trailing punctuation. ' +
    `Keep it under ${MAX_SUGGESTION_CHARS} characters. ` +
    'If nothing useful follows from the context, reply with an empty string.'
  );
}

/**
 * Assemble the context payload for an empty-prompt suggestion.
 *
 * Contract: this is a DATA-EGRESS boundary. The returned string is the only
 * session content sent to the suggestion model, which may be a cheaper model at
 * a DIFFERENT endpoint (`baseUrl` override) than the session itself. Everything
 * — cwd, user arc, outcome — is passed through `redactSecrets` before it
 * leaves the process, mirroring the same chokepoint in `suggest.ts`'s
 * `buildUser`.
 *
 * The payload is structured in three layers:
 * 1. **User arc** — all user messages this session, condensed. Shows the
 *    workflow trajectory (what the user has been doing).
 * 2. **Last request** — the user's most recent message in full.
 * 3. **Outcome** — the agent's terminal-state block (Done/Blocked/Asking) or
 *    final paragraph. Shows what actually happened, not the verbose narration.
 *
 * This gives the suggestion model: "the user has been doing X, just asked Y,
 * and the agent finished with Z — what would they type next?"
 */
export function buildPromptSuggestionUser(ctx: SuggestContext): string {
  const cwdBase = basename(ctx.cwd) || ctx.cwd;
  const parts: string[] = [`cwd: ${cwdBase}`];

  // Layer 1: user arc (workflow trajectory)
  const arc = buildUserArc(ctx);
  if (arc.length > 0) parts.push(`session so far: ${arc}`);

  // Layer 2 + 3: last request and outcome (structured extraction)
  const lastAssistant = ctx.getLastAssistantResponse?.();
  if (lastAssistant !== undefined && lastAssistant.length > 0) {
    // We have structured access — extract user arc's last entry as the
    // request, and the terminal-state block as the outcome.
    const userArc = ctx.getUserArc?.();
    const lastRequest = userArc?.[userArc.length - 1];
    if (lastRequest) {
      const capped =
        lastRequest.length > LAST_REQUEST_CAP
          ? lastRequest.slice(0, LAST_REQUEST_CAP) + '…'
          : lastRequest;
      parts.push(`last request: ${capped}`);
    }
    const outcome = extractOutcome(lastAssistant);
    if (outcome.length > 0) parts.push(`outcome: ${outcome}`);
  } else {
    // Fallback: no structured access, use raw transcript tail (legacy path).
    const recent = ctx.getRecentCommands().slice(0, RECENT_COMMAND_LIMIT);
    const transcript = ctx.getTranscriptTail();
    if (recent.length > 0) parts.push(`recent commands: ${recent.join(' | ')}`);
    if (transcript.length > 0) {
      parts.push(`what just happened: ${transcript.slice(0, TRANSCRIPT_BUDGET)}`);
    }
  }

  parts.push('Suggest the next thing to type:');
  return redactSecrets(parts.join('\n'));
}

/**
 * Whether the session has anything for a suggestion to be grounded in.
 *
 * Invariant: this feature PROPOSES the next action "based on what just
 * happened" (see {@link buildPromptSuggestionSystem}). At the very first prompt
 * of a session nothing has happened yet — the transcript tail is empty and the
 * only remaining inputs are the cwd basename and the persisted history ring,
 * which carries the PREVIOUS session's commands. A proposal built from those is
 * an ungrounded guess about work the user has not started, so the startup
 * prompt stays clean and the first suggestion waits for the first completed
 * turn. `/clear` empties the same transcript (`resetStats`) and is therefore
 * covered by the same gate; a resumed session restores it and is not.
 */
export function hasSuggestionGrounding(ctx: SuggestContext): boolean {
  return ctx.getTranscriptTail().trim().length > 0;
}

/**
 * Whether `suggestion` is essentially the same text as the user's last
 * submitted message — i.e., the model parroted back the input.
 *
 * Extracted from the transcript tail returned by `ctx.getTranscriptTail()`.
 * The tail is newest-first: `user: <newest>\nassistant: <reply>\nuser: <older>…`.
 * The FIRST `user: ` line in the string is therefore the most-recent turn.
 * Returns false when the transcript is empty (no completed turn yet) or when
 * no `user: ` line is present.
 */
export function isEchoOfLastInput(suggestion: string, ctx: SuggestContext): boolean {
  const tail = ctx.getTranscriptTail();
  if (tail.trim().length === 0) return false;

  // Contract: Multi-line user inputs produce a false negative — only the
  // first physical line after 'user: ' is compared. This is acceptable:
  // REPL readline input is overwhelmingly single-line, and the failure mode
  // is a missed echo (not unsafe state).

  // Walk lines FORWARD to find the most-recent "user: " line.
  // getTranscriptTail() emits turns newest-first, so the first "user: " line
  // in the string is the NEWEST turn — not the last (oldest) line.
  const lines = tail.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('user: ')) {
      const lastUserMessage = line.slice('user: '.length).trim();
      return lastUserMessage.toLowerCase() === suggestion.trim().toLowerCase();
    }
  }
  return false;
}

/**
 * Gate a model reply before it is ever shown as ghost text.
 *
 * Invariant: a suggestion is rendered at an EMPTY buffer, where Tab and
 * Right-arrow both accept it verbatim into the input. There is no prefix
 * relationship to validate against (every string trivially extends ''), so this
 * predicate is the ONLY structural check standing between the model's output
 * and the user's input line. It must therefore reject anything that would be
 * surprising to accept: multi-line blocks, prose-length replies, leading
 * whitespace that would render as a detached ghost, and refusal text.
 */
export function isValidPromptSuggestion(reply: string): boolean {
  if (reply.length === 0) return false;
  // Leading whitespace would render detached from the caret and, once
  // accepted, silently indent the submitted prompt.
  if (reply !== reply.trimStart()) return false;
  if (reply.trim().length === 0) return false;
  if (reply.length > MAX_SUGGESTION_CHARS) return false;
  // Multi-line replies cannot render on the single input row. U+2028/U+2029 are
  // line terminators too — outside /[\r\n]/ but rendered as breaks by many
  // terminals — so they are rejected here rather than left to the scrubber,
  // which would silently strip them and accept a reply that was never valid.
  if (/[\r\n\u2028\u2029]/.test(reply)) return false;

  const lowered = reply.trim().toLowerCase();
  for (const prefix of REFUSAL_PREFIXES) {
    if (lowered.startsWith(prefix)) return false;
  }
  return true;
}

/**
 * Normalize a raw model reply into a candidate suggestion, or null when the
 * reply is unusable. Strips the wrapping quotes and trailing period a model
 * adds despite the brief, then applies {@link isValidPromptSuggestion}.
 */
export function normalizePromptSuggestion(raw: string): string | null {
  let s = raw.trim();
  // Unwrap a fully-quoted reply ("run the tests" → run the tests).
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      s = s.slice(1, -1).trim();
    }
  }
  // Drop a single trailing period; keep ? and ! which can be meaningful.
  if (s.endsWith('.') && !s.endsWith('..')) s = s.slice(0, -1).trimEnd();

  return isValidPromptSuggestion(s) ? s : null;
}

/**
 * Minimal completion call shape shared with the Tier-2 engine.
 * Alias of the canonical {@link CompleteRequest}; kept as a named export
 * because callers already import this name.
 */
export type PromptCompleteRequest = CompleteRequest;

/** Collaborators injected by the engine so this module stays provider-agnostic. */
export interface PromptSuggestionDeps {
  /** Resolve the completion function, or null when the provider cannot complete. */
  resolveComplete(model: string): ((req: PromptCompleteRequest) => Promise<string>) | null;
  /** Suggestion-class model id for this session. */
  model: string;
  /** Hard abort budget in milliseconds. */
  timeoutMs: number;
  /** Control-character scrubber (owned by the engine module). */
  scrub(s: string): string;
  /** Receives the controller so the engine can abort an in-flight prime. */
  onController(c: AbortController | null): void;
  /**
   * Diagnostic sink for a thrown completion (bad auth, 404 model, unreachable
   * shim). Optional; the engine wires the same `opts.onError` the Tier-2 tier
   * uses so an empty-prompt failure is visible under `AFK_DEBUG=1` instead of
   * being silently swallowed. NOT called on the expected abort/timeout path,
   * which resolves without throwing.
   */
  onError?(err: unknown): void;
}

/**
 * Generate one empty-prompt suggestion, or null.
 *
 * Contract: never throws and never rejects — a failed suggestion is simply no
 * suggestion. Deliberately uncached: the answer is a function of session state
 * that changes every turn, so a buffer-keyed cache (whose key would always be
 * the empty string) would pin one stale proposal for the whole session.
 */
export async function generatePromptSuggestion(
  ctx: SuggestContext,
  deps: PromptSuggestionDeps,
): Promise<string | null> {
  if (!ctx.llmEnabled() || ctx.promptSuggestEnabled?.() !== true) return null;
  // Startup gate: no completed turn in this session means no grounding, so
  // refuse before the provider call rather than proposing from stale
  // cross-session history. See {@link hasSuggestionGrounding}.
  if (!hasSuggestionGrounding(ctx)) return null;

  const controller = new AbortController();
  deps.onController(controller);
  const timeoutHandle = setTimeout(() => controller.abort(), deps.timeoutMs);
  const abortPromise = new Promise<null>((res) => {
    if (controller.signal.aborted) res(null);
    else controller.signal.addEventListener('abort', () => res(null), { once: true });
  });

  try {
    const complete = deps.resolveComplete(deps.model);
    if (complete === null) return null;

    const raced = await Promise.race([
      complete({
        system: buildPromptSuggestionSystem(),
        user: buildPromptSuggestionUser(ctx),
        model: deps.model,
        maxTokens: 48,
        signal: controller.signal,
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
      }).then((raw) => ({ ok: true as const, raw })),
      abortPromise.then(() => ({ ok: false as const })),
    ]);
    if (!raced.ok) return null;

    // Invariant: validate the RAW reply BEFORE scrubbing. The scrubber deletes
    // newlines, so scrubbing first would splice a two-line reply into one long
    // line and defeat the multi-line rejection in isValidPromptSuggestion.
    // Structure is judged first, control characters second, empty result last.
    const candidate = normalizePromptSuggestion(raced.raw);
    if (candidate === null) return null;
    // Echo guard: discard exact parrot echoes of the user's last input.
    // The LLM context includes the transcript tail (via buildPromptSuggestionUser),
    // so nothing structurally prevents repetition. Catches exact (case-insensitive)
    // matches only — partial echoes or paraphrases are not filtered here.
    if (isEchoOfLastInput(candidate, ctx)) return null;
    const scrubbed = deps.scrub(candidate).trim();
    return scrubbed.length > 0 ? scrubbed : null;
  } catch (err) {
    // Never-throws: a failed suggestion is simply no suggestion. Surface the
    // cause through the injected sink (same one the Tier-2 tier uses) so a
    // misconfigured suggestion endpoint is diagnosable rather than presenting
    // as "the empty-prompt ghost silently never appears".
    deps.onError?.(err);
    return null;
  } finally {
    clearTimeout(timeoutHandle);
    deps.onController(null);
  }
}
