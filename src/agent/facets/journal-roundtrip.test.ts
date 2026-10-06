/**
 * Round trip (#2978): a compose result with partial nodes, written through a
 * provider's real tool-result commit site and journal adapter, reaches the
 * facet. Path: tool result → native history → JournalSync → journal file →
 * readJournalRecords → journal-adapter → deriveSessionFacet.
 *
 * Before #2978 the journal write path dropped `incomplete`, so a facet rebuilt
 * from the journal alone reported no partial compose nodes.
 */

import { describe, it, expect } from 'vitest';
import type { MessageParam } from '@anthropic-ai/sdk/resources';
import { useTmpAfkHome } from '../journal/__test-utils__/helpers.js';
import { createMessageJournal, JournalSync, readJournalRecords } from '../journal/index.js';
import { anthropicJournalAdapter } from '../providers/anthropic-direct/journal-adapter.js';
import { emitAndCommitToolResults } from '../providers/anthropic-direct/loop/tool-results.js';
import type { RunTurnInput, ToolCall, ToolResult } from '../providers/anthropic-direct/types.js';
import { openAIJournalAdapter } from '../providers/openai-compatible/journal-adapter.js';
import { toolResultsToMessages } from '../providers/openai-compatible/loop.js';
import type { OpenAIMessage } from '../providers/openai-compatible/messages.js';
import { partialNodeFlag } from '../tools/compose-executor.partial.js';
import { journalRecordsToToolEvents } from './journal-adapter.js';
import { deriveSessionFacet } from './derive.js';
import { SessionFacetSchema, type StoredSessionInput } from './schema.js';

useTmpAfkHome();

const SESSION: StoredSessionInput = { sessionId: 'rt', model: 'm', startedAt: 0, savedAt: 1, totalTurns: 1, turns: [] };
const signal = new AbortController().signal;

function call(id: string): ToolCall {
  return { id, name: 'compose', input: { nodes: [] }, signal };
}

/** A compose result as ComposeExecutor builds it, with `n` partial nodes. */
function composeResult(n: number): ToolResult {
  const partial = Array.from({ length: n }, (_, i) => ({ id: `node-${i}`, stopReason: 'soft_deadline' }));
  return { content: 'dag output', isError: false, ...partialNodeFlag(partial) };
}

async function drain(gen: AsyncGenerator<unknown, unknown, void>): Promise<void> {
  for (;;) if ((await gen.next()).done) return;
}

async function facetFromJournal(sessionId: string) {
  const events = journalRecordsToToolEvents(readJournalRecords(sessionId));
  return { events, facet: deriveSessionFacet(SESSION, { journalEvents: events }) };
}

describe('journal round trip for compose partial nodes (#2978)', () => {
  it('anthropic: write → journal-adapter → derive gives compose_partial_nodes: 1', async () => {
    const journal = createMessageJournal({ getSessionId: () => 'rt-anthropic' });
    const sync = new JournalSync<MessageParam>(journal, anthropicJournalAdapter);
    const messages: MessageParam[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'c1', name: 'compose', input: {} },
          { type: 'tool_use', id: 'c2', name: 'compose', input: {} },
        ],
      },
    ];
    const input = { messages, ctx: { sessionId: 'rt-anthropic' } } as unknown as RunTurnInput;
    await drain(emitAndCommitToolResults([call('c1'), call('c2')], [composeResult(3), composeResult(0)], new Map(), input));
    sync.sync(messages);
    await journal.flush();

    // The wire block itself never carries the harness-only flag.
    const wire = JSON.stringify(messages[2]);
    expect(wire).not.toContain('incomplete');

    const { events, facet } = await facetFromJournal('rt-anthropic');
    expect(events.find((e) => e.toolUseId === 'c1')).toMatchObject({ incomplete: true, partialNodeCount: 3 });
    expect(events.find((e) => e.toolUseId === 'c2')?.incomplete).toBeUndefined();
    expect(facet.compose_partial_nodes).toBe(1);
    expect(facet.compose_partial_node_count).toBe(3);
    expect(SessionFacetSchema.safeParse(facet).success).toBe(true);
  });

  it('anthropic: flags survive resume (fromJournalMessages) and a full resync', async () => {
    const journal = createMessageJournal({ getSessionId: () => 'rt-resume' });
    const sync = new JournalSync<MessageParam>(journal, anthropicJournalAdapter);
    const messages: MessageParam[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'compose', input: {} }] },
    ];
    const input = { messages, ctx: { sessionId: 'rt-resume' } } as unknown as RunTurnInput;
    await drain(emitAndCommitToolResults([call('c1')], [composeResult(2)], new Map(), input));
    sync.sync(messages);
    await journal.flush();

    const folded = readJournalRecords('rt-resume').flatMap((r) => (r.kind === 'append' ? [r.message] : []));
    const resumed = anthropicJournalAdapter.fromJournalMessages(folded);
    const back = resumed.map((m) => anthropicJournalAdapter.toJournal(m));
    const block = back[1]!.content[0]!;
    expect(block).toMatchObject({ type: 'tool_result', incomplete: true, partialNodeCount: 2 });
  });

  it('openai-compatible: write → journal-adapter → derive gives compose_partial_nodes: 1', async () => {
    const journal = createMessageJournal({ getSessionId: () => 'rt-openai' });
    const sync = new JournalSync<OpenAIMessage>(journal, openAIJournalAdapter);
    const priorTurns: OpenAIMessage[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'compose', arguments: '{}' } }],
      } as unknown as OpenAIMessage,
    ];
    for (const m of toolResultsToMessages([{ call: call('c1'), result: composeResult(2) }])) {
      expect(JSON.stringify(m)).not.toContain('incomplete');
      priorTurns.push(m as unknown as OpenAIMessage);
    }
    sync.sync(priorTurns);
    await journal.flush();

    const { facet } = await facetFromJournal('rt-openai');
    expect(facet.compose_partial_nodes).toBe(1);
    expect(facet.compose_partial_node_count).toBe(2);
  });
});
