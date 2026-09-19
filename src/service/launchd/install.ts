import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname } from 'path';
import { guiDomain, LAUNCHCTL_TIMEOUT_MS, labelFor, launchAgentsDir, plistPath, serviceLogPath, type ServiceName } from './paths.js';
import { type PlistOptions, renderPlist, resolveServicePath, resolveWatchPaths, resolveProgramArguments } from './plist.js';

/**
 * Extract `EnvironmentVariables` key→value pairs from a plist string.
 * Used by `upgradeService` to preserve installed env vars when
 * `opts.environment` is undefined (#1717). Never throws; returns {} on
 * any parse failure so the caller degrades to a PATH-only environment.
 */
export function extractPlistEnvVars(plistXml: string): Record<string, string> {
  try {
    const section = plistXml.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/);
    if (!section?.[1]) return {};
    const vars: Record<string, string> = {};
    const re = /<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g;
    const unescape = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    let m: RegExpExecArray | null;
    while ((m = re.exec(section[1])) !== null) vars[unescape(m[1]!)] = unescape(m[2]!);
    return vars;
  } catch { return {}; }
}

// ─────────────────────────────────────────────────────────────────────────
// Install / uninstall I/O
// ─────────────────────────────────────────────────────────────────────────

/** Result discriminated union for `installService()`. */
export type InstallResult =
  | { kind: 'installed'; plistPath: string; label: string; watchPathsActive: boolean }
  | { kind: 'already-installed'; plistPath: string; label: string }
  | { kind: 'failed'; reason: string };

/** Result discriminated union for `upgradeService()`. */
export type UpgradeResult =
  | { kind: 'upgraded'; plistPath: string; label: string }
  | { kind: 'already-current'; plistPath: string; label: string }
  | { kind: 'not-installed'; plistPath: string }
  | { kind: 'failed'; reason: string };

/** Result discriminated union for `uninstallService()`. */
export type UninstallResult =
  | { kind: 'uninstalled'; plistPath: string }
  | { kind: 'not-installed'; plistPath: string }
  | { kind: 'failed'; reason: string };

/** Install opts kept narrow so tests can pin behaviour. */
export interface InstallOptions {
  /** Disable WatchPaths even if the heuristic would have emitted them. */
  noWatch?: boolean;
  /** Skip the `launchctl bootstrap` step (tests; or for dry-runs). */
  skipBootstrap?: boolean;
  /** Extra env vars to surface in the plist. */
  environment?: Record<string, string>;
  /**
   * Override the `existsSync` check used to validate the entrypoint path
   * before writing the plist (M-9). Exposed for unit tests that stub the
   * telegram manager to return a fake path that doesn't exist on disk.
   * Production callers should omit this — the real `existsSync` is the
   * correct guard.
   */
  _entrypointExistsCheck?: (p: string) => boolean;
}

/**
 * Write the LaunchAgent plist and (unless skipped) load it with launchctl.
 *
 * Constraint ordering rationale: the plist file MUST exist on disk before
 * `launchctl bootstrap` runs, otherwise bootstrap fails with "input/output
 * error". So we write → bootstrap, never the inverse.
 *
 * Write atomicity: we write the rendered XML to a sibling tmp file with
 * `O_EXCL` (`flag: 'wx'`) + explicit `mode: 0o600`, then `renameSync` it
 * into place. APFS guarantees the rename is atomic relative to crashes,
 * which means an observer (including launchctl bootstrap on a retry)
 * will see either the full new plist or the previous state — never a
 * truncated half-written file that passes `existsSync` but fails XML
 * parsing. The `wx` flag closes the TOCTOU window between the
 * `existsSync` check above and the write: if another process (or a
 * symlink attack) created the tmp path between the two operations,
 * `writeFileSync` throws instead of following a symlink to clobber an
 * arbitrary file. Explicit `mode: 0o600` overrides the user's `umask` so
 * the plist file is owner-readable only — the plist may embed env-var
 * values (API keys, tokens) and should not be world-readable.
 */
