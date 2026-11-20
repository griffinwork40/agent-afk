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
import { createDesktopScreenshotHandler } from './desktop-screenshot.js';
import { DESKTOP_SETUP_INSTRUCTIONS } from './desktop-provider.js';
import type { DesktopBackend, DesktopScreenshotInput } from '../../../desktop/types.js';
import type { TraceSink } from '../../trace/index.js';

// ---------------------------------------------------------------------------
// Mock backend helpers
// ---------------------------------------------------------------------------

/** Minimal PNG header bytes so the handler can read dimensions from the sidecar. */
const FAKE_PNG_WIDTH = 1920;
const FAKE_PNG_HEIGHT = 1080;

function makeFakePngBuf(): Buffer {
  // 8-byte PNG signature + IHDR chunk (4 len + 4 type + 13 data)
  const buf = Buffer.alloc(33);
  // PNG signature
  buf.write('\x89PNG\r\n\x1a\n', 0, 'binary');
  // IHDR length = 13
  buf.writeUInt32BE(13, 8);
  // 'IHDR'
  buf.write('IHDR', 12, 'ascii');
  // Width and height
  buf.writeUInt32BE(FAKE_PNG_WIDTH, 16);
  buf.writeUInt32BE(FAKE_PNG_HEIGHT, 20);
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

/** Minimal no-op trace sink. */
const noopTrace: TraceSink = {
  write: vi.fn().mockResolvedValue(undefined),
  getTracePath: () => '/tmp/fake-trace.jsonl',
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

  it('omits image when dimensions exceed MAX_IMAGE_DIMENSION', async () => {
    vi.stubEnv('AFK_SESSION_ID', 'test-session-abc');
    const oversizeBuf = Buffer.alloc(33);
    oversizeBuf.write('\x89PNG\r\n\x1a\n', 0, 'binary');
    oversizeBuf.writeUInt32BE(13, 8);
    oversizeBuf.write('IHDR', 12, 'ascii');
    oversizeBuf.writeUInt32BE(9000, 16); // exceeds 8000px limit
    oversizeBuf.writeUInt32BE(9000, 20);
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
    expect(result.isError).toBeUndefined();
    expect(result.image).toBeUndefined();
    expect(result.content).toContain('imageOmitted');
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

  it('DESKTOP_SETUP_INSTRUCTIONS contains AFK_DESKTOP_ENABLED', () => {
    expect(DESKTOP_SETUP_INSTRUCTIONS).toContain('AFK_DESKTOP_ENABLED');
  });
});
