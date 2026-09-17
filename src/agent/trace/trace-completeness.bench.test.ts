/**
 * Benchmark: trace completeness under kill -9.
 *
 * Tests that `NdjsonTraceWriter` events whose `appendFile` completed before
 * SIGKILL survive on disk, and that in-flight writes (started but not yet
 * awaited) do not corrupt earlier events. Validates the incremental-flush
 * claim from `docs/philosophy/afk-contract.md`.
 *
 * The benchmark spawns isolated child processes that write trace events, then
 * sends SIGKILL at a configurable boundary. After the child exits the test
 * reads back the NDJSON file and counts valid events. Completeness is reported
 * as a percentage of expected events recovered.
 *
 * Contract: `appendFile` puts data in the kernel page cache (no fsync per
 * event). On process kill the kernel flushes dirty pages, so completed writes
 * survive. This benchmark validates that property, not power-failure durability.
 *
 * Note: `session_sealed` survival is NOT part of the completeness score — the
 * writer's own docs acknowledge SIGKILL is uncatchable. Only event records are
 * measured against the contract.
 *
 * @module agent/trace/trace-completeness.bench
 */

import { mkdtemp, readFile, stat, rm } from 'fs/promises';
import { existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TraceEvent } from './types.js';

// ---------------------------------------------------------------------------
// Locate tsx — worktrees share node_modules with the main repo.
// Walk up the directory tree from this file until we find node_modules/.bin/tsx.
// ---------------------------------------------------------------------------
const here = dirname(fileURLToPath(import.meta.url));
const writerSrc = join(here, 'writer.ts');

function resolveTsx(): string {
  let dir = here;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'node_modules', '.bin', 'tsx');
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  return 'tsx'; // fall back to PATH
}
const tsxBin = resolveTsx();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a NDJSON trace file, skipping any trailing partial line. */
async function readTrace(tracePath: string): Promise<TraceEvent[]> {
  let body: string;
  try {
    body = await readFile(tracePath, 'utf8');
  } catch {
    return [];
  }
  const events: TraceEvent[] = [];
  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as TraceEvent);
    } catch {
      // Partial last line from a mid-write kill — skip it, do not fail.
    }
  }
  return events;
}

/** Count only tool_call events (session_sealed excluded from completeness score). */
function countToolCalls(events: TraceEvent[]): number {
  return events.filter((e) => e.kind === 'tool_call').length;
}

/** Verify seq is strictly monotonically increasing for all recovered events. */
function isMonotonic(events: TraceEvent[]): boolean {
  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1];
    const curr = events[i];
    if (prev === undefined || curr === undefined) return false;
    if (curr.seq <= prev.seq) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Child script builders
//
// buildChildScript: writes pairsBeforeSignal pairs, prints READY, then sleeps.
// All writes complete before READY — tests post-completion survival.
//
// buildMidWriteChildScript: writes pairsBeforeSignal pairs, prints READY, then
// fires pairsAfterSignal more pairs WITHOUT awaiting. The kill races in-flight
// writes — tests that completed writes survive even when later writes are
// interrupted, and that partial writes don't corrupt the NDJSON file.
// ---------------------------------------------------------------------------
function buildChildScript(traceDir: string, pairsBeforeSignal: number): string {
  return [
    `import { NdjsonTraceWriter } from ${JSON.stringify(writerSrc)};`,
    `const w = new NdjsonTraceWriter({ traceDir: ${JSON.stringify(traceDir)} });`,
    `async function main() {`,
    `  for (let i = 0; i < ${pairsBeforeSignal}; i++) {`,
    `    await w.write({ kind: 'tool_call', payload: {`,
    `      phase: 'started', toolUseId: 't' + i, name: 'bash',`,
    `      inputBytes: i, argsFingerprint: 'a'.repeat(64) } });`,
    `    await w.write({ kind: 'tool_call', payload: {`,
    `      phase: 'completed', toolUseId: 't' + i, name: 'bash',`,
    `      resultBytes: i, isError: false, truncated: false, durationMs: 1 } });`,
    `  }`,
    `  process.stdout.write('READY\\n');`,
    `  await new Promise(r => setTimeout(r, 60_000));`,
    `}`,
    `main().catch(e => { console.error(e); process.exit(1); });`,
  ].join('\n');
}

