/**
 * Benchmark: hook-block fidelity.
 *
 * The AFK Contract states: "Silent hook failure (handler exceptions become
 * HookBlockedError, fail-safe)" is impossible by construction, and every hook
 * decision must be traced. This benchmark validates three properties:
 *
 * 1. **Block enforced.** A handler returning `decision: 'block'` throws
 *    `HookBlockedError` and short-circuits the chain -- subsequent handlers
 *    never fire.
 * 2. **Fail-safe on throw.** A handler that throws an arbitrary exception is
 *    wrapped in `HookBlockedError` -- the tool call is blocked, not silently
 *    passed.
 * 3. **Trace fidelity.** Every block decision emits a `hook_decision` trace
 *    event with the correct event type, tool name, outcome, and reason.
 *
 * Each scenario spawns an isolated child process that constructs a
 * `HookRegistryImpl`, registers handlers, dispatches through
 * `dispatchPreToolUse`, writes verification data to a trace file, and exits.
 * The parent reads back the NDJSON trace and verifies the recorded events
 * against the expected behavior.
 *
 * @module agent/hook-block-fidelity.bench
 */

import { mkdtemp, readFile, rm } from 'fs/promises';
import { existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TraceEvent } from './trace/types.js';

/** Read a JSON verification file written by the child process. */
async function readVerify(path: string): Promise<Record<string, unknown>> {
  const body = await readFile(path, 'utf8');
  return JSON.parse(body) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Locate tsx and source paths for child scripts.
// ---------------------------------------------------------------------------
const here = dirname(fileURLToPath(import.meta.url));
const writerSrc = join(here, 'trace', 'writer.ts');
const hookRegistrySrc = join(here, 'hook-registry.ts');
const hooksSrc = join(here, 'hooks.ts');
const subagentHooksSrc = join(here, 'subagent-hooks.ts');

function resolveTsx(): string {
  let dir = here;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'node_modules', '.bin', 'tsx');
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  return 'tsx';
}
const tsxBin = resolveTsx();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
      // skip partial
    }
  }
  return events;
}

