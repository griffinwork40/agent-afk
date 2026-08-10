/**
 * Shared one-way ratchet for size gates. Consumed by `scripts/check-file-size.ts`
 * (unit = file) and `scripts/check-function-size.ts` (unit = function).
 *
 * Invariant: a baseline grandfathers what already exceeded the ceiling when its
 * gate landed, and it may only ever shrink. Five failure modes keep it from
 * silently slackening into a parking lot:
 *   NEW      a non-baselined key exceeds the ceiling.
 *   GREW     a baselined key is larger than its recorded size.
 *   RETIRED  a baselined key now fits — remove it.
 *   STALE    a baselined key no longer exists — remove it.
 *   TOUCHED  a baselined key was modified without being brought under the ceiling.
 *
 * `permanent: true` exempts an entry from RETIRED (it is never expected to fit)
 * but NOT from GREW. Each needs a written reason. Keep the list tiny.
 *
 * Contract: this module is pure with respect to the ratchet decision — it reads
 * and writes the baseline file and computes violations, but never prints and
 * never exits. Message wording and process exit belong to the calling gate,
 * because the two units need different remediation advice.
 */

import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';

export interface BaselineEntry {
  loc: number;
  reason: string;
  permanent?: boolean;
}

export interface Baseline {
  limit: number;
  entries: Record<string, BaselineEntry>;
}

export type ViolationKind = 'NEW' | 'GREW' | 'RETIRED' | 'STALE' | 'TOUCHED';

export interface Violation {
  kind: ViolationKind;
  key: string;
  detail: string;
}

export interface RatchetConfig {
  /** Hard ceiling. Never raise it — extract a concern instead. */
  limit: number;
  /** Absolute path to the baseline JSON. */
  baselinePath: string;
  /** Repo-relative baseline path, for messages. */
  baselineRel: string;
  /** Singular noun for the measured unit, e.g. 'line'. */
  unit: string;
  /** Plural noun for what a baseline entry denotes, e.g. 'files' or 'functions'. */
  entryPlural: string;
  /** Default `reason` stamped on newly-grandfathered entries. */
  legacyReason: string;
}

export function loadBaseline(cfg: RatchetConfig): Baseline {
  if (!fs.existsSync(cfg.baselinePath)) return { limit: cfg.limit, entries: {} };
  const parsed = JSON.parse(fs.readFileSync(cfg.baselinePath, 'utf8')) as Partial<Baseline>;
  return { limit: parsed.limit ?? cfg.limit, entries: parsed.entries ?? {} };
}

/**
 * Invariant: keys sorted, exactly one line per entry. This layout is what keeps
 * concurrent single-subtree waves from colliding in git, so do not reformat it
 * with a bare JSON.stringify(obj, null, 2) — that explodes each entry across
 * four lines and turns every wave into a merge conflict.
 */
export function serializeBaseline(baseline: Baseline): string {
  const keys = Object.keys(baseline.entries).sort();
  const lines = keys.map((k) => {
    const e = baseline.entries[k];
    if (!e) return '';
    const parts: string[] = [`"loc": ${e.loc}`];
    if (e.permanent) parts.push('"permanent": true');
    parts.push(`"reason": ${JSON.stringify(e.reason)}`);
    return `    ${JSON.stringify(k)}: { ${parts.join(', ')} }`;
  });
  return `{\n  "limit": ${baseline.limit},\n  "entries": {\n${lines.join(',\n')}\n  }\n}\n`;
}

export interface UpdateResult {
  kept: number;
  dropped: string[];
}

/**
 * Regenerate the baseline from measured sizes, preserving `reason` / `permanent`
 * by key so hand-written rationale is never lost to a mechanical refresh.
 */
