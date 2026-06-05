/**
 * Display formatter for `bash` tool results.
 *
 * Bash output is mostly plain text — for that case this formatter returns
 * `null` and the existing `lineCount` / preview path renders cleanly. The
 * one shape that DID leak truncated raw JSON into the tool lane is when
 * the command itself emits structured JSON on a single line (`gh pr view
 * --json`, `jq -c`, `curl … | jq -c`, `npm pkg get`, etc.). Without a
 * formatter the single-line >80-char truncation branch in
 * `stream-consumer.ts:truncateContent` slices the JSON mid-string and the
 * renderer falls through to a raw preview like
 * `✓ {"additions":1016,"baseRefName":"main","b…`.
 *
 * This formatter detects JSON-shaped output, summarizes object outputs as
 * `{key1, key2, key3, …}` and array outputs as `[N items]` / `[N]`. Pure,
 * deterministic, fails open on any parse or shape mismatch.
 *
 * @module agent/tools/renderers/bash-renderer
 */

/**
 * Max keys to list before eliding with `…`. 4 keeps the line short
 * enough to coexist with the surrounding glyph + tool name in
 * default-width terminals while still naming enough of the shape to
 * orient the reader.
 */
const MAX_KEYS_SHOWN = 4;

/**
 * Hard cap on the display string length. The renderer downstream does
 * NOT truncate `chunk.display`, so we self-cap to keep wide outputs
 * from line-wrapping. 80 chars matches `truncateContent`'s threshold
 * for the content path.
 */
const MAX_DISPLAY_CHARS = 80;

export function formatBashDisplay(rawContent: string): string | null {
  const trimmed = rawContent.trim();
  if (trimmed.length === 0) return null;

  const first = trimmed[0];
  if (first !== '{' && first !== '[') return null;

  // Cheap pre-check: structural JSON must end with the matching delimiter.
  // Skips JSON.parse on output that happens to START with `{` (e.g. shell
  // brace expansion echoed back) but isn't valid JSON.
  const last = trimmed[trimmed.length - 1];
  if (first === '{' && last !== '}') return null;
  if (first === '[' && last !== ']') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (Array.isArray(parsed)) {
    return capDisplay(formatArray(parsed));
  }
  if (parsed !== null && typeof parsed === 'object') {
    return capDisplay(formatObject(parsed as Record<string, unknown>));
  }
  return null;
}

function formatArray(arr: unknown[]): string {
  if (arr.length === 0) return '[empty array]';
  if (arr.length === 1) return '[1 item]';
  return `[${arr.length} items]`;
}

function formatObject(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj);
  if (keys.length === 0) return '{empty object}';
  const shown = keys.slice(0, MAX_KEYS_SHOWN);
  const elision = keys.length > MAX_KEYS_SHOWN ? ', …' : '';
  return `{${shown.join(', ')}${elision}}`;
}

function capDisplay(s: string): string {
  if (s.length <= MAX_DISPLAY_CHARS) return s;
  return s.slice(0, MAX_DISPLAY_CHARS - 1) + '…';
}
