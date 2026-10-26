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
 */

import { openSync, readSync, closeSync, readdirSync, statSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';

import { palette } from '../../palette.js';
import { getSessionsDir } from '../../../paths.js';
import { getOrDeriveFacet } from '../../../agent/facets/store.js';
import type { SessionFacet } from '../../../agent/facets/schema.js';

// How many recent sidecar files to inspect before giving up.
const MAX_SCAN = 30;

// How many bytes to read from the sidecar head for the cwd check.
const HEAD_BYTES = 1024;

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

/**
 * Extract the cwd field from the first HEAD_BYTES of a sidecar JSON file.
 * Returns undefined when the field is absent or the file cannot be read.
 */
function extractCwdFromHead(filePath: string): string | undefined {
  try {
    const head = readFileHead(filePath);
    const match = head.match(/"cwd"\s*:\s*"([^"]*)"/);
    // Decode JSON escape sequences (backslash paths on Windows, Unicode escapes)
    // so the comparison against opts.cwd uses the real path, not raw JSON bytes.
    if (!match) return undefined;
    try { return JSON.parse('"' + match[1] + '"'); } catch { return match[1]; }
  } catch {
    return undefined;
  }
}

/**
 * Walk the sessions directory (sorted by mtime desc) and return the facet for
 * the most recent sealed session whose cwd matches the given path.
 *
 * Excludes the current live session by id.
 */
function findLatestCwdSession(
  cwd: string,
  excludeId: string | undefined,
  sessionsDir: string,
): SessionFacet | undefined {
  const t0 = performance.now();
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

    const fileCwd = extractCwdFromHead(join(sessionsDir, entry.name));
    if (fileCwd !== cwd) continue;

    try {
      const facet = getOrDeriveFacet(id);
      // Skip unsealed (live) sessions — end_time is set only on session seal.
      if (facet && facet.end_time) {
        const elapsed = performance.now() - t0;
        if (elapsed > 50) {
          process.stderr.write(`[startup-recall] findLatestCwdSession took ${elapsed.toFixed(0)}ms\n`);
        }
        return facet;
      }
    } catch {
      // Corrupt or derivation failure — skip.
    }
  }
  const elapsed = performance.now() - t0;
  if (elapsed > 50) {
    process.stderr.write(`[startup-recall] findLatestCwdSession took ${elapsed.toFixed(0)}ms (no match)\n`);
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
  const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

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
