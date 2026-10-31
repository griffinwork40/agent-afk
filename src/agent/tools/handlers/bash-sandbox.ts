/**
 * OS-level sandbox wrapper for bash tool spawns (issue #3845).
 *
 * // Contract: wraps a shell command in a platform-appropriate sandbox when
 * // `AFK_BASH_SANDBOX` is set. Three policies are supported:
 * //
 * //   workspace-write  Allow reads everywhere; confine writes to the session
 * //                    cwd/worktree and the child temp dir. Credential paths from
 * //                    the write-denylist floor are always denied.
 * //   read-only        Deny regular-file writes (standard device IO remains).
 * //   off              No-op; sandbox disabled.
 * //
 * // Platform behaviour:
 * //
 * //   macOS   — sandbox-exec -p <profile>. Deprecated in Xcode 14+ but
 * //             functional through macOS 15. Profile uses TinyScheme s-expr syntax.
 * //
 * //   Linux   — bwrap (bubblewrap) from trusted system locations. When unavailable and the
 * //             policy is not 'off', the spawn is REFUSED (fail-closed).
 * //
 * //   Windows — Fail-closed: throws so the caller refuses the spawn. The OS
 * //             sandbox mechanisms (sandbox-exec, bwrap) do not
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
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { env } from '../../../config/env.js';
import { canonicalSandboxPath, sandboxWriteFloor, sandboxFloorAncestors, assertDisjointSandboxGrants, sandboxSchemeString } from './bash-sandbox.paths.js';

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
 * SBPL uses last-matching-rule precedence: all floor denies MUST follow grants.
 * Default allow deliberately preserves git, networking, IPC and ordinary process
 * operations. This is a filesystem write sandbox, not a secret-read sandbox.
 */
function buildMacosProfile(policy: SandboxPolicy, cwd: string, temp: string): string {
  const grants = policy === 'workspace-write' ? [cwd, temp] : [];
  const floor = sandboxWriteFloor();
  return [
    '(version 1)',
    '(allow default)',
    '(allow network*)',
    '(allow file-read*)',
    '(deny file-write*)',
    // Git opens /dev/null O_RDWR. This grants device IO, not regular-file writes.
    '(allow file-write-data (literal "/dev/null"))',
    ...grants.map((p) => `  (allow file-write* (subpath ${sandboxSchemeString(p)}))`),
    ...floor.map((p) => `  (deny file-write* (subpath ${sandboxSchemeString(p)}))`),
    // Prevent moving a protected subtree out from under its pathname deny.
    ...sandboxFloorAncestors(floor).map((p) => `  (deny file-write-unlink (literal ${sandboxSchemeString(p)}))`),
  ].join('\n');
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
  cwd: string,
  temp: string,
): SandboxedCommand {
  const profile = buildMacosProfile(policy, cwd, temp);
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

/** Cache availability and the trusted absolute binary path across calls. */
let _bwrapAvailable: boolean | undefined;
let _bwrapPath: string | undefined;

/** @internal Exposed for testing only. Resets the bwrap availability cache. */
export function _resetBwrapCacheForTests(): void {
  _bwrapAvailable = undefined;
  _bwrapPath = undefined;
}

/** @internal Exposed for testing only. Forces bwrap-unavailable without exec. */
export function _forceBwrapUnavailableForTests(): void {
  _bwrapAvailable = false;
  _bwrapPath = undefined;
}

function isBwrapAvailable(): boolean {
  if (_bwrapAvailable !== undefined) return _bwrapAvailable;
  // Never resolve through PATH: the workspace may control its entries.
  for (const directory of [['usr', 'bin'], ['usr', 'local', 'bin'], ['usr', 'sbin']]) {
    const candidate = path.posix.join('/', ...directory, 'bwrap');
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore', timeout: 3_000 });
      _bwrapPath = candidate;
      _bwrapAvailable = true;
      return true;
    } catch {
      // Try the remaining trusted locations; never fall back to PATH.
    }
  }
  _bwrapAvailable = false;
  return false;
}

/** Root is read-only; private proc/dev directories are remounted read-only.
 * Writable mounts must be wholly disjoint from the full live write floor.
 */
function buildLinuxBwrapCommand(
  command: string,
  policy: SandboxPolicy,
  cwd: string,
  temp: string,
  bwrapPath: string,
): SandboxedCommand {
  const root = path.posix.join('/');
  // A host /proc exposes other processes' writable /proc/PID/root aliases.
  // A private PID namespace + read-only proc mount closes that mount escape.
  const proc = path.posix.join('/', 'proc');
  const dev = path.posix.join('/', 'dev');
  const bwrapArgs: string[] = [
    '--ro-bind', root, root, '--cap-drop', 'ALL', '--unshare-pid',
    '--proc', proc, '--remount-ro', proc,
    // A read-only host /dev still permits IO to device nodes (including disks).
    // Expose only inert standard IO devices, in a read-only private directory.
    '--tmpfs', dev,
  ];
  for (const name of ['null', 'zero', 'full', 'random', 'urandom']) {
    const device = path.posix.join(dev, name);
    bwrapArgs.push('--dev-bind', device, device);
  }
  // Preserve standard descriptor aliases before sealing the private /dev.
  for (const [target, name] of [['fd', 'fd'], ['fd/0', 'stdin'], ['fd/1', 'stdout'], ['fd/2', 'stderr']] as const) {
    bwrapArgs.push('--symlink', path.posix.join(proc, 'self', target), path.posix.join(dev, name));
  }
  bwrapArgs.push('--remount-ro', dev);
  if (policy === 'workspace-write') {
    const grants = [...new Set([cwd, temp])];
    // Never let a later grant shadow private proc or expose writable kernel/device
    // interfaces, including ancestor/descendant and canonical-alias grants.
    // Use path.resolve so the roots match the OS-native paths that
    // canonicalSandboxPath returns (cross-platform, including Windows tests).
    const kernelRoots = ['proc', 'dev', 'sys'].map((name) => path.resolve('/', name));
    assertDisjointSandboxGrants(grants, [...sandboxWriteFloor(), ...kernelRoots]);
    for (const grant of grants) bwrapArgs.push('--bind', grant, grant);
  }
  bwrapArgs.push('--', path.posix.join('/', 'bin', 'sh'), '-c');
  return { shell: bwrapPath, args: bwrapArgs, command, sandboxed: true };
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
  childTemp: string = tmpdir(),
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
        `supported on Windows. The sandbox mechanisms (sandbox-exec, bwrap) ` +
        `are macOS/Linux-only. Either unset AFK_BASH_SANDBOX or set it to "off" ` +
        `to run without sandboxing on this platform. ` +
        `Existing string-based path guards remain active regardless of this setting.`,
    );
  }

  const effectiveCwd = canonicalSandboxPath(cwd ?? process.cwd());
  // Relative TMPDIR is interpreted by the child from its effective cwd.
  const effectiveTemp = canonicalSandboxPath(path.resolve(effectiveCwd, childTemp));
  if (platform === 'darwin') {
    return buildMacosSandboxedCommand(command, policy, effectiveCwd, effectiveTemp);
  }

  // Only Linux supports this bwrap backend; all other platforms fail closed.
  if (platform === 'linux' && isBwrapAvailable() && _bwrapPath !== undefined) {
    return buildLinuxBwrapCommand(command, policy, effectiveCwd, effectiveTemp, _bwrapPath);
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
