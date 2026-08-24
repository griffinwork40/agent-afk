/**
 * Detector: recurring forked sub-agent READ auto-denials.
 *
 * The path-approval `PreToolUse` hook auto-denies a forked child's file read
 * when the resolved path falls outside the fork's granted READ roots — a fork
 * cannot prompt a human to approve, so the hook hard-blocks with
 * `decision: 'block'`, `blockedTool ∈ {read_file, grep, glob, …}`, and a
 * `reason` beginning "Sub-agent path access denied: <path> is outside …". The
 * child then retries the read and spins until a wall-clock timeout.
 *
 * Invariant: this detector flags ONLY read-family denials. A WRITE auto-deny
 * (write_file / edit_file / mutating bash outside the worktree) is BY DESIGN —
 * worktree isolation confines writes and reports back to the parent — so
 * folding writes in here would drown the real signal in expected noise.
 *
 * Why a distinct detector from `subagent-block`: that one flags a subagent
 * DISPATCH refused before it ran (`hookEvent: 'SubagentStart'`); this flags a
 * RUNNING fork whose read was refused (`hookEvent: 'PreToolUse'`). Different
 * lifecycle stage, different remediation — so a distinct card pattern.
 *
 * ## Fingerprint
 *
 * Stable SHA-256 over `(hookEvent | normalizedReason)`. The reason is
 * NORMALIZED (absolute paths → `<path>`) before hashing because the denial
 * message embeds the specific offending path, which varies per denial; without
 * normalization each path would split into its own card and the class ("this
 * fork keeps failing to read") would never aggregate. `blockedTool` is
 * deliberately NOT in the fingerprint — a read_file / grep / glob denial of the
 * same structural cause is one pattern, not three; the distinct tools are
 * recorded in `detail.blockedTools` instead.
 *
 * @module improve/scan/detectors/subagent-read-denial
 */

import { createHash } from 'crypto';
import type { DetectorResult, FailureEvidence, Severity } from '../../schemas.js';
import type { SessionRead } from '../reader.js';
import {
  READ_DENYLIST_ENTRY_MARKER,
  PROTECTED_CREDENTIAL_PATH_MARKER,
} from '../../../agent/tools/handlers/read-denylist.js';

/** Default minimum read-denials sharing a normalized reason before a card fires. */
export const DEFAULT_SUBAGENT_READ_DENIAL_MIN_OCCURRENCES = 2;

const FINGERPRINT_ALGORITHM = 'v1-pretooluse-read-normreason';
const MAX_EVIDENCE_PER_CARD = 8;

/**
 * Read-family tool names whose PreToolUse block is a pathological read-scope
 * denial. Both afk-native (lowercase) and Claude-style (capitalized) names are
 * included so the detector is robust across surfaces. WRITE / mutating tools
 * are intentionally absent — their denial is by-design worktree confinement.
 */
const READ_TOOL_NAMES: ReadonlySet<string> = new Set([
  'read_file',
  'grep',
  'glob',
  'list_directory',
  'Read',
  'Grep',
  'Glob',
  'LS',
  'NotebookRead',
]);

/**
 * Invariant: several DIFFERENT mechanisms surface as `PreToolUse` read blocks,
 * and only one of them is ever a defect.
 *
 *   - `read-root-containment` — the resolved path fell outside the fork's
 *     granted read roots. A fork cannot prompt a human, so the hook hard-blocks
 *     (`path-approval-hook.ts`, the confinement branch). This CAN be a real
 *     scope gap worth a card.
 *   - `credential-floor` — the unconditional read-denylist floor refusing a
 *     credential path (`~/.afk/config/afk.env`, `mcp.json`, `~/.ssh`, …) via
 *     `isReadDenied` / `BUILTIN_READ_DENYLIST`. This is the guardrail working
 *     exactly as designed and no read-scope widening should ever make it stop
 *     firing.
 *   - `unclassified` — a real PreToolUse/block on a read-family tool whose
 *     reason matches neither positive marker below. A human declining an
 *     interactive prompt (`path-approval-hook.ts`'s `User denied access to
 *     <path>`) and a tool-allowlist refusal (`permissions.ts`'s `Tool "<x>" is
 *     not in the configured allowlist`) both land here — neither's remedy is
 *     "widen read roots", so mislabeling either as containment sends a triager
 *     toward a fix that cannot work.
 *
 * Conflating the floor with containment manufactured a card
 * (`subagent-read-denial-cf21041f85be`, open/high, N=9) whose every evidence
 * row was the credential floor doing its job — and, worse, made that noise
 * indistinguishable from the genuine agent-framework scope gap it sat next to.
 * Floor denials are therefore dropped before fingerprinting: they never reach
 * a bucket, so they can never merge into or inflate a containment card.
 * `unclassified` denials are NOT dropped — they still fingerprint and count
 * exactly as containment did before this split; only the label changes, from
 * a false positive assertion to an honest "don't know".
 */
