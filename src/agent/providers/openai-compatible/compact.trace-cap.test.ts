import { describe, expect, it } from 'vitest';
import { compactOpenAIHistory, openaiCompactionOps } from './compact.js';
import type { OpenAIMessage } from './messages.js';
import { renderTranscript } from '../shared/compaction.js';
import { InMemoryTraceWriter } from '../../trace/writer.js';

describe('OpenAI compaction trace input cap', () => {
  it.each([100, 10_000, undefined])('records the exact cap drop for budget %s (undefined = uncapped)', async (budget) => {
    const priorTurns: OpenAIMessage[] = [
      { role: 'user', content: 'opening ' + 'x'.repeat(1_000) },
      { role: 'assistant', content: 'older reply' },
      { role: 'user', content: 'keep this turn' },
      { role: 'assistant', content: 'recent reply' },
      { role: 'user', content: 'newest turn' },
    ];
    const olderSlice = priorTurns.slice(0, 2);
    const renderedLength = renderTranscript(olderSlice, openaiCompactionOps).length;
    const writer = new InMemoryTraceWriter();
    const result = await compactOpenAIHistory({
      priorTurns, traceWriter: writer, isClosed: false, isIdle: true,
      beginAbort: () => new AbortController(), clearAbort: () => {},
      ...(budget !== undefined ? { summarizerInputMaxChars: budget } : {}),
      summarize: async () => 'Summary',
    });
    expect(result.compacted).toBe(true);
    const event = writer.events.find((e) => e.kind === 'compaction');
    if (event?.kind !== 'compaction') throw new Error('missing compaction');
    expect(event.payload.summarizerInputCharsDropped).toBe(
      budget === undefined ? 0 : Math.max(0, renderedLength - budget),
    );
    expect(writer.getInlineCompactionPayload(event.seq)?.preCompactionMessages).toEqual(olderSlice);
  });
});
