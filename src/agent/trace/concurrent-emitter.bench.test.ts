/**
 * Benchmark: concurrent-emitter trace integrity under kill -9.
 *
 * The single-writer benchmark (trace-completeness.bench.test.ts) proved that
 * O_APPEND writes survive SIGKILL for one `NdjsonTraceWriter`. Production runs
 * routinely have 5-10 parallel sessions (daemon compose waves, concurrent REPL
 * + Telegram + cron) each writing to their own trace file on the same machine.
 *
 * This benchmark answers: **does the flush-survives-kill property hold when N
 * writers contend for kernel I/O resources simultaneously?**
 *
 * A single child process creates N `NdjsonTraceWriter` instances (each to a
 * separate trace.jsonl), writes events to all of them concurrently, signals
 * READY, then the parent sends SIGKILL. Post-kill, every trace file is read
 * back and verified independently: event count, seq monotonicity, NDJSON
 * integrity, and zero cross-writer contamination.
 *
 * Contract: each writer uses an independent O_APPEND file handle. Kernel page
 * cache flush on process exit applies to ALL dirty pages, not one handle.
 * Concurrent writers sharing page cache should not degrade event survival.
 *
 * @module agent/trace/concurrent-emitter.bench
 */

import { mkdtemp, readFile, rm } from 'fs/promises';
import { existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TraceEvent } from './types.js';

// ---------------------------------------------------------------------------
// Locate tsx -- worktrees share node_modules with the main repo.
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
// Configuration
// ---------------------------------------------------------------------------

/** Number of parallel writers in each scenario. */
const WRITER_COUNT = 10;

/** Pairs of (started, completed) events per writer before the READY signal. */
const PAIRS_PER_WRITER = 5;

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
      // Partial last line from mid-write kill -- skip, do not fail.
    }
  }
  return events;
}

/** Count only tool_call events (session_sealed excluded from completeness). */
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

/**
 * Verify that every tool_call event in a writer's trace contains the correct
 * writer tag in the toolUseId prefix. Guards against cross-writer contamination
 * (wrong file handle writing to wrong trace file).
 */
function allEventsTagged(events: TraceEvent[], writerTag: string): boolean {
  const toolCalls = events.filter((e) => e.kind === 'tool_call');
  return toolCalls.every((e) => {
    const payload = e.payload as { toolUseId?: string };
    return payload.toolUseId?.startsWith(writerTag) ?? false;
  });
}

// ---------------------------------------------------------------------------
// Child script builders
// ---------------------------------------------------------------------------

/**
 * Build a script that creates N writers, writes PAIRS_PER_WRITER pairs to each
 * concurrently (all awaited), signals READY, then sleeps. All writes complete
 * before the kill window opens.
 */
function buildConcurrentScript(rootDir: string, writerCount: number, pairsPerWriter: number): string {
  return [
    `import { NdjsonTraceWriter } from ${JSON.stringify(writerSrc)};`,
    `import { join } from 'path';`,
    `import { mkdirSync } from 'fs';`,
    ``,
    `const ROOT = ${JSON.stringify(rootDir)};`,
    `const WRITER_COUNT = ${writerCount};`,
    `const PAIRS = ${pairsPerWriter};`,
    ``,
    `async function runWriter(id) {`,
    `  const dir = join(ROOT, 'writer-' + id);`,
    `  mkdirSync(dir, { recursive: true });`,
    `  const w = new NdjsonTraceWriter({ traceDir: dir });`,
    `  const tag = 'w' + id + '-';`,
    `  for (let i = 0; i < PAIRS; i++) {`,
    `    await w.write({ kind: 'tool_call', payload: {`,
    `      phase: 'started', toolUseId: tag + 't' + i, name: 'bash',`,
    `      inputBytes: i, argsFingerprint: 'a'.repeat(64) } });`,
    `    await w.write({ kind: 'tool_call', payload: {`,
    `      phase: 'completed', toolUseId: tag + 't' + i, name: 'bash',`,
    `      resultBytes: i, isError: false, truncated: false, durationMs: 1 } });`,
    `  }`,
    `}`,
    ``,
    `async function main() {`,
    `  const writers = [];`,
    `  for (let id = 0; id < WRITER_COUNT; id++) {`,
    `    writers.push(runWriter(id));`,
    `  }`,
    `  await Promise.all(writers);`,
    `  process.stdout.write('READY\\n');`,
    `  await new Promise(r => setTimeout(r, 60_000));`,
    `}`,
    `main().catch(e => { console.error(e); process.exit(1); });`,
  ].join('\n');
}

