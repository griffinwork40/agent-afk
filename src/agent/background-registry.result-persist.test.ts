/**
 * Tests for the result-body persistence path introduced to fix the
 * "78 completed jobs never delivered" bug.
 *
 * Three behaviors under test:
 *
 *   1. `BgJobLogWriter.writeResult` / `BgJobLogReader.readResult` — the
 *      round-trip for the new `result.json` sidecar.
 *
 *   2. `BackgroundAgentRegistry.markTerminal` writes `result.json` for
 *      completed and failed jobs (not cancelled).
 *
 *   3. REPL `BgResultNotifier.dispose()` emits a stderr notice for
 *      buffered-but-undelivered jobs and does NOT call `markDelivered()`.
 *
 *   4. Telegram `TelegramBgResultNotifier.dispose()` does NOT call
 *      `markDelivered()` for buffered-but-undrained jobs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ── Set AFK_HOME before any module that reads paths is imported ──────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-result-test-'));
process.env['AFK_HOME'] = tmpDir;

// Now import after env is set.
import { BgJobLogWriter, BgJobLogReader } from './bg-job-log.js';
import type { BgJobMeta, BgJobResult } from './bg-job-log.js';
import { BackgroundAgentRegistry } from './background-registry.js';
import type { SubagentHandle, SubagentResult } from './subagent.js';
import {
  BgResultNotifier,
} from '../cli/commands/interactive/bg-result-notifier.js';

// Silence routing telemetry writes (background-registry emits on settle).
vi.mock('./routing-telemetry.js', () => ({
  appendRoutingDecision: vi.fn(async () => {}),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMeta(jobId: string): BgJobMeta {
  return {
    jobId,
    subagentId: `sub-${jobId}`,
    label: `test job ${jobId}`,
    promptHash: 'aabbcc',
    model: 'sonnet',
    startedAt: Date.now(),
    status: 'running',
    schemaVersion: 1,
  };
}

function makeBgHandle(id = 'sub-1'): {
  handle: SubagentHandle;
  fireTerminal: (r: SubagentResult) => void;
} {
  let captured: ((r: SubagentResult) => void) | undefined;
  return {
    handle: {
      id,
      status: 'idle',
      runInBackground: vi.fn((_p: string, on?: (r: SubagentResult) => void) => {
        captured = on;
      }),
      cancel: vi.fn().mockResolvedValue(undefined),
      teardown: vi.fn().mockResolvedValue(undefined),
      run: vi.fn(),
      runToResult: vi.fn(),
    } as unknown as SubagentHandle,
    fireTerminal: (r) => captured?.(r),
  };
}

function succeed(id: string, content: string): SubagentResult {
  return {
    id,
    status: 'succeeded',
    message: { content, role: 'assistant' } as unknown as SubagentResult['message'],
  } as SubagentResult;
}

function fail(id: string, msg: string): SubagentResult {
  return {
    id,
    status: 'failed',
    error: new Error(msg),
  } as SubagentResult;
}

// ── BgJobLogWriter.writeResult / BgJobLogReader.readResult ───────────────────

describe('BgJobLogWriter.writeResult / BgJobLogReader.readResult', () => {
  const JOB_ID = 'bg-result-rw-1';

  beforeEach(() => {
    // Ensure the job directory exists (writer normally creates it).
    const writer = new BgJobLogWriter(JOB_ID);
    void writer.writeMeta(makeMeta(JOB_ID));
  });

  it('round-trips a completed result body through writeResult → readResult', async () => {
    const writer = new BgJobLogWriter(JOB_ID);
    const resultIn: BgJobResult = {
      jobId: JOB_ID,
      status: 'completed',
      outputText: 'The answer is 42.',
      schemaVersion: 1,
    };
    await writer.writeResult(resultIn);

    const resultOut = await BgJobLogReader.readResult(JOB_ID);
    expect(resultOut).not.toBeNull();
    expect(resultOut!.jobId).toBe(JOB_ID);
    expect(resultOut!.status).toBe('completed');
    expect(resultOut!.outputText).toBe('The answer is 42.');
    expect(resultOut!.schemaVersion).toBe(1);
  });

  it('round-trips a failed result body', async () => {
    const writer = new BgJobLogWriter(JOB_ID + '-fail');
    const resultIn: BgJobResult = {
      jobId: JOB_ID + '-fail',
      status: 'failed',
      outputText: 'Subagent failed — Error: rate limit',
      schemaVersion: 1,
    };
    await writer.writeResult(resultIn);

    const resultOut = await BgJobLogReader.readResult(JOB_ID + '-fail');
    expect(resultOut).not.toBeNull();
    expect(resultOut!.status).toBe('failed');
    expect(resultOut!.outputText).toContain('rate limit');
  });

  it('readResult returns null for a jobId with no result.json', async () => {
    const result = await BgJobLogReader.readResult('bg-no-such-job-xyz');
    expect(result).toBeNull();
  });

  it('readResult returns null for an invalid jobId', async () => {
    const result = await BgJobLogReader.readResult('../etc/passwd');
    expect(result).toBeNull();
  });
});

// ── BackgroundAgentRegistry persists result.json on markTerminal ─────────────

describe('BackgroundAgentRegistry persists result.json on markTerminal', () => {
  let registry: BackgroundAgentRegistry;

  beforeEach(() => {
    registry = new BackgroundAgentRegistry({});
  });

  afterEach(() => {
    // nothing to tear down; jobs auto-evict
  });

  it('writes result.json for a completed job', async () => {
    const { handle, fireTerminal } = makeBgHandle('sub-persist-ok');
    const job = registry.register({ handle, prompt: 'complete me', model: 'sonnet' });
    fireTerminal(succeed('sub-persist-ok', 'job done: all tests pass'));

    // writeResult is async/fire-and-forget inside markTerminal; wait briefly.
    await vi.waitFor(async () => {
      const result = await BgJobLogReader.readResult(job.jobId);
      expect(result).not.toBeNull();
    }, { timeout: 2000 });

    const result = await BgJobLogReader.readResult(job.jobId);
    expect(result!.status).toBe('completed');
    expect(result!.outputText).toContain('job done: all tests pass');
  });

  it('writes result.json for a failed job', async () => {
    const { handle, fireTerminal } = makeBgHandle('sub-persist-fail');
    const job = registry.register({ handle, prompt: 'fail me', model: 'sonnet' });
    fireTerminal(fail('sub-persist-fail', 'provider blew up'));

    await vi.waitFor(async () => {
      const result = await BgJobLogReader.readResult(job.jobId);
      expect(result).not.toBeNull();
    }, { timeout: 2000 });

    const result = await BgJobLogReader.readResult(job.jobId);
    expect(result!.status).toBe('failed');
    expect(result!.outputText).toContain('provider blew up');
  });

  it('does NOT write result.json for a cancelled job', async () => {
    const { handle, fireTerminal } = makeBgHandle('sub-persist-cancel');
    const job = registry.register({ handle, prompt: 'cancel me', model: 'sonnet' });
    await registry.cancelJob(job.jobId);
    fireTerminal({ id: 'sub-persist-cancel', status: 'cancelled' } as SubagentResult);

    // Give any hypothetical write a chance to land.
    await new Promise<void>((r) => setTimeout(r, 300));

    const result = await BgJobLogReader.readResult(job.jobId);
    // Either null (file not created) or undefined — cancelled jobs must not
    // write result.json.
    expect(result).toBeNull();
  });
});

// ── REPL BgResultNotifier.dispose() notices and does NOT markDelivered ───────

describe('BgResultNotifier.dispose() — undelivered notice', () => {
  let registry: BackgroundAgentRegistry;
  let notifier: BgResultNotifier;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let markDeliveredSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    delete process.env['AFK_BG_AUTO_DELIVER'];
    registry = new BackgroundAgentRegistry({});
    notifier = new BgResultNotifier(registry);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    markDeliveredSpy = vi.spyOn(registry, 'markDelivered');
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    markDeliveredSpy.mockRestore();
    notifier.dispose();
    delete process.env['AFK_BG_AUTO_DELIVER'];
  });

  it('emits a stderr notice when completed jobs are buffered at dispose', () => {
    const { handle, fireTerminal } = makeBgHandle('sub-notice-1');
    registry.register({ handle, prompt: 'undelivered job', model: 'sonnet' });
    fireTerminal(succeed('sub-notice-1', 'output'));

    // Buffer is populated; dispose without draining.
    notifier.dispose();

    const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toContain('background job(s) completed but were never delivered');
    expect(written).toContain('/bgsub:join');
  });

  it('does NOT call markDelivered for buffered-but-undrained jobs on dispose', () => {
    const { handle, fireTerminal } = makeBgHandle('sub-notice-2');
    registry.register({ handle, prompt: 'undrained', model: 'sonnet' });
    fireTerminal(succeed('sub-notice-2', 'output'));

    // Do not drain. dispose() must NOT call markDelivered.
    notifier.dispose();

    expect(markDeliveredSpy).not.toHaveBeenCalled();
  });

  it('emits no notice when the buffer is empty at dispose', () => {
    notifier.dispose();
    // No writes to stderr about undelivered jobs.
    const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(written).not.toContain('background job(s) completed');
  });

  it('emits no notice when jobs were drained before dispose', () => {
    const { handle, fireTerminal } = makeBgHandle('sub-notice-3');
    registry.register({ handle, prompt: 'drained job', model: 'sonnet' });
    fireTerminal(succeed('sub-notice-3', 'output'));

    notifier.drainInjections(); // fully delivered
    notifier.dispose();

    const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(written).not.toContain('background job(s) completed but were never delivered');
  });

  it('includes job IDs in the notice so operators know what to join', () => {
    const a = makeBgHandle('sub-notice-a');
    const b = makeBgHandle('sub-notice-b');
    const jobA = registry.register({ handle: a.handle, prompt: 'task A', model: 'sonnet' });
    const jobB = registry.register({ handle: b.handle, prompt: 'task B', model: 'sonnet' });
    a.fireTerminal(succeed('sub-notice-a', 'A output'));
    b.fireTerminal(succeed('sub-notice-b', 'B output'));

    notifier.dispose();

    const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toContain(jobA.jobId);
    expect(written).toContain(jobB.jobId);
  });
});

// ── Telegram TelegramBgResultNotifier.dispose() — no markDelivered mislabel ──

// vi.mock is hoisted to module scope by vitest, so it runs before imports and
// safely stubs push.js before bg-result-notifier.js loads it (v5 requires the
// call to be at the top level of the file, not nested inside describe/test).
vi.mock('../telegram/push.js', () => ({
  pushIfConfigured: vi.fn(async () => []),
}));

describe('TelegramBgResultNotifier.dispose() — no markDelivered mislabel', async () => {
  const { TelegramBgResultNotifier } = await import('../telegram/bg-result-notifier.js');

  let registry: BackgroundAgentRegistry;
  let notifier: InstanceType<typeof TelegramBgResultNotifier>;
  let markDeliveredSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    registry = new BackgroundAgentRegistry({});
    notifier = new TelegramBgResultNotifier(registry);
    markDeliveredSpy = vi.spyOn(registry, 'markDelivered');
  });

  afterEach(() => {
    markDeliveredSpy.mockRestore();
    notifier.dispose();
  });

  it('does NOT call markDelivered for buffered-but-undrained jobs on dispose', () => {
    const { handle, fireTerminal } = makeBgHandle('sub-tg-undrained');
    registry.register({ handle, prompt: 'tg undrained', model: 'sonnet' });
    fireTerminal(succeed('sub-tg-undrained', 'output'));

    // Buffer is populated; dispose without calling drainInjections().
    notifier.dispose();

    expect(markDeliveredSpy).not.toHaveBeenCalled();
  });

  it('DOES call markDelivered when drainInjections() is called before dispose', () => {
    const { handle, fireTerminal } = makeBgHandle('sub-tg-drained');
    const job = registry.register({ handle, prompt: 'tg drained', model: 'sonnet' });
    fireTerminal(succeed('sub-tg-drained', 'output'));

    notifier.drainInjections(); // properly delivered
    // markDelivered was called during drain, not dispose.
    expect(markDeliveredSpy).toHaveBeenCalledWith(job.jobId);

    markDeliveredSpy.mockClear();
    notifier.dispose(); // buffer is empty now
    expect(markDeliveredSpy).not.toHaveBeenCalled();
  });
});
