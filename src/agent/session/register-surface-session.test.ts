import { describe, it, expect } from 'vitest';
import { registerSurfaceSession } from './register-surface-session.js';
import { createSessionRegistry, type SessionRegistry } from './session-registry.js';

/** Session with the SDK id known up front. */
function fixedSession(sessionId?: string): { sessionId?: string; waitForInitialization(): Promise<void> } {
  return { sessionId, async waitForInitialization() { /* immediate */ } };
}

/** Session whose SDK id only becomes available AFTER initialization (the late-bind case). */
class LateSession {
  private _id: string | undefined;
  get sessionId(): string | undefined {
    return this._id;
  }
  async waitForInitialization(): Promise<void> {
    this._id = 'sdk-late';
  }
}

describe('registerSurfaceSession', () => {
  it('registers a handle with the surface/model and an up-front SDK id', () => {
    const registry = createSessionRegistry();
    const { handle } = registerSurfaceSession(fixedSession('sdk-1'), {
      surface: 'cli',
      model: 'sonnet',
      sdkSessionId: 'sdk-1',
      name: 'my-repl',
      cwd: '/repo',
      registry,
    });
    expect(handle?.surface).toBe('cli');
    expect(handle?.model).toBe('sonnet');
    expect(handle?.name).toBe('my-repl');
    expect(handle?.cwd).toBe('/repo');
    expect(handle?.sdkSessionId).toBe('sdk-1');
    // Keyed on + reverse-lookupable by the SDK id.
    expect(registry.resolve('cli', 'sdk-1')?.id).toBe(handle?.id);
    expect(registry.getBySdkSessionId('sdk-1')?.id).toBe(handle?.id);
  });

  it('attaches the SDK id lazily once the session initializes', async () => {
    const registry = createSessionRegistry();
    const { handle } = registerSurfaceSession(new LateSession(), {
      surface: 'daemon',
      model: 'sonnet',
      registry,
    });
    expect(handle?.sdkSessionId).toBeUndefined(); // not known at registration time
    // Flush the waitForInitialization().then() microtask chain.
    await new Promise((r) => setTimeout(r, 0));
    expect(registry.getBySdkSessionId('sdk-late')?.id).toBe(handle?.id);
  });

  it('uses a unique generated key per session when no SDK id is known', () => {
    const registry = createSessionRegistry();
    const a = registerSurfaceSession(fixedSession(), { surface: 'cli', model: 'sonnet', registry });
    const b = registerSurfaceSession(fixedSession(), { surface: 'cli', model: 'sonnet', registry });
    // Distinct handles, no key collision (both registered successfully).
    expect(a.handle?.id).toBeDefined();
    expect(b.handle?.id).toBeDefined();
    expect(a.handle?.id).not.toBe(b.handle?.id);
  });

  it('dispose archives the handle and frees its key (idempotent)', () => {
    const registry = createSessionRegistry();
    const { handle, dispose } = registerSurfaceSession(fixedSession('sdk-x'), {
      surface: 'cli',
      model: 'sonnet',
      sdkSessionId: 'sdk-x',
      registry,
    });
    expect(registry.resolve('cli', 'sdk-x')?.id).toBe(handle?.id);
    dispose();
    expect(registry.resolve('cli', 'sdk-x')).toBeUndefined(); // key freed
    expect(() => dispose()).not.toThrow(); // idempotent
  });

  it('is best-effort: a throwing registry never propagates', () => {
    const throwing = {
      create() {
        throw new Error('boom');
      },
    } as unknown as SessionRegistry;
    const reg = registerSurfaceSession(fixedSession(), { surface: 'cli', model: 'sonnet', registry: throwing });
    expect(reg.handle).toBeUndefined();
    expect(() => reg.dispose()).not.toThrow();
  });
});
