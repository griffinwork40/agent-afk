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

function started(id: string, model: string, credentialSource?: string): TraceEvent {
  return ev('subagent_lifecycle', {
    transition: 'started', subagentId: id, parentId: 'root', model,
    ...(credentialSource !== undefined ? { credentialSource } : {}),
  });
}
function ok(id: string): TraceEvent {
  return ev('subagent_lifecycle', { transition: 'succeeded', subagentId: id, durationMs: 1, turnCount: 1 });
}

describe('receipt subagents.byModel[*].credentialSources', () => {
  it('Claude parent with a qwen child and an OpenAI child: three sources, each on the right entry', () => {
    const r = generateReceipt([
      init('main', 'sonnet', 'claude-sonnet-4-6', 'claude-code-keychain'),
      started('a', 'local', 'local'),
      started('b', 'gpt-5', 'openai:chatgpt-oauth'),
      started('c', 'gpt-5', 'openai:env'),
      init('subagent', 'local', 'qwen3.8-flash-next'),
      init('subagent', 'gpt-5', 'gpt-5'),
      ok('a'), ok('b'), ok('c'),
    ], META);
    expect(r.credentialSource).toBe('claude-code-keychain');
    const by = r.subagents.byModel!;
    expect(by['qwen3.8-flash-next']?.credentialSources).toEqual(['local']);
    expect(by['gpt-5']?.credentialSources).toEqual(['openai:chatgpt-oauth', 'openai:env']);
  });

  it('dedupes and sorts', () => {
    const by = generateReceipt([
      started('a', 'gpt-5', 'openai:env'), started('b', 'gpt-5', 'openai:env'),
    ], META).subagents.byModel!;
    expect(by['gpt-5']?.credentialSources).toEqual(['openai:env']);
  });

  it('model fallback re-run takes the source from subagent_model_fallback metadata', () => {
    const by = generateReceipt([
      started('a', 'local', 'local'),
      ev('session_phase', { phase: 'subagent_model_fallback', metadata: { subagentId: 'a', fromModel: 'local', toModel: 'sonnet', reason: 'x', credentialSource: 'ANTHROPIC_API_KEY' } }),
      ok('a'),
    ], META).subagents.byModel!;
    expect(by['sonnet']?.credentialSources).toEqual(['ANTHROPIC_API_KEY']);
    expect(by['local']).toBeUndefined();
  });

  it('old traces without the field produce no credentialSources key', () => {
    const by = generateReceipt([started('a', 'gpt-5'), ok('a')], META).subagents.byModel!;
    expect('credentialSources' in by['gpt-5']!).toBe(false);
  });
});
