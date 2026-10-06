import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProcessJobCapError, ProcessJobRegistry, isProcessJobId } from './process-jobs.js';
import { enforceSessionQuota } from './process-jobs.sweep.js';
import { ProcessLogSink } from './process-log-sink.js';

// Real processes: these tests exercise process groups, signals and pipes.
// POSIX-shaped commands run under the resolved shell (Git Bash on Windows).

let dir: string;
let reg: ProcessJobRegistry;

function makeRegistry(extra: Partial<ConstructorParameters<typeof ProcessJobRegistry>[0]> = {}): ProcessJobRegistry {
  return new ProcessJobRegistry({
    logDir: dir, sweep: false, cancelGraceMs: 300, closeGraceMs: 200, reapGraceMs: 200, ...extra,
  });
}

function groupAlive(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true; } catch { return false; }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-proc-jobs-'));
  reg = makeRegistry();
});

afterEach(async () => {
  await reg.killAll();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('ProcessJobRegistry', () => {
  it('returns immediately with a proc- id and a running status', () => {
    const t0 = Date.now();
    const job = reg.start({ command: 'sleep 5', env: process.env });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(isProcessJobId(job.id)).toBe(true);
    expect(job.status).toBe('running');
    expect(job.pid).toBeGreaterThan(0);
    expect(job.logPath.startsWith(dir)).toBe(true);
  });

  it('records completed with exit 0 and writes output to the log', async () => {
    const job = reg.start({ command: 'echo hello-log; echo err-line 1>&2', env: process.env });
    const done = await reg.waitFor(job.id);
    expect(done?.status).toBe('completed');
    expect(done?.exitCode).toBe(0);
    const log = fs.readFileSync(job.logPath, 'utf8');
    expect(log).toContain('hello-log');
    expect(log).toContain('err-line');
    expect(reg.tail(job.id, 100)).toContain('hello-log');
  });

  it('records failed with the real exit code', async () => {
    const job = reg.start({ command: 'exit 3', env: process.env });
    const done = await reg.waitFor(job.id);
    expect(done?.status).toBe('failed');
    expect(done?.exitCode).toBe(3);
  });

  it('emits settled exactly once per job', async () => {
    const seen: string[] = [];
    reg.on('settled', (j) => seen.push(`${j.id}:${j.status}`));
    const job = reg.start({ command: 'true', env: process.env });
    await reg.waitFor(job.id);
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual([`${job.id}:completed`]);
  });

  it('cancel reaps the whole process group, including background grandchildren', async () => {
    const job = reg.start({ command: 'sleep 300 & sleep 300', env: process.env });
    await new Promise((r) => setTimeout(r, 200));
    expect(groupAlive(job.pid!)).toBe(true);
    const snap = reg.cancel(job.id, 'model');
    expect(snap?.cancelSource).toBe('model');
    const done = await reg.waitFor(job.id);
    expect(done?.status).toBe('cancelled');
    expect(groupAlive(job.pid!)).toBe(false);
  });

  it('escalates to SIGKILL when the process traps SIGTERM', async () => {
    const job = reg.start({ command: "trap '' TERM; sleep 300", env: process.env });
    await new Promise((r) => setTimeout(r, 200));
    reg.cancel(job.id, 'model');
    const done = await reg.waitFor(job.id);
    expect(done?.status).toBe('cancelled');
    expect(groupAlive(job.pid!)).toBe(false);
  });

  it('cancel after natural exit sends no signal and keeps the natural status', async () => {
    const job = reg.start({ command: 'true', env: process.env });
    await reg.waitFor(job.id);
    const spy = vi.spyOn(process, 'kill');
    const snap = reg.cancel(job.id, 'model');
    expect(snap?.status).toBe('completed');
    expect(snap?.cancelSource).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('reaps group members that outlive the leader and reports it', async () => {
    // The leader exits at once; the backgrounded sleep keeps the pipe open.
    const job = reg.start({ command: 'sleep 300 & exit 0', env: process.env });
    const done = await reg.waitFor(job.id);
    expect(done?.orphansReaped).toBe(true);
    expect(done?.exitCode).toBe(0);
    expect(groupAlive(job.pid!)).toBe(false);
  });

  it('a cancel during the post-exit grace keeps the natural outcome', async () => {
    // Leader exits 0 at once; a backgrounded sleep holds the pipe, so the job
    // is still settling (close-grace) when the cancel lands.
    const job = reg.start({ command: 'sleep 300 & exit 0', env: process.env });
    await new Promise((r) => setTimeout(r, 100));
    const snap = reg.cancel(job.id, 'model');
    expect(snap?.cancelSource).toBeUndefined();
    const done = await reg.waitFor(job.id);
    expect(done?.status).toBe('completed');
    expect(done?.orphansReaped).toBe(true);
  });

  it('refuses new jobs once teardown has begun', async () => {
    await reg.killAll();
    expect(() => reg.start({ command: 'true', env: process.env })).toThrow(/session is ending/);
  });

  it('times out at the max runtime with timed_out status', async () => {
    const job = reg.start({ command: 'sleep 300', env: process.env, maxRuntimeMs: 200 });
    const done = await reg.waitFor(job.id);
    expect(done?.status).toBe('timed_out');
  });

  it('enforces the concurrency cap', async () => {
    const small = makeRegistry({ maxConcurrent: 1 });
    try {
      small.start({ command: 'sleep 5', env: process.env });
      expect(() => small.start({ command: 'sleep 5', env: process.env })).toThrow(ProcessJobCapError);
    } finally {
      await small.killAll();
    }
  });

  it('killAll stops every running job as teardown and removes the exit hook', async () => {
    const before = process.listenerCount('exit');
    const a = reg.start({ command: 'sleep 300', env: process.env });
    expect(process.listenerCount('exit')).toBe(before + 1);
    const stopped = await reg.killAll();
    expect(stopped.map((j) => j.id)).toEqual([a.id]);
    expect(reg.get(a.id)?.status).toBe('cancelled');
    expect(reg.get(a.id)?.cancelSource).toBe('teardown');
    expect(process.listenerCount('exit')).toBe(before);
  });

  it('a spawn failure in a missing cwd settles as failed', async () => {
    const job = reg.start({ command: 'true', env: process.env, cwd: path.join(dir, 'nope') });
    const done = await reg.waitFor(job.id);
    expect(done?.status).toBe('failed');
  });
});

describe('ProcessLogSink', () => {
  it('rotates at the cap without losing the process and bounds disk use', () => {
    const logPath = path.join(dir, 'x.log');
    const sink = new ProcessLogSink({ logPath, capBytes: 1024, tailChars: 256 });
    for (let i = 0; i < 10; i++) sink.write(Buffer.alloc(600, 'a'));
    sink.close();
    expect(sink.rotations).toBeGreaterThan(0);
    expect(sink.totalBytes).toBe(6000);
    expect(fs.statSync(logPath).size).toBeLessThanOrEqual(1024);
    expect(fs.existsSync(`${logPath}.1`)).toBe(true);
    expect(sink.tail().length).toBeLessThanOrEqual(512);
  });

  it('keeps a UTF-8 character split across chunks of one stream intact', () => {
    const sink = new ProcessLogSink({ logPath: path.join(dir, 'u.log') });
    const bytes = Buffer.from('héllo', 'utf8');
    sink.write(bytes.subarray(0, 2), 'stdout');
    sink.write(Buffer.from('X'), 'stderr');
    sink.write(bytes.subarray(2), 'stdout');
    sink.close();
    expect(sink.tail()).toContain('héllo'.slice(2));
    expect(sink.tail()).not.toContain('\uFFFD');
  });

  it('strips ANSI from the in-memory tail but keeps raw bytes in the file', () => {
    const logPath = path.join(dir, 'y.log');
    const sink = new ProcessLogSink({ logPath });
    sink.write(Buffer.from('\x1b[31mred\x1b[0m'));
    sink.close();
    expect(sink.tail()).toBe('red');
    expect(fs.readFileSync(logPath, 'utf8')).toContain('\x1b[31m');
  });
});

describe('enforceSessionQuota', () => {
  it('deletes oldest settled logs first and never touches live logs', () => {
    const old = path.join(dir, 'proc-1.log');
    const live = path.join(dir, 'proc-2.log');
    const newer = path.join(dir, 'proc-3.log');
    fs.writeFileSync(old, Buffer.alloc(400));
    fs.writeFileSync(live, Buffer.alloc(400));
    fs.writeFileSync(newer, Buffer.alloc(400));
    const t = Date.now() / 1000;
    fs.utimesSync(old, t - 300, t - 300);
    fs.utimesSync(live, t - 400, t - 400);
    enforceSessionQuota(dir, 900, new Set([live]));
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(live)).toBe(true);
    expect(fs.existsSync(newer)).toBe(true);
  });
});
