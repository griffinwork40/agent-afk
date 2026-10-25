import { describe, it, expect, vi } from 'vitest';
import type { ServerResponse } from 'node:http';
import { createSessionStats } from '../cli/slash/session-stats.js';

vi.mock('./session-owner.slash.js', () => ({ getStats: () => createSessionStats('haiku') }));

const { handleRewind } = await import('./routes.rewind.js');
type Ctx = Parameters<typeof handleRewind>[0];

function fakeRes() {
  let status = 0;
  let raw = '';
  const res = {
    writeHead: (s: number) => { status = s; return res; },
    setHeader: () => res,
    end: (chunk?: string) => { raw = chunk ?? ''; return res; },
  } as unknown as ServerResponse;
  return { res, status: () => status, body: () => (raw ? JSON.parse(raw) as Record<string, unknown> : {}) };
}

function ctxWith(result: unknown) {
  const submitPrompt = vi.fn();
  const executeSessionControl = vi.fn(async (_id: string, _cmd: unknown, sctx: { choose?: (r: unknown) => Promise<string | null> }, args: string) => {
    // The handler's only picker is the target list; it must be answered '0'.
    expect(await sctx.choose?.({})).toBe('0');
    expect(args).toBe('conversation');
    return { result };
  });
  const ctx = {
    owned: new Set(['s1']),
    isBusy: () => false,
    reserveTurn: vi.fn(),
    releaseTurn: vi.fn(),
    getSession: () => ({}),
    executeSessionControl,
    submitPrompt,
  } as unknown as Ctx;
  return { ctx, submitPrompt, executeSessionControl };
}

describe('POST /api/sessions/:id/rewind', () => {
  it('retry is a conversation-only rewind that resends the reloaded prompt without preamble', async () => {
    const { ctx, submitPrompt, executeSessionControl } = ctxWith({ kind: 'prefill', message: '[skill-routing: active]\nhello there' });
    const r = fakeRes();
    await handleRewind(ctx, r.res, 's1', { mode: 'retry' });
    expect(executeSessionControl).toHaveBeenCalledOnce();
    expect(r.status()).toBe(200);
    expect(submitPrompt).toHaveBeenCalledWith('s1', 'hello there');
  });

  it('retry prefers the browser-displayed prompt text over the provider history text', async () => {
    const { ctx, submitPrompt } = ctxWith({ kind: 'prefill', message: '[placeholder-prevent] Prefer running commands yourself.\n\nhello there' });
    const r = fakeRes();
    await handleRewind(ctx, r.res, 's1', { mode: 'retry', text: 'hello there' });
    expect(r.status()).toBe(200);
    expect(submitPrompt).toHaveBeenCalledWith('s1', 'hello there');
  });

  it('edit sends the edited text after a conversation-only rewind', async () => {
    const { ctx, submitPrompt } = ctxWith({ kind: 'prefill', message: 'old' });
    const r = fakeRes();
    await handleRewind(ctx, r.res, 's1', { mode: 'edit', text: ' new text ' });
    expect(r.status()).toBe(200);
    expect(submitPrompt).toHaveBeenCalledWith('s1', 'new text');
  });

  it('a refused rewind never submits (edit would append, retry would duplicate)', async () => {
    const { ctx, submitPrompt } = ctxWith('continue');
    const r = fakeRes();
    await handleRewind(ctx, r.res, 's1', { mode: 'edit', text: 'new' });
    expect(r.status()).toBe(409);
    expect(r.body()['error']).toBe('rewind_failed');
    expect(submitPrompt).not.toHaveBeenCalled();
    expect(ctx.releaseTurn).toHaveBeenCalledWith('s1');
  });

  it('409 while a turn is in flight', async () => {
    const { ctx, submitPrompt } = ctxWith({ kind: 'prefill', message: 'x' });
    (ctx as { isBusy: (id: string) => boolean }).isBusy = () => true;
    const r = fakeRes();
    await handleRewind(ctx, r.res, 's1', { mode: 'retry' });
    expect(r.status()).toBe(409);
    expect(submitPrompt).not.toHaveBeenCalled();
  });
});
