import { describe, expect, it, vi } from 'vitest';
import { Command, Option } from 'commander';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { repoRoot } from '../scripts/lib/docs-reference.js';
import { cliSymbols, sortSurface } from '../scripts/lib/public-surface-build.js';
import { loadPublicSurface, loadBacklog, listHandwrittenPages, stripComments, namesSymbol, namingContexts,
  type Surface, type SurfaceSymbol, type Backlog, type SymbolKind } from '../scripts/lib/public-surface.js';
import { checkDocsSurface, checkRepositorySurface } from '../scripts/check-docs-surface.js';
import { renderSurface, writeSurface } from '../scripts/render-public-surface.js';
import { collectCoverageNames } from '../scripts/check-docs-coverage.js';
import { CONFIG_KEY_SPECS } from '../src/config/settable-keys.js';
import { ENV_REGISTRY } from '../src/config/env.js';
import { collectSlash } from '../scripts/render-slash-commands.js';

const surface: Surface = { version: 1, symbols: [{ kind: 'tool', name: 'read_file' }] };
const empty: Backlog = { version: 1, entries: [] };
const backlog: Backlog = { version: 1, entries: [{ kind: 'tool', name: 'read_file', reason: 'Needs a worked example', added: '2026-10-18' }] };
const pages = [{ path: 'guide.mdx', text: 'Use `read_file`.' }];
function temporary(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'afk-surface-'));
  try { run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

function isolated(check = true, extra: NodeJS.ProcessEnv = {}): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ['--import', 'tsx', join(repoRoot, 'scripts/lib/isolated-reference.ts'), 'surface', ...(check ? ['--check'] : [])], {
    cwd: repoRoot, env: { ...process.env, ...extra }, encoding: 'utf8', timeout: 60_000,
  });
}

describe('public surface extraction', () => {
  it('collects canonical command paths and visible long flags without executing actions', () => {
    const root = new Command('afk').option('-v, --verbose').option('-x');
    const cmd = root.command('schedule').alias('sched');
    cmd.command('add').requiredOption('--cron <expr>').addOption(new Option('--secret').hideHelp()).action(() => { throw new Error('Never run'); });
    root.command('hidden', { hidden: true }).option('--private');
    const result = cliSymbols(root, () => 'src/fixture.ts');
    expect(result.filter((item) => item.kind === 'command').map((item) => item.name)).toEqual(['afk', 'afk schedule', 'afk schedule add']);
    expect(result).toContainEqual({ kind: 'flag', name: 'afk schedule add --cron', source: 'src/fixture.ts' });
    expect(result.filter((item) => item.name.includes('--verbose'))).toHaveLength(1);
    expect(result.some((item) => /hidden|secret|sched --| -x$/.test(item.name))).toBe(false);
  });

  it('sorts deterministically and rejects duplicate kind/name identities', () => {
    const input: SurfaceSymbol[] = [{ kind: 'tool', name: 'z' }, { kind: 'config', name: 'a' }];
    expect(sortSurface(input)).toEqual(sortSurface([...input].reverse()));
    expect(renderSurface(sortSurface(input))).toBe(renderSurface(sortSurface(input)));
    expect(renderSurface(sortSurface(input))).toMatch(/\n$/);
    expect(() => sortSurface([...input, input[0]!])).toThrow('Duplicate');
  });

  it('matches authoritative tool/hook, config, env, and public slash universes', async () => {
    const snapshot = await loadPublicSurface();
    const names = (kind: SymbolKind): string[] => snapshot.symbols.filter((item) => item.kind === kind).map((item) => item.name).sort();
    const coverage = collectCoverageNames(repoRoot);
    expect(names('tool')).toEqual(coverage.tools);
    expect(names('hook')).toEqual(coverage.hooks);
    expect(names('config')).toEqual(CONFIG_KEY_SPECS.map((item) => item.path).sort());
    expect(names('env')).toEqual(ENV_REGISTRY.map((item) => item.name).sort());
    const slash = collectSlash();
    expect(names('slash')).toEqual([...slash.core, ...slash.skills].map((item) => item.name).sort());
    expect(snapshot.symbols.every((item) => item.source && !item.source.includes('\\'))).toBe(true);
    expect(snapshot.symbols.find((item) => item.name === 'afk schedule add --cron')?.source).toBe('src/cli/commands/schedule.ts');
    expect(snapshot.symbols.find((item) => item.name === 'afk chat --model')?.source).toBe('src/cli/commands/shared-command-options.ts');
    expect(snapshot.symbols.find((item) => item.name === '/retry')?.source).toBe('src/cli/slash/commands/retry.ts');
  });

  it('runs deterministically in isolated homes and ignores hostile ambient config', () => {
    const first = isolated(true, { AFK_MODEL: 'POISON', AFK_INTERNAL: '1', AFK_HOME: join(tmpdir(), 'not-real-afk-home') });
    expect(first.status, `${first.stdout}\n${first.stderr}`).toBe(0);
    const second = isolated();
    expect(second.status, `${second.stdout}\n${second.stderr}`).toBe(0);
    expect(first.stdout).toBe(second.stdout);
  }, 120_000);

  it('checks byte exact output without rewriting drift or creating missing artifacts', () => {
    temporary((root) => {
      mkdirSync(join(root, 'docs'));
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        expect(writeSurface(surface, true, root)).toBe(false);
        expect(writeSurface(surface, false, root)).toBe(true);
        expect(writeSurface(surface, true, root)).toBe(true);
        const path = join(root, 'docs/public-surface.json');
        writeFileSync(path, renderSurface(surface).replaceAll('\n', '\r\n'));
        expect(writeSurface(surface, true, root)).toBe(false);
        expect(readFileSync(path, 'utf8')).toContain('\r\n');
      } finally { error.mockRestore(); log.mockRestore(); }
    });
  });
});

