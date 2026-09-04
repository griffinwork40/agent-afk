/**
 * Handler for the `json_query` tool.
 *
 * Runs bounded, jq-subset queries on JSON files without loading the full
 * file content into model context. Supports field access, array indexing,
 * slicing, map-extract, `keys`, and `length`.
 *
 * Result shape: `{ result, type, truncated, source_size }`
 *
 * @module agent/tools/handlers/json-query
 */

import { promises as fs } from 'fs';
import type { ToolHandler, ToolHandlerContext } from '../types.js';
import { resolveAndContain } from './_cwd-utils.js';
import { fsErrorToToolResult } from './_fs-error.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default cap on returned array elements. */
const DEFAULT_MAX_RESULTS = 100;

/** Default cap on serialized output bytes (50 KB). */
const DEFAULT_MAX_BYTES = 50 * 1024;

/** Hard upper bound on file size we'll parse (10 MB). */
const MAX_FILE_SIZE = 10 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Query engine — jq-subset interpreter
// ---------------------------------------------------------------------------

/**
 * Parsed query token. One of:
 *   - `{ kind: 'identity' }` — `.`
 *   - `{ kind: 'field',   name }` — `.field`
 *   - `{ kind: 'index',   idx  }` — `.[N]`
 *   - `{ kind: 'slice',   from, to }` — `.[N:M]`
 *   - `{ kind: 'iter'  }` — `.[]` (map over array)
 *   - `{ kind: 'keys'  }` — `keys`
 *   - `{ kind: 'length'}` — `length`
 *   - `{ kind: 'pipe', left, right }` — `left | right`
 */
type QueryToken =
  | { kind: 'identity' }
  | { kind: 'field'; name: string }
  | { kind: 'index'; idx: number }
  | { kind: 'slice'; from: number; to: number }
  | { kind: 'iter' }
  | { kind: 'keys' }
  | { kind: 'length' }
  | { kind: 'pipe'; left: QueryToken; right: QueryToken };

/**
 * Parse a jq-subset query string into a token tree.
 *
 * Supported forms:
 *   `.`
 *   `.field` / `.field.nested`
 *   `.[N]`
 *   `.[N:M]`
 *   `.[]`
 *   `.[] | .field`
 *   `keys`
 *   `length`
 *
 * @throws {Error} with a descriptive message when the expression is unrecognised.
 */
function parseQuery(raw: string): QueryToken {
  const q = raw.trim();

  // keywords
  if (q === 'keys') return { kind: 'keys' };
  if (q === 'length') return { kind: 'length' };
  if (q === '.') return { kind: 'identity' };

  // Pipe: `.[] | .field`
  const pipeIdx = findTopLevelPipe(q);
  if (pipeIdx !== -1) {
    const left = parseQuery(q.slice(0, pipeIdx).trim());
    const right = parseQuery(q.slice(pipeIdx + 1).trim());
    return { kind: 'pipe', left, right };
  }

  // Bracketed forms: `.[...]`
  const bracketMatch = q.match(/^\.\[(.+)\]$/);
  if (bracketMatch) {
    const inner = (bracketMatch[1] ?? '').trim();
    // Slice: `N:M`
    const sliceMatch = inner.match(/^(-?\d+)\s*:\s*(-?\d+)$/);
    if (sliceMatch) {
      return {
        kind: 'slice',
        from: Number(sliceMatch[1] ?? '0'),
        to: Number(sliceMatch[2] ?? '0'),
      };
    }
    // Index: `N`
    if (/^-?\d+$/.test(inner)) {
      return { kind: 'index', idx: Number(inner) };
    }
    throw new Error(`Unrecognised bracket expression: .[${inner}]`);
  }

  // `.[]` iterator
  if (q === '.[]') return { kind: 'iter' };

  // Field access: `.field` or `.field.nested.deep`
  if (q.startsWith('.')) {
    const fieldPath = q.slice(1); // strip leading `.`
    if (fieldPath.length === 0) return { kind: 'identity' };
    if (/^[a-zA-Z_$][a-zA-Z0-9_$.]*$/.test(fieldPath)) {
      const parts = fieldPath.split('.');
      const first = parts[0] ?? '';
      if (parts.length === 1) return { kind: 'field', name: first };
      // Chain: `.a.b.c` → pipe(field(a), pipe(field(b), field(c)))
      let token: QueryToken = { kind: 'field', name: first };
      for (let i = 1; i < parts.length; i++) {
        token = {
          kind: 'pipe',
          left: token,
          right: { kind: 'field', name: parts[i] ?? '' },
        };
      }
      return token;
    }
  }

  throw new Error(
    `Unrecognised query expression: "${q}". ` +
      'Supported: . .field .field.nested .[N] .[N:M] .[] keys length .[] | .field',
  );
}

