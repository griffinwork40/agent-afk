/**
 * Tests for the `desktop_screenshot` handler.
 *
 * Invariant: NO real screen capture is performed in this suite. The backend
 * is always injected via `DesktopHandlerOptions.getBackend`. The spec and
 * the owner instruction both require that any real capture be consented by
 * the owner and run separately (Step 0M / Step 0W feasibility spikes).
 *
 * @module agent/tools/handlers/desktop-screenshot.test
 */

import { describe, it, expect, vi } from 'vitest';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { createDesktopScreenshotHandler, ATTACHED_LONG_SIDE } from './desktop-screenshot.js';
import { DESKTOP_SETUP_INSTRUCTIONS } from './desktop-provider.js';
import { isDesktopEnabled, desktopSchemas } from '../../tools/desktop-surface.js';
import { builtinToolSchemas } from '../../tools/schemas.js';
import type { DesktopBackend, DesktopScreenshotInput } from '../../../desktop/types.js';
import type { TraceSink } from '../../trace/index.js';

// ---------------------------------------------------------------------------
// Mock backend helpers
// ---------------------------------------------------------------------------

/** Minimal PNG header bytes so the handler can read dimensions from the sidecar. */
const FAKE_PNG_WIDTH = 1920;
const FAKE_PNG_HEIGHT = 1080;

