/**
 * Streaming shell executor for user-typed `!cmd` passthrough in the REPL.
 *
 * Spawns a shell child with the same hardening as the model-facing bash
 * tool (`detached: true` process group, SIGKILL on timeout/abort,
 * mid-stream byte cap) but exposes chunks via `onChunk` so the REPL can
 * route output through `commitAbove()` while the command runs — the
 * collect-then-flush model used by the model-facing tool would feel hung
 * for any command longer than ~2s.
 *
 * Two output buffers are maintained internally:
 *   1. `displayCaptured` — raw bytes (ANSI passed through unchanged) so
 *      `/sh show <id>` and tail-readers see what the user actually saw on
 *      screen. Capped at `maxBytes`.
 *   2. `modelCaptured`  — ANSI-stripped, capped at `maxBytes`. This is the
 *      buffer that gets injected into the next model turn so the model
 *      sees clean text, not terminal escape soup. Tracked separately so
 *      the two consumption paths are decoupled.
 *
 * The caller decides whether to await the returned `promise` (foreground)
 * or detach it and store the `ShellHandle` in a registry (background).
 * `kill()` sends SIGKILL to the entire process group — including any
 * grandchildren the shell backgrounded with `&`.
 *
 * @module agent/shell-jobs/streamer
 */

import { spawn, type ChildProcess } from 'node:child_process';

/**
 * ANSI / VT escape sequence regex — strips:
 *   • CSI sequences:  ESC [ … letter          (colours, cursor, erase, …)
 *   • OSC sequences:  ESC ] … BEL  or  ESC ] … ST   (hyperlinks, title sets)
 *   • DCS sequences:  ESC P … ST                    (device control strings)
 *   • PM  sequences:  ESC ^ … ST                    (privacy message)
 *   • APC sequences:  ESC _ … ST                    (application program cmd)
 *   • SOS sequences:  ESC X … ST                    (start of string)
 *   • Single-char ESC sequences:  ESC + one byte in 0x40-0x5F EXCEPT the
 *                                 string-introducers ] P ^ _ X
 *                                 (e.g. ESC M reverse-index — but NOT ESC ]).
 *
 * The single-char alternative deliberately EXCLUDES the string-introducer
 * bytes ] (OSC), P (DCS), ^ (PM), _ (APC), X (SOS). Those bytes only ever
 * introduce a longer string sequence whose terminator (BEL / ST) may arrive
 * in a LATER chunk. If the single-char alt could match `ESC ]` on its own it
 * would strip the 2-byte introducer and leak the sequence body as literal
 * text (e.g. a hyperlink `ESC ]8;;URL BEL` split right after `ESC ]` would
 * surface `8;;URL` to the model). Excluding them lets the partial-carry in
 * `makeAnsiStripper` hold the introducer as residue until the terminator
 * lands. (PR #565 review: L3 — caught by a cross-chunk OSC-split test.)
 *
 * Excluded set as ranges: 0x40-0x4F (@-O), 0x51-0x57 (Q-W), 0x59-0x5A (YZ),
 * 0x5C (\). Dropped vs. the naive 0x40-0x5F: P(0x50) X(0x58) ](0x5D)
 * ^(0x5E) _(0x5F).
 *
 * String Terminator (ST) is BEL (\x07) or ESC \ (\x1b\x5c).
 * The body consumer `[^\x07\x1b]*` stops at the first ESC or BEL so a
 * malformed sequence never consumes content past its intended boundary.
 */
// eslint-disable-next-line no-control-regex
const ANSI_REGEX =
  /\x1b(?:\[[0-9;]*[a-zA-Z]|[\]P^_X][^\x07\x1b]*(?:\x07|\x1b\\)|[@-OQ-WYZ\\])/g;

/**
 * Stateful ANSI stripper interface. Exported for direct unit testing of the
 * cross-chunk split-sequence path (PR #565 review: L3).
 */
