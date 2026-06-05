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

import type { ToolHandler } from '../types.js';
import type { BrowserHandlerOptions } from './browser-open.js';
import type { Target } from '../../../browser/types.js';
import { env } from '../../../config/env.js';

// History: browser_event witness emission is a no-op in this handler.
// See browser-open.ts for the full rationale.

const PLAYWRIGHT_MISSING_HINTS = ['Cannot find package', 'ERR_MODULE_NOT_FOUND'];

const VALID_TARGET_KINDS = ['semantic', 'element_id', 'selector'] as const;

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
  return async (input, signal) => {
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
      if (PLAYWRIGHT_MISSING_HINTS.some((hint) => msg.includes(hint))) {
        return {
          content:
            'browser tools require the optional `playwright` peer dependency. ' +
            'Install via: pnpm add playwright. Or pick a different tool.',
          isError: true,
        };
      }
      return { content: `browser_screenshot failed to get provider: ${msg}`, isError: true };
    }

    try {
      const screenshotResult = await provider.screenshot({
        sessionId,
        target: parsed.target,
        fullPage: parsed.fullPage,
      });
      return { content: JSON.stringify(screenshotResult, null, 2) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `browser_screenshot failed: ${msg}`, isError: true };
    }
  };
}

export const browserScreenshotHandler: ToolHandler = createBrowserScreenshotHandler();
