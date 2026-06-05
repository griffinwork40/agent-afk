/**
 * Detector: recurring `SubagentStart` hook blocks.
 *
 * The runtime emits a `hook_decision` event when any registered hook
 * returns a decision; the witness payload (`src/agent/trace/types.ts:80`)
 * carries `hookEvent`, `decision`, `reason?`, `blockedTool?`, and
 * `injectedContextBytes?`. When `hookEvent === 'SubagentStart'` and
 * `decision === 'block'`, a subagent dispatch was refused before it ran.
 *
 * We aggregate by the `reason` string: same reason → same card. A single
 * block is a low-noise signal; the same reason recurring across sessions
 * is the actionable case (a guard is repeatedly tripping on the same
 * pattern of subagent dispatch).
 *
 * ## Fingerprint
 *
 * Stable SHA-256 over `(hookEvent | reason ?? '' | blockedTool ?? '')`.
 *
 *   - `hookEvent` is always `'SubagentStart'` for cards emitted by this
 *     detector (it filters on that), but is included for forward
 *     compatibility with future hook-block detectors.
 *   - `blockedTool` is only set by `PreToolUse` blocks per the schema's
 *     own JSDoc (`src/agent/trace/types.ts:85–86`), so it will be empty
 *     for SubagentStart events. Included so the fingerprint stays stable
 *     if the runtime ever extends the field.
 *   - `reason` is the actual discriminator. Two blocks with the same
 *     reason text get the same fingerprint regardless of which session.
 *
 * The slug embeds the first 12 hex chars of the fingerprint.
 *
 * ## Why not also include `injectedContextBytes`?
 *
 * It's not a stable identity for the pattern — the byte count varies
 * per-session even when the underlying block reason is the same. Folding
 * it into the fingerprint would split one logical pattern into many cards.
 *
 * ## What this detector does NOT detect
 *
 * The witness `hook_decision` payload does not include a `subagentId`
 * field, and there is no "user retried after block" event in the trace
 * schema. We deliberately do not infer retries; the design doc described
 * retry-correlation as future work. The clean schema-grounded signal is
 * "this block keeps happening" — which is what this detector reports.
 *
 * @module improve/scan/detectors/subagent-block
 */

import { createHash } from 'crypto';
import type { DetectorResult, FailureEvidence, Severity } from '../../schemas.js';
import type { SessionRead } from '../reader.js';

/** Default minimum block occurrences sharing a reason before a card fires. */
export const DEFAULT_SUBAGENT_BLOCK_MIN_OCCURRENCES = 2;

const FINGERPRINT_ALGORITHM = 'v1-hook-reason-tuple';
const MAX_EVIDENCE_PER_CARD = 8;

export interface SubagentBlockOptions {
  minOccurrences?: number;
}

interface BlockSighting {
  sessionId: string;
  relativeTracePath: string;
  seq: number;
  rawLine: string;
  reason: string;
  blockedTool: string | undefined;
  injectedContextBytes: number | undefined;
}

/**
 * Run the detector. Pure function — no I/O.
 *
 * One {@link DetectorResult} per distinct block-reason fingerprint that
 * meets the threshold. Multiple sessions with the same reason merge
 * downstream into one card via the standard slug-keyed merge.
 */
export function detectSubagentBlock(
  sessions: SessionRead[],
  options: SubagentBlockOptions = {},
): DetectorResult[] {
  const minOccurrences =
    options.minOccurrences ?? DEFAULT_SUBAGENT_BLOCK_MIN_OCCURRENCES;
  if (minOccurrences < 1) {
    throw new Error(`minOccurrences must be >= 1 (got ${minOccurrences})`);
  }

  // Bucket by fingerprint.
  const byFingerprint = new Map<string, BlockSighting[]>();

  for (const session of sessions) {
    for (const item of session.events) {
      const ev = item.event;
      if (ev.kind !== 'hook_decision') continue;
      if (ev.payload.hookEvent !== 'SubagentStart') continue;
      if (ev.payload.decision !== 'block') continue;

      const reason = ev.payload.reason ?? '';
      const blockedTool = ev.payload.blockedTool;
      const fingerprint = computeFingerprint({
        hookEvent: ev.payload.hookEvent,
        reason,
        blockedTool,
      });

      const sighting: BlockSighting = {
        sessionId: session.sessionId,
        relativeTracePath: session.relativeTracePath,
        seq: ev.seq,
        rawLine: item.rawLine,
        reason,
        blockedTool,
        injectedContextBytes: ev.payload.injectedContextBytes,
      };

      const bucket = byFingerprint.get(fingerprint);
      if (bucket) {
        bucket.push(sighting);
      } else {
        byFingerprint.set(fingerprint, [sighting]);
      }
    }
  }

  const results: DetectorResult[] = [];
  for (const [fingerprint, sightings] of byFingerprint.entries()) {
    if (sightings.length < minOccurrences) continue;
    results.push(buildResult(fingerprint, sightings));
  }
  return results;
}

