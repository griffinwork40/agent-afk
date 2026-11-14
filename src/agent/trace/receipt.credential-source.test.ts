/**
 * #4882: receipt credential provenance — top-level `credentialSource` from the
 * root `session_init_start`, absent on traces that predate the field.
 */
import { describe, it, expect } from 'vitest';
import { generateReceipt } from './receipt.js';
import type { TraceEvent } from './types.js';

let seq = 0;
function ev(kind: TraceEvent['kind'], payload: Record<string, unknown>): TraceEvent {
  const n = seq++;
  return { ts: `2026-01-01T00:00:${String(n % 60).padStart(2, '0')}.000Z`, seq: n, kind, payload } as unknown as TraceEvent;
}

function init(actor: 'main' | 'subagent', model: string, resolvedModel: string, credentialSource?: string): TraceEvent {
  return ev('session_phase', {
    phase: 'session_init_start', model, resolvedModel, actor,
    ...(credentialSource !== undefined ? { credentialSource } : {}),
  });
}

const META = { tracePath: '/t/trace.jsonl', witnessLabel: 'w' };

describe('receipt top-level credentialSource', () => {
  it('carries the root session_init_start credentialSource', () => {
    const r = generateReceipt([init('main', 'sonnet', 'claude-sonnet-4-6', 'claude-code-keychain')], META);
    expect(r.credentialSource).toBe('claude-code-keychain');
  });

  it('first (root) init wins over a later subagent init', () => {
    const r = generateReceipt([
      init('main', 'local', 'qwen3.8-flash-next', 'local'),
      init('subagent', 'sonnet', 'claude-sonnet-4-6', 'ANTHROPIC_API_KEY'),
    ], META);
    expect(r.credentialSource).toBe('local');
  });

  it('old trace without the field produces no field', () => {
    const r = generateReceipt([init('main', 'sonnet', 'claude-sonnet-4-6')], META);
    expect('credentialSource' in r).toBe(false);
  });
});
