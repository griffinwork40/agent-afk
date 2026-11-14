/**
 * Receipt credential-source contract (#4882):
 *   - top-level `credentialSource` from the root `session_init_start`
 *   - `subagents.byModel[*].credentialSources` (sorted, unique) from the
 *     `started` payload, overridden by `subagent_model_fallback` metadata
 *   - absent (never guessed) on traces that predate the field
 */

import { describe, it, expect } from 'vitest';
import { generateReceipt } from './receipt.js';
import { buildSubagentsByModel } from './receipt.subagents-by-model.js';
import type { TraceEvent } from './types.js';

let seq = 0;
function ev(kind: TraceEvent['kind'], payload: Record<string, unknown>): TraceEvent {
  const n = seq++;
  return { ts: `2026-01-01T00:00:${String(n % 60).padStart(2, '0')}.000Z`, seq: n, kind, payload } as unknown as TraceEvent;
}

function init(model: string, actor: 'user' | 'subagent', credentialSource?: string, resolvedModel?: string): TraceEvent {
  return ev('session_phase', {
    phase: 'session_init_start',
    model,
    resolvedModel: resolvedModel ?? model,
    actor,
    ...(credentialSource !== undefined ? { credentialSource } : {}),
  });
}

function started(subagentId: string, model: string, credentialSource?: string): TraceEvent {
  return ev('subagent_lifecycle', {
    transition: 'started',
    subagentId,
    parentId: 'root',
    model,
    ...(credentialSource !== undefined ? { credentialSource } : {}),
  });
}

function succeeded(subagentId: string): TraceEvent {
  return ev('subagent_lifecycle', { transition: 'succeeded', subagentId, durationMs: 1, turnCount: 1, outputBytes: 1 });
}

const META = { tracePath: '/t/trace.jsonl', witnessLabel: 'lbl', now: new Date('2026-01-01T00:00:00Z') };

describe('receipt credentialSource (#4882)', () => {
  it('Claude parent + qwen child + OpenAI child → three different sources on the right entries', () => {
    const events = [
      init('sonnet', 'user', 'claude-code-keychain', 'claude-sonnet-4-6'),
      started('c1', 'qwen3.8-flash-next', 'local'),
      started('c2', 'gpt-5', 'chatgpt-oauth'),
      succeeded('c1'),
      succeeded('c2'),
    ];
    const r = generateReceipt(events, META);
    expect(r.credentialSource).toBe('claude-code-keychain');
    expect(r.subagents.byModel?.['qwen3.8-flash-next']?.credentialSources).toEqual(['local']);
    expect(r.subagents.byModel?.['gpt-5']?.credentialSources).toEqual(['chatgpt-oauth']);
  });

  it('dedupes and sorts sources within one bucket', () => {
    const byModel = buildSubagentsByModel([
      started('a', 'gpt-5', 'env'),
      started('b', 'gpt-5', 'chatgpt-oauth'),
      started('c', 'gpt-5', 'env'),
    ]);
    expect(byModel?.['gpt-5']?.credentialSources).toEqual(['chatgpt-oauth', 'env']);
  });

  it('a model fallback attributes the source of the model that actually ran', () => {
    const byModel = buildSubagentsByModel([
      started('a', 'qwen3.8-flash-next', 'local'),
      ev('session_phase', {
        phase: 'subagent_model_fallback',
        metadata: { subagentId: 'a', fromModel: 'qwen3.8-flash-next', toModel: 'sonnet', reason: 'x', credentialSource: 'ANTHROPIC_API_KEY' },
      }),
    ]);
    expect(byModel?.['sonnet']?.credentialSources).toEqual(['ANTHROPIC_API_KEY']);
    expect(byModel?.['qwen3.8-flash-next']).toBeUndefined();
  });

  it('a fallback without a recorded source drops the rejected attempt\'s source (never guessed)', () => {
    const byModel = buildSubagentsByModel([
      started('a', 'qwen3.8-flash-next', 'local'),
      ev('session_phase', {
        phase: 'subagent_model_fallback',
        metadata: { subagentId: 'a', fromModel: 'qwen3.8-flash-next', toModel: 'sonnet', reason: 'x' },
      }),
    ]);
    expect(byModel?.['sonnet']).toBeDefined();
    expect(byModel?.['sonnet']?.credentialSources).toBeUndefined();
  });

  it('old traces: both fields absent, never guessed', () => {
    const r = generateReceipt([init('sonnet', 'user'), started('c1', 'gpt-5'), succeeded('c1')], META);
    expect('credentialSource' in r).toBe(false);
    expect(r.subagents.byModel?.['gpt-5']).toBeDefined();
    expect('credentialSources' in (r.subagents.byModel?.['gpt-5'] ?? {})).toBe(false);
  });

  it('takes the ROOT session source, not a later subagent init', () => {
    const r = generateReceipt([
      init('qwen3.8-flash-next', 'user', 'local'),
      init('sonnet', 'subagent', 'claude-code-keychain'),
    ], META);
    expect(r.credentialSource).toBe('local');
  });
});
