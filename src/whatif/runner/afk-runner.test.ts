/**
 * Integration tests for the AFK agent runner.
 *
 * Uses a fake `cliEntry` pointing at a tiny Node.js script written to a temp
 * dir — no real agent or model API calls are made.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFile, mkdir, rm, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createAfkRunner } from './afk-runner.js';
import type { Environment, Episode, RunnerOptions } from '../types.js';

// ---------------------------------------------------------------------------
// Fake child scripts
// ---------------------------------------------------------------------------

/**
 * A fake "afk chat --format stream-json" script that:
 *   - Appends two JSONL lines to $AFK_WHATIF_TOOL_LOG.
 *   - Emits NDJSON OutputEvent lines on stdout (stream-json format):
 *       chunk/content "Hello, ", then tool_use_detail for read_file,
 *       then chunk/content " world", then done with metadata.
 *   - Exits 0.
 */
const FAKE_RUN_SCRIPT = `
const fs = require('fs');
const logPath = process.env.AFK_WHATIF_TOOL_LOG;
if (logPath) {
  fs.appendFileSync(logPath, JSON.stringify({ts:1,tool:'read_file',input:{path:'/foo'},verdict:'executed',subagent:false}) + '\\n');
  fs.appendFileSync(logPath, JSON.stringify({ts:2,tool:'bash',input:{command:'echo hi'},verdict:'recorded',subagent:false}) + '\\n');
}
// stream-json NDJSON: text before tool, tool marker, text after tool, done with metadata
const events = [
  { type: 'chunk', chunk: { type: 'content', content: 'Hello, ' } },
  { type: 'chunk', chunk: { type: 'tool_use_detail', toolUseId: 'tu1', toolName: 'read_file', toolInput: '{}' } },
  { type: 'chunk', chunk: { type: 'content', content: ' world' } },
  { type: 'done', metadata: { totalCostUsd: 0.01, durationMs: 500, usage: { input_tokens: 100, output_tokens: 50 } } },
];
for (const e of events) process.stdout.write(JSON.stringify(e) + '\\n');
process.exit(0);
`;

/**
 * A fake script that exits nonzero and writes to stderr.
 */
const FAKE_ERROR_SCRIPT = `
process.stderr.write('Something went wrong\\n');
process.exit(1);
`;

/**
 * A fake script that sleeps forever (for timeout testing).
 */
const FAKE_TIMEOUT_SCRIPT = `
setTimeout(() => {}, 60000);
`;

/**
 * A fake script that exits cleanly on SIGTERM (simulates a well-behaved child
 * that exits before the SIGKILL follow-up timer fires).
 * Medium fix #2295: verifies the SIGKILL timer is cleared by settle() so the
 * test resolves quickly instead of hanging for SIGKILL_DELAY_MS (5 s).
 */
const FAKE_SIGTERM_EXITS_SCRIPT = `
process.on('SIGTERM', () => { process.exit(0); });
setTimeout(() => {}, 60000);
`;

/**
 * A fake "afk chat" script for snapshot that:
 *   - POSTs a fake Anthropic request to $ANTHROPIC_BASE_URL/v1/messages.
 *   - Then prints some output and exits.
 */
const FAKE_SNAPSHOT_SCRIPT = `
const http = require('http');
const url = new URL(process.env.ANTHROPIC_BASE_URL + '/v1/messages');
const body = JSON.stringify({
  model: 'claude-3-5-sonnet',
  system: 'You are a helpful assistant.',
  messages: [{ role: 'user', content: 'What time is it?' }],
  tools: [{ name: 'read_file', description: 'Read a file' }],
  max_tokens: 1024,
});
const req = http.request({
  hostname: url.hostname,
  port: url.port,
  path: url.pathname,
  method: 'POST',
  headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
}, (res) => {
  res.resume();
  res.on('end', () => {
    const out = { success: true, message: 'ok', model: 'claude-3-5-sonnet' };
    console.log(JSON.stringify(out));
    process.exit(0);
  });
});
req.on('error', (e) => {
  process.stderr.write('POST failed: ' + e.message + '\\n');
  process.exit(1);
});
req.write(body);
req.end();
`;

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let runScript: string;
let errorScript: string;
let timeoutScript: string;
let sigtermExitsScript: string;
let snapshotScript: string;
let sandboxHome: string;

const baseEnv: Environment = {
  label: 'baseline',
  home: '',
  cwd: '',
  launch: { model: undefined, effort: undefined, env: {} },
};

const baseEpisode: Episode = {
  id: 'ep-test',
  source: 'synthetic',
  prompt: 'Say hello',
};

