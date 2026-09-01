/**
 * Condition evaluators for the `wait_for` tool.
 *
 * Each evaluator takes a condition and an AbortSignal, then returns a
 * WaitResult indicating whether the condition is currently met. The poll
 * loop in `wait-for-poller.ts` calls these repeatedly until met or timeout.
 *
 * @module agent/tools/handlers/wait-for-conditions
 */

import * as fs from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { checkEgressTarget } from '../../../web/egress-guard.js';

/** Union of all condition shapes. */
export type WaitCondition =
  | UrlCondition
  | FileCondition
  | ProcessCondition
  | CommandCondition;

export interface UrlCondition {
  type: 'url';
  url: string;
  method?: 'HEAD' | 'GET';
  expected_status?: number;
  body_contains?: string;
}

export interface FileCondition {
  type: 'file';
  path: string;
  content_contains?: string;
}

export interface ProcessCondition {
  type: 'process';
  pid: number;
}

export interface CommandCondition {
  type: 'command';
  command: string;
  cwd?: string;
}

/** Result of a single condition evaluation. */
export interface WaitResult {
  /** True when the condition has been satisfied. */
  met: boolean;
  /** Human-readable detail for the response message. */
  detail: string;
  /** Condition-specific metadata (HTTP status, file stat, exit code, etc). */
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// URL evaluator
// ---------------------------------------------------------------------------

export async function evaluateUrl(
  cond: UrlCondition,
  signal: AbortSignal,
): Promise<WaitResult> {
  // Eagerly reject private/loopback hosts (SSRF guard).
  const verdict = await checkEgressTarget(cond.url);
  if (!verdict.allowed) {
    return { met: false, detail: `SSRF blocked: ${verdict.reason}`, data: { blocked: true } };
  }

  const method = cond.method ?? 'HEAD';
  let response: Response;
  try {
    response = await fetch(cond.url, { method, signal });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { met: false, detail: `fetch error: ${msg}` };
  }

  const { status } = response;
  const data: Record<string, unknown> = { status };

  // Status check: default = any 2xx.
  const statusOk = cond.expected_status !== undefined
    ? status === cond.expected_status
    : status >= 200 && status < 300;

  if (!statusOk) {
    return { met: false, detail: `HTTP ${status} (want ${cond.expected_status ?? '2xx'})`, data };
  }

  // Optional body substring match — only applies when method allows body.
  if (cond.body_contains !== undefined) {
    const body = await response.text().catch(() => '');
    data['bodyLength'] = body.length;
    if (!body.includes(cond.body_contains)) {
      return { met: false, detail: `body does not contain "${cond.body_contains}"`, data };
    }
  } else if (method === 'HEAD') {
    // No body to read for HEAD; drain nothing.
    await response.body?.cancel().catch(() => undefined);
  }

  return { met: true, detail: `HTTP ${status}`, data };
}

// ---------------------------------------------------------------------------
// File evaluator
// ---------------------------------------------------------------------------

export async function evaluateFile(cond: FileCondition): Promise<WaitResult> {
  let stat: { mtimeMs: number; size: number };
  try {
    const s = await fs.stat(cond.path);
    stat = { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return { met: false, detail: `file not found: ${cond.path}` };
  }

  if (cond.content_contains !== undefined) {
    let content: string;
    try {
      content = await fs.readFile(cond.path, 'utf8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { met: false, detail: `read error: ${msg}`, data: stat };
    }
    if (!content.includes(cond.content_contains)) {
      return {
        met: false,
        detail: `file exists but does not contain "${cond.content_contains}"`,
        data: stat,
      };
    }
  }

  return { met: true, detail: `file exists (${stat.size} bytes)`, data: stat };
}

// ---------------------------------------------------------------------------
// Process evaluator
// ---------------------------------------------------------------------------

export function evaluateProcess(cond: ProcessCondition): WaitResult {
  try {
    // Signal 0 tests process existence without sending a real signal.
    process.kill(cond.pid, 0);
    // kill did NOT throw → process is still alive.
    return { met: false, detail: `pid ${cond.pid} is still alive`, data: { pid: cond.pid } };
  } catch (err) {
    // ESRCH = no such process → it has exited (condition met).
    // EPERM = exists but we lack permission to signal it → still alive.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      return { met: true, detail: `pid ${cond.pid} has exited`, data: { pid: cond.pid } };
    }
    return { met: false, detail: `pid ${cond.pid} is alive (${code ?? 'unknown'})`, data: { pid: cond.pid } };
  }
}

// ---------------------------------------------------------------------------
// Command evaluator
// ---------------------------------------------------------------------------

export function evaluateCommand(cond: CommandCondition): WaitResult {
  try {
    execSync(cond.command, {
      cwd: cond.cwd,
      stdio: 'pipe',
      timeout: 30_000,
    });
    return { met: true, detail: `command exited 0`, data: { command: cond.command } };
  } catch (err) {
    const status = (err as { status?: number }).status ?? -1;
    return {
      met: false,
      detail: `command exited ${status}`,
      data: { command: cond.command, exitCode: status },
    };
  }
}