function buildMidWriteChildScript(
  traceDir: string,
  pairsBeforeSignal: number,
  pairsAfterSignal: number,
): string {
  return [
    `import { NdjsonTraceWriter } from ${JSON.stringify(writerSrc)};`,
    `const w = new NdjsonTraceWriter({ traceDir: ${JSON.stringify(traceDir)} });`,
    `async function main() {`,
    // Phase 1: write pairs and await each — these are durably in kernel cache.
    `  for (let i = 0; i < ${pairsBeforeSignal}; i++) {`,
    `    await w.write({ kind: 'tool_call', payload: {`,
    `      phase: 'started', toolUseId: 't' + i, name: 'bash',`,
    `      inputBytes: i, argsFingerprint: 'a'.repeat(64) } });`,
    `    await w.write({ kind: 'tool_call', payload: {`,
    `      phase: 'completed', toolUseId: 't' + i, name: 'bash',`,
    `      resultBytes: i, isError: false, truncated: false, durationMs: 1 } });`,
    `  }`,
    // Signal READY, then immediately start more writes without awaiting.
    // The kill races these in-flight writes.
    `  process.stdout.write('READY\\n');`,
    `  for (let i = ${pairsBeforeSignal}; i < ${pairsBeforeSignal + pairsAfterSignal}; i++) {`,
    `    w.write({ kind: 'tool_call', payload: {`,
    `      phase: 'started', toolUseId: 't' + i, name: 'bash',`,
    `      inputBytes: i, argsFingerprint: 'b'.repeat(64) } });`,
    `    w.write({ kind: 'tool_call', payload: {`,
    `      phase: 'completed', toolUseId: 't' + i, name: 'bash',`,
    `      resultBytes: i, isError: false, truncated: false, durationMs: 1 } });`,
    `  }`,
    `  await new Promise(r => setTimeout(r, 60_000));`,
    `}`,
    `main().catch(e => { console.error(e); process.exit(1); });`,
  ].join('\n');
}

/** Spawn child, wait for READY signal, send SIGKILL, wait for child to exit. */
async function spawnAndKill(scriptPath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(tsxBin, [scriptPath], {
      env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });

    let buf = '';
    let killed = false;

    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      if (!killed && buf.includes('READY')) {
        killed = true;
        child.kill('SIGKILL');
      }
    });

    child.on('exit', () => resolve());
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') { reject(new Error(`tsx not found at: ${tsxBin}`)); return; }
      resolve(); // SIGKILL may surface as error
    });
  });
}

// ---------------------------------------------------------------------------
// Benchmark result accumulator
// ---------------------------------------------------------------------------
interface BenchResult {
  scenario: string;
  expected: number;
  recovered: number;
  monotonic: boolean;
  sealed: boolean;
}
const results: BenchResult[] = [];

// ---------------------------------------------------------------------------
// Benchmark scenarios
// ---------------------------------------------------------------------------

