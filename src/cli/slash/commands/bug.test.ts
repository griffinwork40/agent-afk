/**
 * Tests for /bug: the pure URL/body builders and the REPL handler.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { bugCmd, collectBugEnvironment } from './bug.js';
import {
  BUG_REPORT_REPO,
  MAX_BUG_URL_LENGTH,
  buildBugBody,
  buildBugReportLink,
  buildBugTitle,
  type BugEnvironment,
} from './bug.body.js';
import { resetHyperlinksEnabledForTest } from '../../hyperlink.js';
import type { SlashContext, SessionStats } from '../types.js';

const ENV: BugEnvironment = {
  version: '9.9.9',
  nodeVersion: 'v26.0.0',
  os: 'darwin 25.0.0 (arm64)',
  model: 'sonnet',
  sessionId: 'sess-123',
};

function params(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

function makeStats(overrides: Partial<SessionStats> = {}): SessionStats {
  return {
    totalTurns: 0,
    totalCostUsd: 0,
    unpricedTurns: 0,
    totalTokens: 0,
    totalDurationMs: 0,
    sessionStartTime: Date.now(),
    turnCosts: [],
    turnTokens: [],
    turns: [],
    model: 'sonnet',
    permissionMode: 'default',
    ...overrides,
  };
}

function makeCtx(stats: SessionStats): { ctx: SlashContext; lines: string[] } {
  const lines: string[] = [];
  const ctx = {
    session: {} as SlashContext['session'],
    stats,
    out: {
      line: (t = ''): void => { lines.push(t); },
      raw: (t: string): void => { lines.push(t); },
      success: (t: string): void => { lines.push(`SUCCESS:${t}`); },
      info: (t: string): void => { lines.push(`INFO:${t}`); },
      warn: (t: string): void => { lines.push(`WARN:${t}`); },
      error: (t: string): void => { lines.push(`ERROR:${t}`); },
    },
    ui: { clearScreen: vi.fn(), repaintStatusLine: vi.fn() },
  } as unknown as SlashContext;
  return { ctx, lines };
}

describe('bug.body builders', () => {
  it('targets the canonical repo issues/new endpoint', () => {
    const { url } = buildBugReportLink('crash on start', ENV);
    expect(url.startsWith(`https://github.com/${BUG_REPORT_REPO}/issues/new?`)).toBe(true);
  });

  it('only sends title and body params (labels/template would 404 for read-only users)', () => {
    const { url } = buildBugReportLink('crash on start', ENV);
    expect([...params(url).keys()].sort()).toEqual(['body', 'title']);
  });

  it('round-trips title and body through URL encoding', () => {
    const desc = 'REPL hangs after /compact & "quotes" + #hash';
    const { url } = buildBugReportLink(desc, ENV);
    expect(params(url).get('title')).toBe(desc);
    expect(params(url).get('body')).toBe(buildBugBody(desc, ENV));
  });

  it('includes the environment block and mirrors the template sections', () => {
    const body = buildBugBody('boom', ENV);
    for (const s of ['**What happened**', '**Expected behavior**', '**Repro steps**', '**Environment**', '**Logs / trace**']) {
      expect(body).toContain(s);
    }
    expect(body).toContain('version: 9.9.9');
    expect(body).toContain('Node version: v26.0.0');
    expect(body).toContain('OS: darwin 25.0.0 (arm64)');
    expect(body).toContain('Model: sonnet');
    expect(body).toContain('Session id: sess-123');
  });

  it('omits the session id line when unknown and falls back to a placeholder description', () => {
    const body = buildBugBody('', { ...ENV, sessionId: undefined });
    expect(body).not.toContain('Session id');
    expect(body).toContain('_Describe the bug._');
  });

  it('redacts secrets in the description before they reach the URL', () => {
    const key = `sk-ant-${'a'.repeat(40)}`;
    const { url } = buildBugReportLink(`auth failed with ${key}`, ENV);
    const decoded = `${params(url).get('title')}\n${params(url).get('body')}`;
    expect(decoded).not.toContain(key);
    expect(decoded).toContain('[REDACTED]');
  });

  it('uses the first line for the title and clips long titles', () => {
    expect(buildBugTitle('first line\nsecond line')).toBe('first line');
    const t = buildBugTitle('word '.repeat(100));
    expect(t.length).toBeLessThanOrEqual(120);
    expect(t.endsWith('…')).toBe(true);
  });

  it('truncates long descriptions to stay under the URL limit', () => {
    const { url, truncated } = buildBugReportLink('é word '.repeat(5000), ENV);
    expect(truncated).toBe(true);
    expect(url.length).toBeLessThanOrEqual(MAX_BUG_URL_LENGTH);
    expect(params(url).get('body')).toContain('truncated by /bug');
  });

  it('does not truncate short descriptions', () => {
    expect(buildBugReportLink('short', ENV).truncated).toBe(false);
  });

  it('does not leak partial secrets when truncation splits a token', () => {
    // Place a ≥32-char opaque token so truncation would split it if the
    // loop sliced raw (unredacted) text and then redacted the fragment.
    const opaqueToken = 'AAAA' + 'Bx9Kz7Qm4Wp3Ry6Fn8Ls2Jd5Hg0Tv1C'; // 36 chars
    const padding = 'x '.repeat(4000); // force truncation
    const desc = `${padding}secret: ${opaqueToken} end`;
    const { url, truncated } = buildBugReportLink(desc, ENV, 2000);
    expect(truncated).toBe(true);
    const decoded = decodeURIComponent(url);
    // No prefix of the token of length ≥8 should survive in the URL.
    for (let len = 8; len <= opaqueToken.length; len++) {
      expect(decoded).not.toContain(opaqueToken.slice(0, len));
    }
  });
});

describe('/bug handler', () => {
  beforeEach(() => resetHyperlinksEnabledForTest(false));
  afterEach(() => resetHyperlinksEnabledForTest());

  it('is named /bug', () => {
    expect(bugCmd.name).toBe('/bug');
  });

  it('prints a PUBLIC warning and the raw URL, and continues', async () => {
    const { ctx, lines } = makeCtx(makeStats({ sessionId: 'sess-xyz' }));
    const result = await bugCmd.handler(ctx, 'tool lane flickers');
    expect(result).toBe('continue');
    expect(lines.some((l) => l.startsWith('WARN:') && l.includes('PUBLIC'))).toBe(true);
    const urlLine = lines.find((l) => l.startsWith('https://github.com/'));
    expect(urlLine).toBeDefined();
    expect(params(urlLine!).get('title')).toBe('tool lane flickers');
    expect(params(urlLine!).get('body')).toContain('Session id: sess-xyz');
  });

  it('shows a tip when no description is given', async () => {
    const { ctx, lines } = makeCtx(makeStats());
    await bugCmd.handler(ctx, '');
    expect(lines.some((l) => l.includes('/bug <what went wrong>'))).toBe(true);
  });

  it('adds a clickable hyperlink line when the terminal supports it', async () => {
    resetHyperlinksEnabledForTest(true);
    const { ctx, lines } = makeCtx(makeStats());
    await bugCmd.handler(ctx, 'x');
    expect(lines.some((l) => l.startsWith('INFO:') && l.includes('\x1b]8;;https://github.com/'))).toBe(true);
    expect(lines.some((l) => l.startsWith('https://github.com/'))).toBe(true);
  });

  it('collects the environment from the session context', () => {
    const { ctx } = makeCtx(makeStats({ model: 'gpt-6-sol' }));
    const env = collectBugEnvironment(ctx);
    expect(env.model).toBe('gpt-6-sol');
    expect(env.nodeVersion).toBe(process.version);
    expect(env.version.length).toBeGreaterThan(0);
    expect(env.sessionId).toBeUndefined();
  });
});
