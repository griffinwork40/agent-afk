/**
 * `.env` file primitives shared across surfaces.
 *
 * Originally co-located with `src/cli/auth-wizard.ts` (which calls
 * `upsertEnvVar` when persisting an Anthropic OAuth token), but the
 * Telegram setup wizard (`src/telegram/setup-wizard.ts`) and the
 * `afk telegram` setup commands need the same primitive — without those
 * surfaces reaching upward into `src/cli/auth-wizard.js`. This file is
 * the canonical home; `src/cli/auth-wizard.ts` re-exports for backward
 * compat with existing CLI import sites.
 *
 * @module utils/envFile
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'fs';
import { dirname } from 'path';

/**
 * Escape a string for safe literal use inside a `RegExp`. Env-var names are
 * normally `[A-Z0-9_]`, but callers may pass arbitrary keys (e.g. the
 * config-mutation engine), so we never interpolate a raw key into a pattern.
 */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Write `contents` to `filePath` atomically: write a sibling temp file, then
 * `rename` it over the target. `rename` is atomic on a single filesystem, so a
 * crash mid-write can never leave a half-written `.env` (which would drop or
 * corrupt secrets and config). The temp file inherits the same restrictive
 * `mode` so the secret is never briefly world-readable.
 *
 * Invariant: temp and target must share a directory (same filesystem) for the
 * rename to be atomic — we derive the temp path from `filePath` to guarantee it.
 *
 * Exported so the config-mutation engine can reuse one atomic-write
 * implementation for both afk.env and afk.config.json.
 */
export function atomicWriteFile(filePath: string, contents: string, mode = 0o600): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, contents, { mode });
    renameSync(tmp, filePath);
  } catch (err) {
    // Best-effort cleanup of the temp file on failure; ignore unlink errors.
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/**
 * Write or update a single env var in a `.env`-style file.
 *
 * - Creates parent directories if they do not exist.
 * - Writes the file atomically (temp + rename) with restrictive permissions
 *   (`0o600`) so secrets are not world-readable and never half-written.
 * - If the key already exists, the existing line is replaced in-place,
 *   preserving surrounding comments, blank lines, and ordering.
 * - Any additional keys listed in `keysToRemove` are stripped from the
 *   file in the same pass (used when swapping between mutually-exclusive
 *   auth keys, e.g. `ANTHROPIC_API_KEY` vs `CLAUDE_CODE_OAUTH_TOKEN`).
 *
 * Values are written verbatim — no quoting or escaping. The caller is
 * responsible for ensuring the value does not contain newlines.
 */
export function upsertEnvVar(
  filePath: string,
  key: string,
  value: string,
  keysToRemove: string[] = [],
): void {
  let contents = '';
  if (existsSync(filePath)) {
    contents = readFileSync(filePath, 'utf-8');
  }
  // Remove any stale conflicting keys
  for (const removeKey of keysToRemove) {
    const removeRegex = new RegExp(`^${escapeRegExp(removeKey)}=.*$\n?`, 'm');
    contents = contents.replace(removeRegex, '');
  }
  const line = `${key}=${value}`;
  const keyRegex = new RegExp(`^${escapeRegExp(key)}=.*$`, 'm');
  if (keyRegex.test(contents)) {
    contents = contents.replace(keyRegex, line);
  } else {
    if (contents && !contents.endsWith('\n')) contents += '\n';
    contents += line + '\n';
  }
  atomicWriteFile(filePath, contents, 0o600);
}

/**
 * Remove a single env var from a `.env`-style file, preserving surrounding
 * lines. No-op (and no write) when the file does not exist or the key is
 * absent. Returns `true` when a line was actually removed.
 *
 * Writes atomically (temp + rename) with the same `0o600` permissions as
 * {@link upsertEnvVar}.
 */
export function removeEnvVar(filePath: string, key: string): boolean {
  if (!existsSync(filePath)) return false;
  const contents = readFileSync(filePath, 'utf-8');
  const removeRegex = new RegExp(`^${escapeRegExp(key)}=.*$\n?`, 'm');
  if (!removeRegex.test(contents)) return false;
  const next = contents.replace(removeRegex, '');
  atomicWriteFile(filePath, next, 0o600);
  return true;
}

/**
 * Read a single env var's raw value directly from a `.env`-style file, without
 * touching `process.env`. Returns `undefined` when the file or key is absent.
 *
 * Reflects what is *persisted on disk* (which may differ from the live
 * `process.env` value if the file changed after process start). Used by the
 * config-mutation tooling to report what was actually written.
 */
export function readEnvVarFromFile(filePath: string, key: string): string | undefined {
  if (!existsSync(filePath)) return undefined;
  const contents = readFileSync(filePath, 'utf-8');
  const match = contents.match(new RegExp(`^${escapeRegExp(key)}=(.*)$`, 'm'));
  return match ? match[1] : undefined;
}

/**
 * Parse every `KEY=value` line from a `.env`-style file into a plain object,
 * preserving last-write-wins for duplicate keys. Comment lines (`#…`) and
 * blank lines are skipped. Returns `{}` when the file does not exist.
 */
export function readEnvFile(filePath: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(filePath)) return out;
  const contents = readFileSync(filePath, 'utf-8');
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1);
    out[key] = value;
  }
  return out;
}
