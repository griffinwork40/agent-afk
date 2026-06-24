/**
 * Handler for the `browser_screenshot` tool.
 *
 * Captures a screenshot of the current page (or a target element's bounding
 * box if `target` is specified) and returns the `ScreenshotResult` as JSON.
 *
 * The screenshot is written to a sidecar PNG file under
 * `~/.afk/state/witness/<sid>/browser/screenshots/` by the provider.
 * The handler returns `{ path, bytes, width, height }` — the model uses the
 * path field to refer to the file in subsequent messages.
 *
 * NOTE: `browser_screenshot` does NOT update the observation cache. If you
 * need a fresh observation alongside the screenshot, call `browser_observe`
 * after this tool.
 *
 * @module agent/tools/handlers/browser-screenshot
 */

import type { ToolHandler, ToolHandlerContext } from '../types.js';
import type { BrowserHandlerOptions } from './browser-open.js';
import type { Target } from '../../../browser/types.js';
import { env } from '../../../config/env.js';
import { emitBrowserEvent } from '../../trace/emit.js';

import { isPlaywrightMissing, playwrightMissingHint } from './playwright-hints.js';

const VALID_TARGET_KINDS = ['semantic', 'element_id', 'selector'] as const;

// Invariant: Anthropic's vision API hard-rejects any image whose width OR
// height exceeds 8000px (docs: "Build with Claude › Vision › General limits").
// This is a pixel ceiling independent of byte size — enforced here, not in the
// provider, because the provider is model-agnostic and this is a model limit.
const MAX_IMAGE_DIMENSION = 8000;

interface ParsedScreenshotInput {
  target?: Target;
  fullPage?: boolean;
}

function parseTargetObject(t: Record<string, unknown>): Target | { error: string } {
  if (typeof t['kind'] !== 'string' || !VALID_TARGET_KINDS.includes(t['kind'] as typeof VALID_TARGET_KINDS[number])) {
    return {
      error: `browser_screenshot: "target.kind" must be one of ${VALID_TARGET_KINDS.map((k) => `"${k}"`).join(', ')} (got ${JSON.stringify(t['kind'])})`,
    };
  }

  const kind = t['kind'] as typeof VALID_TARGET_KINDS[number];

  if (kind === 'semantic') {
    if (typeof t['text'] !== 'string' || t['text'].length === 0) {
      return { error: 'browser_screenshot: target.kind=semantic requires "target.text" (non-empty string)' };
    }
    return {
      kind: 'semantic',
      text: t['text'],
      ...(typeof t['role'] === 'string' && t['role'].length > 0 ? { role: t['role'] } : {}),
    };
  }

  if (kind === 'element_id') {
    if (typeof t['element_id'] !== 'string' || t['element_id'].length === 0) {
      return { error: 'browser_screenshot: target.kind=element_id requires "target.element_id" (non-empty string)' };
    }
    return { kind: 'element_id', elementId: t['element_id'] };
  }

  // selector
  if (typeof t['selector'] !== 'string' || t['selector'].length === 0) {
    return { error: 'browser_screenshot: target.kind=selector requires "target.selector" (non-empty string)' };
  }
  return { kind: 'selector', selector: t['selector'] };
}

function parseInput(raw: unknown): ParsedScreenshotInput | { error: string } {
  if (raw !== undefined && raw !== null && typeof raw !== 'object') {
    return { error: 'browser_screenshot: input must be an object or omitted' };
  }
  if (!raw) return {};

  const obj = raw as Record<string, unknown>;

  let target: Target | undefined;
  if (obj['target'] !== undefined) {
    if (!obj['target'] || typeof obj['target'] !== 'object') {
      return { error: 'browser_screenshot: "target" must be an object when provided' };
    }
    const parsed = parseTargetObject(obj['target'] as Record<string, unknown>);
    if ('error' in parsed) return parsed;
    target = parsed;
  }

  let fullPage: boolean | undefined;
  if (obj['full_page'] !== undefined) {
    if (typeof obj['full_page'] !== 'boolean') {
      return { error: 'browser_screenshot: "full_page" must be a boolean' };
    }
    fullPage = obj['full_page'];
  }

  return { target, fullPage };
}

