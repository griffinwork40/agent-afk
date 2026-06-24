/**
 * Handler for the `browser_act` tool.
 *
 * Performs an action (click, fill, press, select, hover, scroll_to,
 * wait_for) against a target element on the current page and returns the
 * resulting `BrowserObservation` as JSON.
 *
 * Pattern-matches on the `ActOutcome` discriminated union:
 *   - `BrowserObservation`  → `{ content: JSON.stringify(obs) }`
 *   - `AmbiguousTarget`     → disambiguation message, `isError: true`
 *   - `BlockedByPolicy`     → blocked message, `isError: true`
 *
 * Target resolution strategy (ordered by preference):
 *   - `kind: 'semantic'`    — natural-language text + optional role. Preferred.
 *   - `kind: 'element_id'`  — `id` from a prior observation's interactive list.
 *   - `kind: 'selector'`    — raw CSS / xpath selector. Escape hatch.
 *
 * @module agent/tools/handlers/browser-act
 */

import type { ToolHandler, ToolHandlerContext } from '../types.js';
import type { BrowserHandlerOptions } from './browser-open.js';
import type { Target, ActAction } from '../../../browser/types.js';
import { truncateTargetText, hashSelector } from '../../../browser/sanitize.js';
import { env } from '../../../config/env.js';
import { emitBrowserEvent } from '../../trace/emit.js';
import type { BrowserEventTarget } from '../../trace/types.js';

import {
  browserTimeoutFailureClass,
  isPlaywrightMissing,
  playwrightMissingHint,
} from './playwright-hints.js';

const VALID_ACTIONS: readonly ActAction[] = [
  'click', 'fill', 'press', 'select', 'hover', 'scroll_to', 'wait_for',
];

const VALID_TARGET_KINDS = ['semantic', 'element_id', 'selector'] as const;

interface ParsedActInput {
  action: ActAction;
  target: Target;
  value?: string;
  timeoutMs?: number;
  screenshot?: boolean;
}

function parseInput(raw: unknown): ParsedActInput | { error: string } {
  if (!raw || typeof raw !== 'object') {
    return { error: 'browser_act: input must be an object' };
  }
  const obj = raw as Record<string, unknown>;

  // Validate action
  if (typeof obj['action'] !== 'string') {
    return { error: 'browser_act: "action" is required and must be a string' };
  }
  if (!VALID_ACTIONS.includes(obj['action'] as ActAction)) {
    return {
      error: `browser_act: "action" must be one of ${VALID_ACTIONS.map((a) => `"${a}"`).join(', ')} (got ${JSON.stringify(obj['action'])})`,
    };
  }
  const action = obj['action'] as ActAction;

  // Validate target
  const targetRaw = obj['target'];
  if (!targetRaw || typeof targetRaw !== 'object') {
    return { error: 'browser_act: "target" is required and must be an object' };
  }
  const t = targetRaw as Record<string, unknown>;

  if (typeof t['kind'] !== 'string' || !VALID_TARGET_KINDS.includes(t['kind'] as typeof VALID_TARGET_KINDS[number])) {
    return {
      error: `browser_act: "target.kind" must be one of ${VALID_TARGET_KINDS.map((k) => `"${k}"`).join(', ')} (got ${JSON.stringify(t['kind'])})`,
    };
  }

  let target: Target;
  const kind = t['kind'] as typeof VALID_TARGET_KINDS[number];

  if (kind === 'semantic') {
    if (typeof t['text'] !== 'string' || t['text'].length === 0) {
      return { error: 'browser_act: target.kind=semantic requires "target.text" (non-empty string)' };
    }
    target = {
      kind: 'semantic',
      text: t['text'],
      ...(typeof t['role'] === 'string' && t['role'].length > 0 ? { role: t['role'] } : {}),
    };
  } else if (kind === 'element_id') {
    if (typeof t['element_id'] !== 'string' || t['element_id'].length === 0) {
      return { error: 'browser_act: target.kind=element_id requires "target.element_id" (non-empty string)' };
    }
    target = { kind: 'element_id', elementId: t['element_id'] };
  } else {
    // selector
    if (typeof t['selector'] !== 'string' || t['selector'].length === 0) {
      return { error: 'browser_act: target.kind=selector requires "target.selector" (non-empty string)' };
    }
    target = { kind: 'selector', selector: t['selector'] };
  }

  let value: string | undefined;
  if (obj['value'] !== undefined) {
    if (typeof obj['value'] !== 'string') {
      return { error: 'browser_act: "value" must be a string when provided' };
    }
    value = obj['value'];
  }

  let timeoutMs: number | undefined;
  if (obj['timeout_ms'] !== undefined) {
    if (typeof obj['timeout_ms'] !== 'number' || !Number.isFinite(obj['timeout_ms']) || obj['timeout_ms'] <= 0) {
      return { error: 'browser_act: "timeout_ms" must be a positive finite number' };
    }
    timeoutMs = obj['timeout_ms'];
  }

  let screenshot: boolean | undefined;
  if (obj['screenshot'] !== undefined) {
    if (typeof obj['screenshot'] !== 'boolean') {
      return { error: 'browser_act: "screenshot" must be a boolean' };
    }
    screenshot = obj['screenshot'];
  }

  return { action, target, value, timeoutMs, screenshot };
}

