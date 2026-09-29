/**
 * Tests for journal-adapter.ts:
 *   - tool_use / tool_result pairing
 *   - compacted-away records still counted
 *   - result text cap
 *   - unpaired tool_use included with no result
 *   - deduplication by toolUseId (last-write-wins on re-append)
 *   - subagent journal summarization
 */

import { describe, it, expect } from 'vitest';
import { journalRecordsToToolEvents, summarizeSubagentJournal } from './journal-adapter.js';
import type { JournalRecord } from '../journal/types.js';

const V = 1 as const;
const TS = 1_000_000;

function appendRecord(index: number, blocks: JournalRecord extends { kind: 'append'; message: infer M } ? M['content'] : never): Extract<JournalRecord, { kind: 'append' }> {
  return { v: V, ts: TS, kind: 'append', index, message: { role: 'assistant', content: blocks } };
}

function toolUseBlock(id: string, name: string, input: unknown = {}) {
  return { type: 'tool_use' as const, id, name, input };
}

function toolResultBlock(toolUseId: string, text: string, isError?: boolean) {
  return {
    type: 'tool_result' as const,
    toolUseId,
    ...(isError !== undefined ? { isError } : {}),
    content: [{ type: 'text' as const, text }],
  };
}

describe('journalRecordsToToolEvents', () => {
  it('pairs tool_use with tool_result by id', () => {
    const records: JournalRecord[] = [
      appendRecord(0, [toolUseBlock('id1', 'bash', { command: 'ls' })]),
      { v: V, ts: TS, kind: 'append', index: 1, message: { role: 'user', content: [toolResultBlock('id1', 'file.txt')] } },
    ];
    const events = journalRecordsToToolEvents(records);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ toolName: 'bash', toolUseId: 'id1', result: 'file.txt' });
  });

  it('includes unpaired tool_use with no result', () => {
    const records: JournalRecord[] = [
      appendRecord(0, [toolUseBlock('id2', 'read_file', { file_path: '/a.ts' })]),
    ];
    const events = journalRecordsToToolEvents(records);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ toolName: 'read_file', toolUseId: 'id2' });
    expect(events[0]?.result).toBeUndefined();
    expect(events[0]?.isError).toBeUndefined();
  });

  it('counts tool_use from compacted-away (truncated) records', () => {
    // Simulate: tool_use at index 0, then a truncate to 0 (compaction), then
    // the fold resumes at 0 without that message. The raw append record still
    // exists and the adapter scans ALL records.
    const records: JournalRecord[] = [
      appendRecord(0, [toolUseBlock('id3', 'write_file', { file_path: '/x.ts' })]),
      { v: V, ts: TS, kind: 'truncate', length: 0 },
      appendRecord(0, [toolUseBlock('id4', 'bash', { command: 'echo hi' })]),
    ];
    const events = journalRecordsToToolEvents(records);
    // Both tool_use blocks should be counted (id3 from before compaction, id4 after)
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.toolUseId).sort()).toEqual(['id3', 'id4']);
  });

  it('caps result text at resultTextCap', () => {
    const bigText = 'x'.repeat(5000);
    const records: JournalRecord[] = [
      appendRecord(0, [toolUseBlock('id5', 'bash')]),
      { v: V, ts: TS, kind: 'append', index: 1, message: { role: 'user', content: [toolResultBlock('id5', bigText)] } },
    ];
    const events = journalRecordsToToolEvents(records, { resultTextCap: 100 });
    expect(events[0]?.result?.length).toBe(100);
  });

  it('deduplicates tool_use by id (last-write-wins for input, first-seen for order)', () => {
    // Same id re-appended twice (e.g. journal replay / re-append after compact)
    const records: JournalRecord[] = [
      appendRecord(0, [toolUseBlock('idA', 'bash', { command: 'ls' })]),
      appendRecord(0, [toolUseBlock('idA', 'bash', { command: 'pwd' })]), // re-append
    ];
    const events = journalRecordsToToolEvents(records);
    expect(events).toHaveLength(1);
    // last-write-wins for input (extractRawToolInput gives no output for bash command anyway)
    expect(events[0]?.toolUseId).toBe('idA');
  });

  it('marks isError from tool_result', () => {
    const records: JournalRecord[] = [
      appendRecord(0, [toolUseBlock('idB', 'bash')]),
      { v: V, ts: TS, kind: 'append', index: 1, message: { role: 'user', content: [toolResultBlock('idB', 'err', true)] } },
    ];
    const events = journalRecordsToToolEvents(records);
    expect(events[0]?.isError).toBe(true);
  });

  it('extracts file_path into inputRaw for whitelisted tools', () => {
    const records: JournalRecord[] = [
      appendRecord(0, [toolUseBlock('idC', 'read_file', { file_path: '/src/foo.ts' })]),
    ];
    const events = journalRecordsToToolEvents(records);
    expect(events[0]?.inputRaw).toContain('file_path');
    expect(events[0]?.inputRaw).toContain('/src/foo.ts');
  });

  it('does not include inputRaw for tools without whitelisted fields', () => {
    const records: JournalRecord[] = [
      appendRecord(0, [toolUseBlock('idD', 'bash', { command: 'ls' })]),
    ];
    const events = journalRecordsToToolEvents(records);
    // command is NOT in RAW_INPUT_FIELDS, so inputRaw should be undefined
    expect(events[0]?.inputRaw).toBeUndefined();
  });

  it('handles multiple tool calls in one record', () => {
    const records: JournalRecord[] = [
      appendRecord(0, [
        toolUseBlock('idE', 'read_file', { file_path: '/a.ts' }),
        toolUseBlock('idF', 'write_file', { file_path: '/b.ts' }),
      ]),
    ];
    const events = journalRecordsToToolEvents(records);
    expect(events).toHaveLength(2);
    expect(events[0]?.toolName).toBe('read_file');
    expect(events[1]?.toolName).toBe('write_file');
  });

  it('ignores non-append records', () => {
    const records: JournalRecord[] = [
      { v: V, ts: TS, kind: 'meta', sessionId: 'sess', writerId: 'w' },
      { v: V, ts: TS, kind: 'mark', label: 'compact' },
      appendRecord(0, [toolUseBlock('idG', 'bash')]),
    ];
    const events = journalRecordsToToolEvents(records);
    expect(events).toHaveLength(1);
  });
});

