/**
 * Tests for `afk browser` config helpers (chrome-devtools-mcp wiring).
 *
 * The interactive command output + Chrome-version detection are not unit-tested
 * (they're stdout/UX and env-dependent); the testable core is the config
 * read/merge/write contract, which must be atomic, idempotent, and must never
 * clobber a hand-edited mcp.json.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildChromeDevtoolsEntry,
  readMcpConfigFile,
  writeMcpConfigFileAtomic,
  CHROME_DEVTOOLS_SERVER_NAME,
} from './browser.js';

describe('buildChromeDevtoolsEntry', () => {
  it('defaults to npx + --autoConnect on the stable channel', () => {
    expect(buildChromeDevtoolsEntry()).toEqual({
      command: 'npx',
      args: ['chrome-devtools-mcp@latest', '--autoConnect'],
    });
  });

  it('appends --channel for a non-stable channel', () => {
    expect(buildChromeDevtoolsEntry('canary')).toEqual({
      command: 'npx',
      args: ['chrome-devtools-mcp@latest', '--autoConnect', '--channel', 'canary'],
    });
  });
});

describe('readMcpConfigFile / writeMcpConfigFileAtomic', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'afk-mcp-'));
    path = join(dir, 'mcp.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns an empty server map when the file is absent', () => {
    expect(readMcpConfigFile(path)).toEqual({ mcpServers: {} });
  });

  it('round-trips a written config', () => {
    const cfg = { mcpServers: { [CHROME_DEVTOOLS_SERVER_NAME]: buildChromeDevtoolsEntry() } };
    writeMcpConfigFileAtomic(path, cfg);
    expect(existsSync(path)).toBe(true);
    // Trailing newline for POSIX-friendliness, valid JSON otherwise.
    expect(readFileSync(path, 'utf-8').endsWith('\n')).toBe(true);
    expect(readMcpConfigFile(path)).toEqual(cfg);
  });

  it('preserves existing servers when adding chrome-devtools', () => {
    writeFileSync(path, JSON.stringify({ mcpServers: { other: { command: 'cat' } } }), 'utf-8');
    const cfg = readMcpConfigFile(path);
    cfg.mcpServers![CHROME_DEVTOOLS_SERVER_NAME] = buildChromeDevtoolsEntry();
    writeMcpConfigFileAtomic(path, cfg);

    const reread = readMcpConfigFile(path);
    expect(reread.mcpServers!['other']).toEqual({ command: 'cat' });
    expect(reread.mcpServers![CHROME_DEVTOOLS_SERVER_NAME]).toEqual(buildChromeDevtoolsEntry());
  });

  it('is idempotent: re-adding the same entry produces an identical file', () => {
    const cfg1 = readMcpConfigFile(path);
    cfg1.mcpServers![CHROME_DEVTOOLS_SERVER_NAME] = buildChromeDevtoolsEntry();
    writeMcpConfigFileAtomic(path, cfg1);
    const first = readFileSync(path, 'utf-8');

    const cfg2 = readMcpConfigFile(path);
    cfg2.mcpServers![CHROME_DEVTOOLS_SERVER_NAME] = buildChromeDevtoolsEntry();
    writeMcpConfigFileAtomic(path, cfg2);
    expect(readFileSync(path, 'utf-8')).toBe(first);
  });

  it('normalizes a file missing mcpServers to an empty map', () => {
    writeFileSync(path, JSON.stringify({ someOtherKey: true }), 'utf-8');
    expect(readMcpConfigFile(path).mcpServers).toEqual({});
  });

  it('throws a clear error on malformed JSON (never clobbers)', () => {
    writeFileSync(path, '{ not valid', 'utf-8');
    expect(() => readMcpConfigFile(path)).toThrow(/not valid JSON/);
  });

  it('throws when the top-level value is not an object', () => {
    writeFileSync(path, '[]', 'utf-8');
    expect(() => readMcpConfigFile(path)).toThrow(/must be a JSON object/);
  });
});
