/**
 * Tests for src/cli/commands/interactive/verdict-ledger.ts — focused on the
 * AFK_PLAIN_OUTPUT full render opt-out gate.
 *
 * --plain must make a TTY session behave like a non-TTY surface, so the
 * pinned verdict rail stays fully inert (no reserved row, no ResizeBus
 * subscription, no CUP writes) even though `stream.isTTY` is still true —
 * matching the status-line / renderer / compositor / input gates.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createVerdictLedger } from './verdict-ledger.js';

function makeMockStream(isTTY = true): NodeJS.WriteStream {
  return { columns: 80, rows: 24, isTTY, write: vi.fn() } as unknown as NodeJS.WriteStream;
}

describe('verdict ledger — AFK_PLAIN_OUTPUT full render opt-out', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('start()/push()/repaint() stay inert on a real TTY when AFK_PLAIN_OUTPUT=1', () => {
    vi.stubEnv('AFK_PLAIN_OUTPUT', '1');
    const stream = makeMockStream(true);
    const rowHandler = vi.fn();
    const ledger = createVerdictLedger();
    ledger.setRowCountChangeHandler(rowHandler);
    ledger.start({ stream });
    ledger.push({ kind: 'done' });
    ledger.repaint();
    const writeFn = stream.write as unknown as ReturnType<typeof vi.fn>;
    expect(rowHandler).not.toHaveBeenCalled();
    expect(writeFn).not.toHaveBeenCalled();
    ledger.stop();
  });

  it('paints a reserved row on a TTY when AFK_PLAIN_OUTPUT is unset (no behavior change)', () => {
    vi.stubEnv('AFK_PLAIN_OUTPUT', undefined as unknown as string);
    const stream = makeMockStream(true);
    const rowHandler = vi.fn();
    const ledger = createVerdictLedger();
    ledger.setRowCountChangeHandler(rowHandler);
    ledger.start({ stream });
    ledger.push({ kind: 'done' });
    const writeFn = stream.write as unknown as ReturnType<typeof vi.fn>;
    expect(rowHandler).toHaveBeenCalledWith(1);
    expect(writeFn).toHaveBeenCalled();
    ledger.stop();
  });
});
