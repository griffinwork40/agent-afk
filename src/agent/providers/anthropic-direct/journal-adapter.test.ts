import { describe, it, expect } from 'vitest';
import type { ContentBlockParam, MessageParam } from '@anthropic-ai/sdk/resources';
import { anthropicJournalAdapter as adapter } from './journal-adapter.js';
import type { JournalMessage } from '../../journal/index.js';

const PNG = 'iVBORw0KGgo=';
const PDF = 'JVBERi0xLjQ=';

function roundTrip(messages: MessageParam[]): MessageParam[] {
  return adapter.fromJournalMessages(messages.map((m) => adapter.toJournal(m)!));
}

describe('anthropicJournalAdapter', () => {
  it('round-trips every block kind the provider produces', () => {
    const history: MessageParam[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
          { type: 'image', source: { type: 'url', url: 'https://x.test/a.png' } },
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF }, title: 'spec' },
          { type: 'document', source: { type: 'url', url: 'https://x.test/a.pdf' } },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm', signature: 'sig-1' },
          { type: 'redacted_thinking', data: 'opaque' },
          { type: 'text', text: 'calling' },
          { type: 'tool_use', id: 'toolu_1', name: 'bash', input: { command: 'ls', nested: [1, 2] } },
          { type: 'tool_use', id: 'toolu_2', name: 'read', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'x'.repeat(50_000) },
          {
            type: 'tool_result',
            tool_use_id: 'toolu_2',
            is_error: true,
            content: [
              { type: 'text', text: 'part' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
            ],
          },
        ],
      },
    ];
    const back = roundTrip(history);
    // String tool_result content comes back as one text part (send-equivalent).
    const expected = structuredClone(history);
    (expected[2]!.content as ContentBlockParam[])[0] = {
      type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'x'.repeat(50_000) }],
    };
    expect(back).toEqual(expected);
  });

  it('maps string content to one text block and drops cache_control / citations', () => {
    const j = adapter.toJournal({ role: 'user', content: 'hi' });
    expect(j).toEqual({ role: 'user', content: [{ type: 'text', text: 'hi' }] });
    const j2 = adapter.toJournal({
      role: 'assistant',
      content: [{ type: 'text', text: 'c', cache_control: { type: 'ephemeral' }, citations: [] } as ContentBlockParam],
    });
    expect(j2!.content).toEqual([{ type: 'text', text: 'c' }]);
  });

  it('records plain-text documents as text and unknown server blocks as labelled text', () => {
    const j = adapter.toJournal({
      role: 'user',
      content: [
        { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'body' }, title: 'notes' },
        { type: 'search_result', source: 's', title: 't', content: [{ type: 'text', text: 'r' }] } as ContentBlockParam,
        { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { q: 1 } } as ContentBlockParam,
      ],
    })!;
    expect(j.content[0]).toEqual({ type: 'text', text: '[document: notes]\nbody' });
    expect(j.content[1]).toMatchObject({ type: 'text' });
    expect((j.content[1] as { text: string }).text).toContain('[search_result]');
    expect((j.content[2] as { text: string }).text).toContain('[server_tool_use]');
  });

  it('drops unsigned thinking, renders text_ref previews, and merges same-role messages', () => {
    const ref = { path: 'x/blobs/a.txt', bytes: 9, sha256: 'a', mediaType: 'text/plain' };
    const journal: JournalMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'q1' }] },
      { role: 'user', content: [{ type: 'text_ref', ref, preview: 'head' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'from openai' }, { type: 'text', text: 'a' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'only unsigned' }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't', content: [{ type: 'text_ref', ref, preview: 'p' }] }] },
    ];
    expect(adapter.fromJournalMessages(journal)).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'q1' }, { type: 'text', text: 'head' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'p' }] }] },
    ]);
  });

  it('degrades binaries it cannot send (unresolved refs, non-pdf documents) to text', () => {
    const ref = { path: 'x', bytes: 1, sha256: 'a', mediaType: 'image/png' };
    const out = adapter.fromJournalMessages([
      {
        role: 'user',
        content: [
          { type: 'image', source: { kind: 'ref', ref } },
          { type: 'document', source: { kind: 'base64', mediaType: 'text/plain', data: Buffer.from('txt').toString('base64') } },
          { type: 'document', source: { kind: 'base64', mediaType: 'application/zip', data: 'AA==' }, title: 'z' },
        ],
      },
    ]);
    expect(out[0]!.content).toEqual([
      { type: 'text', text: '[image unavailable on resume]' },
      { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'txt' } },
      { type: 'text', text: '[document: z unavailable on resume]' },
    ]);
  });

  it('drops tool_result parts of an unknown type instead of replaying undefined', () => {
    const unknownPart = { type: 'video', url: 'x' } as unknown as JournalMessage['content'][number];
    const out = adapter.fromJournalMessages([
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: {} }] },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          toolUseId: 't1',
          content: [{ type: 'text', text: 'ok' }, unknownPart] as never,
        }],
      },
    ]);
    expect(out[1]!.content).toEqual([{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'ok' }] }]);
    const allUnknown = adapter.fromJournalMessages([
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't2', content: [unknownPart] as never }] },
    ]);
    expect(allUnknown[0]!.content).toEqual([{ type: 'tool_result', tool_use_id: 't2' }]);
  });
});

