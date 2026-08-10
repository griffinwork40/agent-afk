/**
 * Tests for Claude Code `commands/*.md` discovery.
 *
 * Fixture shape mirrors the plugin-agents suite in skill-bridge.test.ts:
 * a tmpdir plugin root written per-case, passed by path.
 *
 * @module agent/plugins/command-files.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { extractPluginCommands } from './command-files.js';
import { normalizeSkillSource, MAX_SKILL_SOURCE_CHARS } from './source-guard.js';

let pluginDir: string;

function writeCommand(relPath: string, contents: string): void {
  const full = join(pluginDir, 'commands', relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, contents);
}

beforeEach(() => {
  pluginDir = mkdtempSync(join(tmpdir(), 'plugin-commands-test-'));
});
afterEach(() => {
  rmSync(pluginDir, { recursive: true, force: true });
});

describe('extractPluginCommands', () => {
  it('returns [] when the plugin ships no commands/ directory', () => {
    expect(extractPluginCommands(pluginDir)).toEqual([]);
  });

  it('derives the command name from the filename, not frontmatter', () => {
    writeCommand('deploy.md', '---\ndescription: Ship it\n---\n\nDeploy the app.\n');
    const found = extractPluginCommands(pluginDir);
    expect(found).toHaveLength(1);
    expect(found[0]?.name).toBe('deploy');
    expect(found[0]?.description).toBe('Ship it');
    expect(found[0]?.body).toContain('Deploy the app.');
  });

  it('accepts a plain Markdown prompt without frontmatter', () => {
    writeCommand('review.md', 'Review this pull request: $ARGUMENTS\n');
    const found = extractPluginCommands(pluginDir);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      name: 'review',
      body: 'Review this pull request: $ARGUMENTS',
      origin: 'command',
    });
    // A frontmatter-free file declares no description; collectSkillEntries
    // supplies the plugin-path fallback downstream.
    expect(found[0]?.description).toBeUndefined();
  });

  it('parses a CRLF-authored command instead of leaking its frontmatter into the body', () => {
    // A Windows-authored file fails a byte-exact `---\n` test, so without
    // normalisation the whole YAML block was handed to the model as the prompt.
    writeCommand('crlf.md', '---\r\ndescription: Ship it\r\n---\r\n\r\nDeploy the app.\r\n');
    const found = extractPluginCommands(pluginDir);
    expect(found).toHaveLength(1);
    expect(found[0]?.description).toBe('Ship it');
    expect(found[0]?.body).toBe('Deploy the app.');
    expect(found[0]?.body).not.toContain('---');
  });

  it('parses a BOM-prefixed command instead of leaking its frontmatter into the body', () => {
    writeCommand('bom.md', '\uFEFF---\ndescription: Ship it\n---\n\nDeploy the app.\n');
    const found = extractPluginCommands(pluginDir);
    expect(found).toHaveLength(1);
    expect(found[0]?.description).toBe('Ship it');
    expect(found[0]?.body).toBe('Deploy the app.');
    expect(found[0]?.body).not.toContain('---');
  });

  it('parses a CR-only command file (classic Mac line endings)', () => {
    writeCommand('cr.md', '---\rdescription: Ship it\r---\r\rDeploy the app.\r');
    const found = extractPluginCommands(pluginDir);
    expect(found).toHaveLength(1);
    expect(found[0]?.description).toBe('Ship it');
    expect(found[0]?.body).toBe('Deploy the app.');
  });

  it('skips a path segment containing the namespace separator', () => {
    // `a:b.md` would derive the same name as `a/b.md`; registering both lets
    // the first-wins guard drop one at random. Distinct bodies make it
    // possible to tell WHICH file survived: deleting the colon guard would
    // let `a:b.md` register (or race with `a/b.md`), and either outcome must
    // fail this assertion since only the `a/b.md` body is expected to survive.
    writeCommand('a:b.md', '---\ndescription: d\n---\n\nColon body.\n');
    writeCommand('a/b.md', '---\ndescription: d\n---\n\nSlash body.\n');
    const found = extractPluginCommands(pluginDir);
    const names = found.map((c) => c.name);
    expect(names).toEqual(['a:b']);
    expect(names).toHaveLength(1);
    expect(found[0]?.body).toBe('Slash body.');
  });

  it('namespaces a subdirectory with a colon (CC parity)', () => {
    writeCommand('review/security.md', '---\ndescription: Sec review\n---\n\nCheck auth.\n');
    const found = extractPluginCommands(pluginDir);
    expect(found[0]?.name).toBe('review:security');
  });

  it('namespaces nested subdirectories', () => {
    writeCommand('a/b/c.md', '---\ndescription: Deep\n---\n\nBody.\n');
    expect(extractPluginCommands(pluginDir)[0]?.name).toBe('a:b:c');
  });

  it('marks every discovered command with origin: command', () => {
    writeCommand('one.md', '---\ndescription: One\n---\n\nBody.\n');
    expect(extractPluginCommands(pluginDir)[0]?.origin).toBe('command');
  });

  it('ignores a stray frontmatter name: so the path stays authoritative', () => {
    // CC addresses a command by its path; honouring a `name:` would make the
    // file invocable under a name its own location does not predict.
    writeCommand('real-name.md', '---\nname: bogus\ndescription: d\n---\n\nBody.\n');
    expect(extractPluginCommands(pluginDir)[0]?.name).toBe('real-name');
  });

  it('parses argument-hint and model frontmatter via the shared SKILL.md parser', () => {
    writeCommand(
      'x.md',
      '---\ndescription: d\nargument-hint: "[pr-number]"\nmodel: opus\n---\n\nBody.\n',
    );
    const cmd = extractPluginCommands(pluginDir)[0];
    expect(cmd?.argumentHint).toBe('[pr-number]');
    expect(cmd?.model).toBe('opus');
  });

  it('skips non-markdown files and dotfiles', () => {
    writeCommand('real.md', '---\ndescription: d\n---\n\nBody.\n');
    writeCommand('README.txt', 'not a command');
    writeCommand('.hidden.md', '---\ndescription: d\n---\n\nBody.\n');
    const names = extractPluginCommands(pluginDir).map((c) => c.name);
    expect(names).toEqual(['real']);
  });

  it('skips a command with an empty body rather than registering an inert slash', () => {
    writeCommand('empty.md', '---\ndescription: d\n---\n');
    expect(extractPluginCommands(pluginDir)).toEqual([]);
  });

  it('returns results sorted by name so ordering does not depend on the filesystem', () => {
    writeCommand('zebra.md', '---\ndescription: d\n---\n\nB.\n');
    writeCommand('alpha.md', '---\ndescription: d\n---\n\nB.\n');
    writeCommand('middle.md', '---\ndescription: d\n---\n\nB.\n');
    expect(extractPluginCommands(pluginDir).map((c) => c.name)).toEqual([
      'alpha',
      'middle',
      'zebra',
    ]);
  });

  it('survives a malformed file without losing its siblings', () => {
    // One bad command in a third-party plugin must not break discovery for
    // every other command it ships.
    writeCommand('good.md', '---\ndescription: d\n---\n\nBody.\n');
    writeCommand('bad.md', '---\ndescription: unterminated frontmatter');
    const names = extractPluginCommands(pluginDir).map((c) => c.name);
    expect(names).toContain('good');
    // The malformed sibling must be dropped, not registered with a raw body.
    expect(names).not.toContain('bad');
  });
});

describe('normalizeSkillSource', () => {
  it('strips NUL bytes', () => {
    expect(normalizeSkillSource('a\x00b')).toBe('ab');
  });

  it('strips other C0 control chars but keeps \\t and \\n', () => {
    expect(normalizeSkillSource('a\x01\x02b\tc\nd\x1F')).toBe('ab\tc\nd');
  });

  it('truncates over-cap input to exactly MAX_SKILL_SOURCE_CHARS', () => {
    const oversized = 'x'.repeat(MAX_SKILL_SOURCE_CHARS + 100);
    const result = normalizeSkillSource(oversized);
    expect(result.length).toBe(MAX_SKILL_SOURCE_CHARS);
    expect(result).toBe('x'.repeat(MAX_SKILL_SOURCE_CHARS));
  });

  it('still handles BOM+CRLF when combined with control stripping and truncation', () => {
    const result = normalizeSkillSource('\uFEFF---\r\ndescription: d\r\n---\r\n\r\nBody.\r\n');
    expect(result).toBe('---\ndescription: d\n---\n\nBody.\n');
  });

  it('never throws, and truncation alone never discards non-control content', () => {
    expect(() => normalizeSkillSource('\x00\x00\x00')).not.toThrow();
    expect(() => normalizeSkillSource('x'.repeat(MAX_SKILL_SOURCE_CHARS * 2))).not.toThrow();
    expect(normalizeSkillSource('a\x00')).toBe('a');
  });
});