export type DenialMechanism = 'read-root-containment' | 'credential-floor' | 'unclassified';

/**
 * Contract: classify from the deny reason alone — the trace carries no explicit
 * mechanism field. Detection is POSITIVE for both non-default outcomes; a
 * reason matching neither marker is `unclassified` rather than assumed to be
 * containment.
 *
 * The floor's message is machine-generated in one place and embeds the literal
 * marker `read-denylist entry:` plus a protected-path phrase. Containment is
 * matched on two wordings: `Sub-agent path access denied:` — the current
 * prefix, documented load-bearing at `path-approval-hook.ts:301` — and the
 * legacy `Sub-agents cannot access paths outside the session's granted roots`,
 * which still appears on cards written before the reword. Matching markers is
 * stable against the path itself varying (and against path normalization,
 * which rewrites paths but not this prose).
 */
export function classifyDenialMechanism(reason: string): DenialMechanism {
  const isFloor =
    reason.includes(READ_DENYLIST_ENTRY_MARKER) ||
    reason.includes(PROTECTED_CREDENTIAL_PATH_MARKER);
  if (isFloor) return 'credential-floor';

  const isContainment =
    reason.includes('Sub-agent path access denied:') ||
    reason.includes("Sub-agents cannot access paths outside the session's granted roots");
  if (isContainment) return 'read-root-containment';

  return 'unclassified';
}

export interface SubagentReadDenialOptions {
  minOccurrences?: number;
}

interface DenialSighting {
  sessionId: string;
  relativeTracePath: string;
  seq: number;
  rawLine: string;
  reason: string;
  normalizedReason: string;
  blockedTool: string;
  mechanism: DenialMechanism;
}

/**
 * Collapse absolute filesystem paths in a denial reason to `<path>` so
 * structurally-identical denials aggregate. Matches a leading `/` followed by
 * path characters — `/Users/x/foo.ts`, `/tmp`, `~/.afk/state/x.diff` (the
 * `~`-relative form is also normalized). Conservative character class avoids
 * eating ordinary prose.
 */
export function normalizeReason(reason: string): string {
  return reason.replace(/~?\/[\w.\-/]+/g, '<path>');
}

/**
 * Run the detector. Pure function — no I/O. One {@link DetectorResult} per
 * distinct normalized-reason fingerprint that meets the threshold.
 */
