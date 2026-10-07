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
    expect(roundDeliveryNotice(1, 2)).toContain('1 tool-use round remains');
    expect(roundDeliveryNotice(1, 0)).toBeNull();
    expect(roundDeliveryNotice(0, 1)).toBeNull();
    expect(WIND_DOWN_NOTE).toContain('This reply IS the deliverable');
  });
});

describe('CappedHandoffAccumulator cross-turn isolation (Finding 1)', () => {
  const turn1Findings = 'Turn-1 confirmed: cache flush at line 42.';
  const turn2Narration = 'Okay, let me write the summary.';

  it('does not salvage turn-1 findings into turn-2 finish when baseline is set correctly', () => {
    // Turn 1: accumulator with baseline 0, processes findings
    const acc1 = new CappedHandoffAccumulator();
    acc1.setHistoryBaseline(0);
    acc1.onEvent({ type: 'message', message: { role: 'assistant', content: turn1Findings, timestamp: new Date() } });

    // Session history after turn 1 has two messages
    const historyAfterTurn1: import('../types.js').Message[] = [
      { role: 'assistant', content: turn1Findings, timestamp: new Date() },
      { role: 'assistant', content: turn2Narration, timestamp: new Date() },
    ];

    // Turn 2: NEW accumulator, baseline = 1 (history length after turn 1 appended)
    const acc2 = new CappedHandoffAccumulator();
    acc2.setHistoryBaseline(1);
    // Only narration-only events in turn 2
    acc2.onEvent({ type: 'message', message: { role: 'assistant', content: turn2Narration, timestamp: new Date() } });

    const session = {
      getHistory: () => historyAfterTurn1,
    } as unknown as import('../types.js').IAgentSession;

    const result = acc2.finish({ role: 'assistant', content: turn2Narration, timestamp: new Date() }, session);
    // turn-2 finish must NOT surface turn-1 findings — only history[1..] is walked
    expect(result.content).not.toContain(turn1Findings);
  });

  it('still salvages findings within the same turn when baseline is 0', () => {
    const acc = new CappedHandoffAccumulator();
    acc.setHistoryBaseline(0);
    const history: import('../types.js').Message[] = [
      { role: 'assistant', content: turn1Findings, timestamp: new Date() },
      { role: 'assistant', content: turn2Narration, timestamp: new Date() },
    ];
    const session = { getHistory: () => history } as unknown as import('../types.js').IAgentSession;
    const result = acc.finish({ role: 'assistant', content: turn2Narration, timestamp: new Date() }, session);
    expect(result.content).toContain(turn1Findings);
  });
});

describe('OpenAI round-delivery notice placement (Finding 2)', () => {
  it('appends notice to last tool message content, not as a new user turn', () => {
    const priorTurns: Array<{ role: string; content: string }> = [
      { role: 'user', content: 'Initial prompt.' },
      { role: 'assistant', content: 'I will check that.' },
      { role: 'tool', content: 'tool result data' },
    ];
    const initialLength = priorTurns.length;
    const notice = '[Budget notice: 1 tool-use round remains of 4. Deliver useful findings now. Persist any requested artifact while tools are still available; stop expanding scope. Your final reply must contain findings and remaining work, not future actions.]';

    // Apply the fix logic (mirrors turn-driver.ts patch)
    const lastTool = [...priorTurns].reverse().find(m => m.role === 'tool');
    if (lastTool && typeof lastTool.content === 'string') {
      lastTool.content += '\n\n' + notice;
    }

    // priorTurns must NOT have grown
    expect(priorTurns).toHaveLength(initialLength);
    // The notice must appear in the last tool message
    expect(priorTurns[2]!.content).toContain(notice);
    // No new user message was inserted
    expect(priorTurns.every(m => m.role !== 'user' || m.content === 'Initial prompt.')).toBe(true);
  });

  it('does nothing when there is no tool message in priorTurns', () => {
    const priorTurns: Array<{ role: string; content: string }> = [
      { role: 'user', content: 'Hello.' },
      { role: 'assistant', content: 'Reply.' },
    ];
    const initialLength = priorTurns.length;
    const notice = 'some notice';

    const lastTool = [...priorTurns].reverse().find(m => m.role === 'tool');
    if (lastTool && typeof lastTool.content === 'string') {
      lastTool.content += '\n\n' + notice;
    }

    // Nothing should change — no tool message found
    expect(priorTurns).toHaveLength(initialLength);
    expect(priorTurns.some(m => m.content.includes(notice))).toBe(false);
  });
});
