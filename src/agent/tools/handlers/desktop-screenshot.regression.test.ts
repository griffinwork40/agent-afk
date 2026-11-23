import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createDesktopScreenshotHandler } from './desktop-screenshot.js';
import { ensurePrivateScreenshotDirectory } from '../../../desktop/private-directory.js';
import type { DesktopBackend } from '../../../desktop/types.js';
import type { TraceSink } from '../../trace/index.js';
import { DesktopEventPayloadSchema } from '../../trace/events.desktop.js';
import { desktopScreenshotTool } from '../schemas.desktop-tools.js';

vi.mock('../../../desktop/private-directory.js', () => ({
  ensurePrivateScreenshotDirectory: vi.fn().mockResolvedValue(undefined),
}));

function png(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function backend(width = 9000, height = 4500, scaleFactor: number | null = 1): DesktopBackend {
  return {
    screenshot: vi.fn<DesktopBackend['screenshot']>().mockImplementation(async (_input, sidecar) => ({
      path: sidecar, bytes: 33, width, height, scaleFactor, displayIndex: 0,
      logicalWidth: width, logicalHeight: height,
      dataBase64: png(width, height).toString('base64'), mediaType: 'image/png',
    })),
  };
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'afk-desktop-regression-'));
  vi.stubEnv('AFK_HOME', root);
  vi.stubEnv('AFK_SESSION_ID', 'regression');
  vi.mocked(ensurePrivateScreenshotDirectory).mockResolvedValue(undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('desktop screenshot review regressions', () => {
  it('omits unknown scale from the emitted event and passes the actual payload schema', async () => {
    const sink: TraceSink = { write: vi.fn().mockResolvedValue(undefined), getTracePath: () => path.join(root, 'trace') };
    const handler = createDesktopScreenshotHandler({ getBackend: async () => backend(1920, 1080, null) });
    const result = await handler({}, new AbortController().signal, { traceWriter: sink, toolUseId: 'scale-null' });
    expect(result.isError).toBeUndefined();
    const event = vi.mocked(sink.write).mock.calls[0]![0];
    expect(event.kind).toBe('desktop_event');
    expect(event.payload).not.toHaveProperty('scaleFactor');
    expect(DesktopEventPayloadSchema.safeParse(event.payload).success).toBe(true);
  });

  it('reports the correctly spelled attachment ratio and dimensions on any host platform', async () => {
    const downscale = vi.fn().mockResolvedValue(png(1000, 500));
    const handler = createDesktopScreenshotHandler({ getBackend: async () => backend(), downscale });
    const signal = new AbortController().signal;
    const result = await handler({}, signal);
    expect(result.isError).toBeUndefined();
    expect(result.image).toBeDefined();
    expect(JSON.parse(result.content)).toMatchObject({
      attachedWidth: 1000, attachedHeight: 500, attachedToCaptureRatio: 1000 / 9000,
    });
    expect(JSON.parse(result.content)).not.toHaveProperty('attachedToCapturRatio');
    expect(downscale.mock.calls[0]?.[3]).toBe(signal);
  });

  it.each(['resolve', 'reject'])('returns an aborted error, not a text-only result, when downscale aborts (%s)', async (mode) => {
    const controller = new AbortController();
    const handler = createDesktopScreenshotHandler({
      getBackend: async () => backend(),
      downscale: async (_source, _out, _longSide, signal) => {
        expect(signal).toBe(controller.signal);
        controller.abort('downscale cancelled');
        if (mode === 'reject') throw new Error('AbortError');
        return null;
      },
    });
    const result = await handler({}, controller.signal);
    expect(result.isError).toBe(true);
    expect(result.content).toBe('desktop_screenshot aborted: downscale cancelled');
    expect(result.image).toBeUndefined();
    expect(result.content).not.toContain('imageOmitted');
  });

  it('allocates distinct sidecar and attachment paths for concurrent calls at the same millisecond', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(123456);
    expect(desktopScreenshotTool.concurrencySafe).toBe(true);
    const capture = backend();
    const downscale = vi.fn().mockResolvedValue(png(1000, 500));
    const handler = createDesktopScreenshotHandler({ getBackend: async () => capture, downscale });
    const signal = new AbortController().signal;
    const results = await Promise.all([handler({}, signal), handler({}, signal)]);
    expect(results.every((result) => !result.isError && result.image)).toBe(true);
    const sidecars = vi.mocked(capture.screenshot).mock.calls.map((call) => call[1]);
    const attachments = downscale.mock.calls.map((call) => call[1] as string);
    expect(new Set([...sidecars, ...attachments]).size).toBe(4);
    for (const sidecar of sidecars) expect(path.basename(sidecar)).toMatch(/^desktop_screenshot_123456-.+\.png$/);
    for (const attachment of attachments) expect(path.basename(attachment)).toMatch(/^attach-123456-.+\.png$/);
  });

  it.each([
    Object.assign(new Error('Access denied'), { code: 1 }),
    Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }),
  ])('refuses capture on directory ACL failure: $message', async (error) => {
    vi.mocked(ensurePrivateScreenshotDirectory).mockRejectedValueOnce(error);
    const capture = backend();
    const result = await createDesktopScreenshotHandler({ getBackend: async () => capture })({}, new AbortController().signal);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('desktop_screenshot refused: could not make the screenshot directory private');
    expect(capture.screenshot).not.toHaveBeenCalled();
  });

  it('preserves text-only fallback for a non-aborted resize failure', async () => {
    const handler = createDesktopScreenshotHandler({ getBackend: async () => backend(), downscale: async () => null });
    const result = await handler({}, new AbortController().signal);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('imageOmitted');
  });
});
