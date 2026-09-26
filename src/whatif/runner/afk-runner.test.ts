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
 * A fake "afk chat" script that:
 *   - Appends two JSONL lines to $AFK_WHATIF_TOOL_LOG.
 *   - Prints a JSON object to stdout.
 *   - Exits 0.
 */
const FAKE_RUN_SCRIPT = `
const fs = require('fs');
const logPath = process.env.AFK_WHATIF_TOOL_LOG;
if (logPath) {
  fs.appendFileSync(logPath, JSON.stringify({ts:1,tool:'read_file',input:{path:'/foo'},verdict:'executed',subagent:false}) + '\\n');
  fs.appendFileSync(logPath, JSON.stringify({ts:2,tool:'bash',input:{command:'echo hi'},verdict:'recorded',subagent:false}) + '\\n');
}
const out = {
  success: true,
  model: 'claude-3-5-sonnet',
  message: 'Hello from fake agent',
  costUsd: 0.01,
  durationMs: 500,
  inputTokens: 100,
  outputTokens: 50,
};
console.log(JSON.stringify(out, null, 2));
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
    expect(trace.text).toBe('Hello from fake agent');
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
