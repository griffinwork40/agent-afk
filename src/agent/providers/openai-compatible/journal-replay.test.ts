/**
 * Tests for destination-keyed reasoning replay (issue #2791).
 *
 * When a session switches between OpenAI-compatible endpoints mid-conversation
 * the journal carries thinking blocks tagged with the SOURCE endpoint's wire
 * field (`openai-compatible:reasoning` for Cerebras, `openai-compatible:reasoning_content`
 * for DeepSeek). On resume the replay MUST use the DESTINATION endpoint's field,
 * not the source's, or a strict destination will reject the first post-switch
 * request with HTTP 400.
 */
import { describe, expect, it } from 'vitest';
import { openAIJournalAdapterForEndpoint } from './journal-adapter.js';
import type { JournalMessage } from '../../journal/index.js';

const mixed: JournalMessage = {
  role: 'assistant',
  content: [
    { type: 'thinking', thinking: 'legacy' },
    { type: 'thinking', thinking: 'cerebras', origin: 'openai-compatible:reasoning' },
    { type: 'thinking', thinking: 'deepseek', origin: 'openai-compatible:reasoning_content' },
    { type: 'thinking', thinking: 'foreign', origin: 'anthropic-direct', signature: 'sig' },
    { type: 'text', text: 'answer' },
  ],
};

describe('destination reasoning replay', () => {
  it.each([
    ['https://api.deepseek.com/v1', 'reasoning_content'],
    ['https://api.cerebras.ai/v1', 'reasoning'],
  ] as const)('merges legacy and mixed thinking under %s destination field', (url, field) => {
    const adapter = openAIJournalAdapterForEndpoint(url);
    const turns = adapter.fromJournalMessages([mixed]);
    expect(turns[0]).toEqual({ role: 'assistant', content: 'answer', [field]: 'legacy\ncerebras\ndeepseek\nforeign' });
    // Forced re-syncs use adopt(), not lossy toJournal() on the wire projection.
    expect(adapter.adopt?.(turns, 0)?.entries).toEqual([mixed]);
  });

  it.each([undefined, 'not a URL', 'https://localhost:8080/v1'])('omits imported thinking for unknown destination %s without losing it', (url) => {
    const adapter = openAIJournalAdapterForEndpoint(url);
    const turns = adapter.fromJournalMessages([mixed]);
    expect(turns).toEqual([{ role: 'assistant', content: 'answer' }]);
    expect(adapter.adopt?.(turns, 0)?.entries).toEqual([mixed]);
  });
});

// ─── Mid-session endpoint switch scenarios (issue #2791) ──────────────────────

/** Helper: one assistant turn with reasoning and one tool call, journaled. */
function reasoningToolTurn(reasoningOrigin: string, thought: string): JournalMessage {
  return {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: thought, origin: reasoningOrigin },
      { type: 'tool_use', id: 'c1', name: 'bash', input: { cmd: 'ls' } },
    ],
  };
}