/**
 * Build a script that creates N writers, writes some pairs awaited (phase 1),
 * signals READY, then fires more pairs unawaited (phase 2). The kill races the
 * in-flight writes across all N writers simultaneously.
 */
function buildConcurrentMidWriteScript(
  rootDir: string,
  writerCount: number,
  pairsBeforeSignal: number,
  pairsAfterSignal: number,
): string {
  return [
    `import { NdjsonTraceWriter } from ${JSON.stringify(writerSrc)};`,
    `import { join } from 'path';`,
    `import { mkdirSync } from 'fs';`,
    ``,
    `const ROOT = ${JSON.stringify(rootDir)};`,
    `const WRITER_COUNT = ${writerCount};`,
    `const PAIRS_BEFORE = ${pairsBeforeSignal};`,
    `const PAIRS_AFTER = ${pairsAfterSignal};`,
    ``,
    `async function main() {`,
    `  const writers = [];`,
    `  for (let id = 0; id < WRITER_COUNT; id++) {`,
    `    const dir = join(ROOT, 'writer-' + id);`,
    `    mkdirSync(dir, { recursive: true });`,
    `    writers.push({ id, w: new NdjsonTraceWriter({ traceDir: dir }) });`,
    `  }`,
    ``,
    `  // Phase 1: all writers emit pairsBeforeSignal pairs concurrently (awaited).`,
    `  await Promise.all(writers.map(async ({ id, w }) => {`,
    `    const tag = 'w' + id + '-';`,
    `    for (let i = 0; i < PAIRS_BEFORE; i++) {`,
    `      await w.write({ kind: 'tool_call', payload: {`,
    `        phase: 'started', toolUseId: tag + 't' + i, name: 'bash',`,
    `        inputBytes: i, argsFingerprint: 'a'.repeat(64) } });`,
    `      await w.write({ kind: 'tool_call', payload: {`,
    `        phase: 'completed', toolUseId: tag + 't' + i, name: 'bash',`,
    `        resultBytes: i, isError: false, truncated: false, durationMs: 1 } });`,
    `    }`,
    `  }));`,
    ``,
    `  process.stdout.write('READY\\n');`,
    ``,
    `  // Phase 2: fire more pairs WITHOUT awaiting -- kill races these writes.`,
    `  for (const { id, w } of writers) {`,
    `    const tag = 'w' + id + '-';`,
    `    for (let i = PAIRS_BEFORE; i < PAIRS_BEFORE + PAIRS_AFTER; i++) {`,
    `      w.write({ kind: 'tool_call', payload: {`,
    `        phase: 'started', toolUseId: tag + 't' + i, name: 'bash',`,
    `        inputBytes: i, argsFingerprint: 'b'.repeat(64) } });`,
    `      w.write({ kind: 'tool_call', payload: {`,
    `        phase: 'completed', toolUseId: tag + 't' + i, name: 'bash',`,
    `        resultBytes: i, isError: false, truncated: false, durationMs: 1 } });`,
    `    }`,
    `  }`,
    `  await new Promise(r => setTimeout(r, 60_000));`,
    `}`,
    `main().catch(e => { console.error(e); process.exit(1); });`,
  ].join('\n');
}

/** Spawn child, wait for READY, send SIGKILL, wait for exit. */
async function spawnAndKill(scriptPath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(tsxBin, [scriptPath], {
      env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });

    let buf = '';
    let killed = false;

    const timer = setTimeout(() => {
      if (!killed) {
        killed = true;
        child.kill('SIGTERM');
        reject(new Error('child timed out waiting for READY'));
      }
    }, 12_000);

    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      if (!killed && buf.includes('READY')) {
        killed = true;
        clearTimeout(timer);
        child.kill('SIGKILL');
      }
    });

    child.on('exit', () => { clearTimeout(timer); resolve(); });
    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === 'ENOENT') { reject(new Error(`tsx not found at: ${tsxBin}`)); return; }
      resolve(); // SIGKILL may surface as error
    });
  });
}

// ---------------------------------------------------------------------------
// Benchmark result accumulator
// ---------------------------------------------------------------------------
interface WriterResult {
  writerId: number;
  expected: number;
  recovered: number;
  monotonic: boolean;
  sealed: boolean;
  tagged: boolean;
}
interface BenchResult {
  scenario: string;
  writers: WriterResult[];
  allPass: boolean;
}
const results: BenchResult[] = [];

