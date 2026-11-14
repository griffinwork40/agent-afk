/**
 * Subscription overage detection from `anthropic-ratelimit-unified-*` response
 * headers (#4883).
 *
 * A Claude subscription with extra usage enabled keeps serving requests after
 * its usage window is exhausted and bills the excess at API rates, while the
 * request still authenticates with the OAuth login. This module classifies each
 * response so the per-response cost AFK already computes can be attributed to
 * overage, and keeps the raw header evidence for the trace.
 *
 * The rule mirrors the reference client (Claude Code 2.1.319, strings inspected
 * in the installed binary). A response was served from overage when EITHER:
 *   1. `anthropic-ratelimit-unified-overage-in-use` is `true`, OR
 *   2. `anthropic-ratelimit-unified-status` is `rejected` AND
 *      `anthropic-ratelimit-unified-overage-status` is `allowed` or
 *      `allowed_warning`.
 * Nobody has captured these headers from an account actually in overage, so
 * the rule is unconfirmed. The tracker therefore also writes the raw values to
 * the trace (a `ratelimit_unified_state` session phase) at first observation
 * and whenever the observed combination changes, never per request, so the
 * first real overage confirms or refutes the rule.
 *
 * Attribution contract: the tracker holds the classification of the LATEST
 * response whose headers were observed. `takeForResponse()` hands that state to
 * the cost accrual for the response just streamed and clears it, so one header
 * observation is attributed to at most one response cost. Within one session
 * the model requests are sequential (one round at a time; SDK and connection
 * retries replace the latest observation with the response that actually
 * streamed), so the latest observation belongs to the response being accrued.
 *
 * Invariant: never throws. Every entry point is guarded; a broken observer must
 * not disturb the request path, the quota cache, or the status line.
 *
 * @module agent/providers/anthropic-direct/overage-tracker
 */

import type { TraceSink } from '../../trace/index.js';
import { emitSessionPhase } from '../../trace/emit.js';

const PREFIX = 'anthropic-ratelimit-unified-';
const H_STATUS = `${PREFIX}status`;
const H_OVERAGE_STATUS = `${PREFIX}overage-status`;
const H_OVERAGE_IN_USE = `${PREFIX}overage-in-use`;
const H_CLAIM = `${PREFIX}representative-claim`;

/** Longest header value kept in the trace evidence record. */
const EVIDENCE_VALUE_CAP = 64;

/** Raw header values kept as evidence (short strings; absent headers omitted). */
export interface OverageEvidence {
  status?: string;
  overageStatus?: string;
  overageInUse?: string;
  representativeClaim?: string;
}

/** Classification of one response's headers. */
export interface OverageClassification {
  /** True when the response carried any `anthropic-ratelimit-unified-*` header. */
  measured: boolean;
  /** True when the overage rule matched. Always false when `measured` is false. */
  overage: boolean;
  evidence: OverageEvidence;
}

function norm(v: string | null): string | undefined {
  if (v === null) return undefined;
  const t = v.trim();
  return t.length > 0 ? t.slice(0, EVIDENCE_VALUE_CAP) : undefined;
}

function hasUnifiedHeader(headers: Headers): boolean {
  let found = false;
  headers.forEach((_value, key) => {
    if (key.toLowerCase().startsWith(PREFIX)) found = true;
  });
  return found;
}

/**
 * Classify one response's headers with the Claude Code 2.1.319 rule. Header
 * names are matched case-insensitively (the `Headers` contract) and values are
 * compared case-insensitively after trimming; any other value is not overage.
 */
export function classifyOverage(headers: Headers): OverageClassification {
  const evidence: OverageEvidence = {};
  const status = norm(headers.get(H_STATUS));
  const overageStatus = norm(headers.get(H_OVERAGE_STATUS));
  const overageInUse = norm(headers.get(H_OVERAGE_IN_USE));
  const claim = norm(headers.get(H_CLAIM));
  if (status !== undefined) evidence.status = status;
  if (overageStatus !== undefined) evidence.overageStatus = overageStatus;
  if (overageInUse !== undefined) evidence.overageInUse = overageInUse;
  if (claim !== undefined) evidence.representativeClaim = claim;
  const measured = hasUnifiedHeader(headers);
  if (!measured) return { measured: false, overage: false, evidence };
  const os = overageStatus?.toLowerCase();
  const inUse = overageInUse?.toLowerCase() === 'true';
  const rejectedButAllowed =
    status?.toLowerCase() === 'rejected' && (os === 'allowed' || os === 'allowed_warning');
  return { measured: true, overage: inUse || rejectedButAllowed, evidence };
}

/** State handed to the cost accrual of one response. */
export interface ResponseOverageState {
  measured: boolean;
  overage: boolean;
}

function evidenceKey(c: OverageClassification): string {
  const e = c.evidence;
  return [e.status ?? '', e.overageStatus ?? '', e.overageInUse ?? '', e.representativeClaim ?? '', c.overage ? '1' : '0'].join('|');
}

/** Per-session overage observer. One instance per provider query (session). */
export class OverageTracker {
  private latest: ResponseOverageState | undefined;
  private lastEvidenceKey: string | undefined;

  constructor(private readonly writer?: TraceSink) {}

  /** Observe one response's headers. Never throws. */
  observe(headers: Headers): void {
    try {
      const c = classifyOverage(headers);
      if (!c.measured) {
        this.latest = undefined;
        return;
      }
      this.latest = { measured: true, overage: c.overage };
      const key = evidenceKey(c);
      if (key === this.lastEvidenceKey) return;
      this.lastEvidenceKey = key;
      if (this.writer === undefined) return;
      const metadata: Record<string, string | boolean> = { ...c.evidence, overage: c.overage };
      void emitSessionPhase(this.writer, { phase: 'ratelimit_unified_state', metadata }).catch(() => {});
    } catch {
      // Observability only: never disturb the request path.
    }
  }

  /**
   * Hand the latest observation to the cost accrual of the response just
   * streamed, then clear it. Undefined when no unified headers were observed
   * since the last take (API key session, missing headers, or already taken).
   */
  takeForResponse(): ResponseOverageState | undefined {
    const s = this.latest;
    this.latest = undefined;
    return s;
  }
}

/**
 * Stamp one response's overage fields onto its usage. Presence follows the
 * receipt contract: both fields appear (possibly 0) only when the response was
 * measured. A flagged response whose cost is unknown is counted as not flagged
 * (no guessed dollars).
 */
export function overageUsageFields(
  state: ResponseOverageState | undefined,
  costUsd: number | undefined,
): { overageCostUsd?: number; overageRequests?: number } {
  if (state === undefined || !state.measured) return {};
  const costKnown = typeof costUsd === 'number' && Number.isFinite(costUsd) && costUsd >= 0;
  if (state.overage && costKnown) return { overageCostUsd: costUsd, overageRequests: 1 };
  return { overageCostUsd: 0, overageRequests: 0 };
}
