/**
 * Subagent-block validation contract for `afk improve eval-run`.
 *
 * Implements the guardrail-presence check for the `subagent-block` detector
 * pattern. Extracted from `contracts.ts` to keep each file under the 350
 * code-line ceiling.
 *
 * ## What this contract validates
 *
 * The `subagent-block` detector fires on `hook_decision` events with
 * `hookEvent:'SubagentStart'` + `decision:'block'`
 * (src/improve/scan/detectors/subagent-block.ts). This contract exercises the
 * real {@link detectSubagentBlock} function against a synthetic
 * {@link SessionRead} corpus to prove:
 *
 *   - recurring SubagentStart blocks across sessions emit a card once the
 *     min-occurrences threshold is met;
 *   - `PreToolUse` blocks with the same `decision:'block'` are excluded;
 *   - a single sighting below the threshold produces no card.
 *
 * This replaces the prior mismapped contract that validated
 * `buildSkillMaxDepthRefusal` — a skill-executor depth gate that fires on a
 * completely different code path the detector never observes.
 *
 * @module improve/eval-run/contracts.sab
 */

import {
  DEFAULT_SUBAGENT_BLOCK_MIN_OCCURRENCES,
  detectSubagentBlock,
} from '../scan/detectors/subagent-block.js';
import type { ReaderEvent, SessionRead } from '../scan/reader.js';
import type { EvalCheck, EvalRunEvidenceRef } from '../schemas.js';
import { makeCheck, type ContractProbeResult } from './contracts.types.js';

// ---------------------------------------------------------------------------
// Synthetic corpus builder
// ---------------------------------------------------------------------------

const FAKE_TRACE_PATH = '/fake/trace.jsonl';
const FAKE_TS = '2026-01-01T00:00:00.000Z';

function makeSubagentBlockEvent(seq: number, sessionId: string, reason: string): ReaderEvent {
  return {
    sessionId,
    tracePath: FAKE_TRACE_PATH,
    relativeTracePath: `state/witness/${sessionId}/trace.jsonl`,
    lineNumber: seq + 1,
    rawLine: JSON.stringify({ ts: FAKE_TS, seq, kind: 'hook_decision', payload: { hookEvent: 'SubagentStart', decision: 'block', reason } }),
    event: {
      ts: FAKE_TS,
      seq,
      kind: 'hook_decision',
      payload: { hookEvent: 'SubagentStart', decision: 'block', reason },
    },
  };
}

function makePreToolUseBlockEvent(seq: number, sessionId: string): ReaderEvent {
  return {
    sessionId,
    tracePath: FAKE_TRACE_PATH,
    relativeTracePath: `state/witness/${sessionId}/trace.jsonl`,
    lineNumber: seq + 1,
    rawLine: JSON.stringify({ ts: FAKE_TS, seq, kind: 'hook_decision', payload: { hookEvent: 'PreToolUse', decision: 'block', reason: 'tool-policy', blockedTool: 'bash' } }),
    event: {
      ts: FAKE_TS,
      seq,
      kind: 'hook_decision',
      payload: { hookEvent: 'PreToolUse', decision: 'block', reason: 'tool-policy', blockedTool: 'bash' },
    },
  };
}

function makeSessionRead(sessionId: string, events: ReaderEvent[]): SessionRead {
  return {
    sessionId,
    tracePath: FAKE_TRACE_PATH,
    relativeTracePath: `state/witness/${sessionId}/trace.jsonl`,
    sessionMtimeMs: 0,
    events,
    invalidLineCount: 0,
  };
}

/**
 * Build a synthetic {@link SessionRead} corpus that exercises
 * {@link detectSubagentBlock}:
 *
 *   - Session A: 2 SubagentStart blocks with the same reason + 1 PreToolUse
 *     block (must be excluded).
 *   - Session B: 1 SubagentStart block with the same reason.
 *
 * Total SubagentStart blocks: 3 across 2 sessions → one card expected.
 */
export function buildSubagentBlockCorpus(): SessionRead[] {
  const sharedReason = 'max-depth-subagent-policy';
  return [
    makeSessionRead('sab-sess-a', [
      makeSubagentBlockEvent(0, 'sab-sess-a', sharedReason),
      makeSubagentBlockEvent(1, 'sab-sess-a', sharedReason),
      makePreToolUseBlockEvent(2, 'sab-sess-a'),
    ]),
    makeSessionRead('sab-sess-b', [
      makeSubagentBlockEvent(0, 'sab-sess-b', sharedReason),
    ]),
  ];
}

