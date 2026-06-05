import { execFileSync } from 'child_process';
import { existsSync, realpathSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';
import { resolveEntrypoint as resolveTelegramEntrypoint } from '../../telegram/manager.js';
import { type ServiceName } from './paths.js';

// ─────────────────────────────────────────────────────────────────────────
// Plist generation (pure)
// ─────────────────────────────────────────────────────────────────────────

/** Inputs that fully determine a generated plist. Pure data, no I/O. */
export interface PlistOptions {
  /** Reverse-DNS label, e.g. `com.afk.telegram`. */
  label: string;
  /** Argv to exec. First element is the executable. */
  programArguments: string[];
  /** Working directory. Defaults to `$HOME`. */
  workingDirectory: string;
  /** Stdout sink. Appended. */
  standardOutPath: string;
  /** Stderr sink. Appended. */
  standardErrorPath: string;
  /**
   * Files to watch — launchd will restart the job when any of these files
   * is modified. Used to auto-restart on `pnpm build`. Optional.
   */
  watchPaths?: string[];
  /**
   * Extra env vars to inject. Keep small — the running process already
   * inherits the user's login env via launchd's user-context bootstrap.
   */
  environmentVariables?: Record<string, string>;
}

/** XML-encode a value for use inside a plist `<string>`. */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Render a LaunchAgent plist as a UTF-8 string.
 *
 * Invariants:
 *   - `RunAtLoad` = true: start on login.
 *   - `KeepAlive` = true: relaunch on any exit (crash, OOM, manual kill).
 *   - Per-job `ProcessType=Interactive` keeps it lively in the foreground
 *     QoS class — daemon background QoS would throttle Node's GC.
 *
 * No optimistic rendering: we serialise the fields in a fixed order so
 * test snapshots are stable across machines.
 */
export function renderPlist(opts: PlistOptions): string {
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
  );
  lines.push('<plist version="1.0">');
  lines.push('<dict>');
  lines.push('  <key>Label</key>');
  lines.push(`  <string>${xmlEscape(opts.label)}</string>`);

  lines.push('  <key>ProgramArguments</key>');
  lines.push('  <array>');
  for (const arg of opts.programArguments) {
    lines.push(`    <string>${xmlEscape(arg)}</string>`);
  }
  lines.push('  </array>');

  lines.push('  <key>WorkingDirectory</key>');
  lines.push(`  <string>${xmlEscape(opts.workingDirectory)}</string>`);

  lines.push('  <key>StandardOutPath</key>');
  lines.push(`  <string>${xmlEscape(opts.standardOutPath)}</string>`);
  lines.push('  <key>StandardErrorPath</key>');
  lines.push(`  <string>${xmlEscape(opts.standardErrorPath)}</string>`);

  lines.push('  <key>RunAtLoad</key>');
  lines.push('  <true/>');
  lines.push('  <key>KeepAlive</key>');
  lines.push('  <true/>');
  lines.push('  <key>ProcessType</key>');
  lines.push('  <string>Interactive</string>');

  if (opts.watchPaths && opts.watchPaths.length > 0) {
    lines.push('  <key>WatchPaths</key>');
    lines.push('  <array>');
    for (const p of opts.watchPaths) {
      lines.push(`    <string>${xmlEscape(p)}</string>`);
    }
    lines.push('  </array>');
  }

  if (opts.environmentVariables && Object.keys(opts.environmentVariables).length > 0) {
    lines.push('  <key>EnvironmentVariables</key>');
    lines.push('  <dict>');
    // Stable key order — plist diff hygiene matters when users version-control them.
    const keys = Object.keys(opts.environmentVariables).sort();
    for (const k of keys) {
      const v = opts.environmentVariables[k] ?? '';
      lines.push(`    <key>${xmlEscape(k)}</key>`);
      lines.push(`    <string>${xmlEscape(v)}</string>`);
    }
    lines.push('  </dict>');
  }

  lines.push('</dict>');
  lines.push('</plist>');
  return lines.join('\n') + '\n';
}

