// Contract: `/config` writes to ONE file (the user-global afk.config.json) but
// the loader resolves across env > project > user > legacy. These tests pin the
// resolver that tells the menu which tier actually wins, because a wrong answer
// here reintroduces the exact bug the feature removes: a write that saves
// successfully, reports success, and silently never takes effect.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  resolveConfigProvenance,
  activeEnvShadow,
  describeSource,
  sourceSuffix,
  shadowNote,
  CONFIG_ENV_SHADOWS,
} from './provenance.js';
import { CONFIG_KEY_SPECS } from '../../config/settable-keys.js';

const TRACKED = [
  'AFK_HOME',
  'AFK_MODEL',
  'CLAUDE_MODEL',
  'AFK_MAX_TOKENS',
  'AFK_TEMPERATURE',
  'AFK_THEME',
] as const;

let tmpRoot: string;
let cwdBefore: string;
let saved: Record<string, string | undefined>;

/** Write the user-global config (the file `/config` mutates). */
function writeUserConfig(obj: unknown): void {
  const dir = join(tmpRoot, 'home', 'config');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'afk.config.json'), JSON.stringify(obj), 'utf8');
}

/** Write a project-local config in cwd (outranks the user file). */
function writeProjectConfig(raw: string): void {
  writeFileSync(join(tmpRoot, 'project', 'afk.config.json'), raw, 'utf8');
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'afk-provenance-'));
  mkdirSync(join(tmpRoot, 'project'), { recursive: true });
  cwdBefore = process.cwd();
  process.chdir(join(tmpRoot, 'project'));
  saved = {};
  for (const k of TRACKED) saved[k] = process.env[k];
  for (const k of TRACKED) delete process.env[k];
  process.env['AFK_HOME'] = join(tmpRoot, 'home');
});

