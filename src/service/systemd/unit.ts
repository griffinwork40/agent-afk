/**
 * Pure systemd unit-file generation — the Linux analog of
 * `launchd/plist.ts`'s `renderPlist`. No I/O; deterministic output
 * (sorted env keys) so test snapshots are stable across machines.
 *
 * @module service/systemd/unit
 */

/** Inputs that fully determine a generated `.service` unit. Pure data. */
export interface ServiceUnitOptions {
  /** `[Unit] Description=`. */
  description: string;
  /** Argv to exec. First element is the executable (absolute path). */
  execStart: string[];
  /** `[Service] WorkingDirectory=`. */
  workingDirectory: string;
  /** Stdout+stderr sink; appended (`append:` needs systemd ≥ 240). */
  logFile: string;
  /**
   * Extra env vars. A `PATH` led by the installer's node dir is injected
   * by the caller for the same reason launchd needs it — a `--user` unit
   * does not inherit an interactive shell's PATH, so a bare
   * `#!/usr/bin/env node` shebang can fail to resolve node.
   */
  environmentVariables?: Record<string, string>;
}

/** Inputs for a companion `.path` unit (the WatchPaths equivalent). */
export interface PathUnitOptions {
  description: string;
  /** Files whose modification restarts the paired service. */
  pathModified: string[];
  /** The `.service` unit this path unit activates, e.g. `afk-telegram.service`. */
  unit: string;
}

/** Inputs for the oneshot restart-helper unit (see `renderRestartUnit`). */
export interface RestartUnitOptions {
  description: string;
  /** Absolute path to `systemctl` (falls back to the bare command; see `install.ts`). */
  systemctlPath: string;
  /** The `.service` unit to restart, e.g. `afk-telegram.service`. */
  targetUnit: string;
}

/**
 * Shared escaping for any value embedded in a systemd unit file, used by
 * both `quoteArg` (ExecStart=) and `escapeEnvValue` (Environment="K=V").
 *
 * Order matters and is deliberate:
 *   1. `\` → `\\`   — backslash FIRST so the escapes added below aren't
 *      themselves re-escaped by this same replace pass.
 *   2. `"` → `\"`   — keeps the value safe inside a double-quoted token.
 *   3. `\n` → `\\n` and `\r` → `\\r` — a raw newline/CR would start a new
 *      unit-file line and could inject a directive (e.g. a rogue
 *      `ExecStart=` or `[Section]`); systemd's C-style unquoting
 *      understands `\n`/`\r` escapes so the value round-trips.
 *   4. `%` → `%%` LAST — systemd expands `%`-specifiers (`%h`, `%u`, …) at
 *      load time; escaping earlier could double-escape a literal `%`
 *      introduced by a prior step (none currently emit one, but ordering
 *      it last keeps the invariant obviously correct rather than
 *      incidentally correct). See systemd.service(5) "Specifiers".
 */
function escapeUnitValue(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/%/g, '%%');
}

/**
 * Quote one ExecStart argument. systemd splits ExecStart on whitespace;
 * double-quoted args are unquoted with C-style escapes. Quoting every arg
 * is safe and keeps paths containing spaces intact.
 */
function quoteArg(s: string): string {
  return `"${escapeUnitValue(s)}"`;
}

/** Escape a value for use inside a double-quoted `Environment="K=V"`. */
function escapeEnvValue(s: string): string {
  return escapeUnitValue(s);
}

/**
 * Render an `afk-<name>.service` unit as a UTF-8 string.
 *
 * Invariants (mirror the launchd plist):
 *   - `Restart=always` ≈ launchd `KeepAlive` — relaunch on any exit.
 *   - `WantedBy=default.target` ≈ `RunAtLoad` — start on (graphical) login.
 *   - `After/Wants=network-online.target` — the telegram bot needs the network.
 */
export function renderServiceUnit(opts: ServiceUnitOptions): string {
  const lines: string[] = [];
  lines.push('[Unit]');
  lines.push(`Description=${opts.description}`);
  lines.push('After=network-online.target');
  lines.push('Wants=network-online.target');
  lines.push('');
  lines.push('[Service]');
  lines.push('Type=simple');
  lines.push(`ExecStart=${opts.execStart.map(quoteArg).join(' ')}`);
  lines.push(`WorkingDirectory=${opts.workingDirectory}`);
  lines.push('Restart=always');
  lines.push('RestartSec=2');
  lines.push(`StandardOutput=append:${opts.logFile}`);
  lines.push(`StandardError=append:${opts.logFile}`);
  if (opts.environmentVariables && Object.keys(opts.environmentVariables).length > 0) {
    // Stable key order — unit-file diff hygiene matters when users
    // version-control or inspect them.
    for (const k of Object.keys(opts.environmentVariables).sort()) {
      const v = opts.environmentVariables[k] ?? '';
      lines.push(`Environment="${k}=${escapeEnvValue(v)}"`);
    }
  }
  lines.push('');
  lines.push('[Install]');
  lines.push('WantedBy=default.target');
  return lines.join('\n') + '\n';
}

/**
 * Render an `afk-<name>.path` unit — restarts the paired `.service` when
 * any `PathModified=` file changes. Only emitted for dev-tree installs
 * (see `resolveWatchPaths`), matching launchd's WatchPaths heuristic.
 */
export function renderPathUnit(opts: PathUnitOptions): string {
  const lines: string[] = [];
  lines.push('[Unit]');
  lines.push(`Description=${opts.description}`);
  lines.push('');
  lines.push('[Path]');
  for (const p of opts.pathModified) {
    lines.push(`PathModified=${p}`);
  }
  lines.push(`Unit=${opts.unit}`);
  lines.push('');
  lines.push('[Install]');
  lines.push('WantedBy=default.target');
  return lines.join('\n') + '\n';
}

/**
 * Render the oneshot restart-helper unit the `.path` unit triggers.
 *
 * `start` on an already-active `Restart=always` service is a no-op — the
 * rebuilt code would never be loaded (unlike launchd's WatchPaths, which
 * relaunches). So the `.path` unit targets THIS oneshot instead, which
 * shells out to `systemctl --user restart <targetUnit>` to force an
 * actual reload. Deliberately has NO `[Install]` section: it must never be
 * enabled or started at boot, only activated on demand by the path unit.
 */
export function renderRestartUnit(opts: RestartUnitOptions): string {
  const lines: string[] = [];
  lines.push('[Unit]');
  lines.push(`Description=${opts.description}`);
  lines.push('');
  lines.push('[Service]');
  lines.push('Type=oneshot');
  lines.push(`ExecStart=${opts.systemctlPath} --user restart ${opts.targetUnit}`);
  return lines.join('\n') + '\n';
}