export function installService(name: ServiceName, opts: InstallOptions = {}): InstallResult {
  const path = plistPath(name);
  if (existsSync(path)) {
    return { kind: 'already-installed', plistPath: path, label: labelFor(name) };
  }
  let args: string[];
  try {
    args = resolveProgramArguments(name, opts._entrypointExistsCheck);
  } catch (err) {
    return { kind: 'failed', reason: (err as Error).message };
  }
  const watchPaths = opts.noWatch ? undefined : resolveWatchPaths(name, opts._entrypointExistsCheck);
  const logFile = serviceLogPath(name);

  // Ensure target dirs exist before we write into them.
  mkdirSync(launchAgentsDir(), { recursive: true });
  mkdirSync(dirname(logFile), { recursive: true });

  // launchd's minimal bootstrap PATH excludes Homebrew and version-manager
  // node installs, which crash-loops any service whose entrypoint resolves
  // node via `#!/usr/bin/env node` (see resolveServicePath). Always inject an
  // explicit PATH led by the installer's own node dir; caller-supplied env
  // wins so an explicit `PATH` in opts.environment still overrides.
  const environmentVariables: Record<string, string> = {
    PATH: resolveServicePath(),
    ...(opts.environment ?? {}),
  };

  const plistOpts: PlistOptions = {
    label: labelFor(name),
    programArguments: args,
    workingDirectory: homedir(),
    standardOutPath: logFile,
    standardErrorPath: logFile,
    ...(watchPaths ? { watchPaths } : {}),
    environmentVariables,
  };
  const xml = renderPlist(plistOpts);

  // Atomic write: tmp file with O_EXCL + explicit mode → rename. See
  // function-level docstring for the threat model.
  const tmpPath = `${path}.tmp`;
  try {
    writeFileSync(tmpPath, xml, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
  } catch (err) {
    // Best-effort cleanup so a stale tmp file from a prior failed run
    // doesn't permanently break subsequent installs. We swallow the
    // unlink error: if it fails, the user gets a clearer message on the
    // next install attempt naming the stale tmp path.
    return { kind: 'failed', reason: `Failed to write plist (tmp ${tmpPath}): ${(err as Error).message}` };
  }
  try {
    renameSync(tmpPath, path);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Ignore — the rename error message below is the actionable one.
    }
    return { kind: 'failed', reason: `Failed to install plist (rename ${tmpPath} → ${path}): ${(err as Error).message}` };
  }

  if (opts.skipBootstrap) {
    return {
      kind: 'installed',
      plistPath: path,
      label: labelFor(name),
      watchPathsActive: Boolean(watchPaths),
    };
  }

  try {
    execFileSync('launchctl', ['bootstrap', guiDomain(), path], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: LAUNCHCTL_TIMEOUT_MS,
    });
  } catch (err) {
    const msg = (err as Error).message;

    // M-7: EALREADY (exit status 37) means the service was already loaded
    // by launchd — common after a crash-recovery where launchd auto-
    // reloaded the plist before we bootstrapped it ourselves. Give an
    // actionable message instead of the cryptic OS error.
    if ((err as NodeJS.ErrnoException).code === 'EALREADY' || /\b37\b/.test(msg)) {
      return {
        kind: 'failed',
        reason: `Service already loaded — run 'afk service restart ${name}' to reload with the new plist.`,
      };
    }

    // Common case: job is already bootstrapped (label collision). Try
    // bootout + retry so re-installs after a partial failure recover.
    // Bootout stderr is captured (not redirected to /dev/null) so when
    // the retry bootstrap itself fails, the upstream cause from bootout
    // is preserved and surfaced — otherwise the user sees only the
    // downstream symptom.
    if (/already bootstrapped|already loaded/i.test(msg)) {
      let bootoutStderr = '';
      try {
        execFileSync('launchctl', ['bootout', `${guiDomain()}/${labelFor(name)}`], {
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: LAUNCHCTL_TIMEOUT_MS,
        });
      } catch (bootoutErr) {
        // Capture but don't fail here — bootout often fails with
        // "service not loaded" which is benign. We hold the message in
        // case the retry bootstrap also fails.
        bootoutStderr = (bootoutErr as Error).message;
      }
      try {
        execFileSync('launchctl', ['bootstrap', guiDomain(), path], {
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: LAUNCHCTL_TIMEOUT_MS,
        });
      } catch (retryErr) {
        const retryMsg = (retryErr as Error).message;
        const detail = bootoutStderr
          ? `${retryMsg} (prior bootout: ${bootoutStderr})`
          : retryMsg;
        return { kind: 'failed', reason: `Bootstrap failed: ${detail}` };
      }
    } else {
      return { kind: 'failed', reason: `Bootstrap failed: ${msg}` };
    }
  }
  return {
    kind: 'installed',
    plistPath: path,
    label: labelFor(name),
    watchPathsActive: Boolean(watchPaths),
  };
}