export function updateBaseline(cfg: RatchetConfig, sizes: Map<string, number>): UpdateResult {
  const previous = loadBaseline(cfg);
  const entries: Record<string, BaselineEntry> = {};
  for (const [key, loc] of sizes) {
    if (loc <= cfg.limit) continue;
    const prior = previous.entries[key];
    entries[key] = {
      loc,
      reason: prior?.reason ?? cfg.legacyReason,
      ...(prior?.permanent ? { permanent: true } : {}),
    };
  }
  fs.writeFileSync(cfg.baselinePath, serializeBaseline({ limit: cfg.limit, entries }), 'utf8');
  return {
    kept: Object.keys(entries).length,
    dropped: Object.keys(previous.entries).filter((k) => !entries[k]),
  };
}

/**
 * Files changed relative to `ref`, filtered to what the caller considers scannable.
 *
 * Invariant: diff from the MERGE BASE to the WORKING TREE, not `ref...HEAD`.
 * Two properties are load-bearing and each rules out a simpler form:
 *   - merge-base (not `ref` directly) so files advanced on `ref` since the branch
 *     point are not misattributed to this change;
 *   - working tree (not `HEAD`) so uncommitted edits are caught — a pre-commit or
 *     local invocation must see work that is not yet a commit.
 */
export function changedSince(ref: string, repoRoot: string, isScannable: (rel: string) => boolean): string[] {
  let base = ref;
  try {
    base = execFileSync('git', ['merge-base', ref, 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    // No merge base (unrelated histories, or `ref` unfetched) — fall back to a
    // direct diff rather than failing the gate on a git topology problem.
  }
  const out = execFileSync('git', ['diff', '--name-only', base], { cwd: repoRoot, encoding: 'utf8' });
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && isScannable(l));
}

export interface ViolationInput {
  /** Measured size per key, for every key currently on disk. */
  sizes: Map<string, number>;
  baseline: Baseline;
  cfg: RatchetConfig;
  /**
   * Keys belonging to something modified in this change. Supplying it enables the
   * TOUCHED mode; omit it to skip that check entirely.
   */
  touchedKeys?: Set<string>;
  /** Human label for what TOUCHED compared against, e.g. 'origin/main'. */
  touchedVs?: string;
}

export function collectViolations(input: ViolationInput): Violation[] {
  const { sizes, baseline, cfg, touchedKeys, touchedVs } = input;
  const violations: Violation[] = [];

  for (const [key, loc] of sizes) {
    const entry = baseline.entries[key];
    if (!entry) {
      if (loc > cfg.limit) {
        violations.push({
          kind: 'NEW',
          key,
          detail: `${loc} ${cfg.unit}s exceeds the ${cfg.limit}-${cfg.unit} ceiling by ${loc - cfg.limit}`,
        });
      }
      continue;
    }
    if (loc > entry.loc) {
      violations.push({
        kind: 'GREW',
        key,
        detail: `grew ${entry.loc} → ${loc} (+${loc - entry.loc}); baselined ${cfg.entryPlural} may shrink, never grow`,
      });
    } else if (loc <= cfg.limit && !entry.permanent) {
      violations.push({
        kind: 'RETIRED',
        key,
        detail: `now ${loc} ${cfg.unit}s and within the ceiling — remove it from ${cfg.baselineRel}`,
      });
    }
  }

  for (const key of Object.keys(baseline.entries)) {
    if (!sizes.has(key)) {
      violations.push({ kind: 'STALE', key, detail: `no longer exists — remove it from ${cfg.baselineRel}` });
    }
  }

  if (touchedKeys) {
    for (const key of touchedKeys) {
      const loc = sizes.get(key);
      if (loc === undefined || loc <= cfg.limit) continue;
      if (!baseline.entries[key]) continue; // already reported as NEW
      violations.push({
        kind: 'TOUCHED',
        key,
        detail:
          `modified vs ${touchedVs ?? 'the base ref'} while still ${loc} ${cfg.unit}s — ` +
          `a change that touches a baselined entry must bring it under ${cfg.limit}`,
      });
    }
  }

  return violations;
}

/** Stable print order: worst-actionable first, bookkeeping last. */
export const VIOLATION_ORDER: readonly ViolationKind[] = ['NEW', 'GREW', 'TOUCHED', 'RETIRED', 'STALE'];
