/**
 * Builders for the POSIX shell scripts `remote_agent` runs on a remote host
 * over SSH. Every script is executed by `/bin/sh -c` on the remote (see
 * `ssh-runner.ts`), so it never depends on the remote user's login shell
 * (zsh does not word-split unquoted variables; bash does).
 *
 * Contract: every caller-supplied value (run id, cwd, model, resume id, afk
 * path) is embedded through {@link shQuote}. The prompt is never embedded; it
 * travels on ssh stdin into `<runDir>/prompt`, so its content cannot be
 * interpreted by any shell.
 *
 * Invariant: the recursion guard is inlined into the launch command
 * (`AFK_MAX_NESTING_DEPTH=0 AFK_REMOTE_DEPTH=1`). Forwarding env over ssh is
 * not an option: sshd's default `AcceptEnv` only passes LANG/LC_*, so a
 * forwarded variable would be silently dropped and the guard would not exist.
 *
 * @module remote/remote-script
 */

/** Line the launch script prints with the detached afk pid. */
export const PID_MARKER = '__AFK_REMOTE_PID__';
/** Line the follow script prints after the remote afk process has exited. */
export const EXIT_MARKER = '__AFK_REMOTE_EXIT__';
/** Exit code the launch script uses when no afk binary can be found. */
export const EXIT_AFK_NOT_FOUND = 3;
/** Exit code the launch script uses when `cd` into the requested cwd fails. */
export const EXIT_BAD_CWD = 4;
/** Exit code the launch script uses when the login keychain could not be unlocked. */
export const EXIT_KEYCHAIN_UNLOCK = 5;

/** Single-quote `value` for POSIX sh. Safe for any byte sequence without NUL. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Quote a path, expanding a leading `~` or `~/` to the remote `$HOME`. */
export function shQuotePath(path: string): string {
  if (path === '~') return '"$HOME"';
  if (path.startsWith('~/')) return `"$HOME"/${shQuote(path.slice(2))}`;
  return shQuote(path);
}

/** Remote run directory expression (evaluated by the remote shell). */
export function runDirExpr(runId: string): string {
  return `"$HOME"/.afk/state/remote-runs/${shQuote(runId)}`;
}

export interface LaunchScriptOptions {
  runId: string;
  /** New session id, passed as `--session-id`. Ignored when `resume` is set. */
  sessionId: string;
  cwd?: string;
  model?: string;
  resume?: string;
  /** Absolute afk path on the remote; resolved by the script when absent. */
  afkPath?: string;
  /**
   * Permission mode to pin on the remote `afk chat` invocation via
   * `--permission-mode`. When absent the remote resolves its own default
   * (typically `bypassPermissions` from `DEFAULT_CLI_PERMISSION_MODE`).
   */
  permissionMode?: string;
  /**
   * When true, the FIRST stdin line is the remote login password, already
   * escaped for `security -i` (see `keychain-unlock.ts`); the prompt follows.
   */
  unlockKeychain?: boolean;
}

// Invariant: the password is read with the shell builtin `read`, interpolated
// by the builtin `printf`, and reaches `security` only through a pipe into
// `security -i`, so it never appears in any process's argv. The variable is
// cleared immediately, and the unlock is verified non-interactively (over SSH
// a locked keychain fails fast instead of prompting).
const UNLOCK_KEYCHAIN = [
  'IFS= read -r kcpw || kcpw=',
  'kc="$HOME/Library/Keychains/login.keychain-db"',
  `printf 'unlock-keychain -p "%s" "%s"\\n' "$kcpw" "$kc" | security -i >/dev/null 2>&1 || true`,
  'kcpw=',
  'if ! security show-keychain-info "$kc" >/dev/null 2>&1; then',
  `  echo "could not unlock the login keychain (is the stored password current?)" >&2; exit ${EXIT_KEYCHAIN_UNLOCK}`,
  'fi',
];

