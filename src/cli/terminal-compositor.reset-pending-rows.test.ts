/**
 * resetState() must clear a stale pendingContentRows value (content-hug field;
 * reset added for #2227). A non-null value carried across a disarm/rearm cycle would
 * position the frame using a phantom band length from the previous session.
 *
 * Pattern: construct TerminalCompositor (same approach as clear-band-reset.test.ts),
 * set pendingContentRows to a non-null value via the internal cast, call
 * disarm() which invokes resetState(), and assert the field is null.
 */

import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { TerminalCompositor } from './terminal-compositor.js';

type MockStdout = NodeJS.WriteStream & { isTTY: boolean; columns: number; rows: number };
type MockStdin = NodeJS.ReadStream & { isTTY: boolean; isRaw: boolean; setRawMode: ReturnType<typeof vi.fn> };

function makeMockStdout(cols: number, rows: number): MockStdout {
  const s = new PassThrough() as unknown as MockStdout;
  s.isTTY = true;
  s.columns = cols;
  s.rows = rows;
  return s;
}
function makeMockStdin(): MockStdin {
  const s = new PassThrough() as unknown as MockStdin;
  s.isTTY = true;
  s.isRaw = false;
  s.setRawMode = vi.fn((raw: boolean) => { s.isRaw = raw; return s; });
  return s;
}

type Internals = { pendingContentRows: number | null };

describe('resetState pendingContentRows', () => {
  it('clears a stale pendingContentRows on disarm (resetState)', async () => {
    const stdout = makeMockStdout(80, 24);
    const stdin = makeMockStdin();
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), anchorRow: 1 });
    await c.arm();

    // Inject a stale in-flight value (as Phase 2 would set during a commit).
    (c as unknown as Internals).pendingContentRows = 7;
    expect((c as unknown as Internals).pendingContentRows).toBe(7);

    // disarm() calls resetState(), which must null the field.
    c.disarm();
    expect((c as unknown as Internals).pendingContentRows).toBeNull();
  }, 10_000);
});
