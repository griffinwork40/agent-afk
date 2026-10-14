/**
 * Read a session's human name from its sidecar (`<sessions>/<id>.json`)
 * without parsing the whole file.
 *
 * The sidecar's top-level `name` is what `/resume` lists and what `/name`
 * sets (auto-derived from the first user message otherwise; see
 * `src/cli/session-name.ts`). Using it makes the web session list show the
 * same title as the REPL picker for every session that has one.
 *
 * Invariant: head-read only. Sidecars carry the full `turns` array and reach
 * multiple MB, and the session list is polled, so parsing up to 100 of them
 * per request is not acceptable. `saveSession` writes `name` as the second
 * key (right after `sessionId`, before `turns`) with `JSON.stringify(x, null,
 * 2)`, so a top-level key is a line indented by exactly two spaces. Matching
 * only that indentation, and only before the `"turns"` key, keeps a nested
 * `name` field (e.g. inside a tool event) from ever being mistaken for it.
 *
 * @module web-server/session-name-head
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { getSessionsDir } from '../paths.js';

/** Bytes read from the start of a sidecar; `name` sits within the first few lines. */
const SIDECAR_HEAD_BYTES = 4096;

/**
 * Extract the top-level `name` from the head of a pretty-printed sidecar.
 * Returns `undefined` when absent, empty, or not a well-formed JSON string.
 */
export function parseSidecarName(head: string): string | undefined {
  const turnsAt = head.search(/^ {2}"turns"\s*:/m);
  const scope = turnsAt >= 0 ? head.slice(0, turnsAt) : head;
  const match = /^ {2}"name"\s*:\s*("(?:[^"\\\n]|\\.)*")/m.exec(scope);
  if (!match?.[1]) return undefined;
  try {
    const value: unknown = JSON.parse(match[1]);
    return typeof value === 'string' && value.trim() ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The sidecar `name` for `sessionId`, or `undefined` when there is no sidecar
 * (e.g. a session started from the web UI, which does not write one) or it
 * carries no name. Never throws.
 */
export async function readSidecarName(sessionId: string): Promise<string | undefined> {
  let fh: fsp.FileHandle | undefined;
  try {
    fh = await fsp.open(path.join(getSessionsDir(), `${sessionId}.json`), 'r');
    const buf = Buffer.alloc(SIDECAR_HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, SIDECAR_HEAD_BYTES, 0);
    return parseSidecarName(buf.subarray(0, bytesRead).toString('utf8'));
  } catch {
    return undefined;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}
