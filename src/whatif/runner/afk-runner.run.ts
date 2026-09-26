/**
 * Episode child-process execution for the AFK runner.
 *
 * Extracted from `afk-runner.ts` to keep that file within the 350-line
 * ceiling. Owns spawn, stdout capture, stdout JSON parsing, timeout/signal
 * enforcement, and stderr tail collection.
 *
 * @module whatif/runner/afk-runner.run
 */

import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawn as nodeSpawn } from 'node:child_process';
import type { EpisodeTrace } from '../types.js';

export type SpawnFn = typeof nodeSpawn;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max stderr bytes kept for error messages (redacted). */
const STDERR_TAIL_BYTES = 500;

/** Delay between SIGTERM and SIGKILL on timeout. */
const SIGKILL_DELAY_MS = 5_000;

/** Regex that matches Anthropic API key patterns for redaction. */
const SK_ANT_PATTERN = /sk-ant-[A-Za-z0-9_-]+/g;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Redact Anthropic credentials from error strings. */
function redactSecrets(text: string): string {
  return text.replace(SK_ANT_PATTERN, '[REDACTED]');
}

/**
 * Extract the LAST top-level JSON object from stdout.
 *
 * `afk chat --format json` prints a pretty-printed JSON object as its last
 * output line, but may emit other text before it (spinners, warnings written
 * to stdout by mistake). We scan for the last `{…}` block.
 */
function extractLastJson(stdout: string): unknown | null {
  // Find all positions of top-level '{' and match their closing '}'.
  let last: unknown = null;
  let depth = 0;
  let start = -1;
  for (let i = 0; i < stdout.length; i++) {
    const ch = stdout[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) {
          const candidate = stdout.slice(start, i + 1);
          try { last = JSON.parse(candidate); } catch { /* skip */ }
        }
      }
    }
  }
  return last;
}

// ---------------------------------------------------------------------------
// Spawn and wait
// ---------------------------------------------------------------------------

export interface RunEpisodeChildArgs {
  command: string;
  spawnArgs: string[];
  spawnOptions: SpawnOptions;
  spawnImpl: SpawnFn;
  episodeId: string;
  envLabel: 'baseline' | 'candidate';
  sample: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

interface ChildResult {
  stdout: string;
  stderrTail: string;
  exitCode: number;
  timedOut: boolean;
}

/** Spawn the child and wait for it to exit, enforcing timeout and signal. */
async function waitForChild(
  child: ChildProcess,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ChildResult> {
  return new Promise<ChildResult>((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;

    const settle = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      const stderrRaw = Buffer.concat(stderrChunks).toString('utf-8');
      const tail = stderrRaw.slice(-STDERR_TAIL_BYTES);
      resolve({ stdout, stderrTail: tail, exitCode, timedOut });
    };

    const sendSigterm = (): void => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* already exited */ }
    };
    const sendSigkill = (): void => {
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
    };

    const timeoutTimer = setTimeout(() => {
      sendSigterm();
      // Give the process a chance to clean up before SIGKILL.
      setTimeout(sendSigkill, SIGKILL_DELAY_MS);
    }, timeoutMs);

    // Separate kill timer ref for cleanup; reuse the same handle.
    let killTimer: ReturnType<typeof setTimeout> = timeoutTimer;

    // AbortSignal support.
    const onAbort = (): void => {
      sendSigterm();
      setTimeout(sendSigkill, SIGKILL_DELAY_MS);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBytes < STDERR_TAIL_BYTES * 4) {
        stderrChunks.push(chunk);
        stderrBytes += chunk.length;
      }
    });

    child.on('close', (code) => {
      clearTimeout(timeoutTimer);
      signal?.removeEventListener('abort', onAbort);
      settle(code ?? 1);
    });
    child.on('error', () => {
      clearTimeout(timeoutTimer);
      signal?.removeEventListener('abort', onAbort);
      settle(1);
    });

    // Suppress the unused-variable warning; killTimer is assigned but only
    // referenced inside settle().
    void killTimer;
  });
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

/**
 * Spawn the chat child, wait for it to finish, and parse the result into an
 * {@link EpisodeTrace}.
 *
 * On timeout, nonzero exit, or unparsable output the returned trace has
 * `error` set instead of throwing.
 */
export async function runEpisodeChild(args: RunEpisodeChildArgs): Promise<EpisodeTrace> {
  const { command, spawnArgs, spawnOptions, spawnImpl, episodeId, envLabel, sample, timeoutMs, signal } = args;

  const startMs = Date.now();
  const child = spawnImpl(command, spawnArgs, spawnOptions);
  const { stdout, stderrTail, exitCode, timedOut } = await waitForChild(child, timeoutMs, signal);
  const durationMs = Date.now() - startMs;

  if (timedOut) {
    return {
      episodeId,
      env: envLabel,
      sample,
      text: '',
      tools: [],
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      durationMs,
      error: `Episode timed out after ${timeoutMs}ms. stderr: ${redactSecrets(stderrTail)}`,
    };
  }

  const parsed = extractLastJson(stdout);

  if (exitCode !== 0 || parsed === null || typeof parsed !== 'object') {
    const errMsg = exitCode !== 0
      ? `afk chat exited ${exitCode}. stderr: ${redactSecrets(stderrTail)}`
      : `afk chat output did not contain a JSON object. stderr: ${redactSecrets(stderrTail)}`;
    return {
      episodeId,
      env: envLabel,
      sample,
      text: '',
      tools: [],
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      durationMs,
      error: errMsg,
    };
  }

  const obj = parsed as Record<string, unknown>;
  return {
    episodeId,
    env: envLabel,
    sample,
    text: typeof obj['message'] === 'string' ? obj['message'] : '',
    tools: [],
    costUsd: typeof obj['costUsd'] === 'number' ? obj['costUsd'] : 0,
    inputTokens: typeof obj['inputTokens'] === 'number' ? obj['inputTokens'] : 0,
    outputTokens: typeof obj['outputTokens'] === 'number' ? obj['outputTokens'] : 0,
    durationMs: typeof obj['durationMs'] === 'number' ? obj['durationMs'] : durationMs,
  };
}
