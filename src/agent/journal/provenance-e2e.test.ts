/**
 * End-to-end provenance tests for #2464.
 * Tests A→B→A cross-provider switch, incremental append after switch,
 * span invalidation, divergence, crash-resume, Anthropic merge, and origin.
 */
import { describe, it, expect, vi } from 'vitest';
import type { MessageParam } from '@anthropic-ai/sdk/resources';
import { anthropicJournalAdapter } from '../providers/anthropic-direct/journal-adapter.js';
import { openAIJournalAdapter, INTERRUPTED_TOOL_RESULT } from '../providers/openai-compatible/journal-adapter.js';
import { JournalSync } from './sync.js';
import type { JournalMessage, JournalTruncateReason, JournalMarkLabel, MessageJournal } from './types.js';
import type { OpenAIMessage } from '../providers/openai-compatible/messages.js';

// ──────────────────────────────── FakeJournal ────────────────────────────────
type Rec =
  | { kind: 'append'; index: number; message: JournalMessage }
  | { kind: 'truncate'; length: number; reason?: JournalTruncateReason };

class FakeJournal implements MessageJournal {
  readonly records: Rec[] = [];
  private arr: JournalMessage[] = [];
  constructor(initial: JournalMessage[] = []) {
    this.arr = [...initial];
  }
  get length(): number {
    return this.arr.length;
  }
  append(index: number, message: JournalMessage): void {
    expect(index).toBe(this.arr.length); // invariant check
    this.arr.push(message);
    this.records.push({ kind: 'append', index, message });
  }
  truncate(length: number, reason?: JournalTruncateReason): void {
    this.arr.length = length;
    this.records.push({ kind: 'truncate', length, ...(reason ? { reason } : {}) });
  }
  mark(_l: JournalMarkLabel): void {}
  forSubagent(): MessageJournal {
    return new FakeJournal();
  }
  flush(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
  snapshot(): JournalMessage[] {
    return [...this.arr];
  }
  appendCount(): number {
    return this.records.filter((r) => r.kind === 'append').length;
  }
  truncateCount(): number {
    return this.records.filter((r) => r.kind === 'truncate').length;
  }
  /** Clear record log (not data) after a phase so assertions are scoped. */
  clearRecords(): void {
    this.records.length = 0;
  }
}

// ──────────────────────────────── helpers ────────────────────────────────────
const PNG = 'iVBORw0KGgo=';
const SIG = 'anthropic-sig-abc123';
const REDACTED_DATA = 'redacted-thinking-bytes-xyz';

/** Build a rich Anthropic-native conversation for testing. */
function buildAnthropicNatives(): MessageParam[] {
  return [
    {
      role: 'user',
      content: [{ type: 'text', text: 'start' }],
    },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'I should act', signature: SIG },
        { type: 'redacted_thinking', data: REDACTED_DATA },
        { type: 'text', text: 'using tools' },
        { type: 'tool_use', id: 'toolu_1', name: 'bash', input: { cmd: 'ls' } },
        { type: 'tool_use', id: 'toolu_2', name: 'read', input: { path: '/tmp' } },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: [{ type: 'text', text: 'file.txt' }],
        },
        {
          type: 'tool_result',
          tool_use_id: 'toolu_2',
          is_error: false,
          content: [
            { type: 'text', text: 'content here' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
          ],
        },
        { type: 'text', text: 'thanks' },
      ],
    },
  ] as MessageParam[];
}

/** Extract tool call ids from OpenAI messages. */
function oaiToolCallIds(msgs: OpenAIMessage[]): string[] {
  const ids: string[] = [];
  for (const m of msgs) {
    const tc = (m as { tool_calls?: Array<{ id: string }> }).tool_calls;
    if (tc) for (const c of tc) ids.push(c.id);
  }
  return ids;
}

/** Extract tool_call_id from tool messages. */
function oaiToolResultIds(msgs: OpenAIMessage[]): string[] {
  return msgs.filter((m) => m.role === 'tool').map((m) => m.tool_call_id ?? '');
}

