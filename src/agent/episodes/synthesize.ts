/**
 * Episode synthesis via a Haiku-class one-shot LLM call.
 *
 * Formats a prompt from EpisodeInput, calls the LLM to produce a structured
 * EpisodeRecord, and parses the JSON response. Falls back to a deterministic
 * record from facet fields if the LLM call fails or returns unparseable output.
 *
 * Design invariants:
 *   - Uses the same oneShotCompletion pattern as spine-classifier.ts.
 *   - Fallback path never throws: always returns a usable (if thin) record.
 *   - Output is bounded: maxTokens 512 to keep cost minimal.
 *
 * @module agent/episodes/synthesize
 */

import { oneShotCompletion } from '../providers/whatif-api.js';
import { loadAnthropicCredential } from '../auth/credential-resolver.js';
import type { EpisodeInput, EpisodeRecord } from './types.js';

const SYNTHESIS_MODEL = 'claude-haiku-4-5';
const MAX_TOKENS = 512;

const SYSTEM_PROMPT = `You synthesize compressed episodic narratives from agent session data.
Given structured session signals, produce a JSON object with these exact fields:
  goal        - one sentence: what the user wanted
  approach    - one sentence: how the agent tackled it
  pivots      - array of strings: major strategy changes (empty array if none)
  decisions   - array of strings: key decisions made (max 4)
  outcome     - one sentence: what happened
  openQuestions - array of strings: unresolved questions (empty array if none)
  filesKey    - array of strings: most important files touched (max 5, paths only)
  tags        - array of strings: 2-5 topic tags (lowercase, hyphen-separated)
  narrative   - 2-3 sentence summary combining goal, approach, and outcome

Return ONLY valid JSON. No markdown fences, no explanation.`;

function buildPrompt(input: EpisodeInput): string {
  const lines: string[] = [
    `Session: ${input.sessionId}`,
    '',
    `FIRST USER MESSAGE:\n${input.firstUserMessage || '(none)'}`,
    '',
    `TOOLS USED: ${input.toolsUsed.slice(0, 30).join(', ') || '(none)'}`,
  ];

  if (input.toolErrors.length > 0) {
    lines.push(`TOOL ERRORS (first line each):\n${input.toolErrors.slice(0, 5).join('\n')}`);
  }

  if (input.markSequence.length > 0) {
    lines.push(`SESSION MARKS: ${input.markSequence.join(' → ')}`);
  }

  if (input.facetSummary) {
    lines.push(`FACET: ${input.facetSummary}`);
  }

  lines.push('', `LAST ASSISTANT MESSAGE:\n${input.lastAssistantMessage || '(none)'}`);

  return lines.join('\n');
}

function parseLLMResponse(raw: string, sessionId: string): EpisodeRecord | null {
  // Strip markdown fences if the model ignored the instruction
  const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  try {
    const obj = JSON.parse(cleaned) as Record<string, unknown>;
    const str = (v: unknown, fallback = '') =>
      typeof v === 'string' ? v : fallback;
    const arr = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

    return {
      sessionId,
      goal: str(obj['goal']),
      approach: str(obj['approach']),
      pivots: arr(obj['pivots']),
      decisions: arr(obj['decisions']),
      outcome: str(obj['outcome']),
      openQuestions: arr(obj['openQuestions']),
      filesKey: arr(obj['filesKey']),
      tags: arr(obj['tags']),
      narrative: str(obj['narrative']),
      synthesizedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function deterministicFallback(input: EpisodeInput): EpisodeRecord {
  const goal = input.firstUserMessage.slice(0, 120) || 'Unknown goal';
  const outcome = input.facetSummary ?? (input.lastAssistantMessage.slice(0, 120) || 'Unknown outcome');
  return {
    sessionId: input.sessionId,
    goal,
    approach: input.toolsUsed.length > 0
      ? `Used tools: ${input.toolsUsed.slice(0, 5).join(', ')}`
      : 'Conversational session',
    pivots: input.markSequence.filter((m) => m === 'rewind' || m === 'clear'),
    decisions: [],
    outcome,
    openQuestions: [],
    filesKey: [],
    tags: [],
    narrative: `${goal.slice(0, 80)}. ${outcome.slice(0, 80)}.`,
    synthesizedAt: new Date().toISOString(),
  };
}

/**
 * Synthesize an EpisodeRecord from the extracted input.
 * Falls back to a deterministic record if the LLM call fails.
 */
export async function synthesizeEpisode(input: EpisodeInput): Promise<EpisodeRecord> {
  const token = loadAnthropicCredential();
  if (!token) {
    return deterministicFallback(input);
  }

  try {
    const userPrompt = buildPrompt(input);
    const raw = await oneShotCompletion({
      token,
      model: SYNTHESIS_MODEL,
      system: SYSTEM_PROMPT,
      user: userPrompt,
      maxTokens: MAX_TOKENS,
    });

    const parsed = parseLLMResponse(raw, input.sessionId);
    if (parsed && parsed.goal) return parsed;

    return deterministicFallback(input);
  } catch {
    return deterministicFallback(input);
  }
}
