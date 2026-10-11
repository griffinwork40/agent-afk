/**
 * Calibration ledger for the what-if prediction engine.
 *
 * Every prediction + verified outcome is appended to
 * `~/.afk/state/whatif/ledger.jsonl` so the engine can report its track
 * record per change kind when generating new predictions.
 *
 * @module whatif/ledger
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { getWhatifDir } from '../paths.js';
import type { Prediction, Verdict } from './types.js';
import { isErrnoCode } from '../utils/errors.js';
import { parseJsonlLines } from '../utils/jsonl.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CalibrationRecord {
  ts: string;
  changeKinds: string[];
  prediction: Prediction;
  verdict: Verdict;
  delta: number;
}

// ---------------------------------------------------------------------------
// appendCalibration
// ---------------------------------------------------------------------------

/**
 * Append calibration records to the ledger file.
 *
 * Each record is written as a newline-delimited JSON line.  The directory is
 * created if it does not exist.
 *
 * @param records  Calibration records to append.
 * @param file     Override path (tests inject a tmp path).
 */
export async function appendCalibration(
  records: CalibrationRecord[],
  file?: string,
): Promise<void> {
  if (records.length === 0) return;

  const ledgerPath = file ?? path.join(getWhatifDir(), 'ledger.jsonl');
  const dir = path.dirname(ledgerPath);

  await fsp.mkdir(dir, { recursive: true });

  const lines = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  await fsp.appendFile(ledgerPath, lines, 'utf8');
}

// ---------------------------------------------------------------------------
// trackRecordSummary
// ---------------------------------------------------------------------------

/**
 * Read the calibration ledger and produce a per-change-kind summary string
 * for use in prediction prompts.
 *
 * Only change kinds with ≥ 3 resolved (confirmed + refuted) records are
 * included.  Returns `undefined` when nothing qualifies.
 *
 * Example output line:
 *   `memory-add changes: 4 of 10 past predictions confirmed (40%).`
 *
 * @param changeKinds  The change kinds in the current run (used to filter).
 * @param file         Override path (tests inject a tmp path).
 */
export async function trackRecordSummary(
  changeKinds: string[],
  file?: string,
): Promise<string | undefined> {
  const ledgerPath = file ?? path.join(getWhatifDir(), 'ledger.jsonl');

  let raw: string;
  try {
    raw = await fsp.readFile(ledgerPath, 'utf8');
  } catch (e) {
    if (isErrnoCode(e, 'ENOENT')) return undefined;
    throw e;
  }

  // ── Aggregate per change kind ─────────────────────────────────────────────
  const stats = new Map<string, { confirmed: number; total: number }>();

  // Discriminant pair: `ts` (ISO timestamp string) and `verdict` ('confirmed' |
  // 'refuted') are the two fields that every CalibrationRecord must carry and
  // that plain JSON objects (e.g. index lines, partial writes) will not have.
  // Checking both gives stronger type narrowing than a single field would.
  const isCalibrationRecord = (x: unknown): x is CalibrationRecord =>
    x !== null &&
    typeof x === 'object' &&
    typeof (x as Record<string, unknown>)['ts'] === 'string' &&
    typeof (x as Record<string, unknown>)['verdict'] === 'string';
  const records = parseJsonlLines<CalibrationRecord>(raw, { guard: isCalibrationRecord });

  for (const rec of records) {
    if (rec.verdict !== 'confirmed' && rec.verdict !== 'refuted') continue;

    for (const kind of rec.changeKinds) {
      if (!stats.has(kind)) stats.set(kind, { confirmed: 0, total: 0 });
      const entry = stats.get(kind)!;
      entry.total++;
      if (rec.verdict === 'confirmed') entry.confirmed++;
    }
  }

  // ── Build summary lines ───────────────────────────────────────────────────
  const changeKindSet = new Set(changeKinds);
  const lines: string[] = [];

  for (const [kind, { confirmed, total }] of stats.entries()) {
    if (total < 3) continue;
    if (!changeKindSet.has(kind)) continue;
    const pct = Math.round((confirmed / total) * 100);
    lines.push(`${kind} changes: ${confirmed} of ${total} past predictions confirmed (${pct}%).`);
  }

  return lines.length > 0 ? lines.join('\n') : undefined;
}
