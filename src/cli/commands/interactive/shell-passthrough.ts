/**
 * REPL-side glue for the `!cmd` / `!&cmd` shell-passthrough feature.
 *
 * Wires three concerns together that the underlying `ShellJobRegistry`
 * keeps deliberately separate:
 *
 *   1. **Live display** — for foreground jobs, route each captured line
 *      into the REPL's `writeLine` so output appears in scrollback as the
 *      command runs (rather than dumping a wall of text on completion).
 *   2. **Model-context injection** — when a job finishes, queue the
 *      ANSI-stripped captured buffer (with command + exit metadata) into
 *      a pending list that the REPL drains and prepends to the NEXT user
 *      message before passing it to `sendMessageStream`. Matches Claude
 *      Code's "shell output sits in the transcript, model sees it next
 *      turn" semantics.
 *   3. **Background completion notification** — when a background job
 *      finishes, queue a one-line summary that the REPL drains and
 *      surfaces at the top of the next iteration alongside the existing
 *      `pendingBgNotifications` flow.
 *
 * Distinct from `BackgroundTaskManager` (which detaches MODEL TURNS via
 * Ctrl+B / `/bg`) and `BackgroundAgentRegistry` (which tracks BACKGROUND
 * SUBAGENT DISPATCHES via the `agent` tool). These three layers
 * intentionally have separate registries because they own separate
 * resources (shell process / model turn / subagent fork).
 *
 * @module cli/commands/interactive/shell-passthrough
 */

import {
  ShellJobRegistry,
  type ShellJob,
  type ShellResult,
  type ShellErrorReason,
  type StartJobOptions,
} from '../../../agent/shell-jobs/index.js';
import { palette } from '../../palette.js';
import { formatDuration } from '../../format-utils.js';

export interface ShellPassthroughOptions {
  /**
   * The REPL's writeLine sink — routes through the persistent compositor's
   * `commitAbove` when armed, falls back to raw stdout when not. Provided
   * by `replRenderer.writeLine` so the existing scroll-region + DECSTBM
   * hardening is reused without re-implementation.
   */
  writeLine: (text: string) => void;
  /**
   * Session cwd factory — the REPL re-reads this at command time so an
   * `afk i --worktree foo` session always lands in `foo`, not the host's
   * `process.cwd()`. Returning `undefined` makes the streamer inherit
   * `process.cwd()` (spawn semantics).
   */
  getCwd: () => string | undefined;
}

/**
 * Parsed shell-passthrough trigger. Returns `null` for any input that
 * isn't a `!` prefix. The `!` and `!&` sigils are matched at the very
 * start of the input — embedded `&&`, `||`, and the like are passed
 * through to the shell unchanged.
 *
 * - `!cmd`   → mode='foreground', command='cmd'
 * - `!&cmd`  → mode='background', command='cmd'
 * - `!`      → null (empty command; the REPL should print a hint)
 * - `!&`     → null (empty command in background; same hint)
 * - anything else → null
 *
 * Whitespace between the sigil and the command is stripped so `! ls` and
 * `!ls` are equivalent.
 */
export function parseShellTrigger(
  input: string,
): { mode: 'foreground' | 'background'; command: string } | null {
  if (!input.startsWith('!')) return null;
  // `!&` must be checked BEFORE the bare `!` branch — otherwise the bare
  // form would match first and `!&cmd` would be treated as a foreground
  // command starting with `&`.
  if (input.startsWith('!&')) {
    const cmd = input.slice(2).trim();
    if (cmd.length === 0) return null;
    return { mode: 'background', command: cmd };
  }
  const cmd = input.slice(1).trim();
  if (cmd.length === 0) return null;
  return { mode: 'foreground', command: cmd };
}

/**
 * Format a completion-footer line: `[exit N · 1.3s]` (success) or
 * `[exit 1 · 0.4s · failed]` (nonzero) or `[killed · 0.8s]` (abort) etc.
 * Visible to the user; the model sees the same fields in the structured
 * injection block, not this prose.
 */
