import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { toolTitle } from './acp.tool-kind.js';
import { buildPendingStart } from './acp.permission.policy.js';
import { buildReplayUpdates } from './acp.replay.js';
import { DETAIL_CHARS, oneLine } from './acp.tool-title.js';

const cwd = path.resolve(os.tmpdir(), 'acp-title-ws');
const outside = path.resolve(os.tmpdir(), 'acp-title-elsewhere', 'secret.txt');

describe('legible approval card titles (profile section 5)', () => {
  it('each tool family says what is being approved', () => {
    const cases: [string, Record<string, unknown>, string][] = [
      ['bash', { command: 'rm -rf build' }, 'bash rm -rf build'],
      ['bash', { command: 'echo a\necho b' }, 'bash echo a…'],
      ['test_run', { file: 'src/a.test.ts' }, 'test_run src/a.test.ts'],
      ['web_request', { url: 'https://x.test/api', method: 'post' }, 'web_request POST https://x.test/api'],
      ['web_scrape', { url: 'https://x.test/' }, 'web_scrape GET https://x.test/'],
      ['grep', { pattern: 'TODO', path: 'src' }, `grep "TODO" in ${path.join(cwd, 'src')}`],
      ['glob', { pattern: '**/*.ts' }, `glob "**/*.ts" in ${cwd}`],
      ['mcp__github__create_issue', { title: 'x' }, 'mcp__github__create_issue MCP server github: create_issue'],
      ['agent', { agent_type: 'research-agent', prompt: 'Find every caller of foo' }, 'agent research-agent "Find every caller of foo" (each subagent tool call is asked separately)'],
      ['skill', { name: 'review', arguments: '123' }, 'skill review "123" (each subagent tool call is asked separately)'],
      ['git_read', { subcommand: 'diff', args: ['HEAD~1'], paths: ['a.txt'] }, 'git_read diff HEAD~1 -- a.txt'],
      ['write_file', { file_path: 'a.txt' }, `write_file ${path.join(cwd, 'a.txt')}`],
    ];
    for (const [name, input, title] of cases) expect(toolTitle(name, input, cwd), name).toBe(title);
  });

  it('titles are one line and bounded; the task shows only its first words', () => {
    const long = 'x'.repeat(5000);
    const t = toolTitle('bash', { command: `${long}\nrm -rf /` }, cwd);
    expect(t).not.toMatch(/[\r\n]/);
    expect(t.length).toBeLessThanOrEqual('bash '.length + DETAIL_CHARS);
    expect(t.endsWith('…')).toBe(true);
    expect(toolTitle('agent', { prompt: Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ') }, cwd)).toContain('w11…"');
    expect(oneLine('a\u0000b\u2028c')).toBe('a b c');
  });

  it('an outside target stays visible after bounding, whatever the command length', () => {
    const start = buildPendingStart('t1', 'list_directory', { path: outside, extra: 'y'.repeat(9000) }, cwd);
    expect(start.title).toContain(outside);
    const grep = buildPendingStart('t3', 'grep', { pattern: 'z'.repeat(5000), path: outside }, cwd);
    expect(grep.title).toContain(outside);
    const child = buildPendingStart('t4', 'bash', { command: 'q'.repeat(5000), cwd: outside }, cwd, '[subagent]');
    expect(child.title).toContain(outside);
    expect(child.title.length).toBeLessThan(400);
    const glob = buildPendingStart('t2', 'glob', { pattern: `${'a'.repeat(3000)}/**`, path: path.dirname(outside) }, cwd);
    expect(glob.title).toContain(path.dirname(outside));
    expect(glob.title).not.toMatch(/[\r\n]/);
  });

  it('live cards and history replay produce the same title', () => {
    const input = { command: 'pnpm test' };
    const live = buildPendingStart('t', 'bash', input, cwd).title;
    const [replayed] = buildReplayUpdates([
      { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'bash', input }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] },
    ] as never, cwd) as { title: string }[];
    expect(replayed?.title).toBe(live);
  });
});