export interface AnsiStripper {
  /** Strip ANSI sequences from `text`, carrying any partial sequence across calls. */
  strip(text: string): string;
  /**
   * Flush any partial ESC sequence held from the last chunk.
   * Call once when the stream closes so the residue is not silently dropped.
   * A partial escape sequence is never printable text, so flush() discards it
   * rather than appending raw escape bytes to modelCaptured.
   * After flush(), the residue is cleared — calling strip() again is safe.
   */
  flush(): string;
}

/**
 * Returns a stateful ANSI stripper that carries a partial-sequence residual
 * across calls. This handles the case where an ESC sequence is split across
 * two `data` chunks from the child process pipe.
 *
 * The residual holds an incomplete ESC sequence tail that was at the end of
 * the previous chunk; it is prepended to the next chunk before regex-stripping,
 * then the new tail is checked for another partial sequence. Call flush() once
 * when the stream closes to discard any residue not followed by a final chunk.
 *
 * Exported for direct unit testing — forcing a split ESC sequence through a
 * real spawned process is non-deterministic, so the carry/flush behaviour is
 * verified against this factory directly (PR #565 review: L3).
 */
export function makeAnsiStripper(): AnsiStripper {
  let residue = '';
  return {
    strip(text: string): string {
      const input = residue + text;
      // Remove all complete ANSI sequences (CSI, OSC, DCS, single-char ESC, …).
      const stripped = input.replace(ANSI_REGEX, '');
      // Hold any trailing partial ESC sequence for the next chunk.
      // Covers: bare ESC, ESC+[, ESC+[digits (CSI partial),
      //         ESC+] / ESC+P / ESC+^ / ESC+_ / ESC+X (OSC/DCS — body not yet closed).
      // eslint-disable-next-line no-control-regex
      const partialMatch = stripped.match(/\x1b(?:[\]P^_X][^\x07\x1b]*|\[[0-9;]*)?$/);
      if (partialMatch) {
        residue = partialMatch[0];
        return stripped.slice(0, stripped.length - residue.length);
      }
      residue = '';
      return stripped;
    },
    flush(): string {
      // The residue is a fragment of an incomplete ESC sequence — not printable
      // text — so discard it rather than exposing raw escape bytes to the model.
      // Reset so strip() works correctly if called again after flush().
      residue = '';
      return '';
    },
  };
}

/**
 * Truncate a UTF-8 Buffer to at most `maxBytes` bytes without splitting a
 * multi-byte code-point. Walks backward from the cut offset, skipping
 * continuation bytes (0x80–0xBF), to find the last complete character
 * boundary. Returns a subarray view (zero-copy).
 *
 * Exported for direct unit testing of the multi-byte-straddles-cap boundary
 * (PR #565 review: L4).
 */
export function utf8SafeTruncate(buf: Buffer, maxBytes: number): Buffer {
  if (buf.length <= maxBytes) return buf;
  let end = maxBytes;
  // Skip over UTF-8 continuation bytes so we don't split a multi-byte char.
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end);
}

/** Default per-command timeout in milliseconds (2 minutes, matches model tool). */
export const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Default per-command captured-output cap in bytes (100KB).
 *
 * This bounds the in-memory `displayCaptured` and `modelCaptured` buffers,
 * NOT what streams through `onChunk`. The on-screen render is unbounded —
 * `commitAbove` writes go straight to scrollback as they arrive — so long
 * commands don't lose visible output; only the structured capture used by
 * `/sh show` and model-context injection is truncated.
 */
export const DEFAULT_MAX_BYTES = 100_000;

