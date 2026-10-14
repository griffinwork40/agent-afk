/**
 * Structured filters for `search_witness` / `read_witness`, split from
 * `witness.query.ts` under the 350-code-line ceiling.
 *
 *   - `where` — exact-match AND filter over dotted paths relative to the
 *     event (`kind`, `payload.decision`, `payload.hookEvent`, ...).
 *   - current-session exclusion — lets `search_witness` skip the caller's own
 *     live trace, which otherwise floods results with the very search in progress.
 *
 * Contract: path walking uses OWN properties only and rejects any segment
 * equal to `__proto__`, `constructor`, or `prototype` with a
 * {@link WitnessWhereError}; values must be scalars (string, number, boolean,
 * null). A path that does not resolve (missing key, non-object parent) is a
 * mismatch, not an error.
 *
 * @module agent/tools/handlers/witness.query.where
 */

import { resolve } from 'node:path';

export type WhereScalar = string | number | boolean | null;

/** Validated where clause: path segments + expected value, AND semantics. */
export type WhereClause = ReadonlyArray<{ path: string; segments: string[]; value: WhereScalar }>;

/** Thrown for a malformed `where` argument; handlers map it to a tool error. */
export class WitnessWhereError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WitnessWhereError';
  }
}

const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

/** Cap on clause count — a where object is a filter, not a query language. */
const MAX_WHERE_KEYS = 16;

function isScalar(v: unknown): v is WhereScalar {
  return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

/**
 * Validate a raw `where` argument. Returns `undefined` when absent; throws
 * {@link WitnessWhereError} on any malformed input.
 */
export function parseWhere(raw: unknown): WhereClause | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new WitnessWhereError('where must be an object mapping dotted paths to scalar values');
  }
  const keys = Object.keys(raw);
  if (keys.length > MAX_WHERE_KEYS) {
    throw new WitnessWhereError(`where accepts at most ${MAX_WHERE_KEYS} paths (got ${keys.length})`);
  }
  const clause: { path: string; segments: string[]; value: WhereScalar }[] = [];
  for (const path of keys) {
    const segments = path.split('.');
    if (segments.some((seg) => seg.length === 0)) {
      throw new WitnessWhereError(`where path "${path}" has an empty segment`);
    }
    const bad = segments.find((seg) => FORBIDDEN_SEGMENTS.has(seg));
    if (bad !== undefined) {
      throw new WitnessWhereError(`where path "${path}" uses forbidden segment "${bad}"`);
    }
    const value: unknown = (raw as Record<string, unknown>)[path];
    if (!isScalar(value)) {
      throw new WitnessWhereError(
        `where value for "${path}" must be a string, number, boolean, or null`,
      );
    }
    clause.push({ path, segments, value });
  }
  return clause;
}

const NOT_FOUND = Symbol('not-found');

function walkOwn(root: unknown, segments: readonly string[]): unknown {
  let cur: unknown = root;
  for (const seg of segments) {
    if (typeof cur !== 'object' || cur === null) return NOT_FOUND;
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) return NOT_FOUND;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** True when every clause entry resolves to an exactly-equal value. */
export function matchesWhere(event: unknown, where: WhereClause | undefined): boolean {
  if (where === undefined) return true;
  for (const { segments, value } of where) {
    const got = walkOwn(event, segments);
    if (got === NOT_FOUND || got !== value) return false;
  }
  return true;
}

/** Identity of the calling session's trace, used to exclude it from search. */
export interface CurrentSessionRef {
  /** Absolute trace.jsonl path of the caller's writer, when file-backed. */
  tracePath?: string;
  /** Caller's session id; matches witness dirs labelled by session id. */
  sessionId?: string;
}

/** True when a listed trace belongs to the calling session. */
export function isCurrentSession(
  entry: { sessionId: string; tracePath: string },
  current: CurrentSessionRef | undefined,
): boolean {
  if (current === undefined) return false;
  if (current.tracePath !== undefined && resolve(entry.tracePath) === resolve(current.tracePath)) {
    return true;
  }
  return current.sessionId !== undefined && entry.sessionId === current.sessionId;
}

/**
 * Build a {@link CurrentSessionRef} from a handler context. The writer's
 * trace path is authoritative (witness dirs are keyed by a writer label that
 * may differ from the session id); the in-memory sentinel path is ignored.
 */
export function currentSessionRef(ctx: {
  traceWriter?: { getTracePath(): string };
  sessionId?: string;
}): CurrentSessionRef | undefined {
  let tracePath: string | undefined;
  try {
    const p = ctx.traceWriter?.getTracePath();
    if (p !== undefined && !p.includes('://')) tracePath = p;
  } catch {
    /* a partial sink without getTracePath — fall back to sessionId */
  }
  if (tracePath === undefined && ctx.sessionId === undefined) return undefined;
  return {
    ...(tracePath !== undefined ? { tracePath } : {}),
    ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}),
  };
}

/** Hint attached when the match cap stopped a search early. */
export const MATCH_LIMIT_HINT =
  'Match cap reached; results are incomplete. Narrow with where (e.g. ' +
  '{"payload.decision":"block"}), since, kinds, or a more specific query.';
