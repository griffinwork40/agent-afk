/**
 * Tests for the /resume slash command — argument-bearing dispatch path.
 *
 * Focus: the C2 same-session guard (PR #355 follow-up). Without this guard,
 * `/resume <current-session-id>` would trigger the full 12-step swap against
 * the live session — cancelling its background jobs, closing it, and
 * rebuilding it from the on-disk snapshot — silently discarding any turn
 * data accumulated since the last /save.
 *
 * The guard runs BEFORE ctx.requestResume is invoked. We verify both the
 * SDK-id match path and the sidecar-id match path block the swap.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resumeCmd } from './resume.js';
import { saveSession } from '../../session-store.js';
import { createSessionStats, recordTurn } from '../session-stats.js';
import type { SlashContext, SessionStats } from '../types.js';
import type { ResolvedResumeTarget } from '../../resume-session.js';
import type { ResumeSwapResult } from '../../commands/interactive/shared.js';

let tmpHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env['HOME'];
  tmpHome = join(tmpdir(), `afk-resume-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  process.env['HOME'] = tmpHome;
});

afterEach(() => {
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
  if (originalHome !== undefined) process.env['HOME'] = originalHome;
});

function makeStats(): SessionStats {
  return {
    totalTurns: 0,
    totalCostUsd: 0,
    totalTokens: 0,
    totalDurationMs: 0,
    sessionStartTime: Date.now(),
    turnCosts: [],
    turnTokens: [],
    turns: [],
    model: 'sonnet',
    permissionMode: 'default',
  };
}

function makeCtx(
  currentSdkId: string | undefined,
  requestResume?: (target: ResolvedResumeTarget) => Promise<ResumeSwapResult>,
): { ctx: SlashContext; lines: string[]; requestResumeSpy: ReturnType<typeof vi.fn> | undefined } {
  const lines: string[] = [];
  const requestResumeSpy = requestResume ? vi.fn(requestResume) : vi.fn(async () => ({ ok: true as const, sessionId: 'new-sdk-id' }));
  const ctx: SlashContext = {
    session: {
      current: { sessionId: currentSdkId } as unknown as SlashContext['session']['current'],
    } as SlashContext['session'],
    stats: makeStats(),
    out: {
      line: (t = ''): void => { lines.push(t); },
      raw: (t): void => { lines.push(t); },
      success: (t): void => { lines.push(`SUCCESS:${t}`); },
      info: (t): void => { lines.push(`INFO:${t}`); },
      warn: (t): void => { lines.push(`WARN:${t}`); },
      error: (t): void => { lines.push(`ERROR:${t}`); },
    },
    ui: { clearScreen: vi.fn(), repaintStatusLine: vi.fn() },
    requestResume: requestResumeSpy,
  } as unknown as SlashContext;
  return { ctx, lines, requestResumeSpy };
}

describe('/resume — C2 same-session guard', () => {
  it('refuses to resume when target SDK id matches the current session id', async () => {
    // Persist a session with a known SDK id, then point the live session at
    // the same SDK id. The guard must intercept before requestResume fires.
    const stats = createSessionStats('sonnet');
    recordTurn(stats, 'a', 'b', { totalCostUsd: 0.01, durationMs: 10, usage: { input_tokens: 5, output_tokens: 5 }, sessionId: 'sdk-live-id' });
    const path = saveSession(stats);
    const sidecarId = path.split('/').pop()!.replace(/\.json$/, '');

    const { ctx, lines, requestResumeSpy } = makeCtx('sdk-live-id');
    const result = await resumeCmd.handler(ctx, sidecarId);

    expect(result).toBe('continue');
    expect(requestResumeSpy).not.toHaveBeenCalled();
    expect(lines.some((l) => /WARN:.*Already on session/i.test(l))).toBe(true);
  });

  it('refuses to resume when the user passes the SDK id of the live session', async () => {
    // Looking up by SDK id (not sidecar id) — findSession resolves it; the
    // guard then compares ctx.session.current.sessionId to found.data.sessionId.
    const stats = createSessionStats('sonnet');
    recordTurn(stats, 'a', 'b', { totalCostUsd: 0.01, durationMs: 10, usage: { input_tokens: 5, output_tokens: 5 }, sessionId: 'sdk-target' });
    saveSession(stats);

    const { ctx, lines, requestResumeSpy } = makeCtx('sdk-target');
    const result = await resumeCmd.handler(ctx, 'sdk-target');

    expect(result).toBe('continue');
    expect(requestResumeSpy).not.toHaveBeenCalled();
    expect(lines.some((l) => /WARN:.*Already on session/i.test(l))).toBe(true);
  });

  it('proceeds with the swap when target is a different session', async () => {
    const stats = createSessionStats('sonnet');
    recordTurn(stats, 'a', 'b', { totalCostUsd: 0.01, durationMs: 10, usage: { input_tokens: 5, output_tokens: 5 }, sessionId: 'sdk-other-id' });
    const path = saveSession(stats);
    const sidecarId = path.split('/').pop()!.replace(/\.json$/, '');

    const { ctx, requestResumeSpy } = makeCtx('sdk-live-id');
    const result = await resumeCmd.handler(ctx, sidecarId);

    expect(result).toBe('continue');
    expect(requestResumeSpy).toHaveBeenCalledOnce();
  });

  it('warns and returns when target session does not exist', async () => {
    const { ctx, lines, requestResumeSpy } = makeCtx('sdk-live-id');
    const result = await resumeCmd.handler(ctx, 'nonexistent-id');
    expect(result).toBe('continue');
    expect(requestResumeSpy).not.toHaveBeenCalled();
    expect(lines.some((l) => /WARN:.*No saved session/i.test(l))).toBe(true);
  });
});

describe('/resume — no-arg CWD filtering', () => {
  it('shows only sessions matching ctx.stats.cwd', async () => {
    // Save two sessions in different directories.
    const statsA = createSessionStats('sonnet');
    statsA.cwd = '/proj/foo';
    recordTurn(statsA, 'foo work', 'done', { sessionId: 'sdk-cwd-a', totalCostUsd: 0.01, durationMs: 10, usage: { input_tokens: 5, output_tokens: 5 } });
    statsA.name = 'session-foo';
    saveSession(statsA);

    const statsB = createSessionStats('sonnet');
    statsB.cwd = '/proj/bar';
    recordTurn(statsB, 'bar work', 'done', { sessionId: 'sdk-cwd-b', totalCostUsd: 0.01, durationMs: 10, usage: { input_tokens: 5, output_tokens: 5 } });
    statsB.name = 'session-bar';
    saveSession(statsB);

    const { ctx, lines } = makeCtx(undefined);
    ctx.stats.cwd = '/proj/foo';
    await resumeCmd.handler(ctx, '');

    const allText = lines.join('\n');
    expect(allText).toContain('session-foo');
    expect(allText).not.toContain('session-bar');
  });

  it('falls back to global list with distinct header when no local sessions', async () => {
    const statsB = createSessionStats('sonnet');
    statsB.cwd = '/proj/bar';
    recordTurn(statsB, 'bar work', 'done', { sessionId: 'sdk-fallback', totalCostUsd: 0.01, durationMs: 10, usage: { input_tokens: 5, output_tokens: 5 } });
    statsB.name = 'session-bar-only';
    saveSession(statsB);

    const { ctx, lines } = makeCtx(undefined);
    ctx.stats.cwd = '/proj/unrelated';
    await resumeCmd.handler(ctx, '');

    const allText = lines.join('\n');
    expect(allText).toMatch(/Saved sessions — all \(none in this directory\)/);
    expect(allText).toContain('session-bar-only');
  });

  it('explicit target path ignores cwd entirely', async () => {
    const statsC = createSessionStats('sonnet');
    statsC.cwd = '/proj/bar';
    recordTurn(statsC, 'some work', 'done', { sessionId: 'sdk-explicit', totalCostUsd: 0.01, durationMs: 10, usage: { input_tokens: 5, output_tokens: 5 } });
    const path = saveSession(statsC);
    const sidecarId = path.split('/').pop()!.replace(/\.json$/, '');

    const { ctx, requestResumeSpy } = makeCtx('sdk-other');
    ctx.stats.cwd = '/proj/other';
    await resumeCmd.handler(ctx, sidecarId);

    expect(requestResumeSpy).toHaveBeenCalledOnce();
  });
});
