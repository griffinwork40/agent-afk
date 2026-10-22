/**
 * Tree diff for `git-snapshot.ts`: run `git diff-tree -r -z --no-renames`,
 * parse the NUL-delimited raw format, classify each entry, and fetch every
 * prior blob in one `git cat-file --batch`.
 *
 * @module agent/file-checkpoint/git-snapshot.diff
 */

import * as path from 'node:path';
import { GIT_SNAPSHOT_GLOBAL_ARGS, classifyFailure, isOk, runGit, type GitEnv } from './git-snapshot.exec.js';
import type { DiffOptions, DiffResult, SkippedChange, TreeChange } from './git-snapshot.js';

export interface RawEntry { oldMode: string; newMode: string; oldSha: string; status: string; gitPath: string }

const REGULAR = new Set(['100644', '100755']);
const ABSENT = '000000';

/**
 * Parse `diff-tree -r -z` raw output. Contract: each record is
 * `:<old> <new> <oldsha> <newsha> <status>\0<path>\0`; with `--no-renames`
 * there is never a second path. Returns null on malformed input.
 */
export function parseRawDiff(buf: Buffer): RawEntry[] | null {
  const fields = buf.toString('utf8').split('\0');
  const out: RawEntry[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const head = fields[i] ?? '';
    const gitPath = fields[i + 1] ?? '';
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/.exec(head);
    if (m === null || gitPath === '') return null;
    out.push({ oldMode: m[1] ?? '', newMode: m[2] ?? '', oldSha: m[3] ?? '', status: m[5] ?? '', gitPath });
  }
  return out;
}

/** Git path → absolute host path (split on '/', so Windows separators are right). */
export function toAbsPath(repoRoot: string, gitPath: string): string {
  return path.join(repoRoot, ...gitPath.split('/'));
}

type Classified = { kind: 'added' } | { kind: 'prior'; mode: number } | { kind: 'skip'; reason: string };

/** Decide how one raw entry is restored. */
export function classifyEntry(e: RawEntry): Classified {
  const modes = [e.oldMode, e.newMode];
  if (modes.includes('120000')) return { kind: 'skip', reason: 'symlink' };
  if (modes.includes('160000')) return { kind: 'skip', reason: 'submodule (gitlink)' };
  if (e.status === 'T') return { kind: 'skip', reason: 'type change' };
  if (e.status === 'A' && e.oldMode === ABSENT && REGULAR.has(e.newMode)) return { kind: 'added' };
  if ((e.status === 'M' || e.status === 'D') && REGULAR.has(e.oldMode)
    && (e.newMode === ABSENT || REGULAR.has(e.newMode))) {
    return { kind: 'prior', mode: e.oldMode === '100755' ? 0o755 : 0o644 };
  }
  return { kind: 'skip', reason: `unsupported change ${e.status} ${e.oldMode}->${e.newMode}` };
}

/**
 * Split a `cat-file --batch` stream into blob bodies keyed by request order.
 * Contract: every request is answered by `<sha> <type> <size>\n<bytes>\n` or
 * `<sha> missing\n`; a missing or malformed answer returns null (fail closed —
 * a rewind must never restore the wrong bytes).
 */
export function parseCatFileBatch(buf: Buffer, count: number): Buffer[] | null {
  const blobs: Buffer[] = [];
  let pos = 0;
  for (let i = 0; i < count; i++) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) return null;
    const m = /^[0-9a-f]+ blob (\d+)$/.exec(buf.subarray(pos, nl).toString('utf8'));
    if (m === null) return null;
    const size = Number(m[1]);
    const start = nl + 1;
    if (start + size + 1 > buf.length) return null;
    blobs.push(Buffer.from(buf.subarray(start, start + size)));
    pos = start + size + 1;
  }
  return blobs;
}

/** Run the diff with an env that already points at the private object store. */
export async function diffWithEnv(options: DiffOptions, env: GitEnv, deadline: number): Promise<DiffResult> {
  const cwd = options.repoRoot;
  const run = await runGit(
    [...GIT_SNAPSHOT_GLOBAL_ARGS, 'diff-tree', '-r', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', options.before, options.after],
    { cwd, env, deadline },
  );
  if (!isOk(run)) return classifyFailure(run, 'git diff-tree');
  const entries = parseRawDiff(run.stdout);
  if (entries === null) return { ok: false, reason: 'error', detail: 'git diff-tree: unparseable output' };

  const max = Math.max(0, Math.floor(options.maxFiles));
  // Invariant: maxFiles bounds changes + skipped together, so neither list
  // (and no blob fetch) grows past it however large the diff is.
  const truncated = entries.length > max;
  const kept = entries.slice(0, max);
  const changes: TreeChange[] = [];
  const skipped: SkippedChange[] = [];
  const wanted: { index: number; sha: string; mode: number }[] = [];
  for (const e of kept) {
    const absPath = toAbsPath(options.repoRoot, e.gitPath);
    const c = classifyEntry(e);
    if (c.kind === 'skip') skipped.push({ absPath, reason: c.reason });
    else if (c.kind === 'added') changes.push({ absPath, prior: null });
    else {
      wanted.push({ index: changes.length, sha: e.oldSha, mode: c.mode });
      changes.push({ absPath, prior: null });
    }
  }
  if (wanted.length > 0) {
    const cat = await runGit([...GIT_SNAPSHOT_GLOBAL_ARGS, 'cat-file', '--batch'], {
      cwd, env, deadline, input: wanted.map((w) => `${w.sha}\n`).join(''),
    });
    if (!isOk(cat)) return classifyFailure(cat, 'git cat-file');
    const blobs = parseCatFileBatch(cat.stdout, wanted.length);
    if (blobs === null) return { ok: false, reason: 'error', detail: 'git cat-file: missing or malformed blob' };
    wanted.forEach((w, i) => {
      const target = changes[w.index];
      const bytes = blobs[i];
      if (target !== undefined && bytes !== undefined) target.prior = { bytes, mode: w.mode };
    });
  }
  return { ok: true, changes, skipped, truncated };
}
