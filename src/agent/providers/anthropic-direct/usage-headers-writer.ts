/**
 * Per-turn writer for the last-seen unified rate-limit header snapshot.
 *
 * After each turn that received at least one Anthropic OAuth response carrying
 * `anthropic-ratelimit-unified-*` headers, writes the last-seen values to
 * `~/.afk/state/usage-headers.json` (mode 0600) atomically (temp + rename).
 * One write per turn at most. Only for OAuth responses; API-key, Bedrock, and
 * Vertex sessions never write the file.
 *
 * # Schema
 *
 * ```json
 * {
 *   "updatedAt": "2026-11-16T20:00:00.000Z",
 *   "accountId": "<parseAccountIdentifier result>",
 *   "status": "allowed_warning",
 *   "reset": 1731801600,
 *   "representativeClaim": "5h",
 *   "fiveHour": { "status": "allowed", "reset": 1731801600, "utilization": 0.82 },
 *   "sevenDay": { "status": "allowed_warning", "reset": 1732060800, "utilization": 0.45 },
 *   "overage": { "inUse": false }
 * }
 * ```
 *
 * Fields whose headers were absent are omitted. `reset` and
 * `representativeClaim` are top-level aliases for the dominant window's
 * reset epoch-seconds and the `anthropic-ratelimit-unified-representative-claim`
 * header value, matching the shape the closed-router consumer expects.
 *
 * # Invariants
 *
 * - Never throws: every entry point is wrapped in try/catch. A broken writer
 *   must not disturb the request path.
 * - One write per turn: `UsageHeadersTurnWriter.flush()` is idempotent; only
 *   the first flush in a turn writes (subsequent calls are no-ops).
 * - Only OAuth: `setUpUsageHeadersTurnWriter` returns `undefined` for non-OAuth
 *   auth modes, so callers never see a writer for API-key / Bedrock / Vertex.
 *
 * @module agent/providers/anthropic-direct/usage-headers-writer
 */

import { atomicWriteFile } from '../../../utils/atomic-write.js';
import { getUsageHeadersPath } from '../../../paths.js';
import { parseAccountIdentifier } from '../../auth/keychain.js';

const PREFIX = 'anthropic-ratelimit-unified-';
const H_STATUS = `${PREFIX}status`;
const H_REPRESENTATIVE_CLAIM = `${PREFIX}representative-claim`;
const H_5H_STATUS = `${PREFIX}5h-status`;
const H_5H_RESET = `${PREFIX}5h-reset`;
const H_5H_UTILIZATION = `${PREFIX}5h-utilization`;
const H_7D_STATUS = `${PREFIX}7d-status`;
const H_7D_RESET = `${PREFIX}7d-reset`;
const H_7D_UTILIZATION = `${PREFIX}7d-utilization`;
const H_OVERAGE_IN_USE = `${PREFIX}overage-in-use`;

/** Clamp to [0,1]. */
function parseUtilization(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(1, Math.max(0, n));
}

/** Epoch-seconds, or undefined when absent/invalid. */
function parseResetSecs(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}

/** First comma-separated token, trimmed and lower-cased. */
function norm(raw: string | null): string | undefined {
  if (raw === null) return undefined;
  const t = (raw.split(',')[0] ?? '').trim().toLowerCase();
  return t.length > 0 ? t : undefined;
}

export interface WindowRecord {
  status?: string;
  reset?: number;
  utilization?: number;
}

export interface OverageRecord {
  inUse: boolean;
}

/** Shape written to `usage-headers.json`. All optional fields may be absent. */
export interface UsageHeadersRecord {
  updatedAt: string;
  accountId: string;
  status?: string;
  reset?: number;
  representativeClaim?: string;
  fiveHour?: WindowRecord;
  sevenDay?: WindowRecord;
  overage?: OverageRecord;
}

/**
 * Parse the full set of unified rate-limit headers from one response.
 * Returns `undefined` when no unified header is present.
 * Never throws.
 */
