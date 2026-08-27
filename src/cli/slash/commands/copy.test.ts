import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../clipboard.js', () => ({
  copyToClipboard: vi.fn(),
}));

vi.mock('../../code-block-register.js', () => ({
  getCodeBlock: vi.fn(),
  getCodeBlocks: vi.fn(),
}));

import { copyCmd } from './copy.js';
import { copyToClipboard } from '../../clipboard.js';
import { getCodeBlock, getCodeBlocks } from '../../code-block-register.js';
import type { SlashContext, SessionStats } from '../types.js';

const mockedCopy = vi.mocked(copyToClipboard);
const mockedGetBlock = vi.mocked(getCodeBlock);
const mockedGetBlocks = vi.mocked(getCodeBlocks);

let origIsTTY: boolean | undefined;

function makeStats(assistant?: string): SessionStats {
  const turns = assistant
    ? [{ user: 'hi', assistant, timestamp: Date.now() }]
    : [];
  return {
    totalTurns: turns.length,
    totalCostUsd: 0,
    unpricedTurns: 0,
    totalTokens: 0,
    totalDurationMs: 0,
    sessionStartTime: Date.now(),
    turnCosts: [],
    turnTokens: [],
    turns: turns as unknown as SessionStats['turns'],
    model: 'sonnet',
    permissionMode: 'default',
  } as unknown as SessionStats;
}

interface CtxResult {
  ctx: SlashContext;
  lines: string[];
}

function makeCtx(opts: { assistant?: string; interactive?: boolean } = {}): CtxResult {
  const lines: string[] = [];
  const ctx = {
    session: { current: {} },
    stats: makeStats(opts.assistant),
    out: {
      line: (t = ''): void => { lines.push(`LINE:${t}`); },
      raw: (t: string): void => { lines.push(`RAW:${t}`); },
      success: (t: string): void => { lines.push(`SUCCESS:${t}`); },
      info: (t: string): void => { lines.push(`INFO:${t}`); },
      warn: (t: string): void => { lines.push(`WARN:${t}`); },
      error: (t: string): void => { lines.push(`ERROR:${t}`); },
    },
    ui: { clearScreen: vi.fn(), repaintStatusLine: vi.fn() },
    // requestResume present = interactive REPL surface
    ...(opts.interactive !== false ? { requestResume: vi.fn() } : {}),
  } as unknown as SlashContext;
  return { ctx, lines };
}

beforeEach(() => {
  vi.clearAllMocks();
  origIsTTY = process.stdout.isTTY;
  (process.stdout as { isTTY?: boolean }).isTTY = true;
});

afterEach(() => {
  (process.stdout as { isTTY?: boolean }).isTTY = origIsTTY;
});

describe('/copy slash command', () => {
  it('returns continue and warns when no turns exist', async () => {
    const { ctx, lines } = makeCtx({ assistant: undefined });
    const result = await copyCmd.handler(ctx, '');
    expect(result).toBe('continue');
    expect(lines.some((l) => l.includes('Nothing to copy'))).toBe(true);
  });

  it('returns continue and warns on non-interactive surface', async () => {
    const { ctx, lines } = makeCtx({ assistant: 'hello world', interactive: false });
    const result = await copyCmd.handler(ctx, '');
    expect(result).toBe('continue');
    expect(lines.some((l) => l.includes('Clipboard not available'))).toBe(true);
    expect(mockedCopy).not.toHaveBeenCalled();
  });

  it('returns continue and warns when stdout is not a TTY', async () => {
    (process.stdout as { isTTY?: boolean }).isTTY = false;
    const { ctx, lines } = makeCtx({ assistant: 'hello world' });
    const result = await copyCmd.handler(ctx, '');
    expect(result).toBe('continue');
    expect(lines.some((l) => l.includes('Clipboard not available'))).toBe(true);
    expect(mockedCopy).not.toHaveBeenCalled();
  });

  it('copies the last assistant response with no args', async () => {
    const text = '# Hello\n\nSome markdown response';
    mockedCopy.mockReturnValue(true);
    const { ctx, lines } = makeCtx({ assistant: text });
    const result = await copyCmd.handler(ctx, '');
    expect(result).toBe('continue');
    expect(mockedCopy).toHaveBeenCalledWith(text);
    expect(lines.some((l) => l.startsWith('SUCCESS:') && l.includes('Copied last response'))).toBe(true);
  });

  it('shows fallback message when clipboard write fails', async () => {
    mockedCopy.mockReturnValue(false);
    const { ctx, lines } = makeCtx({ assistant: 'some text' });
    const result = await copyCmd.handler(ctx, '');
    expect(result).toBe('continue');
    expect(lines.some((l) => l.includes('Clipboard write failed'))).toBe(true);
  });

  it('copies a specific code block by index', async () => {
    mockedGetBlock.mockReturnValue({ index: 2, type: 'code_block', lang: 'python', text: 'print("hello")' });
    mockedCopy.mockReturnValue(true);
    const { ctx, lines } = makeCtx({ assistant: 'Here is code:\n```python\nprint("hello")\n```' });
    const result = await copyCmd.handler(ctx, '2');
    expect(result).toBe('continue');
    expect(mockedGetBlock).toHaveBeenCalledWith(2);
    expect(mockedCopy).toHaveBeenCalledWith('print("hello")');
    expect(lines.some((l) => l.startsWith('SUCCESS:') && l.includes('block 2'))).toBe(true);
  });

  it('warns when block index is out of range', async () => {
    mockedGetBlock.mockReturnValue(undefined);
    mockedGetBlocks.mockReturnValue([
      { index: 1, type: 'code_block', lang: 'bash', text: 'echo hi' },
    ]);
    const { ctx, lines } = makeCtx({ assistant: 'some response' });
    const result = await copyCmd.handler(ctx, '5');
    expect(result).toBe('continue');
    expect(lines.some((l) => l.includes('Block 5 not found') && l.includes('1 code block'))).toBe(true);
  });

  it('warns when no code blocks exist and a block index is requested', async () => {
    mockedGetBlock.mockReturnValue(undefined);
    mockedGetBlocks.mockReturnValue([]);
    const { ctx, lines } = makeCtx({ assistant: 'just prose' });
    const result = await copyCmd.handler(ctx, '1');
    expect(result).toBe('continue');
    expect(lines.some((l) => l.includes('No code blocks'))).toBe(true);
  });

  it('warns on unrecognized non-numeric argument', async () => {
    const { ctx, lines } = makeCtx({ assistant: 'hello' });
    const result = await copyCmd.handler(ctx, 'banana');
    expect(result).toBe('continue');
    expect(lines.some((l) => l.includes('Unknown argument'))).toBe(true);
  });
});