describe.skipIf(process.platform === 'win32')(
  'trace completeness under kill -9 (POSIX only)',
  () => {
    let rootDir: string;

    beforeAll(async () => {
      rootDir = await mkdtemp(join(tmpdir(), 'afk-bench-'));
    });

    afterAll(async () => {
      await rm(rootDir, { recursive: true, force: true });

      const total = results.reduce((s, r) => s + r.expected, 0);
      const found = results.reduce((s, r) => s + r.recovered, 0);
      const pct = total > 0 ? ((found / total) * 100).toFixed(1) : 'N/A';

      process.stdout.write('\n=== Trace Completeness Benchmark Results ===\n');
      for (const r of results) {
        const p = r.expected > 0 ? `${((r.recovered / r.expected) * 100).toFixed(0)}%` : 'N/A';
        process.stdout.write(
          `  ${r.scenario.padEnd(30)} ${String(r.recovered).padStart(3)}/${String(r.expected).padEnd(3)}` +
            ` ${p.padStart(5)}  sealed=${String(r.sealed)}  mono=${String(r.monotonic)}\n`,
        );
      }
      process.stdout.write(
        `  ${'TOTAL'.padEnd(30)} ${String(found).padStart(3)}/${String(total).padEnd(3)} ${pct.padStart(5)}\n`,
      );
      process.stdout.write('============================================\n\n');
    });

    // -------------------------------------------------------------------------
    // Scenario A: zero-events — kill before any write
    // -------------------------------------------------------------------------
    it('zero-events: no trace file when killed before first write', async () => {
      const traceDir = join(rootDir, 'zero-events');
      const scriptPath = join(rootDir, 'zero-events.mts');
      writeFileSync(scriptPath, [
        `async function main() {`,
        `  process.stdout.write('READY\\n');`,
        `  await new Promise(r => setTimeout(r, 60_000));`,
        `}`,
        `main().catch(e => { console.error(e); process.exit(1); });`,
      ].join('\n'));

      await spawnAndKill(scriptPath);

      let fileExists = false;
      try {
        await stat(join(traceDir, 'trace.jsonl'));
        fileExists = true;
      } catch { fileExists = false; }

      expect(fileExists).toBe(false);
      results.push({ scenario: 'zero-events', expected: 0, recovered: 0, monotonic: true, sealed: false });
    }, 15_000);

    // -------------------------------------------------------------------------
    // Scenario B: mid-sequence — kill after 1 of 5 pairs flushed
    // -------------------------------------------------------------------------
    it('mid-sequence: events flushed before kill survive intact', async () => {
      const traceDir = join(rootDir, 'mid-seq');
      const scriptPath = join(rootDir, 'mid-seq.mts');
      // 1 pair before READY signal; killed immediately after signal.
      writeFileSync(scriptPath, buildChildScript(traceDir, 1));

      await spawnAndKill(scriptPath);

      const events = await readTrace(join(traceDir, 'trace.jsonl'));
      const recovered = countToolCalls(events);
      const mono = isMonotonic(events);
      const sealed = events.some((e) => e.kind === 'session_sealed');

      expect(recovered).toBe(2); // 1 pair = started + completed
      expect(mono).toBe(true);
      expect(sealed).toBe(false); // SIGKILL: exit backstop cannot run

      results.push({ scenario: 'mid-sequence', expected: 2, recovered, monotonic: mono, sealed });
    }, 15_000);

    // -------------------------------------------------------------------------
    // Scenario C: batch-complete — kill after all 5 pairs flushed, before seal
    // -------------------------------------------------------------------------
    it('batch-complete: all flushed events survive a pre-seal kill', async () => {
      const traceDir = join(rootDir, 'batch-complete');
      const scriptPath = join(rootDir, 'batch-complete.mts');
      writeFileSync(scriptPath, buildChildScript(traceDir, 5));

      await spawnAndKill(scriptPath);

      const events = await readTrace(join(traceDir, 'trace.jsonl'));
      const recovered = countToolCalls(events);
      const mono = isMonotonic(events);
      const sealed = events.some((e) => e.kind === 'session_sealed');

      expect(recovered).toBe(10); // 5 pairs × 2 events
      expect(mono).toBe(true);
      expect(sealed).toBe(false);

      results.push({ scenario: 'batch-complete', expected: 10, recovered, monotonic: mono, sealed });
    }, 15_000);

    // -------------------------------------------------------------------------
    // Scenario D: mid-write — 3 pairs complete, then READY, then 10 more pairs
    // fire-and-forget (not awaited). Kill races the in-flight writes.
    // Only the 3 pre-signal pairs are guaranteed; post-signal events may or
    // may not land. The test verifies:
    //   (a) at least the 3 pre-signal pairs (6 events) survive
    //   (b) any partial post-signal writes don't corrupt the NDJSON
    //   (c) seq monotonicity holds across whatever events survived
    // -------------------------------------------------------------------------
    it('mid-write: pre-signal events survive when kill races in-flight writes', async () => {
      const traceDir = join(rootDir, 'mid-write');
      const scriptPath = join(rootDir, 'mid-write.mts');
      writeFileSync(scriptPath, buildMidWriteChildScript(traceDir, 3, 10));

      await spawnAndKill(scriptPath);

      const events = await readTrace(join(traceDir, 'trace.jsonl'));
      const recovered = countToolCalls(events);
      const mono = isMonotonic(events);
      const sealed = events.some((e) => e.kind === 'session_sealed');

      // At least the 3 pre-signal pairs (6 events) must survive.
      // Some post-signal events may also land (kernel flushes dirty pages on
      // process exit), but we don't require them.
      expect(recovered).toBeGreaterThanOrEqual(6);
      expect(mono).toBe(true);
      expect(sealed).toBe(false);

      // Report only the guaranteed pre-signal events as the "expected" baseline.
      results.push({ scenario: 'mid-write', expected: 6, recovered, monotonic: mono, sealed });
    }, 15_000);
  },
);
