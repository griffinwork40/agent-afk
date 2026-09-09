/**
 * Pure analysis functions for workspace read-dedup measurement.
 *
 * Extracted from `scripts/measure-read-dedup.ts` so the logic is testable
 * without CLI argument parsing or filesystem I/O.
 *
 * @module scripts/workspace-ab/analyze-read-dedup
 */

import type {
  DedupReport,
  FingerprintGroup,
  ToolCallStarted,
  ValidationFailure,
  ValidationResult,
} from './types.js';

// ─── Analysis ───────────────────────────────────────────────────────────────

/**
 * Analyze parsed tool calls and produce a deduplication report.
 *
 * Groups calls by `(toolName, argsFingerprint)` for exact-call deduplication,
 * and by `(toolName, resourceFingerprint)` for resource-level overlap.
 */
export function analyze(args: {
  calls: ToolCallStarted[];
  tracePath: string;
  allTools: boolean;
  skippedNoFingerprint: number;
  totalToolCallStarted: number;
}): DedupReport {
  const { calls, tracePath, allTools, skippedNoFingerprint, totalToolCallStarted } = args;

  // ── Exact-call grouping (argsFingerprint) ───────────────────────────────
  const groups = new Map<string, FingerprintGroup>();
  const allAgents = new Set<string>();

  for (const c of calls) {
    allAgents.add(c.subagentId);
    const groupKey = `${c.name}|${c.argsFingerprint}`;
    let g = groups.get(groupKey);
    if (!g) {
      g = {
        fingerprint: c.argsFingerprint,
        toolName: c.name,
        agents: new Set(),
        totalCalls: 0,
        callDetails: [],
      };
      groups.set(groupKey, g);
    }
    g.agents.add(c.subagentId);
    g.totalCalls++;
    g.callDetails.push({ subagentId: c.subagentId, seq: c.seq, ts: c.ts });
  }

  const { crossAgentDuplicates, selfDuplicates, hotFingerprints } =
    computeDuplication(groups);

  // ── Resource-level grouping (resourceFingerprint) ───────────────────────
  const fileOverlapRatio = computeFileOverlapRatio(calls);

  const totalCalls = calls.length;
  const crossAgentDedupRatio = totalCalls > 0 ? crossAgentDuplicates / totalCalls : 0;

  return {
    tracePath,
    toolFilter: allTools ? 'all tools' : 'read_file only',
    totalCalls,
    uniqueFingerprints: groups.size,
    crossAgentDuplicates,
    selfDuplicates,
    crossAgentDedupRatio,
    crossAgentFileOverlapRatio: fileOverlapRatio,
    distinctAgents: allAgents.size,
    hotFingerprints: hotFingerprints.slice(0, 20),
    skippedNoFingerprint,
    totalToolCallStarted,
  };
}

// ─── Duplication computation ────────────────────────────────────────────────

function computeDuplication(groups: Map<string, FingerprintGroup>) {
  let crossAgentDuplicates = 0;
  let selfDuplicates = 0;
  const hotFingerprints: DedupReport['hotFingerprints'] = [];

  for (const g of groups.values()) {
    const perAgent = new Map<string, number>();
    for (const d of g.callDetails) {
      perAgent.set(d.subagentId, (perAgent.get(d.subagentId) ?? 0) + 1);
    }

    // Self-duplicates: within any single agent, calls beyond the first
    for (const count of perAgent.values()) {
      if (count > 1) selfDuplicates += count - 1;
    }

    // Cross-agent duplicates: every agent beyond the first contributes all
    // of its calls (the earliest agent "owns" the original read).
    if (perAgent.size > 1) {
      // Pre-compute each agent's earliest seq to avoid O(n) .find() inside
      // the comparator (which makes the sort O(n² log n) for large groups).
      const firstSeq = new Map<string, number>();
      for (const d of g.callDetails) {
        const prev = firstSeq.get(d.subagentId);
        if (prev === undefined || d.seq < prev) firstSeq.set(d.subagentId, d.seq);
      }
      const agents = [...perAgent.entries()].sort(
        (a, b) => firstSeq.get(a[0])! - firstSeq.get(b[0])!,
      );
      for (let i = 1; i < agents.length; i++) {
        crossAgentDuplicates += agents[i]![1];
      }
      hotFingerprints.push({
        fingerprint: g.fingerprint.slice(0, 16),
        toolName: g.toolName,
        agentCount: g.agents.size,
        totalCalls: g.totalCalls,
        agents: [...g.agents],
      });
    }
  }

  hotFingerprints.sort((a, b) => b.totalCalls - a.totalCalls);
  return { crossAgentDuplicates, selfDuplicates, hotFingerprints };
}