/** Find the index of the first top-level `|` character (not inside brackets). */
function findTopLevelPipe(q: string): number {
  let depth = 0;
  for (let i = 0; i < q.length; i++) {
    const ch = q[i];
    if (ch === '[' || ch === '(') depth++;
    else if (ch === ']' || ch === ')') depth--;
    else if (ch === '|' && depth === 0) return i;
  }
  return -1;
}

/**
 * Return true when the query token represents an iteration or map-extract
 * query (.[] or .[] | .field). These queries ALWAYS return an array so the
 * response shape is independent of input cardinality.
 */
function isIterationQuery(token: QueryToken): boolean {
  if (token.kind === 'iter') return true;
  if (token.kind === 'pipe' && token.left.kind === 'iter') return true;
  return false;
}

/**
 * Evaluate a parsed query token against a JSON value.
 *
 * Returns an array of result values (a query may produce multiple results
 * when iterating over an array with `.[]`).
 */
function evalQuery(token: QueryToken, value: unknown): unknown[] {
  switch (token.kind) {
    case 'identity':
      return [value];

    case 'keys': {
      if (value === null || typeof value !== 'object') {
        throw new Error(`keys requires an object or array, got ${typeName(value)}`);
      }
      if (Array.isArray(value)) {
        return [value.map((_, i) => i)];
      }
      return [Object.keys(value as Record<string, unknown>)];
    }

    case 'length': {
      if (Array.isArray(value)) return [value.length];
      if (value !== null && typeof value === 'object') {
        return [Object.keys(value as Record<string, unknown>).length];
      }
      if (typeof value === 'string') return [value.length];
      if (value === null) return [0];
      throw new Error(`length not defined for ${typeName(value)}`);
    }

    case 'field': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`Cannot access field ".${token.name}" on ${typeName(value)}`);
      }
      return [(value as Record<string, unknown>)[token.name]];
    }

    case 'index': {
      if (!Array.isArray(value)) {
        throw new Error(`Cannot index non-array with .[${token.idx}]`);
      }
      const len = value.length;
      const idx = token.idx < 0 ? len + token.idx : token.idx;
      return [value[idx]];
    }

    case 'slice': {
      if (!Array.isArray(value) && typeof value !== 'string') {
        throw new Error(`Cannot slice ${typeName(value)} — expected array or string`);
      }
      if (Array.isArray(value)) {
        return [value.slice(token.from, token.to)];
      }
      return [(value as string).slice(token.from, token.to)];
    }

    case 'iter': {
      if (!Array.isArray(value)) {
        throw new Error(`Cannot iterate (.[] ) over ${typeName(value)} — expected array`);
      }
      return value as unknown[];
    }

    case 'pipe': {
      const leftResults = evalQuery(token.left, value);
      const out: unknown[] = [];
      for (const lv of leftResults) {
        const rightResults = evalQuery(token.right, lv);
        out.push(...rightResults);
      }
      return out;
    }
  }
}

/** Human-friendly name for the JSON type of a value. */
function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

// ---------------------------------------------------------------------------
// Core handler implementation
// ---------------------------------------------------------------------------

