import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Telegraf } from 'telegraf';
import { makeTaskCompleteHandler } from './daemon.action.js';
import { resolveNotifyChatTarget } from './daemon.js';
import { elicitationRouter } from '../../agent/elicitation-router.js';
import type { AgentSession } from '../../agent/session/agent-session.js';
import type { ElicitationRequest } from '../../agent/types/sdk-types.js';
import { askQuestionHandler } from '../../agent/tools/handlers/ask-question.js';
import { readHandoff } from '../../agent/daemon/handoff-store.js';
import { CronScheduler, type SchedulerOptions } from '../../agent/daemon/scheduler.js';
import { getHandoffsDir } from '../../paths.js';
import { operatorNotify } from '../../agent/operator-notify.js';

vi.mock('node-cron', () => ({
  schedule: () => ({ start() {}, stop() {}, destroy() {}, getStatus: () => 'stopped' }),
}));

vi.mock('../../agent/default-hook-registry.js', () => ({
  createDefaultHookRegistry: () => ({ registry: undefined, memoryStore: { close() {} } }),
}));

vi.mock('../../telegram/notify-routing.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../telegram/notify-routing.js')>(),
  loadChatAliases: () => ({ ops: -100200, rogue: -100999 }),
}));

const telegramFileConfig = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('../config.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../config.js')>(),
  loadTelegramConfig: () => telegramFileConfig.current,
}));

vi.mock('../../agent/operator-notify.js', async (importOriginal) => {
  const { operatorNotify: notify } = await importOriginal<typeof import('../../agent/operator-notify.js')>();
  return { operatorNotify: vi.fn(notify) };
});

const fetchStub = vi.fn<typeof fetch>();
const confirm: ElicitationRequest = { message: 'Continue with this task?', type: 'confirm' };
const choice: ElicitationRequest = { message: 'Which plan?', type: 'choice', choices: ['A', 'B'] };
const confirmKeyboard = [[
  { text: 'Yes', callback_data: 'afk:h:1:question-task' },
  { text: 'No', callback_data: 'afk:h:0:question-task' },
]];
const choiceKeyboard = [
  [{ text: 'A', callback_data: 'afk:h:0:question-task' }],
  [{ text: 'B', callback_data: 'afk:h:1:question-task' }],
];

beforeEach(() => {
  vi.stubEnv('TELEGRAM_BOT_TOKEN', 'fixture-token');
  vi.stubEnv('AFK_TELEGRAM_ALLOWED_CHAT_IDS', '101,102,-100200');
  vi.stubEnv('AFK_ALLOW_PROJECT_MCP', '0');
  vi.mocked(operatorNotify).mockClear();
  telegramFileConfig.current = {};
  fetchStub.mockReset().mockImplementation(async () => new Response('{}'));
  vi.stubGlobal('fetch', fetchStub);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function telegramMessages(): Record<string, unknown>[] {
  return fetchStub.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
}

async function runTask(
  request: ElicitationRequest | undefined,
  notifyOn: 'always' | 'failure' | 'never',
  notifyChat?: string,
  bot?: Telegraf,
  recover = false,
  command = 'run task',
) {
  const install = vi.spyOn(elicitationRouter, 'installForSession');
  const onTaskComplete = vi.fn(makeTaskCompleteHandler(false));
  const sessionFactory: SchedulerOptions['sessionFactory'] = () => ({
    sendMessage: async () => {
      if (request) {
        const sessionKey = install.mock.lastCall?.[0];
        if (!sessionKey) throw new Error('Expected a per-session question handler');
        await askQuestionHandler({ ...request, question: request.message }, new AbortController().signal, { sessionId: sessionKey });
      }
      return { role: 'assistant', content: 'finished the turn', timestamp: new Date() };
    },
    close: async () => {},
  } as unknown as AgentSession);
  const scheduler = new CronScheduler({
    handoffsDir: getHandoffsDir(),
    budgetGate: async () => ({ skip: false }),
    sessionFactory,
    resolveNotifyChat: resolveNotifyChatTarget,
    onTaskComplete,
    ...(bot !== undefined ? { bot, primaryChatId: 101, primaryThreadId: 12 } : {}),
  });
  try {
    scheduler.register({
      taskId: 'question-task', command, trigger: 'cron', cronExpression: '0 * * * *', notifyOn,
      ...(notifyChat !== undefined ? { notifyChat } : {}),
    });
    const record = await scheduler.tick('question-task');
    await onTaskComplete.mock.results[0]?.value;
    if (recover) {
      fetchStub.mockClear();
      scheduler.startHandoffMaintenance();
    }
    return { record, onTaskComplete };
  } finally {
    await scheduler.stop();
  }
}

function expectQuestion(request: ElicitationRequest, chatId: number, keyboard?: unknown): void {
  const messages = telegramMessages();
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ chat_id: chatId, text: expect.stringContaining(request.message) });
  if (keyboard !== undefined) expect(messages[0]?.['reply_markup']).toEqual({ inline_keyboard: keyboard });
  else expect(messages[0]).not.toHaveProperty('reply_markup');
}

