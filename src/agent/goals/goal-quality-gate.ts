/**
 * Phase 2a quality gates for verified goal completion.
 *
 * Runs a list of shell commands (tests, lint, build) that must all exit 0
 * before a goal is considered complete. Each check produces a `GateResult`
 * carrying the command, exit code, a retained tail of stdout+stderr, and a
 * pass/fail status. The aggregate `GateReport` maps every check to its result
 * plus a top-level `passed` boolean.
 *
 * Design decisions
 * ----------------
 * - **Deterministic only.** Phase 2a is shell checks only — no LLM judge.
 *   The judge (Phase 2c) will review the evidence packet produced here.
 * - **Configured via `AFK_GOAL_CHECKS`.** A colon-separated list of shell
 *   commands to run, e.g. `pnpm test:pnpm lint`. When the env var is unset
 *   the check list is empty and the gate passes vacuously (consistent with
 *   the issue spec: "not checked" is a valid gate state).
 * - **Output tail retained.** Each command captures up to `MAX_OUTPUT_BYTES`
 *   of combined stdout+stderr so the evidence packet is self-contained.
 * - **Timeout per command.** Each command is capped at `DEFAULT_TIMEOUT_MS`
 *   (60 s) to prevent an unattended run from hanging indefinitely.
 * - **Injectable for tests.** `runGoalQualityGates` accepts an optional
 *   `options` bag that lets tests inject a custom `spawnFn` and suppress real
 *   child processes.
 * - **Cross-platform shell.** Uses `resolveShell()` (not a hardcoded binary)
 *   so Windows CI routes through Git Bash / PowerShell correctly.
 *
 * @module agent/goals/goal-quality-gate
 */

import { spawnSync } from 'node:child_process';
import { resolveShell } from '../../utils/resolve-shell.js';

/** Maximum bytes of combined stdout+stderr retained per gate command. */
export const MAX_OUTPUT_BYTES = 4096;

/** Per-command timeout in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 60_000;

/** Separator used to split `AFK_GOAL_CHECKS` into individual commands. */
export const CHECKS_SEPARATOR = ':';

/** Status of a single quality-gate check. */
export type GateStatus = 'passed' | 'failed' | 'not_checked';

/** Result for one shell command in the gate suite. */
export interface GateResult {
  /** The shell command that was run (or was configured but skipped). */
  command: string;
  status: GateStatus;
  /** Process exit code, or null when the command timed out or was not executed. */
  exitCode: number | null;
  /** Retained tail of combined stdout+stderr (up to MAX_OUTPUT_BYTES). */
  output: string;
  /** Wall-clock milliseconds the command took, or null if not executed. */
  durationMs: number | null;
}

/** Aggregate result for the full gate suite for one goal. */
export interface GateReport {
  /** True iff every configured command exited 0, or no commands configured. */
  passed: boolean;
  /** Per-command results in the order they were run. */
  results: GateResult[];
  /** ISO timestamp when the gate run completed. */
  completedAt: string;
  /** The git commit SHA present in the working tree at gate time, if available. */
  commitSha: string | null;
}

/**
 * Minimal return shape for the injectable spawn function.
 * Using `encoding: 'utf8'` throughout avoids a dependency on the Node global
 * `Buffer` type, which is not available under `"lib": ["ES2022"]`.
 */
export interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

/**
 * Injectable spawn function. The default wraps Node's `spawnSync` with
 * `encoding: 'utf8'`. Tests supply a stub to avoid forking real processes.
 */
export type SpawnFn = (
  command: string,
  opts: {
    shell: string | boolean;
    cwd: string;
    timeout: number;
    encoding: 'utf8';
    stdio: ['ignore', 'pipe', 'pipe'];
  },
) => SpawnResult;

/** Options bag for `runGoalQualityGates` — primarily for test injection. */
export interface RunGatesOptions {
  /**
   * Override the shell-spawn function. When omitted the real `spawnSync` is
   * used. Tests supply a stub to avoid forking real processes.
   */
  spawnFn?: SpawnFn;
  /**
   * Override the per-command timeout in milliseconds.
   * Defaults to `DEFAULT_TIMEOUT_MS`.
   */
  timeoutMs?: number;
  /**
   * Override the working directory for all commands.
   * Defaults to `process.cwd()`.
   */
  cwd?: string;
}

/**
 * Parse `AFK_GOAL_CHECKS` value into an array of trimmed, non-empty commands.
 *
 * The separator is `:`. Commands that contain a literal colon must be encoded
 * differently — this is a known limitation of the single-character separator.
 * An empty or unset value returns `[]`.
 *
 * @param raw - The raw value of `AFK_GOAL_CHECKS`, or `undefined`.
 */
