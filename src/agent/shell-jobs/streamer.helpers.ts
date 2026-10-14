/**
 * Named helpers extracted from `startShell` to bring it under the 200-line
 * function ceiling (#1865).  All helpers take explicit parameters — no closures
 * over the outer function's locals — so they are independently testable.
 *
 * @module agent/shell-jobs/streamer.helpers
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { killProcessGroup } from '../../utils/kill-process-group.js';
import { errorMessage } from '../../utils/errors.js';
import {
  makeAnsiStripper,
  utf8SafeTruncate,
  type AnsiStripper,
  type ShellResult,
  type ShellErrorReason,
} from './streamer.js';

// ---------------------------------------------------------------------------
// Shared mutable capture state — passed by reference to helpers so every
// helper operates on the same live buffers without closures.
// ---------------------------------------------------------------------------

export interface CaptureState {
  displayCaptured: string;
  modelCaptured: string;
  displayBytes: number;
  modelBytes: number;
  truncated: boolean;
  overflowKilled: boolean;
  killedByCaller: boolean;
  settled: boolean;
  stripper: AnsiStripper;
}

export function makeCaptureState(): CaptureState {
  return {
    displayCaptured: '',
    modelCaptured: '',
    displayBytes: 0,
    modelBytes: 0,
    truncated: false,
    overflowKilled: false,
    killedByCaller: false,
    settled: false,
    stripper: makeAnsiStripper(),
  };
}

// ---------------------------------------------------------------------------
// Helper 1 – Spawn setup
// ---------------------------------------------------------------------------

export interface SpawnResult {
  proc: ChildProcess;
}

export interface SpawnFailure {
  spawnFailed: true;
  message: string;
}

/**
 * Attempt to spawn the shell child.  Returns either the live `ChildProcess`
 * or a structured failure — never throws.
 *
 * Spawn shape mirrors `createBashHandler` so the failure modes (overflow kill,
 * process-group SIGKILL, env merge) carry over identically.  The one
 * structural difference is that startShell pipes `onChunk` for live display
 * where the bash tool only collects and returns.
 */
export function spawnChild(
  command: string,
  cwd: string | undefined,
  env: Record<string, string> | undefined,
): SpawnResult | SpawnFailure {
  try {
    const proc = spawn(command, {
      shell: true,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(cwd !== undefined ? { cwd } : {}),
      ...(env !== undefined ? { env: { ...process.env, ...env } } : {}),
    });
    return { proc };
  } catch (err) {
    return { spawnFailed: true, message: errorMessage(err) };
  }
}

// ---------------------------------------------------------------------------
// Helper 2 – Stream wiring
// ---------------------------------------------------------------------------

/**
 * Wire stdout and stderr data handlers onto `proc`.  Each chunk is captured
 * into `state`, forwarded to `onChunk` (errors swallowed), then checked for
 * overflow.
 *
 * // Invariant: captureChunk is called before onChunk so the structured
 * // capture is always consistent with what the callback receives —
 * // a throwing callback cannot corrupt the capture buffers.
 *
 * // Invariant: maybeOverflow is called after onChunk so the overflow kill
 * // fires only after the live callback has seen the chunk that pushed us
 * // over the cap — preserving the same ordering as the original code.
 */
export function wireStreams(
  proc: ChildProcess,
  state: CaptureState,
  maxBytes: number,
  startedAt: number,
  timeoutHandle: ReturnType<typeof setTimeout>,
  abortHandler: () => void,
  abortSignal: AbortSignal,
  onChunk: ((chunk: Buffer, stream: 'stdout' | 'stderr') => void) | undefined,
  resolveResult: (r: ShellResult) => void,
): void {
  function captureChunk(chunk: Buffer): void {
    // Display buffer: raw bytes, ANSI preserved.
    const displayRemaining = maxBytes - state.displayBytes;
    if (displayRemaining > 0) {
      const safe =
        chunk.length <= displayRemaining
          ? chunk
          : utf8SafeTruncate(chunk, displayRemaining);
      state.displayBytes += safe.length;
      state.displayCaptured += safe.toString('utf8');
      if (chunk.length > displayRemaining) state.truncated = true;
    } else if (chunk.length > 0) {
      state.truncated = true;
    }

    // Model buffer: ANSI stripped, separate byte counter.  The stateful
    // stripper carries any partial ESC sequence residual across chunk
    // boundaries so split ANSI sequences are handled correctly (H-2).
    if (state.modelBytes < maxBytes) {
      const stripped = state.stripper.strip(chunk.toString('utf8'));
      const strippedBytes = Buffer.byteLength(stripped, 'utf8');
      const modelRemaining = maxBytes - state.modelBytes;
      if (strippedBytes <= modelRemaining) {
        state.modelCaptured += stripped;
        state.modelBytes += strippedBytes;
      } else {
        const buf = Buffer.from(stripped, 'utf8');
        state.modelCaptured += utf8SafeTruncate(buf, modelRemaining).toString('utf8');
        state.modelBytes = maxBytes;
        state.truncated = true;
      }
    }
  }

  function killGroup(pid: number): void {
    // Guard pid !== 0: `process.kill(-0, …)` would signal THIS process's
    // own group.  Node never assigns pid 0 to a live child, but the guard
    // is cheap insurance. (PR #565 review: N3.)
    if (pid !== 0 && !proc.killed) {
      killProcessGroup(pid);
    }
  }

  function maybeOverflow(): void {
    if (state.overflowKilled || state.settled) return;
    if (state.displayBytes < maxBytes && state.modelBytes < maxBytes) return;
    // Both buffers are at cap.  Mirror the model-side bash tool hardening:
    // kill and settle as soon as the cap is crossed to prevent V8 max-string
    // length exhaustion from a runaway `yes`-style command.
    state.overflowKilled = true;
    if (proc.pid !== undefined) killGroup(proc.pid);
    clearTimeout(timeoutHandle);
    abortSignal.removeEventListener('abort', abortHandler);
    resolveResult({
      exitCode: null,
      durationMs: Date.now() - startedAt,
      displayCaptured: state.displayCaptured,
      modelCaptured: state.modelCaptured,
      truncated: true,
      errorReason: 'overflow' as ShellErrorReason,
      errorMessage: `Output exceeded ${maxBytes} bytes`,
    });
  }

  proc.stdout?.on('data', (chunk: Buffer) => {
    // Invariant: capture → callback → overflow (see JSDoc above).
    captureChunk(chunk);
    try {
      onChunk?.(chunk, 'stdout');
    } catch {
      // onChunk callbacks must not break the streamer — swallow.
    }
    maybeOverflow();
  });

  proc.stderr?.on('data', (chunk: Buffer) => {
    // Invariant: capture → callback → overflow (see JSDoc above).
    captureChunk(chunk);
    try {
      onChunk?.(chunk, 'stderr');
    } catch {
      // onChunk callbacks must not break the streamer — swallow.
    }
    maybeOverflow();
  });
}

