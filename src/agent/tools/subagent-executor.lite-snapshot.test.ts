import { describe, it, expect } from 'vitest';
import { buildSubagentsLite } from './subagent-executor.lite-snapshot.js';
import type { SubagentManager } from '../subagent.js';
import type { BackgroundAgentRegistry } from '../background-registry.js';
import type { BackgroundJob } from '../background-registry.types.js';

// ---------------------------------------------------------------------------
// Minimal fakes — only the methods buildSubagentsLite calls
// ---------------------------------------------------------------------------

function fakeManager(
  handles: Array<{ id: string; status: 'idle' | 'running' | 'succeeded' | 'failed' | 'cancelled' }> = [],
): SubagentManager {
  return { list: () => handles } as unknown as SubagentManager;
}

function fakeRegistry(
  jobs: BackgroundJob[],
  transcripts: Record<string, string> = {},
): BackgroundAgentRegistry {
  return {
    list: () => jobs,
    getTranscript: (jobId: string) => transcripts[jobId],
  } as unknown as BackgroundAgentRegistry;
}

function makeJob(overrides: Partial<BackgroundJob> = {}): BackgroundJob {
  return {
    jobId: 'bg-test-1',
    provenance: 'model' as const,
    subagentId: 'sa-1',
    label: 'test job',
    model: 'sonnet',
    startedAt: Date.now(),
    status: 'running' as const,
    parentSessionId: 'session-abc',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildSubagentsLite', () => {
  it('returns empty arrays when no subagents or registry', () => {
    const result = buildSubagentsLite(fakeManager(), undefined);
    expect(result.active).toEqual([]);
    expect(result.backgroundJobs).toEqual([]);
  });

  it('maps active subagent handles to {id, status}', () => {
    const manager = fakeManager([
      { id: 'h-1', status: 'running' },
      { id: 'h-2', status: 'succeeded' },
    ]);
    const result = buildSubagentsLite(manager, undefined);
    expect(result.active).toEqual([
      { id: 'h-1', status: 'running' },
      { id: 'h-2', status: 'succeeded' },
    ]);
  });

  it('maps background jobs with ISO startedAt and null for empty label', () => {
    const job = makeJob({ label: '', startedAt: 1700000000000 });
    const registry = fakeRegistry([job]);
    const result = buildSubagentsLite(fakeManager(), registry);
    expect(result.backgroundJobs).toHaveLength(1);
    expect(result.backgroundJobs[0]!.label).toBeNull();
    expect(result.backgroundJobs[0]!.startedAt).toBe(new Date(1700000000000).toISOString());
  });

  // -------------------------------------------------------------------------
  // recentActivity — ownership gating
  // -------------------------------------------------------------------------

  it('includes recentActivity for running jobs owned by the caller', () => {
    const job = makeJob({ parentSessionId: 'session-abc', status: 'running' });
    const registry = fakeRegistry([job], { 'bg-test-1': 'Working on file analysis...' });
    const result = buildSubagentsLite(fakeManager(), registry, 'session-abc');
    expect(result.backgroundJobs[0]!.recentActivity).toBe('Working on file analysis...');
  });

  it('omits recentActivity for jobs owned by a different session', () => {
    const job = makeJob({ parentSessionId: 'session-other', status: 'running' });
    const registry = fakeRegistry([job], { 'bg-test-1': 'some output' });
    const result = buildSubagentsLite(fakeManager(), registry, 'session-abc');
    expect(result.backgroundJobs[0]!.recentActivity).toBeUndefined();
  });

  it('omits recentActivity for terminal (completed) jobs', () => {
    const job = makeJob({ parentSessionId: 'session-abc', status: 'completed' });
    const registry = fakeRegistry([job], { 'bg-test-1': 'final output' });
    const result = buildSubagentsLite(fakeManager(), registry, 'session-abc');
    expect(result.backgroundJobs[0]!.recentActivity).toBeUndefined();
  });

  it('omits recentActivity when callerSessionId is not provided', () => {
    const job = makeJob({ parentSessionId: 'session-abc', status: 'running' });
    const registry = fakeRegistry([job], { 'bg-test-1': 'some output' });
    const result = buildSubagentsLite(fakeManager(), registry);
    expect(result.backgroundJobs[0]!.recentActivity).toBeUndefined();
  });

  it('omits recentActivity when both parentSessionId and callerSessionId are undefined (double-undefined guard)', () => {
    // Both sides are `string | undefined`. If the `callerSessionId &&` guard
    // were ever relaxed, `undefined === undefined` would be true and an
    // identity-less caller would match identity-less jobs. This test pins the
    // current safe behaviour so the regression is caught immediately.
    const job = makeJob({ parentSessionId: undefined, status: 'running' });
    const registry = fakeRegistry([job], { 'bg-test-1': 'some output' });
    const result = buildSubagentsLite(fakeManager(), registry, undefined);
    expect(result.backgroundJobs[0]!.recentActivity).toBeUndefined();
  });

  it('omits recentActivity for user-provenance (promoted) jobs (structural gate)', () => {
    // User-promoted (Ctrl+B) jobs have provenance === 'user'. The gate now
    // explicitly checks `j.provenance === 'model'`, so exclusion is structural
    // rather than incidental (they happen to have an empty transcript).
    const job = makeJob({
      parentSessionId: 'session-abc',
      status: 'running',
      provenance: 'user',
    });
    const registry = fakeRegistry([job], { 'bg-test-1': 'promoted output' });
    const result = buildSubagentsLite(fakeManager(), registry, 'session-abc');
    expect(result.backgroundJobs[0]!.recentActivity).toBeUndefined();
  });

  it('omits recentActivity when transcript is empty', () => {
    const job = makeJob({ parentSessionId: 'session-abc', status: 'running' });
    const registry = fakeRegistry([job], { 'bg-test-1': '' });
    const result = buildSubagentsLite(fakeManager(), registry, 'session-abc');
    expect(result.backgroundJobs[0]!.recentActivity).toBeUndefined();
  });

  it('omits recentActivity when transcript is undefined (promoted job)', () => {
    const job = makeJob({ parentSessionId: 'session-abc', status: 'running' });
    const registry = fakeRegistry([job], {});
    const result = buildSubagentsLite(fakeManager(), registry, 'session-abc');
    expect(result.backgroundJobs[0]!.recentActivity).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // recentActivity — truncation
  // -------------------------------------------------------------------------

  it('truncates recentActivity to last 2048 chars', () => {
    const long = 'x'.repeat(4000);
    const job = makeJob({ parentSessionId: 'session-abc', status: 'running' });
    const registry = fakeRegistry([job], { 'bg-test-1': long });
    const result = buildSubagentsLite(fakeManager(), registry, 'session-abc');
    expect(result.backgroundJobs[0]!.recentActivity).toHaveLength(2048);
    // Should be the TAIL, not the head
    expect(result.backgroundJobs[0]!.recentActivity).toBe(long.slice(long.length - 2048));
  });

  it('does not truncate recentActivity when under 2048 chars', () => {
    const short = 'Reading src/agent/session.ts and analyzing the control flow...';
    const job = makeJob({ parentSessionId: 'session-abc', status: 'running' });
    const registry = fakeRegistry([job], { 'bg-test-1': short });
    const result = buildSubagentsLite(fakeManager(), registry, 'session-abc');
    expect(result.backgroundJobs[0]!.recentActivity).toBe(short);
  });

  it('does not truncate recentActivity at exactly 2048 chars (boundary — uses >, not >=)', () => {
    // The truncation guard is `tail.length > MAX_ACTIVITY_SNAPSHOT_CHARS`.
    // A string of exactly 2048 chars must be returned verbatim.
    const exact = 'a'.repeat(2048);
    const job = makeJob({ parentSessionId: 'session-abc', status: 'running' });
    const registry = fakeRegistry([job], { 'bg-test-1': exact });
    const result = buildSubagentsLite(fakeManager(), registry, 'session-abc');
    expect(result.backgroundJobs[0]!.recentActivity).toHaveLength(2048);
    expect(result.backgroundJobs[0]!.recentActivity).toBe(exact);
  });

  // -------------------------------------------------------------------------
  // Mixed jobs — only matching ones get recentActivity
  // -------------------------------------------------------------------------

  it('populates recentActivity selectively across mixed job set', () => {
    const ownedRunning = makeJob({
      jobId: 'bg-1',
      parentSessionId: 'session-abc',
      status: 'running',
    });
    const otherRunning = makeJob({
      jobId: 'bg-2',
      parentSessionId: 'session-other',
      status: 'running',
    });
    const ownedDone = makeJob({
      jobId: 'bg-3',
      parentSessionId: 'session-abc',
      status: 'completed',
    });
    const registry = fakeRegistry(
      [ownedRunning, otherRunning, ownedDone],
      { 'bg-1': 'active work', 'bg-2': 'other work', 'bg-3': 'done work' },
    );
    const result = buildSubagentsLite(fakeManager(), registry, 'session-abc');
    expect(result.backgroundJobs).toHaveLength(3);
    expect(result.backgroundJobs[0]!.recentActivity).toBe('active work');
    expect(result.backgroundJobs[1]!.recentActivity).toBeUndefined();
    expect(result.backgroundJobs[2]!.recentActivity).toBeUndefined();
  });
});
