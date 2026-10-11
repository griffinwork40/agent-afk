/**
 * Tests for cron-task elicitation visibility (#3243 gap 1 partial).
 *
 * Covers two layers:
 *
 * 1. Unit tests for `formatCronElicitationMessage` and
 *    `makeCronElicitationHandler` in isolation.
 *
 * 2. Integration tests for the wiring in `CronScheduler`: when a cron task's
 *    session calls `ask_question`, the cron handler writes a durable handoff
 *    record and fires `onTaskComplete` with a task-aware notification message.
 *
 * @module agent/daemon/scheduler.elicitation-notify.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

vi.mock('node-cron', () => ({
  schedule: vi.fn(() => ({
    start: () => {},
    stop: () => {},
    destroy: () => {},
    getStatus: () => 'stopped',
  })),
}));

vi.mock('../providers/index.js', () => ({
  resolveProvider: () => { throw new Error('not used in elicitation-notify tests'); },
  providerForModel: () => 'anthropic-direct',
}));

vi.mock('../default-hook-registry.js', () => ({
  createDefaultHookRegistry: () => ({
    registry: undefined,
    memoryStore: { close: () => {} },
  }),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  formatCronElicitationMessage,
  makeCronElicitationHandler,
} from './scheduler.elicitation-notify.js';
import { CronScheduler, type TelemetryRecord, type TaskCompletionDetails } from './scheduler.js';
import { elicitationRouter } from '../elicitation-router.js';
import type { AgentSession } from '../session/agent-session.js';
import type { AgentConfig } from '../types.js';
import type { ScheduledTask } from './triggers.js';
import type { ElicitationRequest } from '../types/sdk-types.js';

// ---------------------------------------------------------------------------
// Unit: formatCronElicitationMessage
// ---------------------------------------------------------------------------

describe('formatCronElicitationMessage', () => {
  it('includes taskId, command, and question in output', () => {
    const msg = formatCronElicitationMessage('my-task', '/deploy', '0 * * * *', 'Continue?');
    expect(msg).toContain('my-task');
    expect(msg).toContain('/deploy');
    expect(msg).toContain('Continue?');
    expect(msg).toContain('0 * * * *');
  });

  it('omits cron note when cronExpression is undefined', () => {
    const msg = formatCronElicitationMessage('t', '/cmd', undefined, 'ok?');
    expect(msg).not.toContain('cron:');
    expect(msg).toContain('t');
  });

  it('truncates a question longer than 300 chars', () => {
    const long = 'x'.repeat(400);
    const msg = formatCronElicitationMessage('t', '/cmd', undefined, long);
    expect(msg).toContain('\u2026(truncated)');
    expect(msg.includes('x'.repeat(301))).toBe(false);
  });

  it('does not truncate a question of exactly 300 chars', () => {
    const exact = 'y'.repeat(300);
    const msg = formatCronElicitationMessage('t', '/cmd', undefined, exact);
    expect(msg).not.toContain('truncated');
    expect(msg).toContain(exact);
  });
});

// ---------------------------------------------------------------------------
// Unit: makeCronElicitationHandler
// ---------------------------------------------------------------------------

describe('makeCronElicitationHandler', () => {
  let handoffsDir: string;
  const signal = new AbortController().signal;

  beforeEach(() => {
    handoffsDir = mkdtempSync(join(tmpdir(), 'afk-elicit-unit-'));
  });

  afterEach(() => {
    rmSync(handoffsDir, { recursive: true, force: true });
  });

  const request: ElicitationRequest = {
    message: 'Should I proceed?',
    type: 'confirm',
  };

  it('always returns { action: decline }', async () => {
    const handler = makeCronElicitationHandler({
      taskId: 'task-1',
      originalCommand: '/cmd',
      handoffsDir,
    });
    const result = await handler(request, { signal });
    expect(result).toEqual({ action: 'decline' });
  });

  it('writes a durable handoff record', async () => {
    const handler = makeCronElicitationHandler({
      taskId: 'task-1',
      originalCommand: '/cmd',
      handoffsDir,
    });
    await handler(request, { signal });
    const files = readdirSync(handoffsDir).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(1);
    const rec = JSON.parse(readFileSync(join(handoffsDir, files[0]!), 'utf-8')) as Record<string, unknown>;
    expect(rec['taskId']).toBe('task-1');
    expect(rec['status']).toBe('pending');
    expect(rec['requestType']).toBe('ask_question');
  });

  it('calls onHandoffWritten with a task-aware message when handoff succeeds', async () => {
    const messages: string[] = [];
    const handler = makeCronElicitationHandler({
      taskId: 'task-2',
      originalCommand: '/run',
      cronExpression: '* * * * *',
      handoffsDir,
      onHandoffWritten: (m) => { messages.push(m); },
    });
    await handler(request, { signal });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('task-2');
    expect(messages[0]).toContain('/run');
    expect(messages[0]).toContain('Should I proceed?');
  });

  it('declines immediately without calling onHandoffWritten when signal is pre-aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const messages: string[] = [];
    const handler = makeCronElicitationHandler({
      taskId: 'task-3',
      originalCommand: '/cmd',
      handoffsDir,
      onHandoffWritten: (m) => { messages.push(m); },
    });
    const result = await handler(request, { signal: ac.signal });
    expect(result).toEqual({ action: 'decline' });
    expect(messages).toHaveLength(0);
    // No handoff written (pre-abort fast path)
    const files = readdirSync(handoffsDir).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(0);
  });

  it('does not call onHandoffWritten when handoff write fails', async () => {
    const messages: string[] = [];
    // Pass a non-existent, non-creatable path to force a write failure.
    const badDir = '/dev/null/no-such-dir';
    const handler = makeCronElicitationHandler({
      taskId: 'task-4',
      originalCommand: '/cmd',
      handoffsDir: badDir,
      onHandoffWritten: (m) => { messages.push(m); },
    });
    const result = await handler(request, { signal });
    expect(result).toEqual({ action: 'decline' });
    expect(messages).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: CronScheduler wires cron elicitation handler
// ---------------------------------------------------------------------------

describe('CronScheduler cron elicitation notify', () => {
  let dir: string;
  let telemetryPath: string;
  let handoffsDir: string;
  let savedAfkHome: string | undefined;
  let savedProjectMcp: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'afk-elicit-sched-'));
    telemetryPath = join(dir, 'forge-telemetry.jsonl');
    handoffsDir = join(dir, 'handoffs');
    savedAfkHome = process.env['AFK_HOME'];
    savedProjectMcp = process.env['AFK_ALLOW_PROJECT_MCP'];
    process.env['AFK_HOME'] = dir;
    process.env['AFK_ALLOW_PROJECT_MCP'] = '0';
  });

  afterEach(() => {
    if (savedAfkHome === undefined) delete process.env['AFK_HOME'];
    else process.env['AFK_HOME'] = savedAfkHome;
    if (savedProjectMcp === undefined) delete process.env['AFK_ALLOW_PROJECT_MCP'];
    else process.env['AFK_ALLOW_PROJECT_MCP'] = savedProjectMcp;
    rmSync(dir, { recursive: true, force: true });
  });

  function makeFakeSession(triggerElicitation: boolean): AgentSession {
    return {
      sendMessage: async (_cmd: string) => {
        if (triggerElicitation) {
          // Route an elicitation through the router (simulates ask_question).
          const ac = new AbortController();
          await elicitationRouter.route(
            { message: 'Need approval', type: 'confirm' },
            { signal: ac.signal },
          );
        }
        return {
          role: 'assistant' as const,
          content: 'done',
          timestamp: new Date(),
        };
      },
      close: async () => {},
      sessionId: 'test-session-id',
      cwd: dir,
    } as unknown as AgentSession;
  }

  type Factory = NonNullable<ConstructorParameters<typeof CronScheduler>[0]>['sessionFactory'];

  function makeScheduler(
    triggerElicitation: boolean,
    onTaskComplete?: (record: TelemetryRecord, details?: TaskCompletionDetails) => void,
  ): CronScheduler {
    const factory: Factory = ((_config: AgentConfig) => makeFakeSession(triggerElicitation)) as Factory;
    return new CronScheduler({
      telemetryPath,
      handoffsDir,
      budgetGate: async () => ({ skip: false }),
      sessionFactory: factory,
      onTaskComplete,
    });
  }

  function task(extra: Partial<ScheduledTask> = {}): ScheduledTask {
    return {
      taskId: 'elicit-task',
      command: '/do-something',
      trigger: 'cron',
      cronExpression: '0 * * * *',
      notifyOn: 'always',
      ...extra,
    };
  }

  it('when no elicitation fires, onTaskComplete receives normal responseText', async () => {
    const completions: Array<{ record: TelemetryRecord; details?: TaskCompletionDetails }> = [];
    const s = makeScheduler(false, (r, d) => { completions.push({ record: r, details: d }); });
    s.register(task());
    await s.tick('elicit-task');
    await s.stop();
    expect(completions).toHaveLength(1);
    expect(completions[0]?.details?.responseText).toBe('done');
    // No handoff files written
    try {
      const files = readdirSync(handoffsDir).filter((f) => f.endsWith('.json'));
      expect(files).toHaveLength(0);
    } catch {
      // handoffsDir not created — also fine (no elicitation)
    }
  });

  it('when elicitation fires, a handoff record is written', async () => {
    const s = makeScheduler(true);
    s.register(task());
    await s.tick('elicit-task');
    await s.stop();
    const files = readdirSync(handoffsDir).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(1);
    const rec = JSON.parse(readFileSync(join(handoffsDir, files[0]!), 'utf-8')) as Record<string, unknown>;
    expect(rec['taskId']).toBe('elicit-task');
    expect(rec['status']).toBe('pending');
  });

  it('when elicitation fires, onTaskComplete receives task-aware responseText', async () => {
    const completions: Array<{ record: TelemetryRecord; details?: TaskCompletionDetails }> = [];
    const s = makeScheduler(true, (r, d) => { completions.push({ record: r, details: d }); });
    s.register(task());
    await s.tick('elicit-task');
    await s.stop();
    expect(completions).toHaveLength(1);
    const notifyText = completions[0]?.details?.responseText ?? '';
    expect(notifyText).toContain('elicit-task');
    expect(notifyText).not.toBe('done');
  });

  it('elicitation handler is uninstalled after the tick completes', async () => {
    const s = makeScheduler(true);
    s.register(task());
    await s.tick('elicit-task');
    await s.stop();
    // After the tick, the router should have no handler installed.
    expect(elicitationRouter.hasHandler()).toBe(false);
  });

  it('sessionstart trigger also gets the cron handler', async () => {
    const completions: Array<{ record: TelemetryRecord; details?: TaskCompletionDetails }> = [];
    const s = makeScheduler(true, (r, d) => { completions.push({ record: r, details: d }); });
    const t: ScheduledTask = {
      taskId: 'elicit-ss',
      command: '/ss-cmd',
      trigger: 'sessionstart',
      notifyOn: 'always',
    };
    s.register(t);
    // Manually call runOnce via tick (which records as 'cron' trigger).
    await s.tick('elicit-ss');
    await s.stop();
    const files = readdirSync(handoffsDir).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(1);
    const notifyText = completions[0]?.details?.responseText ?? '';
    expect(notifyText).toContain('elicit-ss');
  });
});
