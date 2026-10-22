/**
 * Tree diff for `git-snapshot.ts`: run `git diff-tree -r -z --no-renames`,
 * parse the NUL-delimited raw format, classify each entry, and fetch every
 * prior blob in one `git cat-file --batch` after a `--batch-check` size pass.
 *
 * @module agent/file-checkpoint/git-snapshot.diff
 */

import * as path from 'node:path';
import { classifyFailure, isOk, runIn, type GitCtx } from './git-snapshot.exec.js';
import type { DiffOptions, DiffResult, SkippedChange, TreeChange } from './git-snapshot.js';

export interface RawEntry { oldMode: string; newMode: string; oldSha: string; status: string; gitPath: string }

const REGULAR = new Set(['100644', '100755']);
const ABSENT = '000000';

/**
 * Parse `diff-tree -r -z` raw output. Contract: each record is
 * `:<old> <new> <oldsha> <newsha> <status>\0<path>\0`; with `--no-renames`
 * there is never a second path. Returns null on malformed input.
 *
 * Invariant: the raw Buffer is split on NUL bytes BEFORE any UTF-8 decode so
 * that non-UTF-8 bytes in a filename never corrupt adjacent fields. The header
 * field is pure ASCII and always decoded safely. The path field is decoded with
 * an explicit fatal check; if it contains invalid UTF-8 the entry is skipped
 * and `onNonUtf8Path` is called with the raw Buffer so callers can emit a
 * partial warning without silently checkpointing the wrong path.
 */
export function parseRawDiff(
  buf: Buffer,
  onNonUtf8Path?: (rawPath: Buffer) => void,
): RawEntry[] | null {
  // Contract: split on the NUL byte (0x00) at the Buffer level — never decode
  // the whole buffer first, which would replace invalid UTF-8 bytes with U+FFFD
  // and cause recordPriorState to checkpoint a path that does not exist.
  const NUL = 0x00;
  const chunks: Buffer[] = [];
  let start = 0;
  for (let i = 0; i <= buf.length; i++) {
    if (i === buf.length || buf[i] === NUL) {
      chunks.push(buf.subarray(start, i));
      start = i + 1;
    }
  }
  const out: RawEntry[] = [];
  for (let i = 0; i + 1 < chunks.length; i += 2) {
    // Header is pure ASCII — safe to decode as UTF-8.
    const head = (chunks[i] ?? Buffer.alloc(0)).toString('utf8');
    const pathBuf = chunks[i + 1] ?? Buffer.alloc(0);
    // Decode the path with 'fatal' replacement detection: if the decoded string
    // contains U+FFFD the bytes were not valid UTF-8 — skip and warn.
    const gitPath = pathBuf.toString('utf8');
    if (gitPath.includes('\uFFFD')) {
      onNonUtf8Path?.(pathBuf);
      continue;
    }
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

/**
 * Largest prior blob a diff will read. Invariant: `cat-file --batch` output is
 * buffered whole, so without a per-blob cap one huge tracked file would be
 * held in memory (and then in the content store). Larger priors are reported
 * in `skipped` without ever being read.
 */
export const MAX_BLOB_BYTES = 64 * 1024 * 1024;
let maxBlobBytes = MAX_BLOB_BYTES;

/** Test seam: override the per-blob cap (`undefined` restores MAX_BLOB_BYTES). */
export function _setMaxBlobBytesForTests(value: number | undefined): void {
  maxBlobBytes = value ?? MAX_BLOB_BYTES;
}

/**
 * Parse `cat-file --batch-check` output into sizes by request order.
 * Contract: one `<sha> <type> <size>` line per request; anything that is not a
 * blob (or missing) returns null so the diff fails closed.
 */
export function parseBatchCheck(buf: Buffer, count: number): number[] | null {
  const lines = buf.toString('utf8').split('\n');
  const sizes: number[] = [];
  for (let i = 0; i < count; i++) {
    const m = /^[0-9a-f]+ blob (\d+)$/.exec(lines[i] ?? '');
    if (m === null) return null;
    sizes.push(Number(m[1]));
  }
  return sizes;
}

type Wanted = { index: number; sha: string; mode: number };

/** Fill `prior` for every wanted blob within the cap; oversized ones move to `skipped`. */
async function fetchPriors(
  ctx: GitCtx, cwd: string, wanted: Wanted[], changes: (TreeChange | null)[], skipped: SkippedChange[],
): Promise<DiffResult | null> {
  const check = await runIn(ctx, cwd, ['cat-file', '--batch-check'], wanted.map((w) => `${w.sha}\n`).join(''));
  if (!isOk(check)) return classifyFailure(check, 'git cat-file --batch-check');
  const sizes = parseBatchCheck(check.stdout, wanted.length);
  if (sizes === null) return { ok: false, reason: 'error', detail: 'git cat-file: missing or malformed blob' };
  const small = wanted.filter((w, i) => {
    if ((sizes[i] ?? 0) <= maxBlobBytes) return true;
    const target = changes[w.index];
    if (target) skipped.push({ absPath: target.absPath, reason: `prior content larger than ${maxBlobBytes} bytes` });
    changes[w.index] = null;
    return false;
  });
  if (small.length === 0) return null;
  const cat = await runIn(ctx, cwd, ['cat-file', '--batch'], small.map((w) => `${w.sha}\n`).join(''));
  if (!isOk(cat)) return classifyFailure(cat, 'git cat-file');
  const blobs = parseCatFileBatch(cat.stdout, small.length);
  if (blobs === null) return { ok: false, reason: 'error', detail: 'git cat-file: missing or malformed blob' };
  small.forEach((w, i) => {
    const target = changes[w.index];
    const bytes = blobs[i];
    if (target && bytes !== undefined) target.prior = { bytes, mode: w.mode };
  });
  return null;
}

/** Run the diff with a context whose env already points at the private object store. */
export async function diffWithCtx(options: DiffOptions, ctx: GitCtx): Promise<DiffResult> {
  const cwd = options.repoRoot;
  const run = await runIn(ctx, cwd,
    ['diff-tree', '-r', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', options.before, options.after]);
  if (!isOk(run)) return classifyFailure(run, 'git diff-tree');
  const skipped: SkippedChange[] = [];
  const entries = parseRawDiff(run.stdout, (rawPath) => {
    // Non-UTF-8 filename: emit a partial warning with a hex repr so the caller
    // knows a file was skipped without checkpointing a corrupted path.
    skipped.push({ absPath: `<non-utf8:${rawPath.toString('hex')}>`, reason: 'non-UTF-8 filename' });
  });
  if (entries === null) return { ok: false, reason: 'error', detail: 'git diff-tree: unparseable output' };

  const max = Math.max(0, Math.floor(options.maxFiles));
  // Invariant: maxFiles bounds changes + skipped together, so neither list
  // (and no blob fetch) grows past it however large the diff is.
  const truncated = entries.length > max;
  const kept = entries.slice(0, max);
  const changes: (TreeChange | null)[] = [];
  const wanted: Wanted[] = [];
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
    const failed = await fetchPriors(ctx, cwd, wanted, changes, skipped);
    if (failed !== null) return failed;
  }
  return { ok: true, changes: changes.filter((c): c is TreeChange => c !== null), skipped, truncated };
}