function formatFooter(job: ShellJob, result: ShellResult): string {
  const duration = formatDuration(result.durationMs);
  if (result.errorReason === 'abort') {
    return palette.dim(`  [${job.id} · killed · ${duration}]`);
  }
  if (result.errorReason === 'timeout') {
    return palette.dim(`  [${job.id} · timed out · ${duration}]`);
  }
  if (result.errorReason === 'overflow') {
    return palette.dim(`  [${job.id} · output overflow · ${duration}]`);
  }
  if (result.errorReason === 'spawn-failed') {
    return palette.warning(`  [${job.id} · spawn failed · ${duration}]`);
  }
  if (result.errorReason === 'nonzero-exit') {
    return palette.warning(`  [${job.id} · exit ${result.exitCode} · ${duration}]`);
  }
  if (result.errorReason === 'signal-killed') {
    return palette.warning(`  [${job.id} · killed by signal · ${duration}]`);
  }
  return palette.dim(`  [${job.id} · exit ${result.exitCode ?? 0} · ${duration}]`);
}

/**
 * Build the model-injection block for one completed job. Wrapped in
 * `<bash-passthrough>` tags so the model can parse it unambiguously
 * — distinct from the regular bash-tool result envelope so the model
 * understands this came from the human, not a tool call it made.
 *
 * Capped at the streamer's `maxBytes` already (modelCaptured is the
 * ANSI-stripped, capped buffer); we just frame it.
 */
/**
 * Minimal XML escaping for content inserted into the bash-passthrough envelope.
 * Guards against command output or user-typed commands that contain closing tags
 * (`</output>`, `</bash-passthrough>`, etc.) which would break the XML envelope
 * and inject arbitrary framing into model context.
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildInjectionBlock(
  command: string,
  mode: 'foreground' | 'background',
  result: ShellResult,
): string {
  const lines: string[] = [];
  const attrs: string[] = [`mode="${mode}"`];
  if (result.exitCode !== null) attrs.push(`exit="${result.exitCode}"`);
  if (result.errorReason !== undefined) attrs.push(`reason="${result.errorReason}"`);
  attrs.push(`duration="${formatDuration(result.durationMs)}"`);
  if (result.truncated) attrs.push('truncated="true"');
  lines.push(`<bash-passthrough ${attrs.join(' ')}>`);
  lines.push(`<command>${escapeXml(command)}</command>`);
  lines.push('<output>');
  // Escape to prevent command output containing closing tags from breaking
  // the envelope and injecting arbitrary text into model context (C-2).
  lines.push(escapeXml(result.modelCaptured));
  lines.push('</output>');
  lines.push('</bash-passthrough>');
  return lines.join('\n');
}

/**
 * One pending background-job completion event surfaced via
 * `drainNotifications`. The REPL formats and renders these at the top of
 * the next loop iteration, alongside the existing pending bg-task notice
 * stream.
 */
export interface PendingBgNotification {
  job: ShellJob;
  result: ShellResult;
}

/**
 * Public API used by the REPL loop. One instance per `runReplLoop` —
 * lifetime tracks the surrounding REPL session.
 */
export class ShellPassthrough {
  readonly registry = new ShellJobRegistry();

  /** Buffer of completed jobs awaiting injection into the next user turn. */
  private pendingInjections: { command: string; mode: 'foreground' | 'background'; result: ShellResult }[] = [];
  /** Buffer of completed BG jobs awaiting one-line completion notification. */
  private pendingNotifications: PendingBgNotification[] = [];
  /** Job-id of the currently running foreground command, if any. */
  private activeFgJobId: string | null = null;

  /** Maximum number of pending injections kept; older entries are dropped. */
  static readonly MAX_PENDING_INJECTIONS = 25;
  /** Maximum number of pending BG notifications kept. */
  static readonly MAX_PENDING_NOTIFICATIONS = 50;

