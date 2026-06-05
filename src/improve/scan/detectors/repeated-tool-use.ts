/**
 * Detector: repeated identical tool calls.
 *
 * Surfaces tool-call loops — the same tool fired ≥N times consecutively
 * with the same fingerprint within one agent context (one subagent or the
 * root session).
 *
 * ## Fingerprint caveat
 *
 * The witness-layer `tool_call` event payload does NOT contain raw tool
 * arguments. From `src/agent/trace/types.ts:42–62` the available fields
 * are: `name`, `inputBytes`, `resultBytes`, `isError`, `truncated`,
 * `durationMs`, `toolUseId`, `subagentId?`. No `args` blob.
 *
 * Phase 1A therefore derives a **proxy fingerprint** — a SHA-256 over a
 * stable 5-tuple `(name, inputBytes, resultBytes, isError, subagentId)`.
 * Two unrelated calls with coincidentally identical byte counts would
 * collide; at the 4-repeat threshold this is vanishingly unlikely, and
 * the evidence emitted on every detection includes the `toolUseId`s and
 * `seq` indices so a reviewer can confirm. The field is named
 * `argsFingerprint` (not `argsHash`) to make the proxy honest in the
 * schema.
 *
 * A future detector version (`v2-with-args-hash`) will become available
 * once the runtime is enriched to emit a content hash at tool-call time.
 * The `detail.fingerprintAlgorithm` field on emitted cards makes that
 * migration painless.
 *
 * ## Pairing
 *
 * Each tool dispatch emits TWO trace events: `phase: 'started'` and
 * `phase: 'completed'`, sharing a `toolUseId`. The detector pairs them
 * on `toolUseId` to construct the fingerprint over both halves of the
 * dispatch. A call without its `completed` event (the session crashed
 * mid-call) is ignored — it cannot have repeated since it never finished.
 *
 * ## Grouping and "consecutive"
 *
 * Events are grouped by `agent context` — `subagentId` when present,
 * `'root'` otherwise. Within each context, completed tool calls are
 * scanned in `seq` order. A run of ≥4 identical fingerprints is flagged.
 * Other event kinds between two tool calls do NOT break the run; a
 * tool call with a different fingerprint DOES.
 *
 * @module improve/scan/detectors/repeated-tool-use
 */

import { createHash } from 'crypto';
import type { DetectorResult, FailureEvidence } from '../../schemas.js';
import type { ReaderEvent, SessionRead } from '../reader.js';

/** Minimum number of consecutive identical calls before a run is flagged. */
export const DEFAULT_MIN_REPEATS = 4;

/**
 * Hard cap on the number of evidence excerpts attached per detection. Higher
 * values bloat cards without adding signal — reviewers only need enough
 * lines to confirm the pattern. The total count is preserved separately on
 * `detail.runLength`.
 */
const MAX_EXCERPT_EVENTS_PER_FINDING = 8;

/** Algorithm tag stored on every emitted card for future migration. */
const FINGERPRINT_ALGORITHM = 'v1-bytes-tuple';

export interface RepeatedToolUseOptions {
  /** Override for the run-length threshold. Default {@link DEFAULT_MIN_REPEATS}. */
  minRepeats?: number;
}

/**
 * Run the detector over the reader's session output.
 *
 * Pure function — no I/O. Returns one {@link DetectorResult} per detected
 * run. A single session can produce multiple results if it contains
 * independent loops on different tools or different fingerprints.
 *
 * The slug is shared across sessions for the same `(toolName, fingerprint)`
 * pair, so re-detections of the SAME loop pattern in different sessions
 * merge into one card downstream.
 */
export function detectRepeatedToolUse(
  sessions: SessionRead[],
  options: RepeatedToolUseOptions = {},
): DetectorResult[] {
  const minRepeats = options.minRepeats ?? DEFAULT_MIN_REPEATS;
  if (minRepeats < 2) {
    throw new Error(`minRepeats must be >= 2 (got ${minRepeats})`);
  }

  const results: DetectorResult[] = [];
  for (const session of sessions) {
    const sessionResults = detectInSession(session, minRepeats);
    results.push(...sessionResults);
  }
  return results;
}

/**
 * Tag a tool-dispatch as a pair of (started, completed). Exported for the
 * unit test that asserts how unpaired events are handled.
 */
