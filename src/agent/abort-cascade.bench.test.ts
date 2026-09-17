/**
 * Benchmark: abort-cascade correctness.
 *
 * Validates that {@link AbortGraph} enforces the two core abort invariants
 * documented in `docs/philosophy/afk-contract.md`:
 *
 *   1. **Parent abort cascades to ALL descendants** -- aborting a root node
 *      must synchronously abort every child, grandchild, etc., threading the
 *      same reason. The trace must record a single `abort` event whose
 *      `cascadedTo[]` lists every descendant reached.
 *
 *   2. **Child abort does NOT auto-abort parent** -- a child may abort
 *      independently; the parent's controller stays live, and the parent
 *      receives a notification (not an abort).
 *
 * Unlike the unit tests in `abort-graph.test.ts` (which test in-process
 * semantics), this benchmark spawns isolated child processes that construct
 * a graph, trigger an abort, write the trace, then exit. The parent reads
 * the NDJSON trace file and verifies the recorded events match the contract.
 * This proves the witness layer faithfully records cascade topology under
 * real process conditions.
 *
 * Contract ref: `docs/philosophy/afk-contract.md` --
 *   "Every abort (origin, cascade target)."
 *   "Ignoring an abort signal mid-dispatch is impossible by construction."
 *
 * @module agent/abort-cascade.bench
 */

import { mkdtemp, readFile, rm } from 'fs/promises';
import { existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Locate tsx -- worktrees share node_modules with the main repo.
// ---------------------------------------------------------------------------
const here = dirname(fileURLToPath(import.meta.url));
const abortGraphSrc = join(here, 'abort-graph.ts');
const writerSrc = join(here, 'trace', 'writer.ts');

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

interface TraceEvent {
  ts: string;
  seq: number;
  kind: string;
  payload: Record<string, unknown>;
}

/** Parse an NDJSON trace file, skipping any trailing partial line. */
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
      // partial last line -- skip
    }
  }
  return events;
}