describe('summarizeSubagentJournal', () => {
  it('counts tool calls and errors per tool', () => {
    const records: JournalRecord[] = [
      appendRecord(0, [toolUseBlock('s1', 'bash')]),
      appendRecord(0, [toolUseBlock('s2', 'read_file', { file_path: '/x.ts' })]),
      { v: V, ts: TS, kind: 'append', index: 1, message: { role: 'user', content: [toolResultBlock('s1', 'ok', true)] } },
      { v: V, ts: TS, kind: 'append', index: 1, message: { role: 'user', content: [toolResultBlock('s2', 'content')] } },
    ];
    const summary = summarizeSubagentJournal('sub-abc', records);
    expect(summary.subagent_id).toBe('sub-abc');
    expect(summary.tool_calls).toBe(2);
    expect(summary.tool_errors).toBe(1);
    expect(summary.tool_counts).toEqual({ bash: 1, read_file: 1 });
  });

  it('deduplicates by toolUseId', () => {
    const records: JournalRecord[] = [
      appendRecord(0, [toolUseBlock('s3', 'bash')]),
      appendRecord(0, [toolUseBlock('s3', 'bash')]), // same id
    ];
    const summary = summarizeSubagentJournal('sub-xyz', records);
    expect(summary.tool_calls).toBe(1);
  });

  it('returns zero counts for empty records', () => {
    const summary = summarizeSubagentJournal('sub-empty', []);
    expect(summary.tool_calls).toBe(0);
    expect(summary.tool_errors).toBe(0);
    expect(summary.tool_counts).toEqual({});
  });
});
