/**
 * Deterministic feature extraction from episode traces.
 *
 * No model calls. Reads only the tool log embedded in an {@link EpisodeTrace}.
 *
 * @module whatif/observe
 */

import type { EpisodeFeatures, EpisodeTrace } from './types.js';

// ---------------------------------------------------------------------------
// Feature labels
// ---------------------------------------------------------------------------

/**
 * Stable, human-readable labels for the boolean features produced by
 * {@link featureIndicators}. Ordered to match the report's Measured Behaviors
 * table.
 */
export const FEATURE_LABELS: readonly string[] = [
  'Asked before acting',
  'Answered without tools',
  'Took a side-effecting action',
  'Delegated to a subagent or skill',
  'Searched memory',
  'Hit an error',
] as const;

// ---------------------------------------------------------------------------
// Tool classification helpers
// ---------------------------------------------------------------------------

/** Tools whose first recorded verdict marks delegation. */
const DELEGATE_TOOLS = new Set([
  'agent',
  'compose',
  'skill',
  'background_agent',
]);

/** Tool names that are memory searches. */
const MEMORY_SEARCH_TOOLS = new Set(['memory_search']);

/** Tool whose presence indicates the agent asked the user a question. */
const ASK_TOOL = 'ask_question';

// ---------------------------------------------------------------------------
// extractFeatures
// ---------------------------------------------------------------------------

/**
 * Extract {@link EpisodeFeatures} from a completed trace.
 *
 * Classification rules (applied in order):
 *
 * - `none`        — no tool calls AND empty text.
 * - `ask`         — first tool call is `ask_question`.
 * - `delegate`    — first tool call is an agent/compose/skill dispatch.
 * - `side-effect` — a `recorded` verdict appears BEFORE any `executed` verdict
 *                   (or alongside only other `recorded`).
 * - `read`        — first tool call is anything else (executed read-only tool).
 * - `answer`      — no tool calls but there IS text.
 *
 * `askedBeforeActing` is `true` when:
 *   - `ask_question` appears before any tool with a `recorded` verdict, OR
 *   - there are no tools at all AND the final non-empty line of `text` ends
 *     with `?` (heuristic: the agent typed a question to the user).
 *
 * `usedSkills` collects the `name` input from every `skill` tool call.
 * `searchedMemory` is `true` when `memory_search` appears in the tool list.
 */
export function extractFeatures(trace: EpisodeTrace): EpisodeFeatures {
  const tools = trace.tools;
  const text = trace.text;

  // ── usedTools ────────────────────────────────────────────────────────────
  const usedToolsSet = new Set<string>();
  for (const t of tools) {
    usedToolsSet.add(t.tool);
  }
  const usedTools = Array.from(usedToolsSet);

  // ── usedSkills ────────────────────────────────────────────────────────────
  const usedSkills: string[] = [];
  for (const t of tools) {
    if (t.tool === 'skill') {
      const input = t.input as Record<string, unknown>;
      const skillName = input['name'];
      if (typeof skillName === 'string' && skillName) {
        usedSkills.push(skillName);
      }
    }
  }

  // ── searchedMemory ────────────────────────────────────────────────────────
  const searchedMemory = usedTools.some((n) => MEMORY_SEARCH_TOOLS.has(n));

  // ── errored ───────────────────────────────────────────────────────────────
  const errored = trace.error !== undefined;

  // ── firstAction ───────────────────────────────────────────────────────────
  const firstTool = tools[0];

  let firstAction: EpisodeFeatures['firstAction'];

  if (tools.length === 0 && text.trim() === '') {
    firstAction = 'none';
  } else if (tools.length === 0) {
    firstAction = 'answer';
  } else if (firstTool!.tool === ASK_TOOL) {
    firstAction = 'ask';
  } else if (DELEGATE_TOOLS.has(firstTool!.tool)) {
    firstAction = 'delegate';
  } else if (firstTool!.verdict === 'recorded') {
    // The FIRST tool encountered is already a recorded side effect.
    firstAction = 'side-effect';
  } else {
    // First executed tool or any other tool — treat as 'read'.
    firstAction = 'read';

    // Re-scan: if a recorded verdict appears before any executed, override.
    let seenExecuted = false;
    for (const t of tools) {
      if (t.verdict === 'executed') {
        seenExecuted = true;
        break;
      }
      if (t.verdict === 'recorded') {
        // Recorded precedes all executed → side-effect first action.
        firstAction = 'side-effect';
        break;
      }
    }
    void seenExecuted; // used implicitly via loop break
  }

  // ── askedBeforeActing ─────────────────────────────────────────────────────
  let askedBeforeActing = false;

  if (tools.length === 0) {
    // Heuristic: last non-empty line ends with '?'
    const nonEmpty = text.split('\n').filter((l) => l.trim().length > 0);
    const lastLine = nonEmpty[nonEmpty.length - 1] ?? '';
    askedBeforeActing = lastLine.trim().endsWith('?');
  } else {
    // Ask before any recorded side effect.
    let foundAsk = false;
    for (const t of tools) {
      if (t.tool === ASK_TOOL) {
        foundAsk = true;
        break;
      }
      if (t.verdict === 'recorded') {
        // A side effect appeared before any ask → false.
        break;
      }
    }
    askedBeforeActing = foundAsk;
  }

  // ── delegated (derived) ───────────────────────────────────────────────────
  const delegated = usedTools.some((n) => DELEGATE_TOOLS.has(n));

  return {
    firstAction,
    askedBeforeActing,
    delegated,
    usedTools,
    usedSkills,
    searchedMemory,
    toolCalls: tools.length,
    responseChars: text.length,
    errored,
  };
}

// ---------------------------------------------------------------------------
// featureIndicators
// ---------------------------------------------------------------------------

/**
 * Map an {@link EpisodeFeatures} to boolean indicators indexed by
 * {@link FEATURE_LABELS}. Rate comparisons are computed from the means of
 * these booleans across episode samples.
 */
export function featureIndicators(f: EpisodeFeatures): Record<string, boolean> {
  return {
    'Asked before acting': f.askedBeforeActing,
    'Answered without tools': f.firstAction === 'answer',
    'Took a side-effecting action': f.firstAction === 'side-effect',
    'Delegated to a subagent or skill': f.delegated,
    'Searched memory': f.searchedMemory,
    'Hit an error': f.errored,
  };
}

// ---------------------------------------------------------------------------
// meanNumeric helpers
// ---------------------------------------------------------------------------

/**
 * Mean of `toolCalls` across a sample of features.
 * Returns 0 for an empty array.
 */
export function meanToolCalls(samples: EpisodeFeatures[]): number {
  if (samples.length === 0) return 0;
  return samples.reduce((s, f) => s + f.toolCalls, 0) / samples.length;
}

/**
 * Mean of `responseChars` across a sample of features.
 * Returns 0 for an empty array.
 */
export function meanResponseChars(samples: EpisodeFeatures[]): number {
  if (samples.length === 0) return 0;
  return samples.reduce((s, f) => s + f.responseChars, 0) / samples.length;
}
