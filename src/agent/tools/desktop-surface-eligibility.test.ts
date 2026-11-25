/**
 * Tests for surface eligibility checks on desktop tools (Tranche 2).
 *
 * Verifies that desktop tools are refused on headless/remote surfaces
 * (daemon, telegram, subagent) and allowed on interactive surfaces
 * (cli, repl, acp, web, sdk, unknown, undefined).
 *
 * @module agent/tools/desktop-surface-eligibility.test
 */

import { describe, it, expect, vi } from 'vitest';
import {
  checkDesktopSurfaceEligibility,
  desktopSurfaceRefusalMessage,
  DESKTOP_INELIGIBLE_SURFACES,
} from './desktop-surface-eligibility.js';
import { createDesktopScreenshotHandler } from './handlers/desktop-screenshot.js';
import type { DesktopBackend } from '../../desktop/types.js';

// ---------------------------------------------------------------------------
// Unit tests for the eligibility check function
// ---------------------------------------------------------------------------

describe('checkDesktopSurfaceEligibility()', () => {
  it('returns null (eligible) for cli', () => {
    expect(checkDesktopSurfaceEligibility('cli')).toBeNull();
  });

  it('returns null (eligible) for repl', () => {
    expect(checkDesktopSurfaceEligibility('repl')).toBeNull();
  });

  it('returns null (eligible) for acp', () => {
    expect(checkDesktopSurfaceEligibility('acp')).toBeNull();
  });

  it('returns null (eligible) for web', () => {
    expect(checkDesktopSurfaceEligibility('web')).toBeNull();
  });

  it('returns null (eligible) for sdk', () => {
    expect(checkDesktopSurfaceEligibility('sdk')).toBeNull();
  });

  it('returns null (eligible) for unknown surface', () => {
    // unknown = SDK embedder; operator is at the machine
    expect(checkDesktopSurfaceEligibility('unknown')).toBeNull();
  });

  it('returns null (eligible) when surface is undefined', () => {
    // undefined = call site not yet updated; preserve existing behavior
    expect(checkDesktopSurfaceEligibility(undefined)).toBeNull();
  });

  it('returns an error string for daemon surface', () => {
    const result = checkDesktopSurfaceEligibility('daemon');
    expect(result).not.toBeNull();
    expect(result).toContain('daemon');
    expect(result).toContain('desktop_screenshot');
  });

  it('returns an error string for telegram surface', () => {
    const result = checkDesktopSurfaceEligibility('telegram');
    expect(result).not.toBeNull();
    expect(result).toContain('telegram');
    expect(result).toContain('desktop_screenshot');
  });

  it('returns an error string for subagent surface', () => {
    const result = checkDesktopSurfaceEligibility('subagent');
    expect(result).not.toBeNull();
    expect(result).toContain('subagent');
    expect(result).toContain('desktop_screenshot');
  });
});

describe('DESKTOP_INELIGIBLE_SURFACES', () => {
  it('contains daemon, telegram, and subagent', () => {
    expect(DESKTOP_INELIGIBLE_SURFACES.has('daemon')).toBe(true);
    expect(DESKTOP_INELIGIBLE_SURFACES.has('telegram')).toBe(true);
    expect(DESKTOP_INELIGIBLE_SURFACES.has('subagent')).toBe(true);
  });

  it('does not contain cli, repl, acp, web, sdk, unknown', () => {
    for (const s of ['cli', 'repl', 'acp', 'web', 'sdk', 'unknown']) {
      expect(DESKTOP_INELIGIBLE_SURFACES.has(s), `${s} must not be ineligible`).toBe(false);
    }
  });
});

describe('desktopSurfaceRefusalMessage()', () => {
  it('mentions headless for daemon', () => {
    expect(desktopSurfaceRefusalMessage('daemon')).toContain('headless');
  });

  it('mentions server for telegram', () => {
    expect(desktopSurfaceRefusalMessage('telegram')).toContain('server');
  });

  it('produces a non-empty string for any ineligible surface', () => {
    for (const s of DESKTOP_INELIGIBLE_SURFACES) {
      expect(desktopSurfaceRefusalMessage(s).length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: surface check wired into the handler via DesktopHandlerOptions
// ---------------------------------------------------------------------------

function makeBackend(): DesktopBackend {
  return {
    screenshot: vi.fn().mockResolvedValue({
      path: '/fake/path.png',
      bytes: 100,
      width: 100,
      height: 100,
      scaleFactor: 1,
      displayIndex: 0,
      logicalWidth: 100,
      logicalHeight: 100,
      dataBase64: Buffer.alloc(33).toString('base64'),
      mediaType: 'image/png' as const,
    }),
  };
}

describe('createDesktopScreenshotHandler() surface eligibility', () => {
  it('refuses when surface is daemon (even with injected backend)', async () => {
    vi.stubEnv('AFK_SESSION_ID', 'test-surface-daemon');
    const handler = createDesktopScreenshotHandler({
      getBackend: async () => makeBackend(),
      surface: 'daemon',
    });
    const result = await handler({}, new AbortController().signal);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('daemon');
    vi.unstubAllEnvs();
  });

  it('refuses when surface is telegram (even with injected backend)', async () => {
    vi.stubEnv('AFK_SESSION_ID', 'test-surface-telegram');
    const handler = createDesktopScreenshotHandler({
      getBackend: async () => makeBackend(),
      surface: 'telegram',
    });
    const result = await handler({}, new AbortController().signal);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('telegram');
    vi.unstubAllEnvs();
  });

  it('refuses when surface is subagent (belt-and-suspenders; even with injected backend)', async () => {
    vi.stubEnv('AFK_SESSION_ID', 'test-surface-subagent');
    const handler = createDesktopScreenshotHandler({
      getBackend: async () => makeBackend(),
      surface: 'subagent',
    });
    const result = await handler({}, new AbortController().signal);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('subagent');
    vi.unstubAllEnvs();
  });

  it('allows when surface is cli (proceeds to backend)', async () => {
    vi.stubEnv('AFK_SESSION_ID', 'test-surface-cli');
    const backend = makeBackend();
    const handler = createDesktopScreenshotHandler({
      getBackend: async () => backend,
      surface: 'cli',
      hardenDirectory: async (_dir: string, _opts?: { signal?: AbortSignal }) => {},
    });
    const result = await handler({}, new AbortController().signal);
    // Should reach the backend (not refused at surface level)
    expect(result.isError).toBeUndefined();
    expect(vi.mocked(backend.screenshot as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
    vi.unstubAllEnvs();
  });

  it('allows when surface is repl (proceeds to backend)', async () => {
    vi.stubEnv('AFK_SESSION_ID', 'test-surface-repl');
    const backend = makeBackend();
    const handler = createDesktopScreenshotHandler({
      getBackend: async () => backend,
      surface: 'repl',
      hardenDirectory: async (_dir: string, _opts?: { signal?: AbortSignal }) => {},
    });
    const result = await handler({}, new AbortController().signal);
    expect(result.isError).toBeUndefined();
    vi.unstubAllEnvs();
  });

  it('allows when surface is undefined (no surface wired; backward compat)', async () => {
    vi.stubEnv('AFK_SESSION_ID', 'test-surface-undef');
    const backend = makeBackend();
    const handler = createDesktopScreenshotHandler({
      getBackend: async () => backend,
      // surface intentionally omitted
      hardenDirectory: async (_dir: string, _opts?: { signal?: AbortSignal }) => {},
    });
    const result = await handler({}, new AbortController().signal);
    expect(result.isError).toBeUndefined();
    vi.unstubAllEnvs();
  });
});
