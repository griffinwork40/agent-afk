import { describe, expect, it, vi } from 'vitest';
import { coreCommands } from './commands/core.js';
import { infoCommands } from './commands/info.js';
import { createSessionStats } from './session-stats.js';
import { HookBlockedError } from '../../utils/errors.js';
import type { SlashContext } from './types.js';
import type { ProgressEvent } from './interaction.js';

function context() {
  const current = {
    setModel: vi.fn(async () => {}),
    listRewindTargets: vi.fn(() => [
      { turnIndex: 4, preview: 'newest' }, { turnIndex: 0, preview: 'oldest' },
    ]),
    rewindConversation: vi.fn(async () => ({ rewound: true, reloadText: 'oldest' })),
    compact: vi.fn(async () => ({ compacted: true })),
    hookRegistry: undefined as undefined | { dispatch: ReturnType<typeof vi.fn> },
  };
  const ctx: SlashContext = {
    session: { current } as unknown as SlashContext['session'],
    stats: createSessionStats('sonnet'),
    out: { line: vi.fn(), raw: vi.fn(), success: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ui: { repaintStatusLine: vi.fn(), clearScreen: vi.fn() },
    getCompositor: () => { throw new Error('neutral handlers must not access terminal'); },
  };
  return { ctx, current };
}
const model = infoCommands.find((command) => command.name === '/model')!;
const rewind = coreCommands.find((command) => command.name === '/rewind')!;
const compact = coreCommands.find((command) => command.name === '/compact')!;

describe('surface-neutral slash interactions', () => {
  it('bare model uses labeled options/default and applies the returned value', async () => {
    const { ctx, current } = context();
    const choose = vi.fn(async () => 'haiku');
    ctx.choose = choose;
    await model.handler(ctx, '');
    expect(choose).toHaveBeenCalledWith(expect.objectContaining({
      corrId: expect.any(String), title: 'Switch model', default: 'sonnet', cancellable: true,
      options: expect.arrayContaining([expect.objectContaining({ value: 'haiku', label: expect.any(String) })]),
    }));
    expect(current.setModel).toHaveBeenCalledWith('haiku');
    expect(ctx.stats.model).toBe('haiku');
  });

  it.each([null, 'not-an-offered-value'])('model reply %s leaves state intact', async (answer) => {
    const { ctx, current } = context();
    ctx.choose = vi.fn(async () => answer);
    await model.handler(ctx, '');
    expect(current.setModel).not.toHaveBeenCalled();
    expect(ctx.stats.model).toBe('sonnet');
  });

  it('explicit model bypasses choice and retains existing service normalization', async () => {
    const { ctx, current } = context();
    ctx.choose = vi.fn();
    await model.handler(ctx, 'org/Case-ID');
    expect(ctx.choose).not.toHaveBeenCalled();
    expect(current.setModel).toHaveBeenCalledWith('org/case-id');
  });

  it('rewind uses opaque option values and returns the existing prefill contract', async () => {
    const { ctx, current } = context();
    ctx.choose = vi.fn(async () => '1');
    expect(rewind.requires).toEqual(['sessionControl', 'choose']);
    expect(await rewind.handler(ctx, '')).toEqual({ kind: 'prefill', message: 'oldest' });
    expect(ctx.choose).toHaveBeenCalledWith(expect.objectContaining({
      options: [{ value: '0', label: 'newest' }, { value: '1', label: 'oldest' }],
    }));
    expect(current.rewindConversation).toHaveBeenCalledWith(0);
  });

  it.each([null, '0.0', '99'])('rewind reply %s does not mutate', async (answer) => {
    const { ctx, current } = context();
    ctx.choose = vi.fn(async () => answer);
    expect(await rewind.handler(ctx, '')).toBe('continue');
    expect(current.rewindConversation).not.toHaveBeenCalled();
  });

  it('empty rewind does not request choice', async () => {
    const { ctx, current } = context();
    current.listRewindTargets.mockReturnValue([]);
    ctx.choose = vi.fn();
    await rewind.handler(ctx, '');
    expect(ctx.choose).not.toHaveBeenCalled();
  });

  it.each([false, true])('compact progress is paired on provider failure=%s', async (failure) => {
    const { ctx, current } = context();
    if (failure) current.compact.mockRejectedValue(new Error('provider unavailable'));
    const events: ProgressEvent[] = [];
    ctx.progress = (event) => { events.push(event); };
    await compact.handler(ctx, '');
    expect(events.map((event) => event.phase)).toEqual(['start', 'end']);
    expect(events[0]?.corrId).toBe(events[1]?.corrId);
    expect(events[0]?.label).toBe('Summarizing earlier turns...');
    expect(ctx.out.info).not.toHaveBeenCalled();
  });

  it('hook-blocked compact emits no progress', async () => {
    const { ctx, current } = context();
    current.hookRegistry = { dispatch: vi.fn().mockRejectedValue(new HookBlockedError('PreCompact', 'blocked')) };
    ctx.progress = vi.fn();
    await compact.handler(ctx, '');
    expect(ctx.progress).not.toHaveBeenCalled();
    expect(current.compact).not.toHaveBeenCalled();
  });
});