// ─── Resource-level file overlap ────────────────────────────────────────────

/**
 * Compute the cross-agent file-overlap ratio using `resourceFingerprint`.
 *
 * Groups calls by `(toolName, resourceFingerprint)` -- this collapses reads
 * of the same file at different offsets into one resource. The ratio is the
 * fraction of total resource-bearing calls that are cross-agent duplicates.
 *
 * Returns `null` when no calls carry a `resourceFingerprint` (pre-upgrade
 * traces or non-resource tools only).
 */
function computeFileOverlapRatio(calls: ToolCallStarted[]): number | null {
  const resourceCalls = calls.filter(c => c.resourceFingerprint != null);
  if (resourceCalls.length === 0) return null;

  const groups = new Map<string, { agents: Map<string, number>; details: Array<{ subagentId: string; seq: number }> }>();

  for (const c of resourceCalls) {
    const key = `${c.name}|${c.resourceFingerprint!}`;
    let g = groups.get(key);
    if (!g) {
      g = { agents: new Map(), details: [] };
      groups.set(key, g);
    }
    g.agents.set(c.subagentId, (g.agents.get(c.subagentId) ?? 0) + 1);
    g.details.push({ subagentId: c.subagentId, seq: c.seq });
  }

  let duplicates = 0;
  for (const g of groups.values()) {
    if (g.agents.size > 1) {
      // Pre-compute each agent's earliest seq to avoid O(n) .find() inside
      // the comparator (which makes the sort O(n² log n) for large groups).
      const firstSeq = new Map<string, number>();
      for (const d of g.details) {
        const prev = firstSeq.get(d.subagentId);
        if (prev === undefined || d.seq < prev) firstSeq.set(d.subagentId, d.seq);
      }
      const agents = [...g.agents.entries()].sort(
        (a, b) => firstSeq.get(a[0])! - firstSeq.get(b[0])!,
      );
      for (let i = 1; i < agents.length; i++) {
        duplicates += agents[i]![1];
      }
    }
  }

  return resourceCalls.length > 0 ? duplicates / resourceCalls.length : 0;
}

// ─── Validation ─────────────────────────────────────────────────────────────

/**
 * Validate a dedup report for experiment suitability. Returns failures
 * explaining why the report should not be used for A/B comparison.
 *
 * @param hasValidClosure - Whether the session reached a valid terminal state.
 *   The caller must determine this from the trace (the analyzer has no I/O).
 * @param childFailureRate - Fraction of child subagents that failed or were
 *   cancelled. The caller computes this from the trace.
 */
export function validate(
  report: DedupReport,
  opts?: { hasValidClosure?: boolean; childFailureRate?: number },
): ValidationResult {
  const failures: ValidationFailure[] = [];

  if (report.distinctAgents < 1) {
    failures.push({ rule: 'no-subagents', message: 'No subagents ran (only root session).' });
  } else if (report.distinctAgents < 2) {
    failures.push({
      rule: 'too-few-reading-agents',
      message: `Fewer than 2 agents performed reads (found ${report.distinctAgents}).`,
      agentCount: report.distinctAgents,
    });
  }

  // New traces should always have fingerprints; >20% missing suggests
  // a pre-upgrade trace that can't support the experiment.
  if (report.totalCalls > 0 && report.skippedNoFingerprint > 0) {
    const ratio = report.skippedNoFingerprint / (report.totalCalls + report.skippedNoFingerprint);
    if (ratio > 0.2) {
      failures.push({
        rule: 'missing-fingerprints',
        message: `${(ratio * 100).toFixed(0)}% of tool calls lack fingerprints (pre-upgrade trace).`,
        ratio,
      });
    }
  }

  if (opts?.hasValidClosure === false) {
    failures.push({ rule: 'no-closure', message: 'Session did not reach a valid closure.' });
  }

  if (opts?.childFailureRate !== undefined && opts.childFailureRate > 0.5) {
    failures.push({
      rule: 'high-child-failure-rate',
      message: `${(opts.childFailureRate * 100).toFixed(0)}% of children failed or were cancelled.`,
      rate: opts.childFailureRate,
    });
  }

  return { valid: failures.length === 0, failures };
}