// Invariant: resolution order is (1) explicit afkPath, (2) the non-interactive
// PATH, (3) scanning the interactive shell's PATH for an executable `afk`
// (nvm installs typically load from .zshrc, and `afk` may be a shell function
// there, so `command -v` inside that shell is not trustworthy), (4) nvm's
// default install glob. The bin dir is then prepended to PATH because npm's
// afk shim starts with `#!/usr/bin/env node`, and node lives in that same dir.
const RESOLVE_AFK = [
  'if [ -z "$p" ]; then p=$(command -v afk 2>/dev/null || true); case "$p" in /*) ;; *) p= ;; esac; fi',
  'if [ -z "$p" ]; then',
  `  ip=$("\${SHELL:-/bin/sh}" -ic 'printf "__AFK_PATH__%s\\n" "$PATH"' </dev/null 2>/dev/null | sed -n 's/^__AFK_PATH__//p' | tail -n 1)`,
  '  oldifs=$IFS; IFS=:',
  '  for dir in $ip; do if [ -x "$dir/afk" ]; then p="$dir/afk"; break; fi; done',
  '  IFS=$oldifs',
  'fi',
  'if [ -z "$p" ]; then for c in "$HOME"/.nvm/versions/node/*/bin/afk; do if [ -x "$c" ]; then p=$c; fi; done; fi',
  `if [ -z "$p" ]; then echo "afk not found on the remote PATH or interactive-shell PATH" >&2; exit ${EXIT_AFK_NOT_FOUND}; fi`,
];

/** Script that stores the prompt (from stdin), starts afk detached, and prints its pid. */
export function buildLaunchScript(opts: LaunchScriptOptions): string {
  const args = ['chat', '--format', 'stream-json'];
  if (opts.resume !== undefined) args.push('--resume', opts.resume);
  else args.push('--session-id', opts.sessionId);
  if (opts.model !== undefined) args.push('--model', opts.model);
  if (opts.permissionMode !== undefined) args.push('--permission-mode', opts.permissionMode);
  const lines = [
    'set -e',
    'umask 077',
    `d=${runDirExpr(opts.runId)}`,
    'mkdir -p "$d"',
    // Must precede `cat`: the password is the first stdin line.
    ...(opts.unlockKeychain === true ? UNLOCK_KEYCHAIN : []),
    'cat > "$d/prompt"',
    `p=${opts.afkPath !== undefined ? shQuote(opts.afkPath) : "''"}`,
    ...RESOLVE_AFK,
  ];
  if (opts.cwd !== undefined) {
    const q = shQuotePath(opts.cwd);
    lines.push(`cd ${q} || { echo "cannot cd to "${q} >&2; exit ${EXIT_BAD_CWD}; }`);
  }
  lines.push(
    ': > "$d/out.ndjson"',
    // Detached: nohup + full redirection so ssh returns immediately and a
    // dropped connection or sleeping laptop does not kill the run.
    'PATH="$(dirname "$p"):$PATH" AFK_MAX_NESTING_DEPTH=0 AFK_REMOTE_DEPTH=1 ' +
      `nohup "$p" ${args.map(shQuote).join(' ')} < "$d/prompt" > "$d/out.ndjson" 2> "$d/err.log" &`,
    'echo "$!" > "$d/pid"',
    `echo "${PID_MARKER} $!"`,
  );
  return lines.join('\n');
}

/**
 * Script that streams `out.ndjson` from 1-based line `startLine` until the
 * afk process exits, then prints {@link EXIT_MARKER}. Re-running it with the
 * next unseen line number is how a dropped connection resumes.
 */
export function buildFollowScript(runId: string, startLine: number): string {
  const start = Math.max(1, Math.floor(startLine));
  return [
    `d=${runDirExpr(runId)}`,
    'pid=$(cat "$d/pid" 2>/dev/null || echo 0)',
    `tail -n +${start} -f "$d/out.ndjson" &`,
    't=$!',
    'while kill -0 "$pid" 2>/dev/null; do sleep 1; done',
    // Give tail one poll interval to emit the final lines before stopping it.
    'sleep 1',
    'kill "$t" 2>/dev/null',
    'wait "$t" 2>/dev/null',
    `echo "${EXIT_MARKER}"`,
  ].join('\n');
}

/** Script that stops the remote afk process (best-effort, always exits 0). */
export function buildCancelScript(runId: string): string {
  return [
    `d=${runDirExpr(runId)}`,
    'pid=$(cat "$d/pid" 2>/dev/null) && kill "$pid" 2>/dev/null',
    'exit 0',
  ].join('\n');
}

/** Script that prints the last 2000 bytes of the run's stderr log. */
export function buildErrTailScript(runId: string): string {
  return [`d=${runDirExpr(runId)}`, 'tail -c 2000 "$d/err.log" 2>/dev/null', 'exit 0'].join('\n');
}
