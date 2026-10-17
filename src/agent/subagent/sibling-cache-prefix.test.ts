/**
 * Regression test (#3878): Anthropic-path subagent requests are structured so
 * they CAN hit the prompt cache like root requests.
 *
 * Drives REAL forks (`SubagentManager.forkSubagent` → real `AgentSession` →
 * real `AnthropicDirectProvider`) against a fake `messages.create` that only
 * records request params. No network, no model call. Each child runs two
 * rounds (one tool_use round, one end_turn round) so both a first request and
 * a later request are captured per child.
 *
 * Properties pinned:
 *   1. Breakpoints are present on every child request: the stable system
 *      block carries `cache_control`, and exactly one message breakpoint sits
 *      on the last content block of the last message.
 *   2. Sibling children forked from the same base (same prompt, budget, depth)
 *      send byte-identical `tools` and a byte-identical stable system block,
 *      so sibling N>1 can read sibling 1's cache write, EVEN WHEN siblings
 *      published workspace findings in between (the workspace preamble is a
 *      per-fork snapshot and must ride after the stable breakpoint).
 *   3. Volatile content stays AFTER the stable breakpoint: `# Environment`
 *      (cwd, date, git state), the workspace preamble, the per-child subagent
 *      id, and the `[vitals]` clock never appear in the stable block or tools.
 *   4. A child's later round keeps the same tools + stable system block and
 *      re-sends its earlier messages unchanged (modulo the floating
 *      breakpoint), so the prefix hash still matches.
 *
 * Context: the issue's 47% vs 88% hit-rate gap came from legacy counters with
 * mixed semantics (see PR #3889). This file checks that the cache-relevant
 * request shape is right; re-measure the rate with the billing rollup.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import type Anthropic from '@anthropic-ai/sdk';
import { SubagentManager } from '../subagent.js';
import { __setAnthropicClientFactory } from '../providers/anthropic-direct/index.js';
import { WorkspaceStore } from '../workspace/workspace-store.js';

interface Block { type: string; text?: string; cache_control?: unknown }
interface Msg { role: string; content: string | Block[] }
interface Captured { child: number; params: { system?: Block[]; tools?: unknown[]; messages: Msg[] } }

function usage(): Record<string, number> {
  return { input_tokens: 5, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
}

/** Round 1 of each child calls `glob`; round 2 ends the turn. */
function streamFor(callIndex: number): unknown[] {
  const isTool = callIndex % 2 === 0;
  const id = `tu_${callIndex}`;
  const start = { type: 'message_start', message: { id: `msg_${callIndex}`, type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-5', stop_reason: null, stop_sequence: null, usage: usage() } };
  const body = isTool
    ? [
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name: 'glob', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ pattern: '*.none' }) } },
      ]
    : [
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '', citations: [] } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
      ];
  return [
    start,
    ...body,
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: isTool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ];
}

const SIBLINGS = 3;

async function captureSiblingRequests(cwd: string): Promise<{ calls: Captured[]; ids: string[] }> {
  const calls: Captured[] = [];
  let current = 0;
  __setAnthropicClientFactory(() => ({
    messages: {
      create: (p: unknown) => {
        calls.push({ child: current, params: JSON.parse(JSON.stringify(p)) as Captured['params'] });
        const events = streamFor(calls.length - 1);
        return (async function* () { for (const e of events) yield e; })();
      },
    },
  }) as unknown as Anthropic);

  const store = new WorkspaceStore();
  const manager = new SubagentManager({ cwd, workspaceStore: store });
  const ids: string[] = [];
  try {
    for (let c = 0; c < SIBLINGS; c++) {
      current = c;
      const handle = await manager.forkSubagent({
        parent: { sessionId: 'parent-session-0001' },
        config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-api03-test', systemPrompt: 'SHARED BASE WORKER PROMPT', maxToolUseIterations: 50, depth: 1, maxDepth: 6 },
        agentType: 'cache-prefix-probe',
      });
      ids.push(handle.id);
      for await (const ev of handle.session.sendMessageStream(`sibling task ${c}`)) void ev;
      await handle.teardown();
      // Real fan-outs publish while siblings are still being forked, so later
      // siblings see a different workspace snapshot than earlier ones.
      store.publish({ session_id: 'sib', agent_id: handle.id, type: 'finding', content: `SHARED BASE WORKER finding ${c}`, subject: 'SHARED BASE' });
    }
  } finally {
    await manager.teardownAll();
  }
  return { calls, ids };
}