// ---------------------------------------------------------------------------
// Contract probe
// ---------------------------------------------------------------------------

/**
 * Exercise the real {@link detectSubagentBlock} detector against a synthetic
 * corpus. Validates the guardrail the `subagent-block` pattern maps to:
 * `hook_decision { hookEvent:'SubagentStart', decision:'block' }` aggregation
 * with a min-occurrences threshold.
 */
export async function runSubagentHookBlockDetector(): Promise<ContractProbeResult> {
  const corpus = buildSubagentBlockCorpus();
  const cards = detectSubagentBlock(corpus, {});
  const card = cards[0];

  // Below-threshold: a single sighting must not emit a card.
  const belowThresholdCards = detectSubagentBlock(
    [makeSessionRead('sab-solo', [makeSubagentBlockEvent(0, 'sab-solo', 'solo-reason')])],
    {},
  );

  // Independently falsifiable exclusion check: run the detector with
  // minOccurrences:1 against a corpus that contains ONLY PreToolUse blocks
  // (≥2 so the occurrence threshold cannot mask a filter regression). If the
  // hookEvent !== 'SubagentStart' filter were removed, these would be counted
  // as subagent blocks and a card would be emitted.
  const preToolUseOnlyCorpus = [
    makeSessionRead('sab-excl-a', [
      makePreToolUseBlockEvent(0, 'sab-excl-a'),
      makePreToolUseBlockEvent(1, 'sab-excl-a'),
    ]),
    makeSessionRead('sab-excl-b', [
      makePreToolUseBlockEvent(0, 'sab-excl-b'),
    ]),
  ];
  const preToolUseOnlyCards = detectSubagentBlock(preToolUseOnlyCorpus, { minOccurrences: 1 });

  const checks: EvalCheck[] = [
    makeCheck({
      name: 'emits-card-on-recurring-subagent-block',
      description: 'detector emits exactly one card when SubagentStart blocks recur across sessions',
      pass: cards.length === 1,
      expected: '1 card',
      actual: `${cards.length} card(s)`,
    }),
    makeCheck({
      name: 'card-pattern-is-subagent-block',
      description: "card's pattern field is 'subagent-block'",
      pass: card?.pattern === 'subagent-block',
      expected: "'subagent-block'",
      actual: card?.pattern ?? 'undefined',
    }),
    makeCheck({
      name: 'block-count-and-sessions-correct',
      description: 'card detail reports the correct blockCount and distinctSessions from the corpus',
      pass: card?.detail['blockCount'] === 3 && card?.detail['distinctSessions'] === 2,
      expected: 'blockCount=3, distinctSessions=2',
      actual: `blockCount=${card?.detail['blockCount'] ?? 'undefined'}, distinctSessions=${card?.detail['distinctSessions'] ?? 'undefined'}`,
    }),
    makeCheck({
      name: 'excludes-non-subagent-hook-blocks',
      description:
        'a corpus of ≥2 PreToolUse blocks (minOccurrences:1) emits no card — would fail if the hookEvent filter were removed',
      pass: preToolUseOnlyCards.length === 0,
      expected: '0 cards from PreToolUse-only corpus',
      actual: `${preToolUseOnlyCards.length} card(s)`,
    }),
    makeCheck({
      name: 'below-threshold-produces-no-card',
      description: `a single SubagentStart block (below default minOccurrences=${DEFAULT_SUBAGENT_BLOCK_MIN_OCCURRENCES}) emits no card`,
      pass: belowThresholdCards.length === 0,
      expected: '0 cards',
      actual: `${belowThresholdCards.length} card(s)`,
    }),
  ];

  const evidence: EvalRunEvidenceRef[] = [
    {
      kind: 'source-symbol',
      ref: 'src/improve/scan/detectors/subagent-block.ts#detectSubagentBlock',
      detail: `emitted ${cards.length} card(s) from synthetic corpus (3 SubagentStart blocks across 2 sessions + 1 PreToolUse block)`,
    },
    {
      kind: 'config-value',
      ref: 'src/improve/scan/detectors/subagent-block.ts#DEFAULT_SUBAGENT_BLOCK_MIN_OCCURRENCES',
      detail: String(DEFAULT_SUBAGENT_BLOCK_MIN_OCCURRENCES),
    },
  ];

  return { checks, evidence };
}
