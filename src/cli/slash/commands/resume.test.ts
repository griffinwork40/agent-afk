/**
 * Tests for the /resume slash command — argument-bearing dispatch path.
 *
 * Focus: the C2 same-session guard (PR #355 follow-up). Without this guard,
 * `/resume <current-session-id>` would trigger the full 12-step swap against
 * the live session — cancelling its background jobs, closing it, and
 * rebuilding it from the on-disk snapshot — silently discarding any turn
 * data accumulated since the last autosave.
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
import type { PickerController, TerminalCompositor } from '../../terminal-compositor.js';

class FakeHost {
  controller: PickerController | null = null;
  enterCalls = 0;
  exitCalls = 0;
  /**
   * When true, automatically confirm (press Enter) on every call to
   * `enterPickerMode` beyond the first. Used by tests that exercise the
   * two-phase picker→preview flow: the test drives the session-picker phase
   * manually and lets FakeHost auto-confirm the subsequent resume preview.
   */
  autoConfirmPreview = false;

  enterPickerMode(controller: PickerController): void {
    this.enterCalls += 1;
    this.controller = controller;
    // Auto-confirm the preview phase (any enterPickerMode call after the first).
    if (this.autoConfirmPreview && this.enterCalls > 1) {
      // Use setImmediate so the controller is fully installed before the key fires.
      setImmediate(() => this.press('return'));
    }
  }
  exitPickerMode(): void {
    this.exitCalls += 1;
    this.controller = null;
  }
  repaintPicker(): void {}

  press(name: string): void {
    if (!this.controller) throw new Error('FakeHost: no controller installed');
    this.controller.onKey(undefined, { name, ctrl: false, shift: false });
  }
}

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