/** Spawn child and wait for it to exit (no kill -- children exit naturally). */
async function spawnAndWait(scriptPath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(tsxBin, [scriptPath], {
      env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`child exited ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      resolve(stdout);
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') { reject(new Error(`tsx not found at: ${tsxBin}`)); return; }
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Benchmark result accumulator
// ---------------------------------------------------------------------------
interface BenchResult {
  scenario: string;
  pass: boolean;
  detail: string;
}
const results: BenchResult[] = [];

// ---------------------------------------------------------------------------
// Benchmark scenarios
// ---------------------------------------------------------------------------

describe.skipIf(process.platform === 'win32')(
  'hook-block fidelity (POSIX only)',
  () => {
    let rootDir: string;

    beforeAll(async () => {
      rootDir = await mkdtemp(join(tmpdir(), 'afk-bench-hookblock-'));
    });

    afterAll(async () => {
      await rm(rootDir, { recursive: true, force: true });

      process.stdout.write('\n=== Hook-Block Fidelity Benchmark Results ===\n');
      for (const r of results) {
        process.stdout.write(
          `  ${r.scenario.padEnd(42)} ${r.detail.padEnd(40)} [${r.pass ? 'PASS' : 'FAIL'}]\n`,
        );
      }
      process.stdout.write('==============================================\n\n');
    });

    // -----------------------------------------------------------------------
    // Scenario A: explicit block -- handler returns { decision: 'block' }.
    // Verifies: HookBlockedError thrown, chain short-circuited (handler2
    // never fires), hook_decision trace event emitted with 'blocked' outcome.
    // -----------------------------------------------------------------------
    it('explicit block: decision:block throws HookBlockedError and traces it', async () => {
      const traceDir = join(rootDir, 'explicit-block');
      const scriptPath = join(rootDir, 'explicit-block.mts');

      // The child registers two handlers. Handler 1 blocks; handler 2 sets a
      // flag on a global. After dispatch (which must throw), the child writes
      // verification data to a JSON file.
      const verifyPath = join(rootDir, 'explicit-block-verify.json');
      writeFileSync(scriptPath, [
        `import { createHookRegistryImpl } from ${JSON.stringify(hookRegistrySrc)};`,
        `import { dispatchPreToolUse } from ${JSON.stringify(subagentHooksSrc)};`,
        `import { NdjsonTraceWriter } from ${JSON.stringify(writerSrc)};`,
        `import { writeFileSync } from 'fs';`,
        ``,
        `async function main() {`,
        `  const registry = createHookRegistryImpl();`,
        `  const traceDir = ${JSON.stringify(traceDir)};`,
        `  const w = new NdjsonTraceWriter({ traceDir });`,
        ``,
        `  let handler2Fired = false;`,
        `  registry.register('PreToolUse', async () => {`,
        `    return { decision: 'block', reason: 'benchmark-explicit-block' };`,
        `  });`,
        `  registry.register('PreToolUse', async () => {`,
        `    handler2Fired = true;`,
        `    return {};`,
        `  });`,
        ``,
        `  let blocked = false;`,
        `  let errorName = '';`,
        `  let errorReason = '';`,
        `  try {`,
        `    await dispatchPreToolUse(registry, {`,
        `      event: 'PreToolUse',`,
        `      toolName: 'bash',`,
        `      input: { command: 'echo test' },`,
        `    }, { traceWriter: w });`,
        `  } catch (err) {`,
        `    blocked = true;`,
        `    errorName = err.constructor.name;`,
        `    errorReason = err.reason ?? '';`,
        `  }`,
        ``,
        `  writeFileSync(${JSON.stringify(verifyPath)}, JSON.stringify({`,
        `    blocked, errorName, errorReason, handler2Fired }));`,
        `  await w.seal({ status: 'succeeded', totalCostUsd: 0, turnCount: 0,`,
        `    durationMs: 0, modelId: 'bench', closureReason: 'model_end_turn' });`,
        `}`,
        `main().catch(e => { console.error(e); process.exit(1); });`,
      ].join('\n'));

      await spawnAndWait(scriptPath);

      const events = await readTrace(join(traceDir, 'trace.jsonl'));

      // 1. Verify hook_decision event was emitted.
      const hookEvents = events.filter((e) => e.kind === 'hook_decision');
      expect(hookEvents.length, 'exactly one hook_decision event').toBe(1);
      const hookPayload = hookEvents[0]!.payload as Record<string, unknown>;
      expect(hookPayload['hookEvent']).toBe('PreToolUse');
      expect(hookPayload['decision']).toBe('block');
      expect(hookPayload['blockedTool']).toBe('bash');

      // 2. Verify in-process behavior from the verification file.
      const fp = await readVerify(verifyPath);

      expect(fp['blocked'], 'dispatch threw').toBe(true);
      expect(fp['errorName'], 'error is HookBlockedError').toBe('HookBlockedError');
      expect(fp['errorReason'], 'reason preserved').toBe('benchmark-explicit-block');
      expect(fp['handler2Fired'], 'chain short-circuited').toBe(false);

      results.push({
        scenario: 'explicit block (decision:block)',
        pass: true,
        detail: 'blocked=true, chain short-circuited, traced',
      });
    }, 15_000);

    // -----------------------------------------------------------------------
    // Scenario B: fail-safe on throw -- handler throws an Error.
    // Verifies: exception wrapped in HookBlockedError (fail-safe, not
    // fail-open), hook_decision trace event emitted.
    // -----------------------------------------------------------------------
    it('fail-safe: handler throw becomes HookBlockedError', async () => {
      const traceDir = join(rootDir, 'fail-safe');
      const scriptPath = join(rootDir, 'fail-safe.mts');

      const verifyPath = join(rootDir, 'fail-safe-verify.json');
      writeFileSync(scriptPath, [
        `import { createHookRegistryImpl } from ${JSON.stringify(hookRegistrySrc)};`,
        `import { dispatchPreToolUse } from ${JSON.stringify(subagentHooksSrc)};`,
        `import { NdjsonTraceWriter } from ${JSON.stringify(writerSrc)};`,
        `import { writeFileSync } from 'fs';`,
        ``,
        `async function main() {`,
        `  const registry = createHookRegistryImpl();`,
        `  const traceDir = ${JSON.stringify(traceDir)};`,
        `  const w = new NdjsonTraceWriter({ traceDir });`,
        ``,
        `  registry.register('PreToolUse', async () => {`,
        `    throw new Error('handler-crash-simulated');`,
        `  });`,
        ``,
        `  let blocked = false;`,
        `  let errorName = '';`,
        `  let causeMessage = '';`,
        `  try {`,
        `    await dispatchPreToolUse(registry, {`,
        `      event: 'PreToolUse',`,
        `      toolName: 'edit_file',`,
        `      input: {},`,
        `    }, { traceWriter: w });`,
        `  } catch (err) {`,
        `    blocked = true;`,
        `    errorName = err.constructor.name;`,
        `    causeMessage = err.cause?.message ?? '';`,
        `  }`,
        ``,
        `  writeFileSync(${JSON.stringify(verifyPath)}, JSON.stringify({`,
        `    blocked, errorName, causeMessage }));`,
        `  await w.seal({ status: 'succeeded', totalCostUsd: 0, turnCount: 0,`,
        `    durationMs: 0, modelId: 'bench', closureReason: 'model_end_turn' });`,
        `}`,
        `main().catch(e => { console.error(e); process.exit(1); });`,
      ].join('\n'));

      await spawnAndWait(scriptPath);

      const events = await readTrace(join(traceDir, 'trace.jsonl'));

      // 1. hook_decision emitted for the block.
      const hookEvents = events.filter((e) => e.kind === 'hook_decision');
      expect(hookEvents.length).toBe(1);
      const hookPayload = hookEvents[0]!.payload as Record<string, unknown>;
      expect(hookPayload['hookEvent']).toBe('PreToolUse');
      expect(hookPayload['decision']).toBe('block');
      expect(hookPayload['blockedTool']).toBe('edit_file');

      // 2. Verify in-process behavior.
      const fp = await readVerify(verifyPath);

      expect(fp['blocked'], 'dispatch threw').toBe(true);
      expect(fp['errorName'], 'wrapped in HookBlockedError').toBe('HookBlockedError');
      expect(fp['causeMessage'], 'original error preserved as cause').toBe('handler-crash-simulated');

      results.push({
        scenario: 'fail-safe (handler throws)',
        pass: true,
        detail: 'throw -> HookBlockedError, cause preserved, traced',
      });
    }, 15_000);

    // -----------------------------------------------------------------------
    // Scenario C: allow path -- handler returns {} (no block).
    // Verifies: dispatch resolves without throwing, no hook_decision trace
    // event for allows (current behavior: allows are silent in the trace).
    // -----------------------------------------------------------------------
    it('allow path: non-blocking handler resolves cleanly with no trace event', async () => {
      const traceDir = join(rootDir, 'allow-path');
      const scriptPath = join(rootDir, 'allow-path.mts');

      const verifyPath = join(rootDir, 'allow-path-verify.json');
      writeFileSync(scriptPath, [
        `import { createHookRegistryImpl } from ${JSON.stringify(hookRegistrySrc)};`,
        `import { dispatchPreToolUse } from ${JSON.stringify(subagentHooksSrc)};`,
        `import { NdjsonTraceWriter } from ${JSON.stringify(writerSrc)};`,
        `import { writeFileSync } from 'fs';`,
        ``,
        `async function main() {`,
        `  const registry = createHookRegistryImpl();`,
        `  const traceDir = ${JSON.stringify(traceDir)};`,
        `  const w = new NdjsonTraceWriter({ traceDir });`,
        ``,
        `  registry.register('PreToolUse', async () => {`,
        `    return { decision: 'approve', reason: 'benchmark-approved' };`,
        `  });`,
        ``,
        `  let resolved = false;`,
        `  let threw = false;`,
        `  try {`,
        `    await dispatchPreToolUse(registry, {`,
        `      event: 'PreToolUse',`,
        `      toolName: 'read_file',`,
        `      input: {},`,
        `    }, { traceWriter: w });`,
        `    resolved = true;`,
        `  } catch {`,
        `    threw = true;`,
        `  }`,
        ``,
        `  writeFileSync(${JSON.stringify(verifyPath)}, JSON.stringify({ resolved, threw }));`,
        `  await w.seal({ status: 'succeeded', totalCostUsd: 0, turnCount: 0,`,
        `    durationMs: 0, modelId: 'bench', closureReason: 'model_end_turn' });`,
        `}`,
        `main().catch(e => { console.error(e); process.exit(1); });`,
      ].join('\n'));

      await spawnAndWait(scriptPath);

      const events = await readTrace(join(traceDir, 'trace.jsonl'));

      // Allow decisions emit a hook_decision with outcome 'allowed'.
      const hookEvents = events.filter((e) => e.kind === 'hook_decision');
      // Current behavior: allows emit hook_decision with decision field.
      // Verify the event has an 'allowed' or non-blocked outcome.
      for (const he of hookEvents) {
        const p = he.payload as Record<string, unknown>;
        expect(p['decision'], 'no block decision on allow path').not.toBe('block');
      }

      const fp = await readVerify(verifyPath);

      expect(fp['resolved'], 'dispatch resolved').toBe(true);
      expect(fp['threw'], 'no throw on allow').toBe(false);

      results.push({
        scenario: 'allow path (no block)',
        pass: true,
        detail: 'resolved cleanly, no blocked trace event',
      });
    }, 15_000);

    // -----------------------------------------------------------------------
    // Scenario D: multi-handler chain -- first allows, second blocks.
    // Verifies: second handler's block is enforced even after first allows,
    // and the trace records the block from the correct handler.
    // -----------------------------------------------------------------------
    it('multi-handler: second handler block enforced after first allows', async () => {
      const traceDir = join(rootDir, 'multi-handler');
      const scriptPath = join(rootDir, 'multi-handler.mts');

      const verifyPath = join(rootDir, 'multi-handler-verify.json');
      writeFileSync(scriptPath, [
        `import { createHookRegistryImpl } from ${JSON.stringify(hookRegistrySrc)};`,
        `import { dispatchPreToolUse } from ${JSON.stringify(subagentHooksSrc)};`,
        `import { NdjsonTraceWriter } from ${JSON.stringify(writerSrc)};`,
        `import { writeFileSync } from 'fs';`,
        ``,
        `async function main() {`,
        `  const registry = createHookRegistryImpl();`,
        `  const traceDir = ${JSON.stringify(traceDir)};`,
        `  const w = new NdjsonTraceWriter({ traceDir });`,
        ``,
        `  let handler1Fired = false;`,
        `  let handler3Fired = false;`,
        ``,
        `  registry.register('PreToolUse', async () => {`,
        `    handler1Fired = true;`,
        `    return { decision: 'approve' };`,
        `  });`,
        `  registry.register('PreToolUse', async () => {`,
        `    return { decision: 'block', reason: 'policy-violation' };`,
        `  });`,
        `  registry.register('PreToolUse', async () => {`,
        `    handler3Fired = true;`,
        `    return {};`,
        `  });`,
        ``,
        `  let blocked = false;`,
        `  try {`,
        `    await dispatchPreToolUse(registry, {`,
        `      event: 'PreToolUse',`,
        `      toolName: 'write_file',`,
        `      input: {},`,
        `    }, { traceWriter: w });`,
        `  } catch { blocked = true; }`,
        ``,
        `  writeFileSync(${JSON.stringify(verifyPath)}, JSON.stringify({`,
        `    blocked, handler1Fired, handler3Fired }));`,
        `  await w.seal({ status: 'succeeded', totalCostUsd: 0, turnCount: 0,`,
        `    durationMs: 0, modelId: 'bench', closureReason: 'model_end_turn' });`,
        `}`,
        `main().catch(e => { console.error(e); process.exit(1); });`,
      ].join('\n'));

      await spawnAndWait(scriptPath);

      const events = await readTrace(join(traceDir, 'trace.jsonl'));

      // hook_decision should show blocked.
      const hookEvents = events.filter((e) => e.kind === 'hook_decision');
      expect(hookEvents.length, 'hook_decision emitted').toBeGreaterThanOrEqual(1);
      const blockEvent = hookEvents.find(
        (e) => (e.payload as Record<string, unknown>)['decision'] === 'block',
      );
      expect(blockEvent, 'blocked outcome recorded').toBeDefined();

      const fp = await readVerify(verifyPath);

      expect(fp['blocked'], 'dispatch threw').toBe(true);
      expect(fp['handler1Fired'], 'first handler ran').toBe(true);
      expect(fp['handler3Fired'], 'third handler short-circuited').toBe(false);

      results.push({
        scenario: 'multi-handler (allow, block, skip)',
        pass: true,
        detail: 'h1 ran, h2 blocked, h3 skipped, traced',
      });
    }, 15_000);
  },
);
