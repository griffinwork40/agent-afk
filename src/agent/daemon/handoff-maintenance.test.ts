/**
 * Handoff maintenance runs in EVERY daemon trigger mode (#1416).
 *
 * Uses a CronScheduler with NO pull interval (cron/sessionstart/both shape),
 * injected tmp queue/handoffs/telemetry dirs, and fake setInterval + Date.
 * setTimeout stays real so `vi.waitFor` can poll real async fs work.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CronScheduler } from './scheduler.js';
import { enqueue, listPending } from './queue-store.js';
import { readHandoff, writeHandoff, type HandoffRecord } from './handoff-store.js';
import * as expiry from './handoff-expiry.js';
import { resumeQueueDir } from './handoff-maintenance.js';
import { pushIfConfigured } from '../../telegram/push.js';
import type { AgentSession } from '../session/agent-session.js';

vi.mock('../../telegram/push.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../telegram/push.js')>()),
  pushIfConfigured: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./handoff-expiry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./handoff-expiry.js')>();
  return { ...actual, sweepExpiredHandoffs: vi.fn(actual.sweepExpiredHandoffs) };
});

const HOUR = 60 * 60 * 1_000;
const INTERVAL = 1_000;
const T0 = Date.parse('2026-10-15T12:00:00.000Z');

let root: string;
let queueDir: string;
let handoffsDir: string;
let telemetryPath: string;
let sendMessage: ReturnType<typeof vi.fn>;
let scheduler: CronScheduler | undefined;
let savedAllowProjectMcp: string | undefined;

function makeScheduler(pullPollIntervalMs?: number): CronScheduler {
  scheduler = new CronScheduler({
    queueDir,
    handoffsDir,
    telemetryPath,
    budgetGate: async () => ({ skip: false }),
    ...(pullPollIntervalMs !== undefined ? { pullPollIntervalMs } : {}),
    sessionFactory: () => ({ sendMessage, close: vi.fn().mockResolvedValue(undefined) }) as unknown as AgentSession,
  });
  return scheduler;
}

function handoff(taskId: string, overrides: Partial<HandoffRecord> = {}): HandoffRecord {
  return {
    taskId,
    sessionId: 'sess-1',
    question: { message: `Question for ${taskId}?` },
    requestType: 'ask_question',
    createdAt: new Date(Date.now()).toISOString(),
    status: 'pending',
    originalCommand: '/deploy staging',
    ...overrides,
  };
}

function telemetry(): Array<Record<string, unknown>> {
  if (!existsSync(telemetryPath)) return [];
  return readFileSync(telemetryPath, 'utf-8').trim().split('\n').filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(T0);
  root = mkdtempSync(join(tmpdir(), 'afk-handoff-maint-'));
  queueDir = join(root, 'queue');
  handoffsDir = join(root, 'handoffs');
  telemetryPath = join(root, 'telemetry.jsonl');
  sendMessage = vi.fn().mockResolvedValue({ content: 'resumed ok' });
  vi.mocked(pushIfConfigured).mockClear();
  vi.mocked(expiry.sweepExpiredHandoffs).mockClear();
  expiry.resetExpirySweepThrottleForTests();
  savedAllowProjectMcp = process.env['AFK_ALLOW_PROJECT_MCP'];
  process.env['AFK_ALLOW_PROJECT_MCP'] = '0';
});

afterEach(async () => {
  await scheduler?.stop();
  scheduler = undefined;
  vi.useRealTimers();
  if (savedAllowProjectMcp === undefined) delete process.env['AFK_ALLOW_PROJECT_MCP'];
  else process.env['AFK_ALLOW_PROJECT_MCP'] = savedAllowProjectMcp;
  rmSync(root, { recursive: true, force: true });
});

describe('handoff maintenance in a non-pull (cron) daemon', () => {
  it('startup recovery expires stale handoffs and re-notifies fresh ones', async () => {
    await writeHandoff(handoff('q-stale', { createdAt: new Date(T0 - 25 * HOUR).toISOString() }), handoffsDir);
    await writeHandoff(handoff('q-fresh'), handoffsDir);

    makeScheduler().startHandoffMaintenance(INTERVAL);

    await vi.waitFor(async () => {
      expect((await readHandoff('q-stale', handoffsDir))?.status).toBe('expired');
    });
    expect((await readHandoff('q-fresh', handoffsDir))?.status).toBe('pending');
    const texts = vi.mocked(pushIfConfigured).mock.calls.map((c) => String(c[0]));
    expect(texts.some((t) => t.includes('Reminder') && t.includes('q-fresh'))).toBe(true);
    expect(texts.some((t) => t.includes('expired') && t.includes('q-stale'))).toBe(true);
  });

  it('periodic sweep expires a handoff that goes stale while the daemon runs', async () => {
    await writeHandoff(handoff('q-later'), handoffsDir);
    makeScheduler().startHandoffMaintenance(INTERVAL);
    await vi.waitFor(() => expect(pushIfConfigured).toHaveBeenCalled()); // startup reminder done

    vi.setSystemTime(T0 + 25 * HOUR);
    await vi.advanceTimersByTimeAsync(INTERVAL);

    await vi.waitFor(async () => {
      expect((await readHandoff('q-later', handoffsDir))?.status).toBe('expired');
    });
    expect(expiry.sweepExpiredHandoffs).toHaveBeenCalledWith(queueDir, expect.any(Number), handoffsDir);
  });

  it('resumes an answered cron handoff without draining the general queue', async () => {
    enqueue('/unrelated-general-task', {}, queueDir);
    await writeHandoff(handoff('cron-task', {
      status: 'answered',
      answer: { value: 'production' },
      answeredAt: new Date(T0).toISOString(),
    }), handoffsDir);

    makeScheduler().startHandoffMaintenance(INTERVAL);
    await vi.advanceTimersByTimeAsync(INTERVAL);

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    const prompt = String(sendMessage.mock.calls[0]?.[0]);
    expect(prompt).toContain('[Resumed task');
    expect(prompt).toContain('/deploy staging');
    expect(prompt).toContain('production');
    await vi.waitFor(() => expect(telemetry()).toHaveLength(1));
    expect(telemetry()[0]).toMatchObject({ trigger: 'pull', status: 'success' });

    // Answer consumed; the general pull queue is untouched in non-pull modes.
    expect(await readHandoff('cron-task', handoffsDir)).toBeNull();
    expect(listPending(queueDir).map((t) => t.command)).toEqual(['/unrelated-general-task']);
    // The resume lease was finalised (no orphan for lease recovery).
    const leased = join(resumeQueueDir(queueDir), 'leased');
    await vi.waitFor(() => expect(existsSync(leased) ? readdirSync(leased) : []).toEqual([]));
  });

  it('stop() clears the maintenance timer (no leaked handles)', async () => {
    const s = makeScheduler();
    s.startHandoffMaintenance(INTERVAL);
    s.startHandoffMaintenance(INTERVAL); // idempotent
    expect(vi.getTimerCount()).toBe(1);
    await s.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('handoff maintenance in pull mode', () => {
  it('sweeps expiry once per maintenance tick, never from the pull tick', async () => {
    const s = makeScheduler(INTERVAL);
    s.startPullLoop();
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(expiry.sweepExpiredHandoffs).not.toHaveBeenCalled();

    s.startHandoffMaintenance(INTERVAL);
    vi.mocked(expiry.sweepExpiredHandoffs).mockClear();
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    expect(expiry.sweepExpiredHandoffs).toHaveBeenCalledTimes(2);
  });
});
