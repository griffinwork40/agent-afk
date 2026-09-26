/**
 * D5-style propose-then-verify: PROPOSE half.
 *
 * Given paired baseline/candidate outputs and a list of already-known
 * predictions, ask the model to surface up to 3 *additional* differences
 * that are not already covered. Each proposed difference comes with a
 * positively framed yes/no question for the verify half.
 *
 * @module whatif/discover
 */

import { z } from 'zod';
import { extractJsonAs } from './json-extract.js';
import type { CompleteFn, Prediction } from './types.js';

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

const DiffSchema = z.object({
  id: z.string(),
  description: z.string(),
  question: z.string(),
});

const DiscoverOutputSchema = z.array(DiffSchema);

export type DiscoveredDiff = z.infer<typeof DiffSchema>;

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM = `You are a behavioral-difference analyst for agent-afk's what-if engine.

You will receive:
1. A list of already-known predicted differences (do NOT repeat them).
2. Up to 12 paired outputs — baseline vs candidate — each truncated to ~1500 chars.

Your job: identify up to 3 NEW behavioral differences that the known predictions
do not already cover.

## Rules

- Return at most 3 differences.
- If there are no additional differences, return [].
- Each difference must have a positively framed yes/no question: "Does the response …?"
- Ids must be d1, d2, d3.
- Do not repeat or rephrase any known prediction.

## Output format

Respond with ONLY a JSON array (no prose, no fences):
[{"id":"d1","description":"…","question":"Does the response …?"},…]`;

// ---------------------------------------------------------------------------
// Input type
// ---------------------------------------------------------------------------

export interface OutputPair {
  prompt: string;
  baseline: string;
  candidate: string;
}

// ---------------------------------------------------------------------------
// Discoverer
// ---------------------------------------------------------------------------

const MAX_OUTPUT_CHARS = 1500;
const MAX_PAIRS = 12;

/** Truncate text to maxChars with a marker. */
function trunc(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '…[truncated]';
}

/**
 * Propose up to 3 differences NOT already covered by `known` predictions.
 *
 * Returns an empty array when no new differences are found or the model
 * returns malformed output.
 */
export async function discoverDifferences(
  pairs: OutputPair[],
  known: Prediction[],
  complete: CompleteFn,
  model: string,
): Promise<DiscoveredDiff[]> {
  const limitedPairs = pairs.slice(0, MAX_PAIRS);

  const knownSection =
    known.length > 0
      ? known.map((p) => `- [${p.id}] ${p.behavior} (question: "${p.testQuestion}")`).join('\n')
      : '(none)';

  const pairsSection = limitedPairs
    .map(
      (pair, i) =>
        `### Pair ${i + 1}\nPrompt: ${trunc(pair.prompt, 200)}\n` +
        `Baseline:\n${trunc(pair.baseline, MAX_OUTPUT_CHARS)}\n` +
        `Candidate:\n${trunc(pair.candidate, MAX_OUTPUT_CHARS)}`,
    )
    .join('\n\n');

  const user = `## Known predictions (do not repeat)\n${knownSection}\n\n## Paired outputs\n${pairsSection}`;

  const { text } = await complete({ system: SYSTEM, user, maxTokens: 1024, model });

  let raw: DiscoveredDiff[];
  try {
    raw = extractJsonAs(text, DiscoverOutputSchema);
  } catch {
    return [];
  }

  // Re-assign sequential ids and cap at 3.
  const valid: DiscoveredDiff[] = [];
  for (const entry of raw) {
    const parsed = DiffSchema.safeParse(entry);
    if (parsed.success && valid.length < 3) {
      valid.push({ ...parsed.data, id: `d${valid.length + 1}` });
    }
  }

  return valid;
}