describe('cron question Telegram delivery', () => {
  it.each([[confirm, confirmKeyboard], [choice, choiceKeyboard]])(
    'sends a $type question with answer buttons under failure policy',
    async (request, keyboard) => {
      const { record } = await runTask(request, 'failure');
      expect(record?.status).toBe('success');
      await vi.waitFor(() => expectQuestion(request, 101, keyboard));
    },
  );

  it.each([false, true])('keeps a never question silent (Telegraf injected: %s)', async (coHosted) => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 42 });
    const bot = { telegram: { sendMessage } } as unknown as Telegraf;
    const { onTaskComplete } = await runTask(confirm, 'never', undefined, coHosted ? bot : undefined);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(onTaskComplete).not.toHaveBeenCalled();
    expect(fetchStub).not.toHaveBeenCalled();
    expect(await readHandoff('question-task')).toMatchObject({ status: 'pending' });
  });

  it.each(['text', 'number'] as const)('sends a %s question without buttons', async (type) => {
    const request = { message: 'What value should I use?', type };
    await runTask(request, 'failure');
    await vi.waitFor(() => expectQuestion(request, 101));
  });

  it('keeps an ordinary success silent under failure policy', async () => {
    const { record, onTaskComplete } = await runTask(undefined, 'failure');
    expect(record?.status).toBe('success');
    expect(onTaskComplete).not.toHaveBeenCalled();
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('sends only the question to the allowlisted notifyChat alias under always', async () => {
    await runTask(choice, 'always', 'ops');
    await vi.waitFor(() => expectQuestion(choice, -100200, choiceKeyboard));
  });

  it('falls back to default routing for an unallowlisted notifyChat alias', async () => {
    await runTask(confirm, 'always', 'rogue');
    await vi.waitFor(() => expectQuestion(confirm, 101, confirmKeyboard));
  });

  it('does not let a long command turn one question into multiple messages', async () => {
    const request = { ...confirm, message: 'Need one answer' };
    await runTask(request, 'always', undefined, undefined, false, 'Long command '.repeat(500));
    await vi.waitFor(() => expectQuestion(request, 101, confirmKeyboard));
  });

  it('does not send a completion message after a successful Telegraf send', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 42 });
    const bot = { telegram: { sendMessage } } as unknown as Telegraf;
    const { onTaskComplete } = await runTask(confirm, 'always', undefined, bot);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(101, expect.stringContaining(confirm.message),
      expect.objectContaining({ message_thread_id: 12 }));
    expect(onTaskComplete).not.toHaveBeenCalled();
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('falls back to raw push if the injected Telegraf send fails', async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error('send failed'));
    const bot = { telegram: { sendMessage } } as unknown as Telegraf;
    await runTask(confirm, 'failure', 'ops', bot);
    expect(sendMessage).toHaveBeenCalledOnce();
    await vi.waitFor(() => expectQuestion(confirm, -100200, confirmKeyboard));
    expect(telegramMessages()[0]).not.toHaveProperty('message_thread_id');
  });

  it('co-hosted broadcast: each configured target gets the button question once; thread only on primary', async () => {
    vi.stubEnv('AFK_TELEGRAM_NOTIFY_MODE', 'broadcast');
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 42 });
    const bot = { telegram: { sendMessage } } as unknown as Telegraf;
    const { onTaskComplete } = await runTask(confirm, 'always', undefined, bot);
    expect(sendMessage.mock.calls.map((c) => c[0])).toEqual([101, 102, -100200]);
    for (const [chatId, , extra] of sendMessage.mock.calls as Array<[number, string, Record<string, unknown>]>) {
      expect(extra['reply_markup']).toMatchObject({ inline_keyboard: confirmKeyboard });
      if (chatId === 101) expect(extra['message_thread_id']).toBe(12);
      else expect(extra).not.toHaveProperty('message_thread_id');
    }
    expect(onTaskComplete).not.toHaveBeenCalled();
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('co-hosted broadcast: a failed bot send falls back to raw push with buttons for that target only', async () => {
    vi.stubEnv('AFK_TELEGRAM_NOTIFY_MODE', 'broadcast');
    const sendMessage = vi.fn(async (chatId: number, _text: string, _extra?: unknown) => {
      if (chatId === 102) throw new Error('send failed');
      return { message_id: 42 };
    });
    const bot = { telegram: { sendMessage } } as unknown as Telegraf;
    await runTask(choice, 'failure', undefined, bot);
    expect(sendMessage).toHaveBeenCalledTimes(3);
    await vi.waitFor(() => expectQuestion(choice, 102, choiceKeyboard));
    expect(telegramMessages()[0]).not.toHaveProperty('message_thread_id');
  });

  it('custom mode without a bot: one raw push with buttons per custom target', async () => {
    telegramFileConfig.current = { notify: { mode: 'custom', targets: [102, -100300, 102] } };
    await runTask(confirm, 'failure');
    await vi.waitFor(() => expect(telegramMessages()).toHaveLength(2));
    expect(telegramMessages().map((m) => m['chat_id'])).toEqual([102, -100300]);
    for (const m of telegramMessages()) expect(m['reply_markup']).toEqual({ inline_keyboard: confirmKeyboard });
  });

  it('co-hosted broadcast + allowlisted notifyChat: only the override chat is asked', async () => {
    vi.stubEnv('AFK_TELEGRAM_NOTIFY_MODE', 'broadcast');
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 42 });
    const bot = { telegram: { sendMessage } } as unknown as Telegraf;
    await runTask(confirm, 'always', 'ops', bot);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(-100200, expect.stringContaining(confirm.message),
      expect.not.objectContaining({ message_thread_id: expect.anything() }));
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('re-notifies a pending question at startup to its allowlisted notifyChat', async () => {
    await runTask(choice, 'failure', 'ops', undefined, true);
    await vi.waitFor(() => expectQuestion(choice, -100200, choiceKeyboard));
  });

  it('does not re-notify a pending never question at startup', async () => {
    await runTask(confirm, 'never', undefined, undefined, true);
    expect(operatorNotify).not.toHaveBeenCalled();
    expect(fetchStub).not.toHaveBeenCalled();
    expect(await readHandoff('question-task')).toMatchObject({ status: 'pending' });
  });
});