describe('handwritten naming rules', () => {
  const named = (kind: SymbolKind, name: string, text: string): boolean => namesSymbol({ kind, name }, text);
  it('strips both comment forms and preserves lines/offsets', () => {
    const input = 'Before\n{/* `read_file`\n afk chat */}\n<!-- /retry -->\nAfter';
    const output = stripComments(input);
    expect(output.length).toBe(input.length);
    expect(output.split('\n')).toHaveLength(input.split('\n').length);
    expect(named('tool', 'read_file', input)).toBe(false);
    expect(named('command', 'afk chat', input)).toBe(false);
  });
  it('requires entire inline tokens, not prose, fences, longer names, or escaped fragments', () => {
    for (const kind of ['slash', 'tool', 'config', 'hook'] as const) {
      expect(named(kind, 'token', '`token`')).toBe(true);
      expect(named(kind, 'token', '``token``')).toBe(true);
      expect(named(kind, 'token', 'token')).toBe(false);
      expect(named(kind, 'token', '`token more`')).toBe(false);
      expect(named(kind, 'token', '```text\ntoken\n```')).toBe(false);
    }
  });
  it('matches command prefixes only in inline code or supported shell fences', () => {
    for (const lang of ['bash', 'sh', 'zsh', 'fish', 'powershell', 'text']) {
      expect(named('command', 'afk schedule add', `\`\`\`${lang}\n$ afk schedule add --cron "* * * * *"\n\`\`\``)).toBe(true);
    }
    expect(named('command', 'afk chat', '`afk chat "hello"`')).toBe(true);
    expect(named('command', 'afk chat', '`afk chatter`')).toBe(false);
    expect(named('command', 'afk chat', 'Use afk chat')).toBe(false);
    expect(named('command', 'afk chat', '```json\nafk chat\n```')).toBe(false);
    expect(named('command', 'afk chat', '```bash\necho afk chat\n```')).toBe(false);
    expect(named('command', 'afk chat', '~~~~sh\nafk chat\n~~~~')).toBe(true);
  });
  it('does not turn fenced backticks into inline mentions, even with longer closing fences', () => {
    expect(namingContexts('````json\n`read_file`\n`````\n`real`').inline).toEqual(['real']);
  });
  it('lists sorted absolute handwritten pages, excluding only generated reference paths', () => {
    temporary((root) => {
      const base = join(root, 'website/content/docs');
      mkdirSync(join(base, 'reference'), { recursive: true });
      mkdirSync(join(base, 'guides'));
      for (const local of ['index.mdx', 'guides/cli.mdx', 'reference/cli.mdx', 'reference/slash-commands.mdx', 'reference/config-keys.mdx', 'reference/environment-variables.mdx', 'reference/tools.mdx']) {
        writeFileSync(join(base, local), '');
      }
      expect(listHandwrittenPages(root)).toEqual(['guides/cli.mdx', 'index.mdx', 'reference/tools.mdx'].map((local) => join(base, local)));
    });
  });
});

