import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildToolRows, disabledCount, runToolsMenu, type ToolsMenuIo } from './config-menu-tools.js';
import { runConfigMenu, type MenuIo, type MenuOverlays } from './config-menu.js';
import { writeUserDisabledTools, readDisabledToolsByTier, type TierDisabledTools } from '../config/tools-disabled.js';
import { LOCKED_TOOLS, toolGroups } from '../../agent/tools/operator-denied.js';
import { jsonConfigTierPaths } from '../config/json-tier-paths.js';

// eslint-disable-next-line no-control-regex
const strip = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, '');

class FakeOverlays implements MenuOverlays {
  emits: string[] = [];
  picks: Array<number | null>;
  manyCalls: Array<{ options: readonly string[]; initial: ReadonlySet<number> }> = [];
  constructor(picks: Array<number | null>, private readonly many: ((opts: readonly string[], init: ReadonlySet<number>) => number[] | null) | null) {
    this.picks = picks;
  }
  async pick(): Promise<number | null> { return this.picks.length > 0 ? this.picks.shift()! : null; }
  async editText(): Promise<string | null> { return null; }
  emit(line: string): void { this.emits.push(strip(line)); }
  get pickMany(): MenuOverlays['pickMany'] {
    if (!this.many) return undefined;
    const many = this.many;
    return async (_h, options, initial) => {
      this.manyCalls.push({ options: options.map(strip), initial });
      return many(options.map(strip), initial);
    };
  }
}

function fakeIo(tiers: TierDisabledTools[], mcp: string[] = []): ToolsMenuIo & { writes: string[][]; fail?: boolean } {
  const io = {
    writes: [] as string[][],
    fail: false,
    byTier: () => tiers,
    writeUser(entries: readonly string[]) {
      if (io.fail) throw new Error('disk full');
      io.writes.push([...entries]);
    },
    mcpServers: () => mcp,
  };
  return io;
}
const userTier = (entries: string[]): TierDisabledTools => ({ tier: 'user', label: 'user config', path: '/u/afk.config.json', entries });
const projectTier = (entries: string[]): TierDisabledTools => ({ tier: 'project', label: 'project config', path: '/p/afk.config.json', entries });
const rowIndex = (opts: readonly string[], entry: string): number => opts.findIndex((o) => o.split(/\s+/)[0] === entry);
/** Uncheck the given entries from the initial selection. */
const uncheck = (...entries: string[]) => (opts: readonly string[], init: ReadonlySet<number>): number[] =>
  [...init].filter((i) => !entries.some((e) => rowIndex(opts, e) === i));
/** Check the given entries in addition to the initial selection. */
const check = (...entries: string[]) => (opts: readonly string[], init: ReadonlySet<number>): number[] =>
  [...new Set([...init, ...entries.map((e) => rowIndex(opts, e))])];

describe('buildToolRows', () => {
  it('lists groups first, then non-locked non-grouped builtins, then MCP servers, then extra configured entries', () => {
    const rows = buildToolRows(['zeta', 'alpha'], ['mcp__alpha__echo', 'browser_open', 'bash', 'read_file']);
    const entries = rows.map((r) => r.entry);
    expect(entries.slice(0, 5)).toEqual(['browser', 'image', 'clipboard', 'peer', 'schedules']);
    expect(entries).toContain('bash');
    expect(entries.filter((e) => LOCKED_TOOLS.has(e))).toEqual(['read_file']); // only via config, flagged
    expect(rows.find((r) => r.entry === 'read_file')!.detail).toContain('locked');
    expect(entries.indexOf('mcp__alpha__*')).toBeLessThan(entries.indexOf('mcp__zeta__*'));
    expect(entries.slice(-3)).toEqual(['mcp__alpha__echo', 'browser_open', 'read_file']); // extras in config order; bash already listed
    expect(new Set(entries).size).toBe(entries.length);
    for (const r of rows.slice(0, 5)) expect(r.detail.length).toBeLessThanOrEqual(64); // never wraps
    for (const member of Object.values(toolGroups()).flat()) {
      if (member !== 'browser_open') expect(entries).not.toContain(member);
    }
  });
});

