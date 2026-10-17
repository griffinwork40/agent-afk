/**
 * #3878: `afk trace show` renders the billing `{ provider, tokens }` fields on
 * terminal subagent_lifecycle rows (succeeded / failed / cancelled), and stays
 * byte-identical for payloads that carry none.
 */
import { describe, expect, it } from 'vitest';
import { fmtBillingSuffix, renderSubagentLifecycle } from './trace-lifecycle-render.js';
import type { SubagentLifecyclePayload } from '../../agent/trace/index.js';

const line = (kind: string, detail: string): string => `${kind}|${detail}`;
const tokens = { uncachedInput: 1_234, cacheRead: 30_000, cacheWrite: 2_000, output: 900 };
const suffix = '  [anthropic-direct in 1.2k / cr 30k / cw 2k / out 900]';

describe('fmtBillingSuffix', () => {
  it('formats provider + compact token counts', () => {
    expect(fmtBillingSuffix({ provider: 'anthropic-direct', tokens })).toBe(suffix);
  });
  it('is empty without tokens, and omits a missing provider', () => {
    expect(fmtBillingSuffix({})).toBe('');
    expect(fmtBillingSuffix({ tokens })).toBe('  [in 1.2k / cr 30k / cw 2k / out 900]');
  });
});

describe('renderSubagentLifecycle billing suffix', () => {
  const billing = { provider: 'anthropic-direct', tokens };

  it('succeeded', () => {
    const p: SubagentLifecyclePayload = {
      transition: 'succeeded', subagentId: 's1', durationMs: 500, turnCount: 2, outputBytes: 10, ...billing,
    };
    expect(renderSubagentLifecycle(p, line)).toBe(`subagent|succeeded  500ms  2 turns  10 B${suffix}  [s1]`);
  });

  it('failed', () => {
    const p: SubagentLifecyclePayload = {
      transition: 'failed', subagentId: 's2', errorClass: 'Error', errorMessage: 'boom', partialOutputBytes: 0, ...billing,
    };
    expect(renderSubagentLifecycle(p, line)).toBe(`subagent|FAILED  Error: boom${suffix}  [s2]`);
  });

  it('cancelled', () => {
    const p: SubagentLifecyclePayload = { transition: 'cancelled', subagentId: 's3', source: 'explicit', ...billing };
    expect(renderSubagentLifecycle(p, line)).toBe(`subagent|cancelled (explicit)${suffix}  [s3]`);
  });

  it('legacy payloads without billing render unchanged', () => {
    const p: SubagentLifecyclePayload = { transition: 'cancelled', subagentId: 's4', source: 'cascade' };
    expect(renderSubagentLifecycle(p, line)).toBe('subagent|cancelled (cascade)  [s4]');
  });
});
