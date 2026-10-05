/**
 * OpenAIJournalWiring: microcompaction rewrites tool content IN PLACE on
 * already-synced messages, which the by-reference JournalSync diff cannot see.
 * The wiring must invalidate from the first cleared message so the journal
 * fold matches what the model is sent next (docs/message-journal.md).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { OpenAIJournalWiring } from './journal-wiring.js';
import type { OpenAIMessage } from '../messages.js';
import type { AgentConfig } from '../../../types/config-types.js';
import type {
  JournalMarkLabel,
  JournalMessage,
  JournalTruncateReason,
  MessageJournal,
} from '../../../journal/index.js';

type Rec =
  | { kind: 'append'; index: number }
  | { kind: 'truncate'; length: number; reason?: JournalTruncateReason };

class FakeJournal implements MessageJournal {
  records: Rec[] = [];
  arr: JournalMessage[] = [];
  get length(): number { return this.arr.length; }
  append(index: number, message: JournalMessage): void {
    expect(index).toBe(this.arr.length);
    this.arr.push(structuredClone(message));
    this.records.push({ kind: 'append', index });
  }
  truncate(length: number, reason?: JournalTruncateReason): void {
    this.arr.length = length;
    this.records.push({ kind: 'truncate', length, ...(reason ? { reason } : {}) });
  }
  mark(_label: JournalMarkLabel): void {}
  forSubagent(): MessageJournal { return new FakeJournal(); }
  flush(): Promise<void> { return Promise.resolve(); }
  close(): Promise<void> { return Promise.resolve(); }
}

describe('OpenAIJournalWiring microcompaction', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('re-journals from the first cleared tool message so the fold shows the placeholder', () => {
    vi.stubEnv('AFK_MICROCOMPACT_TOOL_RESULT_BYTES', '100');
    vi.stubEnv('AFK_MICROCOMPACT_KEEP_LAST', '0');
    const big = 'Y'.repeat(5_000);
    const journal = new FakeJournal();
    const wiring = new OpenAIJournalWiring({ model: 'gpt-5.5', messageJournal: journal } as AgentConfig);
    const turns = [
      { role: 'user', content: 'q1' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: big },
      { role: 'assistant', content: 'done' },
    ] as unknown as OpenAIMessage[];
    wiring.sync(turns);
    expect(JSON.stringify(journal.arr)).toContain(big);

    const result = wiring.microcompactFallback(turns);
    expect(result?.microcompaction?.blocksCleared).toBeGreaterThan(0);
    expect(journal.records.find((r) => r.kind === 'truncate')).toEqual({ kind: 'truncate', length: 2, reason: 'compact' });
    expect(journal.arr).toHaveLength(4);
    expect(JSON.stringify(journal.arr)).not.toContain(big);
  });

  it('writes nothing when no tool result qualifies', () => {
    const journal = new FakeJournal();
    const wiring = new OpenAIJournalWiring({ model: 'gpt-5.5', messageJournal: journal } as AgentConfig);
    const turns = [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }] as OpenAIMessage[];
    wiring.sync(turns);
    const before = journal.records.length;
    expect(wiring.microcompactFallback(turns)).toBeNull();
    expect(journal.records).toHaveLength(before);
  });
});
