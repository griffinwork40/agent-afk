/**
 * Unit tests for CronScheduler — focused on telemetry correctness.
 *
 * Uses the `sessionFactory` and `telemetryPath` injection seams so no real
 * AgentSession or filesystem path is ever touched.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CronScheduler, daemonTraceLabel } from './scheduler.js';
import { getTraceDir } from '../../paths.js';
import type { AgentSession } from '../session/agent-session.js';
import type { AgentConfig } from '../types.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'agent-afk-scheduler-'));
}

/**
 * Build a minimal fake AgentSession whose sendMessage() either resolves or
 * rejects with the given Error.
 */
function makeSession(opts: { throws?: Error; response?: string }): AgentSession {
  return {
    sendMessage: opts.throws
      ? () => Promise.reject(opts.throws)
      : () => Promise.resolve({ content: opts.response ?? '' }),
    close: () => Promise.resolve(),
  } as unknown as AgentSession;
}

describe('CronScheduler telemetry — errorMessage redaction', () => {
  let dir: string;
  let telemetryPath: string;

  beforeEach(() => {
    dir = makeTmpDir();
    telemetryPath = join(dir, 'forge-telemetry.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('redacts an Anthropic API key in errorMessage (sk-ant-…)', async () => {
    const rawSecret = 'sk-ant-api03-abc123XYZABC123xyz-0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000XXXX';
    const err = new Error(`HTTP 401 Unauthorized: Authorization: Bearer ${rawSecret}`);

    const scheduler = new CronScheduler({
      telemetryPath,
      sessionFactory: () => makeSession({ throws: err }),
    });

    scheduler.register({
      taskId: 'secret-test',
      command: 'run-report',
      trigger: 'cron',
      cronExpression: '* * * * *',
    });

    const record = await scheduler.tick('secret-test');

    // The returned record must already be redacted
    expect(record.status).toBe('error');
    expect(record.errorMessage).not.toContain(rawSecret);
    expect(record.errorMessage).toMatch(/REDACTED/);

    // The persisted JSONL line must also be redacted
    const line = readFileSync(telemetryPath, 'utf-8').trim();
    const persisted = JSON.parse(line) as { errorMessage?: string };
    expect(persisted.errorMessage).not.toContain(rawSecret);
    expect(persisted.errorMessage).toMatch(/REDACTED/);

    await scheduler.stop();
  });

  it('redacts a Bearer token in errorMessage', async () => {
    const bearerToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.somePayload.signature';
    const err = new Error(`API error: Bearer ${bearerToken} was rejected`);

    const scheduler = new CronScheduler({
      telemetryPath,
      sessionFactory: () => makeSession({ throws: err }),
    });

    scheduler.register({
      taskId: 'bearer-test',
      command: 'sync',
      trigger: 'cron',
      cronExpression: '* * * * *',
    });

    const record = await scheduler.tick('bearer-test');

    expect(record.status).toBe('error');
    expect(record.errorMessage).not.toContain(bearerToken);
    expect(record.errorMessage).toMatch(/REDACTED/);

    const line = readFileSync(telemetryPath, 'utf-8').trim();
    const persisted = JSON.parse(line) as { errorMessage?: string };
    expect(persisted.errorMessage).not.toContain(bearerToken);
    expect(persisted.errorMessage).toMatch(/REDACTED/);

    await scheduler.stop();
  });

  it('passes through error messages that contain no secrets', async () => {
    const safeMessage = 'connection timeout after 30s';
    const err = new Error(safeMessage);

    const scheduler = new CronScheduler({
      telemetryPath,
      sessionFactory: () => makeSession({ throws: err }),
    });

    scheduler.register({
      taskId: 'safe-error-test',
      command: 'health-check',
      trigger: 'cron',
      cronExpression: '* * * * *',
    });

    const record = await scheduler.tick('safe-error-test');

    expect(record.status).toBe('error');
    expect(record.errorMessage).toBe(safeMessage);

    await scheduler.stop();
  });

  it('success path: responseExcerpt is still redacted', async () => {
    const rawSecret = 'sk-ant-api03-secretkeyABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcdefghijklmnopqrstu';
    const scheduler = new CronScheduler({
      telemetryPath,
      sessionFactory: () => makeSession({ response: `Here is the token: ${rawSecret}` }),
    });

    scheduler.register({
      taskId: 'success-redact-test',
      command: 'query',
      trigger: 'cron',
      cronExpression: '* * * * *',
    });

    const record = await scheduler.tick('success-redact-test');

    expect(record.status).toBe('success');
    expect(record.responseExcerpt).not.toContain(rawSecret);
    expect(record.responseExcerpt).toMatch(/REDACTED/);

    await scheduler.stop();
  });

  it('passes full redacted response to completion callback without persisting it', async () => {
    const rawSecret = 'sk-ant-api03-secretkeyABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcdefghijklmnopqrstu';
    const tail = 'TAIL_AFTER_EXCERPT';
    const response = `${'x'.repeat(350)}${rawSecret}\n${tail}`;
    const onTaskComplete = vi.fn();
    const scheduler = new CronScheduler({
      telemetryPath,
      sessionFactory: () => makeSession({ response }),
      onTaskComplete,
    });

    scheduler.register({
      taskId: 'full-response-test',
      command: 'query',
      trigger: 'cron',
      cronExpression: '* * * * *',
    });

    const record = await scheduler.tick('full-response-test');

    expect(record.status).toBe('success');
    expect(record.responseExcerpt).not.toContain(tail);
    expect(onTaskComplete).toHaveBeenCalledOnce();
    const [callbackRecord, details] = onTaskComplete.mock.calls[0]!;
    expect(callbackRecord).toBe(record);
    expect(details?.responseText).toContain(tail);
    expect(details?.responseText).toContain('REDACTED');
    expect(details?.responseText).not.toContain(rawSecret);

    const line = readFileSync(telemetryPath, 'utf-8').trim();
    expect(line).not.toContain(tail);
    expect(line).not.toContain(rawSecret);

    await scheduler.stop();
  });
});

describe('CronScheduler — witness trace-writer wiring', () => {
  let dir: string;
  let telemetryPath: string;
  let savedHome: string | undefined;
  let savedDisabled: string | undefined;

  beforeEach(() => {
    dir = makeTmpDir();
    telemetryPath = join(dir, 'forge-telemetry.jsonl');
    savedHome = process.env['AFK_HOME'];
    savedDisabled = process.env['AFK_TRACE_DISABLED'];
    // Isolate any witness directory under the temp dir; the fake session never
    // writes through the lazy writer, so no trace file is actually created.
    process.env['AFK_HOME'] = dir;
    delete process.env['AFK_TRACE_DISABLED'];
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env['AFK_HOME'];
    else process.env['AFK_HOME'] = savedHome;
    if (savedDisabled === undefined) delete process.env['AFK_TRACE_DISABLED'];
    else process.env['AFK_TRACE_DISABLED'] = savedDisabled;
    rmSync(dir, { recursive: true, force: true });
  });

  it('threads a default trace writer into the spawned session config', async () => {
    let captured: AgentConfig | undefined;
    const scheduler = new CronScheduler({
      telemetryPath,
      sessionFactory: (config) => {
        captured = config;
        return makeSession({ response: 'ok' });
      },
    });
    scheduler.register({
      taskId: 'trace-on',
      command: 'hello',
      trigger: 'cron',
      cronExpression: '* * * * *',
    });

    await scheduler.tick('trace-on');

    expect(captured?.traceWriter).toBeDefined();

    await scheduler.stop();
  });

  it('omits the trace writer when AFK_TRACE_DISABLED=1', async () => {
    process.env['AFK_TRACE_DISABLED'] = '1';
    let captured: AgentConfig | undefined;
    const scheduler = new CronScheduler({
      telemetryPath,
      sessionFactory: (config) => {
        captured = config;
        return makeSession({ response: 'ok' });
      },
    });
    scheduler.register({
      taskId: 'trace-off',
      command: 'hello',
      trigger: 'cron',
      cronExpression: '* * * * *',
    });

    await scheduler.tick('trace-off');

    expect(captured?.traceWriter).toBeUndefined();

    await scheduler.stop();
  });
});

describe('daemonTraceLabel', () => {
  const SAFE = /^[a-zA-Z0-9_-]+$/;

  it('prefixes the taskId so traces are greppable by task name', () => {
    const label = daemonTraceLabel('nightly-forge');
    expect(label.startsWith('nightly-forge-')).toBe(true);
    expect(SAFE.test(label)).toBe(true);
  });

  it('sanitizes disallowed characters so getTraceDir never throws', () => {
    const label = daemonTraceLabel('weird/../id with spaces.json');
    expect(SAFE.test(label)).toBe(true);
    expect(() => getTraceDir(label)).not.toThrow();
  });

  it('is unique per call so repeated ticks get their own trace dir', () => {
    expect(daemonTraceLabel('t')).not.toBe(daemonTraceLabel('t'));
  });

  it('falls back to a non-empty label when the taskId has no safe characters', () => {
    const label = daemonTraceLabel('///');
    expect(SAFE.test(label)).toBe(true);
    expect(label.startsWith('task-')).toBe(true);
  });
});
