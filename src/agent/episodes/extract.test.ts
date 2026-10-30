/**
 * Tests for episode input extraction (extract.ts).
 *
 * Uses real journal record structures written to a temp dir to exercise
 * extractEpisodeInput without touching the live session store.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'afk-episode-extract-test-'));
  vi.stubEnv('AFK_STATE_DIR', tmpRoot);
});

afterEach(() => {
  vi.unstubAllEnvs();
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  vi.restoreAllMocks();
});

// Helper: write a journal.jsonl for a session id
function writeJournal(sessionId: string, lines: unknown[]): void {
  const sessDir = join(tmpRoot, 'sessions', sessionId);
  mkdirSync(sessDir, { recursive: true });
  const content = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  writeFileSync(join(sessDir, 'journal.jsonl'), content, 'utf8');
}

// ---------------------------------------------------------------------------
// Record builders
// ---------------------------------------------------------------------------

function appendRecord(index: number, role: 'user' | 'assistant', blocks: unknown[]): unknown {
  return { v: 1, kind: 'append', ts: Date.now(), index, message: { role, content: blocks } };
}

function textBlock(text: string): unknown {
  return { type: 'text', text };
}

function thinkingBlock(thinking: string): unknown {
  return { type: 'thinking', thinking, signature: 'sig' };
}

function toolUseBlock(name: string, id = 'id1'): unknown {
  return { type: 'tool_use', id, name, input: { path: '/some/file' } };
}

function toolResultBlock(toolUseId: string, isError = false, text = ''): unknown {
  return {
    type: 'tool_result',
    toolUseId,
    isError,
    content: [{ type: 'text', text }],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('extractEpisodeInput', () => {
  it('returns a stub for a missing journal', async () => {
    const { extractEpisodeInput } = await import('./extract.js');
    const result = extractEpisodeInput('nonexistent-session-xyz');
    expect(result.sessionId).toBe('nonexistent-session-xyz');
    expect(result.firstUserMessage).toBe('');
    expect(result.toolsUsed).toEqual([]);
    expect(result.lastAssistantMessage).toBe('');
  });

  it('extracts first user message and last assistant message', async () => {
    const sessionId = 'test-extract-basic';
    writeJournal(sessionId, [
      appendRecord(0, 'user', [textBlock('Please refactor the auth module')]),
      appendRecord(1, 'assistant', [textBlock('I will start by reading the file')]),
      appendRecord(2, 'user', [textBlock('Thanks')]),
      appendRecord(3, 'assistant', [textBlock('Done! The refactor is complete.')]),
    ]);

    const { extractEpisodeInput } = await import('./extract.js');
    const result = extractEpisodeInput(sessionId);

    expect(result.firstUserMessage).toBe('Please refactor the auth module');
    expect(result.lastAssistantMessage).toBe('Done! The refactor is complete.');
  });

  it('excludes thinking blocks entirely', async () => {
    const sessionId = 'test-extract-thinking';
    writeJournal(sessionId, [
      appendRecord(0, 'user', [textBlock('Fix the bug')]),
      appendRecord(1, 'assistant', [
        thinkingBlock('Let me think carefully about this approach with lots of detail...'),
        textBlock('I found the bug and fixed it.'),
      ]),
    ]);

    const { extractEpisodeInput } = await import('./extract.js');
    const result = extractEpisodeInput(sessionId);

    expect(result.lastAssistantMessage).not.toContain('Let me think carefully');
    expect(result.lastAssistantMessage).toBe('I found the bug and fixed it.');
  });

  it('collects tool names but not full inputs', async () => {
    const sessionId = 'test-extract-tools';
    writeJournal(sessionId, [
      appendRecord(0, 'user', [textBlock('Read the config')]),
      appendRecord(1, 'assistant', [
        toolUseBlock('read_file', 'id1'),
        toolUseBlock('edit_file', 'id2'),
        toolUseBlock('bash', 'id3'),
      ]),
      appendRecord(2, 'user', [
        toolResultBlock('id1', false, 'file contents here'),
        toolResultBlock('id2', false, 'ok'),
        toolResultBlock('id3', false, 'done'),
      ]),
      appendRecord(3, 'assistant', [textBlock('All done.')]),
    ]);

    const { extractEpisodeInput } = await import('./extract.js');
    const result = extractEpisodeInput(sessionId);

    expect(result.toolsUsed).toContain('read_file');
    expect(result.toolsUsed).toContain('edit_file');
    expect(result.toolsUsed).toContain('bash');
    // Full tool inputs and outputs must not appear
    expect(JSON.stringify(result)).not.toContain('/some/file');
    expect(JSON.stringify(result)).not.toContain('file contents here');
  });

  it('collects tool errors (first line only)', async () => {
    const sessionId = 'test-extract-errors';
    writeJournal(sessionId, [
      appendRecord(0, 'user', [textBlock('Run the build')]),
      appendRecord(1, 'assistant', [toolUseBlock('bash', 'id1')]),
      appendRecord(2, 'user', [
        toolResultBlock('id1', true, 'Error: command not found\nmore detail here\neven more'),
      ]),
      appendRecord(3, 'assistant', [textBlock('The build failed.')]),
    ]);

    const { extractEpisodeInput } = await import('./extract.js');
    const result = extractEpisodeInput(sessionId);

    expect(result.toolErrors.length).toBeGreaterThan(0);
    const err = result.toolErrors[0]!;
    expect(err).toContain('Error: command not found');
    expect(err).not.toContain('more detail here');
  });

  it('respects token budget — large tool outputs do not blow up input', async () => {
    const sessionId = 'test-extract-budget';
    writeJournal(sessionId, [
      appendRecord(0, 'user', [textBlock('Do something')]),
      appendRecord(1, 'assistant', [toolUseBlock('read_file', 'id1')]),
      appendRecord(2, 'user', [toolResultBlock('id1', false, 'x'.repeat(50_000))]),
      appendRecord(3, 'assistant', [textBlock('A'.repeat(10_000))]),
    ]);

    const { extractEpisodeInput } = await import('./extract.js');
    const result = extractEpisodeInput(sessionId);

    const totalChars =
      result.firstUserMessage.length +
      result.lastAssistantMessage.length +
      result.toolsUsed.join('').length +
      result.toolErrors.join('').length;
    // Must fit within the 32K char budget (with small tolerance for edge math)
    expect(totalChars).toBeLessThanOrEqual(33_000);
  });

  it('extracts mark sequence from journal records', async () => {
    const sessionId = 'test-extract-marks';
    writeJournal(sessionId, [
      { v: 1, kind: 'meta', ts: Date.now(), sessionId },
      appendRecord(0, 'user', [textBlock('Start')]),
      { v: 1, kind: 'mark', ts: Date.now(), label: 'compact', detail: {} },
      { v: 1, kind: 'mark', ts: Date.now(), label: 'rewind', detail: {} },
      appendRecord(1, 'assistant', [textBlock('Done.')]),
    ]);

    const { extractEpisodeInput } = await import('./extract.js');
    const result = extractEpisodeInput(sessionId);

    expect(result.markSequence).toContain('compact');
    expect(result.markSequence).toContain('rewind');
  });

  it('handles an empty journal gracefully', async () => {
    const sessionId = 'test-extract-empty';
    writeJournal(sessionId, []);

    const { extractEpisodeInput } = await import('./extract.js');
    const result = extractEpisodeInput(sessionId);

    expect(result.firstUserMessage).toBe('');
    expect(result.toolsUsed).toEqual([]);
    expect(result.lastAssistantMessage).toBe('');
  });
});
