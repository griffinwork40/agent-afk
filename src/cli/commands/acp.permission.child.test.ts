import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AcpClientPeer, ToolCallStart } from './acp.wire.js';
import { createAcpPermissionGate } from './acp.permission.js';
import { childPrefix } from './acp.permission.labels.js';

const cwd = path.join(os.tmpdir(), 'acp-p1b-child');
const outside = path.join(os.tmpdir(), 'acp-p1b-elsewhere', 'x.txt');

function setup(turnActive?: () => boolean) {
  const emits: ToolCallStart[] = [];
  const requests: { params: unknown; resolve(v: unknown): void }[] = [];
  const peer: AcpClientPeer = {
    request: (_m, params) => new Promise((resolve) => { requests.push({ params, resolve }); }),
    notify: () => Promise.resolve(),
  };
  const gate = createAcpPermissionGate(peer, 'sid', {
    skip: false, cwd, onCancelled: vi.fn(), ...(turnActive ? { turnActive } : {}),
    emitToolCall: vi.fn(async (u: ToolCallStart) => { emits.push(u); }),
  });
  return { gate, emits, requests };
}
const opts = (id: string) => ({ signal: new AbortController().signal, toolUseID: id });
const pick = (optionId: string) => ({ outcome: { outcome: 'selected', optionId } });
async function untilRequests(r: unknown[], n: number) {
  for (let i = 0; i < 100 && r.length < n; i++) await Promise.resolve();
  expect(r.length).toBeGreaterThanOrEqual(n);
}

describe('D9 child labels', () => {
  it('labels every origin shape sensibly and never returns an empty prefix', () => {
    expect(childPrefix({ route: 'agent', depth: 1, agentType: 'research-agent' })).toBe('[subagent research-agent]');
    expect(childPrefix({ route: 'agent', depth: 2, agentType: 'a', label: 'lane' })).toBe('[subagent a lane depth 2]');
    expect(childPrefix({ route: 'skill', depth: 0, label: 'user-skill-foo' })).toBe('[skill user-skill-foo]');
    expect(childPrefix({ route: 'skill', depth: 1, label: 'mint-build' })).toBe('[skill mint-build]');
    expect(childPrefix({ route: 'compose', depth: 3, label: 'n1' })).toBe('[compose node n1 depth 3]');
    expect(childPrefix({ route: 'agent', depth: 1 })).toBe('[subagent]');
    expect(childPrefix(undefined)).toBe('[subagent]');
    expect(childPrefix({ route: 'agent', depth: 1, label: '] [x\n' } as never)).toBe('[subagent x]');
  });
});

describe('D9 child approval lifecycle', () => {
  it('asks with a labelled card, then closes it completed on allow', async () => {
    const t = setup();
    const child = t.gate.forChild!({ route: 'agent', depth: 1, agentType: 'research-agent' });
    const p = child('bash', { command: 'ls' }, opts('tu-1'));
    await untilRequests(t.requests, 1);
    const req = t.requests[0]!.params as { toolCall: { toolCallId: string; title: string }; options: { optionId: string }[] };
    expect(req.toolCall.title).toBe('[subagent research-agent] bash');
    expect(req.toolCall.toolCallId).toBe('child-1-tu-1');
    expect(req.options.map((o) => o.optionId)).toEqual(['allow_once', 'reject_once']);
    t.requests[0]!.resolve(pick('allow_once'));
    expect(await p).toEqual({ behavior: 'allow' });
    expect(t.emits.map((e) => e.status)).toEqual(['pending', 'in_progress', 'completed']);
    expect(JSON.stringify(t.emits[2]!.content)).toContain('Runs inside subagent research-agent');
  });

  it('closes the card failed with the reason on deny', async () => {
    const t = setup();
    const p = t.gate.forChild!({ route: 'compose', depth: 1, label: 'n' })('write_file', { file_path: 'a', content: '' }, opts('w'));
    await untilRequests(t.requests, 1);
    t.requests[0]!.resolve(pick('reject_once'));
    expect(await p).toMatchObject({ behavior: 'deny', message: 'Permission denied: rejected' });
    expect(t.emits.at(-1)).toMatchObject({ status: 'failed', content: [{ type: 'content', content: { text: 'Permission denied: rejected' } }] });
  });

  it('closes a pending child card failed when the turn is cancelled', async () => {
    const t = setup();
    const p = t.gate.forChild!(undefined)('bash', { command: 'x' }, opts('c'));
    await untilRequests(t.requests, 1);
    t.gate.cancelAll();
    expect(await p).toMatchObject({ behavior: 'deny', message: 'Permission denied: cancelled' });
    expect(t.emits.at(-1)?.status).toBe('failed');
  });

  it('a missing toolUseID or signal still denies, never allows', async () => {
    const t = setup();
    const child = t.gate.forChild!({ route: 'agent', depth: 1 });
    expect(await child('bash', {}, { signal: new AbortController().signal, toolUseID: '' })).toMatchObject({ behavior: 'deny' });
    expect(await child('bash', {}, {} as never)).toMatchObject({ behavior: 'deny' });
  });

  it('a child asking outside a live turn is denied without a card or request', async () => {
    for (const active of [() => false, () => { throw new Error('x'); }]) {
      const t = setup(active);
      const r = await t.gate.forChild!({ route: 'agent', depth: 1 })('bash', { command: 'x' }, opts('bg'));
      expect(r).toMatchObject({ behavior: 'deny', message: 'Permission denied: no_active_turn' });
      expect(t.emits).toEqual([]);
      expect(t.requests).toEqual([]);
    }
  });

  it('endTurn denies a pending child ask and resolves only after its card is closed', async () => {
    const t = setup();
    const p = t.gate.forChild!({ route: 'agent', depth: 1, label: 'bg' })('bash', { command: 'sleep' }, opts('bg2'));
    await untilRequests(t.requests, 1);
    await t.gate.endTurn!();
    expect(t.emits.at(-1)).toMatchObject({ status: 'failed', content: [{ content: { text: 'Permission denied: no_active_turn' } }] });
    expect(await p).toMatchObject({ behavior: 'deny', message: 'Permission denied: no_active_turn' });
    void t.gate.canUseTool('bash', { command: 'top' }, opts('top'));
    await untilRequests(t.requests, 2);
    await t.gate.endTurn!();
    expect(t.emits.at(-1)?.status).toBe('pending');
  });

  it('children auto-allow inside reads but are asked for outside reads', async () => {
    const t = setup();
    const child = t.gate.forChild!({ route: 'agent', depth: 1 });
    expect(await child('read_file', { file_path: 'a.txt' }, opts('r'))).toEqual({ behavior: 'allow' });
    void child('read_file', { file_path: outside }, opts('o'));
    await untilRequests(t.requests, 1);
    expect((t.requests[0]!.params as { toolCall: { title: string } }).toolCall.title).toBe(`[subagent] read_file ${outside}`);
  });
});