export interface ToolCallPair {
  toolUseId: string;
  /** The `seq` of the started event. */
  startedSeq: number;
  /** The `seq` of the completed event. */
  completedSeq: number;
  /** Line number of the completed event in the source trace.jsonl (1-based). */
  completedLineNumber: number;
  name: string;
  inputBytes: number;
  resultBytes: number;
  isError: boolean;
  subagentId: string | undefined;
  /** Verbatim JSON line of the completed event for evidence excerpts. */
  rawLine: string;
  fingerprint: string;
}

function detectInSession(
  session: SessionRead,
  minRepeats: number,
): DetectorResult[] {
  const pairs = pairToolCalls(session.events);
  const grouped = groupByContext(pairs);
  const findings: DetectorResult[] = [];

  for (const [contextKey, contextPairs] of grouped.entries()) {
    const runs = findConsecutiveRuns(contextPairs, minRepeats);
    for (const run of runs) {
      findings.push(buildResult(session, run, contextKey));
    }
  }
  return findings;
}

/**
 * Pair `started` and `completed` events on shared `toolUseId`. Unpaired
 * `started` events are dropped (the dispatch didn't complete within the
 * trace — covered by other detectors in future phases).
 */
export function pairToolCalls(events: ReaderEvent[]): ToolCallPair[] {
  const startedById = new Map<
    string,
    { seq: number; name: string; inputBytes: number; subagentId: string | undefined }
  >();
  const pairs: ToolCallPair[] = [];

  for (const item of events) {
    const ev = item.event;
    if (ev.kind !== 'tool_call') continue;
    if (ev.payload.phase === 'started') {
      startedById.set(ev.payload.toolUseId, {
        seq: ev.seq,
        name: ev.payload.name,
        inputBytes: ev.payload.inputBytes,
        subagentId: ev.payload.subagentId,
      });
      continue;
    }
    // completed
    const started = startedById.get(ev.payload.toolUseId);
    if (!started) continue; // mismatched / out-of-order; ignore
    startedById.delete(ev.payload.toolUseId);

    const fingerprint = computeFingerprint({
      name: ev.payload.name,
      inputBytes: started.inputBytes,
      resultBytes: ev.payload.resultBytes,
      isError: ev.payload.isError,
      subagentId: started.subagentId,
    });

    pairs.push({
      toolUseId: ev.payload.toolUseId,
      startedSeq: started.seq,
      completedSeq: ev.seq,
      completedLineNumber: item.lineNumber,
      name: ev.payload.name,
      inputBytes: started.inputBytes,
      resultBytes: ev.payload.resultBytes,
      isError: ev.payload.isError,
      subagentId: started.subagentId,
      rawLine: item.rawLine,
      fingerprint,
    });
  }

  // pairs are already in trace-`seq` order because the reader preserves
  // file order and `completed` always follows its `started`.
  return pairs;
}

/**
 * Bucket pairs by agent context — `subagentId` if set, else `'root'`.
 * Order within each bucket is preserved (insertion order matches `seq`).
 */
function groupByContext(pairs: ToolCallPair[]): Map<string, ToolCallPair[]> {
  const out = new Map<string, ToolCallPair[]>();
  for (const pair of pairs) {
    const key = pair.subagentId ?? 'root';
    const bucket = out.get(key);
    if (bucket) {
      bucket.push(pair);
    } else {
      out.set(key, [pair]);
    }
  }
  return out;
}

/**
 * Walk one context's pair sequence, return every maximal run of identical
 * fingerprints whose length is `>= minRepeats`. Maximal = no longer prefix
 * or suffix shares the same fingerprint.
 */
function findConsecutiveRuns(
  pairs: ToolCallPair[],
  minRepeats: number,
): ToolCallPair[][] {
  const runs: ToolCallPair[][] = [];
  let i = 0;
  while (i < pairs.length) {
    const current = pairs[i];
    if (!current) {
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < pairs.length) {
      const next = pairs[j];
      if (!next || next.fingerprint !== current.fingerprint) break;
      j += 1;
    }
    const runLength = j - i;
    if (runLength >= minRepeats) {
      runs.push(pairs.slice(i, j));
    }
    i = j > i ? j : i + 1;
  }
  return runs;
}

