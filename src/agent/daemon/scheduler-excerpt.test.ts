/**
 * Tests for CronScheduler.tick() responseExcerpt truncation marker (#2365).
 *
 * Verifies that:
 *   - A response longer than 280 chars has "… [truncated]" appended to the
 *     responseExcerpt stored on the telemetry record.
 *   - A response of exactly 280 chars gets no truncation marker.
 *   - A response shorter than 280 chars gets no truncation marker.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CronScheduler } from './scheduler.js';
import type { AgentSession } from '../session/agent-session.js';

vi.mock('../providers/index.js', () => ({
  resolveProvider: () => { throw new Error('resolveProvider is not used by scheduler-excerpt tests'); },
  providerForModel: () => 'anthropic-direct',
}));

vi.mock('../default-hook-registry.js', () => ({
  createDefaultHookRegistry: () => ({
    registry: undefined,
    memoryStore: { close: () => {} },
  }),
}));

vi.mock('node-cron', () => ({
  schedule: vi.fn(() => ({
    start: () => {},
    stop: () => {},
    destroy: () => {},
    getStatus: () => 'stopped',
  })),
}));

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'afk-scheduler-excerpt-'));
}

function makeSession(response: string): AgentSession {
  return {
    sendMessage: () => Promise.resolve({ content: response }),
    close: () => Promise.resolve(),
  } as unknown as AgentSession;
}

let dir: string;
let telemetryPath: string;
let savedAfkHome: string | undefined;
let savedAllowProjectMcp: string | undefined;
let isolatedAfkHome: string;

beforeEach(() => {
  dir = makeTmpDir();
  telemetryPath = join(dir, 'forge-telemetry.jsonl');
  isolatedAfkHome = makeTmpDir();
  savedAfkHome = process.env['AFK_HOME'];
  savedAllowProjectMcp = process.env['AFK_ALLOW_PROJECT_MCP'];
  process.env['AFK_HOME'] = isolatedAfkHome;
  process.env['AFK_ALLOW_PROJECT_MCP'] = '0';
});

afterEach(() => {
  if (savedAfkHome === undefined) delete process.env['AFK_HOME'];
  else process.env['AFK_HOME'] = savedAfkHome;
  if (savedAllowProjectMcp === undefined) delete process.env['AFK_ALLOW_PROJECT_MCP'];
  else process.env['AFK_ALLOW_PROJECT_MCP'] = savedAllowProjectMcp;
  rmSync(dir, { recursive: true, force: true });
  rmSync(isolatedAfkHome, { recursive: true, force: true });
});

describe('CronScheduler — responseExcerpt truncation marker', () => {
  it('appends "… [truncated]" when response is longer than 280 chars', async () => {
    const long = 'x'.repeat(400);
    const scheduler = new CronScheduler({
      telemetryPath,
      sessionFactory: () => makeSession(long),
    });
    scheduler.register({ taskId: 'long', command: 'run', trigger: 'cron', cronExpression: '* * * * *' });

    const record = await scheduler.tick('long');

    expect(record.status).toBe('success');
    expect(record.responseExcerpt).toMatch(/… \[truncated\]$/);
    expect(record.responseExcerpt).toHaveLength(280 + '… [truncated]'.length);
    expect(record.responseExcerpt!.slice(0, 280)).toBe('x'.repeat(280));

    await scheduler.stop();
  });

  it('does NOT append the marker when response is exactly 280 chars', async () => {
    const exact = 'y'.repeat(280);
    const scheduler = new CronScheduler({
      telemetryPath,
      sessionFactory: () => makeSession(exact),
    });
    scheduler.register({ taskId: 'exact', command: 'run', trigger: 'cron', cronExpression: '* * * * *' });

    const record = await scheduler.tick('exact');

    expect(record.status).toBe('success');
    expect(record.responseExcerpt).toBe(exact);
    expect(record.responseExcerpt).not.toContain('truncated');

    await scheduler.stop();
  });

  it('does NOT append the marker when response is shorter than 280 chars', async () => {
    const short = 'z'.repeat(100);
    const scheduler = new CronScheduler({
      telemetryPath,
      sessionFactory: () => makeSession(short),
    });
    scheduler.register({ taskId: 'short', command: 'run', trigger: 'cron', cronExpression: '* * * * *' });

    const record = await scheduler.tick('short');

    expect(record.status).toBe('success');
    expect(record.responseExcerpt).toBe(short);
    expect(record.responseExcerpt).not.toContain('truncated');

    await scheduler.stop();
  });
});
