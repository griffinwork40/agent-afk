/**
 * Tests for Claude Code `commands/*.md` discovery.
 *
 * Fixture shape mirrors the plugin-agents suite in skill-bridge.test.ts:
 * a tmpdir plugin root written per-case, passed by path.
 *
 * @module agent/plugins/command-files.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { extractPluginCommands } from './command-files.js';
import { _resetPluginScanCache } from '../plugins-scanner.js';
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

  it('skips a .md command whose filename carries a terminal escape', () => {
    // The name comes from the PATH, so a filename is the one place a plugin
    // can inject bytes into it — and the name is later written to the terminal
    // by the /skills listing and by the shadowing notice, neither of which
    // sanitizes. The fixture MUST end in `.md`: a `.txt` fixture is rejected
    // by the extension filter before the name is ever derived, so it cannot
    // exercise this guard no matter how the guard behaves.
    writeCommand('evil\x1b[2J\x1b[H.md', '---\ndescription: d\n---\n\nEvil body.\n');
    writeCommand('safe.md', '---\ndescription: d\n---\n\nSafe body.\n');
    const found = extractPluginCommands(pluginDir);
    expect(found.map((c) => c.name)).toEqual(['safe']);
    // Guard the property, not just the count: no registered name may carry a
    // control byte, however many commands a plugin ships.
    for (const c of found) expect(c.name).not.toMatch(/[\u0000-\u001F\u007F-\u009F]/);
  });

  it('skips a subdirectory segment carrying a control byte', () => {
    // Directory segments reach the name through `segments`, a different route
    // than the filename `base` — both must be rejected by the single guard.
    writeCommand('ev\x07il/cmd.md', '---\ndescription: d\n---\n\nEvil body.\n');
    writeCommand('ok/cmd.md', '---\ndescription: d\n---\n\nOk body.\n');
    const found = extractPluginCommands(pluginDir);
    expect(found.map((c) => c.name)).toEqual(['ok:cmd']);
  });

  it('skips a filename carrying a C1 control byte (8-bit CSI)', () => {
    // U+009B is CSI in 8-bit form: terminals in 8-bit mode act on it exactly
    // as they do on ESC-[, so restricting the guard to C0 would leave a
    // working vector open.
    writeCommand('evil\u009b2J.md', '---\ndescription: d\n---\n\nEvil body.\n');
    expect(extractPluginCommands(pluginDir)).toEqual([]);
  });

  it('excludes a commands/ entry symlinked outside the plugin tree', () => {
    // `resolveContained` is the control stopping a plugin from symlinking a
    // private key or credential file into `commands/` and having it become a
    // dispatchable prompt. The accept-path is covered incidentally by every
    // other case here; this asserts the REJECT branch, which had no coverage
    // anywhere in the repo.
    const outside = mkdtempSync(join(tmpdir(), 'plugin-commands-outside-'));
    try {
      const secret = join(outside, 'secret.md');
      writeFileSync(secret, '---\ndescription: d\n---\n\nSecret body.\n');
      mkdirSync(join(pluginDir, 'commands'), { recursive: true });
      symlinkSync(secret, join(pluginDir, 'commands', 'help.md'));
      writeCommand('safe.md', '---\ndescription: d\n---\n\nSafe body.\n');
      const found = extractPluginCommands(pluginDir);
      expect(found.map((c) => c.name)).toEqual(['safe']);
      expect(found.map((c) => c.body).join('')).not.toContain('Secret body.');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
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

  it('strips a terminal escape embedded in an untrusted plugin filename', () => {
    // The AFK_DEBUG skip diagnostics interpolate raw `readdirSync` entries
    // from a third-party plugin tree. Without sanitisation, a directory or
    // file named with a CSI/OSC sequence executes against the operator's
    // terminal the moment discovery logs the skip.
    const tmp = mkdtempSync(join(tmpdir(), 'cmd-esc-'));
    try {
      vi.stubEnv('AFK_DEBUG', '1');
      mkdirSync(join(tmp, 'commands'), { recursive: true });
      writeFileSync(join(tmp, 'commands', 'evil\x1b[2J\x1b[H.txt'), 'x');

      const writes: string[] = [];
      const spy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation((chunk: unknown) => {
          writes.push(String(chunk));
          return true;
        });
      extractPluginCommands(tmp);
      spy.mockRestore();

      const emitted = writes.join('');
      expect(emitted).toContain('skipping');
      expect(emitted).not.toContain('\x1b');
    } finally {
      vi.unstubAllEnvs();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('folds a lone CR to LF rather than stripping it as a control char', () => {
    // Order invariant: CR (0x0D) falls inside the control-strip range
    // [\x00-\x08\x0B-\x1F], so it survives only because newline
    // normalisation runs FIRST and turns it into \n. Reordering the two
    // passes would silently delete the line break instead of keeping it.
    expect(normalizeSkillSource('a\rb')).toBe('a\nb');
  });

  it('never throws, and truncation alone never discards non-control content', () => {
    expect(() => normalizeSkillSource('\x00\x00\x00')).not.toThrow();
    expect(() => normalizeSkillSource('x'.repeat(MAX_SKILL_SOURCE_CHARS * 2))).not.toThrow();
    expect(normalizeSkillSource('a\x00')).toBe('a');
  });
});

describe('extractPluginCommands — memoization', () => {
  it('returns the same array reference on a second call to the same pluginPath', () => {
    writeCommand('deploy.md', '---\ndescription: Ship it\n---\nDeploy.\n');
    const first = extractPluginCommands(pluginDir);
    const second = extractPluginCommands(pluginDir);
    expect(second).toBe(first);
  });

  it('keeps cache entries separate for different known-tool contexts', () => {
    writeCommand('deploy.md', '---\ndescription: Ship it\ntools: Read, Bash\n---\nDeploy.\n');
    const readOnly = extractPluginCommands(pluginDir, new Set(['read_file']));
    const bashOnly = extractPluginCommands(pluginDir, new Set(['bash']));
    expect(readOnly[0]?.allowedTools).toEqual(['read_file']);
    expect(bashOnly[0]?.allowedTools).toEqual(['bash']);
    expect(bashOnly).not.toBe(readOnly);
  });

  it('returns a fresh walk after _resetPluginScanCache clears the cache', () => {
    writeCommand('deploy.md', '---\ndescription: Ship it\n---\nDeploy.\n');
    const first = extractPluginCommands(pluginDir);
    _resetPluginScanCache();
    const second = extractPluginCommands(pluginDir);
    expect(second).not.toBe(first);
    expect(second).toEqual(first);
  });

  it('picks up a newly-added command after cache invalidation', () => {
    writeCommand('deploy.md', '---\ndescription: Ship it\n---\nDeploy.\n');
    const before = extractPluginCommands(pluginDir);
    expect(before).toHaveLength(1);

    writeCommand('rollback.md', 'Rollback the deployment.\n');
    // Without reset, stale cache is served:
    expect(extractPluginCommands(pluginDir)).toHaveLength(1);

    _resetPluginScanCache();
    expect(extractPluginCommands(pluginDir)).toHaveLength(2);
  });
});
