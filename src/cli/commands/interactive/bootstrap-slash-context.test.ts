import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReplSlashContext } from './bootstrap-slash-context.js';
import { createSessionStats } from '../../slash/session-stats.js';
import { createConsoleWriter } from '../../slash/writer.js';
import { dispatch, register, resetRegistry } from '../../slash/registry.js';
import { FastModeController } from '../../../agent/fast-mode.js';
import { renderSelector } from '../../input/selectors.js';
import type { SlashContext } from '../../slash/types.js';
vi.mock('../../input/selectors.js', () => ({ renderSelector: vi.fn() }));

type ContextArgs = Parameters<typeof createReplSlashContext>[0];
const originalStdinTty = process.stdin.isTTY;
const originalStdoutTty = process.stdout.isTTY;

function setTty(stdin: boolean | undefined, stdout: boolean | undefined) {
  (process.stdin as { isTTY?: boolean }).isTTY = stdin;
  (process.stdout as { isTTY?: boolean }).isTTY = stdout;
}

function makeContext() {
  // Unused owner facilities are opaque here: context creation must not touch
  // the provider, samplers, or terminal until a handler invokes them.
  return createReplSlashContext({
    sessionRef: {},
    stats: createSessionStats('sonnet'),
    writer: createConsoleWriter({ fn: vi.fn() }),
    statusLine: {},
    contextSampler: {},
    gitStatusSampler: {},
    ledger: {},
    mcpManager: undefined,
    fastModeController: new FastModeController(),
  } as unknown as ContextArgs);
}

afterEach(() => {
  setTty(originalStdinTty, originalStdoutTty);
  vi.restoreAllMocks();
  resetRegistry();
});

describe('REPL surface declaration', () => {
  it.each([
    [true, true, true],
    [false, true, false],
    [true, false, false],
    [false, false, false],
    [undefined, undefined, false],
  ])('stdin TTY %s / stdout TTY %s declares tty=%s', (stdin, stdout, tty) => {
    setTty(stdin, stdout);
    const ctx = makeContext();
    expect(ctx.capabilities?.has('tty')).toBe(tty);
    expect(ctx.capabilities?.has('choose')).toBe(tty);
    expect(typeof ctx.choose).toBe(tty ? 'function' : 'undefined');
    expect(typeof ctx.progress).toBe('function');
    expect([...ctx.capabilities!].filter((capability) => capability !== 'tty' && capability !== 'choose').sort()).toEqual([
      'consoleOutput', 'conversationRetry', 'hostCredentials',
      'permissionMode', 'progress', 'sessionControl', 'shellJobs',
    ]);
    expect(ctx.capabilities).not.toBe(makeContext().capabilities);
  });

  it('uses the compositor installed after bootstrap for choices and progress', async () => {
    setTty(true, true);
    const ctx = makeContext();
    const compositor = { suspendInput: vi.fn(), resumeInput: vi.fn(), setSpinner: vi.fn() };
    ctx.getCompositor = () => compositor as unknown as ReturnType<NonNullable<SlashContext['getCompositor']>>;
    vi.mocked(renderSelector).mockResolvedValue(0);
    expect(await ctx.choose?.({ corrId: 'pick', title: 'Pick', options: [{ value: 'v', label: 'Label' }] })).toBe('v');
    expect(compositor.suspendInput).toHaveBeenCalledOnce();
    expect(compositor.resumeInput).toHaveBeenCalledOnce();
    ctx.progress?.({ corrId: 'work', phase: 'start', label: 'Working' });
    ctx.progress?.({ corrId: 'work', phase: 'end', label: 'Done' });
    expect(compositor.setSpinner.mock.calls).toEqual([[{ enabled: true }], [{ enabled: false }]]);
  });

  it('gates terminal commands on non-TTY REPLs while allowing owner commands', async () => {
    setTty(false, false);
    const ctx = makeContext();
    const terminal = vi.fn(async () => 'continue' as const);
    const control = vi.fn(async () => 'continue' as const);
    register({ name: '/editor', summary: 'terminal', handler: terminal });
    register({ name: '/model', summary: 'owner', handler: control });
    await dispatch('/editor', ctx);
    await dispatch('/model', ctx);
    expect(terminal).not.toHaveBeenCalled();
    expect(control).toHaveBeenCalledOnce();
  });
});
