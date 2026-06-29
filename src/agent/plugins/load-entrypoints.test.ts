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
import { loadPluginEntrypoints, _resetLoadedEntrypoints } from './load-entrypoints.js';
import type { SdkPluginConfig } from '../types/sdk-types.js';
import { registerSkill, getSkill, listSkills, _resetRegistry } from '../../skills/index.js';
import { loadSkillPrompts } from '../../skills/_lib/prompt-loader.js';

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

    await loadPluginEntrypoints(plugins, {
      pluginApi: { registerSkill, listSkills, getSkill, loadSkillPrompts },
    });

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
        loadPluginEntrypoints(plugins, {
          pluginApi: { registerSkill, listSkills, getSkill, loadSkillPrompts },
        }),
      ).resolves.toBeUndefined();
      expect(store[key]).toBe(true);
    } finally {
      delete store[key];
    }
  });
});
