/** Contract: pure merge helpers; missing index stages are null, malformed stages throw. */
import type { Baseline, BaselineEntry } from './size-ratchet.js';
import type { PosixBaseline, RuleCounts } from './posix-guard.js';

export type { Baseline, BaselineEntry } from './size-ratchet.js';

/**
 * Invariant: either side's prior approval is sufficient. The subsequent update
 * compares measured sizes against max(ours, theirs), then tightens the baseline.
 * Human-authored reasons and permanent exemptions survive that update by key
 * (see size-ratchet.ts updateBaseline).
 *
 * Note: the test-typecheck ratchet (unionTypecheck below) uses a different
 * update path (check-test-typecheck.ts runUpdate / computeNewBaseline). Its
 * reason survives only when the error count is unchanged after regeneration;
 * it is dropped when the count shrinks (the growth it justified is gone).
 */
export function unionBaselines(ours: Baseline | null, theirs: Baseline | null): Baseline {
  const entries: Record<string, BaselineEntry> = {};
  for (const side of [ours, theirs]) {
    for (const [key, entry] of Object.entries(side?.entries ?? {})) {
      const previous = entries[key];
      entries[key] = {
        loc: Math.max(previous?.loc ?? 0, entry.loc),
        reason: previous?.reason.trim() ? previous.reason : entry.reason,
        ...(previous?.permanent || entry.permanent ? { permanent: true } : {}),
      };
    }
  }
  return { limit: ours?.limit ?? theirs?.limit ?? 350, entries };
}

/** Only an absent stage is empty; invalid JSON must never erase prior approvals. */
export function parseBaseline(raw: string): Baseline | null {
  if (!raw.trim()) return null;
  const parsed = JSON.parse(raw) as Baseline;
  if (!parsed.entries || !Number.isFinite(parsed.limit)) throw new Error('Invalid size baseline');
  for (const entry of Object.values(parsed.entries)) {
    if (!Number.isFinite(entry.loc) || typeof entry.reason !== 'string') {
      throw new Error('Invalid size baseline entry');
    }
  }
  return parsed;
}

/** Per-file, per-rule count maxima preserve the POSIX guard's growth-only ratchet. */
export function unionPosix(ours: PosixBaseline | null, theirs: PosixBaseline | null): PosixBaseline {
  const entries: Record<string, RuleCounts> = {};
  for (const side of [ours, theirs]) {
    for (const [file, counts] of Object.entries(side?.entries ?? {})) {
      const merged = entries[file] ?? {};
      for (const rule of ['R1', 'R2', 'R3', 'R4'] as const) {
        if (counts[rule] !== undefined) merged[rule] = Math.max(merged[rule] ?? 0, counts[rule]);
      }
      entries[file] = merged;
    }
  }
  return { entries };
}

export interface TypecheckBaseline { errors: number; reason?: string }

/** The test-typecheck ratchet is one global count, with an optional growth reason. */
export function unionTypecheck(
  ours: TypecheckBaseline | null,
  theirs: TypecheckBaseline | null,
): TypecheckBaseline {
  const oursErrors = ours?.errors ?? 0;
  const theirsErrors = theirs?.errors ?? 0;
  const maxSide = oursErrors >= theirsErrors ? ours : theirs;
  const otherSide = oursErrors >= theirsErrors ? theirs : ours;
  const reason = maxSide?.reason?.trim() ? maxSide.reason : otherSide?.reason?.trim() ? otherSide.reason : undefined;
  return {
    errors: Math.max(oursErrors, theirsErrors),
    ...(reason ? { reason } : {}),
  };
}

/**
 * Contract: only fully derivable artifacts with existing update commands belong
 * here. POSIX counts (audit:posix:update) and test error counts (lint:tests:update)
 * qualify. The SDK lock does not: new symbols need human-authored reasons.
 * Env registries deliberately retain normal git merging; do not add -merge.
 */
export const GENERATED_PATHS = new Set([
  '.filesize-baseline.json',
  '.funcsize-baseline.json',
  'docs/env-registry.json',
  'docs/env-registry.md',
  'website/content/docs/reference/environment-variables.mdx',
  '.posix-guard-baseline.json',
  '.test-typecheck-baseline.json',
]);