function stripCacheControl<T>(v: T): T {
  return JSON.parse(JSON.stringify(v, (k, val: unknown) => (k === 'cache_control' ? undefined : val))) as T;
}

/** String content and a single text block are the same prompt; normalize both. */
function normalizeMessages(msgs: Msg[]): Msg[] {
  return stripCacheControl(msgs).map((m) => (typeof m.content === 'string' ? { ...m, content: [{ type: 'text', text: m.content }] } : m));
}

function countMessageBreakpoints(msgs: Msg[]): number {
  return msgs.reduce((n, m) => n + (Array.isArray(m.content) ? m.content.filter((b) => b.cache_control != null).length : 0), 0);
}

describe('subagent prompt-cache prefix (#3878)', () => {
  let cwd: string;
  let captured: { calls: Captured[]; ids: string[] };

  beforeEach(async () => {
    cwd = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'sib-cache-')));
    captured = await captureSiblingRequests(cwd);
  });

  afterEach(async () => {
    __setAnthropicClientFactory(null);
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it('captures a first and a later request for every sibling', () => {
    expect(captured.calls).toHaveLength(SIBLINGS * 2);
    // Precondition for the sibling property: workspace snapshots really differ.
    const text = (i: number): string => captured.calls[i]!.params.system!.map((b) => b.text ?? '').join('\n');
    expect(text(0)).toContain('No entries published yet');
    expect(text(2)).toContain('SHARED BASE WORKER finding 0');
    expect(text(4)).toContain('SHARED BASE WORKER finding 1');
    for (let c = 0; c < SIBLINGS; c++) {
      expect(captured.calls.filter((x) => x.child === c)).toHaveLength(2);
    }
  });

  it('stamps the stable system breakpoint and one end-of-messages breakpoint on every child request', () => {
    for (const { params } of captured.calls) {
      expect(Array.isArray(params.system)).toBe(true);
      const stable = params.system![0]!;
      expect(stable.cache_control).toEqual({ type: 'ephemeral', ttl: expect.any(String) });
      expect(countMessageBreakpoints(params.messages)).toBe(1);
      const last = params.messages[params.messages.length - 1]!;
      const lastBlocks = last.content as Block[];
      expect(lastBlocks[lastBlocks.length - 1]!.cache_control).toBeDefined();
    }
  });

  it('siblings with the same base send byte-identical tools and stable system block', () => {
    const [first, ...rest] = captured.calls;
    const tools = JSON.stringify(first!.params.tools);
    const stable = JSON.stringify(first!.params.system![0]);
    expect(first!.params.tools!.length).toBeGreaterThan(0);
    for (const call of rest) {
      expect(JSON.stringify(call.params.tools)).toBe(tools);
      expect(JSON.stringify(call.params.system![0])).toBe(stable);
    }
  });

  it('keeps volatile content (environment, date, subagent id, vitals) out of the cached prefix', () => {
    for (const { params } of captured.calls) {
      const prefix = JSON.stringify(params.tools) + (params.system![0]!.text ?? '');
      expect(prefix).not.toContain('# Environment');
      expect(prefix).not.toContain('- Date:');
      expect(prefix).not.toContain(cwd);
      expect(prefix).not.toContain('[vitals]');
      expect(prefix).not.toContain('# Workspace');
      expect(prefix).toContain('# Subagent context');
      expect(prefix).toContain('# Tool budget');
      for (const id of captured.ids) expect(prefix).not.toContain(id);
      const tail = params.system!.slice(1).map((b) => b.text ?? '').join('\n');
      expect(tail).toContain('# Environment');
      expect(tail).toMatch(/# Workspace/);
    }
  });

  it("a child's later round re-sends an unchanged prefix (tools, system, earlier messages)", () => {
    for (let c = 0; c < SIBLINGS; c++) {
      const [r1, r2] = captured.calls.filter((x) => x.child === c);
      expect(JSON.stringify(r2!.params.tools)).toBe(JSON.stringify(r1!.params.tools));
      expect(JSON.stringify(r2!.params.system)).toBe(JSON.stringify(r1!.params.system));
      const earlier = normalizeMessages(r1!.params.messages);
      const later = normalizeMessages(r2!.params.messages).slice(0, earlier.length);
      expect(later).toEqual(earlier);
      expect(r2!.params.messages.length).toBeGreaterThan(r1!.params.messages.length);
    }
  });
});
