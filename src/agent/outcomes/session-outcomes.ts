/**
 * getSessionOutcomes — one OutcomesV1 computation per root session, shared by
 * every SessionEnd consumer (run receipt + outcome store).
 *
 * Contract: never throws, never runs longer than the total budget (default
 * 10s). Any failure or timeout resolves to `null` and is logged at debug —
 * observability only (SPINE INV-040). The promise is memoized per sessionId
 * so hook registration order is irrelevant: whichever hook asks first starts
 * the computation and both await the same promise. The cache entry is
 * evicted after CONSUMERS reads or after a TTL, whichever comes first.
 *
 * Inputs: session-start git head (session-meta sidecar), end HEAD via a
 * bounded `git rev-parse`, the commit range between them, effect-ledger rows
 * for this sessionId, journal tool events (same source as the facet
 * aggregator), and the last assistant message (same source as the receipt's
 * journalSummary).
 *
 * @module agent/outcomes/session-outcomes
 */

import { debugLog } from '../../utils/debug.js';
import { execFileAsync } from '../../utils/exec-file.js';
import { readOutcomesMeta, readOutcomesJournal, checkBudget, type InputBudget } from './outcomes-input.js';
import { readEffectsForSession } from '../effect-ledger/store.js';
import { computeOutcomes } from './compute-outcomes.js';
import { gitLogRange } from './git-range.js';
import { OutcomesV1Schema, type OutcomesV1 } from './outcomes-v1.schema.js';

export interface SessionOutcomesContext {
  /** Fallback cwd when the session-meta sidecar has none. */
  cwd?: string;
}

/** Number of SessionEnd consumers that read the memo (receipt + store). */
const CONSUMERS = 2;
const TOTAL_TIMEOUT_MS = 10_000;
const HEAD_TIMEOUT_MS = 3_000;
const CACHE_TTL_MS = 60_000;
const SHA40_RE = /^[0-9a-f]{40}$/;

interface Entry {
  promise: Promise<OutcomesV1 | null>;
  reads: number;
  timer: ReturnType<typeof setTimeout>;
}

const cache = new Map<string, Entry>();

/** Test seam: drop every memoized computation. */
export function _resetSessionOutcomesCache(): void {
  for (const e of cache.values()) clearTimeout(e.timer);
  cache.clear();
}

/** Full HEAD sha of `cwd`, or null (not a repo, git missing, timeout). */
export async function readEndHead(cwd: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, '--no-optional-locks', 'rev-parse', 'HEAD'], {
      timeout: HEAD_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
      killSignal: 'SIGTERM',
      maxBuffer: 4096,
    });
    const sha = String(stdout).trim().toLowerCase();
    return SHA40_RE.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

async function compute(sessionId: string, ctx: SessionOutcomesContext, budget: InputBudget): Promise<OutcomesV1 | null> {
  const meta = await readOutcomesMeta(sessionId, budget);
  const cwd = meta?.cwd ?? ctx.cwd;
  if (cwd === undefined) return null;
  const startHead = meta?.gitHead?.headSha ?? null;
  const endHead = await readEndHead(cwd, budget.signal);
  checkBudget(budget);
  const [gitLog, ledgerEntries, journal] = await Promise.all([
    gitLogRange(cwd, startHead, endHead, { signal: budget.signal }),
    readEffectsForSession(sessionId, { budget }),
    readOutcomesJournal(sessionId, budget),
  ]);
  checkBudget(budget);
  const outcomes = computeOutcomes({
    cwd,
    startHead,
    endHead,
    gitLog,
    ledgerEntries,
    ...journal,
  });
  checkBudget(budget);
  const parsed = OutcomesV1Schema.safeParse(outcomes);
  if (!parsed.success) {
    debugLog(`[session-outcomes] schema rejected computed outcomes: ${parsed.error.message}`);
    return null;
  }
  return parsed.data;
}

function bounded(sessionId: string, ctx: SessionOutcomesContext, timeoutMs: number): Promise<OutcomesV1 | null> {
  return new Promise((resolve) => {
    const controller = new AbortController();
    const budget = { signal: controller.signal, deadline: Date.now() + timeoutMs };
    const timer = setTimeout(() => {
      controller.abort(new Error('outcomes computation timed out'));
      debugLog(`[session-outcomes] timed out after ${timeoutMs}ms for ${sessionId}`);
      resolve(null);
    }, timeoutMs);
    timer.unref?.();
    Promise.resolve()
      .then(() => compute(sessionId, ctx, budget))
      .then(
        (v) => resolve(v),
        (err: unknown) => {
          debugLog(`[session-outcomes] computation failed for ${sessionId}: ${String(err)}`);
          resolve(null);
        },
      )
      .finally(() => {
        clearTimeout(timer);
        controller.abort();
      });
  });
}

/**
 * Memoized OutcomesV1 for a root session. Resolves to null on any failure;
 * never rejects. `ctx.cwd` is the fallback when the session-meta sidecar
 * carries no cwd.
 */
export function getSessionOutcomes(
  sessionId: string,
  ctx: SessionOutcomesContext = {},
  opts: { timeoutMs?: number } = {},
): Promise<OutcomesV1 | null> {
  let entry = cache.get(sessionId);
  if (!entry) {
    const timer = setTimeout(() => cache.delete(sessionId), CACHE_TTL_MS);
    timer.unref?.();
    entry = { promise: bounded(sessionId, ctx, opts.timeoutMs ?? TOTAL_TIMEOUT_MS), reads: 0, timer };
    cache.set(sessionId, entry);
  }
  entry.reads++;
  if (entry.reads >= CONSUMERS) {
    clearTimeout(entry.timer);
    cache.delete(sessionId);
  }
  return entry.promise;
}
