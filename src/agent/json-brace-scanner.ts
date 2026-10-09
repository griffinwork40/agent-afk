/**
 * Balanced-brace scanners for locating JSON object boundaries in raw text.
 *
 * Both functions skip string literals (respecting `\"` escapes) so that brace
 * characters embedded inside a JSON string value do not mislead depth tracking.
 *
 * Used by:
 *   - `output-extractor.ts` — reverse scan from `}` to find the matching `{`
 *   - `signal-block.ts`     — forward scan from `{` to find the matching `}`
 *
 * @module agent/json-brace-scanner
 */

/**
 * Reverse-direction balanced brace matcher.
 *
 * Starting at `closeIdx` (expected to be `}`) and scanning backward, finds the
 * index of the `{` that balances it. String literals are skipped so embedded
 * braces do not affect depth tracking. Returns `-1` when no match is found.
 */
export function findMatchingOpen(content: string, closeIdx: number): number {
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

/**
 * Forward-direction balanced brace matcher.
 *
 * Starting at `openIdx` (expected to be `{`) and scanning forward, finds the
 * index of the `}` that balances it. String literals are skipped so embedded
 * braces do not affect depth tracking. Returns `-1` when no match is found.
 */
export function findMatchingClose(content: string, openIdx: number): number {
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