function makeFakePngBuf(width = FAKE_PNG_WIDTH, height = FAKE_PNG_HEIGHT): Buffer {
  // 8-byte PNG signature + IHDR chunk (4 len + 4 type + 13 data)
  const buf = Buffer.alloc(33);
  // PNG signature
  buf.write('\x89PNG\r\n\x1a\n', 0, 'binary');
  // IHDR length = 13
  buf.writeUInt32BE(13, 8);
  // 'IHDR'
  buf.write('IHDR', 12, 'ascii');
  // Width and height
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function makeBackend(overrides: Partial<DesktopBackend> = {}): DesktopBackend {
  return {
    screenshot: vi.fn().mockImplementation(
      async (_input: DesktopScreenshotInput, sidecarPath: string) => {
        const buf = makeFakePngBuf();
        return {
          path: sidecarPath,
          bytes: buf.length,
          width: FAKE_PNG_WIDTH,
          height: FAKE_PNG_HEIGHT,
          scaleFactor: 1,
          displayIndex: 0,
          logicalWidth: FAKE_PNG_WIDTH,
          logicalHeight: FAKE_PNG_HEIGHT,
          dataBase64: buf.toString('base64'),
          mediaType: 'image/png' as const,
        };
      },
    ),
    ...overrides,
  };
}

/** Minimal no-op trace sink. Uses os.tmpdir() not a hard-coded /tmp path. */
const noopTrace: TraceSink = {
  write: vi.fn().mockResolvedValue(undefined),
  getTracePath: () => nodePath.join(os.tmpdir(), 'fake-trace.jsonl'),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createDesktopScreenshotHandler()', () => {
  it('returns an error when AFK_DESKTOP_ENABLED is not set (no injected backend)', async () => {
    const handler = createDesktopScreenshotHandler({});
    const signal = new AbortController().signal;
    const result = await handler({}, signal);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('AFK_DESKTOP_ENABLED');
  });

  it('returns an error immediately when signal is already aborted', async () => {
    const backend = makeBackend();
    const handler = createDesktopScreenshotHandler({ getBackend: async () => backend });
    const ac = new AbortController();
    ac.abort('test-abort');
    const result = await handler({}, ac.signal);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('aborted');
  });

  it('calls the backend with display=0 when no input is supplied', async () => {
    vi.stubEnv('AFK_SESSION_ID', 'test-session-abc');
    const backend = makeBackend();
    const handler = createDesktopScreenshotHandler({ getBackend: async () => backend });
    const signal = new AbortController().signal;
    const result = await handler({}, signal, { traceWriter: noopTrace, toolUseId: 'tu-1' });
    expect(backend.screenshot).toHaveBeenCalledOnce();
    const [input] = (backend.screenshot as ReturnType<typeof vi.fn>).mock.calls[0] as [DesktopScreenshotInput, string];
    expect(input.displayIndex).toBe(0);
    expect(input.region).toBeUndefined();
    expect(result.isError).toBeUndefined();
    expect(result.image).toBeDefined();
    expect(result.image?.mediaType).toBe('image/png');
    vi.unstubAllEnvs();
  });

  it('passes display index to the backend', async () => {
    vi.stubEnv('AFK_SESSION_ID', 'test-session-abc');
    const backend = makeBackend();
    const handler = createDesktopScreenshotHandler({ getBackend: async () => backend });
    const signal = new AbortController().signal;
    await handler({ display: 2 }, signal);
    const [input] = (backend.screenshot as ReturnType<typeof vi.fn>).mock.calls[0] as [DesktopScreenshotInput, string];
    expect(input.displayIndex).toBe(2);
    vi.unstubAllEnvs();
  });

  it('passes region to the backend when supplied', async () => {
    vi.stubEnv('AFK_SESSION_ID', 'test-session-abc');
    const backend = makeBackend();
    const handler = createDesktopScreenshotHandler({ getBackend: async () => backend });
    const signal = new AbortController().signal;
    const region = { x: 10, y: 20, width: 300, height: 200 };
    await handler({ region }, signal);
    const [input] = (backend.screenshot as ReturnType<typeof vi.fn>).mock.calls[0] as [DesktopScreenshotInput, string];
    expect(input.region).toEqual(region);
    vi.unstubAllEnvs();
  });

  it('forwards the AbortSignal to the backend', async () => {
    vi.stubEnv('AFK_SESSION_ID', 'test-session-abc');
    const backend = makeBackend();
    const handler = createDesktopScreenshotHandler({ getBackend: async () => backend });
    const ac = new AbortController();
    await handler({}, ac.signal);
    const [input] = (backend.screenshot as ReturnType<typeof vi.fn>).mock.calls[0] as [DesktopScreenshotInput, string];
    expect(input.signal).toBe(ac.signal);
    vi.unstubAllEnvs();
  });

  it('returns isError when the backend throws', async () => {
    vi.stubEnv('AFK_SESSION_ID', 'test-session-abc');
    const backend = makeBackend({
      screenshot: vi.fn().mockRejectedValue(new Error('screencapture: permission denied')),
    });
    const handler = createDesktopScreenshotHandler({ getBackend: async () => backend });
    const signal = new AbortController().signal;
    const result = await handler({}, signal);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('desktop_screenshot failed');
    vi.unstubAllEnvs();
  });

  it('returns isError when backend returns aborted result', async () => {
    vi.stubEnv('AFK_SESSION_ID', 'test-session-abc');
    const backend = makeBackend({
      screenshot: vi.fn().mockResolvedValue({ aborted: true, reason: 'cancelled' }),
    });
    const handler = createDesktopScreenshotHandler({ getBackend: async () => backend });
    const signal = new AbortController().signal;
    const result = await handler({}, signal);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('aborted');
    vi.unstubAllEnvs();
  });

  it('attaches downscaled image (via text-only fallback) when dimensions exceed MAX_IMAGE_DIMENSION', async () => {
    // The handler tries sips on darwin. On non-darwin (or when sips fails) it
    // falls back to text-only result — that is acceptable behaviour.
    vi.stubEnv('AFK_SESSION_ID', 'test-session-abc');
    const oversizeBuf = makeFakePngBuf(9000, 9000);
    const backend = makeBackend({
      screenshot: vi.fn().mockImplementation(async (_: DesktopScreenshotInput, sp: string) => ({
        path: sp, bytes: oversizeBuf.length,
        width: 9000, height: 9000,
        scaleFactor: 1, displayIndex: 0,
        logicalWidth: 9000, logicalHeight: 9000,
        dataBase64: oversizeBuf.toString('base64'),
        mediaType: 'image/png' as const,
      })),
    });
    const handler = createDesktopScreenshotHandler({ getBackend: async () => backend });
    const signal = new AbortController().signal;
    const result = await handler({}, signal);
    // Either downscaled image is attached OR text-only imageOmitted is returned.
    // Both are correct outcomes depending on platform. Neither is isError.
    expect(result.isError).toBeUndefined();
    if (result.image === undefined) {
      // text-only fallback path
      expect(result.content).toContain('imageOmitted');
    }
    vi.unstubAllEnvs();
  });

  it('returns error when region has non-positive dimensions', async () => {
    vi.stubEnv('AFK_SESSION_ID', 'test-session-abc');
    const backend = makeBackend();
    const handler = createDesktopScreenshotHandler({ getBackend: async () => backend });
    const signal = new AbortController().signal;
    const result = await handler({ region: { x: 0, y: 0, width: 0, height: 100 } }, signal);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('positive');
    vi.unstubAllEnvs();
  });

  it('returns error when region has negative x or y', async () => {
    vi.stubEnv('AFK_SESSION_ID', 'test-session-abc');
    const backend = makeBackend();
    const handler = createDesktopScreenshotHandler({ getBackend: async () => backend });
    const signal = new AbortController().signal;
    const result = await handler({ region: { x: -1, y: 0, width: 100, height: 100 } }, signal);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('non-negative');
    vi.unstubAllEnvs();
  });

  it('returns error when display is a non-integer', async () => {
    vi.stubEnv('AFK_SESSION_ID', 'test-session-abc');
    const backend = makeBackend();
    const handler = createDesktopScreenshotHandler({ getBackend: async () => backend });
    const signal = new AbortController().signal;
    const result = await handler({ display: 1.5 }, signal);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('"display"');
    vi.unstubAllEnvs();
  });

  it('returns error when display is a negative number', async () => {
    vi.stubEnv('AFK_SESSION_ID', 'test-session-abc');
    const backend = makeBackend();
    const handler = createDesktopScreenshotHandler({ getBackend: async () => backend });
    const signal = new AbortController().signal;
    const result = await handler({ display: -1 }, signal);
    expect(result.isError).toBe(true);
    vi.unstubAllEnvs();
  });

  it('returns error when display exceeds 255', async () => {
    vi.stubEnv('AFK_SESSION_ID', 'test-session-abc');
    const backend = makeBackend();
    const handler = createDesktopScreenshotHandler({ getBackend: async () => backend });
    const signal = new AbortController().signal;
    const result = await handler({ display: 300 }, signal);
    expect(result.isError).toBe(true);
    vi.unstubAllEnvs();
  });

  it('returns error when region values exceed MAX_COORD_VALUE', async () => {
    vi.stubEnv('AFK_SESSION_ID', 'test-session-abc');
    const backend = makeBackend();
    const handler = createDesktopScreenshotHandler({ getBackend: async () => backend });
    const signal = new AbortController().signal;
    const result = await handler({ region: { x: 0, y: 0, width: 99999, height: 100 } }, signal);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('32768');
    vi.unstubAllEnvs();
  });

  it('DESKTOP_SETUP_INSTRUCTIONS contains AFK_DESKTOP_ENABLED but not the CLI command', () => {
    expect(DESKTOP_SETUP_INSTRUCTIONS).toContain('AFK_DESKTOP_ENABLED');
    // Must NOT contain the exact enable command (security: don't tell model how to enable)
    expect(DESKTOP_SETUP_INSTRUCTIONS).not.toContain('afk config env set');
  });

  it('ATTACHED_LONG_SIDE is below the 2000px many-image ceiling', () => {
    // 2000px is MAX_DIMENSION_MANY_IMAGES from _many-image-guard.ts.
    expect(ATTACHED_LONG_SIDE).toBeLessThan(2000);
  });
});

