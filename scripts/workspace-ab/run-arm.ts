/**
 * Run a single A/B experiment arm — one invocation of `afk chat`.
 *
 * Keeps stdout and stderr separate, treats any nonzero exit as a failure,
 * and parses trace identity (sessionId/witnessLabel/tracePath) from JSON
 * stdout rather than racing against concurrent sessions via `ls -t`.
 *
 * All side effects (spawn, fs, clock) are injectable so this module can be
 * unit-tested without a real afk binary or live LLM calls.
 *
 * @module scripts/workspace-ab/run-arm
 */

import type { SpawnOptionsWithStdioTuple } from 'node:child_process';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ─── Public types ──────────────────────────────────────────────────────────

/** Which experimental arm this invocation is for. */
export type ArmId = 'control' | 'treatment';

export interface ArmOptions {
  /** Absolute path to the afk CLI entry point (e.g. dist/cli/index.js). */
  afkBin: string;
  /** Model to pass via -m. */
  model: string;
  /** Max conversation turns. */
  maxTurns: number;
  /** Budget ceiling in USD. */
  maxBudgetUsd: number;
  /** The experiment prompt (byte-identical across both arms). */
  prompt: string;
  /** Directory into which stdout/stderr capture files are written. */
  outputDir: string;
  /** Arm identifier — controls whether AFK_WORKSPACE_DISABLED is injected. */
  arm: ArmId;
  /** Trial index (0-based) for unique output file names. */
  trialIndex: number;
  /** Trial order label (e.g. "control-first" | "treatment-first"). */
  trialOrder: string;
}

export interface ArmResult {
  arm: ArmId;
  trialIndex: number;
  trialOrder: string;
  exitCode: number;
  /** Whether the arm succeeded (exitCode === 0). */
  success: boolean;
  /** Absolute path to the captured stdout file. */
  stdoutPath: string;
  /** Absolute path to the captured stderr file. */
  stderrPath: string;
  /** Session identifier from JSON output — present only when success && trace was enabled. */
  sessionId?: string;
  /** Witness directory label from JSON output (same as trace dir basename). */
  witnessLabel?: string;
  /** Absolute path to the trace.jsonl file from JSON output. */
  tracePath?: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** Error message if the arm errored out (non-zero exit). */
  errorMessage?: string;
}

// ─── Injectable side-effect interfaces ────────────────────────────────────

export interface SpawnFn {
  (
    command: string,
    args: string[],
    options: SpawnOptionsWithStdioTuple<'pipe', 'pipe', 'pipe'>,
  ): {
    stdout: NodeJS.ReadableStream;
    stderr: NodeJS.ReadableStream;
    on(event: 'close', cb: (code: number | null) => void): void;
  };
}

export interface FsWriteFn {
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
  writeFileSync(path: string, data: string): void;
}

export interface ClockFn {
  now(): number;
}

// ─── Default implementations ────────────────────────────────────────────────

const defaultSpawn: SpawnFn = (command, args, options) =>
  spawn(command, args, options as Parameters<typeof spawn>[2]) as ReturnType<SpawnFn>;

const defaultFs: FsWriteFn = {
  mkdirSync: (p, opts) => mkdirSync(p, opts),
  writeFileSync: (p, d) => writeFileSync(p, d),
};

const defaultClock: ClockFn = { now: () => Date.now() };

// ─── Core runner ──────────────────────────────────────────────────────────

/**
 * Run one arm of the A/B experiment.
 *
 * Resolves when the child process exits. Rejects only on spawn failure (not
 * on nonzero exit — those are captured in `ArmResult.success`).
 */
export async function runArm(
  opts: ArmOptions,
  deps: {
    spawnFn?: SpawnFn;
    fs?: FsWriteFn;
    clock?: ClockFn;
  } = {},
): Promise<ArmResult> {
  const { arm, trialIndex, trialOrder, afkBin, model, maxTurns, maxBudgetUsd, prompt, outputDir } =
    opts;
  const spawnFn = deps.spawnFn ?? defaultSpawn;
  const fs = deps.fs ?? defaultFs;
  const clock = deps.clock ?? defaultClock;

  fs.mkdirSync(outputDir, { recursive: true });

  const tag = `trial-${trialIndex}-${arm}`;
  const stdoutPath = join(outputDir, `${tag}-stdout.json`);
  const stderrPath = join(outputDir, `${tag}-stderr.txt`);

  // Build child environment: control arm disables the workspace; treatment
  // arm runs with the workspace enabled (env var absent).
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  if (arm === 'control') {
    childEnv['AFK_WORKSPACE_DISABLED'] = '1';
  } else {
    delete childEnv['AFK_WORKSPACE_DISABLED'];
  }

  const args = [
    afkBin,
    'chat',
    '-m', model,
    '--max-turns', String(maxTurns),
    '--max-budget-usd', String(maxBudgetUsd),
    '-f', 'json',
    prompt,
  ];

  const startMs = clock.now();

  return new Promise((resolve, reject) => {
    let child: ReturnType<SpawnFn>;
    try {
      child = spawnFn('node', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: childEnv,
      } as SpawnOptionsWithStdioTuple<'pipe', 'pipe', 'pipe'>);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('close', (code: number | null) => {
      const durationMs = clock.now() - startMs;
      const exitCode = code ?? 1;
      const stdoutText = Buffer.concat(stdoutChunks).toString('utf8');
      const stderrText = Buffer.concat(stderrChunks).toString('utf8');

      // Persist raw capture files — always written, even on failure.
      try {
        fs.writeFileSync(stdoutPath, stdoutText);
        fs.writeFileSync(stderrPath, stderrText);
      } catch {
        // best-effort capture; don't mask the real result
      }

      if (exitCode !== 0) {
        const errorMessage = `arm=${arm} trial=${trialIndex} exited with code ${exitCode}`;
        resolve({
          arm, trialIndex, trialOrder, exitCode, success: false,
          stdoutPath, stderrPath, durationMs, errorMessage,
        });
        return;
      }

      // Parse JSON output to extract trace identity.
      const identity = parseTraceIdentity(stdoutText);

      resolve({
        arm, trialIndex, trialOrder, exitCode: 0, success: true,
        stdoutPath, stderrPath, durationMs,
        sessionId: identity.sessionId,
        witnessLabel: identity.witnessLabel,
        tracePath: identity.tracePath,
      });
    });
  });
}

// ─── JSON identity extraction ─────────────────────────────────────────────

interface TraceIdentity {
  sessionId?: string;
  witnessLabel?: string;
  tracePath?: string;
}

/**
 * Parse `sessionId`, `witnessLabel`, and `tracePath` from the JSON blob
 * emitted by `afk chat -f json`.  Returns an empty object when the stdout
 * cannot be parsed or the fields are absent (e.g. AFK_TRACE_DISABLED=1).
 */
export function parseTraceIdentity(stdout: string): TraceIdentity {
  const trimmed = stdout.trim();
  if (!trimmed) return {};
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    return {
      sessionId: typeof obj['sessionId'] === 'string' ? obj['sessionId'] : undefined,
      witnessLabel: typeof obj['witnessLabel'] === 'string' ? obj['witnessLabel'] : undefined,
      tracePath: typeof obj['tracePath'] === 'string' ? obj['tracePath'] : undefined,
    };
  } catch {
    return {};
  }
}
