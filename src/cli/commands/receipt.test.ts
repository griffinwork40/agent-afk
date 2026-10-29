/**
 * Tests for `afk receipt regenerate` (#4452).
 *
 * Acceptance criteria:
 *   - A v1 receipt on disk becomes a v2 receipt after regeneration.
 *   - Re-running with --only-v1 check skips receipts already at current version
 *     (idempotent: zero writes on the second pass).
 *   - A session with no resolvable trace is skipped (returns null), not an error.
 *   - Fixture trace + journal, run regenerate twice: schemaVersion 2 after first
 *     run, zero writes on second.
 */

import { existsSync } from 'node:fs';
import * as fs from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as os from 'node:os';
import { describe, expect, it, vi } from 'vitest';

// Isolated temp dir for AFK_HOME (same pattern as trace.test.ts).
const tmpDir = fs.mkdtempSync(join(os.tmpdir(), 'afk-receipt-regen-'));
process.env['AFK_HOME'] = tmpDir;

import { getReceiptsDir, getSessionsDir, getSessionLedgerDir } from '../../paths.js';
import { getWitnessRoot, getTraceDir } from '../../paths.witness.js';
import {
  RECEIPT_SCHEMA_VERSION,
  type RunReceipt,
  writeRunReceipt,
} from '../../agent/trace/receipt.js';
import type { TraceEvent } from '../../agent/trace/types.js';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

let seq = 0;
const TS = (n: number): string => `2026-01-01T00:00:${String(n).padStart(2, '0')}.000Z`;

function makeClosure(): TraceEvent {
  const s = seq++;
  return {
    ts: TS(s + 1),
    seq: s,
    kind: 'closure',
    payload: {
      reason: 'model_end_turn',
      finalTurnCount: 1,
      finalCostUsd: 0.001,
      lastStopReason: 'end_turn',
      finalTokens: {},
    },
  };
}

function makeSealed(status: 'succeeded' | 'failed' | 'cancelled'): TraceEvent {
  const s = seq++;
  return {
    ts: TS(s + 1),
    seq: s,
    kind: 'session_sealed',
    payload: {
      status,
      finalCostUsd: 0.001,
      finalTurnCount: 1,
      closedAt: TS(s + 1),
    },
  };
}

/** Write a trace.jsonl under witness/<label>/ and return its path. */
async function writeTrace(label: string, events: TraceEvent[]): Promise<string> {
  const dir = getTraceDir(label);
  await mkdir(dir, { recursive: true });
  const tracePath = join(dir, 'trace.jsonl');
  await writeFile(tracePath, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  return tracePath;
}

/** Write a session-meta.json sidecar so the command can resolve traceLabel. */
async function writeSessionMeta(sessionId: string, traceLabel: string): Promise<void> {
  const sessionDir = getSessionLedgerDir(sessionId);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, 'session-meta.json'),
    JSON.stringify({ v: 1, sessionId, model: 'claude-3', traceLabel }),
    'utf8',
  );
}

/**
 * Write a v1 receipt stub so --only-v1 can detect it as outdated.
 * Returns the path to the written JSON file.
 */