const baseOpts: RunnerOptions = {
  timeoutMs: 10_000,
  maxTurns: 3,
};

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'afk-runner-test-'));
  sandboxHome = join(tmpDir, 'sandbox-home');
  await mkdir(join(sandboxHome, 'state'), { recursive: true });

  runScript = join(tmpDir, 'fake-run.js');
  errorScript = join(tmpDir, 'fake-error.js');
  timeoutScript = join(tmpDir, 'fake-timeout.js');
  snapshotScript = join(tmpDir, 'fake-snapshot.js');

  await writeFile(runScript, FAKE_RUN_SCRIPT, 'utf-8');
  await writeFile(errorScript, FAKE_ERROR_SCRIPT, 'utf-8');
  await writeFile(timeoutScript, FAKE_TIMEOUT_SCRIPT, 'utf-8');
  sigtermExitsScript = join(tmpDir, 'fake-sigterm-exits.js');
  await writeFile(sigtermExitsScript, FAKE_SIGTERM_EXITS_SCRIPT, 'utf-8');
  await writeFile(snapshotScript, FAKE_SNAPSHOT_SCRIPT, 'utf-8');
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests: run()
// ---------------------------------------------------------------------------

describe('createAfkRunner().run()', () => {
  it('returns a trace with text and tools from a successful child', async () => {
    const runner = createAfkRunner({ cliEntry: { command: process.execPath, args: [runScript] } });
    const env: Environment = { ...baseEnv, home: sandboxHome, cwd: tmpDir };
    const trace = await runner.run(env, baseEpisode, 0, baseOpts);

    expect(trace.error).toBeUndefined();
    // stream-json: text segments with [tool: name] marker between them
    expect(trace.text).toBe('Hello, [tool: read_file] world');
    expect(trace.costUsd).toBe(0.01);
    expect(trace.inputTokens).toBe(100);
    expect(trace.outputTokens).toBe(50);
    expect(trace.tools).toHaveLength(2);
    expect(trace.tools[0]?.tool).toBe('read_file');
    expect(trace.tools[0]?.verdict).toBe('executed');
    expect(trace.tools[1]?.tool).toBe('bash');
    expect(trace.tools[1]?.verdict).toBe('recorded');
  });

  it('sets episodeId, env label, and sample on the trace', async () => {
    const runner = createAfkRunner({ cliEntry: { command: process.execPath, args: [runScript] } });
    const env: Environment = { ...baseEnv, home: sandboxHome, cwd: tmpDir, label: 'candidate' };
    const episode: Episode = { ...baseEpisode, id: 'ep-42' };
    const trace = await runner.run(env, episode, 3, baseOpts);

    expect(trace.episodeId).toBe('ep-42');
    expect(trace.env).toBe('candidate');
    expect(trace.sample).toBe(3);
  });

  it('returns a trace with error on nonzero exit (does not throw)', async () => {
    const runner = createAfkRunner({ cliEntry: { command: process.execPath, args: [errorScript] } });
    const env: Environment = { ...baseEnv, home: sandboxHome, cwd: tmpDir };
    const trace = await runner.run(env, baseEpisode, 0, baseOpts);

    expect(trace.error).toBeDefined();
    expect(trace.error).toContain('exit');
    expect(trace.text).toBe('');
    expect(trace.tools).toEqual([]);
  });

  it('returns a trace with error on timeout (does not throw)', async () => {
    const runner = createAfkRunner({ cliEntry: { command: process.execPath, args: [timeoutScript] } });
    const env: Environment = { ...baseEnv, home: sandboxHome, cwd: tmpDir };
    const trace = await runner.run(env, baseEpisode, 0, { ...baseOpts, timeoutMs: 500 });

    expect(trace.error).toBeDefined();
    expect(trace.error).toContain('timed out');
  }, 15_000);

  it('resolves quickly when child exits on SIGTERM (SIGKILL timer cleared by settle)', async () => {
    // Medium fix #2295: before the fix, the SIGKILL setTimeout was not tracked in
    // killTimer, so settle() never cleared it — the timer fired 5 s later
    // (SIGKILL_DELAY_MS) on an already-exited process.  The process completing
    // in well under 5 s is the observable signal that the timer was cleared.
    const runner = createAfkRunner({ cliEntry: { command: process.execPath, args: [sigtermExitsScript] } });
    const env: Environment = { ...baseEnv, home: sandboxHome, cwd: tmpDir };

    const start = Date.now();
    const trace = await runner.run(env, baseEpisode, 0, { ...baseOpts, timeoutMs: 300 });
    const elapsed = Date.now() - start;

    // Child should exit on SIGTERM well before SIGKILL_DELAY_MS (5000 ms).
    expect(elapsed).toBeLessThan(3_000);
    expect(trace.error).toBeDefined();
    expect(trace.error).toContain('timed out');
  }, 10_000);

  it('cancels SIGTERM kill timer before setting the SIGKILL follow-up on AbortSignal.abort()', async () => {
    // Uses the infinite-sleep timeoutScript so the process never exits on its own.
    // We abort immediately after starting run(); the path must resolve cleanly
    // (no ghost timers, no hang) with an error trace.
    const runner = createAfkRunner({ cliEntry: { command: process.execPath, args: [timeoutScript] } });
    const env: Environment = { ...baseEnv, home: sandboxHome, cwd: tmpDir };
    const controller = new AbortController();

    const tracePromise = runner.run(env, baseEpisode, 0, { ...baseOpts, signal: controller.signal });
    // Abort immediately — the onAbort handler should clear the pending SIGTERM
    // deadline timer before arming the SIGKILL follow-up, leaving exactly one
    // live timer.
    controller.abort();

    const trace = await tracePromise;
    expect(trace.error).toBeTruthy();
    expect(trace.text).toBe('');
    expect(trace.tools).toEqual([]);
  }, 10_000);

  it('redacts sk-ant credentials in error messages', async () => {
    const scriptWithKey = join(tmpDir, 'fake-key-error.js');
    await writeFile(scriptWithKey,
      `process.stderr.write('Error: sk-ant-api03-secretvalue123\\n'); process.exit(1);`,
      'utf-8');
    const runner = createAfkRunner({ cliEntry: { command: process.execPath, args: [scriptWithKey] } });
    const env: Environment = { ...baseEnv, home: sandboxHome, cwd: tmpDir };
    const trace = await runner.run(env, baseEpisode, 0, baseOpts);

    expect(trace.error).toBeDefined();
    expect(trace.error).not.toContain('secretvalue123');
    expect(trace.error).toContain('[REDACTED]');
  });
});

