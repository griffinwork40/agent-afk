/**
 * Startup recall — renders a single dim line showing the most recent sealed
 * session for the current cwd.
 *
 * Displayed in the REPL pre-arm banner block, right after the boot-prune
 * notice. Gives the user instant backward context (where they left off)
 * without requiring any input.
 *
 * Invariant: this function must never throw. All filesystem reads are wrapped
 * in try/catch so a corrupt or missing session directory cannot crash bootstrap.
 *
 * Invariant: returns undefined (suppressed) when the banner would be
 * redundant (resume, first-run, non-TTY) or when no matching session exists.
 *
 * Invariant: nothing here writes to the terminal in normal use. The only
 * output is a slow-scan diagnostic, and it goes through `debugLog`, so it
 * appears only under AFK_DEBUG=1 / DEBUG=1.
 */

import { openSync, readSync, closeSync, readdirSync, statSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';

import { palette } from '../../palette.js';
import { stripAnsi } from '../../display.js';
import { getSessionsDir } from '../../../paths.js';
import { debugLog } from '../../../utils/debug.js';
import { getOrDeriveFacet } from '../../../agent/facets/store.js';
import type { SessionFacet } from '../../../agent/facets/schema.js';

// How many recent sidecar files to inspect before giving up.
const MAX_SCAN = 30;

// How many bytes to read from the sidecar head for the cwd and sealed checks.
const HEAD_BYTES = 1024;

// A scan slower than this is reported, to developers only (see reportSlowScan).
const SLOW_SCAN_MS = 50;

// Max characters of brief_summary to display.
const SUMMARY_MAX = 50;

// Max characters of first_prompt fallback to display.
const PROMPT_FALLBACK_MAX = 40;

/**
 * Read the first HEAD_BYTES bytes of a file using low-level fd ops so we
 * never read the entire sidecar into memory just to check one field.
 */
function readFileHead(filePath: string): string {
  const fd = openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const bytesRead = readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** What the scan needs from a sidecar, read from its first HEAD_BYTES. */
interface SidecarHead {
  /** Decoded `cwd`, or undefined when the head carries none. */
  cwd: string | undefined;
  /** True when the head carries `endedAt`, i.e. the session was closed. */
  sealed: boolean;
}

/**
 * Read a sidecar's cwd and sealed-ness from its head. Returns undefined when
 * the file cannot be read.
 *
 * Contract: `sealed` is the sidecar's own `endedAt`, which `saveSession`
 * writes only at close time and always ahead of `turns`, so it falls inside
 * the head. It must not be inferred from the facet: `deriveSessionFacet` fills
 * `end_time` from `savedAt` on every save, so a session that is still running
 * has one too. Surfaces that never close their sidecar (daemon, Telegram) are
 * therefore never recalled, which suits a line about where the user left off.
 * A quoted `"endedAt"` inside turn text cannot match: JSON escapes its quotes.
 */
function readSidecarHead(filePath: string): SidecarHead | undefined {
  let head: string;
  try {
    head = readFileHead(filePath);
  } catch {
    return undefined;
  }
  const raw = head.match(/"cwd"\s*:\s*"([^"]*)"/)?.[1];
  let cwd: string | undefined;
  if (raw !== undefined) {
    // Decode JSON escape sequences (backslash paths on Windows, Unicode escapes)
    // so the comparison against opts.cwd uses the real path, not raw JSON bytes.
    try { cwd = JSON.parse('"' + raw + '"') as string; } catch { cwd = raw; }
  }
  return { cwd, sealed: /"endedAt"\s*:\s*\d/.test(head) };
}

/**
 * Report a slow scan to developers. Silent unless AFK_DEBUG=1 / DEBUG=1:
 * `debugLog` owns the gate, so an ordinary boot never shows this line. Dim and
 * indented to sit with the rest of the startup banner when it does appear.
 */
function reportSlowScan(elapsedMs: number, matched: boolean): void {
  if (elapsedMs <= SLOW_SCAN_MS) return;
  const suffix = matched ? '' : ' (no match)';
  debugLog(palette.dim(`  [startup-recall] findLatestCwdSession took ${elapsedMs.toFixed(0)}ms${suffix}`));
}

/**
 * Time {@link scanForLatestCwdSession} and hand the result to
 * {@link reportSlowScan}.
 */
function findLatestCwdSession(
  cwd: string,
  excludeId: string | undefined,
  sessionsDir: string,
): SessionFacet | undefined {
  const t0 = performance.now();
  const facet = scanForLatestCwdSession(cwd, excludeId, sessionsDir);
  reportSlowScan(performance.now() - t0, facet !== undefined);
  return facet;
}

/**
 * Walk the sessions directory (sorted by mtime desc) and return the facet for
 * the most recent sealed session whose cwd matches the given path.
 *
 * Excludes the current live session by id.
 */
function scanForLatestCwdSession(
  cwd: string,
  excludeId: string | undefined,
  sessionsDir: string,
): SessionFacet | undefined {
  let entries: Array<{ name: string; mtimeMs: number }>;
  try {
    entries = readdirSync(sessionsDir)
      .filter((f) => f.endsWith('.json'))
      .flatMap((f) => {
        try {
          return [{ name: f, mtimeMs: statSync(join(sessionsDir, f)).mtimeMs }];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return undefined;
  }

  for (const entry of entries.slice(0, MAX_SCAN)) {
    const id = entry.name.replace(/\.json$/, '');
    if (id === excludeId) continue;

    const head = readSidecarHead(join(sessionsDir, entry.name));
    if (head === undefined || head.cwd !== cwd) continue;
    // Still running, or never closed: skip before paying for a facet lookup.
    if (!head.sealed) continue;

    try {
      const facet = getOrDeriveFacet(id);
      if (facet) return facet;
    } catch {
      // Corrupt or derivation failure — skip.
    }
  }
  return undefined;
}

/** Map a facet outcome to a short human label. Returns undefined for 'unknown'. */
function outcomeLabel(outcome: SessionFacet['outcome']): string | undefined {
  switch (outcome) {
    case 'fully_achieved':     return 'Done';
    case 'partially_achieved': return 'Partial';
    case 'not_achieved':       return 'Failed';
    case 'aborted':            return 'Aborted';
    case 'unknown':            return undefined;
  }
}

/** Compute a human-readable relative time string from an ISO timestamp to now. */
export function formatTimeAgo(isoString: string, now: Date = new Date()): string {
  let then: Date;
  try {
    then = new Date(isoString);
    if (isNaN(then.getTime())) return '';
  } catch {
    return '';
  }

  const diffMs = now.getTime() - then.getTime();
  if (diffMs < 0) return 'just now';

  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;

  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

/** Truncate a string to maxLen chars, appending '…' when cut. */
function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + '…';
}

export interface StartupRecallOpts {
  cwd: string;
  isResume: boolean;
  isTTY: boolean;
  isFirstRun: boolean;
  currentSessionId?: string;
}

/**
 * Returns a dim one-liner summarising the most recent session for `cwd`, or
 * undefined when the line should be suppressed.
 *
 * Example: `  last: fixed PR review feedback · Done · 3h ago · 12 turns`
 */
export function renderStartupRecall(opts: StartupRecallOpts): string | undefined {
  if (!opts.isTTY) return undefined;
  if (opts.isResume) return undefined;
  if (opts.isFirstRun) return undefined;

  const sessionsDir = getSessionsDir();
  const facet = findLatestCwdSession(opts.cwd, opts.currentSessionId, sessionsDir);
  if (!facet) return undefined;

  const parts: string[] = [];

  // Strip ANSI escape sequences before rendering — a corrupt sidecar could
  // embed terminal control codes that bleed into the user's prompt.

  // Summary text — prefer brief_summary, fall back to first_prompt.
  const summary =
    facet.brief_summary?.trim()
      ? truncate(stripAnsi(facet.brief_summary.trim()), SUMMARY_MAX)
      : facet.first_prompt?.trim()
        ? truncate(stripAnsi(facet.first_prompt.trim()), PROMPT_FALLBACK_MAX)
        : '';

  if (summary) parts.push(summary);

  const label = outcomeLabel(facet.outcome);
  if (label) parts.push(label);

  const age = formatTimeAgo(facet.end_time);
  if (age) parts.push(age);

  parts.push(`${facet.total_turns} turns`);

  // total_turns is always pushed above; guard against a zero-turn session
  // that also has no summary/outcome/age — nothing meaningful to display.
  if (parts.length === 0 || (parts.length === 1 && facet.total_turns === 0 && !summary && !label && !age)) return undefined;

  return palette.dim(`  last: ${parts.join(' · ')}`);
}
