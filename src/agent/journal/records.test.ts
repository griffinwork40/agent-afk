/**
 * Unit tests for parseJournalLine, focusing on block-level validation of
 * `append` records. The previous isMessage() implementation only verified
 * `typeof b['type'] === 'string'`, accepting blocks with missing required
 * fields (e.g. a tool_result without toolUseId or with non-array content)
 * that would crash provider adapters or hydrate.ts downstream.
 *
 * These tests pin the contract: recognized block types with missing required
 * fields are rejected as malformed; unknown block types are rejected; valid
 * blocks of every type are accepted. The non-throwing contract (null not
 * throw) is preserved throughout.
 *
 * @module agent/journal/records.test
 */

import { describe, it, expect } from 'vitest';
import { parseJournalLine } from './records.js';
import type { JournalMessage } from './types.js';

const V = 1;
const TS = Date.now();

function appendLine(message: unknown): string {
  return JSON.stringify({ v: V, ts: TS, kind: 'append', index: 0, message });
}

function validMsg(overrides: Partial<JournalMessage> = {}): JournalMessage {
  return { role: 'user', content: [{ type: 'text', text: 'hello' }], ...overrides };
}

// ---------------------------------------------------------------------------
// Valid block shapes — parseJournalLine must accept these.
// ---------------------------------------------------------------------------

describe('parseJournalLine — valid blocks', () => {
  it('accepts a text block', () => {
    const rec = parseJournalLine(appendLine(validMsg()));
    expect(rec).not.toBeNull();
    expect(rec?.kind).toBe('append');
  });

  it('accepts a tool_use block', () => {
    const msg: JournalMessage = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tu-1', name: 'bash', input: { cmd: 'ls' } }],
    };
    expect(parseJournalLine(appendLine(msg))).not.toBeNull();
  });

  it('accepts a tool_result block with array content', () => {
    const msg: JournalMessage = {
      role: 'user',
      content: [{ type: 'tool_result', toolUseId: 'tu-1', content: [{ type: 'text', text: 'ok' }] }],
    };
    expect(parseJournalLine(appendLine(msg))).not.toBeNull();
  });

  it('accepts a tool_result block with empty content array', () => {
    const msg: JournalMessage = {
      role: 'user',
      content: [{ type: 'tool_result', toolUseId: 'tu-2', content: [] }],
    };
    expect(parseJournalLine(appendLine(msg))).not.toBeNull();
  });

  it('accepts a thinking block', () => {
    const msg: JournalMessage = {
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'hmm' }],
    };
    expect(parseJournalLine(appendLine(msg))).not.toBeNull();
  });

  it('accepts a redacted_thinking block', () => {
    const msg: JournalMessage = {
      role: 'assistant',
      content: [{ type: 'redacted_thinking', data: 'opaque' }],
    };
    expect(parseJournalLine(appendLine(msg))).not.toBeNull();
  });

  it('accepts a text_ref block', () => {
    const msg: JournalMessage = {
      role: 'assistant',
      content: [{
        type: 'text_ref',
        ref: { path: 'sessions/x/blobs/abc.txt', bytes: 10, sha256: 'abc', mediaType: 'text/plain' },
        preview: 'first line',
      }],
    };
    expect(parseJournalLine(appendLine(msg))).not.toBeNull();
  });

  it('accepts an image block', () => {
    const msg: JournalMessage = {
      role: 'user',
      content: [{ type: 'image', source: { kind: 'url', url: 'https://example.com/img.png' } }],
    };
    expect(parseJournalLine(appendLine(msg))).not.toBeNull();
  });

  it('accepts a document block', () => {
    const msg: JournalMessage = {
      role: 'user',
      content: [{ type: 'document', source: { kind: 'url', url: 'https://example.com/doc.pdf' } }],
    };
    expect(parseJournalLine(appendLine(msg))).not.toBeNull();
  });

  it('accepts an assistant message with multiple mixed blocks', () => {
    const msg: JournalMessage = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'result:' },
        { type: 'tool_use', id: 'tu-3', name: 'read_file', input: {} },
      ],
    };
    expect(parseJournalLine(appendLine(msg))).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Invalid / incomplete block shapes — parseJournalLine must return null.
// ---------------------------------------------------------------------------

describe('parseJournalLine — malformed blocks (null, not throw)', () => {
  it('rejects a tool_result missing toolUseId', () => {
    const line = appendLine({
      role: 'user',
      content: [{ type: 'tool_result', content: [{ type: 'text', text: 'x' }] }],
    });
    expect(parseJournalLine(line)).toBeNull();
  });

  it('rejects a tool_result whose content is a string (not array)', () => {
    // Anthropic's native format allows string content, but after journalizing
    // via the adapter it is always a JournalResultPart[]. A raw string content
    // in the journal file means a corrupt/hand-edited record.
    const line = appendLine({
      role: 'user',
      content: [{ type: 'tool_result', toolUseId: 'tu-x', content: 'raw string' }],
    });
    expect(parseJournalLine(line)).toBeNull();
  });

  it('rejects a tool_result whose content is null', () => {
    const line = appendLine({
      role: 'user',
      content: [{ type: 'tool_result', toolUseId: 'tu-x', content: null }],
    });
    expect(parseJournalLine(line)).toBeNull();
  });

  it('rejects a tool_use missing id', () => {
    const line = appendLine({
      role: 'assistant',
      content: [{ type: 'tool_use', name: 'bash', input: {} }],
    });
    expect(parseJournalLine(line)).toBeNull();
  });

  it('rejects a tool_use missing name', () => {
    const line = appendLine({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tu-4', input: {} }],
    });
    expect(parseJournalLine(line)).toBeNull();
  });

  it('rejects a text block missing the text field', () => {
    const line = appendLine({ role: 'user', content: [{ type: 'text' }] });
    expect(parseJournalLine(line)).toBeNull();
  });

  it('rejects a thinking block missing the thinking field', () => {
    const line = appendLine({ role: 'assistant', content: [{ type: 'thinking' }] });
    expect(parseJournalLine(line)).toBeNull();
  });

  it('rejects an unknown block type', () => {
    const line = appendLine({ role: 'user', content: [{ type: 'future_block', data: 'x' }] });
    expect(parseJournalLine(line)).toBeNull();
  });

  it('rejects a block that is only { type: "text" } with no text string', () => {
    const line = appendLine({ role: 'user', content: [{ type: 'text', text: 42 }] });
    expect(parseJournalLine(line)).toBeNull();
  });

  it('never throws on any of the above — returns null each time', () => {
    const badLines = [
      appendLine({ role: 'user', content: [{ type: 'tool_result', content: 'string' }] }),
      appendLine({ role: 'user', content: [{ type: 'unknown_future' }] }),
      appendLine({ role: 'user', content: [{ type: 'tool_use' }] }),
      'not json at all',
      '',
      '{}',
    ];
    for (const line of badLines) {
      expect(() => parseJournalLine(line)).not.toThrow();
      // Most will be null; the point is no throw.
    }
  });
});