afterEach(() => {
  process.chdir(cwdBefore);
  for (const k of TRACKED) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('resolveConfigProvenance — tier precedence', () => {
  it('reports the user file when it is the only source, with no shadow', () => {
    writeUserConfig({ model: 'sonnet' });
    const p = resolveConfigProvenance('model');
    expect(p.effective).toBe('sonnet');
    expect(p.source.kind).toBe('user');
    expect(p.shadowedBy).toBeUndefined();
    expect(sourceSuffix(p)).toBeUndefined(); // the unsurprising case stays quiet
  });

  it('reports `default` when no tier supplies the key', () => {
    const p = resolveConfigProvenance('model');
    expect(p.effective).toBeUndefined();
    expect(p.source.kind).toBe('default');
    expect(p.shadowedBy).toBeUndefined();
  });

  it('lets a project config outrank the user file and flags it as shadowing', () => {
    writeUserConfig({ model: 'sonnet' });
    writeProjectConfig(JSON.stringify({ model: 'haiku' }));
    const p = resolveConfigProvenance('model');
    expect(p.effective).toBe('haiku');
    expect(p.source.kind).toBe('project');
    expect(p.shadowedBy?.kind).toBe('project');
    // The user file's own value is still reported — that is what a write edits.
    expect(p.userValue).toBe('sonnet');
    expect(shadowNote(p)).toMatch(/outranks the user config/);
  });

  it('lets env outrank every file and names the variable', () => {
    writeUserConfig({ model: 'sonnet' });
    writeProjectConfig(JSON.stringify({ model: 'haiku' }));
    process.env['AFK_MODEL'] = 'opus';
    const p = resolveConfigProvenance('model');
    expect(p.effective).toBe('opus');
    expect(p.source).toEqual({ kind: 'env', via: 'AFK_MODEL' });
    expect(describeSource(p.source)).toBe('env AFK_MODEL');
    expect(shadowNote(p)).toMatch(/AFK_MODEL is set in the environment/);
  });

  it('falls back to the secondary env alias (CLAUDE_MODEL) only when the primary is unset', () => {
    process.env['CLAUDE_MODEL'] = 'haiku';
    expect(activeEnvShadow('model')).toBe('CLAUDE_MODEL');
    process.env['AFK_MODEL'] = 'opus';
    expect(activeEnvShadow('model')).toBe('AFK_MODEL');
  });

  it('treats the first loadable config as the whole-file winner', () => {
    writeUserConfig({ model: 'sonnet' });
    writeProjectConfig(JSON.stringify({ theme: 'light' }));
    const p = resolveConfigProvenance('model');
    expect(p.effective).toBeUndefined();
    expect(p.source.kind).toBe('default');
    expect(p.shadowedBy?.kind).toBe('project');
    expect(p.userValue).toBe('sonnet');
    expect(shadowNote(p)).toMatch(/loaded INSTEAD of it/);
  });

  it('reports the loader-validated value rather than invalid raw JSON', () => {
    writeUserConfig({ permissionMode: 'yolo' });
    const p = resolveConfigProvenance('permissionMode');
    expect(p.effective).toBeUndefined();
    expect(p.source.kind).toBe('default');
    expect(p.userValue).toBe('yolo');
  });

  it('reports the loader-coerced value', () => {
    writeUserConfig({ model: 'SONNET' });
    const p = resolveConfigProvenance('model');
    expect(p.effective).toBe('sonnet');
    expect(p.source.kind).toBe('user');
    expect(p.userValue).toBe('SONNET');
  });

  it('tolerates a malformed project config instead of throwing (mirrors the loader)', () => {
    writeUserConfig({ model: 'sonnet' });
    writeProjectConfig('{ not json');
    const p = resolveConfigProvenance('model');
    expect(p.effective).toBe('sonnet');
    expect(p.source.kind).toBe('user');
  });

  it('resolves dotted paths', () => {
    writeUserConfig({ interactive: { thinkingUi: 'digest' } });
    const p = resolveConfigProvenance('interactive.thinkingUi');
    expect(p.effective).toBe('digest');
    expect(p.source.kind).toBe('user');
  });
});

describe('activeEnvShadow — the loader is truthiness- and parse-gated', () => {
  it('treats an empty env var as absent (the loader does)', () => {
    process.env['AFK_MODEL'] = '';
    expect(activeEnvShadow('model')).toBeUndefined();
  });

  it('ignores an unparseable AFK_MAX_TOKENS, which the loader also skips', () => {
    process.env['AFK_MAX_TOKENS'] = 'abc';
    expect(activeEnvShadow('maxTokens')).toBeUndefined();
    process.env['AFK_MAX_TOKENS'] = '100';
    expect(activeEnvShadow('maxTokens')).toBe('AFK_MAX_TOKENS');
  });

  it('ignores a non-finite AFK_TEMPERATURE', () => {
    process.env['AFK_TEMPERATURE'] = 'hot';
    expect(activeEnvShadow('temperature')).toBeUndefined();
    process.env['AFK_TEMPERATURE'] = '0.7';
    expect(activeEnvShadow('temperature')).toBe('AFK_TEMPERATURE');
  });

  it('returns undefined for a key with no env twin', () => {
    // permissionMode resolves JSON-only (resolveCliPermissionMode) — claiming an
    // env override for it would be wrong.
    expect(activeEnvShadow('permissionMode')).toBeUndefined();
    expect(CONFIG_ENV_SHADOWS['permissionMode']).toBeUndefined();
  });
});

describe('CONFIG_ENV_SHADOWS integrity', () => {
  it('only maps paths that are real config keys', () => {
    const known = new Set(CONFIG_KEY_SPECS.map((s) => s.path));
    for (const path of Object.keys(CONFIG_ENV_SHADOWS)) {
      expect(known.has(path), `${path} is not a CONFIG_KEY_SPECS path`).toBe(true);
    }
  });

  it('maps all four autoRouting sub-keys, since AFK_AUTO_ROUTING sets them together', () => {
    for (const sub of ['interactive', 'chat', 'telegram', 'daemon']) {
      expect(CONFIG_ENV_SHADOWS[`autoRouting.${sub}`]).toEqual(['AFK_AUTO_ROUTING']);
    }
  });
});
