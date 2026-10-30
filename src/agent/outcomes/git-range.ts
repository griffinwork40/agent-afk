/**
 * git-range — thin adapter that lists the commits a session made, for
 * computeOutcomes. The only I/O in the outcomes-v1 pipeline lives here.
 *
 * Contract: never throws. Any failure (not a git repo, unknown sha, git
 * missing, timeout) returns []. Reads pass `--no-optional-locks` so a
 * concurrent session in the same repo never sees a spurious index.lock.
 *
 * @module agent/outcomes/git-range
 */

import { execFileAsync } from '../../utils/exec-file.js';
import { OUTCOMES_COMMITS_CAP } from './outcomes-v1.schema.js';
import type { GitLogEntry } from './compute-outcomes.js';

const DEFAULT_TIMEOUT_MS = 5_000;
const SHA_RE = /^[0-9a-f]{7,40}$/;
const FIELD_SEP = '\x1f';

export interface GitLogRangeOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Callers pass `--no-optional-locks` first in `args` (audit:git-locks scans each call line). */
async function git(cwd: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    timeout: timeoutMs,
    ...(signal ? { signal } : {}),
    killSignal: 'SIGTERM',
    maxBuffer: 4 * 1024 * 1024,
  });
  return String(stdout);
}

/**
 * Commits reachable from `endHead` (or HEAD when null) but not from
 * `startHead`, newest first, capped at OUTCOMES_COMMITS_CAP. Returns [] when
 * startHead is null (no baseline → no attributable range) or equals endHead.
 */
export async function gitLogRange(
  cwd: string,
  startHead: string | null,
  endHead: string | null,
  opts: GitLogRangeOptions = {},
): Promise<GitLogEntry[]> {
  if (!startHead || !SHA_RE.test(startHead)) return [];
  if (endHead !== null && !SHA_RE.test(endHead)) return [];
  if (endHead !== null && startHead.toLowerCase() === endHead.toLowerCase()) return [];
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const repo = (await git(cwd, ['--no-optional-locks', 'rev-parse', '--show-toplevel'], timeoutMs, opts.signal)).trim();
    if (!repo) return [];
    const out = await git(
      cwd,
      ['--no-optional-locks', 'log', `--max-count=${OUTCOMES_COMMITS_CAP}`, `--format=%H${FIELD_SEP}%s`, `${startHead}..${endHead ?? 'HEAD'}`, '--'],
      timeoutMs,
      opts.signal,
    );
    const entries: GitLogEntry[] = [];
    for (const line of out.split('\n')) {
      const sep = line.indexOf(FIELD_SEP);
      if (sep < 0) continue;
      const sha = line.slice(0, sep).trim().toLowerCase();
      if (!SHA_RE.test(sha)) continue;
      entries.push({ sha, subject: line.slice(sep + 1).trim(), repo });
    }
    return entries;
  } catch {
    return [];
  }
}
