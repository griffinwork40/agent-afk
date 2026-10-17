/**
 * Resume fidelity for answered daemon handoffs (#1416, PR #3877 review):
 *   - a resumed task spawns in the asking task's pinned cwd;
 *   - a resume overlap-guards as the ORIGINAL task id, so a cron fire of that
 *     task is skipped while its resume runs (and a resume waits for the fire);
 *   - startup expires handoffs BEFORE recovering resume leases.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CronScheduler } from './scheduler.js';
import { enqueue, listPending } from './queue-store.js';
import { readHandoff, updateHandoffAnswer, writeHandoff } from './handoff-store.js';
import { resetExpirySweepThrottleForTests } from './handoff-expiry.js';
import { resumeQueueDir } from './handoff-maintenance.js';
import { elicitationRouter, type ElicitationHandler } from '../elicitation-router.js';
import type { AgentSession } from '../session/agent-session.js';
import type { AgentConfig } from '../types.js';

vi.mock('../../telegram/push.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../telegram/push.js')>()),
  pushIfConfigured: vi.fn().mockResolvedValue(undefined),
}));

const INTERVAL = 1_000;
const HOUR = 60 * 60 * 1_000;
const T0 = Date.parse('2026-10-15T12:00:00.000Z');

let root: string;
let queueDir: string;
let handoffsDir: string;
let telemetryPath: string;
let pinnedCwd: string;
let scheduler: CronScheduler | undefined;
let spawnedCwds: Array<string | undefined>;
let sendMessage: ReturnType<typeof vi.fn>;

function makeScheduler(): CronScheduler {
  scheduler = new CronScheduler({
    queueDir,
    handoffsDir,
    telemetryPath,
    budgetGate: async () => ({ skip: false }),
    sessionFactory: (config: AgentConfig) => {
      spawnedCwds.push(config.cwd);
      return { sendMessage, close: vi.fn().mockResolvedValue(undefined) } as unknown as AgentSession;
    },
  });
  return scheduler;
}

function deferred(): { promise: Promise<{ content: string }>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<{ content: string }>((r) => { resolve = () => r({ content: 'done' }); });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(T0);
  root = mkdtempSync(join(tmpdir(), 'afk-handoff-resume-'));
  queueDir = join(root, 'queue');
  handoffsDir = join(root, 'handoffs');
  telemetryPath = join(root, 'telemetry.jsonl');
  pinnedCwd = join(root, 'pinned-repo');
  mkdirSync(pinnedCwd, { recursive: true });
  spawnedCwds = [];
  sendMessage = vi.fn().mockResolvedValue({ content: 'ok' });
  resetExpirySweepThrottleForTests();
  vi.stubEnv('AFK_ALLOW_PROJECT_MCP', '0');
});

afterEach(async () => {
  await scheduler?.stop();
  scheduler = undefined;
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('answered handoff resume keeps the task context', () => {
  it('resumes a cwd-pinned cron task in its pinned cwd', async () => {
    let handler: ElicitationHandler | undefined;
    const realInstall = elicitationRouter.installForSession.bind(elicitationRouter);
    vi.spyOn(elicitationRouter, 'installForSession').mockImplementation((key, h) => {
      handler = h;
      realInstall(key, h);
    });
    sendMessage.mockImplementationOnce(async () => {
      await handler?.({ serverName: 'afk', message: 'Which env?', type: 'text' } as Parameters<ElicitationHandler>[0], { signal: new AbortController().signal, sessionId: 's' });
      return { content: 'asked' };
    });
    const s = makeScheduler();
    s.register({ taskId: 'pinned-task', command: '/deploy', trigger: 'cron', cronExpression: '0 0 1 1 *', cwd: pinnedCwd, notifyOn: 'never' });
    await s.tick('pinned-task');

    const asked = await readHandoff('pinned-task', handoffsDir);
    expect(asked).toMatchObject({ originalTaskId: 'pinned-task', cwd: pinnedCwd, notifyOn: 'never' });
    expect((await updateHandoffAnswer('pinned-task', 'prod', 'telegram', { handoffsDir })).won).toBe(true);

    s.startHandoffMaintenance(INTERVAL);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    expect(String(sendMessage.mock.calls[1]?.[0])).toContain('[Resumed task');
    expect(spawnedCwds).toEqual([pinnedCwd, pinnedCwd]);
  });
});

describe('resume overlap identity is the original task id', () => {
  it('skips a cron fire of task X while X\'s resume is in flight', async () => {
    const s = makeScheduler();
    s.register({ taskId: 'task-x', command: '/x', trigger: 'cron', cronExpression: '0 0 1 1 *' });
    enqueue('[Resumed task] /x', { originalTaskId: 'task-x' }, resumeQueueDir(queueDir));
    const run = deferred();
    sendMessage.mockReturnValueOnce(run.promise);

    s.startHandoffMaintenance(INTERVAL);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));

    const fired = await s.tick('task-x');
    expect(fired).toMatchObject({ status: 'skipped', skipReason: 'overlap', taskId: 'task-x' });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    run.resolve();
  });

  it('defers X\'s resume while a cron fire of X is in flight, then runs it', async () => {
    const s = makeScheduler();
    s.register({ taskId: 'task-x', command: '/x', trigger: 'cron', cronExpression: '0 0 1 1 *' });
    const resumeDir = resumeQueueDir(queueDir);
    enqueue('[Resumed task] /x', { originalTaskId: 'task-x' }, resumeDir);
    const run = deferred();
    sendMessage.mockReturnValueOnce(run.promise);

    const cronRun = s.tick('task-x');
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    s.startHandoffMaintenance(INTERVAL);
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(listPending(resumeDir)).toHaveLength(1);

    run.resolve();
    await cronRun;
    await vi.advanceTimersByTimeAsync(INTERVAL);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    expect(String(sendMessage.mock.calls[1]?.[0])).toContain('[Resumed task');
  });
});

describe('startup ordering', () => {
  it('recovers a resume lease whose handoff expires during startup recovery', async () => {
    const resumeDir = resumeQueueDir(queueDir);
    const leased = join(resumeDir, 'leased');
    mkdirSync(leased, { recursive: true });
    writeFileSync(join(leased, 'q-parked.json'), JSON.stringify({
      id: 'q-parked', command: '/resume', state: 'waiting_human_input', attempts: 1, maxAttempts: 2,
      leaseExpiry: T0 - 1, createdAt: T0 - 25 * HOUR, updatedAt: T0 - 25 * HOUR,
    }));
    await writeHandoff({
      taskId: 'q-parked', sessionId: 's', question: { message: 'Q?' }, requestType: 'ask_question',
      createdAt: new Date(T0 - 25 * HOUR).toISOString(), status: 'pending', originalCommand: '/orig',
    }, handoffsDir);

    makeScheduler().startHandoffMaintenance(INTERVAL);

    await vi.waitFor(async () => {
      expect((await readHandoff('q-parked', handoffsDir))?.status).toBe('expired');
      expect(existsSync(leased) ? readdirSync(leased).filter((f) => f.endsWith('.json')) : []).toEqual([]);
    });
    expect(listPending(resumeDir).map((t) => t.id)).toEqual(['q-parked']);
  });
});