  constructor(private readonly opts: ShellPassthroughOptions) {
    // BG completion: queue notification and injection in one place so the
    // REPL just polls the drain methods. FG completion is handled inline
    // in runForeground so the awaiter has direct access to the result.
    this.registry.on('complete', (job) => {
      if (job.mode !== 'background') return;
      const result = job.result;
      if (!result) return; // Defensive — complete fires after result is set.
      this.queueInjection({ command: job.command, mode: 'background', result });
      this.pendingNotifications.push({ job, result });
      if (this.pendingNotifications.length > ShellPassthrough.MAX_PENDING_NOTIFICATIONS) {
        this.pendingNotifications.shift();
      }
    });
  }

  /**
   * Test the input for the `!` prefix and dispatch if it matches.
   * Returns `true` when the input was a shell trigger (handled here);
   * `false` lets the caller continue to the slash / model paths.
   *
   * The FG branch awaits the child to completion before returning so the
   * REPL's "next prompt" appears AFTER the command finishes — matching
   * the user's mental model of a synchronous shell line.
   */
  async dispatch(input: string): Promise<boolean> {
    const parsed = parseShellTrigger(input);
    if (parsed === null) {
      // Bare `!` or `!&` with no command → emit a hint and consume the
      // input. Returning false would forward an empty `!` to the model
      // which is worse UX.
      if (input === '!' || input === '!&' || input.startsWith('! ') || input.startsWith('!& ')) {
        this.opts.writeLine(palette.dim('  usage: !<cmd>   (foreground)    !&<cmd>   (background)'));
        return true;
      }
      return false;
    }
    if (parsed.mode === 'foreground') {
      await this.runForeground(parsed.command);
    } else {
      this.startBackground(parsed.command);
    }
    return true;
  }

  /**
   * Drain and return the structured injection block to prepend to the
   * next user message. Returns the empty string when nothing is queued
   * so callers can blindly concatenate.
   */
  drainInjections(): string {
    if (this.pendingInjections.length === 0) return '';
    const blocks = this.pendingInjections.map((e) =>
      buildInjectionBlock(e.command, e.mode, e.result),
    );
    this.pendingInjections = [];
    return blocks.join('\n') + '\n';
  }

  /**
   * Drain and return pending BG-job completion notifications so the REPL
   * loop's top-of-iteration block can render them. The REPL is
   * responsible for formatting + commitAbove.
   */
  drainNotifications(): readonly PendingBgNotification[] {
    if (this.pendingNotifications.length === 0) return [];
    const out = this.pendingNotifications;
    this.pendingNotifications = [];
    return out;
  }

  /**
   * Hook for the SIGINT handler: kills the in-flight foreground shell if
   * one is running and returns `true`. The sigint handler should check
   * this FIRST (before turnInFlight) so Ctrl+C during `!sleep 10` kills
   * the shell, not the REPL session.
   */
  abortActiveForeground(): boolean {
    if (this.activeFgJobId === null) return false;
    // Unconditionally return true whenever a foreground job ID is set — even
    // if registry.kill() is a no-op because the job already settled. The
    // activeFgJobId is cleared in runForeground's finally block, which runs
    // asynchronously after the child exits. A second Ctrl-C arriving in that
    // microtask gap would see activeFgJobId still set but kill() returning
    // false (status='killed'), causing the SIGINT to fall through to the REPL
    // exit cycle. Claiming ownership of the signal here is correct: as long as
    // activeFgJobId !== null, we are still inside a foreground-job context.
    this.registry.kill(this.activeFgJobId);
    return true;
  }

  /** Whether a foreground shell job is currently active. */
  hasActiveForeground(): boolean {
    return this.activeFgJobId !== null;
  }

