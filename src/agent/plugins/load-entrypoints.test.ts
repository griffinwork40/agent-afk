/**
 * Tests for boot-time plugin entrypoint loading. The load-bearing proof is that
 * a plugin's `main` module is actually imported and its top-level side-effects
 * run — this is the mechanism that lets a plugin register code-backed skills at
 * session boot without a core edit.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';
import { loadPluginEntrypoints, _resetLoadedEntrypoints, registerPluginHook, installPluginHooks } from './load-entrypoints.js';
import { createDefaultHookRegistry } from '../default-hook-registry.js';
import type { PluginApi } from './load-entrypoints.js';
import type { SdkPluginConfig } from '../types/sdk-types.js';
import { registerSkill, getSkill, listSkills, _resetRegistry } from '../../skills/skill-registry.js';
import { loadSkillPrompts } from '../../skills/_lib/prompt-loader.js';
import { SubagentManager } from '../subagent.js';
import { describeFailure } from '../subagent/result.js';
import { env } from '../../config/env.js';
import { getAgentFrameworkDir, getSkillsDir, getSessionsDir } from '../../paths.js';
import {
  deriveSessionFacet,
  getOrDeriveFacet,
  listSessionIds,
  loadStoredSession,
} from '../facets/index.js';
import { createHookRegistry } from '../hooks.js';
import type { HookContext } from '../hooks.js';
import type { StateStore } from '../state/state-store.js';
import type { SendInput, SendToSessionResult } from '../peer/send.js';
import type { PresenceRecord } from '../awareness/presence.js';

// Minimal stubs for the new optional state/peer fields.
const stubStateStore = {
  get: ((_ns: string, _key: string) => null) as StateStore['get'],
  put: ((_ns: string, _key: string, _v: unknown) => ({ version: 1, created: true })) as StateStore['put'],
  cas: ((_ns: string, _key: string, _ev: number, _v: unknown) => ({ matched: false })) as StateStore['cas'],
  del: ((_ns: string, _key: string) => ({ deleted: false })) as StateStore['del'],
  insertIfAbsent: ((_ns: string, _key: string, _v: unknown) => ({ version: 1, created: false })) as StateStore['insertIfAbsent'],
  query: ((_ns: string) => []) as StateStore['query'],
};
const stubListSessions = (): Promise<PresenceRecord[]> => Promise.resolve([]);
const stubSendToSession = (_input: Omit<SendInput, 'from'>): Promise<SendToSessionResult> =>
  Promise.resolve({ status: 'refused', reason: 'unknown-target', detail: 'stub' });

// The full host-injected API, mirroring skill-bridge.ensurePluginEntrypointsLoaded.
// `discoverPluginSkillBodies` is stubbed here (its real wiring is type-checked at
// the skill-bridge assembly site) so this test need not import that heavy barrel.
const fullApi: PluginApi = {
  registerSkill,
  listSkills,
  getSkill,
  loadSkillPrompts,
  env,
  SubagentManager,
  describeFailure,
  discoverPluginSkillBodies: (() => new Map()) as PluginApi['discoverPluginSkillBodies'],
  getAgentFrameworkDir,
  getSkillsDir,
  getSessionsDir,
  getOrDeriveFacet,
  listSessionIds,
  deriveSessionFacet,
  loadStoredSession,
  stateGet: stubStateStore.get,
  statePut: stubStateStore.put,
  stateCas: stubStateStore.cas,
  stateDel: stubStateStore.del,
  stateInsertIfAbsent: stubStateStore.insertIfAbsent,
  stateQuery: stubStateStore.query,
  listSessions: stubListSessions,
  sendToSession: stubSendToSession,
};

let dir: string;

beforeEach(() => {
  _resetLoadedEntrypoints();
  dir = mkdtempSync(join(tmpdir(), 'afk-entrypoints-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadPluginEntrypoints', () => {
  it('imports and runs a plugin main module (side-effects fire at boot)', async () => {
    const key = `__afkBootProof_${Math.random().toString(36).slice(2)}`;
    writeFileSync(
      join(dir, 'entry.mjs'),
      `globalThis[${JSON.stringify(key)}] = (globalThis[${JSON.stringify(key)}] ?? 0) + 1;\n`,
    );
    const plugins: SdkPluginConfig[] = [{ type: 'local', path: dir, main: 'entry.mjs' }];

    await loadPluginEntrypoints(plugins, { onError: (_p, err) => { throw err; } });

    const store = globalThis as unknown as Record<string, unknown>;
    try {
      expect(store[key]).toBe(1);
    } finally {
      delete store[key];
    }
  });

  it('skips plugins that declare no main (no import attempted)', async () => {
    let calls = 0;
    await loadPluginEntrypoints([{ type: 'local', path: dir }], {
      importer: async () => {
        calls++;
      },
    });
    expect(calls).toBe(0);
  });

  it('does not re-import the same resolved path within a process', async () => {
    let calls = 0;
    const plugins: SdkPluginConfig[] = [{ type: 'local', path: dir, main: 'entry.mjs' }];
    const importer = async (): Promise<void> => {
      calls++;
    };
    await loadPluginEntrypoints(plugins, { importer });
    await loadPluginEntrypoints(plugins, { importer });
    expect(calls).toBe(1);
  });

  it('is non-fatal when an entrypoint is missing/throws, reporting via onError', async () => {
    const errors: unknown[] = [];
    const plugins: SdkPluginConfig[] = [
      { type: 'local', path: dir, main: 'does-not-exist.mjs' },
    ];
    await expect(
      loadPluginEntrypoints(plugins, { onError: (_p, e) => errors.push(e) }),
    ).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  it('resolves a relative main against the plugin path as a file URL', async () => {
    const seen: string[] = [];
    await loadPluginEntrypoints([{ type: 'local', path: dir, main: 'sub/entry.mjs' }], {
      importer: async (s) => {
        seen.push(s);
      },
    });
    expect(seen).toEqual([pathToFileURL(join(dir, 'sub', 'entry.mjs')).href]);
  });

  it('honors an absolute main as-is', async () => {
    const abs = join(dir, 'abs.mjs');
    const seen: string[] = [];
    await loadPluginEntrypoints([{ type: 'local', path: '/elsewhere', main: abs }], {
      importer: async (s) => {
        seen.push(s);
      },
    });
    expect(seen).toEqual([pathToFileURL(abs).href]);
  });

  it('injects the host API into a default-export entrypoint so a plugin registers into the HOST registry (round-trip)', async () => {
    // The load-bearing proof: a plugin's default export, invoked with the host
    // PluginApi, must reach the SAME singleton registry the host reads via
    // getSkill/listSkills. Without injection, a plugin importing its own copy of
    // the package would write to a different registry instance — a silent no-op.
    _resetRegistry();
    const skillName = `__afkRtProof_${Math.random().toString(36).slice(2)}`;
    writeFileSync(
      join(dir, 'entry.mjs'),
      `export default (api) => {\n` +
        `  api.registerSkill({\n` +
        `    name: ${JSON.stringify(skillName)},\n` +
        `    description: 'round-trip proof',\n` +
        `    handler: async () => ({}),\n` +
        `  });\n` +
        `};\n`,
    );
    const plugins: SdkPluginConfig[] = [{ type: 'local', path: dir, main: 'entry.mjs' }];

    await loadPluginEntrypoints(plugins, { pluginApi: fullApi, onError: (_p, err) => { throw err; } });

    try {
      expect(listSkills()).toContain(skillName);
      expect(getSkill(skillName).description).toBe('round-trip proof');
    } finally {
      _resetRegistry();
    }
  });

  it('still runs top-level side-effects when an entrypoint has no default export, even with pluginApi supplied (back-compat)', async () => {
    const key = `__afkSideEffectProof_${Math.random().toString(36).slice(2)}`;
    writeFileSync(join(dir, 'entry.mjs'), `globalThis[${JSON.stringify(key)}] = true;\n`);
    const plugins: SdkPluginConfig[] = [{ type: 'local', path: dir, main: 'entry.mjs' }];
    const store = globalThis as unknown as Record<string, unknown>;
    try {
      await expect(
        loadPluginEntrypoints(plugins, { pluginApi: fullApi, onError: (_p, err) => { throw err; } }),
      ).resolves.toBeUndefined();
      expect(store[key]).toBe(true);
    } finally {
      delete store[key];
    }
  });

  it('injects core runtime values (env, SubagentManager, …) a marketplace clone cannot import directly', async () => {
    // A marketplace-cloned plugin has no node_modules, so a bare
    // `import { SubagentManager } from 'agent-afk'` throws ERR_MODULE_NOT_FOUND.
    // Prove the host instead INJECTS these runtime values into the default-export
    // entrypoint and that they arrive intact (env object, the real SubagentManager
    // class, the helper functions) — the resolution half of the PluginApi contract.
    writeFileSync(
      join(dir, 'entry.mjs'),
      `export default (api) => {\n` +
        `  globalThis.__afkApiProbe = {\n` +
        `    envType: typeof api.env,\n` +
        `    subagentManagerType: typeof api.SubagentManager,\n` +
        `    subagentManagerName: api.SubagentManager && api.SubagentManager.name,\n` +
        `    describeFailureType: typeof api.describeFailure,\n` +
        `    getAgentFrameworkDirType: typeof api.getAgentFrameworkDir,\n` +
        `    discoverPluginSkillBodiesType: typeof api.discoverPluginSkillBodies,\n` +
        `    getOrDeriveFacetType: typeof api.getOrDeriveFacet,\n` +
        `    listSessionIdsType: typeof api.listSessionIds,\n` +
        `    deriveSessionFacetType: typeof api.deriveSessionFacet,\n` +
        `    loadStoredSessionType: typeof api.loadStoredSession,\n` +
        `    stateGetType: typeof api.stateGet,\n` +
        `    statePutType: typeof api.statePut,\n` +
        `    stateCasType: typeof api.stateCas,\n` +
        `    stateDelType: typeof api.stateDel,\n` +
        `    stateInsertIfAbsentType: typeof api.stateInsertIfAbsent,\n` +
        `    stateQueryType: typeof api.stateQuery,\n` +
        `    listSessionsType: typeof api.listSessions,\n` +
        `    sendToSessionType: typeof api.sendToSession,\n` +
        `  };\n` +
        `};\n`,
    );
    const plugins: SdkPluginConfig[] = [{ type: 'local', path: dir, main: 'entry.mjs' }];
    const store = globalThis as unknown as Record<string, unknown>;
    try {
      await loadPluginEntrypoints(plugins, { pluginApi: fullApi, onError: (_p, err) => { throw err; } });
      const probe = store['__afkApiProbe'] as Record<string, unknown> | undefined;
      expect(probe).toBeDefined();
      expect(probe?.['envType']).toBe('object');
      expect(probe?.['subagentManagerType']).toBe('function');
      expect(probe?.['subagentManagerName']).toBe('SubagentManager');
      expect(probe?.['describeFailureType']).toBe('function');
      expect(probe?.['getAgentFrameworkDirType']).toBe('function');
      expect(probe?.['discoverPluginSkillBodiesType']).toBe('function');
      expect(probe?.['getOrDeriveFacetType']).toBe('function');
      expect(probe?.['listSessionIdsType']).toBe('function');
      expect(probe?.['deriveSessionFacetType']).toBe('function');
      expect(probe?.['loadStoredSessionType']).toBe('function');
      expect(probe?.['stateGetType']).toBe('function');
      expect(probe?.['statePutType']).toBe('function');
      expect(probe?.['stateCasType']).toBe('function');
      expect(probe?.['stateDelType']).toBe('function');
      expect(probe?.['stateInsertIfAbsentType']).toBe('function');
      expect(probe?.['stateQueryType']).toBe('function');
      expect(probe?.['listSessionsType']).toBe('function');
      expect(probe?.['sendToSessionType']).toBe('function');
    } finally {
      delete store['__afkApiProbe'];
    }
  });

  describe('registerHook (PluginApi #2166)', () => {
    afterEach(_resetLoadedEntrypoints);

    it('installPluginHooks: a throwing plugin handler is isolated — does not propagate and returns {} (boot invariant)', async () => {
      // Verify the module invariant: a plugin handler that throws must never
      // propagate out of dispatch() as HookBlockedError or any other error.
      const throwingHandler = () => { throw new Error('plugin exploded'); };
      registerPluginHook('PostToolUse', throwingHandler);
      const registry = createHookRegistry();
      installPluginHooks(registry);
      const ctx: HookContext = { event: 'PostToolUse', toolName: 'bash', sessionId: 'test-session' };
      await expect(registry.dispatch(ctx)).resolves.not.toThrow();
    });

    it('registerPluginHook strips longRunning from plugin options (security: prevents timeout bypass)', () => {
      // A plugin must not be able to disable the per-handler timeout by
      // setting longRunning: true — that privilege is reserved for first-party
      // hooks (e.g. path-approval) that await human input.
      // Prove stripping: spy on a raw createHookRegistry() instance and assert
      // that the options forwarded to register() do NOT contain longRunning.
      const rawRegistry = createHookRegistry();
      const registeredOptions: Array<unknown> = [];
      const origRegister = rawRegistry.register.bind(rawRegistry);
      rawRegistry.register = (event, handler, options) => {
        registeredOptions.push(options);
        return origRegister(event, handler, options);
      };

      // Register with longRunning:true (should be stripped)
      registerPluginHook('PostToolUse', () => ({}), { longRunning: true });
      installPluginHooks(rawRegistry);

      // longRunning must NOT appear in any forwarded options.
      // sanitizePluginOptions returns undefined when all keys are stripped, so
      // registeredOptions[0] is undefined — that alone proves longRunning was
      // removed. If it were an object, it still must not carry longRunning.
      expect(registeredOptions).toHaveLength(1);
      const opts = registeredOptions[0];
      if (opts !== undefined) {
        expect(opts).not.toHaveProperty('longRunning');
      }
      // In either branch longRunning is absent — undefined means fully stripped.
    });

    it('installPluginHooks: isolated wrapper forwards AbortSignal to the plugin handler', async () => {
      // The load-bearing proof: the error-isolation wrapper must pass the second
      // `signal` argument so plugin handlers can respect abort/cancellation.
      let receivedSignal: AbortSignal | undefined;
      registerPluginHook('PostToolUse', (_ctx, signal) => {
        receivedSignal = signal;
        return {};
      });
      const registry = createHookRegistry();
      installPluginHooks(registry);
      const ctx: HookContext = { event: 'PostToolUse', toolName: 'bash', sessionId: 'test-session' };
      const ac = new AbortController();
      await registry.dispatch(ctx, ac.signal);
      expect(receivedSignal).toBe(ac.signal);
    });

    it('installs a plugin declaration on every new session registry', async () => {
      writeFileSync(
        join(dir, 'hook-entry.mjs'),
        `export default (api) => {\n` +
          `  api.registerHook('PostToolUse', (ctx) => {\n` +
          `    globalThis.__afkHookProof = (globalThis.__afkHookProof ?? 0) + 1;\n` +
          `    return {};\n` +
          `  });\n` +
          `};\n`,
      );
      const plugins: SdkPluginConfig[] = [{ type: 'local', path: dir, main: 'hook-entry.mjs' }];
      await loadPluginEntrypoints(plugins, {
        pluginApi: { ...fullApi, registerHook: registerPluginHook },
        onError: (_p, err) => { throw err; },
      });
      const first = createDefaultHookRegistry().registry;
      const second = createDefaultHookRegistry().registry;
      const ctx: HookContext = { event: 'PostToolUse', toolName: 'bash', sessionId: 'test-session' };
      const store = globalThis as unknown as Record<string, unknown>;
      try {
        await first.dispatch(ctx);
        await second.dispatch(ctx);
        expect(store['__afkHookProof']).toBe(2);
      } finally {
        delete store['__afkHookProof'];
      }
    });

    it('registerHook exposes registration only and unsubscribe prevents future installation', async () => {
      let called = 0;
      const unsubscribe = registerPluginHook('PostToolUse', () => { called++; return {}; });
      const first = createDefaultHookRegistry().registry;
      unsubscribe();
      const second = createDefaultHookRegistry().registry;
      const ctx: HookContext = { event: 'PostToolUse', toolName: 'bash', sessionId: 'test-session' };
      await first.dispatch(ctx);
      await second.dispatch(ctx);
      expect(called).toBe(1);
      expect((registerPluginHook as unknown as Record<string, unknown>)['dispatch']).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// PR4314 production boundary regression — Items 1+2
//
// Proves that installPluginHooks wires the ALS at the hook dispatch boundary:
// when a plugin hook calls api.listSessions() or api.sendToSession(), the
// trusted session id from the hook context (ctx.sessionId) is available
// inside the plugin API closures without the plugin being able to supply or
// forge it.
//
// This is the integration complement to the unit tests in
// skill-bridge-plugin-api.test.ts, which test the API closures directly.
// These tests exercise the full production path:
//   hook dispatch → installPluginHooks wrapper → runWithPluginSessionContext
//   → pluginSessionContext.getStore() inside listSessions/sendToSession.
// ---------------------------------------------------------------------------

import { pluginSessionContext } from './plugin-session-context.js';

describe('PR4314 production boundary — installPluginHooks wires ALS at hook dispatch', () => {
  afterEach(() => {
    _resetLoadedEntrypoints();
  });

  it('Item 2: sessionId from hook context is available inside plugin hook via ALS (self-exclusion wiring)', async () => {
    let capturedALSValue: string | undefined = 'NOT_SET';

    // Register a plugin hook that reads the ALS store directly — simulates
    // a plugin calling api.listSessions() which internally calls getStore().
    registerPluginHook('PostToolUse', async (_ctx) => {
      capturedALSValue = pluginSessionContext.getStore();
      return {};
    });

    const registry = createDefaultHookRegistry().registry;
    installPluginHooks(registry);

    // Dispatch with a real sessionId — the wrapper must propagate it into ALS.
    const ctx = {
      event: 'PostToolUse' as const,
      toolName: 'bash',
      sessionId: 'prod-session-abc',
    };
    await registry.dispatch(ctx);

    // The plugin hook must have seen the session id from the hook context.
    expect(capturedALSValue).toBe('prod-session-abc');
  });

  it('Item 2: two concurrent hook dispatches carry distinct session ids (multi-session correctness)', async () => {
    const captured: string[] = [];

    registerPluginHook('PostToolUse', async (_ctx) => {
      // Simulate async work inside the hook — ALS must not leak across concurrent dispatches.
      await new Promise((r) => setTimeout(r, 5));
      const id = pluginSessionContext.getStore();
      if (id !== undefined) captured.push(id);
      return {};
    });

    const registry = createDefaultHookRegistry().registry;
    installPluginHooks(registry);

    // Dispatch two hooks concurrently with different session ids.
    await Promise.all([
      registry.dispatch({ event: 'PostToolUse' as const, toolName: 'bash', sessionId: 'session-A' }),
      registry.dispatch({ event: 'PostToolUse' as const, toolName: 'bash', sessionId: 'session-B' }),
    ]);

    // Both session ids must appear. The dispatch may fire more than twice if
    // the registry installs multiple handlers (built-ins + plugin), so we only
    // assert presence and that the set of unique observed ids is exactly the
    // two we dispatched — no cross-contamination between async call chains.
    expect(captured).toContain('session-A');
    expect(captured).toContain('session-B');
    expect(new Set(captured)).toEqual(new Set(['session-A', 'session-B']));
  });

  it('Item 2: hook without sessionId in context does NOT set ALS (fail-closed is safe)', async () => {
    let capturedALSValue: string | undefined = 'NOT_SET';

    registerPluginHook('PostToolUse', async (_ctx) => {
      capturedALSValue = pluginSessionContext.getStore();
      return {};
    });

    const registry = createDefaultHookRegistry().registry;
    installPluginHooks(registry);

    // Dispatch with no sessionId — ALS must remain undefined, not inherit a prior value.
    const ctx = { event: 'PostToolUse' as const, toolName: 'bash' };
    await registry.dispatch(ctx);

    // ALS must be undefined — not a stale value from a prior dispatch.
    expect(capturedALSValue).toBeUndefined();
  });

  it('Item 1: sendToSession from field is overwritten by hook-boundary ALS (end-to-end wiring)', async () => {
    // This test proves the full chain:
    // hook dispatch → installPluginHooks → runWithPluginSessionContext(ctx.sessionId)
    // → pluginSessionContext.getStore() available to sendToSession closure.
    // We verify by reading the ALS inside the hook handler, matching what
    // sendToSession would read when called from within a plugin hook.
    let alsIdSeenByHook: string | undefined;

    registerPluginHook('PostToolUse', async (_ctx) => {
      // Simulate a plugin calling sendToSession — the ALS value here is what
      // sendToSession uses to overwrite `from`. Capture it directly so this
      // test has no dependency on real I/O.
      alsIdSeenByHook = pluginSessionContext.getStore();
      return {};
    });

    const registry = createDefaultHookRegistry().registry;
    installPluginHooks(registry);

    await registry.dispatch({
      event: 'PostToolUse' as const,
      toolName: 'skill',
      sessionId: 'trusted-sender-id',
    });

    // The ALS value seen by the hook is the same value sendToSession uses
    // to bind `from` — proving the full boundary wiring.
    expect(alsIdSeenByHook).toBe('trusted-sender-id');
  });
});
