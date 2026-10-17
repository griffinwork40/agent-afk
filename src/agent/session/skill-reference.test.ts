import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OutputEvent } from '../types.js';

const appendRoutingDecision = vi.fn(async (_entry: unknown) => {});
vi.mock('../routing-telemetry.js', () => ({
  appendRoutingDecision: (entry: unknown) => appendRoutingDecision(entry),
}));

const {
  scanSkillReferences,
  invokedSkillName,
  observeSkillReferences,
  emitReferenceRows,
} = await import('./skill-reference.js');

function names(text: string): string[] {
  return scanSkillReferences(text).names;
}

describe('scanSkillReferences', () => {
  // Real mid-message invocations from operator history (2026-09/10).
  it.each([
    ['lets run /session-handoff', ['session-handoff']],
    ['can you /research what we need to do to switch it to 5.1', ['research']],
    ['any that arent being tackled? /tackle-issues on those', ['tackle-issues']],
    ['to the user it seems that this is redundant /gather to see why', ['gather']],
    ['should we /simplify or /refactor ?', ['simplify', 'refactor']],
    ['i wanna run /devils-advocate on the approach.', ['devils-advocate']],
    ['run /agent-workflow-amplifiers:review on it', ['review']],
    ['(try /orient)', ['orient']],
  ])('finds %j', (text, expected) => {
    expect(names(text)).toEqual(expected);
  });

  it('ignores paths, files, and URLs', () => {
    expect(names('look in /tmp/foo and src/agent/x.ts and /Users/me')).toEqual([]);
    expect(names('see https://github.com/x/review and /notes.md')).toEqual([]);
  });

  it('ignores code spans and fenced blocks', () => {
    expect(names('copy `/tackle-issues 12` for me')).toEqual([]);
    expect(names('like this:\n```\n/pr-triage --limit 3\n```\nok?')).toEqual([]);
  });

  it('ignores framework-wrapped blocks and quoted lines', () => {
    const bg = '<background-subagent-result jobId="x"><task>A /brief-to-primitives run</task></background-subagent-result>\nthoughts?';
    expect(names(bg)).toEqual([]);
    expect(names('> earlier you said /ship\nwhat did you mean')).toEqual([]);
  });

  it('skips slash-path dispatches and a leading token', () => {
    const crumb = '<command-name>/god</command-name>\n<command-message>god</command-message>\n<command-args>what should i use /god for?</command-args>';
    expect(names(crumb)).toEqual([]);
    expect(names('/god what is the most useful /research query')).toEqual(['research']);
  });

  it('dedupes and reports question marks', () => {
    const scan = scanSkillReferences('should we run /pr-triage first? or /pr-triage later');
    expect(scan).toEqual({ names: ['pr-triage'], inQuestion: true });
  });

  it('reads text blocks of a block-array message', () => {
    const scan = scanSkillReferences([{ type: 'text', text: 'lets run /diagnose' }]);
    expect(scan.names).toEqual(['diagnose']);
  });
});

function skillCall(name: string, pending = false): OutputEvent {
  return {
    type: 'chunk',
    chunk: {
      type: 'tool_use_detail',
      toolUseId: 't1',
      toolName: 'skill',
      toolInput: JSON.stringify({ name }),
      ...(pending ? { pending: true as const } : {}),
    },
  };
}

describe('invokedSkillName', () => {
  it('extracts bare names from skill tool calls only', () => {
    expect(invokedSkillName(skillCall('agent-workflow-amplifiers:devils-advocate'))).toBe('devils-advocate');
    expect(invokedSkillName(skillCall('research', true))).toBeUndefined();
    expect(invokedSkillName({ type: 'done' })).toBeUndefined();
  });

  it('returns undefined when toolInput is a scalar JSON value', () => {
    const event: OutputEvent = {
      type: 'chunk',
      chunk: {
        type: 'tool_use_detail',
        toolUseId: 't2',
        toolName: 'skill',
        toolInput: '"scalar"',
      },
    };
    expect(invokedSkillName(event)).toBeUndefined();
  });
});

async function* events(list: OutputEvent[]): AsyncIterableIterator<OutputEvent> {
  for (const e of list) yield e;
}

const ctx = {
  origin: 'cli' as const,
  sessionId: 's-1',
  resolveKnownNames: async (c: readonly string[]) => new Set(c.filter((n) => n !== 'tmpx')),
};

describe('observeSkillReferences', () => {
  beforeEach(() => appendRoutingDecision.mockClear());

  it('passes every event through unchanged and logs hit/miss rows', async () => {
    const input: OutputEvent[] = [skillCall('research'), { type: 'done' }];
    const scan = { names: ['research', 'devils-advocate'], inQuestion: false };
    const out: OutputEvent[] = [];
    for await (const e of observeSkillReferences(scan, events(input), ctx)) out.push(e);
    expect(out).toEqual(input);
    await vi.waitFor(() => expect(appendRoutingDecision).toHaveBeenCalledTimes(2));
    expect(appendRoutingDecision.mock.calls.map((c) => c[0])).toEqual([
      expect.objectContaining({ event: 'skill.reference_seen', requested_name: 'research', invoked: true, in_question: false, origin: 'cli', actor: 'main', parent_session_id: 's-1' }),
      expect.objectContaining({ requested_name: 'devils-advocate', invoked: false }),
    ]);
  });

  it('logs nothing when the consumer stops early', async () => {
    const scan = { names: ['research'], inQuestion: false };
    for await (const _e of observeSkillReferences(scan, events([{ type: 'done' }]), ctx)) break;
    await new Promise((r) => setTimeout(r, 10));
    expect(appendRoutingDecision).not.toHaveBeenCalled();
  });

  it('logs nothing when the turn yielded an error', async () => {
    const scan = { names: ['research'], inQuestion: false };
    const input: OutputEvent[] = [{ type: 'error', error: new Error('boom') }];
    for await (const _e of observeSkillReferences(scan, events(input), ctx)) { /* drain */ }
    await new Promise((r) => setTimeout(r, 10));
    expect(appendRoutingDecision).not.toHaveBeenCalled();
  });
});

describe('emitReferenceRows', () => {
  beforeEach(() => appendRoutingDecision.mockClear());

  it('drops unresolved names unless the model dispatched them', async () => {
    await emitReferenceRows({ names: ['tmpx', 'research'], inQuestion: true }, new Set(), ctx);
    expect(appendRoutingDecision).toHaveBeenCalledTimes(1);
    expect(appendRoutingDecision.mock.calls[0]![0]).toMatchObject({ requested_name: 'research', in_question: true });
    appendRoutingDecision.mockClear();
    await emitReferenceRows({ names: ['tmpx'], inQuestion: false }, new Set(['tmpx']), ctx);
    expect(appendRoutingDecision.mock.calls[0]![0]).toMatchObject({ requested_name: 'tmpx', invoked: true });
  });
});