/**
 * Stable hash over the `(hookEvent, reason, blockedTool)` tuple. Exported
 * for tests that need to assert slug stability across detector runs.
 */
export function computeFingerprint(args: {
  hookEvent: string;
  reason: string;
  blockedTool: string | undefined;
}): string {
  const tuple = [args.hookEvent, args.reason, args.blockedTool ?? ''].join('|');
  return createHash('sha256').update(tuple).digest('hex');
}

/**
 * Slug pattern: `subagent-block-<first 12 hex of fingerprint>`. Stable
 * across sessions, which is the whole point — re-detection in another
 * session merges into one card.
 */
export function makeSlug(fingerprint: string): string {
  return `subagent-block-${fingerprint.slice(0, 12)}`;
}

function buildResult(fingerprint: string, sightings: BlockSighting[]): DetectorResult {
  const first = sightings[0];
  if (!first) {
    // Defensive; the registry guarantees non-empty.
    throw new Error('subagent-block: empty sighting bucket');
  }
  const slug = makeSlug(fingerprint);
  const observedAt = new Date().toISOString();

  const capped = sightings.slice(0, MAX_EVIDENCE_PER_CARD);
  const evidence: FailureEvidence[] = capped.map((s) => ({
    sessionId: s.sessionId,
    tracePath: s.relativeTracePath,
    eventIndices: [s.seq],
    excerpt: clampExcerpt(s.rawLine),
    annotation: buildAnnotation(s),
  }));

  const distinctSessions = new Set(sightings.map((s) => s.sessionId)).size;

  return {
    slug,
    title: buildTitle(first.reason, sightings.length, distinctSessions),
    pattern: 'subagent-block',
    severity: severityFor(sightings.length, distinctSessions),
    observedAt,
    evidence,
    detail: {
      detector: 'subagent-block@v1',
      fingerprintAlgorithm: FINGERPRINT_ALGORITHM,
      fingerprint,
      hookEvent: 'SubagentStart',
      reason: first.reason,
      blockedTool: first.blockedTool ?? null,
      blockCount: sightings.length,
      distinctSessions,
      sessionIds: sightings.map((s) => s.sessionId),
      seqs: sightings.map((s) => s.seq),
    },
  };
}

/**
 * Severity ladder.
 *
 *   - ≥6 blocks OR ≥3 distinct sessions → high.
 *   - ≥3 blocks → medium.
 *   - else → low.
 */
function severityFor(blockCount: number, distinctSessions: number): Severity {
  if (blockCount >= 6 || distinctSessions >= 3) return 'high';
  if (blockCount >= 3) return 'medium';
  return 'low';
}

function buildTitle(reason: string, count: number, sessions: number): string {
  const reasonExcerpt = reason.length > 80 ? reason.slice(0, 77) + '...' : reason;
  const reasonPart = reasonExcerpt.length > 0 ? `: "${reasonExcerpt}"` : '';
  return `SubagentStart hook blocked ${count}× across ${sessions} session${sessions === 1 ? '' : 's'}${reasonPart}`;
}

function buildAnnotation(s: BlockSighting): string {
  const parts = [`seq ${s.seq}`];
  if (s.reason) parts.push(`reason="${s.reason.slice(0, 200)}"`);
  if (s.blockedTool) parts.push(`blockedTool=${s.blockedTool}`);
  if (typeof s.injectedContextBytes === 'number') {
    parts.push(`injectedContextBytes=${s.injectedContextBytes}`);
  }
  return parts.join(' · ');
}

function clampExcerpt(rawLine: string): string {
  if (rawLine.length <= 2000) return rawLine;
  return rawLine.slice(0, 1997) + '...';
}
