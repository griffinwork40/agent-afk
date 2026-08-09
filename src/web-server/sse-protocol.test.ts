import { describe, it, expect } from 'vitest';
import { formatSseFrame, parseSseChunk } from './sse-protocol.js';

describe('formatSseFrame', () => {
  it('formats a frame with id + data, terminated by a blank line', () => {
    const out = formatSseFrame({ id: '1', data: { kind: 'meta', sessionId: 'abc' } });
    expect(out).toBe('id: 1\ndata: {"kind":"meta","sessionId":"abc"}\n\n');
  });

  it('omits the id line when id is undefined', () => {
    const out = formatSseFrame({ data: { kind: 'closed' } });
    expect(out).toBe('data: {"kind":"closed"}\n\n');
  });

  it('serializes Date fields as ISO strings via jsonDateReplacer', () => {
    const resetsAt = new Date('2026-01-01T00:00:00.000Z');
    const out = formatSseFrame({ data: { kind: 'paused', resetsAt } });
    expect(out).toContain('"resetsAt":"2026-01-01T00:00:00.000Z"');
  });

  it('serializes Error fields as {message,name} via jsonDateReplacer', () => {
    const out = formatSseFrame({ data: { kind: 'error', err: new Error('boom') } });
    expect(out).toContain('"message":"boom"');
    expect(out).toContain('"name":"Error"');
    expect(out).not.toContain('"stack"');
  });

  it('never embeds a literal newline in the data payload (single-line guarantee)', () => {
    const out = formatSseFrame({ data: { text: 'line1\nline2' } });
    const dataLine = out.split('\n').find((l) => l.startsWith('data: '));
    expect(dataLine).toBeDefined();
    expect(dataLine).toContain('\\n');
  });
});

describe('parseSseChunk', () => {
  it('round-trips a single frame written by formatSseFrame', () => {
    const frame = formatSseFrame({ id: '42', data: { kind: 'assistant', text: 'hi' } });
    const { events, remainder } = parseSseChunk(frame);
    expect(remainder).toBe('');
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ id: '42', data: '{"kind":"assistant","text":"hi"}' });
    expect(JSON.parse(events[0]!.data)).toEqual({ kind: 'assistant', text: 'hi' });
  });

  it('parses multiple concatenated frames in one chunk', () => {
    const chunk =
      formatSseFrame({ id: '1', data: { n: 1 } }) + formatSseFrame({ id: '2', data: { n: 2 } });
    const { events, remainder } = parseSseChunk(chunk);
    expect(remainder).toBe('');
    expect(events.map((e) => e.id)).toEqual(['1', '2']);
    expect(events.map((e) => JSON.parse(e.data))).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('holds back an incomplete trailing frame as remainder', () => {
    const complete = formatSseFrame({ id: '1', data: { n: 1 } });
    const partial = 'id: 2\ndata: {"n":2}'; // no blank-line terminator yet
    const { events, remainder } = parseSseChunk(complete + partial);
    expect(events).toHaveLength(1);
    expect(remainder).toBe(partial);
  });

  it('reassembles a frame split mid-chunk across two parseSseChunk calls', () => {
    const full = formatSseFrame({ id: '7', data: { kind: 'done' } });
    const splitPoint = Math.floor(full.length / 2);
    const first = parseSseChunk(full.slice(0, splitPoint));
    expect(first.events).toHaveLength(0);
    const second = parseSseChunk(first.remainder + full.slice(splitPoint));
    expect(second.events).toHaveLength(1);
    expect(JSON.parse(second.events[0]!.data)).toEqual({ kind: 'done' });
  });

  it('handles CRLF-terminated frames', () => {
    const chunk = 'id: 1\r\ndata: {"n":1}\r\n\r\n';
    const { events, remainder } = parseSseChunk(chunk);
    expect(remainder).toBe('');
    expect(events).toEqual([{ id: '1', data: '{"n":1}' }]);
  });

  it('skips a frame with no data: line rather than throwing', () => {
    const chunk = 'id: 1\n\ndata: {"n":2}\n\n';
    const { events } = parseSseChunk(chunk);
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.data)).toEqual({ n: 2 });
  });

  it('returns empty events + empty remainder for an empty buffer', () => {
    expect(parseSseChunk('')).toEqual({ events: [], remainder: '' });
  });

  it('a frame with data containing an escaped newline parses back to one data line', () => {
    const frame = formatSseFrame({ data: { text: 'a\nb' } });
    const { events } = parseSseChunk(frame);
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.data)).toEqual({ text: 'a\nb' });
  });
});