describe('/resume interactive picker', () => {
  it('bare /resume opens a picker and resumes the selected session (TTY)', async () => {
    const stats = createSessionStats('sonnet');
    stats.cwd = '/proj/pick';
    recordTurn(stats, 'pick work', 'done', {
      sessionId: 'sdk-pick',
      totalCostUsd: 0.01,
      durationMs: 10,
      usage: { input_tokens: 5, output_tokens: 5 },
    });
    stats.name = 'session-pick';
    saveSession(stats);

    const { ctx, requestResumeSpy } = makeCtx('sdk-live');
    ctx.stats.cwd = '/proj/pick';
    const host = new FakeHost();
    // Auto-confirm the preview Enter so the test only drives the picker phase.
    host.autoConfirmPreview = true;
    ctx.getCompositor = (): TerminalCompositor => host as unknown as TerminalCompositor;

    const p = resumeCmd.handler(ctx, '');
    host.press('return'); // select the first (only) entry in the session picker
    await p;

    // Two enterPickerMode calls: session picker + conversation preview.
    expect(host.enterCalls).toBe(2);
    expect(host.exitCalls).toBe(2);
    expect(requestResumeSpy).toHaveBeenCalledOnce();
  });

  it('cancelling the picker (Esc) resumes nothing', async () => {
    const stats = createSessionStats('sonnet');
    stats.cwd = '/proj/pick2';
    recordTurn(stats, 'pick work', 'done', {
      sessionId: 'sdk-pick2',
      totalCostUsd: 0.01,
      durationMs: 10,
      usage: { input_tokens: 5, output_tokens: 5 },
    });
    stats.name = 'session-pick2';
    saveSession(stats);

    const { ctx, requestResumeSpy } = makeCtx('sdk-live');
    ctx.stats.cwd = '/proj/pick2';
    const host = new FakeHost();
    ctx.getCompositor = (): TerminalCompositor => host as unknown as TerminalCompositor;

    const p = resumeCmd.handler(ctx, '');
    host.press('escape');
    await p;

    expect(requestResumeSpy).not.toHaveBeenCalled();
  });

  it('resumes the highlighted row when two sessions share an identical label', async () => {
    // Two sessions with the same name/model/turns/origin saved in the same
    // minute render an IDENTICAL pickLabel. runPicker returns the selected
    // *label* string; without unique options the label→row mapping (indexOf)
    // resolves both rows to the first match, so selecting row 2 would wrongly
    // resume session 1. The uniquePickLabels disambiguator must keep each row
    // distinct so the highlighted session is the one resumed.
    const save = (sdkId: string): void => {
      const s = createSessionStats('sonnet');
      s.cwd = '/proj/dup';
      recordTurn(s, 'work', 'done', {
        sessionId: sdkId,
        totalCostUsd: 0.01,
        durationMs: 10,
        usage: { input_tokens: 5, output_tokens: 5 },
      });
      s.name = 'dup-name';
      saveSession(s);
    };
    save('sdk-dup-1');
    save('sdk-dup-2');

    const resumeRow = async (downPresses: number): Promise<string | undefined> => {
      let captured: ResolvedResumeTarget | undefined;
      const { ctx } = makeCtx('sdk-live', async (t) => {
        captured = t;
        return { ok: true as const, sessionId: 'new' };
      });
      ctx.stats.cwd = '/proj/dup';
      const host = new FakeHost();
      // Auto-confirm the preview Enter; test drives only the picker phase.
      host.autoConfirmPreview = true;
      ctx.getCompositor = (): TerminalCompositor => host as unknown as TerminalCompositor;
      const p = resumeCmd.handler(ctx, '');
      for (let i = 0; i < downPresses; i++) host.press('down');
      host.press('return');
      await p;
      return captured?.resumeId;
    };

    const row1 = await resumeRow(0);
    const row2 = await resumeRow(1);

    expect(row1).toBeDefined();
    expect(row2).toBeDefined();
    // The collision bug resumed the first match for BOTH rows — distinct rows
    // must resolve to distinct sessions.
    expect(row1).not.toBe(row2);
    expect(['sdk-dup-1', 'sdk-dup-2']).toContain(row1);
    expect(['sdk-dup-1', 'sdk-dup-2']).toContain(row2);
  });

  it('bare /resume on a non-TTY surface lists sessions without resuming', async () => {
    const stats = createSessionStats('sonnet');
    stats.cwd = '/proj/txt';
    recordTurn(stats, 'txt work', 'done', {
      sessionId: 'sdk-txt',
      totalCostUsd: 0.01,
      durationMs: 10,
      usage: { input_tokens: 5, output_tokens: 5 },
    });
    stats.name = 'session-txt';
    saveSession(stats);

    const { ctx, lines, requestResumeSpy } = makeCtx(undefined);
    ctx.stats.cwd = '/proj/txt';
    await resumeCmd.handler(ctx, '');

    expect(lines.join('\n')).toContain('session-txt');
    expect(requestResumeSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Resume view-mode preview integration
// ---------------------------------------------------------------------------

describe('/resume — conversation preview (view-mode)', () => {
  it('shows preview (enters picker mode) before resuming when using explicit ID on TTY', async () => {
    const stats = createSessionStats('sonnet');
    stats.cwd = '/proj/preview';
    recordTurn(stats, 'what is the plan?', 'here is the plan', {
      sessionId: 'sdk-preview',
      totalCostUsd: 0.02,
      durationMs: 20,
      usage: { input_tokens: 10, output_tokens: 20 },
    });
    stats.name = 'session-preview';
    const path = saveSession(stats);
    const sidecarId = path.split('/').pop()!.replace(/\.json$/, '');

    const { ctx, requestResumeSpy } = makeCtx('sdk-live');
    const host = new FakeHost();
    ctx.getCompositor = (): TerminalCompositor => host as unknown as TerminalCompositor;

    // Resume by explicit ID — the only enterPickerMode call is the preview.
    const p = resumeCmd.handler(ctx, sidecarId);
    // Wait one tick for showResumePreview to call enterPickerMode, then confirm.
    await Promise.resolve();
    host.press('return');
    await p;

    // One enterPickerMode for the preview, one exitPickerMode.
    expect(host.enterCalls).toBe(1);
    expect(host.exitCalls).toBe(1);
    expect(requestResumeSpy).toHaveBeenCalledOnce();
  });

  it('cancels resume when user presses Esc on the preview', async () => {
    const stats = createSessionStats('sonnet');
    stats.cwd = '/proj/preview-cancel';
    recordTurn(stats, 'first message', 'first reply', {
      sessionId: 'sdk-preview-cancel',
      totalCostUsd: 0.01,
      durationMs: 10,
      usage: { input_tokens: 5, output_tokens: 5 },
    });
    stats.name = 'session-preview-cancel';
    const path = saveSession(stats);
    const sidecarId = path.split('/').pop()!.replace(/\.json$/, '');

    const { ctx, lines, requestResumeSpy } = makeCtx('sdk-other');
    const host = new FakeHost();
    // Press Esc on the preview (first and only enterPickerMode call here is the preview).
    host.autoConfirmPreview = false;
    ctx.getCompositor = (): TerminalCompositor => host as unknown as TerminalCompositor;

    // Start the resume with an explicit ID — the preview will enterPickerMode.
    const p = resumeCmd.handler(ctx, sidecarId);
    // Wait one tick for the preview enterPickerMode to fire, then press Esc.
    await Promise.resolve();
    host.press('escape');
    await p;

    // requestResume must NOT have been called (user cancelled at the preview).
    expect(requestResumeSpy).not.toHaveBeenCalled();
    // A cancellation message should appear.
    expect(lines.join('\n').toLowerCase()).toMatch(/cancel/);
  });

  it('skips preview on non-TTY surface (no compositor)', async () => {
    const stats = createSessionStats('sonnet');
    stats.cwd = '/proj/no-tty';
    recordTurn(stats, 'hello', 'world', {
      sessionId: 'sdk-no-tty',
      totalCostUsd: 0.01,
      durationMs: 10,
      usage: { input_tokens: 5, output_tokens: 5 },
    });
    stats.name = 'session-no-tty';
    const path = saveSession(stats);
    const sidecarId = path.split('/').pop()!.replace(/\.json$/, '');

    // No getCompositor → non-TTY surface. requestResume IS present.
    const { ctx, requestResumeSpy } = makeCtx('sdk-other-live');
    // Explicitly omit getCompositor (ctx has requestResume but no compositor).

    await resumeCmd.handler(ctx, sidecarId);

    // Should proceed directly to resume without a preview gate.
    expect(requestResumeSpy).toHaveBeenCalledOnce();
  });

  it('preview Enter flow: renders conversation content in preview rows', async () => {
    const stats = createSessionStats('sonnet');
    stats.cwd = '/proj/content-check';
    recordTurn(stats, 'user message in preview', 'assistant reply in preview', {
      sessionId: 'sdk-content',
      totalCostUsd: 0.01,
      durationMs: 10,
      usage: { input_tokens: 5, output_tokens: 5 },
    });
    stats.name = 'session-content';
    const path = saveSession(stats);
    const sidecarId = path.split('/').pop()!.replace(/\.json$/, '');

    const { ctx, requestResumeSpy } = makeCtx('sdk-live-content');
    let capturedRows: readonly string[] = [];
    const host = new FakeHost();
    // Intercept enterPickerMode to capture the rendered preview rows, then confirm.
    host.enterPickerMode = (controller: PickerController): void => {
      host.enterCalls += 1;
      host.controller = controller;
      capturedRows = controller.renderRows();
      // Confirm (Enter) asynchronously so the promise can resolve.
      setImmediate(() => host.press('return'));
    };
    ctx.getCompositor = (): TerminalCompositor => host as unknown as TerminalCompositor;

    await resumeCmd.handler(ctx, sidecarId);

    expect(requestResumeSpy).toHaveBeenCalledOnce();
    // The preview rows should contain the stored conversation content.
    const flat = capturedRows.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
    expect(flat).toContain('user message in preview');
    expect(flat).toContain('assistant reply in preview');
    expect(flat).toContain('Enter');
    expect(flat).toContain('Esc');
  });
});