describe('documentation backlog ratchet', () => {
  it('passes a documented symbol or an honest unresolved entry', () => {
    expect(checkDocsSurface(surface, empty, pages)).toEqual([]);
    expect(checkDocsSurface(surface, backlog, [])).toEqual([]);
  });
  it('fails missing documentation/backlog', () => { expect(checkDocsSurface(surface, empty, [])[0]).toMatch(/^Missing handwritten/); });
  it('fails stale entries', () => { expect(checkDocsSurface({ version: 1, symbols: [] }, backlog, [])[0]).toMatch(/^Stale/); });
  it('fails resolved entries', () => { expect(checkDocsSurface(surface, backlog, pages)[0]).toMatch(/^Resolved/); });
  it('fails duplicates', () => { expect(checkDocsSurface(surface, { version: 1, entries: [...backlog.entries, ...backlog.entries] }, [])).toContain('Duplicate backlog entry: tool:read_file'); });
  it('fails missing or whitespace-only reasons and invalid dates', () => {
    const entries = [{ ...backlog.entries[0]!, reason: '  ', added: '2026-02-30' }];
    expect(checkDocsSurface(surface, { version: 1, entries }, [])).toEqual(['Missing reason: tool:read_file', 'Invalid added date: tool:read_file']);
  });
  it('excludes env/flags from handwritten requirements and refuses backlogging them', () => {
    const env: Surface = { version: 1, symbols: [{ kind: 'env', name: 'AFK_TEST' }] };
    expect(checkDocsSurface(env, empty, [])).toEqual([]);
    expect(checkDocsSurface(env, { version: 1, entries: [{ ...backlog.entries[0]!, kind: 'env', name: 'AFK_TEST' }] }, [])).toContain('Backlog kind is generated-reference only: env:AFK_TEST');
  });
  it('rejects unsorted entries', () => {
    const entries = [{ ...backlog.entries[0]!, name: 'z' }, { ...backlog.entries[0]!, name: 'a' }];
    expect(checkDocsSurface(surface, { version: 1, entries }, [])).toContain('Backlog entries must be sorted by kind/name');
  });
  it('loads only committed JSON without requiring source registrars in fixture roots', async () => {
    const root = mkdtempSync(join(tmpdir(), 'afk-surface-json-'));
    try {
      mkdirSync(join(root, 'docs')); mkdirSync(join(root, 'website'));
      const snapshotPath = join(root, 'docs/public-surface.json');
      writeFileSync(snapshotPath, JSON.stringify(surface));
      writeFileSync(join(root, 'website/docs-backlog.json'), JSON.stringify(backlog));
      expect(await loadPublicSurface(root)).toEqual(surface);
      expect(await loadBacklog(root)).toEqual(backlog);
      writeFileSync(snapshotPath, JSON.stringify({ ...surface, version: 2 }));
      await expect(loadPublicSurface(root)).rejects.toThrow('version');
      writeFileSync(snapshotPath, JSON.stringify({ ...surface, symbols: [{ kind: 'wrong', name: 'x' }] }));
      await expect(loadPublicSurface(root)).rejects.toThrow('known kind');
      writeFileSync(snapshotPath, JSON.stringify({ ...surface, symbols: [surface.symbols[0], surface.symbols[0]] }));
      await expect(loadPublicSurface(root)).rejects.toThrow('Duplicate');
      writeFileSync(snapshotPath, JSON.stringify({ ...surface, symbols: [{ kind: 'tool', name: 'x', source: '../escape' }] }));
      await expect(loadPublicSurface(root)).rejects.toThrow('repository-relative');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('passes the real corpus', async () => { expect(await checkRepositorySurface()).toEqual([]); });
});