describe('runToolsMenu', () => {
  it('pre-checks enabled tools and writes the unchecked set to the user tier', async () => {
    const io = fakeIo([userTier(['image'])], ['jev']);
    const ov = new FakeOverlays([], uncheck('bash', 'mcp__jev__*'));
    await runToolsMenu(ov, io);
    const { options, initial } = ov.manyCalls[0]!;
    expect(initial.has(rowIndex(options, 'image'))).toBe(false);
    expect(initial.has(rowIndex(options, 'bash'))).toBe(true);
    expect(io.writes).toEqual([['image', 'bash', 'mcp__jev__*']]);
    expect(ov.emits.join('\n')).toContain('tools.disabled = image, bash, mcp__jev__*');
  });

  it('re-enables a user entry the menu would not otherwise list (never drops it silently)', async () => {
    const io = fakeIo([userTier(['mcp__jev__jev_score', 'bash'])]);
    const ov = new FakeOverlays([], check('mcp__jev__jev_score'));
    await runToolsMenu(ov, io);
    expect(io.writes).toEqual([['bash']]);
  });

  it('Esc writes nothing', async () => {
    const io = fakeIo([userTier([])]);
    await runToolsMenu(new FakeOverlays([], () => null), io);
    expect(io.writes).toEqual([]);
  });

  it('reports no changes without writing', async () => {
    const io = fakeIo([userTier(['bash'])]);
    const ov = new FakeOverlays([], (_o, init) => [...init]);
    await runToolsMenu(ov, io);
    expect(io.writes).toEqual([]);
    expect(ov.emits.join('\n')).toContain('no changes');
  });

  it('cannot enable an entry disabled by another tier and says which file holds it', async () => {
    const io = fakeIo([userTier([]), projectTier(['bash'])]);
    const ov = new FakeOverlays([], check('bash'));
    await runToolsMenu(ov, io);
    const { options, initial } = ov.manyCalls[0]!;
    expect(initial.has(rowIndex(options, 'bash'))).toBe(false);
    expect(options[rowIndex(options, 'bash')]).toContain('← off in project config');
    expect(io.writes).toEqual([]); // nothing changed in the user tier
    expect(ov.emits.join('\n')).toContain('bash stays off: disabled in project config (/p/afk.config.json)');
  });

  it('does not duplicate another tier entry into the user list when left unchecked', async () => {
    const io = fakeIo([userTier([]), projectTier(['bash'])]);
    await runToolsMenu(new FakeOverlays([], uncheck('web_request')), io);
    expect(io.writes).toEqual([['web_request']]);
  });

  it('echoes a write failure instead of throwing', async () => {
    const io = fakeIo([userTier([])]);
    io.fail = true;
    const ov = new FakeOverlays([], uncheck('bash'));
    await expect(runToolsMenu(ov, io)).resolves.toBeUndefined();
    expect(ov.emits.join('\n')).toContain('✗ disk full');
  });

  it('counts distinct entries across tiers', () => {
    expect(disabledCount(fakeIo([userTier(['bash', 'image']), projectTier(['bash'])]))).toBe(2);
  });
});

describe('runConfigMenu Tools entry', () => {
  const baseIo = (tools?: ToolsMenuIo): MenuIo => ({
    specs: () => [{ path: 'temperature', tier: 'agent', type: 'number', description: 't' }],
    current: () => undefined,
    write: () => '',
    ...(tools ? { tools } : {}),
  });

  it('appends Tools after the categories and opens the checklist', async () => {
    const tools = fakeIo([userTier([])]);
    const ov = new FakeOverlays([1, null], uncheck('bash')); // index 1 = Tools (one category before it)
    await runConfigMenu(ov, baseIo(tools));
    expect(tools.writes).toEqual([['bash']]);
  });

  it('omits Tools when the overlay cannot multi-select', async () => {
    const tools = fakeIo([userTier([])]);
    const ov = new FakeOverlays([1, null], null);
    await runConfigMenu(ov, baseIo(tools));
    expect(tools.writes).toEqual([]);
  });
});

describe('tools-disabled store', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('writes the user list, preserving other keys, and removes the key when emptied', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'afk-tools-store-')), 'afk.config.json');
    writeFileSync(file, JSON.stringify({ model: 'sonnet', tools: { other: 1 } }));
    writeUserDisabledTools(['bash', 'bash', 'image'], file);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ model: 'sonnet', tools: { other: 1, disabled: ['bash', 'image'] } });
    expect(existsSync(`${file}.bak`)).toBe(true);
    writeUserDisabledTools([], file);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ model: 'sonnet', tools: { other: 1 } });
  });

  it('drops an emptied tools object and refuses to overwrite a malformed file', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'afk-tools-store-')), 'afk.config.json');
    writeFileSync(file, JSON.stringify({ tools: { disabled: ['bash'] } }));
    writeUserDisabledTools([], file);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({});
    writeFileSync(file, '{ not json');
    expect(() => writeUserDisabledTools(['bash'], file)).toThrow();
    expect(readFileSync(file, 'utf8')).toBe('{ not json');
  });

  it('reads raw entries per existing tier and flags unreadable files', () => {
    const root = mkdtempSync(join(tmpdir(), 'afk-tools-tiers-'));
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const [project] = jsonConfigTierPaths();
    writeFileSync(project!.path, JSON.stringify({ tools: { disabled: ['bash', 7, 'browser'] } }));
    const tiers = readDisabledToolsByTier();
    expect(tiers.find((t) => t.tier === 'project')).toMatchObject({ entries: ['bash', 'browser'], label: 'project afk.config.json' });
    writeFileSync(project!.path, '{ broken');
    expect(readDisabledToolsByTier().find((t) => t.tier === 'project')).toMatchObject({ entries: [], unreadable: true });
  });
});