export function detectSubagentReadDenial(
  sessions: SessionRead[],
  options: SubagentReadDenialOptions = {},
): DetectorResult[] {
  const minOccurrences =
    options.minOccurrences ?? DEFAULT_SUBAGENT_READ_DENIAL_MIN_OCCURRENCES;
  if (minOccurrences < 1) {
    throw new Error(`minOccurrences must be >= 1 (got ${minOccurrences})`);
  }

  const byFingerprint = new Map<string, DenialSighting[]>();

  for (const session of sessions) {
    for (const item of session.events) {
      const ev = item.event;
      if (ev.kind !== 'hook_decision') continue;
      if (ev.payload.hookEvent !== 'PreToolUse') continue;
      if (ev.payload.decision !== 'block') continue;
      const blockedTool = ev.payload.blockedTool;
      if (blockedTool === undefined || !READ_TOOL_NAMES.has(blockedTool)) continue;

      const reason = ev.payload.reason ?? '';
      // The credential floor is by-design, never a defect — drop it before it
      // can reach a fingerprint bucket. See DenialMechanism. Every other
      // mechanism, `unclassified` included, is kept and labelled honestly.
      const mechanism = classifyDenialMechanism(reason);
      if (mechanism === 'credential-floor') continue;
      const normalizedReason = normalizeReason(reason);
      const fingerprint = computeFingerprint({ hookEvent: ev.payload.hookEvent, normalizedReason });

      const sighting: DenialSighting = {
        sessionId: session.sessionId,
        relativeTracePath: session.relativeTracePath,
        seq: ev.seq,
        rawLine: item.rawLine,
        reason,
        normalizedReason,
        blockedTool,
        mechanism,
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
 * Stable hash over the `(hookEvent, normalizedReason)` tuple. Exported for
 * tests asserting slug stability across detector runs.
 */
export function computeFingerprint(args: { hookEvent: string; normalizedReason: string }): string {
  const tuple = [args.hookEvent, args.normalizedReason].join('|');
  return createHash('sha256').update(tuple).digest('hex');
}

/** Slug pattern: `subagent-read-denial-<first 12 hex of fingerprint>`. */
export function makeSlug(fingerprint: string): string {
  return `subagent-read-denial-${fingerprint.slice(0, 12)}`;
}

function buildResult(fingerprint: string, sightings: DenialSighting[]): DetectorResult {
  const first = sightings[0];
  if (!first) {
    throw new Error('subagent-read-denial: empty sighting bucket');
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
  const blockedTools = [...new Set(sightings.map((s) => s.blockedTool))].sort();

  return {
    slug,
    title: buildTitle(sightings.length, distinctSessions),
    pattern: 'subagent-read-denial',
    severity: severityFor(sightings.length, distinctSessions),
    observedAt,
    evidence,
    detail: {
      // @v2: credential-floor denials are dropped before fingerprinting, so
      // `denialCount` / `distinctSessions` no longer include them, and
      // `denialMechanism` is now observed per sighting rather than assumed. The
      // version bump lets `reconcileSeverity` re-derive a card whose v1 severity
      // was computed from floor-inflated counts — under escalate-only it could
      // never come back down.
      detector: 'subagent-read-denial@v2',
      fingerprintAlgorithm: FINGERPRINT_ALGORITHM,
      fingerprint,
      hookEvent: 'PreToolUse',
      // Contract: read from the first sighting, not asserted as a literal. The
      // fingerprint tuple is (hookEvent, normalizedReason) and the mechanism is
      // a pure function of the reason, so every sighting in this bucket
      // classifies identically — the first is representative of all of them.
      // The tuple itself is unchanged, so pre-existing containment card slugs
      // keep their identity across this change.
      denialMechanism: first.mechanism,
      normalizedReason: first.normalizedReason,
      reason: first.reason,
      blockedTools,
      denialCount: sightings.length,
      distinctSessions,
      sessionIds: [...new Set(sightings.map((s) => s.sessionId))],
      seqs: sightings.map((s) => s.seq),
    },
  };
}

/**
 * Severity ladder (mirrors subagent-block):
 *   - ≥6 denials OR ≥3 distinct sessions → high.
 *   - ≥3 denials → medium.
 *   - else → low.
 */
function severityFor(denialCount: number, distinctSessions: number): Severity {
  if (denialCount >= 6 || distinctSessions >= 3) return 'high';
  if (denialCount >= 3) return 'medium';
  return 'low';
}

function buildTitle(count: number, sessions: number): string {
  return `Forked sub-agent read auto-denied ${count}× across ${sessions} session${sessions === 1 ? '' : 's'} (path outside granted read roots)`;
}

function buildAnnotation(s: DenialSighting): string {
  const parts = [`seq ${s.seq}`, `blockedTool=${s.blockedTool}`];
  if (s.reason) parts.push(`reason="${s.reason.slice(0, 200)}"`);
  return parts.join(' · ');
}

function clampExcerpt(rawLine: string): string {
  if (rawLine.length <= 2000) return rawLine;
  return rawLine.slice(0, 1997) + '...';
}
