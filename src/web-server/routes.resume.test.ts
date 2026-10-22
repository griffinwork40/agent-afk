import { describe, it, expect, vi } from 'vitest';
import type { ServerResponse } from 'node:http';
import { handleResumeSession } from './routes.resume.js';
import type { RouteContext } from './routes.js';

function fakeRes(): { res: ServerResponse; status: () => number; body: () => Record<string, unknown> } {
  let status = 0;
  let raw = '';
  const res = {
    writeHead: (s: number) => { status = s; return res; },
    setHeader: () => res,
    end: (chunk?: string) => { raw = chunk ?? ''; return res; },
  } as unknown as ServerResponse;
  return { res, status: () => status, body: () => (raw ? JSON.parse(raw) as Record<string, unknown> : {}) };
}

const ctxWith = (resumeSession?: RouteContext['resumeSession']): RouteContext =>
  ({ owned: new Set<string>(), resumeSession }) as unknown as RouteContext;

describe('POST /api/sessions/:id/resume', () => {
  it('201 with the new live session id', async () => {
    const resume = vi.fn(async () => ({ kind: 'resumed' as const, id: 'live-2' }));
    const r = fakeRes();
    await handleResumeSession(ctxWith(resume), r.res, 'old-1');
    expect(resume).toHaveBeenCalledWith('old-1');
    expect(r.status()).toBe(201);
    expect(r.body()).toEqual({ session: { id: 'live-2' } });
  });

  it('404 when no saved session matches', async () => {
    const r = fakeRes();
    await handleResumeSession(ctxWith(async () => ({ kind: 'not-found' as const })), r.res, 'nope');
    expect(r.status()).toBe(404);
    expect(r.body()['error']).toBe('unknown_session');
  });

  it('409 when the session is live in another process', async () => {
    const r = fakeRes();
    await handleResumeSession(ctxWith(async () => ({ kind: 'live-elsewhere' as const })), r.res, 'old-1');
    expect(r.status()).toBe(409);
    expect(r.body()['error']).toBe('session_live_elsewhere');
  });

  it('500 resume_failed when starting the session throws', async () => {
    const r = fakeRes();
    await handleResumeSession(ctxWith(async () => { throw new Error('boom'); }), r.res, 'old-1');
    expect(r.status()).toBe(500);
    expect(r.body()).toMatchObject({ error: 'resume_failed', message: 'Failed to resume session.' });
  });

  it('501 on an attach-only server', async () => {
    const r = fakeRes();
    await handleResumeSession(ctxWith(undefined), r.res, 'old-1');
    expect(r.status()).toBe(501);
  });
});
