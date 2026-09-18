/**
 * Tests for shell-task executor, focused on excerpt truncation safety.
 */

import { describe, expect, it } from 'vitest';

import { runShellTask } from './shell-task.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTelemetryCollector() {
  const records: unknown[] = [];
  return {
    records,
    writeTelemetry: (r: unknown) => records.push(r),
  };
}

// ---------------------------------------------------------------------------
// Surrogate-pair guard
// ---------------------------------------------------------------------------

describe('runShellTask excerpt truncation', () => {
  it('produces a well-formed string when emoji lands at the exact cut point (success path)', async () => {
    // Build a string slightly above EXCERPT_CAP (4096) where the last char
    // before the cap boundary is the HIGH surrogate of a 4-byte emoji (🔥 =
    // U+1F525 = \uD83D\uDD25).  The string is: (4095 'a's) + '🔥' = 4097
    // code units.  A naive .slice(1) from position 1 would land on the LOW
    // surrogate \uDD25, producing a malformed lead code unit in the excerpt.
    const emoji = '🔥'; // 2 code units: \uD83D \uDD25
    const filler = 'a'.repeat(4095);
    const payload = filler + emoji; // length === 4097

    // Sanity: payload is 1 code unit over the cap so truncation fires.
    expect(payload.length).toBe(4097);

    const col = makeTelemetryCollector();
    const result = await runShellTask(
      { taskId: 'test-emoji', command: `printf '%s' '${payload}'` },
      'manual',
      { now: Date.now.bind(Date), writeTelemetry: col.writeTelemetry },
    );

    const excerpt: string = (result as Record<string, unknown>)['responseExcerpt'] as string;
    expect(excerpt).toBeDefined();
    // Must be well-formed — no lone surrogates
    expect(() => encodeURIComponent(excerpt)).not.toThrow();
    // The emoji should be present intact (not half-eaten)
    expect(excerpt).toContain(emoji);
  });

  it('produces a well-formed string when emoji lands at the cut point (error path)', async () => {
    const emoji = '💥'; // 2 code units: \uD83D \uDCA5
    const filler = 'a'.repeat(4095);
    const payload = filler + emoji; // 4097 code units

    const col = makeTelemetryCollector();
    // exit 1 forces the error path
    const result = await runShellTask(
      { taskId: 'test-emoji-err', command: `printf '%s' '${payload}'; exit 1` },
      'manual',
      { now: Date.now.bind(Date), writeTelemetry: col.writeTelemetry },
    );

    expect(result.status).toBe('error');
    const excerpt: string = (result as Record<string, unknown>)['responseExcerpt'] as string;
    expect(excerpt).toBeDefined();
    expect(() => encodeURIComponent(excerpt)).not.toThrow();
    expect(excerpt).toContain(emoji);
  });

  it('does not truncate output within the cap', async () => {
    const col = makeTelemetryCollector();
    const result = await runShellTask(
      { taskId: 'test-short', command: 'echo hello' },
      'manual',
      { now: Date.now.bind(Date), writeTelemetry: col.writeTelemetry },
    );
    expect(result.status).toBe('success');
    expect((result as Record<string, unknown>)['responseExcerpt']).toContain('hello');
  });
});