describe('D10 children relocated by a delegation cwd', () => {
  it('after an agent call with its own cwd, child relative and no-path reads are asked', async () => {
    const t = setup();
    const child = t.gate.forChild!({ route: 'agent', depth: 1 });
    expect(await child('grep', { pattern: 'x' }, opts('g0'))).toEqual({ behavior: 'allow' });
    const p = t.gate.canUseTool('agent', { prompt: 'p', cwd: path.dirname(outside) }, opts('a1'));
    await untilRequests(t.requests, 1);
    expect((t.requests[0]!.params as { toolCall: { title: string } }).toolCall.title)
      .toBe(`agent ${path.dirname(outside)} (each subagent tool call is asked separately)`);
    t.requests[0]!.resolve(pick('allow_once'));
    expect(await p).toEqual({ behavior: 'allow' });
    void child('grep', { pattern: 'x' }, opts('g1'));
    await untilRequests(t.requests, 2);
    expect(await child('read_file', { file_path: path.join(cwd, 'a.txt') }, opts('r1'))).toEqual({ behavior: 'allow' });
  });
  it('compose node cwd values are shown and relocate children', async () => {
    const t = setup();
    void t.gate.canUseTool('compose', { nodes: [{ id: 'n', prompt: 'p', cwd: outside }] }, opts('c1'));
    await untilRequests(t.requests, 1);
    expect((t.requests[0]!.params as { toolCall: { title: string } }).toolCall.title).toContain(outside);
  });
});

describe('D11 grants', () => {
  it('are shared with children and never cover an outside-cwd call', async () => {
    const t = setup();
    const p = t.gate.canUseTool('write_file', { file_path: 'a.txt', content: '' }, opts('p1'));
    await untilRequests(t.requests, 1);
    t.requests[0]!.resolve(pick('allow_always'));
    expect(await p).toEqual({ behavior: 'allow' });
    const child = t.gate.forChild!({ route: 'skill', depth: 1, label: 's' });
    expect(await child('write_file', { file_path: 'b.txt', content: '' }, opts('c1'))).toEqual({ behavior: 'allow' });
    expect(t.gate.wouldAsk!('write_file', { file_path: outside })).toBe(true);
    void t.gate.canUseTool('write_file', { file_path: outside, content: '' }, opts('p2'));
    await untilRequests(t.requests, 2);
    const req = t.requests[1]!.params as { toolCall: { title: string }; options: { optionId: string }[] };
    expect(req.toolCall.title).toBe(`write_file ${outside}`);
    expect(req.options.map((o) => o.optionId)).toEqual(['allow_once', 'reject_once']);
  });

  it('an allow_always reply to an outside request is never remembered', async () => {
    const t = setup();
    const p = t.gate.canUseTool('edit_file', { file_path: outside }, opts('e1'));
    await untilRequests(t.requests, 1);
    t.requests[0]!.resolve(pick('allow_always'));
    expect(await p).toMatchObject({ behavior: 'deny', message: 'Permission denied: unknown_option' });
    expect(t.gate.wouldAsk!('edit_file', { file_path: 'in.txt' })).toBe(true);
  });

  it('delegation tools are asked with truthful titles and no always option', async () => {
    const t = setup();
    void t.gate.canUseTool('remote_agent', { host: 'h', prompt: 'p' }, opts('ra'));
    await untilRequests(t.requests, 1);
    const req = t.requests[0]!.params as { toolCall: { title: string }; options: { optionId: string }[] };
    expect(req.toolCall.title).toBe('remote_agent (runs on another machine; its actions are NOT asked in this session)');
    expect(req.options.map((o) => o.optionId)).toEqual(['allow_once', 'reject_once']);
  });
});
