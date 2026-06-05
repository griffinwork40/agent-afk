/**
 * Memory write-through for Speculative Branch Farm runs.
 *
 * Persists a structured `farm-run` fact to cross-session memory after every
 * farm completion. Failures are swallowed — farm completion takes priority
 * over memory bookkeeping.
 *
 * @module skills/score/memory-write
 */

import { MemoryStore } from '../../agent/memory/memory-store.js';
import { type FarmRunRecord, type FarmBranchRecord } from './farm-run-record.js';

// Re-export so existing callers (and the test file) can keep importing types
// from this module. Canonical source is `./farm-run-record.ts`.
export type { FarmRunRecord, FarmBranchRecord };

// ---------------------------------------------------------------------------
// Injection seam (tests only)
// ---------------------------------------------------------------------------

/** Minimal MemoryStore surface needed by writeFarmFact. */
export interface IMemoryStore {
  storeFact(fact: {
    session_id?: string;
    category: 'preference' | 'convention' | 'decision' | 'learning';
    content: string;
    source_surface: string;
  }): number;
}

// ---------------------------------------------------------------------------
// Fact content shape (internal)
// ---------------------------------------------------------------------------

interface ScoreEntry {
  index: number;
  branch: string;
  pass: number;
  fail: number;
  loc_delta: number;
  lint_ok: boolean | null;
  duration_ms: number;
}

interface FarmFactContent {
  type: 'farm-run';
  task: string;
  taskSlug: string;
  winner: number | null;
  why: string;
  scores: ScoreEntry[];
  human_decision: FarmRunRecord['human_decision'] | null;
  baseSha: string;
  completedAt: string;
}

interface FarmDecisionFactContent {
  type: 'farm-decision';
  taskSlug: string;
  decision: NonNullable<FarmRunRecord['human_decision']>;
  decidedAt: string;
  /**
   * Which surface recorded the decision — useful to distinguish a CLI follow-up
   * (`afk farm decide`) from a Telegram inline button tap when auditing memory.
   */
  via: 'telegram' | 'cli';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Write a `farm-run` fact to the memory store.
 *
 * @param record  - Completed farm run data.
 * @param opts    - Injection seam: pass `_store` to avoid real DB in tests.
 * @returns `{ factId }` on success, or `{ skipped: true; reason }` if the
 *          memory store is unavailable. Never throws.
 */
export function writeFarmFact(
  record: FarmRunRecord,
  opts?: { _store?: IMemoryStore },
): { factId: number } | { skipped: true; reason: string } {
  let store: IMemoryStore;
  try {
    // Protocol: construct the store first — if it fails we return skipped
    // rather than letting the error propagate up through farm completion.
    store = opts?._store ?? new MemoryStore();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { skipped: true, reason };
  }

  try {
    const content = buildFactContent(record);
    const factId = store.storeFact({
      category: 'learning',
      content: JSON.stringify(content),
      source_surface: 'afk',
    });
    return { factId };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { skipped: true, reason };
  }
}

/**
 * Write a `farm-decision` fact after a human resolves a farm via Telegram or
 * CLI. This is an append, not a supersede: the smallest safe Day 4b path
 * because the original `farm-run` fact's `factId` is not currently routed
 * across the daemon → bot process boundary. Both facts share `taskSlug` and
 * the FTS index makes the pair queryable.
 *
 * If we ever route `factId` to the bot process (e.g. by stashing it in the
 * farm manifest at write time), this function can be replaced by a
 * `supersedeFact` call — the WAL-fingerprint idempotency in `MemoryStore`
 * already covers replay safety.
 */
export function writeFarmDecisionFact(
  args: {
    taskSlug: string;
    decision: NonNullable<FarmRunRecord['human_decision']>;
    decidedAt: string;
    via: 'telegram' | 'cli';
  },
  opts?: { _store?: IMemoryStore },
): { factId: number } | { skipped: true; reason: string } {
  let store: IMemoryStore;
  try {
    store = opts?._store ?? new MemoryStore();
  } catch (err) {
    return { skipped: true, reason: err instanceof Error ? err.message : String(err) };
  }
  try {
    const content: FarmDecisionFactContent = {
      type: 'farm-decision',
      taskSlug: args.taskSlug,
      decision: args.decision,
      decidedAt: args.decidedAt,
      via: args.via,
    };
    const factId = store.storeFact({
      category: 'decision',
      content: JSON.stringify(content),
      source_surface: 'afk',
    });
    return { factId };
  } catch (err) {
    return { skipped: true, reason: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function buildFactContent(record: FarmRunRecord): FarmFactContent {
  const scores = buildScoreEntries(record.branches);
  const winner = record.winner ?? null;
  const why = buildWhy(record, scores);

  return {
    type: 'farm-run',
    task: record.taskName,
    taskSlug: record.taskSlug,
    winner,
    why,
    scores,
    human_decision: record.human_decision ?? null,
    baseSha: record.baseSha,
    completedAt: record.completedAt,
  };
}

function buildScoreEntries(branches: FarmBranchRecord[]): ScoreEntry[] {
  return branches.map((b) => {
    const s = b.score ?? null;
    return {
      index: b.index,
      branch: b.branch,
      pass: s?.pass ?? 0,
      fail: s?.fail ?? 0,
      loc_delta: s?.loc_delta ?? 0,
      lint_ok: s?.lint_ok ?? null,
      duration_ms: s?.duration_ms ?? 0,
    };
  });
}

function buildWhy(record: FarmRunRecord, scores: ScoreEntry[]): string {
  const { winner, branches } = record;

  // No winner at all
  if (winner === undefined || winner === null) {
    // Check whether we have any scoring data
    const hasAnyScore = branches.some((b) => b.score != null);
    if (!hasAnyScore) {
      return 'no winner: scoring data unavailable';
    }
    return `no winner: all ${branches.length} branches failed tests`;
  }

  // Winner exists — find the winning score entry
  const winnerEntry = scores.find((s) => s.index === winner);
  if (!winnerEntry) {
    // Defensive: winner index not found in scores
    return `branch-${winner} wins`;
  }

  const testSymbol = winnerEntry.pass > 0 ? '✓' : '✗';
  const lintSymbol =
    winnerEntry.lint_ok === true ? '✓' : winnerEntry.lint_ok === false ? '✗' : '?';
  const loc = winnerEntry.loc_delta >= 0 ? `+${winnerEntry.loc_delta}` : String(winnerEntry.loc_delta);

  // Build loser delta list (comma-separated LoC numbers)
  const losers = scores.filter((s) => s.index !== winner);
  const loserDeltas = losers.map((s) =>
    s.loc_delta >= 0 ? `+${s.loc_delta}` : String(s.loc_delta),
  );
  const vsClause = loserDeltas.length > 0 ? ` (vs ${loserDeltas.join(', ')} LoC)` : '';

  return `branch-${winner} wins: tests${testSymbol}, lint${lintSymbol}, ${loc} LoC${vsClause}`;
}
