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
