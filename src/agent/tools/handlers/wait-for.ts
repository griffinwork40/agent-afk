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

import path from 'node:path';
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
      // When body_contains is supplied and the caller did not explicitly set a
      // method, default to GET: HEAD responses have no body, so body_contains
      // can never match against a HEAD response.
      const hasBodyContains = input.body_contains !== undefined;
      const method = input.method ?? (hasBodyContains ? 'GET' : 'HEAD');
      if (method !== 'HEAD' && method !== 'GET') {
        throw new Error('"method" must be "HEAD" or "GET"');
      }
      const condition: WaitCondition = {
        type: 'url',
        url: input.url,
        method: method as 'HEAD' | 'GET',
        ...(input.expected_status !== undefined ? { expected_status: Number(input.expected_status) } : {}),
        ...(hasBodyContains ? { body_contains: String(input.body_contains) } : {}),
      };
      return { condition, timeoutMs, pollIntervalMs, backoff };
    }
    case 'file': {
      if (typeof input.path !== 'string' || input.path.trim() === '') {
        throw new Error('"path" is required for type "file"');
      }
      // Resolve relative paths against the session's working directory rather
      // than process.cwd() (which reflects the AFK daemon's CWD, not the
      // project root the model is operating in).
      const base = context?.resolveBase ?? context?.cwd;
      const resolvedPath =
        base !== undefined && !path.isAbsolute(input.path)
          ? path.resolve(base, input.path)
          : input.path;
      const condition: WaitCondition = {
        type: 'file',
        path: resolvedPath,
        // H-2: Pass the workspace root so evaluateFile can apply containment
        // and the read-denylist floor, matching read_file's containment model.
        workspaceRoot: base,
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

  // Eager SSRF pre-flight for URL type — fast-fail on obviously private targets
  // before entering the poll loop. The real per-hop SSRF gate is guardedFetch
  // inside evaluateUrl, which re-validates on every redirect hop and closes the
  // TOCTOU gap where a public URL 302s to a private IP after this check.
  if (condition.type === 'url') {
    const verdict = await checkEgressTarget(condition.url);
    if (!verdict.allowed) {
      return { content: `SSRF guard blocked: ${verdict.reason}`, isError: true };
    }
  }

  // Build evaluator closure for this condition.
  // The poller passes a per-poll AbortSignal (races session signal vs. deadline)
  // so each evaluator can abort a stalled I/O call rather than blocking past
  // the overall timeout.
  const evaluate = (pollSignal: AbortSignal) => {
    switch (condition.type) {
      case 'url':    return evaluateUrl(condition, pollSignal);
      // M-2: Pass pollSignal to evaluateFile so a stalled readFile call is
      // aborted by the per-poll deadline rather than blocking past the overall
      // timeout.
      case 'file':   return evaluateFile(condition, pollSignal);
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