// ---------------------------------------------------------------------------
// Helper 3 – Exit / cleanup handling
// ---------------------------------------------------------------------------

/**
 * Attach `error` and `close` handlers to `proc`.  These are the terminal
 * event handlers; they always clear the timeout and abort listener before
 * settling.
 *
 * // Invariant: `error` and `close` are mutually exclusive terminal events
 * // on a single ChildProcess — Node guarantees that exactly one fires per
 * // process lifetime.  The `settled` latch in CaptureState enforces this
 * // at runtime too, so a race (overflow fires first, then `close`) is safe.
 *
 * // Invariant: `close` fires after all stdio `data` events have been
 * // delivered (Node stream ordering guarantee).  Therefore flushing the
 * // ANSI stripper in the `close` handler is always safe — every chunk has
 * // already been processed.
 */
export function wireExitHandlers(
  proc: ChildProcess,
  state: CaptureState,
  startedAt: number,
  timeoutHandle: ReturnType<typeof setTimeout>,
  abortHandler: () => void,
  abortSignal: AbortSignal,
  resolveResult: (r: ShellResult) => void,
): void {
  proc.on('error', (err) => {
    clearTimeout(timeoutHandle);
    abortSignal.removeEventListener('abort', abortHandler);
    resolveResult({
      exitCode: null,
      durationMs: Date.now() - startedAt,
      displayCaptured: state.displayCaptured,
      modelCaptured: state.modelCaptured,
      truncated: state.truncated,
      errorReason: 'spawn-failed' as ShellErrorReason,
      errorMessage: `Shell process error: ${err.message}`,
    });
  });

  proc.on('close', (code, signal) => {
    clearTimeout(timeoutHandle);
    abortSignal.removeEventListener('abort', abortHandler);
    if (state.overflowKilled || state.settled) return;

    // Flush any partial ESC residue the stripper was holding across chunks.
    // A partial escape sequence at the tail of the last chunk is never
    // printable text, so flush() discards it rather than appending raw bytes
    // to modelCaptured.  Without this, up to ~6 bytes of the last chunk tail
    // would silently disappear from modelCaptured while remaining visible in
    // displayCaptured.
    // Invariant: called here, after all `data` events, per Node ordering.
    state.stripper.flush();

    // If kill() was called by the caller, surface as 'abort' so callers can
    // disambiguate "I told you to stop" from "command exited normally with a
    // nonzero code".
    if (state.killedByCaller) {
      resolveResult({
        exitCode: code,
        durationMs: Date.now() - startedAt,
        displayCaptured: state.displayCaptured,
        modelCaptured: state.modelCaptured,
        truncated: state.truncated,
        errorReason: 'abort' as ShellErrorReason,
        errorMessage: 'Command killed',
      });
      return;
    }

    if (code !== null && code !== 0) {
      resolveResult({
        exitCode: code,
        durationMs: Date.now() - startedAt,
        displayCaptured: state.displayCaptured,
        modelCaptured: state.modelCaptured,
        truncated: state.truncated,
        errorReason: 'nonzero-exit' as ShellErrorReason,
        errorMessage: `Command exited with code ${code}`,
      });
      return;
    }

    if (code === null) {
      // Process terminated by a signal we did NOT send (segfault, OOM-killer,
      // external `kill`, or a self-signal like `kill -9 $$`).  The
      // caller-kill, timeout, abort, and overflow paths are all handled above,
      // so a null code reaching here means an unrequested signal death.
      // Surface it as a failure so the model is never told a crashed command
      // "succeeded". (PR #565 review: M2.)
      resolveResult({
        exitCode: null,
        durationMs: Date.now() - startedAt,
        displayCaptured: state.displayCaptured,
        modelCaptured: state.modelCaptured,
        truncated: state.truncated,
        errorReason: 'signal-killed' as ShellErrorReason,
        errorMessage: signal
          ? `Command killed by signal ${signal}`
          : 'Command killed by signal',
      });
      return;
    }

    resolveResult({
      exitCode: code,
      durationMs: Date.now() - startedAt,
      displayCaptured: state.displayCaptured,
      modelCaptured: state.modelCaptured,
      truncated: state.truncated,
    });
  });
}
