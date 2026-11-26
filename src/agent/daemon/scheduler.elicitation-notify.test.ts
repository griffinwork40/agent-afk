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
 *    record and sends a question instead of a completion notice.
 *
 * @module agent/daemon/scheduler.elicitation-notify.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  resolveCronQuestionTargets,
} from './scheduler.elicitation-notify.js';
import { CronScheduler, type TelemetryRecord, type TaskCompletionDetails } from './scheduler.js';
import { elicitationRouter } from '../elicitation-router.js';
import { operatorNotify } from '../operator-notify.js';

vi.mock('../operator-notify.js', () => ({ operatorNotify: vi.fn().mockResolvedValue(null) }));
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

  it('signals that the durable handoff was written', async () => {
    const onHandoffWritten = vi.fn();
    const handler = makeCronElicitationHandler({
      taskId: 'task-2',
      originalCommand: '/run',
      cronExpression: '* * * * *',
      handoffsDir,
      onHandoffWritten,
    });
    await handler(request, { signal });
    expect(onHandoffWritten).toHaveBeenCalledOnce();
  });

  it('declines immediately without calling onHandoffWritten when signal is pre-aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const onHandoffWritten = vi.fn();
    const handler = makeCronElicitationHandler({
      taskId: 'task-3',
      originalCommand: '/cmd',
      handoffsDir,
      onHandoffWritten,
    });
    const result = await handler(request, { signal: ac.signal });
    expect(result).toEqual({ action: 'decline' });
    expect(onHandoffWritten).not.toHaveBeenCalled();
    // No handoff written (pre-abort fast path)
    const files = readdirSync(handoffsDir).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(0);
  });

  it('does not call onHandoffWritten when handoff write fails', async () => {
    const onHandoffWritten = vi.fn();
    // Force a write failure portably: a directory path nested under a regular
    // FILE fails mkdir/write with ENOTDIR (POSIX) or ENOENT/EEXIST (win32).
    // `/dev/null/...` is NOT portable — on Windows it resolves to a creatable
    // `C:\dev\null\...`, so the write succeeded and this test failed there.
    const blocker = join(handoffsDir, 'not-a-dir');
    writeFileSync(blocker, '');
    const badDir = join(blocker, 'no-such-dir');
    const handler = makeCronElicitationHandler({
      taskId: 'task-4',
      originalCommand: '/cmd',
      handoffsDir: badDir,
      onHandoffWritten,
    });
    const result = await handler(request, { signal });
    expect(result).toEqual({ action: 'decline' });
    expect(onHandoffWritten).not.toHaveBeenCalled();
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
    vi.mocked(operatorNotify).mockClear();
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
    restoreInstallForSession();
    rmSync(dir, { recursive: true, force: true });
  });

  function makeFakeSession(triggerElicitation: boolean, getSessionKey: () => string | undefined): AgentSession {
    return {
      sendMessage: async (_cmd: string) => {
        if (triggerElicitation) {
          // Route an elicitation through the router (simulates ask_question).
          // Pass sessionKey so the per-session handler registered by
          // runAgentAttempt is found (#3619 — daemon tasks use installForSession).
          const ac = new AbortController();
          const sessionKey = getSessionKey();
          await elicitationRouter.route(
            { message: 'Need approval', type: 'confirm' },
            { signal: ac.signal, ...(sessionKey !== undefined ? { sessionKey } : {}) },
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

  // Shared key capture for the active tick. installForSession is intercepted
  // (call-through) so makeFakeSession.sendMessage can read the key at call
  // time — sendMessage fires AFTER installForSession, so the key is ready.
  let capturedElicitationKey: string | undefined;
  let _originalInstallForSession: typeof elicitationRouter.installForSession | undefined;

  function interceptInstallForSession(): void {
    if (_originalInstallForSession !== undefined) return; // already intercepted
    const orig = elicitationRouter.installForSession.bind(elicitationRouter);
    _originalInstallForSession = orig;
    elicitationRouter.installForSession = (key, handler) => {
      capturedElicitationKey = key;
      orig(key, handler);
    };
  }

  function restoreInstallForSession(): void {
    if (_originalInstallForSession !== undefined) {
      elicitationRouter.installForSession = _originalInstallForSession;
      _originalInstallForSession = undefined;
    }
    capturedElicitationKey = undefined;
  }

  function makeScheduler(
    triggerElicitation: boolean,
    onTaskComplete?: (record: TelemetryRecord, details?: TaskCompletionDetails) => void,
  ): CronScheduler {
    interceptInstallForSession();
    const getKey = () => capturedElicitationKey;
    const factory: Factory = ((_config: AgentConfig) => makeFakeSession(triggerElicitation, getKey)) as Factory;
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

  it('elicitation handler is uninstalled after the tick completes', async () => {
    const s = makeScheduler(true);
    s.register(task());
    await s.tick('elicit-task');
    await s.stop();
    // After the tick, the router should have no handler installed.
    expect(elicitationRouter.hasHandler()).toBe(false);
  });

  it('sessionstart trigger also gets the cron handler', async () => {
    vi.stubEnv('AFK_TELEGRAM_ALLOWED_CHAT_IDS', '4242');
    const s = makeScheduler(true);
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
    expect(operatorNotify).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('elicit-ss'),
      expect.objectContaining({ target: 4242 }),
    );
    vi.unstubAllEnvs();
  });

  // ---------------------------------------------------------------------------
  // Spec 1: completion suppressed only on success; failure must still notify
  // ---------------------------------------------------------------------------

  it('Spec1: successful run with handoff suppresses completion notification', async () => {
    // The handoff owns the user-visible notice; no additional completion push.
    // onTaskComplete is the notification callback — when suppressed, it is NOT
    // called. The telemetry record is the source of truth for the decision.
    const s = makeScheduler(true);
    s.register(task());
    const rec = await s.tick('elicit-task');
    await s.stop();
    expect(rec.status).toBe('success');
    expect(rec.notificationDecision?.state).toBe('suppressed');
    expect(rec.notificationDecision?.kind).toBe('completion');
    expect(rec.notificationDecision?.reason).toBe('handoff-pending');
  });

  it('Spec1: failed run with handoff does NOT suppress failure notification', async () => {
    // Task wrote a handoff on elicitation but then errored — operator must be
    // notified of the failure regardless of the pending question.
    interceptInstallForSession();
    const getKey = () => capturedElicitationKey;

    // Create a session that triggers elicitation then throws.
    const failingSession = {
      sendMessage: async (_cmd: string) => {
        const ac = new AbortController();
        const sessionKey = getKey();
        await elicitationRouter.route(
          { serverName: 'agent', origin: 'agent', message: 'Need approval', type: 'confirm' },
          { signal: ac.signal, ...(sessionKey !== undefined ? { sessionKey } : {}) },
        );
        throw new Error('simulated task failure after elicitation');
      },
      close: async () => {},
      sessionId: 'fail-session',
      cwd: dir,
    } as unknown as AgentSession;

    const factory: Factory = (() => failingSession) as Factory;
    const s = new CronScheduler({
      telemetryPath,
      handoffsDir,
      budgetGate: async () => ({ skip: false }),
      sessionFactory: factory,
    });
    s.register(task({ taskId: 'fail-after-elicit' }));
    const rec = await s.tick('fail-after-elicit');
    await s.stop();

    expect(rec.status).toBe('error');
    // Failure notification must NOT be suppressed by the handoff
    expect(rec.notificationDecision).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Spec 2: targets are resolved BEFORE delivery; each target gets the rich
// question via the bot, with a per-target raw-push fallback carrying the same
// answer buttons. An explicit override is the only target.
// ---------------------------------------------------------------------------

describe('makeCronElicitationHandler target routing', () => {
  let handoffsDir: string;
  const signal = new AbortController().signal;
  const confirmReq: ElicitationRequest = { serverName: 'agent', origin: 'agent', message: 'Deploy now?', type: 'confirm' };
  const confirmKeyboard = {
    inline_keyboard: [[
      { text: 'Yes', callback_data: 'afk:h:1:route-task' },
      { text: 'No', callback_data: 'afk:h:0:route-task' },
    ]],
  };

  beforeEach(() => {
    handoffsDir = mkdtempSync(join(tmpdir(), 'afk-elicit-route-'));
    vi.mocked(operatorNotify).mockReset().mockImplementation(async (_text, opts) => {
      const target = opts?.target;
      return [{ ok: true, chatId: typeof target === 'number' ? target : 0 }] as never;
    });
  });

  afterEach(() => {
    rmSync(handoffsDir, { recursive: true, force: true });
  });

  /** Fake Telegraf whose sendMessage fails for the given chat ids. */
  function fakeBot(failFor: readonly number[] = []) {
    let nextId = 100;
    const sendMessage = vi.fn(async (chatId: number, _text: string, _extra?: Record<string, unknown>) => {
      if (failFor.includes(chatId)) throw new Error(`send to ${chatId} failed`);
      nextId += 1;
      return { message_id: nextId, chat: { id: chatId } };
    });
    return { bot: { telegram: { sendMessage } } as unknown as import('telegraf').Telegraf, sendMessage };
  }

  function handler(extra: Partial<Parameters<typeof makeCronElicitationHandler>[0]>) {
    return makeCronElicitationHandler({
      taskId: 'route-task',
      originalCommand: '/run',
      cronExpression: '* * * * *',
      handoffsDir,
      ...extra,
    });
  }

  it('resolveCronQuestionTargets: override wins without consulting defaults; defaults are de-duplicated', () => {
    const defaults = vi.fn(() => [101, 102, 101, 0]);
    expect(resolveCronQuestionTargets(-100200, defaults)).toEqual([-100200]);
    expect(defaults).not.toHaveBeenCalled();
    expect(resolveCronQuestionTargets(undefined, defaults)).toEqual([101, 102]);
  });

  it('broadcast/custom defaults: every target gets the rich question with buttons exactly once', async () => {
    const { bot, sendMessage } = fakeBot();
    await handler({
      bot,
      primaryChatId: 101,
      primaryThreadId: 7,
      resolveDefaultTargets: () => [101, 102, -100200],
    })(confirmReq, { signal });

    expect(sendMessage.mock.calls.map((c) => c[0])).toEqual([101, 102, -100200]);
    for (const [chatId, , extra] of sendMessage.mock.calls as unknown as Array<[number, string, Record<string, unknown>]>) {
      expect(extra['reply_markup']).toMatchObject(confirmKeyboard);
      // Thread id is specific to the primary chat only.
      if (chatId === 101) expect(extra['message_thread_id']).toBe(7);
      else expect(extra).not.toHaveProperty('message_thread_id');
    }
    expect(operatorNotify).not.toHaveBeenCalled();
  });

  it('explicit override delivers ONLY to that target (no configured-default leak)', async () => {
    const { bot, sendMessage } = fakeBot();
    const defaults = vi.fn(() => [101, 102]);
    await handler({
      bot,
      overrideChatId: -100200,
      primaryChatId: 101,
      primaryThreadId: 7,
      resolveDefaultTargets: defaults,
    })(confirmReq, { signal });

    expect(defaults).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0]?.[0]).toBe(-100200);
    expect(sendMessage.mock.calls[0]?.[2]).not.toHaveProperty('message_thread_id');
    expect(operatorNotify).not.toHaveBeenCalled();
  });

  it('explicit override falls back to raw push for that target only, with buttons', async () => {
    const { bot } = fakeBot([-100200]);
    await handler({
      bot,
      overrideChatId: -100200,
      primaryChatId: 101,
      resolveDefaultTargets: () => [101, 102],
    })(confirmReq, { signal });

    expect(operatorNotify).toHaveBeenCalledOnce();
    expect(vi.mocked(operatorNotify).mock.calls[0]?.[1]).toEqual({ target: -100200, replyMarkup: confirmKeyboard });
  });

  it('per-target fallback: only the failed target is re-sent via raw push, with buttons and its own thread', async () => {
    const { bot, sendMessage } = fakeBot([101, -100200]);
    await handler({
      bot,
      primaryChatId: 101,
      primaryThreadId: 7,
      resolveDefaultTargets: () => [101, 102, -100200],
    })(confirmReq, { signal });

    expect(sendMessage).toHaveBeenCalledTimes(3);
    const pushes = vi.mocked(operatorNotify).mock.calls.map((c) => c[1]);
    expect(pushes).toEqual([
      { target: 101, messageThreadId: 7, replyMarkup: confirmKeyboard },
      { target: -100200, replyMarkup: confirmKeyboard },
    ]);
  });

  it('a primaryChatId outside the configured targets is never contacted', async () => {
    const { bot, sendMessage } = fakeBot();
    await handler({
      bot,
      primaryChatId: 999,
      primaryThreadId: 7,
      resolveDefaultTargets: () => [101],
    })(confirmReq, { signal });

    expect(sendMessage.mock.calls.map((c) => c[0])).toEqual([101]);
    expect(sendMessage.mock.calls[0]?.[2]).not.toHaveProperty('message_thread_id');
  });

  it('without a bot, each target gets its own raw push with buttons', async () => {
    await handler({ resolveDefaultTargets: () => [101, 102] })(confirmReq, { signal });
    expect(vi.mocked(operatorNotify).mock.calls.map((c) => c[1])).toEqual([
      { target: 101, replyMarkup: confirmKeyboard },
      { target: 102, replyMarkup: confirmKeyboard },
    ]);
  });

  it('logs (does not throw) when Telegram is unconfigured or delivery fails; handoff stays pending', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(operatorNotify).mockResolvedValue(null);
    const result = await handler({ resolveDefaultTargets: () => [101] })(confirmReq, { signal });
    expect(result).toEqual({ action: 'decline' });
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('delivery failed'), 1, 1, 'route-task');
    errSpy.mockClear();
    await handler({ resolveDefaultTargets: () => [] })(confirmReq, { signal });
    expect(operatorNotify).toHaveBeenCalledOnce();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('no Telegram target'), 'route-task');
    errSpy.mockRestore();
  });
});