export interface StartShellOptions {
  /** The shell command line to execute. Passed to `spawn` with `shell: true`. */
  command: string;
  /** Working directory. Defaults to the spawn-inherit (process.cwd()) when undefined. */
  cwd?: string;
  /**
   * Abort signal. When fired, the entire process group is SIGKILL'd and the
   * promise settles with `{ errorReason: 'abort' }`.
   */
  abort: AbortSignal;
  /** Per-command timeout in milliseconds. Default {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /**
   * Captured-output cap (display + model buffers, separately). Default
   * {@link DEFAULT_MAX_BYTES}. Once exceeded, the buffers stop accepting
   * new bytes — the child keeps running and `onChunk` keeps firing, but
   * the structured capture is marked `truncated: true`.
   */
  maxBytes?: number;
  /**
   * Live output callback. Fires for every chunk received from the child's
   * stdout/stderr. The Buffer is raw bytes — ANSI escapes are passed
   * through unmodified so the terminal renders colors correctly.
   *
   * Note: this callback may fire after the promise settles (if the child
   * emits a final flush during teardown). Consumers should be idempotent.
   */
  onChunk?: (chunk: Buffer, stream: 'stdout' | 'stderr') => void;
  /**
   * Extra environment to merge onto `process.env` for the spawned child.
   * Mirrors `ToolHandlerContext.env` semantics on the model-side bash tool.
   */
  env?: Record<string, string>;
}

export type ShellErrorReason =
  | 'timeout'
  | 'abort'
  | 'overflow'
  | 'spawn-failed'
  | 'nonzero-exit'
  | 'signal-killed';

export interface ShellResult {
  /** Exit code from the child. Null when killed by signal. */
  exitCode: number | null;
  /** Total wall-clock duration. */
  durationMs: number;
  /** Raw display capture (ANSI preserved), capped at `maxBytes`. */
  displayCaptured: string;
  /** ANSI-stripped capture for model injection, capped at `maxBytes`. */
  modelCaptured: string;
  /** True if either buffer was truncated by the cap. */
  truncated: boolean;
  /** Set when the command did not complete normally with exit 0. */
  errorReason?: ShellErrorReason;
  /** Human-readable failure summary when `errorReason` is set. */
  errorMessage?: string;
}

export interface ShellHandle {
  /**
   * The spawned child's PID (may be undefined if spawn failed before the
   * pid was assigned — `errorReason: 'spawn-failed'` in that case).
   */
  readonly pid: number | undefined;
  /** Resolves when the child exits, times out, aborts, or overflows. */
  readonly promise: Promise<ShellResult>;
  /**
   * Forcibly terminate the process group. Default signal is SIGKILL.
   * Idempotent — calling after the child has already exited is a no-op.
   * The returned promise still settles cleanly (with `errorReason: 'abort'`
   * when this beats normal exit).
   */
  kill(signal?: NodeJS.Signals): void;
}

/**
 * Start a shell command, streaming chunks via `onChunk` and returning a
 * handle whose `promise` settles when the child terminates.
 *
 * The promise NEVER rejects — every failure path resolves to a
 * `ShellResult` with `errorReason` set. This keeps caller error-handling
 * uniform: branch on `result.errorReason`, not on try/catch.
 *
 * Process-group semantics: the child is spawned with `detached: true` so
 * grandchildren (anything the shell launches with `&`) share the same
 * PGID. `kill()` and the timeout/abort paths all use
 * `process.kill(-pid, 'SIGKILL')` to terminate the entire group atomically,
 * matching the existing bash-tool hardening (S10).
 */
