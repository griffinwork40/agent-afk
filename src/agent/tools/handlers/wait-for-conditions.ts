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
import { guardedFetch } from '../../../web/egress-guard.js';
import { classifyRisk } from '../../risk-classifier.js';
import { resolveAndContain } from './_cwd-utils.js';

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
  /** Workspace root used for denylist check and containment. Set by the handler context. */
  workspaceRoot?: string;
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
  // guardedFetch validates the URL before the first request AND re-validates
  // every redirect hop, closing the TOCTOU gap where a public URL 302s to a
  // private IP after the initial check. The separate assertEgressAllowed call
  // is intentionally removed: guardedFetch performs that check internally.
  const method = cond.method ?? 'HEAD';
  let response: Response;
  try {
    response = await guardedFetch(globalThis.fetch, cond.url, { method, signal });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // EgressBlockedError surfaces as "SSRF blocked:" to preserve the existing
    // detail prefix callers may match on.
    const detail = msg.startsWith('refusing to') ? `SSRF blocked: ${msg}` : `fetch error: ${msg}`;
    return { met: false, detail, data: msg.startsWith('refusing to') ? { blocked: true } : undefined };
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

export async function evaluateFile(cond: FileCondition, signal?: AbortSignal): Promise<WaitResult> {
  // H-2: Apply the same read-denylist and workspace-containment checks used by
  // read_file so the model cannot read /etc/passwd, ~/.ssh/id_rsa, etc. via
  // wait_for. resolveAndContain throws on a denylist hit or a path outside the
  // workspace root, which we surface as a met:false result rather than a thrown
  // error so the poll loop can report it cleanly.
  let safePath: string;
  try {
    // Build a minimal synthetic context carrying workspaceRoot as resolveBase
    // so resolveAndContain applies containment (when set) and the read-denylist
    // floor (always). When workspaceRoot is absent the session is unconfined and
    // only the denylist floor fires, matching read_file's unconfined behaviour.
    const ctx = cond.workspaceRoot
      ? { resolveBase: cond.workspaceRoot, cwd: cond.workspaceRoot }
      : undefined;
    safePath = resolveAndContain(cond.path, ctx, 'read');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { met: false, detail: `path rejected: ${msg}`, data: { blocked: true } };
  }

  let stat: { mtimeMs: number; size: number };
  try {
    const s = await fs.stat(safePath);
    stat = { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return { met: false, detail: `file not found: ${cond.path}` };
  }

  if (cond.content_contains !== undefined) {
    let content: string;
    try {
      // M-2: pass the per-poll AbortSignal so a stalled read is aborted with
      // the poll deadline, not left hanging past the overall timeout.
      content = await fs.readFile(safePath, { encoding: 'utf8', signal });
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
  // M-1: Restrict PIDs to positive integers > 1. PID 0 and PID 1 are special
  // system processes (PID 0 = scheduler, PID 1 = init/launchd). Probing them
  // via kill(pid, 0) is an information-disclosure channel and serves no
  // legitimate wait_for use case. Restricting PID > 1 is a pragmatic boundary;
  // full child-process scoping is a known limitation deferred to a PID registry
  // (plan-mode classification can block this condition type if needed).
  if (!Number.isInteger(cond.pid) || cond.pid <= 1) {
    return {
      met: false,
      detail: `pid ${cond.pid} is not a valid target (must be integer > 1)`,
      data: { pid: cond.pid, blocked: true },
    };
  }

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
  // H-1: Apply the same risk classification used for bash commands. Only 'safe'
  // commands are allowed — medium-risk commands (git push, npm install, mv, cp,
  // mkdir, shell redirects) and unknown commands (which default to 'medium') are
  // blocked. Previously, only 'high' was blocked, allowing all medium-risk and
  // unknown commands through execSync unguarded.
  const risk = classifyRisk('bash', { command: cond.command }, { cwd: cond.cwd ?? process.cwd() });
  if (risk !== 'safe') {
    return {
      met: false,
      detail: `command blocked by risk classifier (${risk} risk): ${cond.command}`,
      data: { command: cond.command, blocked: true },
    };
  }

  try {
    execSync(cond.command, {
      cwd: cond.cwd,
      stdio: 'pipe',
      timeout: 30_000,
    });
    return { met: true, detail: `command exited 0`, data: { command: cond.command } };
  } catch (err) {
    // L-2: Detect execSync timeout (killed: true + signal: 'SIGTERM') and report
    // it distinctly so callers know the command ran but was too slow, not that
    // it errored.
    const e = err as { status?: number; killed?: boolean; signal?: string };
    if (e.killed === true && e.signal === 'SIGTERM') {
      return {
        met: false,
        detail: `command timed out (30s limit)`,
        data: { command: cond.command, timedOut: true },
      };
    }
    const status = e.status ?? -1;
    return {
      met: false,
      detail: `command exited ${status}`,
      data: { command: cond.command, exitCode: status },
    };
  }
}
