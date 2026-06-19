/**
 * Regression test for the live `/bypass` (permission-mode) toggle.
 *
 * The reported bug: starting a session in `bypassPermissions` (via
 * `--dangerously-skip-permissions`, the `permissionMode` config key, or the
 * daemon) and then turning bypass OFF mid-session left the agent effectively
 * unrestricted while the UI badge cleared — i.e. `/bypass off` failed UNSAFE.
 *
 * Root cause: `setPermissionMode()` updated only the system-prompt mode field,
 * never the two fields that actually gate enforcement:
 *   1. the provider's `_currentPermissionMode` — read by `getGrants().allowAll`,
 *      which the path-approval hook consults; and
 *   2. the live dispatcher's `_allowAll` — read per call by the file-tool
 *      handler containment chain (`resolveAndContain` / `wouldBeRestricted`).
 *
 * These tests assert BOTH reads flip together on every `setPermissionMode`
 * call, in both directions, within a single session (no model swap).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { AnthropicDirectProvider, __setAnthropicClientFactory } from './index.js';

/** A stub client whose message stream is immediately done — no network. */
function emptyStreamClient() {
  return () =>
    ({
      messages: {
        stream: () => ({
          [Symbol.asyncIterator]() {
            return { next: async () => ({ done: true, value: undefined }) };
          },
        }),
      },
    }) as unknown as InstanceType<typeof import('@anthropic-ai/sdk').default>;
}

/**
 * Test-only read of the LIVE dispatcher's bypass flag — the file-tool
 * containment source. The handler context reads the same `_allowAll` field, so
 * the dispatcher's `getGrants().allowAll` is a faithful proxy for whether file
 * tools are contained.
 */
function liveDispatcherAllowAll(q: unknown): boolean {
  return (
    q as { state: { toolDispatcher: { getGrants(): { allowAll: boolean } } } }
  ).state.toolDispatcher.getGrants().allowAll;
}

describe('AnthropicDirectProvider — live /bypass toggle changes effective enforcement', () => {
  afterEach(() => __setAnthropicClientFactory(undefined));

  it('setPermissionMode flips BOTH enforcement reads live; /bypass off fails CLOSED', async () => {
    __setAnthropicClientFactory(emptyStreamClient());
    const provider = new AnthropicDirectProvider();
    const baseDir = mkdtempSync(path.join(tmpdir(), 'bypass-live-'));
    try {
      // Start bypassed — mirrors --dangerously-skip-permissions / config / daemon.
      const q = provider.query({
        prompt: 'noop',
        config: {
          apiKey: 'sk-test',
          cwd: baseDir,
          permissionMode: 'bypassPermissions',
        } as unknown as Parameters<typeof provider.query>[0]['config'],
      });
      // Drain one event so the SDK lifecycle is fully spun up (buildDispatcher
      // and _currentPermissionMode are already set synchronously by query()).
      await q[Symbol.asyncIterator]().next();

      // Both enforcement sources see bypass at construction.
      expect(provider.getGrants().allowAll).toBe(true); // path-approval hook
      expect(liveDispatcherAllowAll(q)).toBe(true); // file-tool containment

      // THE reported bug: /bypass off must actually restore containment.
      // Pre-fix both reads stayed `true` (agent unrestricted, badge safe).
      await q.setPermissionMode('default');
      expect(provider.getGrants().allowAll).toBe(false);
      expect(liveDispatcherAllowAll(q)).toBe(false);

      // /bypass on from default enables bypass live — no model swap required.
      await q.setPermissionMode('bypassPermissions');
      expect(provider.getGrants().allowAll).toBe(true);
      expect(liveDispatcherAllowAll(q)).toBe(true);

      // No non-bypass mode ever enables allowAll.
      for (const mode of ['default', 'plan', 'autonomous']) {
        await q.setPermissionMode(mode);
        expect(provider.getGrants().allowAll, `provider:${mode}`).toBe(false);
        expect(liveDispatcherAllowAll(q), `dispatcher:${mode}`).toBe(false);
      }

      await q.close?.();
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('starts contained by default and /bypass on lifts containment without a restart', async () => {
    __setAnthropicClientFactory(emptyStreamClient());
    const provider = new AnthropicDirectProvider();
    const baseDir = mkdtempSync(path.join(tmpdir(), 'bypass-live-'));
    try {
      const q = provider.query({
        prompt: 'noop',
        config: {
          apiKey: 'sk-test',
          cwd: baseDir,
        } as unknown as Parameters<typeof provider.query>[0]['config'],
      });
      await q[Symbol.asyncIterator]().next();

      // Default mode: contained.
      expect(provider.getGrants().allowAll).toBe(false);
      expect(liveDispatcherAllowAll(q)).toBe(false);

      // Live enable.
      await q.setPermissionMode('bypassPermissions');
      expect(provider.getGrants().allowAll).toBe(true);
      expect(liveDispatcherAllowAll(q)).toBe(true);

      await q.close?.();
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
