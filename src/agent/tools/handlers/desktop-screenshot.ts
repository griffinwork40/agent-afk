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
 *   - Dimension guard: images exceeding 8000px per side are downgraded to
 *     text-only (the same 8000px limit Anthropic's vision API enforces).
 *   - Trace event emitted failure-isolated from dispatch.
 *   - Abort signal honoured at entry.
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
 * leave it out." The check is not built. The spec DP1 answer applies: locked
 * use is "unsupported in v1" (a clean refusal by the OS — screencapture
 * returns an error, which we surface as a CAPTURE_FAILED DesktopBackendError).
 *
 * @module agent/tools/handlers/desktop-screenshot
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolHandler, ToolHandlerContext } from '../types.js';
import type { DesktopHandlerOptions } from './desktop-provider.js';
import { acquireDesktopBackend } from './desktop-provider.js';
import { emitDesktopEvent } from '../../trace/emit.js';
import { abortReason, errorMessage } from '../../../utils/errors.js';
import { getTraceDir } from '../../../paths.witness.js';
import type { DesktopRegion, DesktopScreenshotInput } from '../../../desktop/types.js';
import { DesktopBackendError } from '../../../desktop/types.js';

// Invariant: Anthropic's vision API hard-rejects any image whose width OR
// height exceeds 8000px (docs: "Build with Claude › Vision › General limits").
// This is a pixel ceiling independent of byte size — enforced here as it is
// in browser-screenshot.ts, because the provider is model-agnostic and this
// is a model limit.
const MAX_IMAGE_DIMENSION = 8000;

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

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
    if (typeof obj['display'] !== 'number' || !Number.isFinite(obj['display']) || obj['display'] < 0) {
      return { error: 'desktop_screenshot: "display" must be a non-negative number' };
    }
    displayIndex = Math.floor(obj['display']);
  }

  let region: DesktopRegion | undefined;
  if (obj['region'] !== undefined) {
    if (!obj['region'] || typeof obj['region'] !== 'object') {
      return { error: 'desktop_screenshot: "region" must be an object when provided' };
    }
    const r = obj['region'] as Record<string, unknown>;
    for (const field of ['x', 'y', 'width', 'height'] as const) {
      if (typeof r[field] !== 'number' || !Number.isFinite(r[field])) {
        return { error: `desktop_screenshot: "region.${field}" must be a finite number` };
      }
    }
    const rWidth = r['width'] as number;
    const rHeight = r['height'] as number;
    if (rWidth <= 0 || rHeight <= 0) {
      return { error: 'desktop_screenshot: "region.width" and "region.height" must be positive' };
    }
    region = { x: r['x'] as number, y: r['y'] as number, width: rWidth, height: rHeight };
  }

  return { displayIndex, region };
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

    // Build the sidecar path under the session trace directory.
    const screenshotsDir = join(getTraceDir(sessionId), 'desktop', 'screenshots');
    const ts = Date.now();
    const sidecarPath = join(screenshotsDir, `desktop_screenshot_${ts}.png`);

    // Ensure the directory exists before the backend writes to it.
    await mkdir(screenshotsDir, { recursive: true });

    const backendInput: DesktopScreenshotInput = {
      displayIndex: parsed.displayIndex,
      ...(parsed.region ? { region: parsed.region } : {}),
    };

    const t0 = Date.now();
    try {
      const result = await backend.screenshot(backendInput, sidecarPath);
      const durationMs = Date.now() - t0;

      const { dataBase64, mediaType, ...meta } = result;

      void emitDesktopEvent(context?.traceWriter, {
        tool: 'desktop_screenshot',
        toolUseId: context?.toolUseId ?? '',
        displayIndex: result.displayIndex,
        captureWidth: result.width,
        captureHeight: result.height,
        scaleFactor: result.scaleFactor,
        screenshotPath: result.path,
        status: 'ok',
        durationMs,
      });

      // Dimension guard — same threshold as browser_screenshot.
      if (meta.width > MAX_IMAGE_DIMENSION || meta.height > MAX_IMAGE_DIMENSION) {
        return {
          content: JSON.stringify(
            {
              ...meta,
              imageOmitted:
                `dimensions ${meta.width}x${meta.height}px exceed the ` +
                `${MAX_IMAGE_DIMENSION}px model-vision limit; the PNG was ` +
                `saved to the sidecar path but not attached. Use a region ` +
                `to capture a smaller area.`,
            },
            null,
            2,
          ),
        };
      }

      return {
        content: JSON.stringify(meta, null, 2),
        image: { mediaType, data: dataBase64 },
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

      return { content: `desktop_screenshot failed: ${msg}`, isError: true };
    }
  };
}

export const desktopScreenshotHandler: ToolHandler = createDesktopScreenshotHandler();
