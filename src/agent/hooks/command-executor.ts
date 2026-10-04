/**
 * Shell-command executor for config-driven hooks.
 *
 * Spawns the hook command via the OS shell (`shell: true`), writes a JSON context payload to its
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
 * This module is event-agnostic: it maps `additionalContext` into
 * `HookDecision.injectContext` regardless of which event triggered it. What
 * happens to that value next is caller-defined per event — see `../hooks.js`
 * for the full contract (notably `Stop`, where a config-driven shell hook's
 * `additionalContext` ends up prepended to the *next* turn's prompt).
 *
 * @module agent/hooks/command-executor
 */

import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import type { HookContext, HookDecision } from '../hooks.js';
import { killProcessGroup } from '../../utils/kill-process-group.js';
import { resolveShell } from '../../utils/resolve-shell.js';
import { readEnvFile } from '../../utils/envFile.js';
import { getEnvConfigPath } from '../../paths.js';

// ---------------------------------------------------------------------------
// Per-plugin env allowlist — denylist
// ---------------------------------------------------------------------------

/**
 * Env-var names that are NEVER forwarded to a plugin hook subprocess even if
 * the user lists them in `pluginHookEnv`. These are AFK's own primary
 * credentials; forwarding them to a third-party plugin hook is a secret-leak
 * regardless of user intent.
 */
const PLUGIN_ENV_DENIED_NAMES: ReadonlySet<string> = new Set([
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'TELEGRAM_BOT_TOKEN',
]);

/**
 * Suffix pattern for AFK-prefixed credential aliases. Any env-var whose name
 * matches this regex is refused from the plugin allowlist even if the bare
 * credential name is not in PLUGIN_ENV_DENIED_NAMES.
 */
const PLUGIN_ENV_DENIED_SUFFIX = /_(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|CREDENTIALS)$/i;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ExecuteCommandOptions {
  command: string;
  context: HookContext;
  agentCwd: string;
  sessionId?: string;
  timeoutMs: number;
  /**
   * Absolute plugin root for a plugin-contributed hook (Claude Code compat).
   * When set, the executor exports `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PROJECT_DIR`
   * so plugin hook commands referencing `${CLAUDE_PLUGIN_ROOT}` resolve their
   * bundled script paths. Undefined for user-global / project-local config
   * hooks (they use AFK's own `AFK_PROJECT_DIR`).
   */
  pluginRoot?: string;
  /**
   * Canonical plugin name (from `.claude-plugin/plugin.json`). Used to look up
   * the per-plugin env allowlist in `pluginHookEnv` below. Undefined for
   * user-global / project-local config hooks.
   */
  pluginName?: string;
  /**
   * Per-plugin env allowlist from `afk.config.json → pluginHookEnv`. Maps
   * plugin name → array of env-var names the user has explicitly approved for
   * forwarding to that plugin's hook subprocesses. Only the allowlist for
   * `pluginName` is consulted; hooks from other plugins do not benefit.
   *
   * Resolution order: process.env first, then afk.env (so a shell-profile
   * override always wins). AFK's own credentials are refused even if listed —
   * see {@link PLUGIN_ENV_DENIED_NAMES} and {@link PLUGIN_ENV_DENIED_SUFFIX}.
   */
  pluginHookEnv?: Record<string, string[]>;
  /**
   * Absolute path to the current session's autosaved markdown transcript file
   * (`~/.afk/state/transcripts/<isoStamp>.md`). Contains prior conversation
   * turns in chronological order. Written continuously during the REPL session
   * so it always contains at least the turns preceding the hook event.
   *
   * `null` when no transcript is available (daemon, `afk chat`, web, or REPL
   * before the first turn). Emitted as `transcript_path` in the stdin payload.
   */
  transcriptPath?: string | null;
}

export interface CommandExecutorResult {
  decision: HookDecision;
}

/**
 * Serialize the JSON payload written to a hook command's stdin.
 *
 * Invariant: PostToolUse and PostToolUseFailure carry the same `tool_input`
 * PreToolUse saw. The same input already reaches the same hook scripts on
 * PreToolUse, so omitting it afterward adds no protection; it only breaks
 * post-hoc hooks that need to know which file was edited or which command ran.
 */
