import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { analyze, validate } from '../scripts/workspace-ab/analyze-read-dedup.js';
import type { ToolCallStarted } from '../scripts/workspace-ab/types.js';

/** Helper: build a ToolCallStarted event with defaults. */
function call(overrides: Partial<ToolCallStarted> & Pick<ToolCallStarted, 'subagentId'>): ToolCallStarted {
  const seq = overrides.seq ?? 1;
  return {
    name: 'read_file',
    argsFingerprint: overrides.argsFingerprint ?? createHash('sha256')
      .update(`${overrides.name ?? 'read_file'}|${overrides.subagentId}|${seq}`)
      .digest('hex'),
    toolUseId: overrides.toolUseId ?? `tu_${seq}`,
    seq,
    ts: overrides.ts ?? new Date(Date.now() + seq * 1000).toISOString(),
    ...overrides,
  };
}

const fp = (s: string) => createHash('sha256').update(s).digest('hex');

const baseArgs = {
  tracePath: '/tmp/test-trace.jsonl',
  allTools: false,
  skippedNoFingerprint: 0,
  totalToolCallStarted: 10,
};

describe('analyze', () => {
  it('detects exact duplicate by two different agents', () => {
    const sharedFp = fp('/src/foo.ts|1|50');
    const calls: ToolCallStarted[] = [
      call({ subagentId: 'agent-1', seq: 1, argsFingerprint: sharedFp }),
      call({ subagentId: 'agent-2', seq: 2, argsFingerprint: sharedFp }),
    ];
    const report = analyze({ ...baseArgs, calls });
    expect(report.crossAgentDuplicates).toBe(1);
    expect(report.selfDuplicates).toBe(0);
    expect(report.crossAgentDedupRatio).toBe(0.5); // 1 dup / 2 total
    expect(report.distinctAgents).toBe(2);
    expect(report.uniqueFingerprints).toBe(1);
  });

  it('detects same agent repeating a read (self-duplicate)', () => {
    const sharedFp = fp('/src/foo.ts|1|50');
    const calls: ToolCallStarted[] = [
      call({ subagentId: 'agent-1', seq: 1, argsFingerprint: sharedFp }),
      call({ subagentId: 'agent-1', seq: 2, argsFingerprint: sharedFp }),
    ];
    const report = analyze({ ...baseArgs, calls });
    expect(report.selfDuplicates).toBe(1);
    expect(report.crossAgentDuplicates).toBe(0);
    expect(report.crossAgentDedupRatio).toBe(0);
  });

  it('distinguishes same file at different offsets via resourceFingerprint', () => {
    // Two agents read the same file at different offsets: different argsFingerprint,
    // same resourceFingerprint.
    const resourceFp = fp('/src/session.ts');
    const calls: ToolCallStarted[] = [
      call({
        subagentId: 'agent-1', seq: 1,
        argsFingerprint: fp('/src/session.ts|1|50'),
        resourceFingerprint: resourceFp,
      }),
      call({
        subagentId: 'agent-2', seq: 2,
        argsFingerprint: fp('/src/session.ts|100|200'),
        resourceFingerprint: resourceFp,
      }),
    ];
    const report = analyze({ ...baseArgs, calls });
    // Exact-call: no duplicate (different argsFingerprint)
    expect(report.crossAgentDuplicates).toBe(0);
    // Resource-level: overlap (same resourceFingerprint, different agents)
    expect(report.crossAgentFileOverlapRatio).toBe(0.5);
  });

  it('treats different files with identical input sizes as distinct', () => {
    // Two files that happen to have identical serialized input byte counts
    // but different fingerprints should not be grouped.
    const calls: ToolCallStarted[] = [
      call({
        subagentId: 'agent-1', seq: 1,
        argsFingerprint: fp('file-a'),
        resourceFingerprint: fp('/src/a.ts'),
      }),
      call({
        subagentId: 'agent-2', seq: 2,
        argsFingerprint: fp('file-b'),
        resourceFingerprint: fp('/src/b.ts'),
      }),
    ];
    const report = analyze({ ...baseArgs, calls });
    expect(report.crossAgentDuplicates).toBe(0);
    expect(report.crossAgentFileOverlapRatio).toBe(0);
  });

  it('handles legacy traces missing resourceFingerprint gracefully', () => {
    const sharedFp = fp('/src/foo.ts|1|50');
    const calls: ToolCallStarted[] = [
      call({ subagentId: 'agent-1', seq: 1, argsFingerprint: sharedFp }),
      call({ subagentId: 'agent-2', seq: 2, argsFingerprint: sharedFp }),
    ];
    // No resourceFingerprint on any call
    const report = analyze({ ...baseArgs, calls });
    // crossAgentFileOverlapRatio should be null (no resource fingerprints)
    expect(report.crossAgentFileOverlapRatio).toBeNull();
    // Exact-call dedup still works
    expect(report.crossAgentDuplicates).toBe(1);
  });

  it('attributes root calls to "root" agent', () => {
    const sharedFp = fp('/src/foo.ts');
    const calls: ToolCallStarted[] = [
      call({ subagentId: 'root', seq: 1, argsFingerprint: sharedFp }),
      call({ subagentId: 'agent-1', seq: 2, argsFingerprint: sharedFp }),
    ];
    const report = analyze({ ...baseArgs, calls });
    expect(report.distinctAgents).toBe(2);
    expect(report.crossAgentDuplicates).toBe(1);
  });

  it('skips failed/incomplete tool calls (represented as not in the calls list)', () => {
    // The parser already filters; the analyzer should handle a small call list.
    const report = analyze({ ...baseArgs, calls: [], totalToolCallStarted: 5 });
    expect(report.totalCalls).toBe(0);
    expect(report.totalToolCallStarted).toBe(5);
    expect(report.crossAgentDedupRatio).toBe(0);
    expect(report.crossAgentFileOverlapRatio).toBeNull();
  });

  it('produces JSON and human-readable compatible output', () => {
    const calls: ToolCallStarted[] = [
      call({ subagentId: 'agent-1', seq: 1, argsFingerprint: fp('x') }),
    ];
    const report = analyze({ ...baseArgs, calls });
    // Should serialize cleanly (no Set objects in the output)
    const json = JSON.stringify(report);
    const parsed = JSON.parse(json);
    expect(parsed.totalCalls).toBe(1);
    expect(parsed.hotFingerprints).toBeInstanceOf(Array);
    // hotFingerprints.agents should be string[] not Set
    expect(typeof report.tracePath).toBe('string');
  });

  it('handles --all-tools flag (multiple tool names)', () => {
    const calls: ToolCallStarted[] = [
      call({ subagentId: 'agent-1', seq: 1, name: 'read_file', argsFingerprint: fp('rf|a') }),
      call({ subagentId: 'agent-2', seq: 2, name: 'read_file', argsFingerprint: fp('rf|a') }),
      call({ subagentId: 'agent-1', seq: 3, name: 'grep', argsFingerprint: fp('grep|b') }),
      call({ subagentId: 'agent-2', seq: 4, name: 'grep', argsFingerprint: fp('grep|b') }),
    ];
    const report = analyze({ ...baseArgs, calls, allTools: true });
    expect(report.toolFilter).toBe('all tools');
    expect(report.crossAgentDuplicates).toBe(2); // one dup per tool
    expect(report.uniqueFingerprints).toBe(2);
  });
});

