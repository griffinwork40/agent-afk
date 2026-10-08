/**
 * Service startup sidecar — version and PID recorded by each service at
 * startup so `afk service status` can surface running vs installed version
 * skew without querying a live health endpoint.
 *
 * ## Design rationale
 *
 * The cleanest signal for version skew is a sidecar the service itself
 * writes at startup: it records the version it was launched with plus its
 * PID. The status command:
 *   1. Reads the sidecar from `~/.afk/state/service-startup/<name>.json`.
 *   2. Checks the recorded PID matches an actually-running process.
 *   3. Compares recorded version to the installed CLI version (read from
 *      package.json by `getVersion()`).
 *   4. Surfaces "running version unknown — restart recommended" when the
 *      sidecar is missing or belongs to a stale PID.
 *
 * ## Why not mtime heuristics
 *
 * The mtime approach (compare installed afk mtime vs service start time) is
 * fragile under NVM / Homebrew / pnpm global — the binary path changes on
 * upgrade, so the reference mtime is ambiguous. Reading the version the
 * process actually started with is unambiguous.
 *
 * ## Platform scope
 *
 * Sidecar paths are under `$AFK_STATE_DIR` which is platform-agnostic.
 * The write/read functions impose no launchd/systemd dependency and work
 * identically on all three supported platforms.
 *
 * @module service/version-skew
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import type { ServiceName } from './types.js';
import { getServiceStartupSidecarPath } from '../paths.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** Written by service entrypoints at startup. Read by `afk service status`. */
export interface ServiceStartupSidecar {
  /** Semver string of the version this service process was launched with. */
  version: string;
  /** PID of the service process. Used to detect stale sidecars. */
  pid: number;
  /** ISO-8601 timestamp of when the sidecar was written. */
  startedAt: string;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Write a startup sidecar for `name`. Called by service entrypoints
 * (daemon CLI, telegram entry) immediately after the service is ready.
 *
 * Best-effort: write errors are swallowed so a filesystem hiccup never
 * takes down the service itself. Callers should not rely on a successful
 * write for correctness — the status command degrades gracefully when the
 * sidecar is absent.
 */
export function writeServiceStartupSidecar(
  name: ServiceName,
  version: string,
  pid: number = process.pid,
  now: () => string = () => new Date().toISOString(),
): void {
  const sidecar: ServiceStartupSidecar = { version, pid, startedAt: now() };
  const path = getServiceStartupSidecarPath(name);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(sidecar), 'utf-8');
  } catch {
    // Best-effort: filesystem errors must not crash the service.
  }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Read and validate a startup sidecar. Returns `undefined` when:
 *   - the file does not exist (old service that predates the sidecar),
 *   - the file is malformed, or
 *   - the recorded PID does not match a running process (stale sidecar).
 *
 * `isRunning` is injectable for testing (default checks kill(pid, 0)).
 */
export function readServiceStartupSidecar(
  name: ServiceName,
  isRunning: (pid: number) => boolean = defaultIsRunning,
): ServiceStartupSidecar | undefined {
  const path = getServiceStartupSidecarPath(name);
  if (!existsSync(path)) return undefined;
  let sidecar: ServiceStartupSidecar;
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isValidSidecar(parsed)) return undefined;
    sidecar = parsed;
  } catch {
    return undefined;
  }
  // Stale-PID guard: if the PID no longer exists the sidecar is from an
  // old run. The status command will report "version unknown" for clarity.
  if (!isRunning(sidecar.pid)) return undefined;
  return sidecar;
}

function isValidSidecar(v: unknown): v is ServiceStartupSidecar {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['version'] === 'string' &&
    o['version'].length > 0 &&
    typeof o['pid'] === 'number' &&
    Number.isFinite(o['pid']) &&
    typeof o['startedAt'] === 'string'
  );
}

function defaultIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Skew analysis
// ---------------------------------------------------------------------------

export type VersionSkewResult =
  | { kind: 'match'; version: string }
  | { kind: 'skew'; runningVersion: string; installedVersion: string }
  | { kind: 'unknown' };

/**
 * Compare the running version (from sidecar) to the installed CLI version.
 *
 * Returns:
 *   - `match`   — both versions are known and identical
 *   - `skew`    — both versions are known but differ
 *   - `unknown` — either version is unavailable (no sidecar, old service, etc.)
 */
export function compareVersions(
  runningVersion: string | undefined,
  installedVersion: string,
): VersionSkewResult {
  if (
    runningVersion === undefined ||
    runningVersion.length === 0 ||
    runningVersion === 'unknown' ||
    installedVersion.length === 0 ||
    installedVersion === 'unknown' ||
    installedVersion === '0.0.0-unknown'
  ) {
    return { kind: 'unknown' };
  }
  if (runningVersion === installedVersion) return { kind: 'match', version: runningVersion };
  return { kind: 'skew', runningVersion, installedVersion };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Format the version line for `afk service status` output.
 *
 * Examples:
 *   match:   "v5.300.1"
 *   skew:    "running v5.300.1 / installed v5.305.5  ⚠ version skew — restart with: afk service restart daemon"
 *   unknown: "running version unknown — restart recommended: afk service restart daemon"
 */
export function formatVersionLine(
  result: VersionSkewResult,
  name: ServiceName,
): string {
  switch (result.kind) {
    case 'match':
      return `v${result.version}`;
    case 'skew':
      return (
        `running v${result.runningVersion} / installed v${result.installedVersion}` +
        `  ⚠ version skew — restart with: afk service restart ${name}`
      );
    case 'unknown':
      return `running version unknown — restart recommended: afk service restart ${name}`;
  }
}
