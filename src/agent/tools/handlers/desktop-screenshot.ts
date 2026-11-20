/**
 * Handler for the `desktop_screenshot` tool.
 *
 * Captures a screenshot of the host desktop display (or a region) and returns
 * the result as a `ToolResult` with the PNG attached as `image`. The PNG is
 * also written as a sidecar under
 * `~/.afk/state/witness/<sessionId>/desktop/screenshots/`.
 *
 * Mirrors `browser-screenshot.ts` in structure:
 *   - `ToolResult.image` carries the pixels; base64 stays out of `content`.
 *   - Dimension guard: on macOS, images exceeding 8000px per side are
 *     downscaled for attachment via `sips`. Windows has no downscale yet and
 *     falls back to a text-only result. The sidecar retains the
 *     full-resolution capture.
 *   - Byte cap: base64 payload over MAX_BASE64_BYTES triggers the same
 *     downscale path regardless of pixel dimensions.
 *   - Trace event emitted failure-isolated from dispatch.
 *   - Abort signal forwarded to the backend and honoured at entry.
 *
 * # Downscale constants
 * MAX_IMAGE_DIMENSION = 8000px — matches browser-screenshot.ts and the
 * Anthropic vision API hard limit (see _many-image-guard.ts).
 * MAX_BASE64_BYTES = 2 MiB — same cap as view-image.ts and image-generate.ts.
 * ATTACHED_LONG_SIDE = 1092px — chosen as follows: a Retina full display at
 * 3456×2234 physical pixels (scale=2) has a logical long side of 1728px.
 * Downscaling that to fit within 1092px (≈63% of 1728) keeps the attached
 * image well under both the 8000px hard limit and the 2 MiB byte cap while
 * still being readable. 1092 is also below MAX_DIMENSION_MANY_IMAGES (2000px)
 * so the image survives the many-image guard too. The constant is named here
 * rather than derived at runtime so the sips invocation can pass a single
 * --resampleHeightWidthMax flag.
 *
 * # Vision-capability check
 * Whether the active model can process images is not reachable from a tool
 * handler without broad plumbing (the handler receives only `input`, `signal`,
 * and `context`; model identity lives in the provider). Per the owner's
 * instruction: "If it is not reachable without broad plumbing, do not build
 * the plumbing; report the gap." The check is therefore left out of Tranche 1.
 * OpenAI-compatible providers already handle the missing-vision case by
 * silently dropping the image block; Anthropic returns a 400 for
 * unsupported models. Both are cleaner failure modes than a stale hard-coded
 * model list in a handler.
 *
 * # Locked-screen check
 * No reliable, unit-testable macOS locked-screen detection method was found
 * during Tranche 1 research. Per the owner's instruction: "implement it only
 * if you find a detection method you can justify and unit-test; otherwise
 * leave it out." The check is not built. Locked use is unsupported in v1 (spec
 * DP1). What `screencapture` does on a locked screen has not been observed:
 * it may fail, which would surface as CAPTURE_FAILED, or it may return an
 * image of the lock screen. Neither is handled specially here.
 *
 * @module agent/tools/handlers/desktop-screenshot
 */

import { chmod, mkdir, readFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolHandler, ToolHandlerContext } from '../types.js';
import type { DesktopHandlerOptions } from './desktop-provider.js';
import { acquireDesktopBackend } from './desktop-provider.js';
import { emitDesktopEvent } from '../../trace/emit.js';
import { abortReason, errorMessage } from '../../../utils/errors.js';
import { getTraceDir } from '../../../paths.witness.js';
import type { DesktopRegion, DesktopScreenshotInput } from '../../../desktop/types.js';
import { DesktopBackendError } from '../../../desktop/types.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Image guards — imported constants (see module-doc for rationale)
// ---------------------------------------------------------------------------

// Anthropic's vision API hard-rejects any image whose width OR height exceeds
// 8000px. Same value as MAX_DIMENSION_SINGLE_IMAGE in _many-image-guard.ts
// and MAX_IMAGE_DIMENSION in browser-screenshot.ts / view-image.ts.
const MAX_IMAGE_DIMENSION = 8000;

// Base64 byte cap — 2 MiB, same as MAX_BASE64_BYTES in view-image.ts and
// image-generate.ts. Prevents oversized Retina captures from flooding context.
const MAX_BASE64_BYTES = 2 * 1024 * 1024;

/**
 * Default long-side pixel size for the attached (downscaled) copy.
 * See module-doc for the derivation. Full-res sidecar is always preserved.
 */
export const ATTACHED_LONG_SIDE = 1092;

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

/**
 * Maximum sane value for any single input coordinate or dimension.
 * No physical display exceeds 32768px on a side; this bound stops absurd
 * values reaching the backend without being exploitable.
 */