export function parseChecksEnv(raw: string | undefined): string[] {
  if (!raw || raw.trim() === '') return [];
  return raw
    .split(CHECKS_SEPARATOR)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Retrieve the HEAD commit SHA for the working tree at `cwd`.
 * Returns `null` when git is unavailable or the directory is not a repo.
 */
function resolveCommitSha(cwd: string, spawnFn: SpawnFn): string | null {
  try {
    const { shell } = resolveShell();
    const result = spawnFn('git rev-parse HEAD', {
      shell,
      cwd,
      timeout: 5_000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.status === 0) {
      return result.stdout.trim() || null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Truncate `text` to at most `maxBytes` UTF-16 code units (approximate byte
 * budget for ASCII output). When truncated a marker line is prepended so
 * reviewers know the head was dropped — the tail is more useful for diagnosing
 * failures.
 */
function truncateTail(text: string, maxBytes: number): string {
  if (text.length <= maxBytes) return text;
  const tail = text.slice(text.length - maxBytes);
  return `[... truncated, showing last ${maxBytes} chars ...]\n${tail}`;
}

/**
 * Default spawn wrapper around Node's `spawnSync` with `encoding: 'utf8'`.
 * Invariant: the command string is passed directly to the shell; the args
 * array is always empty because `shell: true` (or `shell: <path>`) handles
 * argument parsing via the platform shell.
 */
const defaultSpawnFn: SpawnFn = (command, opts) => {
  const result = spawnSync(command, [], {
    shell: opts.shell,
    cwd: opts.cwd,
    timeout: opts.timeout,
    encoding: opts.encoding,
    stdio: opts.stdio,
  });
  return {
    status: result.status,
    stdout: (result.stdout as string) ?? '',
    stderr: (result.stderr as string) ?? '',
    error: result.error,
  };
};

/**
 * Run the configured quality-gate checks for a goal.
 *
 * Each command in `checks` is executed via the platform shell (resolved by
 * `resolveShell()`) with a timeout. A command that times out is recorded as
 * `failed` with exit code `null`. An empty `checks` array returns a vacuously
 * passing `GateReport` with zero results.
 *
 * @param checks - List of shell commands to run (from `parseChecksEnv`).
 * @param options - Injectable options (spawn fn, timeout, cwd).
 * @returns `GateReport` with per-command results and an aggregate `passed`.
 */
export async function runGoalQualityGates(
  checks: readonly string[],
  options: RunGatesOptions = {},
): Promise<GateReport> {
  const spawnFn = options.spawnFn ?? defaultSpawnFn;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cwd = options.cwd ?? process.cwd();

  const commitSha = resolveCommitSha(cwd, spawnFn);

  if (checks.length === 0) {
    return {
      passed: true,
      results: [],
      completedAt: new Date().toISOString(),
      commitSha,
    };
  }

  const { shell } = resolveShell();
  const results: GateResult[] = [];

  for (const command of checks) {
    const start = Date.now();
    let result: SpawnResult;

    try {
      result = spawnFn(command, {
        shell,
        cwd,
        timeout: timeoutMs,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      // Unexpected spawn error — treat as failed.
      const durationMs = Date.now() - start;
      results.push({
        command,
        status: 'failed',
        exitCode: null,
        output: err instanceof Error ? err.message : String(err),
        durationMs,
      });
      continue;
    }

    const durationMs = Date.now() - start;

    // Merge stdout + stderr for the retained evidence tail.
    const combined = result.stdout + result.stderr;
    const output = truncateTail(combined, MAX_OUTPUT_BYTES);

    // Invariant: spawnSync sets status=null when the process is killed by a
    // signal or when the timeout fires. We additionally check the error message
    // so a stub-injected ETIMEDOUT error (status=null, error set) is detected.
    const errMsg = result.error?.message?.toLowerCase() ?? '';
    const timedOut =
      result.status === null &&
      (result.error !== undefined ||
        errMsg.includes('etimedout') ||
        errMsg.includes('timed out'));

    const exitCode = result.status;
    const status: GateStatus = exitCode === 0 ? 'passed' : 'failed';

    results.push({
      command,
      status: timedOut ? 'failed' : status,
      exitCode: timedOut ? null : exitCode,
      output: timedOut ? `[timed out after ${timeoutMs}ms]\n${output}` : output,
      durationMs,
    });
  }

  const passed = results.every((r) => r.status === 'passed');

  return {
    passed,
    results,
    completedAt: new Date().toISOString(),
    commitSha,
  };
}