/**
 * Stable hash over the 5-tuple. The string form is part of the slug, so the
 * hash must be deterministic across runs and architectures. SHA-256 is
 * provided by `node:crypto`; no native deps.
 *
 * The `|` delimiter is safe because none of the inputs can contain it:
 * `inputBytes`/`resultBytes` are numbers, `isError` is bool, `subagentId`
 * is a UUID-shaped string when set.
 */
export function computeFingerprint(args: {
  name: string;
  inputBytes: number;
  resultBytes: number;
  isError: boolean;
  subagentId: string | undefined;
}): string {
  const tuple = [
    args.name,
    String(args.inputBytes),
    String(args.resultBytes),
    args.isError ? '1' : '0',
    args.subagentId ?? '',
  ].join('|');
  return createHash('sha256').update(tuple).digest('hex');
}

function buildResult(
  session: SessionRead,
  run: ToolCallPair[],
  contextKey: string,
): DetectorResult {
  const first = run[0];
  if (!first) {
    // Defensive — findConsecutiveRuns guarantees non-empty runs.
    throw new Error('repeated-tool-use: empty run');
  }
  const slug = makeSlug(first.name, first.fingerprint);
  const observedAt = new Date().toISOString();

  const excerpts = run.slice(0, MAX_EXCERPT_EVENTS_PER_FINDING);
  const evidence: FailureEvidence[] = [
    {
      sessionId: session.sessionId,
      tracePath: session.relativeTracePath,
      eventIndices: excerpts.map((p) => p.completedSeq),
      excerpt: buildExcerpt(excerpts),
      annotation: buildAnnotation(run, contextKey),
    },
  ];

  return {
    slug,
    title: buildTitle(first.name, run.length),
    pattern: 'repeated-tool-use',
    severity: severityFor(run.length),
    observedAt,
    evidence,
    detail: {
      detector: 'repeated-tool-use@v1',
      fingerprintAlgorithm: FINGERPRINT_ALGORITHM,
      fingerprint: first.fingerprint,
      toolName: first.name,
      runLength: run.length,
      agentContext: contextKey,
      inputBytes: first.inputBytes,
      resultBytes: first.resultBytes,
      isError: first.isError,
      toolUseIds: run.map((p) => p.toolUseId),
      completedSeqs: run.map((p) => p.completedSeq),
    },
  };
}

function buildExcerpt(pairs: ToolCallPair[]): string {
  // Join raw lines with newlines so the JSON remains line-parseable when
  // pasted back. Cap at 2 KB to satisfy the schema's excerpt max.
  const joined = pairs.map((p) => p.rawLine).join('\n');
  if (joined.length <= 2000) return joined;
  return joined.slice(0, 1997) + '...';
}

function buildAnnotation(pairs: ToolCallPair[], contextKey: string): string {
  const first = pairs[0];
  const last = pairs[pairs.length - 1];
  if (!first || !last) return '';
  return [
    `${pairs.length}× consecutive '${first.name}' calls in ${contextKey} context`,
    `(seq ${first.completedSeq}…${last.completedSeq},`,
    `inputBytes=${first.inputBytes}, resultBytes=${first.resultBytes},`,
    `isError=${first.isError})`,
  ].join(' ');
}

function buildTitle(toolName: string, runLength: number): string {
  return `'${toolName}' tool repeated ${runLength}× with identical fingerprint`;
}

/**
 * Severity ladder. Conservative for MVP: most loops are medium-cost waste,
 * very long loops (≥10) indicate something is structurally broken.
 */
function severityFor(runLength: number): 'low' | 'medium' | 'high' {
  if (runLength >= 10) return 'high';
  if (runLength >= 4) return 'medium';
  return 'low';
}

/**
 * Slugs are stable across sessions so re-detection of the SAME loop merges
 * into one card. They embed the tool name (for legibility) plus the first
 * 12 hex chars of the fingerprint (for uniqueness across distinct loops on
 * the same tool).
 *
 * Tool names are lowercased and sanitized to `[a-z0-9-]` so the slug
 * passes the regex on FailureCardSchema.
 */
export function makeSlug(toolName: string, fingerprint: string): string {
  const safeName = toolName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const shortHash = fingerprint.slice(0, 12);
  const namePart = safeName.length > 0 ? safeName : 'tool';
  return `repeated-tool-${namePart}-${shortHash}`;
}
