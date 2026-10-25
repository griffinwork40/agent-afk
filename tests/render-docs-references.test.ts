import { describe, expect, it, vi } from 'vitest';
import { Command, Option } from 'commander';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildCli, checkMirror, registrations } from '../scripts/render-cli-reference.js';
import { renderCli } from '../scripts/render-cli-reference.mdx.js';
import { collectSlash, isPublicBuiltin, partitionSlash } from '../scripts/render-slash-commands.js';
import { renderSlash } from '../scripts/render-slash-commands.mdx.js';
import { renderConfig } from '../scripts/render-config-keys.mdx.js';
import { CONFIG_KEY_SPECS } from '../src/config/settable-keys.js';
import { register, resetRegistry } from '../src/cli/slash/registry.js';
import type { SlashCommand } from '../src/cli/slash/types.js';
import type { SkillMetadata } from '../src/skills/skill-types.js';
import { cell, code, repoRoot, writeReference } from '../scripts/lib/docs-reference.js';

function command(name: string, extra: Partial<SlashCommand> = {}): SlashCommand {
  return { name, summary: '<summary> {x} | `code`', handler: async () => 'continue', ...extra };
}
function skill(name: string, extra: Partial<SkillMetadata> = {}): SkillMetadata {
  return { name, description: 'test', handler: async () => undefined, ...extra };
}

function runIsolated(target: string, extra: NodeJS.ProcessEnv = {}): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ['--import', 'tsx', join(repoRoot, 'scripts/lib/isolated-reference.ts'), target, '--check'], {
    cwd: repoRoot, env: { ...process.env, ...extra }, encoding: 'utf8', timeout: 60_000,
  });
}

