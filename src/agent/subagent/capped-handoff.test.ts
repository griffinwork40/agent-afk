import { describe, it, expect, vi } from 'vitest';
import type { IAgentSession, Message, OutputEvent } from '../types.js';
import { AbortGraph } from '../abort-graph.js';
import { SubagentHandleImpl } from './handle.js';
import { CappedHandoffAccumulator, isNarrationOnly } from './capped-handoff.js';
import { roundDeliveryNotice, WIND_DOWN_NOTE } from '../providers/shared/tool-loop-cap.js';
import type { TraceSink } from '../trace/index.js';

const findings = 'Confirmed: src/example.ts:12 persists output before returning. Remaining: cancellation untested.';
const message = (content: string): Message => ({ role: 'assistant', content, timestamp: new Date() });

function fakeSession(final: string | null, stopReason = 'tool_use_loop_capped', prior = findings): IAgentSession {
  return {
    sendMessageStream: async function* () {
      yield { type: 'chunk', chunk: { type: 'content', content: prior } } as OutputEvent;
      yield { type: 'progress', progress: {
        taskId: 'cap', description: 'Working', totalTokens: 0, toolUses: 4,
        durationMs: 1, roundsUsed: 2, budget: 2,
      } } as OutputEvent;
      if (final !== null) yield { type: 'message', message: message(final) } as OutputEvent;
      yield { type: 'done', metadata: { stopReason } } as OutputEvent;
    },
  } as unknown as IAgentSession;
}

async function run(final: string | null, stopReason?: string, prior?: string) {
  const write = vi.fn().mockResolvedValue(undefined);
  const sink = { write, getTracePath: () => '' } as unknown as TraceSink;
  const handle = new SubagentHandleImpl('cap-test', fakeSession(final, stopReason, prior),
    new AbortController(), new AbortGraph(), undefined, 5000, undefined, vi.fn(),
    undefined, undefined, undefined, undefined, undefined, sink);
  return { result: await handle.runToResult('probe'), write };
}

describe('capped child handoff', () => {
  it.each(['Now let me write the output file and return the summary.', null])(
    'preserves prior findings when wind down is %s', async final => {
      const { result, write } = await run(final);
      expect(result).toMatchObject({ incomplete: true, incompleteReason: 'tool_use_loop_capped',
        roundsUsed: 2, budget: 2, salvaged: true });
      expect(result.message?.content).toContain(findings);
      expect(write.mock.calls.some(([e]) => e.payload?.incomplete === true && e.payload?.roundsUsed === 2)).toBe(true);
      expect(result.trace?.toolCalls).toHaveLength(0);
    },
  );
  it('keeps a compliant wind down as the actual deliverable, still incomplete', async () => {
    const { result } = await run('Findings: no duplicate side effects. Remaining: live verification.');
    expect(result.incomplete).toBe(true);
    expect(result.salvaged).toBeUndefined();
    expect(result.message?.content).toBe('Findings: no duplicate side effects. Remaining: live verification.');
  });
  it('marks empty output incomplete even when nothing can be salvaged', async () => {
    const { result } = await run(null, 'tool_use_loop_capped', '');
    expect(result.incomplete).toBe(true);
    expect(result.message?.content).toContain('no substantive assistant findings');
  });
  it('leaves non capped children unchanged', async () => {
    const { result } = await run('Clean answer.', 'end_turn');
    expect(result.incomplete).toBeUndefined();
    expect(result.roundsUsed).toBeUndefined();
    expect(result.message?.content).toBe('Clean answer.');
  });
  it('exposes the actual journal pointer without using renderer nesting identities', () => {
    const accumulator = new CappedHandoffAccumulator();
    const session = { messageJournal: { path: '/actual/root/subagents/child.jsonl' } } as unknown as IAgentSession;
    const msg = accumulator.finish(message('Findings.'), session);
    expect(msg.metadata?.['journalPath']).toBe('/actual/root/subagents/child.jsonl');
  });
  it('does not overwrite newer round findings with an older message', () => {
    const accumulator = new CappedHandoffAccumulator();
    accumulator.onEvent({ type: 'message', message: message('Older finding.') });
    accumulator.onEvent({ type: 'chunk', chunk: { type: 'content', content: findings } });
    accumulator.onEvent({ type: 'progress', progress: { taskId: 'x', description: '', totalTokens: 0, toolUses: 1, durationMs: 0, roundsUsed: 1, budget: 1 } });
    accumulator.onEvent({ type: 'message', message: message('Now let me write the report.') });
    expect(accumulator.finish(message('Now let me write the report.'), {} as unknown as IAgentSession).content).toContain(findings);
  });
  it('salvages from history when intermediate progress events are unavailable', () => {
    const accumulator = new CappedHandoffAccumulator();
    const session = { getHistory: () => [message(findings), message('Now let me write the report.')] } as unknown as IAgentSession;
    expect(accumulator.finish(message('Now let me write the report.'), session).content).toContain(findings);
  });
  it('never classifies a short finding or multiline report as narration', () => {
    expect(isNarrationOnly('Confirmed: output persists.')).toBe(false);
    expect(isNarrationOnly('Now let me write the report.\nFinding: persistence works.')).toBe(false);
  });
  it('warns exactly once, retains usable persistence time, and never increases caps', () => {
    expect(Array.from({ length: 8 }, (_, i) => roundDeliveryNotice(i, 7)).filter(Boolean)).toHaveLength(1);
    expect(roundDeliveryNotice(4, 7)).toContain('3 tool-use rounds remain');
    expect(roundDeliveryNotice(1, 2)).toContain('1 tool-use rounds remain');
    expect(roundDeliveryNotice(1, 0)).toBeNull();
    expect(roundDeliveryNotice(0, 1)).toBeNull();
    expect(WIND_DOWN_NOTE).toContain('This reply IS the deliverable');
  });
});
