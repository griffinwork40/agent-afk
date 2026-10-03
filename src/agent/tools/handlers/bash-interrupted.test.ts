import { describe, expect, it } from 'vitest';
import { interruptedBashResult } from './bash-interrupted.js';
import { MODEL_CAP_BYTES } from './_output-cap.js';

const base = { stdout: '', stderr: '', timeoutMs: 120000 } as const;

describe('interruptedBashResult', () => {
  it('abort with output: headline names elapsed time, output follows', () => {
    const r = interruptedBashResult({ ...base, kind: 'aborted', stdout: 'migrated 3/10\n', startedAt: Date.now() - 3200 });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/^Command aborted after 3\.\ds; the process was killed\. Output before the kill:\nmigrated 3\/10$/);
    expect(r.durationMs).toBeGreaterThanOrEqual(3200);
    expect(r.truncated).toBeUndefined();
  });

  it('abort with no output says so explicitly', () => {
    const r = interruptedBashResult({ ...base, kind: 'aborted', startedAt: Date.now() });
    expect(r.content).toMatch(/^Command aborted after 0\.\ds; no output was captured before the process was killed$/);
  });

  it('timeout keeps the historical headline and appends the output', () => {
    const r = interruptedBashResult({ ...base, kind: 'timeout', timeoutMs: 5000, stderr: 'warn: slow\n', startedAt: Date.now() });
    expect(r.content).toBe('Command timed out after 5000ms; the process was killed. Output before the kill:\nwarn: slow');
  });

  it('timeout with no output is byte-identical to the pre-change message', () => {
    const r = interruptedBashResult({ ...base, kind: 'timeout', timeoutMs: 5000, startedAt: Date.now() });
    expect(r.content).toBe('Command timed out after 5000ms');
  });

  it('combines stdout then stderr and strips ANSI escapes', () => {
    const r = interruptedBashResult({
      ...base,
      kind: 'aborted',
      stdout: '\u001b[32mok\u001b[0m\n',
      stderr: 'err line\n',
      startedAt: Date.now(),
    });
    expect(r.content.endsWith('ok\nerr line')).toBe(true);
    expect(r.content).not.toContain('\u001b[');
  });

  it('caps oversized output to the model budget and flags truncation', () => {
    const big = 'x'.repeat(MODEL_CAP_BYTES * 2);
    const r = interruptedBashResult({ ...base, kind: 'aborted', stdout: big, startedAt: Date.now() });
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.content, 'utf8')).toBeLessThan(MODEL_CAP_BYTES + 1000);
  });
});
