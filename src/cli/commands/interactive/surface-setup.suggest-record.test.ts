import { describe, it, expect, vi } from 'vitest';
import { buildSuggestionJournalRecorder } from './surface-setup.suggest-record.js';
import type { SessionRef } from '../../../agent/session-ref.js';
import type { AgentSession } from '../../../agent/session.js';

function refWith(journal: { mark: ReturnType<typeof vi.fn> } | undefined): SessionRef {
  return { current: { messageJournal: journal } as unknown as AgentSession };
}

describe('buildSuggestionJournalRecorder', () => {
  it('writes a suggestion mark with the record as detail', () => {
    const mark = vi.fn();
    const record = buildSuggestionJournalRecorder(refWith({ mark }));
    record({ event: 'generated', source: 'prompt', text: 'run the tests', model: 'haiku' });
    expect(mark).toHaveBeenCalledWith('suggestion', {
      event: 'generated',
      source: 'prompt',
      text: 'run the tests',
      model: 'haiku',
    });
  });

  it('redacts secrets in text and buffer before they reach the journal', () => {
    const mark = vi.fn();
    const record = buildSuggestionJournalRecorder(refWith({ mark }));
    const key = 'sk-ant-api03-' + 'a'.repeat(40);
    record({ event: 'accepted', source: 'completion', text: `export KEY=${key}`, buffer: `export KEY=${key.slice(0, 30)}` });
    const detail = mark.mock.calls[0]![1] as { text: string; buffer: string };
    expect(detail.text).not.toContain(key);
    expect(detail.text).toContain('[REDACTED]');
    expect(detail.buffer).not.toContain(key.slice(0, 30));
  });

  it('reads the session through the ref at record time (survives a /resume swap)', () => {
    const first = vi.fn();
    const second = vi.fn();
    const ref = refWith({ mark: first });
    const record = buildSuggestionJournalRecorder(ref);
    ref.current = { messageJournal: { mark: second } } as unknown as AgentSession;
    record({ event: 'dismissed', source: 'prompt', text: 'x' });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it('is a no-op when the session has no journal', () => {
    const record = buildSuggestionJournalRecorder(refWith(undefined));
    expect(() => record({ event: 'dismissed', source: 'prompt', text: 'x' })).not.toThrow();
  });
});
