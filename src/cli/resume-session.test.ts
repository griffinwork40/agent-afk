import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { saveSession } from './session-store.js';
import { resolveResumeTarget, resumeConfigFor } from './resume-session.js';
import { createSessionStats, recordTurn } from './slash/session-stats.js';

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

describe('resume-session', () => {
  it('--resume resolves saved sessions into native id plus transcript history', () => {
    const stats = createSessionStats('sonnet');
    recordTurn(stats, 'hello', 'hi', { sessionId: 'sdk-resume' });
    saveSession(stats, 'friendly');

    const target = resolveResumeTarget({ resume: 'friendly' });
    expect(target?.resumeId).toBe('sdk-resume');
    expect(target?.stored?.model).toBe('sonnet');

    expect(resumeConfigFor(target)).toEqual({
      resume: 'sdk-resume',
      sessionId: 'sdk-resume',
      resumeHistory: [{ user: 'hello', assistant: 'hi' }],
    });
  });

  it('--continue resolves the newest saved session', async () => {
    const older = createSessionStats('sonnet');
    recordTurn(older, 'old', 'old reply', { sessionId: 'sdk-old' });
    saveSession(older, 'old');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newer = createSessionStats('opus');
    recordTurn(newer, 'new', 'new reply', { sessionId: 'sdk-new' });
    saveSession(newer, 'new');

    const target = resolveResumeTarget({ continue: true });
    expect(target?.id).toBe('new');
    expect(target?.resumeId).toBe('sdk-new');
  });

  it('passes unknown --resume values through as native provider ids', () => {
    const target = resolveResumeTarget({ resume: 'raw-provider-session' });
    expect(resumeConfigFor(target)).toEqual({
      resume: 'raw-provider-session',
      sessionId: 'raw-provider-session',
    });
  });

  it('appends tool summaries to assistant text when toolEvents are present', () => {
    const stats = createSessionStats('sonnet');
    recordTurn(
      stats,
      'run a command',
      'done',
      { sessionId: 'sdk-tools' },
      [{ toolName: 'bash', toolUseId: 'tu_1', input: 'echo hi', isError: false }],
    );
    saveSession(stats, 'tools-session');

    const target = resolveResumeTarget({ resume: 'tools-session' });
    const config = resumeConfigFor(target);
    expect(config.resumeHistory?.[0]?.assistant).toBe('done\n[Tools used: bash(echo hi)✓]');
  });

  it('leaves assistant text unchanged when turn has no toolEvents', () => {
    const stats = createSessionStats('sonnet');
    recordTurn(stats, 'hello', 'hi there', { sessionId: 'sdk-notools' });
    saveSession(stats, 'notools-session');

    const target = resolveResumeTarget({ resume: 'notools-session' });
    const config = resumeConfigFor(target);
    expect(config.resumeHistory?.[0]?.assistant).toBe('hi there');
  });

  it('leaves assistant text unchanged when toolEvents is an empty array', () => {
    const stats = createSessionStats('sonnet');
    recordTurn(stats, 'hello', 'hi there', { sessionId: 'sdk-emptytools' }, []);
    saveSession(stats, 'emptytools-session');

    const target = resolveResumeTarget({ resume: 'emptytools-session' });
    const config = resumeConfigFor(target);
    expect(config.resumeHistory?.[0]?.assistant).toBe('hi there');
  });
});