  /**
   * Drain registry on REPL exit. The caller (repl-loop's finally block)
   * passes its writeLine so the "Killing N bg jobs on exit" notice lands
   * through the same compositor. Synchronous fire-and-forget — the
   * underlying SIGKILL is fast, but we don't await the streamer promises
   * because REPL teardown is itself best-effort and waiting would risk
   * stranding the user's terminal.
   */
  drainOnExit(): void {
    const survivors = this.registry.killAll();
    if (survivors.length > 0) {
      this.opts.writeLine(
        palette.dim(`  Killing ${survivors.length} background shell job${survivors.length === 1 ? '' : 's'} on exit.`),
      );
    }
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  private async runForeground(command: string): Promise<void> {
    // Print the command line with a $ prefix so scrollback shows the
    // contract between input and output. Matches the convention every
    // shell uses.
    this.opts.writeLine(palette.dim(`$ ${command}`));

    // Line-accumulator: commitAbove writes one logical line per call,
    // but child stdout chunks split arbitrarily. Accumulate until we
    // have a complete `\n`-terminated line, flush, repeat. Trailing
    // partial line is flushed on completion.
    let lineBuf = '';
    // Latch flipped true the instant the foreground job settles (just before
    // the footer is written). On kill paths (abort / timeout / overflow) the
    // child is SIGKILL'd but already-buffered pipe data can still fire `'data'`
    // → `onChunk` AFTER the promise resolves; without this guard those late
    // chunks would paint below the footer (and bleed into the next prompt via
    // commitAbove). It also bounds `lineBuf` growth on a no-newline flood: once
    // the job is done we stop accumulating. (PR #565 review: M1 + M2.)
    let fgDone = false;
    const flushCompleteLines = (): void => {
      let nl: number;
      while ((nl = lineBuf.indexOf('\n')) !== -1) {
        const line = lineBuf.slice(0, nl);
        lineBuf = lineBuf.slice(nl + 1);
        this.opts.writeLine(line);
      }
    };

    const startOpts: StartJobOptions = {
      command,
      mode: 'foreground',
      onChunk: (chunk) => {
        // Drop chunks that arrive after the job has settled (late pipe
        // flush on kill paths) — see fgDone above.
        if (fgDone) return;
        lineBuf += chunk.toString('utf8');
        flushCompleteLines();
      },
    };
    const cwd = this.opts.getCwd();
    if (cwd !== undefined) startOpts.cwd = cwd;

    const { job, handle } = this.registry.start(startOpts);
    this.activeFgJobId = job.id;
    try {
      const result = await handle.promise;

      // Mark the job done BEFORE the final flush + footer so any late
      // `'data'` chunk delivered after `handle.promise` settled is dropped
      // by the onChunk guard rather than painting below the footer.
      fgDone = true;

      // Flush trailing partial line (no `\n` at end). commitAbove always
      // appends a newline so this becomes a complete row in scrollback.
      if (lineBuf.length > 0) {
        this.opts.writeLine(lineBuf);
        lineBuf = '';
      }

      this.opts.writeLine(formatFooter(job, result));
      this.queueInjection({ command, mode: 'foreground', result });
    } finally {
      this.activeFgJobId = null;
    }
  }

  private startBackground(command: string): void {
    const startOpts: StartJobOptions = {
      command,
      mode: 'background',
      // No onChunk — background output is captured but not streamed live.
      // The user can `/sh show <id>` to inspect it; the model receives
      // the captured buffer via the injection path when the job finishes.
    };
    const cwd = this.opts.getCwd();
    if (cwd !== undefined) startOpts.cwd = cwd;

    const { job } = this.registry.start(startOpts);
    this.opts.writeLine(
      palette.dim(`  [${job.id}] background: `) + command,
    );
  }

  private queueInjection(entry: { command: string; mode: 'foreground' | 'background'; result: ShellResult }): void {
    this.pendingInjections.push(entry);
    if (this.pendingInjections.length > ShellPassthrough.MAX_PENDING_INJECTIONS) {
      this.pendingInjections.shift();
    }
  }
}

/** Re-exported for downstream tests + slash command typing. */
export type { ShellJob, ShellResult, ShellErrorReason };
