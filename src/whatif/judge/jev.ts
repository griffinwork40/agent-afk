/**
 * Jev judge: grades episode outputs using TypeSafe's Jev MCP tool `jev_ask`.
 *
 * Jev is an external judge (data leaves Anthropic). It is cross-family,
 * calibrated, and batches all questions per output.
 *
 * Result shape: Jev's MCP `jev_ask` tool returns a ToolResult whose `content`
 * string contains JSON. We defensively handle multiple observed shapes:
 *
 *   Shape A (flat probability map):
 *     {"p1": 0.85, "d2": 0.3}
 *
 *   Shape B (answers array):
 *     {"answers": [{"id":"p1","p_yes":0.85,"p":0.3},...]}
 *   or {"answers": [{"id":"p1","probability":0.85,"yes_probability":0.85},...]}
 *
 *   Shape C (wrapped text):
 *     {"content":[{"type":"text","text":"<JSON string>"}]}
 *     (the ToolHandler concatenates text blocks, so this arrives already as the
 *      inner text; this shape only matters if callTool returns raw MCP shape)
 *
 * The parser tries Shape A first (most likely based on Jev docs), then Shape B,
 * then attempts to extract JSON from the raw string. Missing ids default to 0.5.
 *
 * @module whatif/judge/jev
 */

import { extractJson } from '../json-extract.js';
import type { Judge, JudgeInput, JudgeQuestion, JudgeResult } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JevCallToolFn {
  (name: string, args: unknown, signal?: AbortSignal): Promise<unknown>;
}

export interface JevJudgeOpts {
  callTool: JevCallToolFn;
}

// ---------------------------------------------------------------------------
// Jev result parsing
// ---------------------------------------------------------------------------

/**
 * Clamp to [0,1]. Non-finite → 0.5.
 */
function clamp(v: number): number {
  if (!isFinite(v)) return 0.5;
  return Math.max(0, Math.min(1, v));
}

/**
 * Extract probability from an answers-array entry.
 * Tries: p_yes, probability, yes_probability, p.
 */
function extractP(entry: Record<string, unknown>): number | undefined {
  // `noul` is what jev_ask actually returns for `type: 'check'` questions
  // (observed against jev 0.5.1 / model jev-1.13.0: `answers.<id>.noul` = P(yes)).
  for (const key of ['noul', 'p_yes', 'probability', 'yes_probability', 'p']) {
    const v = entry[key];
    if (typeof v === 'number') return v;
  }
  return undefined;
}

/**
 * Parse a Jev `jev_ask` result into a `JudgeResult` map.
 *
 * `raw` is the unknown value returned by `callTool`. Because the MCP manager
 * normalizes call results into `ToolResult` (a flat `{ content: string }`),
 * `raw` will typically be a `ToolResult`-like object or a plain string.
 *
 * Fallback order:
 *  1. If `raw` is a ToolResult-like `{ content: string }`, parse content as JSON.
 *  2. If `raw` is a string, parse it as JSON.
 *  3. If `raw` is already an object, use it directly.
 * Then try Shape A (flat map) → Shape B (answers array) → extract from text.
 *
 * @internal exported for unit testing
 */
export function parseJevResult(
  raw: unknown,
  questions: JudgeQuestion[],
): JudgeResult {
  // Invariant: ids Jev did not answer are OMITTED, never defaulted. A silent
  // 0.5 default made a parse failure look like a measured "no change" (every
  // rate 50% -> 50%); omission lets the orchestrator exclude the output and
  // count it as a judge failure instead.
  const result: JudgeResult = {};
  const wanted = new Set(questions.map((q) => q.id));

  let parsed: unknown = raw;

  // Unwrap ToolResult { content: string } if present.
  if (
    raw !== null &&
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    typeof (raw as Record<string, unknown>)['content'] === 'string'
  ) {
    const contentStr = (raw as Record<string, unknown>)['content'] as string;
    const extracted = extractJson(contentStr);
    parsed = extracted ?? raw;
  }

  // Unwrap bare string.
  if (typeof raw === 'string') {
    parsed = extractJson(raw) ?? raw;
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return result;
  }

  const obj = parsed as Record<string, unknown>;

  // Shape A: flat id → probability map.
  // Detect by checking whether values are numbers (at least partially).
  let shapeAHits = 0;
  for (const [key, val] of Object.entries(obj)) {
    if (typeof val === 'number' && wanted.has(key)) {
      result[key] = clamp(val);
      shapeAHits++;
    }
  }
  if (shapeAHits > 0) return result;

  // Shape C (actual jev_ask): { answers: { <id>: { type, noul } } }
  const answers = obj['answers'];
  if (answers !== null && typeof answers === 'object' && !Array.isArray(answers)) {
    for (const [id, entry] of Object.entries(answers as Record<string, unknown>)) {
      if (!wanted.has(id) || entry === null || typeof entry !== 'object') continue;
      const p = extractP(entry as Record<string, unknown>);
      if (typeof p === 'number') result[id] = clamp(p);
    }
    return result;
  }

  // Shape B: { answers: [{id, p_yes|probability|yes_probability|p}, ...] }
  if (Array.isArray(answers)) {
    for (const entry of answers) {
      if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
        const e = entry as Record<string, unknown>;
        const id = typeof e['id'] === 'string' ? e['id'] : undefined;
        if (!id) continue;
        const p = extractP(e);
        if (typeof p === 'number') {
          result[id] = clamp(p);
        }
      }
    }
    return result;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Judge factory
// ---------------------------------------------------------------------------

const JEV_TOOL_NAME = 'mcp__jev__jev_ask';

/**
 * Build the `jev_ask` arguments per question.
 * Uses explicit `yes_at_or_above` / `no_at_or_below` thresholds.
 */
function buildJevArgs(input: JudgeInput): Record<string, unknown> {
  return {
    state: `## User prompt\n${input.prompt}\n\n## Agent output\n${input.output}`,
    questions: input.questions.map((q) => ({
      id: q.id,
      type: 'check',
      question: q.question,
    })),
    yes_at_or_above: 0.7,
    no_at_or_below: 0.3,
  };
}

/**
 * Create a Jev-backed `Judge`.
 *
 * `name` is `'jev'`; `external` is `true` (data goes to TypeSafe).
 */
export function createJevJudge(opts: JevJudgeOpts): Judge {
  const { callTool } = opts;

  return {
    name: 'jev',
    external: true,

    async grade(input: JudgeInput, signal?: AbortSignal): Promise<JudgeResult> {
      const args = buildJevArgs(input);
      const raw = await callTool(JEV_TOOL_NAME, args, signal);
      const result = parseJevResult(raw, input.questions);
      if (input.questions.length > 0 && Object.keys(result).length === 0) {
        const preview = (typeof raw === 'string' ? raw : JSON.stringify(raw) ?? '').slice(0, 200);
        throw new Error(`jev_ask returned no usable answers: ${preview}`);
      }
      return result;
    },
  };
}
