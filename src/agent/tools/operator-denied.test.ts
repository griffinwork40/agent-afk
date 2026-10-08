import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { jsonConfigTierPaths } from '../../cli/config/json-tier-paths.js';
import { parseDisabledTools, resolveOperatorDeniedTools, toolGroups } from './operator-denied.js';
import { checkToolPermission } from './permissions.js';
import { setConfigValue, unsetConfigValue } from '../../config/mutate.js';

let root: string;
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'afk-tool-denies-'));
  vi.stubEnv('HOME', join(root, 'home'));
  vi.stubEnv('AFK_HOME', join(root, 'home'));
  vi.spyOn(process, 'cwd').mockReturnValue(join(root, 'project'));
  for (const { path } of jsonConfigTierPaths()) mkdirSync(join(path, '..'), { recursive: true });
  warn = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function tier(index: number, content: unknown): void {
  writeFileSync(jsonConfigTierPaths()[index]!.path, typeof content === 'string' ? content : JSON.stringify(content));
}

describe('operator deny resolver', () => {
  it('expands every fixed group to real tools', () => {
    expect(toolGroups()['browser']).toEqual(['browser_open', 'browser_observe', 'browser_act', 'browser_screenshot', 'browser_close']);
    for (const [group, names] of Object.entries(toolGroups())) expect(parseDisabledTools([group], root)).toEqual(names);
  });
  it('ignores locked tools and warns once', () => {
    expect(parseDisabledTools(['read_file'], root)).toEqual([]);
    parseDisabledTools(['read_file'], root);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('read_file');
  });
  it('warns once for typos and rejects general globbing', () => {
    expect(parseDisabledTools(['typo_foo', 'browser_*', 'mcp__srv__to*'], root)).toEqual([]);
    parseDisabledTools(['typo_foo'], root);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls[0]![0]).toContain('typo_foo');
  });
  it('unions project, user and legacy instead of first-file wins', () => {
    tier(0, { tools: { disabled: ['browser', 'bash'] } });
    tier(1, { tools: { disabled: ['image', 'bash'] } });
    tier(2, { tools: { disabled: ['peer'] } });
    expect(new Set(resolveOperatorDeniedTools())).toEqual(new Set([...toolGroups()['browser']!, 'bash', ...toolGroups()['image']!, ...toolGroups()['peer']!]));
  });
  it('retains other tiers on JSON parse errors and malformed values', () => {
    tier(0, '{bad json');
    tier(1, { tools: { disabled: ['bash', 12] } });
    tier(2, { tools: { disabled: 'browser' } });
    expect(resolveOperatorDeniedTools()).toEqual(['bash']);
    expect(warn).toHaveBeenCalledTimes(3);
  });
  it('accepts asynchronous MCP entries and registered custom names', () => {
    expect(parseDisabledTools(['mcp__server__*', 'mcp__server__tool', 'plugin_tool'], root, ['plugin_tool'])).toHaveLength(3);
  });
});

describe('operator permission gate', () => {
  it.each([undefined, ['bash']])('denies regardless of allowlist %s', (allowedTools) => {
    expect(checkToolPermission('bash', { allowedTools, deniedTools: ['bash'] })).toEqual({
      allowed: false, reason: 'Tool "bash" is disabled by operator settings (tools.disabled in afk.config.json).',
    });
  });
  it('matches only the selected MCP server or exact tool', () => {
    const config = { deniedTools: ['mcp__srv__*', 'mcp__other__one'] };
    expect(checkToolPermission('mcp__srv__late', config).allowed).toBe(false);
    expect(checkToolPermission('mcp__srv2__late', config).allowed).toBe(true);
    expect(checkToolPermission('mcp__other__one', config).allowed).toBe(false);
    expect(checkToolPermission('mcp__other__two', config).allowed).toBe(true);
  });
});

describe('config mutation operator gate', () => {
  it.each(['tools.disabled', 'tools.disabled.0', 'tools'])('refuses setting and unsetting %s', (key) => {
    expect(() => setConfigValue(key, [])).toThrow('A human must edit afk.config.json');
    expect(() => unsetConfigValue(key)).toThrow('A human must edit afk.config.json');
  });
});

describe('built-in name coverage', () => {
  it('recognizes every non-locked top-level tool name without an unknown-entry warning', async () => {
    const { topLevelSurfaceAllowedTools } = await import('./top-level-allowlist.js');
    const { LOCKED_TOOLS } = await import('./operator-denied.js');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const names = topLevelSurfaceAllowedTools().filter((n) => !LOCKED_TOOLS.has(n));
    expect(parseDisabledTools(names, 'coverage')).toEqual(names);
    expect(spy.mock.calls.flat().join('\n')).not.toContain('unknown tool entry');
  });
});