/**
 * Build a human-readable disambiguation message from an `AmbiguousTarget`
 * outcome. Lists each candidate's id, role, and label so the agent can
 * retry with `element_id`.
 */
function buildAmbiguousMessage(
  query: { text: string; role?: string },
  candidates: ReadonlyArray<{ id: string; role: string; label: string }>,
): string {
  const queryDesc = query.role ? `"${query.text}" (role: ${query.role})` : `"${query.text}"`;
  const lines = [
    `browser_act: ambiguous target — ${candidates.length} elements matched ${queryDesc}.`,
    'Retry with target.kind="element_id" using one of the following:',
    ...candidates.map((c) => `  id=${c.id}  role=${c.role}  label=${c.label}`),
  ];
  return lines.join('\n');
}

/**
 * Sanitize the target for witness emission. Returns a `BrowserEventTarget`
 * safe to include in trace records — selector contents are hashed, semantic
 * text is truncated to 80 chars.
 */
function witnessTarget(target: Target): BrowserEventTarget {
  if (target.kind === 'semantic') {
    return {
      kind: 'semantic',
      text: truncateTargetText(target.text),
      ...(target.role !== undefined ? { role: target.role } : {}),
    };
  }
  if (target.kind === 'element_id') {
    return { kind: 'element_id', elementId: target.elementId };
  }
  return { kind: 'selector', selectorHash: hashSelector(target.selector) };
}

export function createBrowserActHandler(opts: BrowserHandlerOptions = {}): ToolHandler {
  return async (input, signal, context?: ToolHandlerContext) => {
    // Pre-aborted short-circuit.
    if (signal.aborted) {
      const reason = signal.reason;
      const msg = reason instanceof Error ? reason.message : String(reason ?? 'aborted');
      return { content: `browser_act aborted: ${msg}`, isError: true, failureClass: 'abort' };
    }

    const parsed = parseInput(input);
    if ('error' in parsed) {
      return { content: parsed.error, isError: true };
    }

    const targetWitness = witnessTarget(parsed.target);

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
      return { content: `browser_act failed to get provider: ${msg}`, isError: true };
    }

    const t0 = Date.now();
    try {
      const result = await provider.act({
        sessionId,
        action: parsed.action,
        target: parsed.target,
        value: parsed.value,
        timeoutMs: parsed.timeoutMs,
        screenshot: parsed.screenshot,
      });
      const durationMs = Date.now() - t0;

      if ('outcome' in result) {
        if (result.outcome === 'ambiguous_target') {
          void emitBrowserEvent(context?.traceWriter, {
            tool: 'browser_act',
            action: parsed.action,
            toolUseId: context?.toolUseId ?? '',
            target: targetWitness,
            urlBefore: null,
            urlAfter: null,
            status: 'ambiguous_target',
            durationMs,
          });
          return {
            content: buildAmbiguousMessage(result.query, result.candidates),
            isError: true,
          };
        }
        if (result.outcome === 'blocked_by_policy') {
          void emitBrowserEvent(context?.traceWriter, {
            tool: 'browser_act',
            action: parsed.action,
            toolUseId: context?.toolUseId ?? '',
            target: targetWitness,
            urlBefore: null,
            urlAfter: null,
            status: 'blocked_by_policy',
            durationMs,
          });
          return {
            content: `browser_act blocked: ${result.reason}`,
            isError: true,
            failureClass: 'policy-refusal',
          };
        }
      }

      // BrowserObservation — url is the post-action URL.
      void emitBrowserEvent(context?.traceWriter, {
        tool: 'browser_act',
        action: parsed.action,
        toolUseId: context?.toolUseId ?? '',
        target: targetWitness,
        urlBefore: result.url,
        urlAfter: result.url,
        status: 'ok',
        durationMs,
        ...(result.screenshotPath !== null ? { screenshotPath: result.screenshotPath } : {}),
      });
      return { content: JSON.stringify(result, null, 2) };
    } catch (err) {
      const durationMs = Date.now() - t0;
      const msg = err instanceof Error ? err.message : String(err);
      void emitBrowserEvent(context?.traceWriter, {
        tool: 'browser_act',
        action: parsed.action,
        toolUseId: context?.toolUseId ?? '',
        target: targetWitness,
        urlBefore: null,
        urlAfter: null,
        status: 'error',
        durationMs,
        error: { reason: msg, recoverable: false },
      });
      const failureClass = browserTimeoutFailureClass(err);
      return {
        content: `browser_act failed: ${msg}`,
        isError: true,
        ...(failureClass ? { failureClass } : {}),
      };
    }
  };
}

export const browserActHandler: ToolHandler = createBrowserActHandler();