export function createBrowserScreenshotHandler(opts: BrowserHandlerOptions = {}): ToolHandler {
  return async (input, signal, context?: ToolHandlerContext) => {
    // Pre-aborted short-circuit.
    if (signal.aborted) {
      const reason = signal.reason;
      const msg = reason instanceof Error ? reason.message : String(reason ?? 'aborted');
      return { content: `browser_screenshot aborted: ${msg}`, isError: true };
    }

    const parsed = parseInput(input);
    if ('error' in parsed) {
      return { content: parsed.error, isError: true };
    }

    const sessionId = env.AFK_SESSION_ID ?? 'default';
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
      return {
        content: `Invalid AFK_SESSION_ID: must match /^[a-zA-Z0-9_-]+$/, got: ${JSON.stringify(sessionId)}`,
        isError: true,
      };
    }

    let provider: import('../../../browser/provider.js').BrowserProvider;
    try {
      if (opts.getBrowserProvider) {
        provider = await opts.getBrowserProvider();
      } else {
        const { getBrowserProvider } = await import('../../../browser/registry.js');
        provider = await getBrowserProvider();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isPlaywrightMissing(msg)) {
        return { content: playwrightMissingHint(msg), isError: true };
      }
      return { content: `browser_screenshot failed to get provider: ${msg}`, isError: true };
    }

    const t0 = Date.now();
    try {
      const screenshotResult = await provider.screenshot({
        sessionId,
        target: parsed.target,
        fullPage: parsed.fullPage,
      });
      const durationMs = Date.now() - t0;

      // Keep the base64 image bytes OUT of the text content — `dataBase64` is
      // megabytes of base64 the model must never see as text. The pixels ride
      // on the `image` field, which the anthropic-direct provider emits as an
      // image content block; the text carries only the metadata so providers
      // that can't render tool-result images still get the path/dimensions.
      const { dataBase64, mediaType, ...meta } = screenshotResult;

      void emitBrowserEvent(context?.traceWriter, {
        tool: 'browser_screenshot',
        toolUseId: context?.toolUseId ?? '',
        // screenshot is a non-navigating read — URL is unchanged; we don't
        // have a currentUrl() on the provider so we use null for both fields.
        urlBefore: null,
        urlAfter: null,
        status: 'ok',
        durationMs,
        screenshotPath: meta.path,
      });

      // Dimension guard. A full_page screenshot of a tall page can stay under
      // the 5 MiB sidecar byte cap yet exceed Anthropic's 8000px pixel limit.
      // Attaching it would 400 the request AND leave a poison image block in
      // message history that re-fails every subsequent turn. So degrade to
      // text-only (omit `image`) — NOT an error: the model still gets the path,
      // byte size, dimensions, and a reason, mirroring the byte-cap fallback.
      if (meta.width > MAX_IMAGE_DIMENSION || meta.height > MAX_IMAGE_DIMENSION) {
        return {
          content: JSON.stringify(
            {
              ...meta,
              imageOmitted: `dimensions ${meta.width}x${meta.height}px exceed the ${MAX_IMAGE_DIMENSION}px model-vision limit; the PNG was saved to the sidecar path but not attached. Use full_page:false (viewport) or target a specific element for a model-visible image.`,
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
      const msg = err instanceof Error ? err.message : String(err);
      void emitBrowserEvent(context?.traceWriter, {
        tool: 'browser_screenshot',
        toolUseId: context?.toolUseId ?? '',
        urlBefore: null,
        urlAfter: null,
        status: 'error',
        durationMs,
        error: { reason: msg, recoverable: false },
      });
      return { content: `browser_screenshot failed: ${msg}`, isError: true };
    }
  };
}

export const browserScreenshotHandler: ToolHandler = createBrowserScreenshotHandler();
