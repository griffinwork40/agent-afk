/**
 * Shell-command executor for config-driven hooks.
 *
 * Spawns the hook command via `sh -c`, writes a JSON context payload to its
 * stdin, reads stdout/stderr (capped at 64 KB each), and maps the exit code
 * to a {@link HookDecision}.
 *
 * Exit-code semantics:
 *   0    → success; parse JSON stdout for optional decision fields
 *   2    → block; stderr (first 500 chars) becomes the `reason`
 *   other → non-blocking error; `console.warn` is emitted, `{}` returned
 *
 * JSON stdout fields (all optional):
 *   `continue: false`                         → block (alias for exit 2)
 *   `decision: "block", reason: "…"`          → block with explanation
 *   `hookSpecificOutput.additionalContext`     → `injectContext` in result
 *
 * @module agent/hooks/command-executor
 */

import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import type { HookContext, HookDecision } from '../hooks.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ExecuteCommandOptions {
  command: string;
  context: HookContext;
  agentCwd: string;
  sessionId?: string;
  timeoutMs: number;
}

export interface CommandExecutorResult {
  decision: HookDecision;
}

/**
 * Execute a single hook command and resolve with a `HookDecision`.
 *
 * Resolves (never rejects) — errors surface via the returned decision or
 * `console.warn`. The caller (config-bridge) is responsible for throwing
 * `HookBlockedError` if `decision.decision === 'block'` or
 * `decision.continue === false`.
 */
