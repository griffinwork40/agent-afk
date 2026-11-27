/**
 * Documents the ACP permission-gate behaviour for delegation tools and turn
 * boundaries in the context of issue #5191 item 4.
 *
 * Coverage in this file:
 *   - Delegation tools (`agent`, any mode) always require consent at the gate —
 *     they are never auto-allowed.
 *   - The gate approves a background `agent` call when the user consents; the
 *     executor-level block (no `backgroundRegistry` wired) is a separate layer.
 *   - A remembered `allow_always` grant for `write_file` covers a child write
 *     during an active turn — the grant is not prematurely revoked by the gate.
 *   - A child ask that is pending when `endTurn` fires is denied
 *     `no_active_turn`.
 *   - A child covered by an `allow_always` grant is allowed even when
 *     `turnActive` returns false — `grantCovers()` returns `allow()` before the
 *     `turnLive()` check, so the executor is the sole guard for background
 *     children on the ACP surface.
 *
 * Executor-level blocking (the structural half of the safety net) is tested in
 * `src/agent/tools/subagent-executor.test.ts`
 * ("mode: \"background\" with no registry: returns error and tears down the orphan
 * handle").
 *
 * @module cli/commands/acp.permission.background-block
 */
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AcpClientPeer, ToolCallStart } from './acp.wire.js';
import { createAcpPermissionGate } from './acp.permission.js';
import { requiresAsk } from './acp.permission.policy.js';

const cwd = path.join(os.tmpdir(), 'acp-bg-block');

function setup(turnActive?: () => boolean) {
  const requests: { params: unknown; resolve(v: unknown): void }[] = [];
  const peer: AcpClientPeer = {
    request: (_m, params) => new Promise((resolve) => { requests.push({ params, resolve }); }),
    notify: () => Promise.resolve(),
  };
  const gate = createAcpPermissionGate(peer, 'sid', {
    skip: false,
    cwd,
    onCancelled: vi.fn(),
    emitToolCall: vi.fn(async (_u: ToolCallStart) => {}),
    ...(turnActive !== undefined ? { turnActive } : {}),
  });
  return { gate, requests };
}

const opts = (id: string) => ({ signal: new AbortController().signal, toolUseID: id });
const pick = (optionId: string) => ({ outcome: { outcome: 'selected', optionId } });
async function flush(n = 50) { for (let i = 0; i < n; i++) await Promise.resolve(); }

// ── Policy table ─────────────────────────────────────────────────────────────

describe('ACP surface: agent tool always requires consent', () => {
  it('agent with mode:"background" is not in AUTO_ALLOW — requiresAsk returns true', () => {
    // Delegation tools are never auto-allowed regardless of mode.
    expect(requiresAsk('agent', { prompt: 'do work', mode: 'background' }, cwd)).toBe(true);
    expect(requiresAsk('agent', { prompt: 'do work', mode: 'foreground' }, cwd)).toBe(true);
    expect(requiresAsk('agent', { prompt: 'do work' }, cwd)).toBe(true);
  });
});

// ── Gate behaviour ────────────────────────────────────────────────────────────

describe('ACP surface: background agent is asked and approve-able at the gate', () => {
  /**
   * The gate itself does not block background mode — it asks for every `agent`
   * call. The block lives one layer down in the executor (no registry wired).
   * This test confirms the gate side is correct: it asks, allows on approval,
   * and does NOT silently drop the call.
   */
  it('allows an agent call with mode:"background" when approved once', async () => {
    const t = setup();
    const p = t.gate.canUseTool(
      'agent',
      { prompt: 'investigate', mode: 'background' },
      opts('ag-1'),
    );
    await flush();
    expect(t.requests).toHaveLength(1);
    t.requests[0]!.resolve(pick('allow_once'));
    expect(await p).toEqual({ behavior: 'allow' });
  });

  it('a child asking for agent mode:"background" outside a live turn is denied no_active_turn', async () => {
    // Background children are denied before they reach the executor when
    // turnActive() returns false.
    const t = setup(() => false);
    const child = t.gate.forChild!({ route: 'agent', depth: 1 });
    const r = await child('agent', { prompt: 'bg', mode: 'background' }, opts('bg-1'));
    expect(r).toMatchObject({ behavior: 'deny', message: 'Permission denied: no_active_turn' });
    expect(t.requests).toHaveLength(0);
  });
});

// ── Grant isolation ───────────────────────────────────────────────────────────

