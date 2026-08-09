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
    writeCommand('bad.md', 'no frontmatter at all');
    const names = extractPluginCommands(pluginDir).map((c) => c.name);
    expect(names).toContain('good');
  });
});
