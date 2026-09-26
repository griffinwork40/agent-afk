/**
 * Claude judge: grades episode outputs using a single model call per output.
 *
 * All questions are answered in one call: the model returns a JSON object
 * mapping question id → probability [0,1]. Missing ids are omitted
 * (maximum uncertainty). Probabilities are clamped to [0,1].
 *
 * @module whatif/judge/claude
 */

import { extractJson } from '../json-extract.js';
import type { CompleteFn, Judge, JudgeInput, JudgeResult } from '../types.js';

const SYSTEM = `You are a calibrated grader for agent-afk's what-if engine.

You will receive a rendered agent output (user prompt + assistant response +
optional tool calls) and a list of yes/no questions about it.

For each question, estimate the probability that the answer is "yes", from 0.0
to 1.0. Be calibrated: 0.5 means genuine uncertainty; 0.9 means "almost
certainly yes".

Output ONLY a JSON object mapping question id → probability (no prose, no fences):
{"p1": 0.85, "d2": 0.3, …}`;

function buildUser(input: JudgeInput): string {
  const questionLines = input.questions
    .map((q) => `  ${q.id}: ${q.question}`)
    .join('\n');

  return `## User prompt\n${input.prompt}\n\n## Agent output\n${input.output}\n\n## Questions\n${questionLines}`;
}

/**
 * Clamp a value to [0, 1]. Non-finite values become 0.5.
 */
function clamp(v: number): number {
  if (!isFinite(v)) return 0.5;
  return Math.max(0, Math.min(1, v));
}

/**
 * Create a Claude-backed `Judge`.
 *
 * `name` is `'claude'`; `external` is `false` (data stays within Anthropic).
 */
export function createClaudeJudge(complete: CompleteFn, model: string): Judge {
  return {
    name: 'claude',
    external: false,

    async grade(input: JudgeInput, signal?: AbortSignal): Promise<JudgeResult> {
      const { text } = await complete({
        system: SYSTEM,
        user: buildUser(input),
        maxTokens: 512,
        model,
        signal,
      });

      const raw = extractJson(text);
      const result: JudgeResult = {};

      // Invariant: unanswered ids are omitted, never defaulted to 0.5 — a
      // default would make a parse failure read as a measured "no change".
      const wanted = new Set(input.questions.map((q) => q.id));
      if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [id, val] of Object.entries(raw as Record<string, unknown>)) {
          if (typeof val === 'number' && wanted.has(id)) {
            result[id] = clamp(val);
          }
        }
      }
      if (input.questions.length > 0 && Object.keys(result).length === 0) {
        throw new Error(`claude judge returned no usable answers: ${text.slice(0, 200)}`);
      }

      return result;
    },
  };
}