export function startShell(opts: StartShellOptions): ShellHandle {
  const startedAt = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const stripAnsi = makeAnsiStripper();

  // Spawn shape mirrors `createBashHandler` so the failure modes that
  // file documents (overflow kill, process-group SIGKILL, env merge) all
  // carry over identically. The one structural difference is that this
  // function pipes onChunk for live display where the bash tool only
  // collects + returns.
  let proc: ChildProcess;
  try {
    proc = spawn(opts.command, {
      shell: true,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.env !== undefined ? { env: { ...process.env, ...opts.env } } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      pid: undefined,
      kill: () => {},
      promise: Promise.resolve({
        exitCode: null,
        durationMs: Date.now() - startedAt,
        displayCaptured: '',
        modelCaptured: '',
        truncated: false,
        errorReason: 'spawn-failed',
        errorMessage: `Failed to spawn shell: ${message}`,
      }),
    };
  }

  // Detach the child from Node's event loop so an abandoned background
  // job doesn't keep the REPL process alive when the user exits.
  proc.unref();

  // Lazy resolver — assigned inside the Promise executor.
  let resolveResult!: (r: ShellResult) => void;
  let settled = false;
  const promise = new Promise<ShellResult>((resolve) => {
    resolveResult = (r) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
  });

  let displayCaptured = '';
  let modelCaptured = '';
  let displayBytes = 0;
  let modelBytes = 0;
  let truncated = false;
  let overflowKilled = false;
  let killedByCaller = false;

  function captureChunk(chunk: Buffer): void {
    // Display buffer: raw bytes, ANSI preserved.
    const displayRemaining = maxBytes - displayBytes;
    if (displayRemaining > 0) {
      const safe = chunk.length <= displayRemaining
        ? chunk
        : utf8SafeTruncate(chunk, displayRemaining);
      displayBytes += safe.length;
      displayCaptured += safe.toString('utf8');
      if (chunk.length > displayRemaining) truncated = true;
    } else if (chunk.length > 0) {
      truncated = true;
    }

    // Model buffer: ANSI stripped, separate byte counter. The stateful
    // stripAnsi closure carries any partial ESC sequence residual across
    // chunk boundaries so split ANSI sequences are handled correctly (H-2).
    if (modelBytes < maxBytes) {
      const stripped = stripAnsi.strip(chunk.toString('utf8'));
      const strippedBytes = Buffer.byteLength(stripped, 'utf8');
      const modelRemaining = maxBytes - modelBytes;
      if (strippedBytes <= modelRemaining) {
        modelCaptured += stripped;
        modelBytes += strippedBytes;
      } else {
        // Slice on UTF-8 byte boundary using Buffer to avoid mid-codepoint cuts.
        const buf = Buffer.from(stripped, 'utf8');
        modelCaptured += utf8SafeTruncate(buf, modelRemaining).toString('utf8');
        modelBytes = maxBytes;
        truncated = true;
      }
    }
  }

  function killGroup(): void {
    // Guard pid !== 0: `process.kill(-0, …)` would signal THIS process's own
    // group. Node never assigns pid 0 to a live child, but the guard is cheap
    // insurance against ever turning a child-kill into a self-kill. (PR #565
    // review: N3.)
    if (proc.pid !== undefined && proc.pid !== 0 && !proc.killed) {
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch {
        // Already dead; ignore. Process-group lookups race with normal exit.
      }
    }
  }

  // Timeout — same semantics as the model-side bash tool.
  const timeoutHandle = setTimeout(() => {
    killGroup();
    // Symmetry with the overflow path: drop the abort listener so a
    // killAll() landing in the one-tick window before `close` fires can't
    // re-enter killGroup() on an already-killed group. (PR #565 review: N2.)
    opts.abort.removeEventListener('abort', abortHandler);
    resolveResult({
      exitCode: null,
      durationMs: Date.now() - startedAt,
      displayCaptured,
      modelCaptured,
      truncated,
      errorReason: 'timeout',
      errorMessage: `Command timed out after ${timeoutMs}ms`,
    });
  }, timeoutMs);

  // Abort — fires from caller (Ctrl-C, REPL shutdown, or registry.kill()).
  const abortHandler = (): void => {
    killGroup();
    clearTimeout(timeoutHandle);
    resolveResult({
      exitCode: null,
      durationMs: Date.now() - startedAt,
      displayCaptured,
      modelCaptured,
      truncated,
      errorReason: 'abort',
      errorMessage: killedByCaller ? 'Command killed' : 'Command aborted',
    });
  };
  opts.abort.addEventListener('abort', abortHandler);

  // Wire stdout / stderr. The combined byte counter (displayBytes +
  // modelBytes capped independently) means an extreme overflow on one
  // stream doesn't starve the other; the overflowKilled latch ensures
  // we only fire the kill+resolve once across both data handlers.
  function maybeOverflow(): void {
    if (overflowKilled || settled) return;
    if (displayBytes < maxBytes && modelBytes < maxBytes) return;
    // Both buffers are at cap. The child can keep running for as long as
    // it wants — we'd just discard further bytes — but the model-side
    // bash tool kills here because a runaway `yes` can hit V8's max
    // string length faster than 120s. Mirroring that hardening: kill
    // and settle as soon as the cap is crossed.
    overflowKilled = true;
    killGroup();
    clearTimeout(timeoutHandle);
    opts.abort.removeEventListener('abort', abortHandler);
    resolveResult({
      exitCode: null,
      durationMs: Date.now() - startedAt,
      displayCaptured,
      modelCaptured,
      truncated: true,
      errorReason: 'overflow',
      errorMessage: `Output exceeded ${maxBytes} bytes`,
    });
  }

  proc.stdout?.on('data', (chunk: Buffer) => {
    captureChunk(chunk);
    try {
      opts.onChunk?.(chunk, 'stdout');
    } catch {
      // onChunk callbacks must not break the streamer — swallow.
    }
    maybeOverflow();
  });

  proc.stderr?.on('data', (chunk: Buffer) => {
    captureChunk(chunk);
    try {
      opts.onChunk?.(chunk, 'stderr');
    } catch {
      // onChunk callbacks must not break the streamer — swallow.
    }
    maybeOverflow();
  });

  proc.on('error', (err) => {
    clearTimeout(timeoutHandle);
    opts.abort.removeEventListener('abort', abortHandler);
    resolveResult({
      exitCode: null,
      durationMs: Date.now() - startedAt,
      displayCaptured,
      modelCaptured,
      truncated,
      errorReason: 'spawn-failed',
      errorMessage: `Shell process error: ${err.message}`,
    });
  });

  proc.on('close', (code, signal) => {
    clearTimeout(timeoutHandle);
    opts.abort.removeEventListener('abort', abortHandler);
    if (overflowKilled || settled) return;

    // Flush any partial ESC residue the stripper was holding across chunks.
    // A partial escape sequence at the tail of the last chunk is never
    // printable text, so flush() discards it rather than appending raw bytes
    // to modelCaptured. Without this, up to ~6 bytes of the last chunk tail
    // would silently disappear from modelCaptured while remaining visible in
    // displayCaptured.
    stripAnsi.flush();

    // If kill() was called by the caller, surface as 'abort' so callers
    // can disambiguate "I told you to stop" from "command exited normally
    // with a nonzero code".
    if (killedByCaller) {
      resolveResult({
        exitCode: code,
        durationMs: Date.now() - startedAt,
        displayCaptured,
        modelCaptured,
        truncated,
        errorReason: 'abort',
        errorMessage: 'Command killed',
      });
      return;
    }

    if (code !== null && code !== 0) {
      resolveResult({
        exitCode: code,
        durationMs: Date.now() - startedAt,
        displayCaptured,
        modelCaptured,
        truncated,
        errorReason: 'nonzero-exit',
        errorMessage: `Command exited with code ${code}`,
      });
      return;
    }

    if (code === null) {
      // Process terminated by a signal we did NOT send (segfault, OOM-killer,
      // external `kill`, or a self-signal like `kill -9 $$`). The caller-kill,
      // timeout, abort, and overflow paths are all handled above, so a null
      // code reaching here means an unrequested signal death. Surface it as a
      // failure instead of falling through to the success resolve, which would
      // tell the model a crashed command "succeeded". (PR #565 review: M2.)
      resolveResult({
        exitCode: null,
        durationMs: Date.now() - startedAt,
        displayCaptured,
        modelCaptured,
        truncated,
        errorReason: 'signal-killed',
        errorMessage: signal
          ? `Command killed by signal ${signal}`
          : 'Command killed by signal',
      });
      return;
    }

    resolveResult({
      exitCode: code,
      durationMs: Date.now() - startedAt,
      displayCaptured,
      modelCaptured,
      truncated,
    });
  });

  return {
    pid: proc.pid,
    promise,
    kill: (signal: NodeJS.Signals = 'SIGKILL') => {
      // pid !== 0 guard: never let -pid resolve to -0 (this process's group).
      if (proc.pid === undefined || proc.pid === 0 || proc.killed) return;
      killedByCaller = true;
      try {
        process.kill(-proc.pid, signal);
      } catch {
        // Process group already gone; close handler will still fire.
      }
    },
  };
}
