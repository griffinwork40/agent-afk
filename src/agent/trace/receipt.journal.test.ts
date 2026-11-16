import { describe, expect, it } from 'vitest';
import type { JournalMessage, JournalRecord } from '../journal/types.js';
import { extractJournalSummary } from './receipt.journal.js';
import { wrapFrameworkContext } from '../session/framework-context-envelope.js';

const user = (...texts: string[]): JournalMessage => ({
  role: 'user',
  content: texts.map((text) => ({ type: 'text' as const, text })),
});
const assistant = (text: string): JournalMessage => ({ role: 'assistant', content: [{ type: 'text', text }] });

// Long hook output: three plugins' SessionStart context, well over 500 chars.
const HOOK_CONTEXT = [
  '[placeholder-prevent] Prefer running commands yourself with your tools. '.repeat(4),
  'Read any referenced file for deeper context before acting — these are pointers, not full content.',
  `Recent work in agent-afk (Q ledger, last 14d):\n${'- abc123 fix something\n'.repeat(20)}`,
].join('\n\n');

describe('extractJournalSummary firstUserMessage strips framework context', () => {
  it('strips >500 chars of enveloped context before capping and keeps the typed prompt', () => {
    expect(HOOK_CONTEXT.length).toBeGreaterThan(500);
    const first = user(`${wrapFrameworkContext(HOOK_CONTEXT)}\n\nfix the flaky receipt test`);
    const summary = extractJournalSummary([first, assistant('done')], false)!;
    expect(summary.firstUserMessage).toBe('fix the flaky receipt test');
  });

  it('collapses a slash-command dispatch (context as block 0) to /<skill> <args>', () => {
    const first = user(
      wrapFrameworkContext(HOOK_CONTEXT),
      '<command-name>/land</command-name>\n<command-message>land</command-message>\n<command-args>4900</command-args>',
      'Run the land skill.',
    );
    const summary = extractJournalSummary([first, assistant('ok')], false)!;
    expect(summary.firstUserMessage).toBe('/land 4900');
  });

  it('omits firstUserMessage when the message is pure framework context', () => {
    const summary = extractJournalSummary([user(wrapFrameworkContext(HOOK_CONTEXT)), assistant('ok')], false)!;
    expect(summary).not.toHaveProperty('firstUserMessage');
    expect(summary.lastAssistantMessage).toBe('ok');
  });

  it('strips the legacy bracketed preamble too', () => {
    const summary = extractJournalSummary([user('[placeholder-prevent] Prefer running commands.\n\nhello'), assistant('hi')], false)!;
    expect(summary.firstUserMessage).toBe('hello');
  });

  it('still caps a long typed prompt at 500 chars after stripping', () => {
    const typed = 'y'.repeat(700);
    const summary = extractJournalSummary([user(`${wrapFrameworkContext(HOOK_CONTEXT)}\n\n${typed}`)], false)!;
    expect(summary.firstUserMessage).toBe(`${'y'.repeat(500)}\u2026`);
  });

  it('strips the raw-record first message used for compaction survival', () => {
    const rawRecords: JournalRecord[] = [
      { v: 1, ts: 1, kind: 'append', index: 0, message: user(`${wrapFrameworkContext(HOOK_CONTEXT)}\n\nreal ask`) },
      { v: 1, ts: 2, kind: 'truncate', length: 0, reason: 'compact' },
      { v: 1, ts: 3, kind: 'append', index: 0, message: user('[Summary of prior conversation]') },
    ];
    const summary = extractJournalSummary([user('[Summary of prior conversation]'), assistant('a')], false, rawRecords)!;
    expect(summary.firstUserMessage).toBe('real ask');
  });

  it('keeps redaction behaviour: no text fields when textDisabled', () => {
    const summary = extractJournalSummary([user(`${wrapFrameworkContext('ctx')}\n\nsecret`)], true)!;
    expect(summary.firstUserMessage).toBeUndefined();
    expect(summary.textRedacted).toBe(true);
  });
});
