#!/usr/bin/env tsx
/**
 * Benchmark: synchronous whole-journal load per resumed request (#3390).
 *
 * Measures `loadJournalMessages` on a synthetic large, repeatedly-compacted
 * journal to quantify the per-request cost of the synchronous read that runs
 * inside the AgentSession constructor for every HTTP service call that passes
 * `resume: sid`.
 *
 * This script is NOT part of the default `pnpm test` run. Run it once and
 * capture the numbers for the PR body:
 *
 *   tsx scripts/benchmark-journal-load.ts
 *
 * Implementation note: `loadJournalMessages` runs `readJournalFile` (one
 * blocking `fs.readFileSync`), parses every JSONL line, folds the records
 * into a message array applying truncate/append mutations, then hydrates
 * every message. The writer re-reads the same file for its base length.
 * Both reads scale with total historical record count (including records
 * obsoleted by truncation/compaction), not just the live message count.
 *
 * @module scripts/benchmark-journal-load
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Set up a temp AFK_HOME so loadJournalMessages reads from our synthetic dir.
// This is a standalone script, so direct process.env access is acceptable here.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-bench-journal-'));
process.env['AFK_HOME'] = tmpDir; // audit-env-access: allow — standalone benchmark script, not production src/

try {
  await runBenchmark();
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

async function runBenchmark(): Promise<void> {
  // Dynamically import after env is set so paths.ts picks up the temp dir.
  const { loadJournalMessages, createMessageJournal } = await import('../src/agent/journal/index.js');
  const { getSessionJournalPath, getSessionLedgerDir } = await import('../src/paths.js');

  // ─── Configuration ─────────────────────────────────────────────────────────

  /** Messages visible in the live fold at any time (simulates n-turn session). */
  const LIVE_MESSAGES = 50;
  /** Compaction cycles simulated: each cycle truncates to 2 + appends a summary. */
  const COMPACT_CYCLES = [0, 5, 20, 50, 100];
  /** Number of measurement iterations per scenario (median is reported). */
  const ITERATIONS = 200;

  // ─── Journal builder ───────────────────────────────────────────────────────

  function buildJournal(sessionId: string, compactCycles: number): { recordCount: number; fileSizeBytes: number } {
    fs.mkdirSync(getSessionLedgerDir(sessionId), { recursive: true });

    const lines: string[] = [];
    let msgIndex = 0;

    function appendRecord(rec: Record<string, unknown>): void {
      lines.push(JSON.stringify({ v: 1, ts: Date.now(), ...rec }));
    }

    // Seed initial messages.
    for (let i = 0; i < LIVE_MESSAGES; i++) {
      appendRecord({
        kind: 'append',
        index: msgIndex++,
        message: {
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: [{ type: 'text', text: `Message ${i}: ${'x'.repeat(80)}` }],
        },
      });
    }

    // Each compaction cycle: truncate to 2, append a summary + fill back up.
    for (let c = 0; c < compactCycles; c++) {
      appendRecord({ kind: 'truncate', length: 2, reason: 'compact' });
      msgIndex = 2;
      // Summary message.
      appendRecord({
        kind: 'append',
        index: msgIndex++,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `Compact summary ${c}: ${'y'.repeat(200)}` }],
        },
      });
      // Fill back up to LIVE_MESSAGES.
      for (let i = msgIndex; i < LIVE_MESSAGES; i++) {
        appendRecord({
          kind: 'append',
          index: msgIndex++,
          message: {
            role: i % 2 === 0 ? 'user' : 'assistant',
            content: [{ type: 'text', text: `Post-compact ${c} msg ${i}: ${'z'.repeat(60)}` }],
          },
        });
      }
    }

    const content = lines.join('\n') + '\n';
    fs.writeFileSync(getSessionJournalPath(sessionId), content, 'utf8');
    return { recordCount: lines.length, fileSizeBytes: Buffer.byteLength(content) };
  }

  // ─── Measurement ───────────────────────────────────────────────────────────

  function measureMedian(fn: () => void, n: number): number {
    // Warm-up pass to populate OS file cache.
    for (let i = 0; i < 5; i++) fn();

    const times: number[] = [];
    for (let i = 0; i < n; i++) {
      const start = performance.now();
      fn();
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    return times[Math.floor(times.length / 2)]!;
  }

  // ─── Run scenarios ─────────────────────────────────────────────────────────

  console.log('\n── benchmark-journal-load (#3390) ──────────────────────────────────────────');
  console.log(`loadJournalMessages synchronous cost (N=${ITERATIONS} iterations, median)`);
  console.log(`Live messages per fold: ${LIVE_MESSAGES}`);
  console.log('');
  console.log('compact_cycles  records  file_kb  median_ms  p95_ms');
  console.log('─────────────────────────────────────────────────────');

  for (const cycles of COMPACT_CYCLES) {
    const sid = `bench-${cycles}-cycles`;
    const { recordCount, fileSizeBytes } = buildJournal(sid, cycles);

    // Warm-up.
    loadJournalMessages(sid);

    const allTimes: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t = performance.now();
      loadJournalMessages(sid);
      allTimes.push(performance.now() - t);
    }
    const times: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const t = performance.now();
      loadJournalMessages(sid);
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)]!;
    const p95 = times[Math.floor(times.length * 0.95)]!;
    const fileKb = (fileSizeBytes / 1024).toFixed(1);

    console.log(
      `${String(cycles).padStart(14)}  ${String(recordCount).padStart(7)}  ${fileKb.padStart(7)}  ${median.toFixed(3).padStart(9)}  ${p95.toFixed(3).padStart(6)}`,
    );
  }

  console.log('');
  console.log('Interpretation:');
  console.log('  median_ms — typical synchronous block on the event loop per request.');
  console.log('  p95_ms    — tail latency (95th percentile).');
  console.log('  Cost scales with total record count (historical + live), not just');
  console.log('  live messages — compacted journals accumulate obsolete records.');
  console.log('────────────────────────────────────────────────────────────────────────────');
}