/** Read all N trace files and build per-writer results. */
async function collectWriterResults(
  rootDir: string,
  writerCount: number,
  expectedPerWriter: number,
): Promise<WriterResult[]> {
  const wr: WriterResult[] = [];
  for (let id = 0; id < writerCount; id++) {
    const tracePath = join(rootDir, `writer-${id}`, 'trace.jsonl');
    const events = await readTrace(tracePath);
    const recovered = countToolCalls(events);
    const mono = isMonotonic(events);
    const sealed = events.some((e) => e.kind === 'session_sealed');
    const tagged = allEventsTagged(events, `w${id}-`);
    wr.push({ writerId: id, expected: expectedPerWriter, recovered, monotonic: mono, sealed, tagged });
  }
  return wr;
}

// ---------------------------------------------------------------------------
// Benchmark scenarios
// ---------------------------------------------------------------------------

describe.skipIf(process.platform === 'win32')(
  'concurrent-emitter trace integrity (POSIX only)',
  () => {
    let rootDir: string;

    beforeAll(async () => {
      rootDir = await mkdtemp(join(tmpdir(), 'afk-bench-concurrent-'));
    });

    afterAll(async () => {
      await rm(rootDir, { recursive: true, force: true });

      // Print summary table.
      process.stdout.write('\n=== Concurrent-Emitter Benchmark Results ===\n');
      for (const r of results) {
        const totalExpected = r.writers.reduce((s, w) => s + w.expected, 0);
        const totalRecovered = r.writers.reduce((s, w) => s + w.recovered, 0);
        const allMono = r.writers.every((w) => w.monotonic);
        const allTagged = r.writers.every((w) => w.tagged);
        const noSeal = r.writers.every((w) => !w.sealed);
        const pct = totalExpected > 0
          ? `${((totalRecovered / totalExpected) * 100).toFixed(0)}%`
          : 'N/A';
        process.stdout.write(
          `  ${r.scenario.padEnd(34)} ` +
          `${String(totalRecovered).padStart(4)}/${String(totalExpected).padEnd(4)} ` +
          `${pct.padStart(5)}  ` +
          `mono=${String(allMono).padEnd(5)} ` +
          `tagged=${String(allTagged).padEnd(5)} ` +
          `sealed=${String(!noSeal).padEnd(5)} ` +
          `[${r.allPass ? 'PASS' : 'FAIL'}]\n`,
        );
      }
      process.stdout.write('=============================================\n\n');
    });

    // -----------------------------------------------------------------------
    // Scenario A: all-complete -- 10 writers, all writes finish before kill.
    // Every writer should have exactly PAIRS_PER_WRITER * 2 events.
    // -----------------------------------------------------------------------
    it('all-complete: 10 writers flushed before kill all survive', async () => {
      const scenarioDir = join(rootDir, 'all-complete');
      const scriptPath = join(rootDir, 'all-complete.mts');
      writeFileSync(scriptPath, buildConcurrentScript(scenarioDir, WRITER_COUNT, PAIRS_PER_WRITER));

      await spawnAndKill(scriptPath);

      const expectedPerWriter = PAIRS_PER_WRITER * 2;
      const writers = await collectWriterResults(scenarioDir, WRITER_COUNT, expectedPerWriter);
      const allPass = writers.every(
        (w) => w.recovered === w.expected && w.monotonic && !w.sealed && w.tagged,
      );

      for (const w of writers) {
        expect(w.recovered, `writer ${w.writerId}: event count`).toBe(expectedPerWriter);
        expect(w.monotonic, `writer ${w.writerId}: seq monotonicity`).toBe(true);
        expect(w.sealed, `writer ${w.writerId}: no seal under SIGKILL`).toBe(false);
        expect(w.tagged, `writer ${w.writerId}: no cross-contamination`).toBe(true);
      }

      results.push({ scenario: 'all-complete (10 writers)', writers, allPass });
    }, 20_000);

    // -----------------------------------------------------------------------
    // Scenario B: mid-write -- 10 writers, 3 pairs awaited per writer, then
    // 5 more pairs unawaited per writer. Kill races 100 in-flight writes.
    // Pre-signal events (3 pairs = 6 events per writer = 60 total) must survive.
    // Post-signal events may or may not land. No corruption, no cross-contamination.
    // -----------------------------------------------------------------------
    it('mid-write: pre-signal events survive across 10 writers under concurrent kill', async () => {
      const scenarioDir = join(rootDir, 'mid-write');
      const scriptPath = join(rootDir, 'mid-write.mts');
      const pairsBefore = 3;
      const pairsAfter = 5;
      writeFileSync(
        scriptPath,
        buildConcurrentMidWriteScript(scenarioDir, WRITER_COUNT, pairsBefore, pairsAfter),
      );

      await spawnAndKill(scriptPath);

      const expectedMinPerWriter = pairsBefore * 2; // only pre-signal guaranteed
      const writers = await collectWriterResults(scenarioDir, WRITER_COUNT, expectedMinPerWriter);
      const allPass = writers.every(
        (w) => w.recovered >= w.expected && w.monotonic && !w.sealed && w.tagged,
      );

      for (const w of writers) {
        expect(
          w.recovered,
          `writer ${w.writerId}: at least ${expectedMinPerWriter} pre-signal events`,
        ).toBeGreaterThanOrEqual(expectedMinPerWriter);
        expect(w.monotonic, `writer ${w.writerId}: seq monotonicity`).toBe(true);
        expect(w.sealed, `writer ${w.writerId}: no seal under SIGKILL`).toBe(false);
        expect(w.tagged, `writer ${w.writerId}: no cross-contamination`).toBe(true);
      }

      results.push({ scenario: 'mid-write (10 writers, racing)', writers, allPass });
    }, 20_000);

    // -----------------------------------------------------------------------
    // Scenario C: staggered-start -- writers begin at different times. Even
    // numbered writers start immediately; odd writers start after a short delay.
    // Tests that writers joining the I/O pool mid-batch do not corrupt earlier
    // writers' traces. All writes complete before the kill.
    // -----------------------------------------------------------------------
    it('staggered-start: late-joining writers do not corrupt early writers', async () => {
      const scenarioDir = join(rootDir, 'staggered');
      const scriptPath = join(rootDir, 'staggered.mts');
      const pairs = PAIRS_PER_WRITER;
      writeFileSync(scriptPath, [
        `import { NdjsonTraceWriter } from ${JSON.stringify(writerSrc)};`,
        `import { join } from 'path';`,
        `import { mkdirSync } from 'fs';`,
        ``,
        `const ROOT = ${JSON.stringify(scenarioDir)};`,
        `const WRITER_COUNT = ${WRITER_COUNT};`,
        `const PAIRS = ${pairs};`,
        ``,
        `async function runWriter(id, delayMs) {`,
        `  if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));`,
        `  const dir = join(ROOT, 'writer-' + id);`,
        `  mkdirSync(dir, { recursive: true });`,
        `  const w = new NdjsonTraceWriter({ traceDir: dir });`,
        `  const tag = 'w' + id + '-';`,
        `  for (let i = 0; i < PAIRS; i++) {`,
        `    await w.write({ kind: 'tool_call', payload: {`,
        `      phase: 'started', toolUseId: tag + 't' + i, name: 'bash',`,
        `      inputBytes: i, argsFingerprint: 'a'.repeat(64) } });`,
        `    await w.write({ kind: 'tool_call', payload: {`,
        `      phase: 'completed', toolUseId: tag + 't' + i, name: 'bash',`,
        `      resultBytes: i, isError: false, truncated: false, durationMs: 1 } });`,
        `  }`,
        `}`,
        ``,
        `async function main() {`,
        `  const all = [];`,
        `  for (let id = 0; id < WRITER_COUNT; id++) {`,
        `    // Even writers start immediately; odd writers start after 50ms.`,
        `    all.push(runWriter(id, id % 2 === 0 ? 0 : 50));`,
        `  }`,
        `  await Promise.all(all);`,
        `  process.stdout.write('READY\\n');`,
        `  await new Promise(r => setTimeout(r, 60_000));`,
        `}`,
        `main().catch(e => { console.error(e); process.exit(1); });`,
      ].join('\n'));

      await spawnAndKill(scriptPath);

      const expectedPerWriter = pairs * 2;
      const writers = await collectWriterResults(scenarioDir, WRITER_COUNT, expectedPerWriter);
      const allPass = writers.every(
        (w) => w.recovered === w.expected && w.monotonic && !w.sealed && w.tagged,
      );

      for (const w of writers) {
        expect(w.recovered, `writer ${w.writerId}: event count`).toBe(expectedPerWriter);
        expect(w.monotonic, `writer ${w.writerId}: seq monotonicity`).toBe(true);
        expect(w.sealed, `writer ${w.writerId}: no seal under SIGKILL`).toBe(false);
        expect(w.tagged, `writer ${w.writerId}: no cross-contamination`).toBe(true);
      }

      results.push({ scenario: 'staggered-start (10 writers)', writers, allPass });
    }, 20_000);
  },
);
