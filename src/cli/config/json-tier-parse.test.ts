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

function writeConfig(dir: string, obj: unknown): string {
  const p = join(dir, 'afk.config.json');
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

describe('parseJsonConfigFile — permissionMode', () => {
  let tmpDir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'afk-json-tier-test-'));
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('permissionMode "default" leaves config.permissionMode undefined and emits one warning', () => {
    const p = writeConfig(tmpDir, { permissionMode: 'default' });
    const result = parseJsonConfigFile(p);
    expect(result).toBeDefined();
    expect(result!.config.permissionMode).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toContain('default');
  });

  it('permissionMode "bypassPermissions" is accepted and emits no warning', () => {
    const p = writeConfig(tmpDir, { permissionMode: 'bypassPermissions' });
    const result = parseJsonConfigFile(p);
    expect(result).toBeDefined();
    expect(result!.config.permissionMode).toBe('bypassPermissions');
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