/** Helper: one assistant text turn without reasoning, journaled. */
function textTurn(text: string): JournalMessage {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

describe('mid-session endpoint switch (#2791)', () => {
  it('Cerebras→DeepSeek: replays reasoning under reasoning_content, not reasoning', () => {
    // Source turn was produced by Cerebras (stores reasoning in `reasoning` field).
    const journal = [reasoningToolTurn('openai-compatible:reasoning', 'cerebras thought')];
    const adapter = openAIJournalAdapterForEndpoint('https://api.deepseek.com/v1');
    const [turn] = adapter.fromJournalMessages(journal);
    expect(turn).toBeDefined();
    // Destination is DeepSeek — must use reasoning_content.
    expect((turn as Record<string, unknown>)['reasoning_content']).toBe('cerebras thought');
    // Must NOT send reasoning (Cerebras field) to DeepSeek — it would 400.
    expect(turn).not.toHaveProperty('reasoning');
  });

  it('DeepSeek→Cerebras: replays reasoning under reasoning, not reasoning_content', () => {
    // Source turn was produced by DeepSeek (stores reasoning in `reasoning_content` field).
    const journal = [reasoningToolTurn('openai-compatible:reasoning_content', 'deepseek thought')];
    const adapter = openAIJournalAdapterForEndpoint('https://api.cerebras.ai/v1');
    const [turn] = adapter.fromJournalMessages(journal);
    expect(turn).toBeDefined();
    // Destination is Cerebras — must use reasoning.
    expect((turn as Record<string, unknown>)['reasoning']).toBe('deepseek thought');
    // Must NOT send reasoning_content to Cerebras — it would 400.
    expect(turn).not.toHaveProperty('reasoning_content');
  });

  it('DeepSeek→DeepSeek (same endpoint): reasoning_content survives unchanged', () => {
    const journal = [reasoningToolTurn('openai-compatible:reasoning_content', 'deep thought')];
    const adapter = openAIJournalAdapterForEndpoint('https://api.deepseek.com/v1');
    const [turn] = adapter.fromJournalMessages(journal);
    expect((turn as Record<string, unknown>)['reasoning_content']).toBe('deep thought');
    expect(turn).not.toHaveProperty('reasoning');
  });

  it('Cerebras→Cerebras (same endpoint): reasoning survives unchanged', () => {
    const journal = [reasoningToolTurn('openai-compatible:reasoning', 'brain thought')];
    const adapter = openAIJournalAdapterForEndpoint('https://api.cerebras.ai/v1');
    const [turn] = adapter.fromJournalMessages(journal);
    expect((turn as Record<string, unknown>)['reasoning']).toBe('brain thought');
    expect(turn).not.toHaveProperty('reasoning_content');
  });

  it('DeepSeek: tool-call turn without reasoning gets empty reasoning_content (API requirement)', () => {
    // DeepSeek requires reasoning_content on all assistant tool-call messages, even
    // those that did not produce reasoning, or the API rejects the history with 400.
    const noReasoningTurn: JournalMessage = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'c1', name: 'bash', input: {} }],
    };
    const adapter = openAIJournalAdapterForEndpoint('https://api.deepseek.com/v1');
    const [turn] = adapter.fromJournalMessages([noReasoningTurn]);
    expect(turn).toHaveProperty('reasoning_content', '');
    expect(turn).not.toHaveProperty('reasoning');
  });

  it('Cerebras: tool-call turn without reasoning does NOT get an empty reasoning field', () => {
    // Cerebras does not require reasoning on tool-call turns without thinking.
    const noReasoningTurn: JournalMessage = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'c1', name: 'bash', input: {} }],
    };
    const adapter = openAIJournalAdapterForEndpoint('https://api.cerebras.ai/v1');
    const [turn] = adapter.fromJournalMessages([noReasoningTurn]);
    expect(turn).not.toHaveProperty('reasoning');
    expect(turn).not.toHaveProperty('reasoning_content');
  });

  it('unknown endpoint: both switch directions omit reasoning without destroying provenance', () => {
    const journal = [
      reasoningToolTurn('openai-compatible:reasoning', 'cerebras thought'),
      reasoningToolTurn('openai-compatible:reasoning_content', 'deepseek thought'),
    ];
    const adapter = openAIJournalAdapterForEndpoint('https://custom.example.com/v1');
    const turns = adapter.fromJournalMessages(journal);
    // repairUnansweredToolCalls inserts a synthetic tool message after each
    // unanswered call, so the repaired array is:
    //   [assistant0, synth_tool0, assistant1, synth_tool1]
    const assistantTurns = turns.filter((m) => m.role === 'assistant');
    for (const turn of assistantTurns) {
      expect(turn).not.toHaveProperty('reasoning');
      expect(turn).not.toHaveProperty('reasoning_content');
    }
    // Provenance must preserve original journal messages (no data loss).
    // adopt() is indexed on the repaired array; assistant0 is at index 0,
    // assistant1 is at index 2 (after the first synthetic tool message).
    expect(adapter.adopt?.(turns, 0)?.entries).toEqual([journal[0]]);
    expect(adapter.adopt?.(turns, 2)?.entries).toEqual([journal[1]]);
  });
});
