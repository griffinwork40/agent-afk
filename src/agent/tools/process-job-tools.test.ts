/**
 * End-to-end tests for `bash run_in_background` through the real dispatcher:
 * start, inspect, cancel, refusals, tool advertisement, and the risk floor.
 * Uses real processes and a real ProcessJobRegistry in a temp log dir.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionToolDispatcher } from './dispatcher.js';
import { builtinToolSchemas } from './schemas.js';
import { createBashHandler } from './handlers/bash.js';
import { SpawnedPidRegistry } from './handlers/pid-registry.js';
import { ProcessJobRegistry } from '../shell-jobs/process-jobs.js';
import { classifyRisk } from '../risk-classifier.js';
import { filterBackgroundToolDefs } from './process-job-tools.js';
import type { ToolCall } from './types.js';

const BG_TOOLS = ['bash', 'get_background_job_health', 'cancel_background_job', 'send_message_to_agent'];

let dir: string;
let reg: ProcessJobRegistry;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-proc-tools-'));
  reg = new ProcessJobRegistry({ logDir: dir, sweep: false, cancelGraceMs: 300, closeGraceMs: 200, reapGraceMs: 200 });
});

afterEach(async () => {
  await reg.killAll();
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeDispatcher(opts: { processJobs?: ProcessJobRegistry; readOnlyBash?: boolean; pids?: SpawnedPidRegistry } = {}) {
  return new SessionToolDispatcher({
    handlers: new Map([['bash', createBashHandler('bypassPermissions', dir)]]),
    schemas: [...builtinToolSchemas],
    permissions: { allowedTools: BG_TOOLS },
    ...(opts.processJobs ? { processJobs: opts.processJobs } : {}),
    ...(opts.readOnlyBash ? { readOnlyBash: true } : {}),
    ...(opts.pids ? { spawnedPidRegistry: opts.pids } : {}),
  });
}

function call(name: string, input: Record<string, unknown>): ToolCall {
  return { id: `t-${Math.random()}`, name, input, signal: new AbortController().signal };
}

async function startJob(d: SessionToolDispatcher, command: string, extra: Record<string, unknown> = {}) {
  const res = await d.execute(call('bash', { command, run_in_background: true, ...extra }));
  expect(res.isError).toBeFalsy();
  return JSON.parse(res.content as string) as { job_id: string; pid: number; log_path: string; max_runtime_ms: number };
}

describe('bash run_in_background via the dispatcher', () => {
  it('starts a job, returns at once, and registers the leader pid for wait_for', async () => {
    const pids = new SpawnedPidRegistry();
    const d = makeDispatcher({ processJobs: reg, pids });
    const t0 = Date.now();
    const job = await startJob(d, 'sleep 30');
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(job.job_id).toMatch(/^proc-\d+$/);
    expect(job.max_runtime_ms).toBe(2 * 60 * 60 * 1000);
    expect(pids.has(job.pid)).toBe(true);
  });

  it('runs in the session cwd', async () => {
    const d = makeDispatcher({ processJobs: reg });
    const job = await startJob(d, 'pwd');
    await reg.waitFor(job.job_id);
    expect(fs.readFileSync(job.log_path, 'utf8').trim()).toBe(fs.realpathSync(dir));
  });

  it('accepts a timeout above the foreground ceiling only when backgrounded', async () => {
    const d = makeDispatcher({ processJobs: reg });
    const job = await startJob(d, 'sleep 30', { timeout_ms: 3_600_000 });
    expect(job.max_runtime_ms).toBe(3_600_000);
    const fg = await d.execute(call('bash', { command: 'true', timeout_ms: 3_600_000 }));
    expect(fg.isError).toBe(true);
  });

  it('rejects a background max runtime under one second', async () => {
    const d = makeDispatcher({ processJobs: reg });
    const res = await d.execute(call('bash', { command: 'sleep 30', run_in_background: true, timeout_ms: 0 }));
    expect(res.isError).toBe(true);
    expect(reg.list()).toHaveLength(0);
  });

  it('rejects a non-boolean run_in_background', async () => {
    const d = makeDispatcher({ processJobs: reg });
    const res = await d.execute(call('bash', { command: 'true', run_in_background: 'yes' }));
    expect(res.isError).toBe(true);
  });

  it('refuses explicitly when no registry is wired (children, Telegram, daemon)', async () => {
    const d = makeDispatcher();
    const res = await d.execute(call('bash', { command: 'sleep 30', run_in_background: true }));
    expect(res.isError).toBe(true);
    expect(res.content).toContain('not available in this session');
  });

  it('refuses background launches from read-only agents even for read-only commands', async () => {
    const d = makeDispatcher({ processJobs: reg, readOnlyBash: true });
    const res = await d.execute(call('bash', { command: 'cat /etc/hosts', run_in_background: true }));
    expect(res.isError).toBe(true);
    expect(res.content).toContain('may not start background processes');
    expect(reg.list()).toHaveLength(0);
  });

  it('health reports status, exit code, log path and untrusted recent output', async () => {
    const d = makeDispatcher({ processJobs: reg });
    const job = await startJob(d, 'echo marker-xyz; exit 4');
    await reg.waitFor(job.job_id);
    const res = await d.execute(call('get_background_job_health', { jobId: job.job_id }));
    const health = JSON.parse(res.content as string) as Record<string, unknown>;
    expect(health['status']).toBe('failed');
    expect(health['exitCode']).toBe(4);
    expect(health['logPath']).toBe(job.log_path);
    expect(String(health['recentOutput'])).toContain('marker-xyz');
    expect(String(health['note'])).toContain('untrusted');
  });

  it('cancel stops the exact job and returns its final status', async () => {
    const d = makeDispatcher({ processJobs: reg });
    const job = await startJob(d, 'sleep 300 & sleep 300');
    const res = await d.execute(call('cancel_background_job', { jobId: job.job_id, reason: 'done' }));
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('status cancelled');
    expect(reg.get(job.job_id)?.status).toBe('cancelled');
  });

  it('cancel on an already-finished job is a non-error no-op', async () => {
    const d = makeDispatcher({ processJobs: reg });
    const job = await startJob(d, 'true');
    await reg.waitFor(job.job_id);
    const res = await d.execute(call('cancel_background_job', { jobId: job.job_id, reason: 'x' }));
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('already completed');
  });

  it('unknown process ids are errors', async () => {
    const d = makeDispatcher({ processJobs: reg });
    const res = await d.execute(call('get_background_job_health', { jobId: 'proc-999' }));
    expect(res.isError).toBe(true);
  });

  it('advertises health and cancel (not steering) when only the process registry is wired', () => {
    const names = (d: SessionToolDispatcher) => new Set(d.toolDefs.map((t) => t.name));
    const withJobs = names(makeDispatcher({ processJobs: reg }));
    expect(withJobs.has('get_background_job_health')).toBe(true);
    expect(withJobs.has('cancel_background_job')).toBe(true);
    expect(withJobs.has('send_message_to_agent')).toBe(false);
    const without = names(makeDispatcher());
    expect(without.has('get_background_job_health')).toBe(false);
  });

  it('send_message_to_agent refuses process ids', async () => {
    const d = makeDispatcher({ processJobs: reg });
    const res = await d.execute(call('send_message_to_agent', { jobId: 'proc-1', message: 'hi' }));
    expect(res.isError).toBe(true);
    expect(res.content).toContain('take no input');
  });
});

describe('filterBackgroundToolDefs', () => {
  const defs = builtinToolSchemas.filter((s) => BG_TOOLS.includes(s.name));
  it('keeps all three background tools when subagent background is supported', () => {
    expect(filterBackgroundToolDefs(defs, true, false).map((d) => d.name)).toContain('send_message_to_agent');
  });
  it('drops every background tool when neither registry exists', () => {
    const names = filterBackgroundToolDefs(defs, false, false).map((d) => d.name);
    expect(names).toEqual(['bash']);
  });
});

describe('risk floor for background launches', () => {
  const ctx = { cwd: os.tmpdir(), workspaceRoot: os.tmpdir() };
  it('raises a safe-classified command to medium when backgrounded', () => {
    expect(classifyRisk('bash', { command: 'cat x; python -m http.server' }, ctx)).toBe('safe');
    expect(classifyRisk('bash', { command: 'cat x; python -m http.server', run_in_background: true }, ctx)).toBe('medium');
  });
  it('never lowers a higher classification', () => {
    expect(classifyRisk('bash', { command: 'rm -rf dist/', run_in_background: true }, ctx)).toBe('high');
  });
});