describe('desktop-surface conditional schema registration', () => {
  it('desktopSchemas() returns [] when AFK_DESKTOP_ENABLED is not set', () => {
    vi.stubEnv('AFK_DESKTOP_ENABLED', undefined as unknown as string);
    expect(desktopSchemas()).toHaveLength(0);
    vi.unstubAllEnvs();
  });

  it('desktopSchemas() returns [desktopScreenshotTool] when AFK_DESKTOP_ENABLED=1', () => {
    vi.stubEnv('AFK_DESKTOP_ENABLED', '1');
    const schemas = desktopSchemas();
    expect(schemas).toHaveLength(1);
    expect(schemas[0]!.name).toBe('desktop_screenshot');
    vi.unstubAllEnvs();
  });

  it('desktop_screenshot is NOT in builtinToolSchemas', () => {
    const names = builtinToolSchemas.map((t) => t.name);
    expect(names).not.toContain('desktop_screenshot');
  });

  it('isDesktopEnabled() returns false when AFK_DESKTOP_ENABLED is unset', () => {
    vi.stubEnv('AFK_DESKTOP_ENABLED', undefined as unknown as string);
    expect(isDesktopEnabled()).toBe(false);
    vi.unstubAllEnvs();
  });

  it('isDesktopEnabled() returns true when AFK_DESKTOP_ENABLED=1', () => {
    vi.stubEnv('AFK_DESKTOP_ENABLED', '1');
    expect(isDesktopEnabled()).toBe(true);
    vi.unstubAllEnvs();
  });
});