describe('CLI reference', () => {
  it('renders deterministic metadata, nested arguments/options, aliases and guide links', () => {
    const root = new Command('afk').description('A <thing> {value}');
    const cmd = root.command('chat').alias('c').description('Use <x> or `a|b`');
    cmd.argument('<message>', 'Say {hello}').addOption(new Option('--mode <value>', '<fast>|{slow}').default('a|b'));
    cmd.command('nested').argument('[file...]', 'Files');
    root.command('secret', { hidden: true }).description('HIDDEN_COMMAND');
    cmd.addOption(new Option('--secret', 'HIDDEN_OPTION').hideHelp());
    const output = renderCli(root);
    expect(output).toBe(renderCli(root));
    expect(output).toContain('## `afk chat nested`');
    expect(output).toContain('Usage: `afk chat nested [options] [file...]`');
    expect(output).toContain('Aliases: `c`');
    expect(output).toContain('Guide: [chat](/surfaces/chat)');
    expect(output).toContain('&lt;fast&gt;\\|&#123;slow&#125;');
    expect(output).toContain('`"a\\|b"`');
    expect(output).not.toContain('HIDDEN_');
    expect(output).not.toContain('## `afk help`');
  });

  it('mirrors every registrar and alias in the entry point without importing it', () => {
    const entry = readFileSync(join(repoRoot, 'src/cli/index.ts'), 'utf8');
    const generator = readFileSync(join(repoRoot, 'scripts/render-cli-reference.ts'), 'utf8');
    expect(registrations(generator)).toEqual(registrations(entry));
    const root = buildCli();
    expect(root.commands).toHaveLength(registrations(entry).length);
    expect(root.commands.find((cmd) => cmd.name() === 'chat')?.aliases()).toContain('c');
    expect(root.commands.find((cmd) => cmd.name() === 'interactive')?.aliases()).toContain('i');
    expect(root.commands.find((cmd) => cmd.name() === 'status')?.aliases()).toContain('s');
    expect(renderCli(root)).toBe(renderCli(buildCli()));
  });

  it('returns true and logs nothing when files are in sync', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // checkMirror reads src/cli/index.ts and scripts/render-cli-reference.ts from
      // the real repo; both are in sync on HEAD so it must return true.
      expect(checkMirror()).toBe(true);
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  it('returns false and logs missing-registrar message when a registrar is absent', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // entry has registerFooCommand; generator does not → missing registrar
      const entry = 'registerFooCommand(program);\nregisterBarCommand(program);';
      const generator = 'registerBarCommand(program);';
      expect(checkMirror(entry, generator)).toBe(false);
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining('registrars in src/cli/index.ts missing from render-cli-reference.ts: registerFooCommand'),
      );
      // Must NOT emit the order-mismatch message — sets differ, not just order
      expect(spy).not.toHaveBeenCalledWith(expect.stringContaining('registration order mismatch'));
    } finally { spy.mockRestore(); }
  });

  it('returns false and logs order-mismatch message when sets are equal but order differs', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // Same registrars, different order
      const entry = 'registerFooCommand(program);\nregisterBarCommand(program);';
      const generator = 'registerBarCommand(program);\nregisterFooCommand(program);';
      expect(checkMirror(entry, generator)).toBe(false);
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining('registration order mismatch'),
      );
      // Must NOT emit the missing/extra messages — sets are equal
      expect(spy).not.toHaveBeenCalledWith(expect.stringContaining('missing from render-cli-reference.ts'));
      expect(spy).not.toHaveBeenCalledWith(expect.stringContaining('not in src/cli/index.ts'));
    } finally { spy.mockRestore(); }
  });

  it('returns false and logs both missing and extra messages when registrars differ in both directions', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // entry has Foo+Bar; generator has Bar+Baz — Foo is missing, Baz is extra
      const entry = 'registerFooCommand(program);\nregisterBarCommand(program);';
      const generator = 'registerBarCommand(program);\nregisterBazCommand(program);';
      expect(checkMirror(entry, generator)).toBe(false);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('missing from render-cli-reference.ts'));
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('not in src/cli/index.ts'));
      // Must NOT emit the order-mismatch message — sets differ, not just order
      expect(spy).not.toHaveBeenCalledWith(expect.stringContaining('registration order mismatch'));
    } finally { spy.mockRestore(); }
  });

  it('imports/registers in an empty isolated home with no state writes and neutralizes ambient config', () => {
    const result = runIsolated('cli', { AFK_MODEL: 'POISON_MODEL', CLAUDE_MODEL: 'POISON_MODEL', AFK_INTERNAL: '1' });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    // Derived, not hardcoded: a literal count breaks on every new top-level command.
    expect(result.stdout).toContain(`${buildCli().commands.length} top level commands`);
  }, 60_000);
});

describe('Slash reference', () => {
  it('excludes user/project/imported/internal and plugin passthrough commands', () => {
    resetRegistry();
    const core = command('/core', { aliases: ['/c'] });
    register(core);
    const metadata = [skill('public'), skill('user', { origin: 'user' }), skill('project', { origin: 'project' }),
      skill('imported', { origin: 'imported:claude-code' }), skill('internal', { audience: 'internal' })];
    const commands = [core, ...metadata.map((meta) => command(`/${meta.name}`, { acceptsAttachments: true })),
      command('/plugin:dynamic', { acceptsAttachments: true })];
    const result = partitionSlash(commands, metadata);
    expect(result.core.map((cmd) => cmd.name)).toEqual(['/core']);
    expect(result.core[0]?.aliases).toEqual(['/c']);
    expect(result.skills.map((cmd) => cmd.name)).toEqual(['/public']);
    expect(result.excluded).toEqual(['/imported', '/internal', '/plugin:dynamic', '/project', '/user']);
    expect(isPublicBuiltin(skill('builtin', { origin: 'builtin' }))).toBe(true);
    const output = renderSlash(result);
    expect(output).not.toContain('### `/plugin:dynamic`');
    expect(output).toContain('&lt;summary&gt; &#123;x&#125; \\| `code`');
  });

  it('sorts, renders usage/hints/flags, and is stable across registry resets', () => {
    const a = command('/a', { usage: '/a <value>', hint: 'For {things}', flags: ['--flag'] });
    const z = command('/z');
    expect(renderSlash({ core: [z, a], skills: [] })).toBe(renderSlash({ core: [a, z], skills: [] }));
    expect(renderSlash({ core: [a], skills: [] })).toContain('Usage: `/a <value>`');
    expect(renderSlash({ core: [a], skills: [] })).toContain('Hint: For &#123;things&#125;');
    expect(renderSlash({ core: [a], skills: [] })).toContain('Flags: `--flag`');
    expect(renderSlash(collectSlash())).toBe(renderSlash(collectSlash()));
  });

  it('isolates discovery from hostile ambient home/project skill inputs', () => {
    const temp = mkdtempSync(join(tmpdir(), 'afk-hostile-skills-'));
    try {
      // A poisoned caller home is deliberately not reused by the wrapper.
      const dir = join(temp, 'skills', 'poison-skill');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'SKILL.md'), '---\nname: poison-skill\ndescription: Should not be discovered\n---\nPrivate body');
      const result = runIsolated('slash', { AFK_HOME: temp, AFK_INTERNAL: '1' });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      // Derived from the in-process registry so new core commands or skills do not break this;
      // the excluded-list assertion below is what proves the poisoned skill stayed invisible.
      const expected = collectSlash();
      expect(result.stdout).toContain(`${expected.core.length} core slash commands; ${expected.skills.length} public shipped TS skills`);
      expect(result.stdout).toContain('1 excluded registered skills (/audit-fit)');
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }, 60_000);
});