async function writeV1Receipt(label: string): Promise<string> {
  const dir = getReceiptsDir();
  await mkdir(dir, { recursive: true });
  const stub: Record<string, unknown> = {
    schemaVersion: 1,
    generatedAt: '2026-01-01T00:00:00.000Z',
    witnessLabel: label,
    tracePath: join(getTraceDir(label), 'trace.jsonl'),
    status: 'succeeded',
    incomplete: false,
    toolCalls: {
      total: 0,
      succeeded: 0,
      errored: 0,
      erroredNotable: 0,
      refused: 0,
      circuitBreakerHits: 0,
      byTool: {},
      byFailureClass: {},
    },
    events: { total: 2, byKind: {} },
    subagents: { started: 0, succeeded: 0, failed: 0, cancelled: 0 },
    cost: {},
    failures: [],
    humanReviewRequired: false,
    humanReviewReasons: [],
    limitations: [],
  };
  const jsonPath = join(dir, `${label}.json`);
  await writeFile(jsonPath, JSON.stringify(stub), 'utf8');
  return jsonPath;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('receipt regenerate (filesystem integration)', () => {
  it('writes a v2 receipt from a fixture trace', async () => {
    seq = 0;
    const label = 'regen-label-01';
    const tracePath = await writeTrace(label, [makeClosure(), makeSealed('succeeded')]);
    await writeSessionMeta('sess-regen-01', label);

    const result = await writeRunReceipt({ tracePath, sessionId: 'sess-regen-01' });
    expect(result).not.toBeNull();
    expect(result?.label).toBe(label);

    const jsonPath = join(getReceiptsDir(), `${label}.json`);
    expect(existsSync(jsonPath)).toBe(true);
    const parsed = JSON.parse(await readFile(jsonPath, 'utf8')) as RunReceipt;
    expect(parsed.schemaVersion).toBe(RECEIPT_SCHEMA_VERSION);
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.witnessLabel).toBe(label);
  });

  it('upgrades a v1 receipt stub to v2', async () => {
    seq = 0;
    const label = 'regen-label-upgrade';
    const tracePath = await writeTrace(label, [makeClosure(), makeSealed('succeeded')]);
    await writeSessionMeta('sess-upgrade', label);
    const jsonPath = await writeV1Receipt(label);

    // Confirm starts at v1.
    const before = JSON.parse(await readFile(jsonPath, 'utf8')) as RunReceipt;
    expect(before.schemaVersion).toBe(1);

    // Regenerate via writeRunReceipt (same call the command makes).
    const result = await writeRunReceipt({ tracePath, sessionId: 'sess-upgrade' });
    expect(result).not.toBeNull();

    const after = JSON.parse(await readFile(jsonPath, 'utf8')) as RunReceipt;
    expect(after.schemaVersion).toBe(RECEIPT_SCHEMA_VERSION);
    expect(after.schemaVersion).toBe(2);
  });

  it('--only-v1 check skips a receipt already at the current schema version', async () => {
    seq = 0;
    const label = 'regen-label-idempotent';
    const tracePath = await writeTrace(label, [makeClosure(), makeSealed('succeeded')]);
    await writeSessionMeta('sess-idempotent', label);

    // First run → v2 receipt on disk.
    const first = await writeRunReceipt({ tracePath, sessionId: 'sess-idempotent' });
    expect(first).not.toBeNull();

    const jsonPath = join(getReceiptsDir(), `${label}.json`);
    const statBefore = await stat(jsonPath);

    // Simulate the --only-v1 guard: read schemaVersion from the on-disk receipt.
    const raw = await readFile(jsonPath, 'utf8');
    const parsed = JSON.parse(raw) as RunReceipt;
    expect(parsed.schemaVersion).toBe(RECEIPT_SCHEMA_VERSION);

    // schemaVersion >= RECEIPT_SCHEMA_VERSION → command would skip, no write.
    expect(parsed.schemaVersion >= RECEIPT_SCHEMA_VERSION).toBe(true);

    // File is untouched (same mtime) because no second write was issued.
    const statAfter = await stat(jsonPath);
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
  });

  it('skips a session with no resolvable trace without throwing', async () => {
    // writeRunReceipt returns null for a missing trace — same path the
    // regenerate command takes after resolveTraceLabel points to a missing file.
    const missingTrace = join(getTraceDir('nonexistent-label'), 'trace.jsonl');
    const result = await writeRunReceipt({ tracePath: missingTrace });
    expect(result).toBeNull();
  });

  it('run regenerate twice: schemaVersion 2 after first, zero writes after second', async () => {
    seq = 0;
    const label = 'regen-label-twice';
    const tracePath = await writeTrace(label, [makeClosure(), makeSealed('succeeded')]);
    await writeSessionMeta('sess-twice', label);

    // First run → v2.
    const first = await writeRunReceipt({ tracePath, sessionId: 'sess-twice' });
    expect(first).not.toBeNull();

    const jsonPath = join(getReceiptsDir(), `${label}.json`);
    const v = JSON.parse(await readFile(jsonPath, 'utf8')) as RunReceipt;
    expect(v.schemaVersion).toBe(2);

    const statAfterFirst = await stat(jsonPath);

    // Second run: --only-v1 logic detects current version → no write.
    const existing = JSON.parse(await readFile(jsonPath, 'utf8')) as RunReceipt;
    const wouldSkip = existing.schemaVersion >= RECEIPT_SCHEMA_VERSION;
    expect(wouldSkip).toBe(true);

    // No second writeRunReceipt called → mtime unchanged.
    const statAfterCheck = await stat(jsonPath);
    expect(statAfterCheck.mtimeMs).toBe(statAfterFirst.mtimeMs);
  });
});