describe('validate', () => {
  const validReport = analyze({
    ...baseArgs,
    calls: [
      call({ subagentId: 'agent-1', seq: 1, argsFingerprint: fp('a') }),
      call({ subagentId: 'agent-2', seq: 2, argsFingerprint: fp('b') }),
    ],
  });

  it('passes a valid report', () => {
    const result = validate(validReport, { hasValidClosure: true, childFailureRate: 0 });
    expect(result.valid).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  it('fails when no subagents ran', () => {
    const noAgents = analyze({ ...baseArgs, calls: [] });
    const result = validate(noAgents);
    expect(result.valid).toBe(false);
    const noSubagentFailures = result.failures.filter(f => f.rule === 'no-subagents');
    expect(noSubagentFailures.some(f => f.rule === 'no-subagents')).toBe(true);
    // Guard against double-emission: exactly one failure for this rule.
    expect(noSubagentFailures).toHaveLength(1);
  });

  it('fails when fewer than 2 agents performed reads', () => {
    const oneAgent = analyze({
      ...baseArgs,
      calls: [call({ subagentId: 'agent-1', seq: 1 })],
    });
    const result = validate(oneAgent);
    expect(result.valid).toBe(false);
    expect(result.failures.some(f => f.rule === 'too-few-reading-agents')).toBe(true);
  });

  it('fails when fingerprints are missing from a material portion of events', () => {
    const report = analyze({
      ...baseArgs,
      calls: [
        call({ subagentId: 'agent-1', seq: 1 }),
        call({ subagentId: 'agent-2', seq: 2 }),
      ],
      skippedNoFingerprint: 10, // 10 skipped out of 12 total
    });
    const result = validate(report);
    expect(result.failures.some(f => f.rule === 'missing-fingerprints')).toBe(true);
  });

  it('fails when session did not reach valid closure', () => {
    const result = validate(validReport, { hasValidClosure: false });
    expect(result.valid).toBe(false);
    expect(result.failures.some(f => f.rule === 'no-closure')).toBe(true);
  });

  it('fails when child failure rate exceeds 50%', () => {
    const result = validate(validReport, { childFailureRate: 0.6 });
    expect(result.valid).toBe(false);
    expect(result.failures.some(f => f.rule === 'high-child-failure-rate')).toBe(true);
  });

  it('passes when child failure rate is acceptable', () => {
    const result = validate(validReport, { childFailureRate: 0.1, hasValidClosure: true });
    expect(result.valid).toBe(true);
  });
});
