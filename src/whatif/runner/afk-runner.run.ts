/**
 * Episode child-process execution for the AFK runner.
 *
 * Extracted from `afk-runner.ts` to keep that file within the 350-line
 * ceiling. Owns spawn, stdout capture, NDJSON parsing, timeout/signal
 * enforcement, and stderr tail collection.
 *
 * Output format: `afk chat --format stream-json` (NDJSON, one OutputEvent per
 * line). This gives the judge ALL assistant text — including narration written
 * between tool calls — not just the final message. Text segments are joined
 * with lightweight `[tool: <name>]` markers where tool calls occurred so the
 * judge can see the full reasoning flow in order.
 *
 * Stream parsing lives in `afk-runner.stream.ts` and is re-exported here.
 *
 * Cost and token counts come from the terminal `done` event, whose
 * `usage.input_tokens` is summed over the turn's model rounds. On the
 * anthropic-direct provider that count is uncached input only: cache reads
 * and cache writes are reported separately (`cache_read_input_tokens`,
 * `cache_creation_input_tokens`) and are not included in `inputTokens`.
 * OpenAI-compatible providers instead report a prompt total that includes
 * cached tokens.
 *
 * @module whatif/runner/afk-runner.run
 */

import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawn as nodeSpawn } from 'node:child_process';
import type { EpisodeTrace } from '../types.js';
import { accumulateStreamJson } from './afk-runner.stream.js';

export { accumulateStreamJson } from './afk-runner.stream.js';
export type { AccumulateResult, StreamDoneMeta } from './afk-runner.stream.js';

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

    // killTimer tracks whichever timer is currently live: initially the SIGTERM
    // deadline; reassigned to the SIGKILL follow-up once SIGTERM fires so that
    // settle() always clears the right timer regardless of when the child exits.
    let killTimer: ReturnType<typeof setTimeout>;

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

    killTimer = setTimeout(() => {
      sendSigterm();
      // Track the SIGKILL follow-up so settle() can clear it if the child
      // exits after SIGTERM but before SIGKILL_DELAY_MS elapses.
      clearTimeout(killTimer);
      killTimer = setTimeout(sendSigkill, SIGKILL_DELAY_MS);
    }, timeoutMs);

    // AbortSignal support.
    const onAbort = (): void => {
      // Cancel the SIGTERM deadline timer (or the SIGKILL follow-up, if the
      // timeout path already fired) so only one SIGKILL timer is ever live.
      clearTimeout(killTimer);
      sendSigterm();
      killTimer = setTimeout(sendSigkill, SIGKILL_DELAY_MS);
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
      signal?.removeEventListener('abort', onAbort);
      settle(code ?? 1);
    });
    child.on('error', () => {
      signal?.removeEventListener('abort', onAbort);
      settle(1);
    });
  });
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

/**
 * Spawn the chat child (using `--format stream-json`), wait for it to finish,
 * and parse the NDJSON output into an {@link EpisodeTrace}.
 *
 * `EpisodeTrace.text` contains ALL assistant text in document order, with
 * lightweight `[tool: <name>]` markers inserted where tool calls occurred.
 * This gives the judge full narration, not just the final assistant message.
 *
 * Error conditions:
 *   - timeout: error set with timeout description.
 *   - nonzero exit: error set with exit code + redacted stderr.
 *   - exit 0 but no `done` event seen: error set. This means a truncated
 *     stream (crash, OOM, network cut) whose partial text would skew cost
 *     accounting and judging, so run.verify.ts counts it as a failed episode
 *     instead of a good trace with zero cost.
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

  if (exitCode !== 0) {
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
      error: `afk chat exited ${exitCode}. stderr: ${redactSecrets(stderrTail)}`,
    };
  }

  const { text, meta, doneSeen } = accumulateStreamJson(stdout);

  if (!doneSeen) {
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
      error: `afk chat stream ended without a done event. stderr: ${redactSecrets(stderrTail)}`,
    };
  }

  return {
    episodeId,
    env: envLabel,
    sample,
    text,
    tools: [],
    costUsd: meta.costUsd,
    inputTokens: meta.inputTokens,
    outputTokens: meta.outputTokens,
    durationMs: meta.durationMs ?? durationMs,
  };
}
