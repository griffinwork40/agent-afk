/**
 * Guard: a terminal-width read may not invent its own fallback width.
 *
 * `getTerminalWidth()` (terminal-size.ts) is the canonical width source and
 * falls back to 80 columns when `process.stdout.columns` is unusable. Two
 * modules had drifted past it with hand-rolled fallbacks:
 *
 *   - `_lib/stream-renderer-subagent{,-helpers}.ts` — `?? 100`, then
 *     `Math.max(20, cols - 14)`. When `columns` read undefined, the sub-agent
 *     lane budgeted its thinking-tail and tool-preview text at exactly
 *     `100 - 14 = 86` columns, regardless of the real terminal width. The
 *     helpers file already imported `getTerminalWidth` and used it 37 lines
 *     earlier, so the divergence was an oversight, not a deliberate choice.
 *   - `slash/commands/bgsub.ts` — `?? 120`, then `Math.max(40, cols - 10)`.
 *
 * Both belong to the same defect class as the stale-width bugs pinned in
 * `terminal-compositor.resize-stale-width.repro.test.ts`: rendering at a width
 * that is not the terminal's width. A too-WIDE invented fallback is the harmful
 * direction — emitted rows overflow the real terminal and get soft-wrapped
 * mid-word, which is exactly the artifact those regressions exist to prevent.
 * The canonical 80 is deliberately conservative: it can under-fill, never
 * overflow.
 *
 * This is a test rather than a lint rule because the failure is invisible in
 * review and only manifests when `columns` reads undefined — piped output, a
 * detached PTY, or a resize race. If a future surface genuinely needs a
 * different fallback, change this test deliberately; do not drift past it.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getTerminalWidth } from './terminal-size.js';

/** The one fallback width the codebase is allowed to hard-code. */
const CANONICAL_FALLBACK = 80;

/** `src/` — this file lives in `src/cli/`. */
const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Matches `stdout.columns ?? 120` / `self.stdout.columns || 100` and captures the literal. */
const COLUMNS_FALLBACK = /stdout\.columns\s*(?:\?\?|\|\|)\s*(\d+)/g;

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      sourceFiles(full, acc);
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      // The canonical helper defines the fallback; it cannot violate itself.
      entry.name !== 'terminal-size.ts'
    ) {
      acc.push(full);
    }
  }
  return acc;
}

describe('terminal-width fallback guard', () => {
  it('no source module pairs a stdout.columns read with a non-canonical fallback', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC_ROOT)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        for (const match of line.matchAll(COLUMNS_FALLBACK)) {
          const width = Number(match[1]);
          if (width !== CANONICAL_FALLBACK) {
            offenders.push(
              `${relative(SRC_ROOT, file)}:${i + 1} falls back to ${width}, not ${CANONICAL_FALLBACK} — use getTerminalWidth()`,
            );
          }
        }
      });
    }

    expect(offenders).toEqual([]);
  });

  it('getTerminalWidth() resolves the canonical fallback for every unusable width', () => {
    const original = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
    const setColumns = (value: number | undefined): void => {
      Object.defineProperty(process.stdout, 'columns', {
        value,
        configurable: true,
        writable: true,
      });
    };

    try {
      setColumns(undefined);
      expect(getTerminalWidth()).toBe(CANONICAL_FALLBACK);

      // 0 is reported by some non-TTY pipes. `?? 100` did NOT catch this —
      // it only guards null/undefined — so the old sub-agent path computed
      // `Math.max(20, 0 - 14)` = 20 columns here.
      setColumns(0);
      expect(getTerminalWidth()).toBe(CANONICAL_FALLBACK);

      // A real width is passed through untouched (no readability cap).
      setColumns(250);
      expect(getTerminalWidth()).toBe(250);
    } finally {
      if (original) {
        Object.defineProperty(process.stdout, 'columns', original);
      } else {
        delete (process.stdout as unknown as { columns?: number }).columns;
      }
    }
  });
});
