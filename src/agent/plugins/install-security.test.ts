/**
 * Direct unit tests for the C1 plugin-install security helpers.
 *
 * `assertSafePluginName` and `assertWithinPluginsDir` are exported from
 * install.ts. These tests pin their exact acceptance/rejection boundaries so
 * that a regression — e.g. a loosened regex or a changed relativisation
 * expression — will be caught immediately.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { assertSafePluginName, assertWithinPluginsDir } from './install.js';

// ── assertSafePluginName ─────────────────────────────────────────────────────

describe('assertSafePluginName — valid names', () => {
  it('accepts a hyphenated name', () => {
    expect(() => assertSafePluginName('my-plugin')).not.toThrow();
  });

  it('accepts a name with underscores', () => {
    expect(() => assertSafePluginName('plugin_name')).not.toThrow();
  });

  it('accepts a mixed-case alphanumeric name', () => {
    expect(() => assertSafePluginName('Plugin123')).not.toThrow();
  });

  it('accepts a single-character name', () => {
    expect(() => assertSafePluginName('a')).not.toThrow();
  });

  it('accepts a name at the exact 100-char limit', () => {
    expect(() => assertSafePluginName('a'.repeat(100))).not.toThrow();
  });
});

describe('assertSafePluginName — invalid names (must throw)', () => {
  it('rejects an empty string', () => {
    expect(() => assertSafePluginName('')).toThrow(/Invalid plugin name/);
  });

  it('rejects a name containing ".." in the middle (foo..bar)', () => {
    expect(() => assertSafePluginName('foo..bar')).toThrow(/Invalid plugin name/);
  });

  it('rejects a name that is just ".."', () => {
    expect(() => assertSafePluginName('..')).toThrow(/Invalid plugin name/);
  });

  it('rejects a name containing a forward slash (foo/bar)', () => {
    expect(() => assertSafePluginName('foo/bar')).toThrow(/Invalid plugin name/);
  });

  it('rejects a name containing a backslash (foo\\\\bar)', () => {
    expect(() => assertSafePluginName('foo\\bar')).toThrow(/Invalid plugin name/);
  });

  it('rejects a name with a leading dash (-foo)', () => {
    expect(() => assertSafePluginName('-foo')).toThrow(/Invalid plugin name/);
  });

  it('rejects a name with a leading dot (.foo)', () => {
    expect(() => assertSafePluginName('.foo')).toThrow(/Invalid plugin name/);
  });

  it('rejects a name exceeding 100 chars (101 "a"s)', () => {
    expect(() => assertSafePluginName('a'.repeat(101))).toThrow(/Invalid plugin name/);
  });
});

// ── assertWithinPluginsDir ───────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'afk-sec-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('assertWithinPluginsDir — paths that must pass', () => {
  it('passes for a direct child of the plugins dir', () => {
    const pluginsDir = join(tmpDir, 'plugins');
    const dest = join(pluginsDir, 'foo');
    expect(() => assertWithinPluginsDir(dest, pluginsDir)).not.toThrow();
  });

  it('passes for a nested path inside the plugins dir', () => {
    const pluginsDir = join(tmpDir, 'plugins');
    const dest = join(pluginsDir, 'foo', 'bar');
    expect(() => assertWithinPluginsDir(dest, pluginsDir)).not.toThrow();
  });

  it('passes for a path that does not exist yet but lives inside the dir', () => {
    const pluginsDir = join(tmpDir, 'plugins');
    const dest = join(pluginsDir, 'not-created-yet');
    // Neither pluginsDir nor dest exist on disk — resolve() handles this fine.
    expect(() => assertWithinPluginsDir(dest, pluginsDir)).not.toThrow();
  });
});

describe('assertWithinPluginsDir — paths that must throw', () => {
  it('blocks a path with ".." that escapes the plugins dir', () => {
    const pluginsDir = join(tmpDir, 'plugins');
    // Construct a dest that resolve()-s to outside pluginsDir.
    const dest = join(pluginsDir, '..', '..', 'etc', 'passwd');
    expect(() => assertWithinPluginsDir(dest, pluginsDir)).toThrow(/Path traversal/);
  });

  it('blocks an absolute path completely outside the plugins dir', () => {
    const pluginsDir = join(tmpDir, 'plugins');
    expect(() => assertWithinPluginsDir('/etc/passwd', pluginsDir)).toThrow(/Path traversal/);
  });

  it('blocks the parentDir itself (relative === "")', () => {
    const pluginsDir = join(tmpDir, 'plugins');
    // dest === pluginsDir → rel becomes '' after resolve()+relative().
    expect(() => assertWithinPluginsDir(pluginsDir, pluginsDir)).toThrow(/Path traversal/);
  });
});

describe('assertWithinPluginsDir — symlink handling (parent-aware)', () => {
  /**
   * Per issue #339, the helper now realpaths `parentDir` and the dirname
   * of `dest` so both sides of `relative()` resolve through the same
   * physical inode when `parentDir` is itself a symlink. The dest itself
   * is intentionally NOT dereferenced — `installLocal` creates dest as a
   * symlink to an out-of-tree source by design, and re-install must not
   * be misclassified as a traversal escape.
   */
  it('passes when pluginsDir is a symlink and dest is its direct child', () => {
    // pluginsDir resolves through a symlink to the real dir. Without
    // parent-side realpath, lexical resolve() of dest (via the link) and
    // lexical resolve() of parentDir (also via the link) would still
    // match — but this test pins the realpath path is exercised and
    // doesn't break the legitimate case.
    const realPlugins = join(tmpDir, 'real-plugins');
    mkdirSync(realPlugins);
    const pluginsDir = join(tmpDir, 'plugins-via-link');
    symlinkSync(realPlugins, pluginsDir);

    const dest = join(pluginsDir, 'plugin-name');
    expect(() => assertWithinPluginsDir(dest, pluginsDir)).not.toThrow();
  });

  it('passes for a not-yet-created dest under a symlinked pluginsDir', () => {
    // dest doesn't exist; dirname(dest) === pluginsDir (the symlink) is
    // realpathed and rejoined with the basename.
    const realPlugins = join(tmpDir, 'real-plugins');
    mkdirSync(realPlugins);
    const pluginsDir = join(tmpDir, 'plugins-via-link');
    symlinkSync(realPlugins, pluginsDir);

    const dest = join(pluginsDir, 'not-created-yet');
    expect(() => assertWithinPluginsDir(dest, pluginsDir)).not.toThrow();
  });

  it('passes when dest is a pre-existing symlink to an out-of-tree source (installLocal pattern)', () => {
    // installLocal creates `dest` as a symlink pointing at the source dir,
    // which lives OUTSIDE pluginsDir. The validator runs again on
    // re-install — it must not block that. We do not realpath `dest`
    // itself; only its dirname.
    const pluginsDir = join(tmpDir, 'plugins');
    const outsideDir = join(tmpDir, 'outside-source');
    mkdirSync(pluginsDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });

    const dest = join(pluginsDir, 'local-plugin');
    symlinkSync(outsideDir, dest);

    expect(() => assertWithinPluginsDir(dest, pluginsDir)).not.toThrow();
  });

  it('still blocks a lexical ".." escape even when dirname(dest) is a symlink resolving inside pluginsDir', () => {
    const pluginsDir = join(tmpDir, 'plugins');
    mkdirSync(pluginsDir, { recursive: true });
    // dest = pluginsDir/../../etc/passwd — lexical resolve() collapses to
    // outside, and realpath of the dirname (which is /tmp or similar)
    // does not change the relativisation outcome.
    const dest = join(pluginsDir, '..', '..', 'etc', 'passwd');
    expect(() => assertWithinPluginsDir(dest, pluginsDir)).toThrow(/Path traversal/);
  });
});
