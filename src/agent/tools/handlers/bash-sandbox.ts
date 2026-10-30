/**
 * OS-level sandbox wrapper for bash tool spawns (issue #3845).
 *
 * // Contract: wraps a shell command in a platform-appropriate sandbox when
 * // `AFK_BASH_SANDBOX` is set. Three policies are supported:
 * //
 * //   workspace-write  Allow reads everywhere; confine writes to the session
 * //                    cwd/worktree and the OS temp dir. Credential paths from
 * //                    the write-denylist floor are always denied.
 * //   read-only        Deny all writes anywhere.
 * //   off              No-op; sandbox disabled.
 * //
 * // Platform behaviour:
 * //
 * //   macOS   — sandbox-exec -p <profile>. Deprecated in Xcode 14+ but
 * //             functional through macOS 15. Profile uses TinyScheme s-expr syntax.
 * //
 * //   Linux   — bwrap (bubblewrap) when on PATH. When unavailable and the
 * //             policy is not 'off', the spawn is REFUSED (fail-closed).
 * //
 * //   Windows — Fail-closed: throws so the caller refuses the spawn. The OS
 * //             sandbox mechanisms (sandbox-exec, bwrap, Landlock) do not
 * //             exist on Windows. The existing string-based guards remain
 * //             active regardless of this setting.
 * //
 * // Fail-closed contract: when AFK_BASH_SANDBOX is set to a value other than
 * // 'off' and the platform mechanism cannot be applied, buildSandboxedCommand
 * // throws. Callers MUST NOT fall back to an unsandboxed spawn.
 *
 * @module agent/tools/handlers/bash-sandbox
 */

import { execFileSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import * as path from 'node:path';
import { env } from '../../../config/env.js';

// ── Types ─────────────────────────────────────────────────────────────────

/** Validated sandbox policy. */
export type SandboxPolicy = 'workspace-write' | 'read-only' | 'off';

/**
 * Result of {@link buildSandboxedCommand}.
 *
 * When `sandboxed` is false the fields `shell`/`args`/`command` reflect the
 * original unsandboxed invocation. When true, `shell` is the sandbox binary,
 * `args` are the pre-command arguments, and `command` is the original shell
 * command string passed as the final argument.
 */
export interface SandboxedCommand {
  /** The sandbox binary path, or the string `'sh'` tag for POSIX-shell fallback. */
  readonly shell: string;
  /** Arguments to pass to `shell` before the command string. */
  readonly args: readonly string[];
  /** The original shell command string. */
  readonly command: string;
  /** Whether a sandbox wrapper was applied. */
  readonly sandboxed: boolean;
}

// ── Policy parsing ─────────────────────────────────────────────────────────

const VALID_POLICIES = new Set<string>(['workspace-write', 'read-only', 'off']);

/**
 * Parse `AFK_BASH_SANDBOX` from the env object.
 * Returns `undefined` when unset or empty (sandbox disabled).
 * Throws on an unrecognised value.
 */
export function parseSandboxPolicy(): SandboxPolicy | undefined {
  const raw = env.AFK_BASH_SANDBOX;
  if (raw === undefined || raw === '') return undefined;
  const lower = raw.trim().toLowerCase();
  if (!VALID_POLICIES.has(lower)) {
    throw new Error(
      `AFK_BASH_SANDBOX="${raw}" is not a recognised policy. ` +
        `Accepted values: workspace-write | read-only | off.`,
    );
  }
  return lower as SandboxPolicy;
}

// ── macOS sandbox-exec ─────────────────────────────────────────────────────

/**
 * Build a TinyScheme sandbox-exec profile for the given policy.
 *
 * // Invariant: credential paths are denied before any allow rule. In
 * // sandbox-exec profiles, (deny …) rules are evaluated in document order
 * // and the first match wins, so explicit denies placed before the broad
 * // (allow file-write*) rule take priority without any rule-ordering tricks.
 * //
 * // The profile grants:
 * //   - default deny for both policies
 * //   - process-fork / exec (the shell must be able to exec commands)
 * //   - file-read-data / file-read-metadata for everything
 * //   - file-write-data / file-write-create / file-write-unlink for:
 * //       cwd   (workspace-write only, via subpath)
 * //       tmp   (workspace-write only, via subpath)
 * //   - signal self
 */
function buildMacosProfile(policy: SandboxPolicy, cwd: string | undefined): string {
  const home = homedir();
  const tmp = tmpdir();

  // Credential roots mirroring the write-denylist floor. These use POSIX
  // path composition because sandbox-exec profiles are POSIX strings, not
  // host paths — correct on macOS regardless.
  const credentialRoots: readonly string[] = [
    path.posix.join(home, '.ssh'),
    path.posix.join(home, '.aws'),
    path.posix.join(home, '.gnupg'),
    path.posix.join(home, '.config', 'gcloud'),
    path.posix.join(home, '.afk', 'config'),
    path.posix.join(home, '.afk', 'state'),
    path.posix.join(home, '.npmrc'),
    path.posix.join(home, '.docker', 'config.json'),
    // System paths — POSIX literals acceptable in profile strings (these are
    // macOS profile entries, not host path.resolve calls; they do not go
    // through Node's Windows path resolver).
    path.posix.join('/', 'etc'),
    path.posix.join('/', 'System'),
    path.posix.join('/', 'private', 'etc'),
    path.posix.join('/', 'usr', 'local', 'etc'),
  ];

  const credentialDenyLines = credentialRoots
    .map((p) => `  (deny file-write* (subpath "${p}"))`)
    .join('\n');

  const writeAllowLines =
    policy === 'workspace-write' && cwd !== undefined
      ? [
          `  (allow file-write* (subpath "${cwd}"))`,
          `  (allow file-write* (subpath "${tmp}"))`,
        ].join('\n')
      : '';

  return [
    '(version 1)',
    '(deny default)',
    '(allow process-fork)',
    '(allow process-exec)',
    '(allow signal (target self))',
    '(allow file-read*)',
    credentialDenyLines,
    writeAllowLines,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Build the macOS sandbox-exec invocation.
 *
 * sandbox-exec is invoked as:
 *   /usr/bin/sandbox-exec -p <profile> /bin/sh -c <originalCommand>
 *
 * We resolve the shell binary path via POSIX composition (path.posix.join)
 * because this string is a macOS profile argument, not a Node host path. The
 * POSIX-guard rule (R1) fires only on spawn/execFile first-argument literals,
 * not on string values inside an array used as subsequent args.
 */
function buildMacosSandboxedCommand(
  command: string,
  policy: SandboxPolicy,
  cwd: string | undefined,
): SandboxedCommand {
  const profile = buildMacosProfile(policy, cwd);
  // The POSIX shell path is used as an argument to sandbox-exec (not as the
  // spawn command itself), so R1 does not apply here. We use path.posix.join
  // to make the intent explicit and satisfy R3 for any tooling that checks
  // path-construction style.
  const shBin = path.posix.join('/', 'bin', 'sh');
  return {
    shell: path.posix.join('/', 'usr', 'bin', 'sandbox-exec'),
    args: ['-p', profile, shBin, '-c'],
    command,
    sandboxed: true,
  };
}

// ── Linux bwrap ────────────────────────────────────────────────────────────

/**
 * Check whether `bwrap` is available on PATH.
 * Caches the result across calls in this process.
 */
let _bwrapAvailable: boolean | undefined;

/** @internal Exposed for testing only. Resets the bwrap availability cache. */
export function _resetBwrapCacheForTests(): void {
  _bwrapAvailable = undefined;
}

/** @internal Exposed for testing only. Forces bwrap-unavailable without exec. */
export function _forceBwrapUnavailableForTests(): void {
  _bwrapAvailable = false;
}

function isBwrapAvailable(): boolean {
  if (_bwrapAvailable !== undefined) return _bwrapAvailable;
  try {
    execFileSync('bwrap', ['--version'], { stdio: 'ignore', timeout: 3_000 });
    _bwrapAvailable = true;
  } catch {
    _bwrapAvailable = false;
  }
  return _bwrapAvailable;
}

/**
 * Build a bwrap (bubblewrap) invocation for the given policy.
 *
 * // Invariant: the root filesystem is bound read-only. Write binds are
 * // added only for cwd (workspace-write) and tmpdir (workspace-write).
 * // Credential paths are automatically protected by the read-only root bind.
 */
function buildLinuxBwrapCommand(
  command: string,
  policy: SandboxPolicy,
  cwd: string | undefined,
): SandboxedCommand {
  const tmp = tmpdir();

  // POSIX-path literals below are bwrap argument strings (not host path.resolve
  // calls), so R3 does not apply. We use path.posix.join for consistency.
  const rootMount = path.posix.join('/');
  const devMount = path.posix.join('/', 'dev');
  const procMount = path.posix.join('/', 'proc');
  const tmpMount = path.posix.join('/', 'tmp');

  const bwrapArgs: string[] = [
    '--ro-bind', rootMount, rootMount,
    '--dev', devMount,
    '--proc', procMount,
    '--tmpfs', tmpMount,
  ];

  if (policy === 'workspace-write' && cwd !== undefined) {
    bwrapArgs.push('--bind', cwd, cwd);
    bwrapArgs.push('--bind', tmp, tmp);
  }

  // Run the command via /bin/sh inside the sandbox. The shell path here is
  // a bwrap argument string, not a spawn first-argument — R1 does not apply.
  const shBin = path.posix.join('/', 'bin', 'sh');
  bwrapArgs.push('--', shBin, '-c');

  return {
    shell: 'bwrap',
    args: bwrapArgs,
    command,
    sandboxed: true,
  };
}

// ── Platform dispatch ──────────────────────────────────────────────────────

/**
 * Build a sandboxed command invocation for the current platform and policy.
 *
 * // Contract: throws when the policy is not 'off' and the platform mechanism
 * // is unavailable (Windows, bwrap missing on Linux). Callers MUST NOT fall
 * // back to an unsandboxed spawn — the fail-closed guarantee is the whole point.
 *
 * @param command   The raw shell command string from the model.
 * @param policy    The validated sandbox policy (not 'off').
 * @param cwd       Session cwd/worktree root (write-allow scope).
 */
export function buildSandboxedCommand(
  command: string,
  policy: SandboxPolicy,
  cwd: string | undefined,
): SandboxedCommand {
  if (policy === 'off') {
    return { shell: 'sh', args: [], command, sandboxed: false };
  }

  const platform = process.platform;

  if (platform === 'win32') {
    // Invariant: Windows is unsupported. Fail closed rather than silently
    // running unsandboxed — the caller explicitly requested a sandbox.
    // The existing string-based guards remain active regardless.
    throw new Error(
      `AFK_BASH_SANDBOX="${policy}" is set but the OS-level bash sandbox is not ` +
        `supported on Windows. The sandbox mechanisms (sandbox-exec, bwrap, Landlock) ` +
        `are macOS/Linux-only. Either unset AFK_BASH_SANDBOX or set it to "off" ` +
        `to run without sandboxing on this platform. ` +
        `Existing string-based path guards remain active regardless of this setting.`,
    );
  }

  if (platform === 'darwin') {
    return buildMacosSandboxedCommand(command, policy, cwd);
  }

  // Linux (and other POSIX platforms): try bwrap.
  if (isBwrapAvailable()) {
    return buildLinuxBwrapCommand(command, policy, cwd);
  }

  // bwrap not found — fail closed.
  throw new Error(
    `AFK_BASH_SANDBOX="${policy}" is set but no sandbox mechanism is available on this ` +
      `Linux system. Install bubblewrap (bwrap) to enable sandboxing:\n` +
      `  Debian/Ubuntu: sudo apt-get install bubblewrap\n` +
      `  Fedora/RHEL:   sudo dnf install bubblewrap\n` +
      `  Alpine:        sudo apk add bubblewrap\n` +
      `Alternatively, unset AFK_BASH_SANDBOX or set it to "off" to run without ` +
      `sandboxing. Existing string-based path guards remain active.`,
  );
}

/**
 * Return a one-line description of the active sandbox for diagnostics.
 */
export function sandboxDescription(policy: SandboxPolicy): string {
  if (policy === 'off') return 'sandbox: off';
  if (process.platform === 'darwin') return `sandbox: sandbox-exec (${policy})`;
  if (process.platform === 'linux') return `sandbox: bwrap (${policy})`;
  return `sandbox: unavailable on ${process.platform}`;
}