// ─────────────────────────────────────────────────────────────────────────
// Argv resolution per service kind
// ─────────────────────────────────────────────────────────────────────────

/**
 * Where to find the installed `afk` binary — needed for the `daemon`
 * service whose entrypoint goes through the CLI.
 *
 * Search order:
 *   1. `process.argv[1]` (the currently-executing CLI script), resolved
 *      via `realpathSync` and validated against the trusted-prefix
 *      allowlist — i.e. "the same `afk` the user just invoked", but
 *      only if it lives in a trusted location.
 *   2. PATH lookup via `which afk`, also allowlist-checked.
 *   3. Explicit candidate list (`/usr/local/bin/afk`, etc.).
 *
 * Returns absolute path. Throws if none exists — we refuse to install a
 * service pointing at a non-existent binary.
 */
export function resolveAfkBinary(
  candidates: string[] = ['/usr/local/bin/afk', '/opt/homebrew/bin/afk'],
  existsCheck: (p: string) => boolean = existsSync,
  whichRunner: () => string | undefined = defaultWhichAfk,
  realpathFn: (p: string) => string = realpathSync,
): string {
  // M-10: try process.argv[1] first — it's the actual binary the user
  // ran, so it's the most direct answer. Resolve symlinks (realpathFn)
  // and validate against the trusted-prefix allowlist to prevent a
  // PATH-hijack binary from being baked into the LaunchAgent plist.
  const argv1 = process.argv[1];
  if (argv1) {
    try {
      const canonical = realpathFn(argv1);
      if (
        TRUSTED_BIN_PREFIXES.some((p) => canonical.startsWith(p)) &&
        existsCheck(canonical)
      ) {
        return canonical;
      }
    } catch {
      // realpathFn failed (dangling symlink, ENOENT) — fall through.
    }
  }

  const fromPath = whichRunner();
  if (fromPath && existsCheck(fromPath)) return fromPath;
  for (const c of candidates) {
    if (existsCheck(c)) return c;
  }
  throw new Error(
    `Could not locate the 'afk' binary. Searched: ${candidates.join(', ')}. Install it globally first (e.g. 'pnpm install -g agent-afk' or via Homebrew).`,
  );
}

/**
 * Trusted directory prefixes for the resolved `afk` binary. Any `which`
 * result outside this allowlist is rejected — preventing a PATH-hijack
 * (e.g. `./afk` from the current dir, `~/Downloads/afk`) from getting
 * baked into the persistent LaunchAgent plist where it would run forever
 * with no further confirmation.
 *
 * Standard global install locations only. Users running from a dev tree
 * must symlink into one of these prefixes or pass an explicit candidate.
 */
const TRUSTED_BIN_PREFIXES: readonly string[] = [
  '/usr/local/bin/',
  '/opt/homebrew/bin/',
  '/usr/bin/',
  '/opt/local/bin/', // MacPorts
];

/**
 * Resolve `afk` via PATH using `which`, then realpath + allowlist-check.
 *
 * Why the extra hardening: the resolved path is written into a launchd
 * plist that survives logout and reboot. A `./afk` shim picked up from
 * the current working directory at install time would become a permanent
 * persistence mechanism for whoever planted it. We resolve through
 * `realpathSync` (defeats symlink trickery) and require the canonical
 * path to live under a system bin prefix.
 *
 * Returns undefined on miss; the caller falls back to the explicit
 * candidate list, which is also filtered through the same allowlist.
 */
