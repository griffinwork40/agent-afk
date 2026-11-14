/**
 * CLI subcommands for run-receipt management.
 *
 * Subcommands:
 *   afk receipt regenerate [--session <id>...] [--all] [--only-v1]
 *                          [--dry-run] [--json]
 *
 * The `regenerate` subcommand rebuilds v1 (or older) receipts on disk as v2
 * receipts by re-reading the original witness trace and the session's message
 * journal — the same inputs `writeRunReceipt` uses at session end — and
 * rewriting the JSON + Markdown files atomically.
 *
 * Enumeration strategy (mirrors `src/agent/facets/store.ts`):
 *   1. Read `sessions/<id>/session-meta.json` (O(1), #4429).
 *   2. Fall back to the `kind:"meta"` record at the head of
 *      `sessions/<id>/events.jsonl` (pre-sidecar sessions).
 *   3. If neither resolves a traceLabel, or `witness/<label>/trace.jsonl`
 *      is absent, skip and count the session as skipped.
 *
 * @module cli/commands/receipt
 * @see https://github.com/griffinwork40/agent-afk/issues/4452
 */

import { Command } from 'commander';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { handleCommandError } from '../errors/index.js';
import { getSessionsDir, isSafeLedgerSessionId } from '../../paths.js';
import { getTraceDir, getReceiptsDir } from '../../paths.witness.js';
import {
  writeRunReceipt,
  RECEIPT_SCHEMA_VERSION,
  type RunReceipt,
} from '../../agent/trace/receipt.js';
import { readSessionMeta } from '../../agent/session/session-meta.js';
import { env } from '../../config/env.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Bytes read from the head of events.jsonl to find the `kind:"meta"` record. */
const EVENTS_META_HEAD_BYTES = 8 * 1024;

/**
 * Resolve the witness trace label for `sessionId`.
 *
 * Returns:
 *  - `{ kind: 'label', label }` when a non-empty traceLabel was found.
 *  - `{ kind: 'disabled' }`     when tracing was explicitly disabled (null).
 *  - `{ kind: 'none' }`         when no signal was found.
 */
async function resolveTraceLabel(
  sessionId: string,
  sessionsRoot: string,
): Promise<{ kind: 'label'; label: string } | { kind: 'disabled' } | { kind: 'none' }> {
  // Fast path: session-meta.json sidecar (O(1), written since #4429).
  const sideMeta = readSessionMeta(sessionId);
  if (sideMeta !== null) {
    if (typeof sideMeta.traceLabel === 'string' && sideMeta.traceLabel.length > 0) {
      if (!isSafeLedgerSessionId(sideMeta.traceLabel)) return { kind: 'none' };
      return { kind: 'label', label: sideMeta.traceLabel };
    }
    if (sideMeta.traceLabel === null) return { kind: 'disabled' };
    // sidecar present but traceLabel field absent — fall through to events.jsonl
  }

  // Fallback: scan the head of events.jsonl for pre-sidecar sessions.
  const eventsPath = join(sessionsRoot, sessionId, 'events.jsonl');
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(eventsPath, 'r');
    const buf = Buffer.alloc(EVENTS_META_HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, EVENTS_META_HEAD_BYTES, 0);
    const firstLine = buf.subarray(0, bytesRead).toString('utf8').split('\n', 1)[0] ?? '';
    const rec = JSON.parse(firstLine) as { kind?: unknown; traceLabel?: unknown };
    if (rec.kind === 'meta') {
      if (typeof rec.traceLabel === 'string' && rec.traceLabel.length > 0) {
        if (!isSafeLedgerSessionId(rec.traceLabel)) return { kind: 'none' };
        return { kind: 'label', label: rec.traceLabel };
      }
      if (rec.traceLabel === null) return { kind: 'disabled' };
      return { kind: 'none' }; // meta present but field absent (pre-field ledger)
    }
  } catch {
    // no events.jsonl, truncated, or corrupt — treat as no signal
  } finally {
    await fh?.close().catch(() => undefined);
  }
  return { kind: 'none' };
}

