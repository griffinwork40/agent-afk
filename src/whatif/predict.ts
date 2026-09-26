/**
 * Level-1 prediction: given a structural impact summary, produce up to 8
 * predicted behavior changes.
 *
 * One model call. Output is validated against the Prediction schema; invalid
 * entries are dropped. The model is instructed to return an empty list when
 * the change has no plausible behavioral effect (no filler).
 *
 * @module whatif/predict
 */

import { z } from 'zod';
import { extractJsonAs } from './json-extract.js';
import type { CompleteFn, Prediction, StructuralImpact } from './types.js';

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

const PredictionSchema = z.object({
  id: z.string(),
  behavior: z.string(),
  direction: z.enum(['added', 'removed', 'strengthened', 'weakened']),
  confidence: z.enum(['high', 'medium', 'low']),
  reason: z.string(),
  testQuestion: z.string(),
  probes: z.array(z.string()).min(1).max(2),
});

const RawPredictionsArraySchema = z.array(z.unknown());

// ---------------------------------------------------------------------------
// System prompt helpers
// ---------------------------------------------------------------------------

/** Truncate a string to maxChars keeping head and tail when over limit. */
function headTail(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  const half = Math.floor(maxChars / 2);
  return `${s.slice(0, half)}\n…[truncated]…\n${s.slice(s.length - half)}`;
}

const SYSTEM = `You are a behavioral prediction assistant for agent-afk's what-if engine.

Your job: given a description of a change to an AI agent's environment, predict
how the agent's behavior will change. Return a JSON array of Prediction objects.

## Rules

- Return at most 8 predictions.
- Return an empty array [] when the change has no plausible behavioral effect.
- Never pad with filler predictions to reach a count. An empty list is correct output.
- Each prediction must have a POSITIVELY framed testQuestion answerable from a
  single agent output. Phrase as "Does the response …?" — never "Is it too …?".
- probes: 1-2 realistic user requests that would exercise the predicted behavior.
- confidence must be honest: high only when the causal link is clear from the diff.
- Ids must be p1, p2, … pN (sequential, no gaps).

## Output format

Respond with ONLY a JSON array (no prose, no fences):
[{"id":"p1","behavior":"…","direction":"added"|"removed"|"strengthened"|"weakened",
  "confidence":"high"|"medium"|"low","reason":"…","testQuestion":"Does the response …?",
  "probes":["…","…"]}, …]`;

// ---------------------------------------------------------------------------
// Input type
// ---------------------------------------------------------------------------

export interface PredictInput {
  spec: { title: string; changes: unknown[] };
  changeDescriptions: string[];
  structural: StructuralImpact;
  trackRecord?: string;
}

// ---------------------------------------------------------------------------
// Predictor
// ---------------------------------------------------------------------------

/**
 * Generate up to 8 behavioral predictions for the proposed change.
 *
 * Returns an empty array when the model determines the change has no
 * behavioral effect. Invalid prediction entries are silently dropped.
 */
export async function predictChanges(
  input: PredictInput,
  complete: CompleteFn,
  model: string,
): Promise<Prediction[]> {
  const { spec, changeDescriptions, structural, trackRecord } = input;

  // Build a concise summary of the structural diff.
  const systemDiffSnippet = headTail(structural.systemDiff || '(no system prompt diff)', 12000);

  const sections: string[] = [
    `## Change spec\nTitle: ${spec.title}\n${changeDescriptions.map((d, i) => `  ${i + 1}. ${d}`).join('\n')}`,
    `## System prompt diff (truncated to ~12k chars)\n${systemDiffSnippet}`,
    `## Tools\nAdded: ${structural.toolsAdded.join(', ') || 'none'}\nRemoved: ${structural.toolsRemoved.join(', ') || 'none'}\nChanged: ${structural.toolsChanged.join(', ') || 'none'}`,
    `## User message diff\n${structural.userMessageDiff || '(no diff)'}`,
    `## Model changed: ${structural.modelChanged ? 'yes' : 'no'}`,
    `## Token delta: ${structural.tokens.candidate - structural.tokens.baseline > 0 ? '+' : ''}${structural.tokens.candidate - structural.tokens.baseline} tokens`,
  ];

  if (trackRecord) {
    sections.push(`## Engine track record (calibration)\n${headTail(trackRecord, 2000)}`);
  }

  const user = sections.join('\n\n');

  const { text } = await complete({ system: SYSTEM, user, maxTokens: 2048, model });

  let raw: unknown[];
  try {
    raw = extractJsonAs(text, RawPredictionsArraySchema);
  } catch {
    // Model returned malformed JSON — treat as no predictions.
    return [];
  }

  // Drop invalid entries, re-assign sequential ids.
  const valid: Prediction[] = [];
  for (const entry of raw) {
    const parsed = PredictionSchema.safeParse(entry);
    if (parsed.success && valid.length < 8) {
      valid.push({ ...parsed.data, id: `p${valid.length + 1}` });
    }
  }

  return valid;
}
