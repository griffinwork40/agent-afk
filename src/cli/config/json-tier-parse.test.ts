/**
 * Tests for permissionMode handling in parseJsonConfigFile (json-tier-parse.ts).
 *
 * Covers: deprecated 'default' emits one console.warn and leaves permissionMode
 * undefined; valid 'bypassPermissions' is accepted silently.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseJsonConfigFile } from './json-tier-parse.js';
import {
  _resetPermissionModeWarnCache,
  deferPermissionModeWarnings,
  flushDeferredPermissionModeWarnings,
} from './permission-mode-warning.js';

function writeConfig(dir: string, obj: unknown): string {
  const p = join(dir, 'afk.config.json');
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

describe('parseJsonConfigFile — permissionMode', () => {
  let tmpDir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetPermissionModeWarnCache();
    tmpDir = mkdtempSync(join(tmpdir(), 'afk-json-tier-test-'));
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    _resetPermissionModeWarnCache();
    warnSpy.mockRestore();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('permissionMode "default" leaves config.permissionMode undefined and emits one warning', () => {
    const p = writeConfig(tmpDir, { permissionMode: 'default' });
    const result = parseJsonConfigFile(p);
    expect(result).toBeDefined();
    expect(result!.config.permissionMode).toBeUndefined();
    expect(parseJsonConfigFile(p)!.config.permissionMode).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toContain('default');
  });

  it('defers the removal warning until flushed and never prints it twice', () => {
    const p = writeConfig(tmpDir, { permissionMode: 'default' });
    deferPermissionModeWarnings();
    deferPermissionModeWarnings();
    expect(parseJsonConfigFile(p)!.config.permissionMode).toBeUndefined();
    parseJsonConfigFile(p);
    expect(warnSpy).not.toHaveBeenCalled();

    flushDeferredPermissionModeWarnings();
    expect(warnSpy).toHaveBeenCalledExactlyOnceWith(
      '[afk] permissionMode "default" was removed. The session will run in bypassPermissions. Set "permissionMode": "plan" for a read-only session.',
    );
    flushDeferredPermissionModeWarnings();
    parseJsonConfigFile(p);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('permissionMode "autonomous" is dropped with a warning that names autonomous, not default', () => {
    const p = writeConfig(tmpDir, { permissionMode: 'autonomous' });
    expect(parseJsonConfigFile(p)!.config.permissionMode).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledExactlyOnceWith(
      '[afk] permissionMode "autonomous" was removed. The session will run in bypassPermissions. Set "permissionMode": "plan" for a read-only session.',
    );
  });

  it('permissionMode "bypassPermissions" is accepted and emits no warning', () => {
    const p = writeConfig(tmpDir, { permissionMode: 'bypassPermissions' });
    const result = parseJsonConfigFile(p);
    expect(result).toBeDefined();
    expect(result!.config.permissionMode).toBe('bypassPermissions');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('unknown permissionMode is dropped with a warning naming the value and valid modes', () => {
    const p = writeConfig(tmpDir, { permissionMode: 'acceptEdits' });
    const result = parseJsonConfigFile(p);
    expect(result).toBeDefined();
    expect(result!.config.permissionMode).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]![0]).toContain('"acceptEdits"');
    expect(warnSpy.mock.calls[0]![0]).toContain('Valid modes:');
  });

  it('unknown permissionMode warning fires only once per value', () => {
    const p = writeConfig(tmpDir, { permissionMode: 'typo' });
    parseJsonConfigFile(p);
    parseJsonConfigFile(p);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]![0]).toContain('"typo"');
  });
});