describe('Config reference and shared output contract', () => {
  it('covers every config path, type, tier, enum and numeric clamp deterministically', () => {
    const output = renderConfig(CONFIG_KEY_SPECS);
    expect(output).toBe(renderConfig([...CONFIG_KEY_SPECS].reverse()));
    for (const key of CONFIG_KEY_SPECS) expect(output).toContain(`| \`${key.path}\` | ${key.type} |`);
    expect(output).toContain('0 to 2');
    expect(output).toContain('1 to 1000000; integer');
    expect(output).toContain('`default`, `plan`, `autonomous`, `bypassPermissions`');
    expect(output).toContain('Agent tier');
    expect(output).toContain('Human tier');
    expect(output).toContain('&#123; id, provider, name &#125;');
  });

  it('escapes MDX outside code spans and handles literal backticks safely', () => {
    expect(cell('x <a> {b} | `c<d>{e}|f`\nnext')).toBe('x &lt;a&gt; &#123;b&#125; \\| `c<d>{e}\\|f` next');
    expect(code('`<a>{b}|')).toBe('<code>&#96;&lt;a&gt;&#123;b&#125;&#124;</code>');
  });

  it('checks byte-exact output without overwriting drift', () => {
    const directory = mkdtempSync(join(tmpdir(), 'afk-reference-output-'));
    const slug = 'fixture';
    const path = join(directory, `${slug}.mdx`);
    try {
      expect(writeReference(slug, 'a\n', false, directory)).toBe(true);
      expect(writeReference(slug, 'a\n', true, directory)).toBe(true);
      writeFileSync(path, 'a\r\n');
      expect(writeReference(slug, 'a\n', true, directory)).toBe(false);
      expect(readFileSync(path, 'utf8')).toBe('a\r\n');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('passes an explicit scanCmd through to the drift error message', () => {
    const directory = mkdtempSync(join(tmpdir(), 'afk-reference-scanCmd-'));
    const slug = 'fixture';
    const path = join(directory, `${slug}.mdx`);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      writeFileSync(path, 'stale\n');
      const result = writeReference(slug, 'fresh\n', true, directory, 'scan:custom');
      expect(result).toBe(false);
      const errors = spy.mock.calls.map((args) => args.join(' '));
      expect(errors).toEqual(expect.arrayContaining([expect.stringMatching(/scan:custom/)]));
      expect(errors).not.toEqual(expect.arrayContaining([expect.stringMatching(/scan:fixture/)]));
    } finally {
      spy.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
