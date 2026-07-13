/**
 * Tool-overflow telemetry tests.
 *
 * Asserts that the `tool.overflow_kill` event is emitted to
 * routing-decisions.jsonl when bash or grep cross the 8MB hard cap and SIGKILL
 * the child process. Mocks `routing-telemetry` to capture calls without
 * touching the real ~/.afk file.
 *
 * Privacy boundary (audit §G.4/G.5): tests assert that payloads do NOT
 * contain the grep pattern, search path, or shell command — only the
 * operational metrics (tool, total_bytes, stream).
 *
 * Related coverage that already exists:
 *   - grep.test.ts truncation tests assert the [output truncated] sentinel
 *     and the wall-clock timing proof of mid-stream SIGKILL.
 *   - bash.test.ts has the parallel proofs for the bash handler.
 * This file is narrowly scoped to the telemetry surface.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Hoisted mock so the handlers pick up the mocked appendRoutingDecision.
const appendRoutingDecision = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);
vi.mock('../../routing-telemetry.js', () => ({
  appendRoutingDecision,
}));

import { grepHandler } from './grep.js';
import { bashHandler } from './bash.js';

function createSignal(): AbortSignal {
  return new AbortController().signal;
}

function findEvent(name: string): Record<string, unknown> | undefined {
  for (const call of appendRoutingDecision.mock.calls) {
    const entry = call[0] as Record<string, unknown>;
    if (entry['event'] === name) return entry;
  }
  return undefined;
}

describe('tool.overflow_kill telemetry — grep', () => {
  let tempDir: string;

  beforeEach(() => {
    appendRoutingDecision.mockClear();
    tempDir = mkdtempSync(join(tmpdir(), 'grep-overflow-tel-'));
  });

  it('emits tool.overflow_kill with operational fields when grep crosses 100KB', async () => {
    // ~10MB of matching content guarantees the mid-stream cap fires.
    // (Same shape as grep.test.ts:199 — V8 overflow guard.)
    const largeLine = 'palette ' + 'x'.repeat(1000);
    const lines = Array(10_000).fill(largeLine).join('\n');
    writeFileSync(join(tempDir, 'huge.txt'), lines);

    const result = await grepHandler(
      { pattern: 'palette', path: tempDir },
      createSignal(),
    );

    // Sanity: the overflow path actually fired (otherwise telemetry isn't
    // expected to be emitted either).
    expect(result.content).toContain('was terminated');

    const evt = findEvent('tool.overflow_kill');
    expect(evt).toBeDefined();
    expect(evt!['tool']).toBe('grep');
    expect(evt!['stream']).toMatch(/^(stdout|stderr)$/);
    expect(typeof evt!['total_bytes']).toBe('number');
    expect(evt!['total_bytes'] as number).toBeGreaterThanOrEqual(100_000);

    rmSync(tempDir, { recursive: true, force: true });
  }, 30_000);

  it('does NOT include the grep pattern or path in the telemetry payload', async () => {
    // Use a distinctive pattern + path so any leak is visually obvious in
    // the JSON-serialized mock-call payload.
    const secretPattern = 'SECRET-PATTERN-MARKER-42';
    const largeLine = `${secretPattern} ` + 'x'.repeat(1000);
    const lines = Array(10_000).fill(largeLine).join('\n');
    writeFileSync(join(tempDir, 'huge.txt'), lines);

    const result = await grepHandler(
      { pattern: secretPattern, path: tempDir },
      createSignal(),
    );
    expect(result.content).toContain('was terminated');

    const serialized = JSON.stringify(appendRoutingDecision.mock.calls);
    expect(serialized).not.toContain(secretPattern);
    // Path leaks would show up as the tmpdir prefix or the file name.
    expect(serialized).not.toContain('huge.txt');
    expect(serialized).not.toContain(tempDir);

    rmSync(tempDir, { recursive: true, force: true });
  }, 30_000);

  it('does NOT emit tool.overflow_kill on a small grep that stays under 100KB', async () => {
    const content = Array(50).fill('hello world').join('\n');
    writeFileSync(join(tempDir, 'small.txt'), content);

    await grepHandler({ pattern: 'hello', path: tempDir }, createSignal());

    expect(findEvent('tool.overflow_kill')).toBeUndefined();

    rmSync(tempDir, { recursive: true, force: true });
  });
});

describe('tool.overflow_kill telemetry — bash', () => {
  beforeEach(() => {
    appendRoutingDecision.mockClear();
  });

  it('emits tool.overflow_kill with operational fields when bash crosses the hard cap', async () => {
    // Fast generator: head -c 9000000 from /dev/zero crosses the 8MB hard
    // cap and exits within seconds. Pipe through tr to make the bytes
    // printable so the buffer accumulation path is identical to a real
    // noisy command.
    const result = await bashHandler(
      { command: 'head -c 9000000 /dev/zero | tr "\\0" "x"', timeout_ms: 30_000 },
      createSignal(),
    );

    expect(result.content).toContain('[output truncated');

    const evt = findEvent('tool.overflow_kill');
    expect(evt).toBeDefined();
    expect(evt!['tool']).toBe('bash');
    expect(evt!['stream']).toMatch(/^(stdout|stderr)$/);
    expect(typeof evt!['total_bytes']).toBe('number');
    expect(evt!['total_bytes'] as number).toBeGreaterThanOrEqual(100_000);
  }, 30_000);

  it('does NOT include the bash command string in the telemetry payload', async () => {
    // Distinctive marker we can scan for in the serialized mock calls.
    const result = await bashHandler(
      {
        command: 'echo SECRET-BASH-MARKER-7 && head -c 9000000 /dev/zero | tr "\\0" "x"',
        timeout_ms: 30_000,
      },
      createSignal(),
    );
    expect(result.content).toContain('[output truncated');

    const serialized = JSON.stringify(appendRoutingDecision.mock.calls);
    expect(serialized).not.toContain('SECRET-BASH-MARKER-7');
    expect(serialized).not.toContain('/dev/zero');
    expect(serialized).not.toContain('head -c');
  }, 30_000);

  it('does NOT emit tool.overflow_kill on a small bash command that stays under 100KB', async () => {
    await bashHandler(
      { command: 'echo hello && echo world', timeout_ms: 5_000 },
      createSignal(),
    );

    expect(findEvent('tool.overflow_kill')).toBeUndefined();
  });
});
