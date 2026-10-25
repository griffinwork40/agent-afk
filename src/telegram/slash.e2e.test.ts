/**
 * Stage 5 end-to-end: real TelegramBot + real Telegraf middleware chain +
 * real MessageHandler/SessionManager, with only the Telegram API (callApi) and
 * the agent session mocked. No network, no real bot.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context, Telegraf } from 'telegraf';
import { TelegramBot } from './bot.js';
import type { AgentConfig, IAgentSession } from '../agent/types.js';

let session: IAgentSession & Record<string, ReturnType<typeof vi.fn>>;

function makeSession(): typeof session {
  let sid = 'sid-e2e-1';
  return {
    state: 'idle',
    get sessionId() { return sid; },
    reset: vi.fn(async () => { sid = 'sid-e2e-2'; }),
    setModel: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    abort: vi.fn(),
    getSessionMetadata: vi.fn(() => ({ slashCommands: [], skills: ['my-skill'] })),
    waitForInitialization: vi.fn(async () => ({ slashCommands: [], skills: ['my-skill'] })),
  } as unknown as typeof session;
}

function makeBot(): TelegramBot {
  return new TelegramBot({
    botToken: 'tok', apiKey: 'key', verbose: false,
    dataDir: mkdtempSync(join(tmpdir(), 'tg-e2e-')),
    allowedChatIds: new Set([4242]),
    createSession: vi.fn(async (_cfg: AgentConfig) => { session = makeSession(); return session; }),
  });
}

/** Send one text update through the real handler; return the sendMessage texts. */
async function send(bot: TelegramBot, text: string): Promise<Array<{ text: string; parse_mode?: string }>> {
  const inner = (bot as unknown as { bot: Telegraf<Context> }).bot;
  inner.botInfo = {
    id: 1, is_bot: true, first_name: 'T', username: 'afk_bot',
    can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false,
  };
  const api = vi.spyOn(Object.getPrototypeOf(inner.telegram) as object, 'callApi')
    .mockResolvedValue({ message_id: 1 } as never);
  api.mockClear();
  const mh = (bot as unknown as { messageHandler: { handle(c: Context): Promise<void> } }).messageHandler;
  const handled = vi.spyOn(mh, 'handle');
  await inner.handleUpdate({
    update_id: Math.floor(Math.random() * 1e9),
    message: {
      message_id: 1, text, date: 0,
      chat: { id: 4242, type: 'private', first_name: 'T' },
      from: { id: 4242, is_bot: false, first_name: 'T' },
      entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }],
    },
  } as never);
  // The text listener runs detached; wait for the handler's own promise.
  for (const r of handled.mock.results) await r.value;
  handled.mockRestore();
  return api.mock.calls
    .filter(([method]) => method === 'sendMessage')
    .map(([, payload]) => payload as { text: string; parse_mode?: string });
}

describe('Telegram shared slash commands end-to-end', () => {
  let bot: TelegramBot;
  const transcript: string[] = [];
  beforeAll(() => { bot = makeBot(); });

  async function step(input: string): Promise<string> {
    const replies = await send(bot, input);
    const joined = replies.map((r) => r.text).join('\n---\n');
    transcript.push(`>>> ${input}\n${joined}\n`);
    writeFileSync(join(tmpdir(), 'afk-telegram-e2e-transcript.txt'), transcript.join('\n'));
    return joined;
  }

  it('/cost renders the shared session cost as HTML', async () => {
    const html = await step('/cost');
    expect(html).toContain('Session cost');
    expect(html).toContain('total       $0.00');
    expect(html).toContain('This is session-local spend.');
    expect(html).not.toMatch(/\u001b\[/);
  });

  it('/help renders the registry command list with escaped HTML', async () => {
    const html = await step('/help');
    expect(html).toContain('<b>Commands</b>');
    expect(html).toContain('• <code>/clear</code> — Clear conversation history');
    expect(html).toContain('• <code>/cost</code> — Show total and per-turn cost');
  });

  it('/model sonnet switches the live session model', async () => {
    const html = await step('/model sonnet');
    expect(html).toContain('Model switched to sonnet');
    expect(session.setModel).toHaveBeenCalledWith('sonnet');
  });

  it('/name x names the session', async () => {
    const html = await step('/name x');
    expect(html).toContain('Named');
    expect(html).toContain('x');
  });

  it('/clear resets in place', async () => {
    const before = session;
    const html = await step('/clear');
    expect(html).toContain('Conversation history cleared.');
    expect(before.reset).toHaveBeenCalledOnce();
  });

  it('unknown /nope replies with guidance', async () => {
    const html = await step('/nope');
    expect(html).toMatch(/^Unknown command: \/nope\./);
  });

  it('capability-refused /editor replies with its reason', async () => {
    const html = await step('/editor');
    expect(html).toBe('/editor is not available on Telegram: requires terminal interaction; use the REPL or browser-native controls');
  });

  it('Telegram-only /cd is untouched by shared dispatch', async () => {
    const html = await step('/cd');
    expect(html).not.toContain('Unknown command');
    expect(html).toContain('cwd');
  });

  it('a session skill passes through to the agent turn', async () => {
    const mh = (bot as unknown as { messageHandler: Record<string, unknown> }).messageHandler;
    const processOne = vi.spyOn(mh as never, 'processOne' as never).mockResolvedValue(undefined as never);
    const html = await step('/my-skill now');
    expect(html).not.toContain('Unknown command');
    expect(processOne).toHaveBeenCalledWith(expect.objectContaining({ chatId: 4242 }), expect.anything(), '/my-skill now');
    processOne.mockRestore();
  });
});
