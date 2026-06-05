/**
 * SIGNAL block parser — passive v0.
 *
 * A subagent MAY emit an optional structured "signal" object as a top-level
 * key inside a fenced JSON block (or inside any balanced-brace JSON span) in
 * its final assistant message. AFK observers can extract this signal without
 * disturbing existing structured-output extraction.
 *
 * Required shape:
 *
 * ```json
 * {
 *   "signal": {
 *     "issue": "stable-slug-or-question",
 *     "stance": "supports" | "opposes" | "uncertain" | "blocks",
 *     "confidence": 0.0,
 *     "evidence": ["file:line or source", ...],
 *     "claim": "one sentence claim"
 *   }
 * }
 * ```
 *
 * ## Design rules (v0)
 *
 * - **Key-scoped, not positional.** Unlike `extractStructuredOutput` (which
 *   picks the LAST fenced/balanced block), this extractor walks every JSON
 *   candidate and returns the FIRST one whose parsed root contains a `signal`
 *   key. This means a SIGNAL key can coexist alongside an existing
 *   `outputSchema`-driven JSON block without disturbing the schema-extraction
 *   contract — either as a sibling key on the same block, or as a separate
 *   block emitted earlier in the message.
 *
 * - **No inference.** No NLP, no fuzzy match, no auto-issue-key generation.
 *   If a subagent omits a SIGNAL block, this returns `{ ok: false }` and the
 *   observer records nothing. Missing means missing.
 *
 * - **Not authoritative.** This module is parsing only. Callers MUST NOT use
 *   the result to gate finalization, block tool execution, or modify provider
 *   message history. v0 is passive-observation infrastructure.
 *
 * - **Schema validation is strict-on-shape, loose-on-meaning.** We require
 *   the five keys (`issue`, `stance`, `confidence`, `evidence`, `claim`) with
 *   correct types and a `stance` from the allowed enum. We do NOT validate
 *   the *meaning* of `issue` (any non-empty string accepted) or whether the
 *   `evidence` strings actually point to real files. Validation is the
 *   observer's job; we just gatekeep the shape.
 *
 * @module agent/signal-block
 *
 * TODO(signal-block-wiring): `parseSignal` is defined and tested but not yet
 * imported by any runtime caller (`handle.ts`, `result.ts`, `executor.ts`).
 * Wiring into the subagent result pipeline is intentionally deferred to a
 * follow-up PR — this PR only lands the parser + schema so observers can
 * adopt it incrementally. Remove this TODO when a caller imports it.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const StanceSchema = z.enum(['supports', 'opposes', 'uncertain', 'blocks']);
export type Stance = z.infer<typeof StanceSchema>;

/**
 * The inner signal payload. The five required fields per the v0 convention.
 *
 * `evidence` is permitted to be an empty array — a v0 observer surfaces
 * "claim with no evidence" as its own signal rather than rejecting the block.
 * Stronger evidence-required gating is explicitly deferred (see audit §7).
 */
export const SignalSchema = z.object({
  issue: z.string().min(1),
  stance: StanceSchema,
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string()),
  claim: z.string().min(1),
});

export type Signal = z.infer<typeof SignalSchema>;

/**
 * The full envelope: an object with a top-level `signal` key.
 *
 * Using `.passthrough()` so we don't reject envelopes that happen to share
 * the JSON block with another schema's keys (e.g. a mint/verify output block
 * that also carries `status` and `issues`). Only the `signal` key is read.
 */
export const SignalBlockSchema = z
  .object({
    signal: SignalSchema,
  })
  .passthrough();

export type SignalBlock = z.infer<typeof SignalBlockSchema>;

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type ParseSignalResult =
  | { ok: true; signal: Signal }
  | { ok: false; reason: 'absent' | 'malformed' };

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * Walk every fenced JSON block in `content`, in order of appearance, and
 * return the FIRST parsed object whose root has a `signal` key.
 *
 * Unlike `extractStructuredOutput` this is key-scoped, not positional —
 * coexists safely with an existing trailing schema block (which positional
 * extraction would always pick) by matching on key rather than position.
 *
 * Returns the raw parsed object (no validation). Use `parseSignal` if you
 * need a typed, validated `Signal`.
 */
export function extractSignalBlock(content: string): unknown {
  // 1. Fenced blocks first — the documented convention.
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(content)) !== null) {
    const body = match[1];
    if (body === undefined) continue;
    const parsed = tryParseJson(body.trim());
    if (hasSignalKey(parsed)) return parsed;
  }

  // 2. Balanced-braces fallback — mirrors output-extractor.ts. Scans left to
  //    right (forward), unlike output-extractor's reverse scan, because we
  //    want the FIRST signal-bearing object, not the last.
  //
  //    Only DOCUMENT-ROOT objects count: an object opened immediately after
  //    `[`, `,`, or `:` is nested inside another JSON structure, not a
  //    standalone candidate. The v0 contract requires `signal` to be a
  //    top-level key on the message's outer envelope, not buried in an array.
  for (let i = 0; i < content.length; i++) {
    if (content[i] !== '{') continue;
    if (isNestedOpenBrace(content, i)) continue;
    const closeIdx = findMatchingClose(content, i);
    if (closeIdx === -1) continue;
    const candidate = content.slice(i, closeIdx + 1);
    const parsed = tryParseJson(candidate);
    if (hasSignalKey(parsed)) return parsed;
    // Skip ahead to avoid quadratic re-scan of nested objects.
    i = closeIdx;
  }

  return undefined;
}

/**
 * Returns true when the `{` at `idx` is structurally inside a JSON array
 * (preceded — ignoring whitespace — by `[` or `,`). Used to reject
 * signal-shaped objects that sit inside an array literal; the v0 convention
 * requires top-level placement.
 *
 * Note: we deliberately do NOT treat `:` as a nesting marker. A colon could
 * be prose punctuation ("Conclusion: {...}") rather than a JSON key/value
 * separator. Objects nested as values of other objects are filtered out
 * implicitly by the forward-scan loop: the outer object is parsed first,
 * the cursor jumps past its closing brace, and any inner objects are
 * never re-scanned.
 */
function isNestedOpenBrace(content: string, idx: number): boolean {
  for (let i = idx - 1; i >= 0; i--) {
    const ch = content[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') continue;
    return ch === '[' || ch === ',';
  }
  return false;
}

/**
 * Extract and validate a SIGNAL block from free-form assistant text.
 *
 * - `{ ok: false, reason: 'absent' }`  → no `signal` key found anywhere.
 * - `{ ok: false, reason: 'malformed' }` → key found but the value did not
 *   match the required shape (e.g. wrong stance enum, missing field).
 * - `{ ok: true, signal }`             → validated payload.
 *
 * v0 observers should record `absent` and `malformed` distinctly — they are
 * different failure modes (the model didn't try vs. the model tried wrong).
 */
export function parseSignal(content: string): ParseSignalResult {
  const candidate = extractSignalBlock(content);
  if (candidate === undefined) return { ok: false, reason: 'absent' };
  const parsed = SignalBlockSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, reason: 'malformed' };
  return { ok: true, signal: parsed.data.signal };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function hasSignalKey(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'signal' in value
  );
}

/**
 * Forward-direction balanced brace matcher. Skips string literals so braces
 * inside JSON strings do not confuse depth tracking. Returns -1 if no match.
 */
function findMatchingClose(content: string, openIdx: number): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = openIdx; i < content.length; i++) {
    const ch = content[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