function buildStdinPayload(
  context: HookContext,
  sessionId: string | undefined,
  agentCwd: string,
  transcriptPath: string | null | undefined,
): string {
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
  }
  if (context.event === 'PreCompact') {
    payload['trigger'] = context.trigger ?? null;
  }
  if (context.event === 'UserPromptSubmit') {
    payload['prompt'] = context.prompt;
  }
  // transcript_path: always emit the key so hook scripts can detect its absence.
  // Use the supplied path when provided and non-empty; fall back to null so
  // JSON.stringify always includes the key (undefined would drop it).
  payload['transcript_path'] =
    typeof transcriptPath === 'string' && transcriptPath.length > 0
      ? transcriptPath
      : null;
  return JSON.stringify(payload);
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

  const stdinPayload = buildStdinPayload(context, sessionId, agentCwd, opts.transcriptPath);

  const childEnv = buildChildEnv(opts, agentCwd, sessionId, context);
  // Deliberate omission: no AFK_TOOL_ERROR env var for PostToolUseFailure.
  // The error string is available in the stdin JSON payload under the 'error'
  // key. Injecting it as an env var risks shell-injection if the error message
  // contains shell metacharacters; parse the stdin payload instead.

  return new Promise<CommandExecutorResult>((resolve) => {
    // Establish settled flag before spawn so cleanup handlers established
    // in the event-loop microtask queue can safely reference it.
    let settled = false;

    function settle(result: CommandExecutorResult): void {
      // unref() is idempotent — calling it again after a prior settle() is
      // harmless and ensures the event loop is never pinned by the child process.
      proc.unref();
      if (settled) return;
      settled = true;
      resolve(result);
    }

    const isWin32 = process.platform === 'win32';
    const shellResolution = resolveShell();
    const spawnOpts = {
      stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
      cwd: agentCwd,
      env: childEnv,
      // detached: true creates a process group on POSIX (allows group kill).
      // On Windows, detached does not create a process group — set false there
      // to avoid misleading behaviour and unref() artefacts.
      detached: !isWin32,
    };
    const proc =
      shellResolution.shell === true
        ? // POSIX: let Node pick /bin/sh via shell:true (existing behaviour).
          spawn(command, { shell: true, ...spawnOpts })
        : // Windows: spawn the resolved shell with args + command string.
          spawn(
            shellResolution.shell,
            [...(shellResolution.args ?? []), command],
            spawnOpts,
          );
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
      // Kill the process group (POSIX) / process tree (Windows) to avoid orphans.
      if (proc.pid !== undefined) {
        killProcessGroup(proc.pid);
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

/**
 * Apply the per-plugin env allowlist from `pluginHookEnv[pluginName]` onto
 * `childEnv`. Each listed var is resolved from `process.env` first, then
 * `afk.env`. AFK's own credentials are silently refused with a console.warn.
 *
 * Asymmetry: the deny-list only covers `AFK_*` vars that match
 * `PLUGIN_ENV_DENIED_SUFFIX` (plus the explicit `PLUGIN_ENV_DENIED_NAMES` set).
 * A non-AFK credential (e.g. `OPENROUTER_API_KEY`) that the user explicitly
 * lists in `pluginHookEnv` **will** be forwarded — this is intentional: the
 * user opted in via their config, which is human-tier gated. The asymmetry is
 * by design; only AFK's own internal secrets are unconditionally refused.
 *
 * Extracted from {@link executeCommand} to keep that function within the 200-
 * line ceiling (pnpm audit:funcsize:check).
 */
function applyPluginHookEnv(
  childEnv: NodeJS.ProcessEnv,
  pluginName: string,
  pluginHookEnv: Record<string, string[]>,
): void {
  const allowedVarNames = pluginHookEnv[pluginName];
  if (allowedVarNames === undefined || allowedVarNames.length === 0) return;
  // Lazy-read afk.env so it is parsed at most once and only when needed.
  let afkEnvCache: Record<string, string> | undefined;
  const getAfkEnv = (): Record<string, string> => {
    if (afkEnvCache === undefined) {
      afkEnvCache = readEnvFile(getEnvConfigPath());
    }
    return afkEnvCache;
  };
  for (const varName of allowedVarNames) {
    // Refuse AFK's own credentials regardless of user intent.
    if (
      PLUGIN_ENV_DENIED_NAMES.has(varName) ||
      (varName.startsWith('AFK_') && PLUGIN_ENV_DENIED_SUFFIX.test(varName))
    ) {
      console.warn(
        `[hooks] pluginHookEnv: refusing to forward protected credential "${varName}" to plugin "${pluginName}" hook — remove it from pluginHookEnv to suppress this warning`,
      );
      continue;
    }
    // Resolve: process.env wins over afk.env (shell profile takes precedence).
    const fromProcess = process.env[varName];
    if (fromProcess !== undefined && fromProcess !== '') {
      childEnv[varName] = fromProcess;
      continue;
    }
    const fromFile = getAfkEnv()[varName];
    if (fromFile !== undefined && fromFile !== '') {
      childEnv[varName] = fromFile;
    }
  }
}

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
  // `hookSpecificOutput.updatedInput`       → updatedInput (PreToolUse only)
  const hso = obj['hookSpecificOutput'];
  if (hso !== null && typeof hso === 'object' && !Array.isArray(hso)) {
    const hsoObj = hso as Record<string, unknown>;
    if (typeof hsoObj['additionalContext'] === 'string') {
      decision.injectContext = hsoObj['additionalContext'];
    }
    // Accept only a plain object; ignore arrays, primitives, null.
    const ui = hsoObj['updatedInput'];
    if (ui !== null && typeof ui === 'object' && !Array.isArray(ui)) {
      decision.updatedInput = ui as Record<string, unknown>;
    }
  }

  return decision;
}

/**
 * Build the child-process environment for a hook subprocess.
 *
 * Security contract: only a minimal allowlist of runtime-safe vars is forwarded.
 * Extracted from {@link executeCommand} to keep that function within the 200-
 * line ceiling (pnpm audit:funcsize:check).
 */
function buildChildEnv(
  opts: ExecuteCommandOptions,
  agentCwd: string,
  sessionId: string | undefined,
  context: HookContext,
): NodeJS.ProcessEnv {
  const toolName =
    context.event === 'PreToolUse' ||
    context.event === 'PostToolUse' ||
    context.event === 'PostToolUseFailure'
      ? context.toolName
      : '';

  // Allowed passthrough: PATH, HOME, SHELL, LANG, TERM (basic shell operation),
  // TMPDIR / TMP / TEMP (temp-file ops), USER / LOGNAME (some hooks probe them).
  const ENV_PASSTHROUGH = ['PATH', 'HOME', 'SHELL', 'LANG', 'TERM', 'TMPDIR', 'TMP', 'TEMP', 'USER', 'LOGNAME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'] as const;
  const childEnv: NodeJS.ProcessEnv = {};
  for (const key of ENV_PASSTHROUGH) {
    const val = process.env[key];
    if (val !== undefined) childEnv[key] = val;
  }
  // Forward non-secret AFK_* vars (e.g. AFK_HOME) but NEVER AFK_-prefixed
  // credential aliases. Suffix pattern avoids false positives on count-style
  // knobs like AFK_MAX_TOKENS.
  const AFK_SECRET_SUFFIX = /_(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|CREDENTIALS)$/i;
  for (const [key, val] of Object.entries(process.env)) {
    if (!key.startsWith('AFK_') || val === undefined) continue;
    if (AFK_SECRET_SUFFIX.test(key)) continue;
    childEnv[key] = val;
  }
  childEnv['AFK_PROJECT_DIR'] = agentCwd;
  childEnv['AFK_SESSION_ID'] = sessionId ?? '';
  childEnv['AFK_HOOK_EVENT'] = context.event;
  childEnv['AFK_TOOL_NAME'] = toolName;
  // Plugin path vars (non-secret); only for plugin-sourced hooks.
  if (opts.pluginRoot !== undefined) {
    childEnv['CLAUDE_PLUGIN_ROOT'] = opts.pluginRoot;
    childEnv['CLAUDE_PROJECT_DIR'] = agentCwd;
  }
  // Per-plugin env allowlist (#2459) — see applyPluginHookEnv.
  if (opts.pluginName !== undefined && opts.pluginHookEnv !== undefined) {
    applyPluginHookEnv(childEnv, opts.pluginName, opts.pluginHookEnv);
  }
  return childEnv;
}
