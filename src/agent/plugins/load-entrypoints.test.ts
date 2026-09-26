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
  // Dynamic .mjs import via file:// URLs is not reliably supported on Windows CI.
  it.skipIf(process.platform === 'win32')('imports and runs a plugin main module (side-effects fire at boot)', async () => {
    const key = `__afkBootProof_${Math.random().toString(36).slice(2)}`;
    writeFileSync(
      join(dir, 'entry.mjs'),
      `globalThis[${JSON.stringify(key)}] = (globalThis[${JSON.stringify(key)}] ?? 0) + 1;\n`,
    );
    const plugins: SdkPluginConfig[] = [{ type: 'local', path: dir, main: 'entry.mjs' }];

    await loadPluginEntrypoints(plugins);

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

  it.skipIf(process.platform === 'win32')('injects the host API into a default-export entrypoint so a plugin registers into the HOST registry (round-trip)', async () => {
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

    await loadPluginEntrypoints(plugins, { pluginApi: fullApi });

    try {
      expect(listSkills()).toContain(skillName);
      expect(getSkill(skillName).description).toBe('round-trip proof');
    } finally {
      _resetRegistry();
    }
  });

  it.skipIf(process.platform === 'win32')('still runs top-level side-effects when an entrypoint has no default export, even with pluginApi supplied (back-compat)', async () => {
    const key = `__afkSideEffectProof_${Math.random().toString(36).slice(2)}`;
    writeFileSync(join(dir, 'entry.mjs'), `globalThis[${JSON.stringify(key)}] = true;\n`);
    const plugins: SdkPluginConfig[] = [{ type: 'local', path: dir, main: 'entry.mjs' }];
    const store = globalThis as unknown as Record<string, unknown>;
    try {
      await expect(
        loadPluginEntrypoints(plugins, { pluginApi: fullApi }),
      ).resolves.toBeUndefined();
      expect(store[key]).toBe(true);
    } finally {
      delete store[key];
    }
  });

  it.skipIf(process.platform === 'win32')('injects core runtime values (env, SubagentManager, …) a marketplace clone cannot import directly', async () => {
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
        `  };\n` +
        `};\n`,
    );
    const plugins: SdkPluginConfig[] = [{ type: 'local', path: dir, main: 'entry.mjs' }];
    const store = globalThis as unknown as Record<string, unknown>;
    try {
      await loadPluginEntrypoints(plugins, { pluginApi: fullApi });
      const probe = store.__afkApiProbe as Record<string, unknown> | undefined;
      expect(probe).toBeDefined();
      expect(probe?.envType).toBe('object');
      expect(probe?.subagentManagerType).toBe('function');
      expect(probe?.subagentManagerName).toBe('SubagentManager');
      expect(probe?.describeFailureType).toBe('function');
      expect(probe?.getAgentFrameworkDirType).toBe('function');
      expect(probe?.discoverPluginSkillBodiesType).toBe('function');
      expect(probe?.getOrDeriveFacetType).toBe('function');
      expect(probe?.listSessionIdsType).toBe('function');
      expect(probe?.deriveSessionFacetType).toBe('function');
      expect(probe?.loadStoredSessionType).toBe('function');
    } finally {
      delete store.__afkApiProbe;
    }
  });

  describe('registerHook (PluginApi #2166)', () => {
    afterEach(_resetLoadedEntrypoints);

    it('installPluginHooks: a throwing plugin handler is isolated — does not propagate and returns {} (boot invariant)', async () => {
      // Verify the module invariant: a plugin handler that throws must never
      // propagate out of dispatch() as HookBlockedError or any other error.
      const throwingHandler = () => { throw new Error('plugin exploded'); };
      registerPluginHook('PostToolUse', throwingHandler);
      const registry = createDefaultHookRegistry().registry;
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
      const registry = createDefaultHookRegistry().registry;
      const ctx: HookContext = { event: 'PostToolUse', toolName: 'bash', sessionId: 'test-session' };
      const ac = new AbortController();
      await registry.dispatch(ctx, ac.signal);
      expect(receivedSignal).toBe(ac.signal);
    });

    it.skipIf(process.platform === 'win32')('installs a plugin declaration on every new session registry', async () => {
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
      });
      const first = createDefaultHookRegistry().registry;
      const second = createDefaultHookRegistry().registry;
      const ctx: HookContext = { event: 'PostToolUse', toolName: 'bash', sessionId: 'test-session' };
      const store = globalThis as unknown as Record<string, unknown>;
      try {
        await first.dispatch(ctx);
        await second.dispatch(ctx);
        expect(store.__afkHookProof).toBe(2);
      } finally {
        delete store.__afkHookProof;
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
