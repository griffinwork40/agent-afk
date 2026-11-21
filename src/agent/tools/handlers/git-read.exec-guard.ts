/**
 * Guards that stop repository-controlled data from making `git_read` start a
 * program (H4). Filter drivers (`filter.<name>.clean|smudge|process`) are not
 * covered by `--no-ext-diff`/`--no-textconv`: `blame`, worktree `diff`
 * (including `--stat`) and `status` of a stat-dirty file run the clean filter
 * of any path whose attributes name a driver. The driver names come from
 * repository config, so they are enumerated per call with a `git config`
 * query (which executes nothing) and every one is overridden at command scope
 * through `GIT_CONFIG_COUNT` (no quoting limits on driver names, unlike `-c`).
 *
 * @module agent/tools/handlers/git-read.exec-guard
 */

import { execFile as execFileCallback } from 'node:child_process';
import path from 'node:path';

const ENUM_TIMEOUT_MS = 10_000;
const ENUM_BUFFER_BYTES = 256 * 1024;
/** More drivers than this is not a real repository; refuse rather than build a huge env. */
export const MAX_FILTER_DRIVERS = 256;

/**
 * A hooks directory that cannot exist: a child of the node binary, which is a
 * regular file. `diff` refreshes the index and would otherwise run a
 * repository `post-index-change` hook even under `--no-optional-locks`.
 */
export const GIT_READ_NO_HOOKS_PATH = path.join(process.execPath, 'afk-git-read-no-hooks');

/** Extra global options appended to the handler's fixed list. */
export const GIT_READ_EXEC_GUARD_ARGS: readonly string[] = [
  '-c', `core.hooksPath=${GIT_READ_NO_HOOKS_PATH}`,
  // A submodule diff in `log -p`/`show`/`diff` would run in the submodule's
  // own repository, with its own drivers; `short` prints only commit ids.
  '-c', 'diff.submodule=short',
];

/** Subcommands that inspect submodule working trees unless told not to. */
const SUBMODULE_WORKTREE_SUBCOMMANDS = new Set(['status', 'diff']);

/**
 * Insert `--ignore-submodules=dirty` after `status`/`diff`: inspecting a dirty
 * submodule runs git inside it with that repository's filters, which the
 * superproject's enumeration cannot see. The flag beats `.gitmodules` and
 * `submodule.<name>.ignore`; new submodule commits are still reported.
 */
export function guardSubmoduleArgv(argv: readonly string[]): string[] {
  const [sub, ...rest] = argv;
  if (sub === undefined || !SUBMODULE_WORKTREE_SUBCOMMANDS.has(sub)) return [...argv];
  return [sub, '--ignore-submodules=dirty', ...rest];
}

export type FilterDriverParse = { ok: true; names: string[] } | { ok: false; error: string };

const DRIVER_KEYS = new Set(['clean', 'smudge', 'process', 'required']);

/**
 * Parse `git config -z --name-only --get-regexp ^filter\.` output: NUL-terminated
 * variable names. Anything that is not `filter.<name>.<key>` with a known key
 * shape is unparseable and fails closed. Unknown keys of a named driver are
 * ignored (git reads only the four in {@link DRIVER_KEYS}).
 */
export function parseFilterDrivers(stdout: string): FilterDriverParse {
  if (stdout.length === 0) return { ok: true, names: [] };
  if (!stdout.endsWith('\0')) return { ok: false, error: 'filter driver list is not NUL-terminated' };
  const names = new Set<string>();
  const prefix = 'filter.';
  for (const entry of stdout.slice(0, -1).split('\0')) {
    const bad = { ok: false as const, error: `unexpected config name ${JSON.stringify(entry.slice(0, 80))}` };
    if (!entry.startsWith(prefix)) return bad;
    const last = entry.lastIndexOf('.');
    const key = entry.slice(last + 1);
    if (!/^[a-z0-9-]+$/.test(key)) return bad;
    // `filter.<key>` with no subsection names no driver git would use.
    if (last < prefix.length) continue;
    if (!DRIVER_KEYS.has(key)) continue;
    names.add(entry.slice(prefix.length, last));
  }
  if (names.size > MAX_FILTER_DRIVERS) return { ok: false, error: `more than ${MAX_FILTER_DRIVERS} filter drivers configured` };
  return { ok: true, names: [...names] };
}

/**
 * Command-scope overrides for every named driver: empty `clean`/`smudge`/
 * `process` make git pass content through unchanged, and `required=false` stops
 * a required driver with no command from aborting the read.
 */
export function filterNeutralisingEnv(names: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  let i = 0;
  for (const name of names) {
    for (const key of ['clean', 'smudge', 'process', 'required']) {
      env[`GIT_CONFIG_KEY_${i}`] = `filter.${name}.${key}`;
      env[`GIT_CONFIG_VALUE_${i}`] = key === 'required' ? 'false' : '';
      i++;
    }
  }
  if (i > 0) env['GIT_CONFIG_COUNT'] = String(i);
  return env;
}

/**
 * Enumerate configured filter drivers in `cwd` with the same env and global
 * options as the read, so discovery (`.git` files, `core.worktree`, includes)
 * resolves to the same configuration git will use. Exit 1 with no output means
 * "none"; any other failure is returned as an error so the caller refuses.
 */
export function enumerateFilterDrivers(
  globalArgs: readonly string[],
  cwd: string,
  env: Record<string, string | undefined>,
  signal: AbortSignal,
): Promise<FilterDriverParse> {
  const argv = [...globalArgs, 'config', '-z', '--name-only', '--get-regexp', '^filter\\.'];
  return new Promise((resolve) => {
    execFileCallback(
      'git',
      argv,
      { cwd, env, signal, timeout: ENUM_TIMEOUT_MS, maxBuffer: ENUM_BUFFER_BYTES, encoding: 'utf8', windowsHide: true },
      (err, stdout, stderr) => {
        if (err === null) { resolve(parseFilterDrivers(stdout)); return; }
        const code: unknown = (err as { code?: unknown }).code;
        if (code === 1 && stdout === '' && stderr.trim() === '') { resolve({ ok: true, names: [] }); return; }
        resolve({ ok: false, error: (stderr.trim() || err.message).slice(0, 500) });
      },
    );
  });
}