/** Spawn child, wait for it to exit naturally (these are not kill tests). */
async function spawnAndWait(scriptPath: string): Promise<{ code: number; stderr: string }> {
  return new Promise<{ code: number; stderr: string }>((resolve) => {
    const child = spawn(tsxBin, [scriptPath], {
      env: { ...process.env },
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('exit', (code) => resolve({ code: code ?? 1, stderr }));
    child.on('error', () => resolve({ code: 1, stderr }));
  });
}

// ---------------------------------------------------------------------------
// Child script builders
//
// Each script constructs an AbortGraph with a NdjsonTraceWriter, builds a
// specific topology, triggers an abort, flushes, and exits. The parent reads
// the trace file to verify the recorded events.
// ---------------------------------------------------------------------------

/**
 * Scenario A: linear chain -- root -> child -> grandchild.
 * Abort the root. Expect cascadedTo = [child, grandchild].
 */
function buildLinearChainScript(traceDir: string): string {
  return [
    `import { AbortGraph } from ${JSON.stringify(abortGraphSrc)};`,
    `import { NdjsonTraceWriter } from ${JSON.stringify(writerSrc)};`,
    `async function main() {`,
    `  const w = new NdjsonTraceWriter({ traceDir: ${JSON.stringify(traceDir)} });`,
    `  const graph = new AbortGraph(w);`,
    `  const root = new AbortController();`,
    `  const child = new AbortController();`,
    `  const grandchild = new AbortController();`,
    `  graph.register('root', root);`,
    `  graph.register('child', child);`,
    `  graph.register('grandchild', grandchild);`,
    `  graph.linkChild('root', 'child');`,
    `  graph.linkChild('child', 'grandchild');`,
    `  graph.abort('root', 'shutdown', 'user_signal');`,
    // Give the async trace write time to flush
    `  await new Promise(r => setTimeout(r, 200));`,
    // Write signal values as tool_call events so the test can verify controller state
    `  await w.write({ kind: 'tool_call', payload: {`,
    `    phase: 'completed', toolUseId: 'verify', name: 'signal-check',`,
    `    resultBytes: 0, isError: false, truncated: false, durationMs: 0,`,
    `    rootAborted: root.signal.aborted,`,
    `    childAborted: child.signal.aborted,`,
    `    grandchildAborted: grandchild.signal.aborted,`,
    `    childReason: child.signal.reason,`,
    `    grandchildReason: grandchild.signal.reason,`,
    `  } });`,
    `  await w.seal({ status: 'succeeded', totalTurns: 0, totalCostUsd: 0, durationMs: 0 });`,
    `}`,
    `main().catch(e => { console.error(e); process.exit(1); });`,
  ].join('\n');
}

/**
 * Scenario B: wide fan-out -- root with 5 direct children.
 * Abort the root. Expect cascadedTo = all 5 children.
 */
function buildWideFanoutScript(traceDir: string): string {
  const childIds = ['c0', 'c1', 'c2', 'c3', 'c4'];
  return [
    `import { AbortGraph } from ${JSON.stringify(abortGraphSrc)};`,
    `import { NdjsonTraceWriter } from ${JSON.stringify(writerSrc)};`,
    `async function main() {`,
    `  const w = new NdjsonTraceWriter({ traceDir: ${JSON.stringify(traceDir)} });`,
    `  const graph = new AbortGraph(w);`,
    `  const root = new AbortController();`,
    `  graph.register('root', root);`,
    ...childIds.map((id) => `  const ${id} = new AbortController();`),
    ...childIds.map((id) => `  graph.register('${id}', ${id});`),
    ...childIds.map((id) => `  graph.linkChild('root', '${id}');`),
    `  graph.abort('root', 'fan-shutdown', 'user_signal');`,
    `  await new Promise(r => setTimeout(r, 200));`,
    // Verify all children aborted
    `  const allAborted = [${childIds.map((id) => `${id}.signal.aborted`).join(', ')}].every(Boolean);`,
    `  const allReasons = [${childIds.map((id) => `${id}.signal.reason`).join(', ')}];`,
    `  await w.write({ kind: 'tool_call', payload: {`,
    `    phase: 'completed', toolUseId: 'verify', name: 'signal-check',`,
    `    resultBytes: 0, isError: false, truncated: false, durationMs: 0,`,
    `    allAborted, allReasonsMatch: allReasons.every(r => r === 'fan-shutdown'),`,
    `  } });`,
    `  await w.seal({ status: 'succeeded', totalTurns: 0, totalCostUsd: 0, durationMs: 0 });`,
    `}`,
    `main().catch(e => { console.error(e); process.exit(1); });`,
  ].join('\n');
}

/**
 * Scenario C: deep 5-level chain -- root -> L1 -> L2 -> L3 -> L4.
 * Abort the root. Expect cascadedTo = [L1, L2, L3, L4].
 */
function buildDeepChainScript(traceDir: string): string {
  const levels = ['L1', 'L2', 'L3', 'L4'];
  return [
    `import { AbortGraph } from ${JSON.stringify(abortGraphSrc)};`,
    `import { NdjsonTraceWriter } from ${JSON.stringify(writerSrc)};`,
    `async function main() {`,
    `  const w = new NdjsonTraceWriter({ traceDir: ${JSON.stringify(traceDir)} });`,
    `  const graph = new AbortGraph(w);`,
    `  const root = new AbortController();`,
    `  graph.register('root', root);`,
    ...levels.map((l) => `  const ${l} = new AbortController();`),
    ...levels.map((l) => `  graph.register('${l}', ${l});`),
    `  graph.linkChild('root', 'L1');`,
    `  graph.linkChild('L1', 'L2');`,
    `  graph.linkChild('L2', 'L3');`,
    `  graph.linkChild('L3', 'L4');`,
    `  graph.abort('root', 'deep-shutdown', 'user_signal');`,
    `  await new Promise(r => setTimeout(r, 200));`,
    `  const leafAborted = L4.signal.aborted;`,
    `  const leafReason = L4.signal.reason;`,
    `  await w.write({ kind: 'tool_call', payload: {`,
    `    phase: 'completed', toolUseId: 'verify', name: 'signal-check',`,
    `    resultBytes: 0, isError: false, truncated: false, durationMs: 0,`,
    `    leafAborted, leafReason,`,
    `  } });`,
    `  await w.seal({ status: 'succeeded', totalTurns: 0, totalCostUsd: 0, durationMs: 0 });`,
    `}`,
    `main().catch(e => { console.error(e); process.exit(1); });`,
  ].join('\n');
}

/**
 * Scenario D: child abort does NOT cascade upward.
 * root -> child. Abort the child. Root must stay live.
 * Trace must record the abort with cascadedTo = [] (no descendants of child).
 */
function buildChildAbortScript(traceDir: string): string {
  return [
    `import { AbortGraph } from ${JSON.stringify(abortGraphSrc)};`,
    `import { NdjsonTraceWriter } from ${JSON.stringify(writerSrc)};`,
    `async function main() {`,
    `  const w = new NdjsonTraceWriter({ traceDir: ${JSON.stringify(traceDir)} });`,
    `  const graph = new AbortGraph(w);`,
    `  const root = new AbortController();`,
    `  const child = new AbortController();`,
    `  graph.register('root', root);`,
    `  graph.register('child', child);`,
    `  graph.linkChild('root', 'child');`,
    `  graph.abort('child', 'child-only-failure', 'user_signal');`,
    `  await new Promise(r => setTimeout(r, 200));`,
    `  await w.write({ kind: 'tool_call', payload: {`,
    `    phase: 'completed', toolUseId: 'verify', name: 'signal-check',`,
    `    resultBytes: 0, isError: false, truncated: false, durationMs: 0,`,
    `    rootAborted: root.signal.aborted,`,
    `    childAborted: child.signal.aborted,`,
    `  } });`,
    `  await w.seal({ status: 'succeeded', totalTurns: 0, totalCostUsd: 0, durationMs: 0 });`,
    `}`,
    `main().catch(e => { console.error(e); process.exit(1); });`,
  ].join('\n');
}

/**
 * Scenario E: mixed tree -- root has 2 children, each has 2 grandchildren.
 * Abort the root. Expect cascadedTo = all 6 descendants.
 * Also verifies reason threading through every level.
 */
function buildMixedTreeScript(traceDir: string): string {
  return [
    `import { AbortGraph } from ${JSON.stringify(abortGraphSrc)};`,
    `import { NdjsonTraceWriter } from ${JSON.stringify(writerSrc)};`,
    `async function main() {`,
    `  const w = new NdjsonTraceWriter({ traceDir: ${JSON.stringify(traceDir)} });`,
    `  const graph = new AbortGraph(w);`,
    `  const root = new AbortController();`,
    `  graph.register('root', root);`,
    // 2 children
    `  const cA = new AbortController();`,
    `  const cB = new AbortController();`,
    `  graph.register('cA', cA);`,
    `  graph.register('cB', cB);`,
    `  graph.linkChild('root', 'cA');`,
    `  graph.linkChild('root', 'cB');`,
    // 2 grandchildren per child
    `  const gA1 = new AbortController();`,
    `  const gA2 = new AbortController();`,
    `  const gB1 = new AbortController();`,
    `  const gB2 = new AbortController();`,
    `  graph.register('gA1', gA1);`,
    `  graph.register('gA2', gA2);`,
    `  graph.register('gB1', gB1);`,
    `  graph.register('gB2', gB2);`,
    `  graph.linkChild('cA', 'gA1');`,
    `  graph.linkChild('cA', 'gA2');`,
    `  graph.linkChild('cB', 'gB1');`,
    `  graph.linkChild('cB', 'gB2');`,
    `  graph.abort('root', 'tree-shutdown', 'user_signal');`,
    `  await new Promise(r => setTimeout(r, 200));`,
    `  const allAborted = [cA, cB, gA1, gA2, gB1, gB2].every(c => c.signal.aborted);`,
    `  const allReasons = [cA, cB, gA1, gA2, gB1, gB2].every(c => c.signal.reason === 'tree-shutdown');`,
    `  await w.write({ kind: 'tool_call', payload: {`,
    `    phase: 'completed', toolUseId: 'verify', name: 'signal-check',`,
    `    resultBytes: 0, isError: false, truncated: false, durationMs: 0,`,
    `    allAborted, allReasons,`,
    `  } });`,
    `  await w.seal({ status: 'succeeded', totalTurns: 0, totalCostUsd: 0, durationMs: 0 });`,
    `}`,
    `main().catch(e => { console.error(e); process.exit(1); });`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Result accumulator
// ---------------------------------------------------------------------------
interface BenchResult {
  scenario: string;
  descendants: number;
  cascadedTo: number;
  allAborted: boolean;
  reasonThreaded: boolean;
  traceRecorded: boolean;
}
const results: BenchResult[] = [];

// ---------------------------------------------------------------------------
// Benchmark scenarios
// ---------------------------------------------------------------------------
describe.skipIf(process.platform === 'win32')(
  'abort-cascade correctness (POSIX only)',
  () => {
    let rootDir: string;

    beforeAll(async () => {
      rootDir = await mkdtemp(join(tmpdir(), 'afk-abort-bench-'));
    });

    afterAll(async () => {
      await rm(rootDir, { recursive: true, force: true });

      process.stdout.write('\n=== Abort-Cascade Benchmark Results ===\n');
      for (const r of results) {
        const status = r.allAborted && r.reasonThreaded && r.traceRecorded ? 'PASS' : 'FAIL';
        process.stdout.write(
          `  ${r.scenario.padEnd(35)} descendants=${String(r.descendants).padStart(2)}` +
            `  cascadedTo=${String(r.cascadedTo).padStart(2)}` +
            `  aborted=${String(r.allAborted).padStart(5)}` +
            `  reason=${String(r.reasonThreaded).padStart(5)}` +
            `  traced=${String(r.traceRecorded).padStart(5)}` +
            `  [${status}]\n`,
        );
      }
      const allPass = results.every((r) => r.allAborted && r.reasonThreaded && r.traceRecorded);
      process.stdout.write(
        `  ${'VERDICT'.padEnd(35)} ${allPass ? 'ALL PASS' : 'FAILURES DETECTED'}\n`,
      );
      process.stdout.write('========================================\n\n');
    });

    // -----------------------------------------------------------------------
    // Scenario A: linear chain (root -> child -> grandchild)
    // -----------------------------------------------------------------------
    it('linear chain: root abort cascades through all levels', async () => {
      const traceDir = join(rootDir, 'linear');
      const scriptPath = join(rootDir, 'linear.mts');
      writeFileSync(scriptPath, buildLinearChainScript(traceDir));

      const { code, stderr } = await spawnAndWait(scriptPath);
      if (code !== 0) throw new Error(`Child exited ${code}: ${stderr}`);

      const events = await readTrace(join(traceDir, 'trace.jsonl'));
      const abortEvents = events.filter((e) => e.kind === 'abort');
      const verifyEvent = events.find(
        (e) => e.kind === 'tool_call' && (e.payload as Record<string, unknown>).toolUseId === 'verify',
      );

      // Exactly one abort trace event from the root
      expect(abortEvents).toHaveLength(1);
      const abortPayload = abortEvents[0]!.payload;
      const cascadedTo = abortPayload.cascadedTo as string[];

      // cascadedTo must list both descendants
      expect(cascadedTo).toHaveLength(2);
      expect(new Set(cascadedTo)).toEqual(new Set(['child', 'grandchild']));
      expect(abortPayload.origin).toBe('user_signal');
      expect(abortPayload.reason).toBe('shutdown');

      // Verify controller states from the child process
      expect(verifyEvent).toBeDefined();
      const vp = verifyEvent!.payload as Record<string, unknown>;
      expect(vp.rootAborted).toBe(true);
      expect(vp.childAborted).toBe(true);
      expect(vp.grandchildAborted).toBe(true);
      expect(vp.childReason).toBe('shutdown');
      expect(vp.grandchildReason).toBe('shutdown');

      results.push({
        scenario: 'linear-chain',
        descendants: 2,
        cascadedTo: cascadedTo.length,
        allAborted: true,
        reasonThreaded: true,
        traceRecorded: abortEvents.length === 1,
      });
    }, 15_000);

    // -----------------------------------------------------------------------
    // Scenario B: wide fan-out (root -> 5 children)
    // -----------------------------------------------------------------------
    it('wide fan-out: root abort reaches all 5 children', async () => {
      const traceDir = join(rootDir, 'wide');
      const scriptPath = join(rootDir, 'wide.mts');
      writeFileSync(scriptPath, buildWideFanoutScript(traceDir));

      const { code, stderr } = await spawnAndWait(scriptPath);
      if (code !== 0) throw new Error(`Child exited ${code}: ${stderr}`);

      const events = await readTrace(join(traceDir, 'trace.jsonl'));
      const abortEvents = events.filter((e) => e.kind === 'abort');
      const verifyEvent = events.find(
        (e) => e.kind === 'tool_call' && (e.payload as Record<string, unknown>).toolUseId === 'verify',
      );

      expect(abortEvents).toHaveLength(1);
      const cascadedTo = abortEvents[0]!.payload.cascadedTo as string[];
      expect(cascadedTo).toHaveLength(5);
      expect(new Set(cascadedTo)).toEqual(new Set(['c0', 'c1', 'c2', 'c3', 'c4']));

      const vp = verifyEvent!.payload as Record<string, unknown>;
      expect(vp.allAborted).toBe(true);
      expect(vp.allReasonsMatch).toBe(true);

      results.push({
        scenario: 'wide-fan-out',
        descendants: 5,
        cascadedTo: cascadedTo.length,
        allAborted: vp.allAborted as boolean,
        reasonThreaded: vp.allReasonsMatch as boolean,
        traceRecorded: abortEvents.length === 1,
      });
    }, 15_000);

    // -----------------------------------------------------------------------
    // Scenario C: deep 5-level chain (root -> L1 -> L2 -> L3 -> L4)
    // -----------------------------------------------------------------------
    it('deep chain: abort propagates through 5 levels to the leaf', async () => {
      const traceDir = join(rootDir, 'deep');
      const scriptPath = join(rootDir, 'deep.mts');
      writeFileSync(scriptPath, buildDeepChainScript(traceDir));

      const { code, stderr } = await spawnAndWait(scriptPath);
      if (code !== 0) throw new Error(`Child exited ${code}: ${stderr}`);

      const events = await readTrace(join(traceDir, 'trace.jsonl'));
      const abortEvents = events.filter((e) => e.kind === 'abort');
      const verifyEvent = events.find(
        (e) => e.kind === 'tool_call' && (e.payload as Record<string, unknown>).toolUseId === 'verify',
      );

      expect(abortEvents).toHaveLength(1);
      const cascadedTo = abortEvents[0]!.payload.cascadedTo as string[];
      expect(cascadedTo).toHaveLength(4);
      expect(new Set(cascadedTo)).toEqual(new Set(['L1', 'L2', 'L3', 'L4']));

      const vp = verifyEvent!.payload as Record<string, unknown>;
      expect(vp.leafAborted).toBe(true);
      expect(vp.leafReason).toBe('deep-shutdown');

      results.push({
        scenario: 'deep-5-level-chain',
        descendants: 4,
        cascadedTo: cascadedTo.length,
        allAborted: vp.leafAborted as boolean,
        reasonThreaded: vp.leafReason === 'deep-shutdown',
        traceRecorded: abortEvents.length === 1,
      });
    }, 15_000);

    // -----------------------------------------------------------------------
    // Scenario D: child abort does NOT cascade upward
    // -----------------------------------------------------------------------
    it('child-only: child abort leaves parent live', async () => {
      const traceDir = join(rootDir, 'child-only');
      const scriptPath = join(rootDir, 'child-only.mts');
      writeFileSync(scriptPath, buildChildAbortScript(traceDir));

      const { code, stderr } = await spawnAndWait(scriptPath);
      if (code !== 0) throw new Error(`Child exited ${code}: ${stderr}`);

      const events = await readTrace(join(traceDir, 'trace.jsonl'));
      const abortEvents = events.filter((e) => e.kind === 'abort');
      const verifyEvent = events.find(
        (e) => e.kind === 'tool_call' && (e.payload as Record<string, unknown>).toolUseId === 'verify',
      );

      // The child has no descendants, so cascadedTo = []
      expect(abortEvents).toHaveLength(1);
      const cascadedTo = abortEvents[0]!.payload.cascadedTo as string[];
      expect(cascadedTo).toHaveLength(0);

      // Key invariant: parent is NOT aborted
      const vp = verifyEvent!.payload as Record<string, unknown>;
      expect(vp.rootAborted).toBe(false);
      expect(vp.childAborted).toBe(true);

      results.push({
        scenario: 'child-only (no upward cascade)',
        descendants: 0,
        cascadedTo: 0,
        allAborted: true, // child aborted as expected
        reasonThreaded: true, // no upward leak
        traceRecorded: abortEvents.length === 1 && vp.rootAborted === false,
      });
    }, 15_000);

    // -----------------------------------------------------------------------
    // Scenario E: mixed tree (root -> 2 children -> 2 grandchildren each)
    // -----------------------------------------------------------------------
    it('mixed tree: root abort reaches all 6 descendants across branches', async () => {
      const traceDir = join(rootDir, 'mixed');
      const scriptPath = join(rootDir, 'mixed.mts');
      writeFileSync(scriptPath, buildMixedTreeScript(traceDir));

      const { code, stderr } = await spawnAndWait(scriptPath);
      if (code !== 0) throw new Error(`Child exited ${code}: ${stderr}`);

      const events = await readTrace(join(traceDir, 'trace.jsonl'));
      const abortEvents = events.filter((e) => e.kind === 'abort');
      const verifyEvent = events.find(
        (e) => e.kind === 'tool_call' && (e.payload as Record<string, unknown>).toolUseId === 'verify',
      );

      expect(abortEvents).toHaveLength(1);
      const cascadedTo = abortEvents[0]!.payload.cascadedTo as string[];
      expect(cascadedTo).toHaveLength(6);
      expect(new Set(cascadedTo)).toEqual(new Set(['cA', 'cB', 'gA1', 'gA2', 'gB1', 'gB2']));

      const vp = verifyEvent!.payload as Record<string, unknown>;
      expect(vp.allAborted).toBe(true);
      expect(vp.allReasons).toBe(true);

      results.push({
        scenario: 'mixed-tree (2x2)',
        descendants: 6,
        cascadedTo: cascadedTo.length,
        allAborted: vp.allAborted as boolean,
        reasonThreaded: vp.allReasons as boolean,
        traceRecorded: abortEvents.length === 1,
      });
    }, 15_000);
  },
);