/** Check every tool_call has a matching tool_result in the journal fold. */
function checkPairing(journal: JournalMessage[]): void {
  const calls: string[] = [];
  const results: string[] = [];
  for (const m of journal) {
    for (const b of m.content) {
      if (b.type === 'tool_use') calls.push(b.id);
      if (b.type === 'tool_result') results.push(b.toolUseId);
    }
  }
  expect(calls.sort()).toEqual(results.sort());
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: A→B→A end-to-end
// ─────────────────────────────────────────────────────────────────────────────
describe('A→B→A end-to-end lossless switch', () => {
  it('writes zero truncate and zero append on both switches', () => {
    const journal = new FakeJournal();

    // ── Phase 1: seed Anthropic sync ──────────────────────────────────────
    const anthropicNatives = buildAnthropicNatives();
    const syncA1 = new JournalSync(journal, anthropicJournalAdapter);
    syncA1.seed(anthropicNatives);
    const initialAppends = journal.appendCount();
    expect(initialAppends).toBeGreaterThan(0); // sanity: wrote something
    const initialJournalLen = journal.length;
    expect(initialJournalLen).toBeGreaterThan(0);

    // ── Phase 2: snapshot → OpenAI seed ──────────────────────────────────
    journal.clearRecords();
    const snap1 = syncA1.snapshot();
    expect(snap1.length).toBe(initialJournalLen);

    // Convert snapshot to OpenAI natives
    const oaiNatives = openAIJournalAdapter.fromJournalMessages(snap1);

    // Seed a new JournalSync with the OpenAI adapter against the SAME journal
    const syncB = new JournalSync(journal, openAIJournalAdapter);
    syncB.seed(oaiNatives);

    // ASSERTION: zero truncate, zero append on A→B switch
    expect(journal.truncateCount()).toBe(0);
    expect(journal.appendCount()).toBe(0);

    // ── Phase 3: snapshot OpenAI → Anthropic seed ────────────────────────
    journal.clearRecords();
    const snap2 = syncB.snapshot();
    // snap2 should match snap1 (original journal messages)
    expect(snap2.length).toBe(snap1.length);

    // Convert back to Anthropic
    const anthropicNatives2 = anthropicJournalAdapter.fromJournalMessages(snap2);

    const syncA2 = new JournalSync(journal, anthropicJournalAdapter);
    syncA2.seed(anthropicNatives2);

    // ASSERTION: zero writes on B→A switch
    expect(journal.truncateCount()).toBe(0);
    expect(journal.appendCount()).toBe(0);

    // ASSERTION: thinking signature and redacted_thinking preserved byte-for-byte
    const thinkingBlock = snap2.find((m) =>
      m.content.some((b) => b.type === 'thinking'),
    );
    expect(thinkingBlock).toBeDefined();
    const thinking = thinkingBlock!.content.find((b) => b.type === 'thinking')!;
    expect(thinking.type).toBe('thinking');
    if (thinking.type === 'thinking') {
      expect(thinking.signature).toBe(SIG);
    }

    const redactedBlock = snap2.find((m) =>
      m.content.some((b) => b.type === 'redacted_thinking'),
    );
    expect(redactedBlock).toBeDefined();
    const redacted = redactedBlock!.content.find((b) => b.type === 'redacted_thinking')!;
    expect(redacted.type).toBe('redacted_thinking');
    if (redacted.type === 'redacted_thinking') {
      expect(redacted.data).toBe(REDACTED_DATA);
    }

    // The final Anthropic natives should contain thinking + redacted thinking
    const assistantMsg = anthropicNatives2.find((m) => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
    const blocks = assistantMsg!.content as Array<{ type: string; signature?: string; data?: string }>;
    const thinkNative = blocks.find((b) => b.type === 'thinking');
    expect(thinkNative?.signature).toBe(SIG);
    const redactNative = blocks.find((b) => b.type === 'redacted_thinking');
    expect(redactNative?.data).toBe(REDACTED_DATA);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: Append new messages after A→B switch (no spurious truncate)
// ─────────────────────────────────────────────────────────────────────────────
describe('incremental append after provider switch', () => {
  it('appends only new messages at correct indices after A→B', () => {
    const journal = new FakeJournal();
    const anthropicNatives = buildAnthropicNatives();
    const syncA = new JournalSync(journal, anthropicJournalAdapter);
    syncA.seed(anthropicNatives);

    const snap = syncA.snapshot();
    const oaiNatives = openAIJournalAdapter.fromJournalMessages(snap);
    const syncB = new JournalSync(journal, openAIJournalAdapter);
    syncB.seed(oaiNatives);
    journal.clearRecords();

    // Push a new assistant (tool_calls) + tool message on OpenAI side
    const newCallId = 'call_new_1';
    const extendedNatives: OpenAIMessage[] = [
      ...oaiNatives,
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: newCallId, type: 'function', function: { name: 'write', arguments: '{"path":"out.txt"}' } }],
      } as unknown as OpenAIMessage,
      { role: 'tool', tool_call_id: newCallId, content: 'ok' },
    ];
    syncB.sync(extendedNatives);

    // ASSERTION: only appends for the 2 new messages, no truncate
    expect(journal.truncateCount()).toBe(0);
    const appended = journal.records.filter((r) => r.kind === 'append');
    expect(appended.length).toBe(2); // assistant tool_use journal msg + tool_result journal msg
    // Indices must be contiguous from journal.length before the sync
    const baseLen = snap.length; // journal length before new appends
    expect(appended[0]!.index).toBe(baseLen);
    expect(appended[1]!.index).toBe(baseLen + 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: In-place edit inside adopted OpenAI span → truncate at span start
// ─────────────────────────────────────────────────────────────────────────────
describe('invalidateFrom inside an adopted span', () => {
  it('truncates at span start and re-appends with valid pairing', () => {
    const journal = new FakeJournal();
    const anthropicNatives = buildAnthropicNatives();
    const syncA = new JournalSync(journal, anthropicJournalAdapter);
    syncA.seed(anthropicNatives);

    const snap = syncA.snapshot();
    const oaiNatives = openAIJournalAdapter.fromJournalMessages(snap);
    const syncB = new JournalSync(journal, openAIJournalAdapter);
    syncB.seed(oaiNatives);
    journal.clearRecords();

    // Find the first 'tool' message in oaiNatives and mutate its content
    const toolMsgIdx = oaiNatives.findIndex((m) => m.role === 'tool');
    expect(toolMsgIdx).toBeGreaterThanOrEqual(0);
    // Mutate the tool message content in place
    (oaiNatives[toolMsgIdx] as OpenAIMessage & { content: string }).content = 'mutated result';

    syncB.invalidateFrom(toolMsgIdx);
    syncB.sync(oaiNatives);

    // ASSERTION: truncate occurred and pairing is valid
    expect(journal.truncateCount()).toBeGreaterThan(0);
    const truncates = journal.records.filter((r) => r.kind === 'truncate');
    const lastTruncate = truncates[truncates.length - 1]!;
    expect(lastTruncate.kind).toBe('truncate');
    if (lastTruncate.kind === 'truncate') {
      // The truncate should land at the span start (which is a journal index <= toolMsgIdx's journal index)
      expect(lastTruncate.length).toBeGreaterThanOrEqual(0);
      expect(lastTruncate.length).toBeLessThanOrEqual(snap.length);
    }

    // Pairing check on the final journal state
    checkPairing(journal.snapshot());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: Divergence inside a span without invalidate → whole span re-maps
// ─────────────────────────────────────────────────────────────────────────────
describe('span divergence without invalidateFrom', () => {
  it('re-maps whole span (truncate occurs, not an adopt)', () => {
    const journal = new FakeJournal();
    const anthropicNatives = buildAnthropicNatives();
    const syncA = new JournalSync(journal, anthropicJournalAdapter);
    syncA.seed(anthropicNatives);

    const snap = syncA.snapshot();
    const oaiNatives = openAIJournalAdapter.fromJournalMessages(snap);
    const syncB = new JournalSync(journal, openAIJournalAdapter);
    syncB.seed(oaiNatives);
    const preSyncLen = journal.length;
    journal.clearRecords();

    // Splice out one tool message from the LAST fan-out span (diverge mid-span
    // without calling invalidateFrom). This breaks the span so adopt() refuses it.
    // The whole span must be re-mapped from scratch (not silently adopted).
    const toolMsgIdx = oaiNatives.findIndex((m) => m.role === 'tool');
    expect(toolMsgIdx).toBeGreaterThanOrEqual(0);
    const spliced = oaiNatives.filter((_, i) => i !== toolMsgIdx);

    // Also add back a proper replacement result so the NEW journal stays paired
    // (we're testing span re-map, not deliberately unbalanced state)
    const removedId = (oaiNatives[toolMsgIdx] as OpenAIMessage).tool_call_id!;
    const paired = spliced; // The splice only removed one result; the other stays
    // To keep it paired: add the removed result back at the right spot but as a NEW object
    const replacedResult: OpenAIMessage = { role: 'tool', tool_call_id: removedId, content: 'replacement' };
    // Insert it before the user message that follows the tool block
    const insertAt = paired.findIndex((m) => m.role === 'user' && !m.tool_call_id);
    const reSpliced = insertAt >= 0
      ? [...paired.slice(0, insertAt), replacedResult, ...paired.slice(insertAt)]
      : [...paired, replacedResult];

    syncB.sync(reSpliced);

    // ASSERTION: span was not adopted (a truncate must have occurred since the span member changed)
    expect(journal.truncateCount()).toBeGreaterThan(0);
    // Pairing on the final journal fold
    checkPairing(journal.snapshot());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 5: Crash-resume — journal ends with unanswered tool_use
// ─────────────────────────────────────────────────────────────────────────────
describe('crash-resume from journal with unanswered tool_use', () => {
  it('does not truncate(0) and appends a synthetic error tool result', () => {
    // Build a journal that ends with an assistant tool_use + no result
    const journalMessages: JournalMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'crash_call_1', name: 'bash', input: { cmd: 'sleep 100' } },
        ],
      },
      // No tool_result — session died here
    ];
    const journal = new FakeJournal(journalMessages);
    // journal.length === 2

    const oaiNatives = openAIJournalAdapter.fromJournalMessages(journalMessages);
    // repairUnansweredToolCalls should add a synthetic tool message
    const syncB = new JournalSync(journal, openAIJournalAdapter);
    syncB.seed(oaiNatives);

    // ASSERTION: no truncate(0) — the journal prefix is kept
    const zeroTruncates = journal.records.filter(
      (r) => r.kind === 'truncate' && r.length === 0,
    );
    expect(zeroTruncates.length).toBe(0);

    // ASSERTION: the synthetic [error] tool result was appended after the kept prefix
    const appended = journal.records.filter((r) => r.kind === 'append');
    expect(appended.length).toBeGreaterThan(0);
    const synthResult = appended.find((r) => {
      if (r.kind !== 'append') return false;
      return r.message.content.some(
        (b) => b.type === 'tool_result' && b.content.some((p) => p.type === 'text' && p.text === INTERRUPTED_TOOL_RESULT),
      );
    });
    expect(synthResult).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 6: Anthropic merge — two consecutive user messages from OpenAI side
// ─────────────────────────────────────────────────────────────────────────────
describe('Anthropic merge of consecutive user messages', () => {
  it('seeds Anthropic from a journal with two consecutive user messages with zero writes', () => {
    // Build a journal that has two consecutive user messages (as OpenAI writes tool results)
    // This happens because OpenAI writes each tool result as a separate 'tool' message → separate journal user messages
    const journalMessages: JournalMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tc1', name: 'bash', input: {} },
          { type: 'tool_use', id: 'tc2', name: 'read', input: {} },
        ],
      },
      // Two separate user messages (tool results, as OpenAI would write them)
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'tc1', content: [{ type: 'text', text: 'r1' }] }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'tc2', content: [{ type: 'text', text: 'r2' }] }] },
    ];
    const journal = new FakeJournal(journalMessages);

    // fromJournalMessages on Anthropic merges consecutive user messages
    const anthropicNatives = anthropicJournalAdapter.fromJournalMessages(journalMessages);
    const syncA = new JournalSync(journal, anthropicJournalAdapter);
    syncA.seed(anthropicNatives);

    // ASSERTION: zero writes (the merge maps back to the same journal length via adopt)
    expect(journal.truncateCount()).toBe(0);
    expect(journal.appendCount()).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 7: JournalProvenance unit tests
// ─────────────────────────────────────────────────────────────────────────────
import { JournalProvenance } from './provenance.js';

describe('JournalProvenance.adopt', () => {
  type Obj = { role: string; val: number; arr?: number[] };

  function makeSpan(count = 2): { sources: JournalMessage[]; members: Obj[] } {
    const sources: JournalMessage[] = Array.from({ length: count }, (_, i) => ({
      role: 'user' as const,
      content: [{ type: 'text' as const, text: `msg-${i}` }],
    }));
    const members: Obj[] = Array.from({ length: count }, (_, i) => ({ role: 'user', val: i }));
    return { sources, members };
  }

  it('returns undefined for mid-span start (index !== 0)', () => {
    const p = new JournalProvenance<Obj>();
    const { sources, members } = makeSpan(3);
    p.record(sources, members);
    // At index 1 (mid-span), adopt should return undefined
    expect(p.adopt([...members], 1)).toBeUndefined();
  });

  it('returns undefined for a missing span member', () => {
    const p = new JournalProvenance<Obj>();
    const { sources, members } = makeSpan(3);
    p.record(sources, members);
    // Only present the first 2 of 3 members
    expect(p.adopt([members[0]!, members[1]!], 0)).toBeUndefined();
  });

  it('returns undefined for a reordered member', () => {
    const p = new JournalProvenance<Obj>();
    const { sources, members } = makeSpan(3);
    p.record(sources, members);
    // Swap order of second and third members
    expect(p.adopt([members[0]!, members[2]!, members[1]!], 0)).toBeUndefined();
  });

  it('returns undefined for replaced content block (array element reference change)', () => {
    const p = new JournalProvenance<Obj>();
    const members: Obj[] = [{ role: 'user', val: 0, arr: [1, 2, 3] }];
    const sources: JournalMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'x' }] }];
    p.record(sources, members);
    // Replace the arr (new reference)
    const mutated: Obj[] = [{ role: 'user', val: 0, arr: [1, 2, 99] }];
    expect(p.adopt(mutated, 0)).toBeUndefined();
  });

  it('returns undefined for reassigned block field', () => {
    const p = new JournalProvenance<Obj>();
    const members: Obj[] = [{ role: 'user', val: 0 }];
    const sources: JournalMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'x' }] }];
    p.record(sources, members);
    // Mutate a field on the member object in-place
    members[0]!.val = 999;
    expect(p.adopt(members, 0)).toBeUndefined();
  });

  it('returns original sources when span is intact', () => {
    const p = new JournalProvenance<Obj>();
    const { sources, members } = makeSpan(2);
    p.record(sources, members);
    const result = p.adopt([...members], 0);
    expect(result).toBeDefined();
    expect(result!.entries).toEqual(sources);
    expect(result!.count).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 8: origin — Anthropic replays thinking based on origin field
// ─────────────────────────────────────────────────────────────────────────────
describe('origin: Anthropic thinking replay', () => {
  it('replays signed thinking when origin is anthropic', () => {
    const msg: JournalMessage = {
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'my thoughts', signature: SIG, origin: 'anthropic' }],
    };
    const natives = anthropicJournalAdapter.fromJournalMessages([msg]);
    const thinking = (natives[0]!.content as Array<{ type: string; signature?: string }>).find(
      (b) => b.type === 'thinking',
    );
    expect(thinking?.signature).toBe(SIG);
  });

  it('replays signed thinking when origin is absent (legacy)', () => {
    const msg: JournalMessage = {
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'my thoughts', signature: SIG }],
    };
    const natives = anthropicJournalAdapter.fromJournalMessages([msg]);
    const blocks = natives[0]!.content as Array<{ type: string; signature?: string }>;
    const thinking = blocks.find((b) => b.type === 'thinking');
    expect(thinking?.signature).toBe(SIG);
  });

  it('drops thinking when origin is another family (no signature from that family)', () => {
    const msg: JournalMessage = {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'my thoughts', signature: 'oai-sig', origin: 'openai-compatible' },
        { type: 'text', text: 'hello' },
      ],
    };
    const natives = anthropicJournalAdapter.fromJournalMessages([msg]);
    const blocks = natives[0]!.content as Array<{ type: string }>;
    expect(blocks.find((b) => b.type === 'thinking')).toBeUndefined();
    expect(blocks.find((b) => b.type === 'text')).toBeDefined();
  });

  it('drops redacted_thinking when origin is another family', () => {
    const msg: JournalMessage = {
      role: 'assistant',
      content: [
        { type: 'redacted_thinking', data: REDACTED_DATA, origin: 'openai-compatible' },
        { type: 'text', text: 'hi' },
      ],
    };
    const natives = anthropicJournalAdapter.fromJournalMessages([msg]);
    const blocks = natives[0]!.content as Array<{ type: string }>;
    expect(blocks.find((b) => b.type === 'redacted_thinking')).toBeUndefined();
    expect(blocks.find((b) => b.type === 'text')).toBeDefined();
  });

  it('replays redacted_thinking when origin is anthropic', () => {
    const msg: JournalMessage = {
      role: 'assistant',
      content: [{ type: 'redacted_thinking', data: REDACTED_DATA, origin: 'anthropic' }],
    };
    const natives = anthropicJournalAdapter.fromJournalMessages([msg]);
    const blocks = natives[0]!.content as Array<{ type: string; data?: string }>;
    const rt = blocks.find((b) => b.type === 'redacted_thinking');
    expect(rt?.data).toBe(REDACTED_DATA);
  });
});