export function parseUnifiedHeaders(headers: Headers): Omit<UsageHeadersRecord, 'updatedAt' | 'accountId'> | undefined {
  try {
    // Detect presence of ANY unified header.
    let found = false;
    headers.forEach((_v, k) => {
      if (k.toLowerCase().startsWith(PREFIX)) found = true;
    });
    if (!found) return undefined;

    const status = norm(headers.get(H_STATUS));
    const representativeClaim = norm(headers.get(H_REPRESENTATIVE_CLAIM));

    const fiveHourStatus = norm(headers.get(H_5H_STATUS));
    const fiveHourReset = parseResetSecs(headers.get(H_5H_RESET));
    const fiveHourUtilization = parseUtilization(headers.get(H_5H_UTILIZATION));

    const sevenDayStatus = norm(headers.get(H_7D_STATUS));
    const sevenDayReset = parseResetSecs(headers.get(H_7D_RESET));
    const sevenDayUtilization = parseUtilization(headers.get(H_7D_UTILIZATION));

    const overageInUseRaw = norm(headers.get(H_OVERAGE_IN_USE));

    const fiveHour: WindowRecord | undefined =
      fiveHourStatus !== undefined || fiveHourReset !== undefined || fiveHourUtilization !== undefined
        ? {
            ...(fiveHourStatus !== undefined ? { status: fiveHourStatus } : {}),
            ...(fiveHourReset !== undefined ? { reset: fiveHourReset } : {}),
            ...(fiveHourUtilization !== undefined ? { utilization: fiveHourUtilization } : {}),
          }
        : undefined;

    const sevenDay: WindowRecord | undefined =
      sevenDayStatus !== undefined || sevenDayReset !== undefined || sevenDayUtilization !== undefined
        ? {
            ...(sevenDayStatus !== undefined ? { status: sevenDayStatus } : {}),
            ...(sevenDayReset !== undefined ? { reset: sevenDayReset } : {}),
            ...(sevenDayUtilization !== undefined ? { utilization: sevenDayUtilization } : {}),
          }
        : undefined;

    const overage: OverageRecord | undefined =
      overageInUseRaw !== undefined ? { inUse: overageInUseRaw === 'true' } : undefined;

    // Top-level `reset`: prefer the dominant window (5h if present, else 7d).
    const reset = fiveHourReset ?? sevenDayReset;

    return {
      ...(status !== undefined ? { status } : {}),
      ...(reset !== undefined ? { reset } : {}),
      ...(representativeClaim !== undefined ? { representativeClaim } : {}),
      ...(fiveHour !== undefined ? { fiveHour } : {}),
      ...(sevenDay !== undefined ? { sevenDay } : {}),
      ...(overage !== undefined ? { overage } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Per-turn stateful writer. Collects the last header parse seen during a turn;
 * `flush()` atomically writes it once and becomes a no-op for subsequent
 * calls.
 *
 * Invariant: never throws — all entry points are guarded with try/catch so a
 * broken writer cannot disturb the request path.
 */
export class UsageHeadersTurnWriter {
  private latest: ReturnType<typeof parseUnifiedHeaders> | undefined;
  private flushed = false;

  constructor(
    private readonly accountId: string,
    /** Injectable for tests. */
    private readonly destPath: string = getUsageHeadersPath(),
  ) {}

  /**
   * Observe one response's headers. The last call before `flush()` wins.
   * Never throws.
   */
  observe(headers: Headers): void {
    try {
      const parsed = parseUnifiedHeaders(headers);
      if (parsed !== undefined) this.latest = parsed;
    } catch {
      // Observability only.
    }
  }

  /**
   * Write the last-seen snapshot atomically. No-op when:
   *   - no unified headers were seen this turn, or
   *   - already flushed this turn.
   * Never throws.
   */
  flush(): void {
    if (this.flushed) return;
    if (this.latest === undefined) return;
    this.flushed = true;
    try {
      const record: UsageHeadersRecord = {
        updatedAt: new Date().toISOString(),
        accountId: this.accountId,
        ...this.latest,
      };
      atomicWriteFile(this.destPath, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
    } catch {
      // Best-effort: a failed write must not disturb the session.
    }
  }
}

/**
 * Factory: create a `UsageHeadersTurnWriter` for OAuth sessions only.
 *
 * Returns `undefined` for non-OAuth auth modes (API key, Bedrock, Vertex) so
 * callers never accidentally write the file for non-subscription sessions.
 *
 * @param authMode  - Session auth mode.
 * @param clientToken - The OAuth token the live client was built with; passed
 *   to `parseAccountIdentifier` to populate `accountId`. Pass `undefined` for
 *   API-key sessions (the guard above makes this unreachable in practice).
 */
export function setUpUsageHeadersTurnWriter(
  authMode: string,
  clientToken: string | undefined,
): UsageHeadersTurnWriter | undefined {
  if (authMode !== 'oauth') return undefined;
  const accountId = parseAccountIdentifier(clientToken ?? '');
  return new UsageHeadersTurnWriter(accountId);
}