const MAX_COORD_VALUE = 32768;

interface ParsedInput {
  displayIndex: number;
  region?: DesktopRegion;
}

function parseInput(raw: unknown): ParsedInput | { error: string } {
  if (raw !== undefined && raw !== null && typeof raw !== 'object') {
    return { error: 'desktop_screenshot: input must be an object or omitted' };
  }
  if (!raw) return { displayIndex: 0 };

  const obj = raw as Record<string, unknown>;

  let displayIndex = 0;
  if (obj['display'] !== undefined) {
    const d = obj['display'];
    if (
      typeof d !== 'number' ||
      !Number.isFinite(d) ||
      d < 0 ||
      !Number.isInteger(d) ||
      d > 255
    ) {
      return { error: 'desktop_screenshot: "display" must be a small non-negative integer (0–255)' };
    }
    displayIndex = d;
  }

  let region: DesktopRegion | undefined;
  if (obj['region'] !== undefined) {
    if (!obj['region'] || typeof obj['region'] !== 'object') {
      return { error: 'desktop_screenshot: "region" must be an object when provided' };
    }
    const r = obj['region'] as Record<string, unknown>;
    for (const field of ['x', 'y', 'width', 'height'] as const) {
      const v = r[field];
      if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) {
        return { error: `desktop_screenshot: "region.${field}" must be a finite integer` };
      }
    }
    const rX = r['x'] as number;
    const rY = r['y'] as number;
    const rWidth = r['width'] as number;
    const rHeight = r['height'] as number;
    if (rX < 0 || rY < 0) {
      return { error: 'desktop_screenshot: "region.x" and "region.y" must be non-negative' };
    }
    if (rWidth <= 0 || rHeight <= 0) {
      return { error: 'desktop_screenshot: "region.width" and "region.height" must be positive' };
    }
    if (rX > MAX_COORD_VALUE || rY > MAX_COORD_VALUE || rWidth > MAX_COORD_VALUE || rHeight > MAX_COORD_VALUE) {
      return { error: `desktop_screenshot: region values must not exceed ${MAX_COORD_VALUE}` };
    }
    region = { x: rX, y: rY, width: rWidth, height: rHeight };
  }

  return { displayIndex, region };
}

// ---------------------------------------------------------------------------
// Downscale helpers
// ---------------------------------------------------------------------------

/**
 * Attempt to downscale `sourcePath` to fit within `longSide` pixels on the
 * long side, writing the result to `outPath`, using `sips` (macOS).
 * Returns the buffer of the downscaled PNG on success, or null on any failure.
 * Never throws.
 */
async function downscaleWithSips(
  sourcePath: string,
  outPath: string,
  longSide: number,
): Promise<Buffer | null> {
  try {
    await execFileAsync(
      'sips',
      ['--resampleHeightWidthMax', String(longSide), sourcePath, '--out', outPath],
      { timeout: 15_000 },
    );
    const buf = await readFile(outPath);
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  } finally {
    await unlink(outPath).catch(() => undefined);
  }
}

interface AttachedImage {
  dataBase64: string;
  attachedWidth: number;
  attachedHeight: number;
}

/**
 * Read PNG dimensions from a buffer (IHDR chunk at bytes 16-23).
 * Returns null when the buffer is too short or not a valid PNG header.
 */
