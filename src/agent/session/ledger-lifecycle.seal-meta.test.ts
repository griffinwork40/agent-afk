/**
 * Regression (#4959): `seal()` must not resolve while the session-meta.json
 * sidecar write started by `ensure()` is still in flight. Before the fix the
 * write was fire-and-forget, so `session.close()` resolved while a tmp+rename
 * could still land in `sessions/<id>/` (teardown ENOTEMPTY/EBUSY in CI).
 *
 * Deterministic: the sidecar write is held on a deferred the test controls.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-ledger-seal-meta-test-'));
process.env['AFK_HOME'] = tmpDir; // audit-env-access: allow — test isolation

const gate = vi.hoisted(() => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((r) => { release = r; });
  return { held, release: () => release(), calls: 0 };
});
vi.mock('./session-meta.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  writeSessionMeta: () => { gate.calls++; return gate.held; },
}));

import { LedgerLifecycle } from './ledger-lifecycle.js';

afterAll(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe('LedgerLifecycle.seal waits for the session-meta sidecar write', () => {
  it('does not resolve until the in-flight writeSessionMeta settles', async () => {
    const life = new LedgerLifecycle();
    life.ensure({
      depth: undefined, parentSessionId: undefined, sessionId: `seal-meta-${Date.now()}`,
      fallbackModel: 'sonnet', tracePath: undefined, getMetadata: () => ({}),
    });
    expect(gate.calls).toBe(1);

    let sealed = false;
    const sealing = life.seal('close').then(() => { sealed = true; });
    // Give the ledger stream ample time to open and end on its own.
    await new Promise((r) => setTimeout(r, 200));
    expect(sealed).toBe(false);

    gate.release();
    await sealing;
    expect(sealed).toBe(true);
  });
});