describe('ACP surface: grant isolation at the gate layer (endTurn + child write)', () => {
  // Contract: at the gate layer, a remembered grant survives endTurn when
  // turnActive is not wired; the ACP executor prevents background children
  // from reaching this path.
  //
  // Scenario: the parent earns an allow_always grant for write_file in turn N.
  // A background `agent` call is dispatched (and approved) in the same turn.
  // When the turn ends (endTurn), every pending ask — including any in-flight
  // child ask — is denied with no_active_turn.
  //
  // On the ACP surface the background executor itself blocks before running
  // (no registry), so no child ever reaches the grant at all. This test
  // documents the gate-layer half: the grant IS shared with forChild callbacks
  // when turnActive is not wired (defaults to live), confirming it is not
  // prematurely revoked at the gate.
  it('a remembered grant covers a child write even after endTurn (gate layer)', async () => {
    const t = setup();

    // Step 1: parent earns allow_always for write_file.
    const wp = t.gate.canUseTool(
      'write_file',
      { file_path: path.join(cwd, 'a.txt'), content: '' },
      opts('w-1'),
    );
    await flush();
    t.requests[0]!.resolve(pick('allow_always'));
    expect(await wp).toEqual({ behavior: 'allow' });

    // Step 2: end the turn, draining in-flight child asks.
    await t.gate.endTurn?.();

    // Step 3: a child that arrives after endTurn is still allowed for a granted tool
    // when turnActive is not wired. turnLive() defaults to true, so the remembered
    // grant covers the child write. The executor (not the gate) is what blocks
    // background children in production.
    //
    // We verify the existing structural guard: the gate's forChild path checks
    // turnLive() before queuing any ask. After endTurn the pending set is drained;
    // a NEW call after endTurn would only be denied if turnActive() returns false.
    // On the ACP surface that is enforced by the executor not wiring backgroundRegistry,
    // not by the permission gate alone. Document the gate-layer invariant instead:
    // the grant IS shared with children during an active turn.
    const child = t.gate.forChild!({ route: 'agent', depth: 1, cwd });
    const r = await child('write_file', { file_path: path.join(cwd, 'b.txt'), content: '' }, opts('cw-1'));
    // The grant covers inside-cwd writes for children during an active turn.
    // After endTurn the child can still use the grant (turnActive is not set here),
    // but on ACP the executor never reaches this point for background children.
    // This confirms the grant IS accessible (not prematurely revoked at the gate).
    expect(r).toEqual({ behavior: 'allow' });
    // No new request was sent — the grant covered it.
    expect(t.requests).toHaveLength(1);
  });

  it('a child write asked BEFORE endTurn is denied when endTurn fires mid-ask', async () => {
    const t = setup();

    // Earn the grant.
    const wp = t.gate.canUseTool(
      'write_file',
      { file_path: path.join(cwd, 'a.txt'), content: '' },
      opts('w-1'),
    );
    await flush();
    t.requests[0]!.resolve(pick('allow_always'));
    expect(await wp).toEqual({ behavior: 'allow' });

    // Child ask that requires a NEW ask (outside the cwd) starts, then endTurn fires.
    const outside = path.join(os.tmpdir(), 'acp-bg-block-other', 'x.txt');
    const childP = t.gate.forChild!({ route: 'agent', depth: 1, cwd })(
      'write_file',
      { file_path: outside, content: '' },
      opts('cw-2'),
    );
    await flush();
    expect(t.requests).toHaveLength(2); // the outside write was asked

    // endTurn cancels the pending child ask.
    const drain = t.gate.endTurn?.();
    expect(await childP).toMatchObject({ behavior: 'deny', message: 'Permission denied: no_active_turn' });
    await drain;
  });

  // Contract: grantCovers() returns allow() before turnLive() is checked
  // (acp.permission.ts decide(), lines ~215 vs ~223). A child covered by an
  // allow_always grant is therefore allowed even when turnActive returns false.
  // The executor — not the permission gate — is the sole structural guard that
  // prevents background children from reaching this path on the ACP surface
  // (no backgroundRegistry wired → runBackgroundBranch returns isError before
  // any child is registered or touches any grant).
  it('child with allow_always grant is allowed even when turnActive returns false (executor is sole guard)', async () => {
    // Wire turnActive: () => false from the start. The parent call is unaffected
    // because decide() only checks turnLive() on the child branch; parent calls
    // go through askClient directly.
    const t = setup(() => false);

    // Step 1: parent earns allow_always for write_file (turnActive does not
    // block the parent — the turnLive() check only applies to children).
    const wp = t.gate.canUseTool(
      'write_file',
      { file_path: path.join(cwd, 'a.txt'), content: '' },
      opts('w-grant'),
    );
    await flush();
    t.requests[0]!.resolve(pick('allow_always'));
    expect(await wp).toEqual({ behavior: 'allow' });

    // Step 2: child call for a granted tool while turnActive returns false.
    // grantCovers() fires before turnLive(), so the grant wins and the call is
    // allowed. No new request is sent — the grant covered it without asking.
    // This documents that the permission gate does NOT enforce turn-liveness for
    // already-granted tools; the ACP executor's structural block (no registry)
    // is what actually prevents background children from reaching this path.
    const child = t.gate.forChild!({ route: 'agent', depth: 1, cwd });
    const r = await child(
      'write_file',
      { file_path: path.join(cwd, 'c.txt'), content: '' },
      opts('cw-grant'),
    );
    expect(r).toEqual({ behavior: 'allow' });
    // Only the original grant request was sent; the child call needed no new ask.
    expect(t.requests).toHaveLength(1);
  });
});
