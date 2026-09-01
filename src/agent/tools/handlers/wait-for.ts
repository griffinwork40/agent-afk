/**
 * Handler for the `wait_for` tool.
 *
 * Blocks on an external condition (URL, file, process, or command) without
 * consuming model turns — the poll loop runs entirely in Node. Returns a
 * structured result indicating whether the condition was met, timed out, or
 * cancelled. Timeout is NOT treated as an error so the model can decide to
 * retry or give up.
 *
 * @module agent/tools/handlers/wait-for
 */

import type { ToolHandler, ToolHandlerContext } from '../types.js';
import { checkEgressTarget } from '../../../web/egress-guard.js';
import {
  evaluateUrl,
  evaluateFile,
  evaluateProcess,
  evaluateCommand,
} from './wait-for-conditions.js';
import type { WaitCondition } from './wait-for-conditions.js';
import {
  pollUntil,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  MIN_POLL_INTERVAL_MS,
} from './wait-for-poller.js';

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------

interface WaitForInput {
  type?: unknown;
  // URL
  url?: unknown;
  method?: unknown;
  expected_status?: unknown;
  body_contains?: unknown;
  // File
  path?: unknown;
  content_contains?: unknown;
  // Process
  pid?: unknown;
  // Command
  command?: unknown;
  // Common
  timeout_ms?: unknown;
  poll_interval_ms?: unknown;
  backoff?: unknown;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function parseInput(
  raw: unknown,
  context: ToolHandlerContext | undefined,
): { condition: WaitCondition; timeoutMs: number; pollIntervalMs: number; backoff: 'none' | 'linear' | 'exponential' } {
  if (typeof raw !== 'object' || raw === null) throw new Error('Input must be an object');
  const input = raw as WaitForInput;

  const type = input.type;
  if (typeof type !== 'string') throw new Error('"type" is required and must be a string');

  // Common options
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (input.timeout_ms !== undefined) {
    if (typeof input.timeout_ms !== 'number' || !Number.isFinite(input.timeout_ms)) {
      throw new Error('"timeout_ms" must be a finite number');
    }
    timeoutMs = Math.min(Math.max(0, input.timeout_ms), MAX_TIMEOUT_MS);
  }

  let pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
  if (input.poll_interval_ms !== undefined) {
    if (typeof input.poll_interval_ms !== 'number' || !Number.isFinite(input.poll_interval_ms)) {
      throw new Error('"poll_interval_ms" must be a finite number');
    }
    pollIntervalMs = Math.max(MIN_POLL_INTERVAL_MS, input.poll_interval_ms);
  }

  const VALID_BACKOFFS = ['none', 'linear', 'exponential'] as const;
  let backoff: 'none' | 'linear' | 'exponential' = 'none';
  if (input.backoff !== undefined) {
    if (!VALID_BACKOFFS.includes(input.backoff as 'none')) {
      throw new Error(`"backoff" must be one of: ${VALID_BACKOFFS.join(', ')}`);
    }
    backoff = input.backoff as typeof backoff;
  }

  // Type-specific validation
  switch (type) {
    case 'url': {
      if (typeof input.url !== 'string' || input.url.trim() === '') {
        throw new Error('"url" is required for type "url"');
      }
      const method = input.method ?? 'HEAD';
      if (method !== 'HEAD' && method !== 'GET') {
        throw new Error('"method" must be "HEAD" or "GET"');
      }
      const condition: WaitCondition = {
        type: 'url',
        url: input.url,
        method: method as 'HEAD' | 'GET',
        ...(input.expected_status !== undefined ? { expected_status: Number(input.expected_status) } : {}),
        ...(input.body_contains !== undefined ? { body_contains: String(input.body_contains) } : {}),
      };
      return { condition, timeoutMs, pollIntervalMs, backoff };
    }
    case 'file': {
      if (typeof input.path !== 'string' || input.path.trim() === '') {
        throw new Error('"path" is required for type "file"');
      }
      const condition: WaitCondition = {
        type: 'file',
        path: input.path,
        ...(input.content_contains !== undefined ? { content_contains: String(input.content_contains) } : {}),
      };
      return { condition, timeoutMs, pollIntervalMs, backoff };
    }
    case 'process': {
      if (typeof input.pid !== 'number' || !Number.isInteger(input.pid) || input.pid <= 0) {
        throw new Error('"pid" is required for type "process" and must be a positive integer');
      }
      const condition: WaitCondition = { type: 'process', pid: input.pid };
      return { condition, timeoutMs, pollIntervalMs, backoff };
    }
    case 'command': {
      if (typeof input.command !== 'string' || input.command.trim() === '') {
        throw new Error('"command" is required for type "command"');
      }
      const cwd = context?.resolveBase ?? context?.cwd;
      const condition: WaitCondition = {
        type: 'command',
        command: input.command,
        ...(cwd !== undefined ? { cwd } : {}),
      };
      return { condition, timeoutMs, pollIntervalMs, backoff };
    }
    default:
      throw new Error(`Unknown type "${type}". Must be one of: url, file, process, command`);
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const waitForHandler: ToolHandler = async (
  input: unknown,
  signal: AbortSignal,
  context?: ToolHandlerContext,
) => {
  let parsed: ReturnType<typeof parseInput>;
  try {
    parsed = parseInput(input, context);
  } catch (err) {
    return {
      content: err instanceof Error ? err.message : String(err),
      isError: true,
    };
  }

  const { condition, timeoutMs, pollIntervalMs, backoff } = parsed;

  // Eager SSRF check for URL type — fail fast before entering the poll loop.
  if (condition.type === 'url') {
    const verdict = await checkEgressTarget(condition.url);
    if (!verdict.allowed) {
      return { content: `SSRF guard blocked: ${verdict.reason}`, isError: true };
    }
  }

  // Build evaluator closure for this condition.
  const evaluate = () => {
    switch (condition.type) {
      case 'url':    return evaluateUrl(condition, signal);
      case 'file':   return evaluateFile(condition);
      case 'process': return Promise.resolve(evaluateProcess(condition));
      case 'command': return Promise.resolve(evaluateCommand(condition));
    }
  };

  const pollResult = await pollUntil(evaluate, {
    timeout_ms: timeoutMs,
    poll_interval_ms: pollIntervalMs,
    backoff,
    signal,
  });

  const summary =
    `Wait ${pollResult.status}: ${condition.type} condition ` +
    `(${pollResult.elapsed_ms}ms elapsed, ${pollResult.attempts} attempt${pollResult.attempts === 1 ? '' : 's'})` +
    (pollResult.result ? ` — ${pollResult.result.detail}` : '') +
    (pollResult.error ? ` — error: ${pollResult.error}` : '');

  return {
    content: summary,
    isError: pollResult.status === 'failed',
  };
};