function readPngDims(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * Produce the image that will be attached to the model, downscaling if needed.
 *
 * Returns an AttachedImage (possibly downscaled) or null when the image cannot
 * be attached (downscale failed and the original is over-limit).
 */
async function buildAttachedImage(
  capturedBase64: string,
  capturedWidth: number,
  capturedHeight: number,
  sidecarPath: string,
): Promise<AttachedImage | null> {
  const needsResize =
    capturedWidth > MAX_IMAGE_DIMENSION ||
    capturedHeight > MAX_IMAGE_DIMENSION ||
    capturedBase64.length > MAX_BASE64_BYTES;

  if (!needsResize) {
    return { dataBase64: capturedBase64, attachedWidth: capturedWidth, attachedHeight: capturedHeight };
  }

  // Attempt downscale. The temporary copy is written next to the sidecar,
  // inside the owner-only screenshots directory, never in the shared OS temp
  // directory: it is a copy of a private screenshot. downscaleWithSips removes
  // it after reading.
  const tmpOut = join(dirname(sidecarPath), `attach-${Date.now()}.png`);

  if (process.platform === 'darwin') {
    const buf = await downscaleWithSips(sidecarPath, tmpOut, ATTACHED_LONG_SIDE);
    if (buf) {
      const dims = readPngDims(buf);
      if (dims && buf.toString('base64').length <= MAX_BASE64_BYTES &&
          dims.width <= MAX_IMAGE_DIMENSION && dims.height <= MAX_IMAGE_DIMENSION) {
        return { dataBase64: buf.toString('base64'), attachedWidth: dims.width, attachedHeight: dims.height };
      }
    }
  }

  // Downscale unavailable or failed — return null so the handler falls back
  // to a text-only result that names the sidecar path.
  return null;
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export function createDesktopScreenshotHandler(opts: DesktopHandlerOptions = {}): ToolHandler {
  return async (input, signal, context?: ToolHandlerContext) => {
    // Pre-aborted short-circuit.
    if (signal.aborted) {
      const msg = abortReason(signal.reason);
      return { content: `desktop_screenshot aborted: ${msg}`, isError: true };
    }

    const parsed = parseInput(input);
    if ('error' in parsed) {
      return { content: parsed.error, isError: true };
    }

    const acquired = await acquireDesktopBackend('desktop_screenshot', opts);
    if (!acquired.ok) return acquired;
    const { sessionId, backend } = acquired;

    // Re-check abort after acquiring the backend (may have taken a moment).
    if (signal.aborted) {
      const msg = abortReason(signal.reason);
      return { content: `desktop_screenshot aborted: ${msg}`, isError: true };
    }

    // Build the sidecar path under the session trace directory.
    const screenshotsDir = join(getTraceDir(sessionId), 'desktop', 'screenshots');
    const ts = Date.now();
    const sidecarPath = join(screenshotsDir, `desktop_screenshot_${ts}.png`);

    // Invariant: the screenshots directory is owner-only before anything is
    // written to it. `mkdir` applies `mode` only to directories it creates, so
    // a directory that already exists with a wider mode is tightened
    // explicitly. If that fails on POSIX the capture is refused: a full-screen
    // image must not land in a directory other local users can read. File
    // modes inside are a second line of defence, not the guarantee.
    await mkdir(screenshotsDir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
      try {
        await chmod(screenshotsDir, 0o700);
      } catch (err) {
        return {
          content:
            `desktop_screenshot refused: could not make the screenshot directory private ` +
            `(${screenshotsDir}): ${errorMessage(err)}`,
          isError: true,
        };
      }
    }

    const backendInput: DesktopScreenshotInput = {
      displayIndex: parsed.displayIndex,
      ...(parsed.region ? { region: parsed.region } : {}),
      signal,
    };

    const t0 = Date.now();
    try {
      const result = await backend.screenshot(backendInput, sidecarPath);
      const durationMs = Date.now() - t0;

      // Handle abort result from the backend.
      if ('aborted' in result) {
        return { content: `desktop_screenshot aborted: ${result.reason}`, isError: true };
      }

      const { dataBase64, mediaType, ...meta } = result;

      void emitDesktopEvent(context?.traceWriter, {
        tool: 'desktop_screenshot',
        toolUseId: context?.toolUseId ?? '',
        displayIndex: result.displayIndex,
        captureWidth: result.width,
        captureHeight: result.height,
        scaleFactor: result.scaleFactor ?? 0,
        screenshotPath: result.path,
        status: 'ok',
        durationMs,
      });

      // Attempt to build an attached image, downscaling if necessary.
      const attached = await buildAttachedImage(
        dataBase64,
        result.width,
        result.height,
        sidecarPath,
      );

      if (!attached) {
        // Downscale failed or unavailable — text-only result.
        return {
          content: JSON.stringify(
            {
              ...meta,
              imageOmitted:
                `Captured image (${result.width}x${result.height}px, ` +
                `${dataBase64.length} base64 bytes) exceeds provider limits ` +
                `and downscaling failed. The full-resolution PNG is at the sidecar path.`,
            },
            null,
            2,
          ),
        };
      }

      const wasDownscaled = attached.attachedWidth !== result.width || attached.attachedHeight !== result.height;
      const responseScale = wasDownscaled
        ? { attachedWidth: attached.attachedWidth, attachedHeight: attached.attachedHeight,
            attachedToCapturRatio: attached.attachedWidth / result.width }
        : {};

      return {
        content: JSON.stringify({ ...meta, ...responseScale }, null, 2),
        image: { mediaType, data: attached.dataBase64 },
      };
    } catch (err) {
      const durationMs = Date.now() - t0;
      const msg = err instanceof DesktopBackendError ? err.message : errorMessage(err);

      void emitDesktopEvent(context?.traceWriter, {
        tool: 'desktop_screenshot',
        toolUseId: context?.toolUseId ?? '',
        status: 'error',
        durationMs,
        error: { reason: msg, recoverable: false },
      });

      // Clean up any partial output file on error.
      await unlink(sidecarPath).catch(() => undefined);

      return { content: `desktop_screenshot failed: ${msg}`, isError: true };
    }
  };
}

export const desktopScreenshotHandler: ToolHandler = createDesktopScreenshotHandler();