/**
 * Read the schemaVersion from an existing receipt JSON on disk.
 * Returns `null` when the file does not exist or is unreadable.
 */
async function readReceiptSchemaVersion(jsonPath: string): Promise<number | null> {
  try {
    const raw = await readFile(jsonPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<RunReceipt>;
    return typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// regenerate action
// ---------------------------------------------------------------------------

interface RegenerateOptions {
  session: string[];
  all: boolean;
  onlyV1: boolean;
  dryRun: boolean;
  json: boolean;
}

interface SessionResult {
  sessionId: string;
  outcome: 'regenerated' | 'skipped' | 'already-current' | 'dry-run';
  reason?: string;
  jsonPath?: string;
  mdPath?: string;
}

async function runRegenerate(opts: RegenerateOptions): Promise<void> {
  if (env.AFK_RUN_RECEIPT_DISABLED === '1') {
    if (opts.json) {
      process.stdout.write(JSON.stringify({ error: 'AFK_RUN_RECEIPT_DISABLED=1; receipts are disabled.' }) + '\n');
    } else {
      process.stderr.write('receipts disabled (AFK_RUN_RECEIPT_DISABLED=1)\n');
    }
    return;
  }

  const sessionsRoot = getSessionsDir();

  // Build the list of session ids to process.
  let sessionIds: string[];
  if (opts.all) {
    let entries: string[];
    try {
      const dirents = await readdir(sessionsRoot, { withFileTypes: true });
      entries = dirents
        .filter((d) => d.isDirectory() && isSafeLedgerSessionId(d.name))
        .map((d) => d.name);
    } catch {
      entries = [];
    }
    sessionIds = entries;
  } else if (opts.session.length > 0) {
    sessionIds = opts.session;
  } else {
    process.stderr.write(
      'error: specify --all or one or more --session <id> arguments\n' +
        'Run `afk receipt regenerate --help` for usage.\n',
    );
    process.exitCode = 1;
    return;
  }

  // Apply --only-v1 when --all is used (default) or explicitly requested.
  const onlyV1 = opts.onlyV1 || opts.all;

  const results: SessionResult[] = [];
  let regenerated = 0;
  let wouldRegenerate = 0;
  let skipped = 0;
  let alreadyCurrent = 0;
  const seenLabels = new Set<string>();

  for (const sessionId of sessionIds) {
    if (!isSafeLedgerSessionId(sessionId)) {
      results.push({ sessionId, outcome: 'skipped', reason: 'unsafe session id' });
      skipped++;
      continue;
    }

    // Resolve traceLabel.
    const resolved = await resolveTraceLabel(sessionId, sessionsRoot);
    if (resolved.kind === 'disabled') {
      results.push({ sessionId, outcome: 'skipped', reason: 'tracing disabled for this session' });
      skipped++;
      continue;
    }
    if (resolved.kind === 'none') {
      results.push({ sessionId, outcome: 'skipped', reason: 'no traceLabel resolvable' });
      skipped++;
      continue;
    }

    const traceLabel = resolved.label;
    if (!isSafeLedgerSessionId(traceLabel)) {
      results.push({ sessionId, outcome: 'skipped', reason: 'unsafe traceLabel' });
      skipped++;
      continue;
    }
    if (seenLabels.has(traceLabel)) {
      results.push({ sessionId, outcome: 'skipped', reason: 'duplicate traceLabel' });
      skipped++;
      continue;
    }
    seenLabels.add(traceLabel);
    const tracePath = join(getTraceDir(traceLabel), 'trace.jsonl');

    // Check the existing receipt schema version when --only-v1 applies.
    const receiptsDir = getReceiptsDir();
    const jsonPath = join(receiptsDir, `${traceLabel}.json`);
    const mdPath = join(receiptsDir, `${traceLabel}.md`);

    // Probe trace existence before dry-run so we never overcount absent traces.
    try {
      await stat(tracePath);
    } catch {
      results.push({ sessionId, outcome: 'skipped', reason: 'trace file absent' });
      skipped++;
      continue;
    }

    if (onlyV1) {
      const existingVersion = await readReceiptSchemaVersion(jsonPath);
      if (existingVersion !== null && existingVersion >= RECEIPT_SCHEMA_VERSION) {
        results.push({ sessionId, outcome: 'already-current', reason: `schemaVersion ${existingVersion}` });
        alreadyCurrent++;
        continue;
      }
    }

    if (opts.dryRun) {
      results.push({ sessionId, outcome: 'dry-run', jsonPath, mdPath });
      wouldRegenerate++;
      continue;
    }

    // Call writeRunReceipt — atomic, reads trace + journal.
    const written = await writeRunReceipt({ tracePath, sessionId });
    if (written === null) {
      results.push({ sessionId, outcome: 'skipped', reason: 'trace missing or empty' });
      skipped++;
    } else {
      results.push({ sessionId, outcome: 'regenerated', jsonPath: written.jsonPath, mdPath: written.mdPath });
      regenerated++;
    }
  }

  // Output.
  if (opts.json) {
    // Emit both keys in both modes so scripting consumers can read either key
    // regardless of whether --dry-run was passed.  The inapplicable counter is
    // always 0: `wouldRegenerate` is 0 in live mode; `regenerated` is 0 in
    // dry-run mode.
    const jsonOut = {
      wouldRegenerate: opts.dryRun ? wouldRegenerate : 0,
      regenerated: opts.dryRun ? 0 : regenerated,
      skipped,
      alreadyCurrent,
      results,
    };
    process.stdout.write(JSON.stringify(jsonOut, null, 2) + '\n');
    return;
  }

  if (opts.dryRun) {
    process.stdout.write(`[dry-run] would regenerate ${wouldRegenerate} receipt(s):\n`);
    for (const r of results) {
      if (r.outcome === 'dry-run') {
        process.stdout.write(`  ${r.sessionId}  →  ${r.jsonPath ?? ''}\n`);
      }
    }
    if (skipped > 0) {
      process.stdout.write(`  (${skipped} session(s) would be skipped)\n`);
    }
    return;
  }

  process.stdout.write(
    `regenerated ${regenerated} receipt(s), skipped ${skipped}, already current ${alreadyCurrent}\n`,
  );
  for (const r of results) {
    if (r.outcome === 'regenerated') {
      process.stdout.write(`  ✓ ${r.sessionId}  →  ${r.jsonPath ?? ''}\n`);
    } else if (r.outcome === 'skipped') {
      process.stdout.write(`  - ${r.sessionId}  (${r.reason ?? 'skipped'})\n`);
    }
  }
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerReceiptCommand(program: Command): void {
  const receipt = program
    .command('receipt')
    .description('Manage run receipts — human- and machine-readable session summaries.');

  // afk receipt regenerate
  receipt
    .command('regenerate')
    .description(
      'Rebuild existing receipts as v2 from the witness trace + message journal.\n' +
        'By default (with --all) skips receipts already at the current schema version.',
    )
    .option(
      '--session <id>',
      'Regenerate receipt for a specific session id (repeatable)',
      (val: string, prev: string[]) => [...prev, val],
      [] as string[],
    )
    .option('--all', 'Enumerate all sessions under the state directory', false)
    .option(
      '--only-v1',
      'Skip receipts already at the current schema version (implied by --all)',
      false,
    )
    .option('--dry-run', 'Print what would be regenerated without writing', false)
    .option('--json', 'Emit structured JSON output', false)
    .action(async (options: RegenerateOptions) => {
      try {
        await runRegenerate(options);
      } catch (err) {
        handleCommandError(err);
      }
    });
}
