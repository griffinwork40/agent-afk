/**
 * Tests for readToolLog in tool-log.ts.
 */

import { describe, it, expect } from 'vitest';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readToolLog } from './tool-log.js';

describe('readToolLog', () => {
  it('returns empty array for non-existent file', async () => {
    const result = await readToolLog('/tmp/nonexistent-whatif-tool-log-xyz.jsonl');
    expect(result).toEqual([]);
  });

  it('parses valid executed and recorded lines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tool-log-test-'));
    const path = join(dir, 'test.jsonl');
    const lines = [
      JSON.stringify({ ts: 1000, tool: 'read_file', input: { path: '/foo' }, verdict: 'executed', subagent: false }),
      JSON.stringify({ ts: 2000, tool: 'bash', input: { command: 'rm -rf /' }, verdict: 'recorded', subagent: false }),
    ].join('\n') + '\n';
    await writeFile(path, lines, 'utf-8');

    const result = await readToolLog(path);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ tool: 'read_file', input: { path: '/foo' }, verdict: 'executed' });
    expect(result[1]).toEqual({ tool: 'bash', input: { command: 'rm -rf /' }, verdict: 'recorded' });

    await rm(dir, { recursive: true, force: true });
  });

  it('tolerates malformed JSON lines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tool-log-test-'));
    const path = join(dir, 'test.jsonl');
    const lines = [
      'not json at all',
      JSON.stringify({ ts: 1000, tool: 'read_file', input: null, verdict: 'executed', subagent: false }),
      '{ broken',
    ].join('\n') + '\n';
    await writeFile(path, lines, 'utf-8');

    const result = await readToolLog(path);
    expect(result).toHaveLength(1);
    expect(result[0]?.tool).toBe('read_file');

    await rm(dir, { recursive: true, force: true });
  });

  it('skips lines with missing or invalid verdict', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tool-log-test-'));
    const path = join(dir, 'test.jsonl');
    const lines = [
      JSON.stringify({ ts: 1000, tool: 'write_file', input: {}, verdict: 'unknown' }),
      JSON.stringify({ ts: 2000, tool: 'valid_tool', input: {}, verdict: 'executed' }),
    ].join('\n');
    await writeFile(path, lines, 'utf-8');

    const result = await readToolLog(path);
    expect(result).toHaveLength(1);
    expect(result[0]?.tool).toBe('valid_tool');

    await rm(dir, { recursive: true, force: true });
  });

  it('skips lines with missing tool name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tool-log-test-'));
    const path = join(dir, 'test.jsonl');
    const lines = [
      JSON.stringify({ ts: 1000, input: {}, verdict: 'executed' }),
      JSON.stringify({ ts: 2000, tool: 'ok_tool', input: {}, verdict: 'recorded' }),
    ].join('\n');
    await writeFile(path, lines, 'utf-8');

    const result = await readToolLog(path);
    expect(result).toHaveLength(1);
    expect(result[0]?.tool).toBe('ok_tool');

    await rm(dir, { recursive: true, force: true });
  });

  it('tolerates blank lines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tool-log-test-'));
    const path = join(dir, 'test.jsonl');
    const content = '\n\n' + JSON.stringify({ ts: 1, tool: 'x', input: null, verdict: 'executed' }) + '\n\n';
    await writeFile(path, content, 'utf-8');

    const result = await readToolLog(path);
    expect(result).toHaveLength(1);

    await rm(dir, { recursive: true, force: true });
  });

  it('handles empty file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tool-log-test-'));
    const path = join(dir, 'test.jsonl');
    await writeFile(path, '', 'utf-8');

    const result = await readToolLog(path);
    expect(result).toEqual([]);

    await rm(dir, { recursive: true, force: true });
  });
});