async function jsonQueryImpl(
  input: unknown,
  _signal: AbortSignal,
  context: ToolHandlerContext | undefined,
  cwd: string | undefined,
): Promise<{ content: string; isError?: boolean }> {
  // ---- Input validation ----------------------------------------------------

  if (!input || typeof input !== 'object') {
    return { content: 'Invalid input: expected an object', isError: true };
  }

  const obj = input as Record<string, unknown>;
  const rawPath = obj['path'];
  const rawQuery = obj['query'];
  const rawMaxResults = obj['max_results'] ?? DEFAULT_MAX_RESULTS;
  const rawMaxBytes = obj['max_bytes'] ?? DEFAULT_MAX_BYTES;

  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    return { content: 'Invalid input: path must be a non-empty string', isError: true };
  }
  if (typeof rawQuery !== 'string' || rawQuery.length === 0) {
    return { content: 'Invalid input: query must be a non-empty string', isError: true };
  }
  if (typeof rawMaxResults !== 'number' || rawMaxResults < 1) {
    return { content: 'Invalid input: max_results must be a positive number', isError: true };
  }
  if (typeof rawMaxBytes !== 'number' || rawMaxBytes < 1) {
    return { content: 'Invalid input: max_bytes must be a positive number', isError: true };
  }

  const maxResults = Math.floor(rawMaxResults);
  const maxBytes = Math.floor(rawMaxBytes);

  // ---- Path resolution & permission check ----------------------------------

  let filePath: string;
  try {
    filePath = resolveAndContain(rawPath, context, 'read', cwd);
  } catch (err) {
    return { content: err instanceof Error ? err.message : String(err), isError: true };
  }

  // ---- Query parsing -------------------------------------------------------

  let queryToken: QueryToken;
  try {
    queryToken = parseQuery(rawQuery);
  } catch (err) {
    return {
      content: `Invalid query: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }

  // ---- File read -----------------------------------------------------------

  let buffer: Buffer;
  try {
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_FILE_SIZE) {
      return {
        content:
          `File too large (${stat.size} bytes). ` +
          `json_query supports files up to ${MAX_FILE_SIZE} bytes.`,
        isError: true,
      };
    }
    buffer = await fs.readFile(filePath);
  } catch (err) {
    const known = fsErrorToToolResult(err, filePath, 'File');
    if (known) return known;
    return {
      content: `Error reading file: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }

  const sourceSize = buffer.length;

  if (sourceSize === 0) {
    return {
      content: JSON.stringify({ result: null, type: 'null', truncated: false, source_size: 0 }),
    };
  }

  // ---- JSON parse ----------------------------------------------------------

  let parsed: unknown;
  try {
    parsed = JSON.parse(buffer.toString('utf-8'));
  } catch (err) {
    const msg = err instanceof SyntaxError ? err.message : String(err);
    return {
      content: `JSON parse error: ${msg}`,
      isError: true,
    };
  }

  // ---- Query evaluation ----------------------------------------------------

  let results: unknown[];
  try {
    results = evalQuery(queryToken, parsed);
  } catch (err) {
    return {
      content: `Query error: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }

  // ---- Result shaping & caps -----------------------------------------------

  // Iteration queries (.[] or .[] | .field) always return an array, even for
  // a single-element input, so the response shape is cardinality-independent.
  const isIterQuery = isIterationQuery(queryToken);

  let truncated = false;
  let finalResult: unknown;

  if (results.length === 1 && !isIterQuery) {
    // Single-value result: apply array-element cap if needed.
    const val = results[0];
    if (Array.isArray(val) && val.length > maxResults) {
      finalResult = val.slice(0, maxResults);
      truncated = true;
    } else {
      finalResult = val;
    }
  } else {
    // Multi-value result from `.[]` iteration.
    if (results.length > maxResults) {
      finalResult = results.slice(0, maxResults);
      truncated = true;
    } else {
      finalResult = results;
    }
  }

  // Byte cap on serialized output.
  // `JSON.stringify` returns `undefined` for undefined values (e.g. missing
  // object key or out-of-bounds array index). Normalise those to null so the
  // caller always gets a valid JSON-representable result.
  const serialized =
    finalResult === undefined ? 'null' : JSON.stringify(finalResult, null, 2);
  let resultPayload: unknown;
  if (Buffer.byteLength(serialized, 'utf-8') > maxBytes) {
    truncated = true;
    // Surface a truncated string rather than a half-formed JSON structure.
    // Truncate by UTF-8 byte count, not UTF-16 character count, so the
    // advertised byte bound is respected even for multi-byte characters.
    const buf = Buffer.from(serialized, 'utf-8');
    resultPayload = buf.slice(0, maxBytes).toString('utf-8') + '\n… [truncated]';
  } else {
    resultPayload = finalResult === undefined ? null : finalResult;
  }

  const response: Record<string, unknown> = {
    result: resultPayload,
    type: finalResult === undefined ? 'null' : typeName(finalResult),
    truncated,
    source_size: sourceSize,
  };

  return { content: JSON.stringify(response) };
}

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------

/**
 * Create a `json_query` handler closed over a session-specific base path.
 *
 * When invoked without a dispatcher context, `cwd` becomes the resolve base
 * so a handler built for a worktree session anchors relative paths to that
 * tree. Mirrors `createReadFileHandler`.
 */
export function createJsonQueryHandler(cwd?: string): ToolHandler {
  return (input, signal, context) => jsonQueryImpl(input, signal, context, cwd);
}

/** Bare `json_query` handler with no session cwd (`createJsonQueryHandler()`). */
export const jsonQueryHandler: ToolHandler = createJsonQueryHandler();