export async function executeCommand(
  opts: ExecuteCommandOptions,
): Promise<CommandExecutorResult> {
  const { context, agentCwd, sessionId, timeoutMs } = opts;

  // Tilde-expand the command path before spawning.
  const command = opts.command.replace(/^~\//, homedir() + '/');

  // Build the stdin JSON payload.
  const payload: Record<string, unknown> = {
    session_id: sessionId,
    hook_event_name: context.event,
    cwd: agentCwd,
  };

  if (
    context.event === 'PreToolUse' ||
    context.event === 'PostToolUse' ||
    context.event === 'PostToolUseFailure'
  ) {
    payload['tool_name'] = context.toolName;
  }
  if (context.event === 'PreToolUse') {
    payload['tool_input'] = context.input;
  }
  if (context.event === 'PostToolUse') {
    // Serialize tool output so hook scripts can inspect it.
    // Omit when output is undefined to avoid confusing hooks with a null key.
    if (context.output !== undefined) {
      payload['tool_output'] =
        typeof context.output === 'string' ? context.output : JSON.stringify(context.output);
    }
  }
  if (context.event === 'PostToolUseFailure') {
    payload['error'] = context.error;
    // Deliberate omission: tool_input is not forwarded to shell hooks for
    // PostToolUseFailure. The originating input is available in-process via
    // context.input, but injecting it into the shell environment or stdin
    // payload risks forwarding untrusted, potentially large, or sensitive
    // tool inputs to arbitrary shell scripts. Add tool_input here if a
    // future use-case justifies it, with appropriate size/content guards.
  }
  if (context.event === 'PreCompact') {
    payload['trigger'] = context.trigger ?? null;
  }
  if (context.event === 'UserPromptSubmit') {
    payload['prompt'] = context.prompt;
  }
  // transcript_path: always emit the key so hook scripts can detect it.
  // When unknown, emit null (not undefined — JSON.stringify drops undefined).
  payload['transcript_path'] = null;
  const stdinPayload = JSON.stringify(payload);

  // Env vars injected into the child process.
  //
  // Security: we deliberately do NOT spread process.env. Forwarding the full
  // environment to an arbitrary user-configured shell command would expose
  // secrets like ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN, and OPENAI_API_KEY
  // to potentially untrusted hook commands. Instead we forward only a minimal
  // set of runtime-safe variables. If a hook command genuinely needs additional
  // vars, the user can set them in their shell profile or via the hook command
  // itself.
  //
  // Allowed passthrough: PATH, HOME, SHELL, LANG, TERM (needed for basic shell
  // operation), TMPDIR / TMP / TEMP (needed for temp-file operations), plus all
  // AFK_* variables that communicate hook context.
  const toolName =
    context.event === 'PreToolUse' ||
    context.event === 'PostToolUse' ||
    context.event === 'PostToolUseFailure'
      ? context.toolName
      : '';

  const ENV_PASSTHROUGH = ['PATH', 'HOME', 'SHELL', 'LANG', 'TERM', 'TMPDIR', 'TMP', 'TEMP', 'USER', 'LOGNAME'] as const;
  const childEnv: NodeJS.ProcessEnv = {};
  for (const key of ENV_PASSTHROUGH) {
    const val = process.env[key];
    if (val !== undefined) childEnv[key] = val;
  }
  // Forward AFK_* vars already in the environment (e.g. AFK_HOME set by the
  // user's shell profile) so hook scripts can reference them — EXCEPT
  // AFK_-prefixed credentials. The bare secret names (ANTHROPIC_API_KEY,
  // TELEGRAM_BOT_TOKEN, OPENAI_API_KEY) are already excluded because they are
  // not in ENV_PASSTHROUGH, but AFK also exposes secret-bearing aliases under
  // the AFK_ prefix (AFK_TELEGRAM_BOT_TOKEN, AFK_LOCAL_API_KEY,
  // AFK_OPENAI_API_KEY). A blanket AFK_* passthrough would re-leak exactly the
  // secrets this allowlist exists to contain, so skip any AFK_ var whose name
  // ends in a credential suffix. The suffix anchor avoids false positives on
  // count-style knobs like AFK_MAX_TOKENS / AFK_MAX_OUTPUT_TOKENS.
  // Invariant: never forward an AFK_-prefixed secret to a hook subprocess.
  const AFK_SECRET_SUFFIX = /_(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|CREDENTIALS)$/i;
  for (const [key, val] of Object.entries(process.env)) {
    if (!key.startsWith('AFK_') || val === undefined) continue;
    if (AFK_SECRET_SUFFIX.test(key)) continue;
    childEnv[key] = val;
  }
  // Hook-context vars — always set explicitly so hook scripts can rely on them.
  childEnv['AFK_PROJECT_DIR'] = agentCwd;
  childEnv['AFK_SESSION_ID'] = sessionId ?? '';
  childEnv['AFK_HOOK_EVENT'] = context.event;
  childEnv['AFK_TOOL_NAME'] = toolName;
  // Deliberate omission: no AFK_TOOL_ERROR env var for PostToolUseFailure.
  // The error string is available in the stdin JSON payload under the 'error'
  // key. Injecting it as an env var risks shell-injection if the error message
  // contains shell metacharacters; parse the stdin payload instead.

  return new Promise<CommandExecutorResult>((resolve) => {
    // Establish settled flag before spawn so cleanup handlers established
    // in the event-loop microtask queue can safely reference it.
    let settled = false;

    function settle(result: CommandExecutorResult): void {
      if (settled) return;
      settled = true;
      resolve(result);
    }

    const proc = spawn('sh', ['-c', command], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: agentCwd,
      env: childEnv,
      detached: true,
    });
    // Don't pin the event loop.
    proc.unref();

    // --- Output capture with 64 KB per-stream cap ---
    // StringDecoder is used so multi-byte UTF-8 codepoints that straddle the
    // 64 000-byte boundary are not split mid-sequence (which would corrupt the
    // last character and potentially break JSON parsing).
    const MAX_STREAM_BYTES = 64_000;
    let stdoutBuf = '';
    let stderrBuf = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');

    proc.stdout!.on('data', (chunk: Buffer) => {
      if (stdoutBytes >= MAX_STREAM_BYTES) return;
      const remaining = MAX_STREAM_BYTES - stdoutBytes;
      const safe = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
      stdoutBytes += safe.length;
      stdoutBuf += stdoutDecoder.write(safe);
    });

    proc.stderr!.on('data', (chunk: Buffer) => {
      if (stderrBytes >= MAX_STREAM_BYTES) return;
      const remaining = MAX_STREAM_BYTES - stderrBytes;
      const safe = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
      stderrBytes += safe.length;
      stderrBuf += stderrDecoder.write(safe);
    });

    // --- Timeout ---
    const timer = setTimeout(() => {
      if (settled) return;
      // SIGKILL the process group to avoid orphaned processes.
      if (proc.pid !== undefined) {
        try {
          process.kill(-proc.pid, 'SIGKILL');
        } catch {
          // Process may have already exited.
        }
      }
      console.warn(
        `[hooks] command timed out after ${timeoutMs}ms: ${command}`,
      );
      settle({ decision: {} });
    }, timeoutMs);
    // Don't pin the event loop while the hook hangs.
    timer.unref();

    // --- Write stdin ---
    // Invariant: writing to a short-lived hook child's stdin can fail with
    // EPIPE when the child exits before the write flushes (common for hooks
    // that ignore stdin). Node delivers that failure ASYNCHRONOUSLY via the
    // stream's 'error' event — a synchronous try/catch cannot observe it — so
    // without a listener it escalates to an unhandled error that crashes the
    // process (and fails CI: vitest counts it among "Errors" and exits
    // non-zero). The hook decision is derived from stdout + exit code in the
    // 'close' handler, never from the stdin write, so a dropped write is benign.
    proc.stdin!.on('error', () => {
      /* swallow EPIPE/ECONNRESET — child closed its stdin read end early */
    });
    try {
      proc.stdin!.write(stdinPayload);
      proc.stdin!.end();
    } catch {
      // Ignore synchronous write errors (e.g. stream already destroyed).
    }

    // --- Process close ---
    proc.on('close', (code) => {
      if (settled) return;
      clearTimeout(timer);
      // Flush any incomplete multi-byte sequence held by the decoders.
      stdoutBuf += stdoutDecoder.end();
      stderrBuf += stderrDecoder.end();

      if (code === 0) {
        // Parse JSON stdout for optional decision fields.
        const decision = parseStdoutDecision(stdoutBuf);
        settle({ decision });
        return;
      }

      if (code === 2) {
        // Explicit block — use stderr as the reason.
        const reason = stderrBuf.trim().slice(0, 500) || 'hook blocked operation';
        settle({ decision: { decision: 'block', reason } });
        return;
      }

      // Any other non-zero exit: non-blocking error.
      console.warn(
        `[hooks] command exited with code ${String(code)}: ${command}${stderrBuf.trim() ? `\n${stderrBuf.trim()}` : ''}`,
      );
      settle({ decision: {} });
    });

    proc.on('error', (err) => {
      if (settled) return;
      clearTimeout(timer);
      console.warn(`[hooks] command error: ${command} — ${err.message}`);
      settle({ decision: {} });
    });
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parseStdoutDecision(stdout: string): HookDecision {
  const trimmed = stdout.trim();
  if (!trimmed) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return {};
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }

  const obj = parsed as Record<string, unknown>;
  const decision: HookDecision = {};

  // `continue: false` → block
  if (obj['continue'] === false) {
    decision.continue = false;
  }

  // `decision: "block" | "approve"`
  if (obj['decision'] === 'block') {
    decision.decision = 'block';
  } else if (obj['decision'] === 'approve') {
    decision.decision = 'approve';
  }

  // `reason`
  if (typeof obj['reason'] === 'string') {
    decision.reason = obj['reason'];
  }

  // `hookSpecificOutput.additionalContext` → injectContext
  const hso = obj['hookSpecificOutput'];
  if (hso !== null && typeof hso === 'object' && !Array.isArray(hso)) {
    const hsoObj = hso as Record<string, unknown>;
    if (typeof hsoObj['additionalContext'] === 'string') {
      decision.injectContext = hsoObj['additionalContext'];
    }
  }

  return decision;
}
