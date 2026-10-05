/**
 * Async, non-blocking tool-result lookup for the web server route.
 *
 * `findToolResultAsync` is the async counterpart to the synchronous
 * `findToolResult` in reader.ts. It uses Node's `readline` interface over a
 * file-read stream so it never calls `readFileSync` and never blocks the event
 * loop.
 *
 * Key differences from the sync path:
 * - Streams each journal file line-by-line via `readline` over `createReadStream`.
 * - Scans ALL records (not the folded view), matching the sync behaviour.
 * - Keeps the newest match by `ts` across the top-level journal and every
 *   subagent journal, exactly as `findToolResult` does.
 * - `afk trace show --results` continues to use the sync `findToolResult` from
 *   reader.ts; this module is ONLY for the web route.
 *
 * @module agent/journal/reader.async
 */

import * as fs from 'node:fs';
import * as readline from 'node:readline';

import {
  getSessionJournalPath,
  getSubagentJournalPath,
  getSubagentJournalsDir,
  isSafeLedgerSessionId,
} from '../../paths.js';
import { hydrateBlock } from './hydrate.js';
import { parseJournalLine } from './records.js';
import type { JournalBlock, ToolResultLookup } from './types.js';

export type { ToolResultLookup } from './types.js';

type ToolResultBlock = Extract<JournalBlock, { type: 'tool_result' }>;

/**
 * Shared return-type alias for both the sync (`findToolResult` in reader.ts)
 * and async (`findToolResultAsync`) tool-result lookup paths. Consumers that
 * import from the journal index via `findToolResultAsync` should import this
 * type rather than spelling the inline shape to keep both sides in sync.
 *
 * @see findToolResult
 * @see findToolResultAsync
 */
export interface ToolResultLookup {
  /** Hydrated tool_result block. */
  block: ToolResultBlock;
  /** Subagent id, when the result lives in a subagent journal. */
  subagentId?: string;
}

/**
 * Scan one journal file for the newest record whose tool_result.toolUseId
 * matches `toolUseId`. Returns { block, ts } on a hit, or null.
 *
 * Uses `readline` over a `ReadStream` — fully async, never blocks the event
 * loop, and early-exits without reading the rest of the file are not possible
 * with readline (it reads to EOF), but the I/O itself is non-blocking.
 */
async function scanFileAsync(
  path: string,
  toolUseId: string,
): Promise<{ block: ToolResultBlock; ts: number } | null> {
  let best: { block: ToolResultBlock; ts: number } | null = null;
  let stream: fs.ReadStream;
  try {
    stream = fs.createReadStream(path, { encoding: 'utf8' });
  } catch {
    return null;
  }
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const rec = parseJournalLine(line);
      if (!rec || rec.kind !== 'append') continue;
      const content = rec.message.content;
      for (let j = content.length - 1; j >= 0; j--) {
        const b = content[j]!;
        if (b.type === 'tool_result' && b.toolUseId === toolUseId) {
          if (!best || rec.ts >= best.ts) {
            best = { block: b as ToolResultBlock, ts: rec.ts };
          }
          break; // only need the last match in this record's content array
        }
      }
    }
  } catch {
    // Unreadable / truncated file — return whatever was found so far.
  } finally {
    rl.close();
    stream.destroy();
  }
  return best;
}

/** Async list of subagent ids with a journal under `sessionId`. */
async function listSubagentJournalsAsync(sessionId: string): Promise<string[]> {
  if (typeof sessionId !== 'string' || !isSafeLedgerSessionId(sessionId)) return [];
  let names: string[];
  try {
    names = await fs.promises.readdir(getSubagentJournalsDir(sessionId));
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const id = name.slice(0, -'.jsonl'.length);
    if (isSafeLedgerSessionId(id)) ids.push(id);
  }
  return ids.sort();
}

/**
 * Async, non-blocking equivalent of `findToolResult` for the web route.
 *
 * Reads every journal (top-level + all subagent journals) via streaming
 * readline, returning the newest matching tool_result block (hydrated).
 * Never calls `readFileSync`.
 */
export async function findToolResultAsync(
  sessionId: string,
  toolUseId: string,
): Promise<ToolResultLookup | null> {
  if (typeof sessionId !== 'string' || !isSafeLedgerSessionId(sessionId)) return null;
  if (typeof toolUseId !== 'string' || toolUseId.length === 0) return null;

  const subagentIds = await listSubagentJournalsAsync(sessionId);

  // Build the list of (path, subagentId?) pairs to scan.
  const entries: Array<{ path: string; subagentId?: string }> = [];
  try {
    entries.push({ path: getSessionJournalPath(sessionId) });
  } catch {
    // unsafe / invalid path — skip
  }
  for (const subId of subagentIds) {
    try {
      entries.push({ path: getSubagentJournalPath(sessionId, subId), subagentId: subId });
    } catch {
      // skip invalid subagent paths
    }
  }

  // Scan all files concurrently (they are independent).
  const results = await Promise.all(
    entries.map(async (e) => {
      const hit = await scanFileAsync(e.path, toolUseId);
      return hit ? { ...hit, subagentId: e.subagentId } : null;
    }),
  );

  // Pick the entry with the highest ts (newest record wins).
  let best: { block: ToolResultBlock; ts: number; subagentId?: string } | null = null;
  for (const r of results) {
    if (r && (!best || r.ts > best.ts)) best = r;
  }
  if (!best) return null;

  const block = hydrateBlock(best.block) as ToolResultBlock;
  return best.subagentId !== undefined ? { block, subagentId: best.subagentId } : { block };
}
