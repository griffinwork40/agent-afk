/**
 * Structured output extraction from sub-agent text responses.
 *
 * Returns a SINGLE value. Multiple top-level JSON values are NOT aggregated —
 * later values shadow earlier ones. If a caller's schema is `z.array(...)`,
 * the sub-agent prompt MUST instruct the model to emit ONE fenced JSON array
 * (see `src/skills/audit-fit/prompts/*.md` for the working pattern). Emitting
 * N bare objects will silently collapse to the last balanced object.
 *
 * Strategy (first match wins):
 * 1. The LAST fenced code block whose body parses as JSON — sub-agents
 *    following `/contract` conventions emit prose followed by a
 *    terminal JSON block.
 * 2. The LAST balanced `{...}` span whose contents parse as JSON.
 * 3. `undefined` if nothing parseable is found — callers treat this as a
 *    signal that the schema parse will fail with "expected object, got
 *    undefined" rather than something noisier.
 *
 * Behavior is locked in by `tests/agent/output-extractor.test.ts`. If a future
 * caller genuinely needs multi-object aggregation, add an opt-in option here
 * rather than changing the default.
 *
 * @module agent/output-extractor
 */

/** Extract a structured JSON payload from free-form assistant text. */
export function extractStructuredOutput(content: string): unknown {
  const fromFence = extractFromLastJsonFence(content);
  if (fromFence !== undefined) return fromFence;
  return extractFromLastBalancedBraces(content);
}

function extractFromLastJsonFence(content: string): unknown {
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let lastCandidate: string | undefined;
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(content)) !== null) {
    lastCandidate = match[1];
  }
  if (!lastCandidate) return undefined;
  return tryParseJson(lastCandidate.trim());
}

function extractFromLastBalancedBraces(content: string): unknown {
  for (let i = content.length - 1; i >= 0; i--) {
    if (content[i] !== '}') continue;
    const openIdx = findMatchingOpen(content, i);
    if (openIdx === -1) continue;
    const candidate = content.slice(openIdx, i + 1);
    const parsed = tryParseJson(candidate);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function findMatchingOpen(content: string, closeIdx: number): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = closeIdx; i >= 0; i--) {
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
    if (ch === '}') depth++;
    else if (ch === '{') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