// ---------------------------------------------------------------------------
// Tests: snapshot()
// ---------------------------------------------------------------------------

describe('createAfkRunner().snapshot()', () => {
  it('returns a RequestSnapshot built from the intercepted request', async () => {
    const runner = createAfkRunner({ cliEntry: { command: process.execPath, args: [snapshotScript] } });
    const env: Environment = { ...baseEnv, home: sandboxHome, cwd: tmpDir };
    const snap = await runner.snapshot(env, 'What time is it?', baseOpts);

    expect(snap.model).toBe('claude-3-5-sonnet');
    expect(snap.system).toBe('You are a helpful assistant.');
    expect(snap.tools).toHaveLength(1);
    expect(snap.tools[0]?.name).toBe('read_file');
    expect(snap.firstUserMessage).toBe('What time is it?');
  });

  it('throws a clear error when no requests were captured', async () => {
    const runner = createAfkRunner({ cliEntry: { command: process.execPath, args: [errorScript] } });
    const env: Environment = { ...baseEnv, home: sandboxHome, cwd: tmpDir };
    await expect(runner.snapshot(env, 'probe', baseOpts)).rejects.toThrow(/no \/messages request/);
  });

  it('passes ANTHROPIC_BASE_URL to the child env', async () => {
    // Script that checks ANTHROPIC_BASE_URL and writes it to stdout as JSON.
    const checkScript = join(tmpDir, 'fake-check-url.js');
    const capturedUrl: string[] = [];
    await writeFile(checkScript, `
const http = require('http');
const base = process.env.ANTHROPIC_BASE_URL;
const url = new URL(base + '/v1/messages');
const body = JSON.stringify({ model: 'test', messages: [], max_tokens: 1, captured_url: base });
const req = http.request({
  hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
  headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
}, (res) => { res.resume(); res.on('end', () => { console.log(JSON.stringify({message:'done'})); process.exit(0); }); });
req.write(body); req.end();
`, 'utf-8');

    const runner = createAfkRunner({ cliEntry: { command: process.execPath, args: [checkScript] } });
    const env: Environment = { ...baseEnv, home: sandboxHome, cwd: tmpDir };
    const snap = await runner.snapshot(env, 'probe', baseOpts);
    // The captured body should include captured_url matching our server.
    const body = snap as unknown as Record<string, unknown>;
    // Verify snapshot was built (model field set).
    expect(snap.model).toBe('test');
  });
});

// ---------------------------------------------------------------------------
// Tests: runner.name
// ---------------------------------------------------------------------------

describe('createAfkRunner()', () => {
  it('has name "afk"', () => {
    const runner = createAfkRunner();
    expect(runner.name).toBe('afk');
  });
});
