/**
 * Home-directory layout helper for sandbox materializer.
 *
 * Builds <sandboxDir>/home from the real AFK_HOME with the layout rules
 * specified in the plan of record:
 *   - config/: files copied; afk.env with credential lines stripped
 *   - AFK.md and settings.json: copied if present
 *   - skills/: real dir with one symlink per entry
 *   - plugins/: real dir; entries symlinked; cache/ real dir with symlinks
 *   - state/: fresh; only state/memory/ recursively copied
 *   - agent-framework/: fresh empty
 *
 * @module whatif/sandbox.home
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  copyFileSync,
  lstatSync,
  statSync,
  readlinkSync,
  unlinkSync,
} from 'node:fs';
import { cpSync } from 'node:fs';
import { join, dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Credential line stripping for afk.env
// ---------------------------------------------------------------------------

/**
 * Lines in afk.env whose KEY matches this regex are omitted from the sandbox
 * copy. Credentials are inherited via the child process environment instead.
 */
const CREDENTIAL_KEY_REGEX = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|OAUTH)/i;

function stripCredentialLines(content: string): string {
  return content
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return true; // keep blanks/comments
      const eq = trimmed.indexOf('=');
      if (eq === -1) return true; // keep malformed lines
      const key = trimmed.slice(0, eq).trim();
      return !CREDENTIAL_KEY_REGEX.test(key);
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Per-directory symlink-all helper
// ---------------------------------------------------------------------------

function symlinkAllEntries(realDir: string, sandboxDir: string): void {
  mkdirSync(sandboxDir, { recursive: true });
  if (!existsSync(realDir)) return;
  for (const entry of readdirSync(realDir)) {
    const target = join(realDir, entry);
    const link = join(sandboxDir, entry);
    if (!existsSync(link) && !linkExists(link)) {
      symlinkSync(target, link);
    }
  }
}

/** lstat-based check for symlinks (works for dangling links too). */
function linkExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Non-credential keys defined in the real `config/afk.env`. The runner unsets
 * these in the child env so the child reads them from the sandbox copy (see
 * `LaunchSettings.unset`). Credential keys are excluded: the child must keep
 * inheriting those from the parent because the sandbox copy strips them.
 */
export function sandboxedAfkEnvKeys(realHome: string): string[] {
  const file = join(realHome, 'config', 'afk.env');
  if (!existsSync(file)) return [];
  const keys: string[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m?.[1] && !CREDENTIAL_KEY_REGEX.test(m[1])) keys.push(m[1]);
  }
  return keys;
}

// ---------------------------------------------------------------------------
// config/ layout
// ---------------------------------------------------------------------------

/**
 * Invariant: only these config files are copied. An allowlist, not a
 * denylist, because operators leave backups such as `afk.env.bak-*` beside
 * the live file; those carry unstripped credentials and must never reach a
 * sandbox. Files that do not shape agent behavior (schedules, backups) stay out.
 */
const CONFIG_ALLOWLIST = new Set(['afk.env', 'afk.config.json', 'mcp.json', 'permissions.json']);

function layoutConfig(realHome: string, sandboxHome: string): void {
  const realConf = join(realHome, 'config');
  const sandboxConf = join(sandboxHome, 'config');
  mkdirSync(sandboxConf, { recursive: true });
  if (!existsSync(realConf)) return;

  for (const entry of readdirSync(realConf)) {
    if (!CONFIG_ALLOWLIST.has(entry)) continue;
    const src = join(realConf, entry);
    try {
      const st = statSync(src); // follows symlinks — we want real files only
      if (!st.isFile()) continue;
    } catch {
      continue;
    }
    const dst = join(sandboxConf, entry);
    if (entry === 'afk.env') {
      const raw = readFileSync(src, 'utf8');
      writeFileSync(dst, stripCredentialLines(raw), 'utf8');
    } else {
      copyFileSync(src, dst);
    }
  }
}

// ---------------------------------------------------------------------------
// skills/ and plugins/ layouts
// ---------------------------------------------------------------------------

function layoutSkills(realHome: string, sandboxHome: string): void {
  symlinkAllEntries(join(realHome, 'skills'), join(sandboxHome, 'skills'));
}

function layoutPlugins(realHome: string, sandboxHome: string): void {
  const realPlugins = join(realHome, 'plugins');
  const sandboxPlugins = join(sandboxHome, 'plugins');
  mkdirSync(sandboxPlugins, { recursive: true });
  if (!existsSync(realPlugins)) return;

  for (const entry of readdirSync(realPlugins)) {
    if (entry === 'cache') {
      // cache/ → real directory with per-entry symlinks
      symlinkAllEntries(join(realPlugins, 'cache'), join(sandboxPlugins, 'cache'));
    } else {
      const target = join(realPlugins, entry);
      const link = join(sandboxPlugins, entry);
      if (!linkExists(link)) {
        symlinkSync(target, link);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// state/ layout (fresh; memory/ recursively copied)
// ---------------------------------------------------------------------------

function layoutState(realHome: string, sandboxHome: string): void {
  const sandboxState = join(sandboxHome, 'state');
  mkdirSync(sandboxState, { recursive: true });

  const realMemory = join(realHome, 'state', 'memory');
  const sandboxMemory = join(sandboxState, 'memory');
  if (existsSync(realMemory)) {
    cpSync(realMemory, sandboxMemory, { recursive: true });
  } else {
    mkdirSync(sandboxMemory, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Root-level files (AFK.md, settings.json)
// ---------------------------------------------------------------------------

function copyRootFile(realHome: string, sandboxHome: string, name: string): void {
  const src = join(realHome, name);
  try {
    const st = lstatSync(src);
    if (st.isFile() || st.isSymbolicLink()) {
      copyFileSync(src, join(sandboxHome, name)); // copyFileSync follows symlinks
    }
  } catch {
    // file absent — skip
  }
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Build a fresh sandbox home directory from a real AFK_HOME.
 */
export function buildSandboxHome(realHome: string, sandboxHome: string): void {
  mkdirSync(sandboxHome, { recursive: true });

  layoutConfig(realHome, sandboxHome);
  copyRootFile(realHome, sandboxHome, 'AFK.md');
  copyRootFile(realHome, sandboxHome, 'settings.json');
  layoutSkills(realHome, sandboxHome);
  layoutPlugins(realHome, sandboxHome);
  layoutState(realHome, sandboxHome);

  mkdirSync(join(sandboxHome, 'agent-framework'), { recursive: true });
}

/**
 * For each relative path in `relPaths`, if the entry at `<sandboxHome>/<rel>`
 * is a symlink, replace it with a recursive real copy so that operator writes
 * never escape to the real AFK_HOME.
 */
export function materializeSymlinks(sandboxHome: string, relPaths: string[]): void {
  for (const rel of relPaths) {
    const linkPath = join(sandboxHome, rel);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(linkPath);
    } catch {
      continue; // path does not exist yet — nothing to materialize
    }
    if (!st.isSymbolicLink()) continue;

    const targetPath = readlinkSync(linkPath);
    unlinkSync(linkPath);

    if (!existsSync(targetPath)) {
      // Dangling link → create empty directory so the operator can write
      mkdirSync(linkPath, { recursive: true });
      continue;
    }

    const targetStat = statSync(targetPath);
    if (targetStat.isDirectory()) {
      cpSync(targetPath, linkPath, { recursive: true });
    } else {
      mkdirSync(dirname(linkPath), { recursive: true });
      copyFileSync(targetPath, linkPath);
    }
  }
}