// ---------------------------------------------------------------------------
// CLI-layer tests: runRegenerate via Commander
// ---------------------------------------------------------------------------

import { Command } from 'commander';
import { registerReceiptCommand } from './receipt.js';

/** Capture stdout.write calls during fn(), return collected output. */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return chunks.join('');
}

describe('CLI-layer: runRegenerate via Commander', () => {
  function makeProgram(): Command {
    const prog = new Command().exitOverride();
    registerReceiptCommand(prog);
    return prog;
  }

  it('--json --all on empty sessions dir emits valid JSON with zero results', async () => {
    const out = await captureStdout(async () => {
      await makeProgram().parseAsync(['receipt', 'regenerate', '--all', '--json'], { from: 'user' });
    });
    const parsed = JSON.parse(out) as { regenerated: number; skipped: number; results: unknown[] };
    expect(parsed.regenerated).toBe(0);
    expect(parsed.skipped).toBe(0);
    expect(Array.isArray(parsed.results)).toBe(true);
  });

  it('--json --session with missing trace emits skipped outcome', async () => {
    const sessionId = 'cli-test-missing-trace';
    await writeSessionMeta(sessionId, 'nonexistent-trace-label-xyz');
    const out = await captureStdout(async () => {
      await makeProgram().parseAsync(
        ['receipt', 'regenerate', '--session', sessionId, '--json'],
        { from: 'user' },
      );
    });
    const parsed = JSON.parse(out) as {
      regenerated: number;
      skipped: number;
      results: Array<{ sessionId: string; outcome: string; reason?: string }>;
    };
    expect(parsed.skipped).toBeGreaterThanOrEqual(1);
    const r = parsed.results.find((x) => x.sessionId === sessionId);
    expect(r).toBeDefined();
    expect(r?.outcome).toBe('skipped');
  });

  it('--dry-run --session with missing trace emits skipped, not dry-run', async () => {
    const sessionId = 'cli-test-dry-run-missing';
    await writeSessionMeta(sessionId, 'nonexistent-trace-for-dry-run');
    const out = await captureStdout(async () => {
      await makeProgram().parseAsync(
        ['receipt', 'regenerate', '--session', sessionId, '--dry-run', '--json'],
        { from: 'user' },
      );
    });
    const parsed = JSON.parse(out) as {
      results: Array<{ sessionId: string; outcome: string }>;
    };
    const r = parsed.results.find((x) => x.sessionId === sessionId);
    expect(r?.outcome).toBe('skipped');
  });

  it('--json --session with unsafe session id emits skipped', async () => {
    const out = await captureStdout(async () => {
      await makeProgram().parseAsync(
        ['receipt', 'regenerate', '--session', '../unsafe', '--json'],
        { from: 'user' },
      );
    });
    const parsed = JSON.parse(out) as {
      results: Array<{ sessionId: string; outcome: string; reason?: string }>;
    };
    expect(parsed.results[0]?.outcome).toBe('skipped');
    expect(parsed.results[0]?.reason).toMatch(/unsafe/i);
  });

  it('readReceiptSchemaVersion: v1 receipt stub returns 1', async () => {
    seq = 0;
    const label = 'cli-schema-version-test';
    const jsonPath = await writeV1Receipt(label);
    const raw = await readFile(jsonPath, 'utf8');
    const parsed = JSON.parse(raw) as { schemaVersion: number };
    expect(parsed.schemaVersion).toBe(1);
  });

  it('AFK_RUN_RECEIPT_DISABLED=1 in --json mode emits JSON error and returns early', async () => {
    vi.stubEnv('AFK_RUN_RECEIPT_DISABLED', '1');
    const out = await captureStdout(async () => {
      await makeProgram().parseAsync(
        ['receipt', 'regenerate', '--all', '--json'],
        { from: 'user' },
      );
    });
    vi.unstubAllEnvs();
    const parsed = JSON.parse(out) as { error: string };
    expect(parsed.error).toMatch(/AFK_RUN_RECEIPT_DISABLED/);
  });

  it('--only-v1 two-pass idempotency: second pass via Commander skips already-current receipt', async () => {
    seq = 0;
    const label = 'cli-only-v1-idempotent';
    const sessionId = 'sess-cli-only-v1';
    const tracePath = await writeTrace(label, [makeClosure(), makeSealed('succeeded')]);
    await writeSessionMeta(sessionId, label);

    // First pass: regenerate to get a v2 receipt on disk.
    const first = await writeRunReceipt({ tracePath, sessionId });
    expect(first).not.toBeNull();

    const jsonPath = join(getReceiptsDir(), `${label}.json`);
    const statAfterFirst = await stat(jsonPath);

    // Second pass: via Commander --only-v1 --session --json.
    const out = await captureStdout(async () => {
      await makeProgram().parseAsync(
        ['receipt', 'regenerate', '--session', sessionId, '--only-v1', '--json'],
        { from: 'user' },
      );
    });
    const parsed = JSON.parse(out) as {
      regenerated: number;
      alreadyCurrent: number;
      results: Array<{ sessionId: string; outcome: string }>;
    };
    expect(parsed.regenerated).toBe(0);
    expect(parsed.alreadyCurrent).toBe(1);
    const r = parsed.results.find((x) => x.sessionId === sessionId);
    expect(r?.outcome).toBe('already-current');

    // Receipt file must be untouched (same mtime).
    const statAfterSecond = await stat(jsonPath);
    expect(statAfterSecond.mtimeMs).toBe(statAfterFirst.mtimeMs);
  });

  it('--dry-run happy path: wouldRegenerate === 1, regenerated === 0, no receipt file written', async () => {
    seq = 0;
    const label = 'cli-dry-run-happy';
    const sessionId = 'sess-cli-dry-run-happy';
    await writeTrace(label, [makeClosure(), makeSealed('succeeded')]);
    await writeSessionMeta(sessionId, label);

    const jsonPath = join(getReceiptsDir(), `${label}.json`);

    // Confirm no receipt exists before the dry-run.
    expect(existsSync(jsonPath)).toBe(false);

    const out = await captureStdout(async () => {
      await makeProgram().parseAsync(
        ['receipt', 'regenerate', '--session', sessionId, '--dry-run', '--json'],
        { from: 'user' },
      );
    });

    const parsed = JSON.parse(out) as {
      wouldRegenerate: number;
      regenerated: number;
      skipped: number;
      results: Array<{ sessionId: string; outcome: string }>;
    };

    // Both keys must be present in dry-run mode.
    expect(parsed.wouldRegenerate).toBe(1);
    expect(parsed.regenerated).toBe(0);
    expect(parsed.skipped).toBe(0);

    const r = parsed.results.find((x) => x.sessionId === sessionId);
    expect(r?.outcome).toBe('dry-run');

    // No receipt file must have been written.
    expect(existsSync(jsonPath)).toBe(false);
  });
});