/**
 * Bootout the job and remove its plist file.
 *
 * Constraint ordering: `launchctl bootout` MUST run before `rm` of the
 * plist, otherwise we leave a phantom-loaded job whose plist is gone. So
 * bootout → rm, never the inverse.
 */
export function uninstallService(name: ServiceName, opts: { skipBootout?: boolean } = {}): UninstallResult {
  const path = plistPath(name);
  if (!existsSync(path)) {
    return { kind: 'not-installed', plistPath: path };
  }

  if (!opts.skipBootout) {
    try {
      execFileSync('launchctl', ['bootout', `${guiDomain()}/${labelFor(name)}`], {
        stdio: 'ignore',
        timeout: LAUNCHCTL_TIMEOUT_MS,
      });
    } catch {
      // bootout failure is usually "service not loaded" — non-fatal, keep
      // going so the file gets removed.
    }
  }

  try {
    rmSync(path, { force: true });
  } catch (err) {
    return { kind: 'failed', reason: `Failed to remove plist: ${(err as Error).message}` };
  }
  return { kind: 'uninstalled', plistPath: path };
}

// ─────────────────────────────────────────────────────────────────────────
// Upgrade (re-render + atomic replace)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Re-render the plist for an already-installed service and atomically
 * replace it when the content has changed. Preserves existing env vars
 * (minus PATH, which is always freshly resolved) when opts.environment
 * is not supplied (#1717). Write atomicity: same tmp+rename + O_EXCL
 * pattern as installService().
 */
export function upgradeService(name: ServiceName, opts: InstallOptions = {}): UpgradeResult {
  const path = plistPath(name);
  if (!existsSync(path)) {
    return { kind: 'not-installed', plistPath: path };
  }

  let args: string[];
  try {
    args = resolveProgramArguments(name, opts._entrypointExistsCheck);
  } catch (err) {
    return { kind: 'failed', reason: (err as Error).message };
  }
  const watchPaths = opts.noWatch ? undefined : resolveWatchPaths(name, opts._entrypointExistsCheck);
  const logFile = serviceLogPath(name);

  // Read current plist; never throws (result-only contract).
  let current: string;
  try {
    current = readFileSync(path, 'utf-8');
  } catch (err) {
    return { kind: 'failed', reason: `Failed to read current plist: ${(err as Error).message}` };
  }
  // #1717: preserve installed env vars when opts.environment is not supplied.
  const preservedEnv: Record<string, string> = opts.environment === undefined
    ? (({ PATH: _p, ...rest }) => rest)(extractPlistEnvVars(current))
    : {};

  const environmentVariables: Record<string, string> = {
    PATH: resolveServicePath(),
    ...preservedEnv,
    ...(opts.environment ?? {}),
  };

  const plistOpts: PlistOptions = {
    label: labelFor(name),
    programArguments: args,
    workingDirectory: homedir(),
    standardOutPath: logFile,
    standardErrorPath: logFile,
    ...(watchPaths ? { watchPaths } : {}),
    environmentVariables,
  };
  const desired = renderPlist(plistOpts);
  if (current === desired) {
    return { kind: 'already-current', plistPath: path, label: labelFor(name) };
  }

  // Atomic write: O_EXCL (wx) to close the TOCTOU symlink window at the
  // predictable tmp path. On EEXIST (stale crash leftover), clean up and
  // retry once — same defense-in-depth as installService().
  const tmpPath = `${path}.tmp`;
  try {
    writeFileSync(tmpPath, desired, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
  } catch (firstErr) {
    if ((firstErr as NodeJS.ErrnoException).code === 'EEXIST') {
      try { unlinkSync(tmpPath); } catch { /* ignore cleanup failure */ }
      try {
        writeFileSync(tmpPath, desired, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
      } catch (retryErr) {
        return { kind: 'failed', reason: `Failed to write upgraded plist (tmp ${tmpPath}): ${(retryErr as Error).message}` };
      }
    } else {
      return { kind: 'failed', reason: `Failed to write upgraded plist (tmp ${tmpPath}): ${(firstErr as Error).message}` };
    }
  }
  try {
    renameSync(tmpPath, path);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    return { kind: 'failed', reason: `Failed to install upgraded plist (rename ${tmpPath} -> ${path}): ${(err as Error).message}` };
  }

  return { kind: 'upgraded', plistPath: path, label: labelFor(name) };
}

/** Read the on-disk plist contents, if installed. Useful for `service status --verbose`. */
export function readPlistFile(name: ServiceName): string | undefined {
  const path = plistPath(name);
  if (!existsSync(path)) return undefined;
  return readFileSync(path, 'utf-8');
}