function defaultWhichAfk(): string | undefined {
  try {
    const out = execFileSync('which', ['afk'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!out) return undefined;
    // Defend against PATH hijack: only accept the result if its realpath
    // lives under a trusted bin prefix.
    let canonical: string;
    try {
      canonical = realpathSync(out);
    } catch {
      return undefined;
    }
    if (!TRUSTED_BIN_PREFIXES.some((p) => canonical.startsWith(p))) {
      return undefined;
    }
    return canonical;
  } catch {
    return undefined;
  }
}

/**
 * Build the `ProgramArguments` array for a given service. Centralised so
 * the install command and tests agree on the shape.
 *
 * For `telegram`: runs the bundled entrypoint with the current node binary.
 *   Running `afk telegram start` would be wrong — that command spawns a
 *   detached child and exits, which launchd would interpret as a crash
 *   and respawn endlessly.
 *
 * For `daemon`: runs `afk daemon` (foreground; blocks until killed).
 *   The bare command:
 *     1. Loads persisted schedules from `~/.afk/config/schedules.json`
 *        unconditionally (see daemon.ts where `loadSchedules()` runs
 *        before tasks are registered) — so cron-triggered work fires
 *        whether the user passed `--trigger` or not.
 *     2. Defaults `--trigger` to `sessionstart`, which fires the
 *        compiled-default `/forge-friction --auto` task once on each
 *        launchd-driven startup. This is intentional: cron mode would
 *        require a `--cron` expression on the main task that doesn't
 *        exist for the compiled default, and would cause the daemon
 *        process to error out before persisted schedules ever load.
 *   Test coverage: `launchd.test.ts > resolveProgramArguments > daemon`
 *   pins this shape so future flag drift is caught.
 */
export function resolveProgramArguments(
  name: ServiceName,
  existsCheck: (p: string) => boolean = existsSync,
): string[] {
  if (name === 'telegram') {
    const entry = resolveTelegramEntrypoint();
    // launchd execs the program directly — there's no shell, no tsx, no
    // ts-node loader. Refuse to install a service that would point at a
    // TypeScript source file; the user must `pnpm build` first (or use
    // a globally-installed `afk` from a published package).
    if (entry.endsWith('.ts')) {
      throw new Error(
        `Refusing to install telegram service pointing at TypeScript source (${entry}). ` +
          `Run 'pnpm build' first so the compiled entrypoint exists, or install agent-afk globally ` +
          `(e.g. 'pnpm install -g agent-afk').`,
      );
    }
    // M-9: validate the resolved entrypoint exists on disk before we
    // write it into a persistent plist. An invalid path baked into a
    // LaunchAgent would produce a silent KeepAlive restart loop at login.
    if (!existsCheck(entry)) {
      throw new Error(
        `Telegram entrypoint does not exist on disk: ${entry}. ` +
          `Run 'pnpm build' to compile it, or install agent-afk globally.`,
      );
    }
    return [process.execPath, entry];
  }
  // daemon: invoke the installed afk CLI in foreground mode. No flags —
  // bare `afk daemon` loads persisted schedules from
  // ~/.afk/config/schedules.json regardless of trigger mode.
  const afk = resolveAfkBinary();
  return [afk, 'daemon'];
}

/**
 * Files whose modification should trigger a relaunch (so a rebuild
 * automatically picks up new code without manual `launchctl kickstart`).
 *
 * Only emitted when the entrypoint lives in a writable dev tree —
 * watching `/opt/homebrew/lib/...` would fire on every brew upgrade,
 * which is the wrong behaviour for global installs.
 */
export function resolveWatchPaths(
  name: ServiceName,
  existsCheck?: (p: string) => boolean,
): string[] | undefined {
  const args = resolveProgramArguments(name, existsCheck);
  const entrypoint = name === 'telegram' ? args[1] : undefined;
  if (!entrypoint) return undefined;
  // Heuristic: only watch if entrypoint is under the user's home AND
  // not inside a Homebrew Cellar / node_modules global tree. This catches
  // dev-tree installs (`/Users/<u>/Projects/...`) without firing on
  // package-manager updates.
  const abs = resolve(entrypoint);
  const home = homedir();
  if (!abs.startsWith(home)) return undefined;
  if (abs.includes('/node_modules/') || abs.includes('/homebrew/')) return undefined;
  return [abs];
}


