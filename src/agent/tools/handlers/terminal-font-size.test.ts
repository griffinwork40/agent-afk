/**
 * Tests for the terminal_font_size tool handler.
 *
 * All tests use `createTerminalFontSizeHandler({ discoverFn, writeFn? })` with
 * a mock `discoverFn` pointing at a temp directory so no real editor settings
 * are touched. The factory's `writeFn` seam is used for EACCES simulation.
 *
 * Pattern: temp-dir isolation from schedules.test.ts — mkdtempSync / rmSync.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createTerminalFontSizeHandler,
  MIN_FONT_SIZE,
  MAX_FONT_SIZE,
  type EditorTarget,
} from './terminal-font-size.js';

// A no-op AbortSignal for handler invocations
const fakeSignal = new AbortController().signal;

describe('terminal_font_size handler — input validation', () => {
  const handler = createTerminalFontSizeHandler({
    discoverFn: () => [],
  });

  // Test 1: null input → isError
  it('null input returns isError: true', async () => {
    const result = await handler(null, fakeSignal);
    expect(result.isError).toBe(true);
  });

  // Test 2: size below MIN → isError with "between"
  it('size below MIN_FONT_SIZE returns isError containing "between"', async () => {
    const result = await handler({ action: 'set', size: 0 }, fakeSignal);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/between/i);
  });

  // Test 3: size above MAX → isError
  it('size above MAX_FONT_SIZE returns isError: true', async () => {
    const result = await handler({ action: 'set', size: 100 }, fakeSignal);
    expect(result.isError).toBe(true);
  });

  // Test 4: invalid action → isError with "Invalid action"
  it('invalid action returns isError containing "Invalid action"', async () => {
    const result = await handler({ action: 'reset' }, fakeSignal);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/invalid action/i);
  });
});

describe('terminal_font_size handler — no editors found', () => {
  // Test 5: discoverFn returns [] → no isError, mentions "No supported editors"
  it('empty discover result returns message about no editors found', async () => {
    const handler = createTerminalFontSizeHandler({
      discoverFn: () => [],
    });
    const result = await handler({ action: 'get' }, fakeSignal);
    expect(result.isError).toBeUndefined();
    expect(result.content).toMatch(/no supported editors/i);
  });
});

describe('terminal_font_size handler — set action with existing settings', () => {
  let tmpDir: string;
  let settingsPath: string;
  let targets: EditorTarget[];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'terminal-font-size-'));
    settingsPath = join(tmpDir, 'settings.json');
    targets = [{ name: 'Test Editor', path: settingsPath }];
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Test 6: existing valid JSON → merged correctly
  it('set merges into existing settings preserving other keys', async () => {
    writeFileSync(settingsPath, JSON.stringify({ key: 'val' }, null, 2) + '\n', 'utf-8');

    const handler = createTerminalFontSizeHandler({
      discoverFn: () => targets,
    });
    const result = await handler({ action: 'set', size: 14 }, fakeSignal);

    expect(result.isError).toBeUndefined();

    const written = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
    expect(written['key']).toBe('val');
    expect(written['terminal.integrated.fontSize']).toBe(14);
  });

  // Test 7: no settings.json → file created with only the font size key
  it('set creates settings.json when it does not exist', async () => {
    // settingsPath does not exist yet
    const handler = createTerminalFontSizeHandler({
      discoverFn: () => targets,
    });
    const result = await handler({ action: 'set', size: 14 }, fakeSignal);

    expect(result.isError).toBeUndefined();

    const written = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
    expect(written['terminal.integrated.fontSize']).toBe(14);
    // Only one key present
    expect(Object.keys(written)).toHaveLength(1);
  });

  // Test 8: JSONC / malformed file → isError, content mentions comments/malformed,
  // original file bytes unchanged
  it('set with JSONC file returns isError and leaves file unchanged', async () => {
    const original = '// comment\n{"key":"val"}';
    writeFileSync(settingsPath, original, 'utf-8');

    const handler = createTerminalFontSizeHandler({
      discoverFn: () => targets,
    });
    const result = await handler({ action: 'set', size: 14 }, fakeSignal);

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/comments or be malformed/i);

    // Original file must be byte-identical
    const afterContent = readFileSync(settingsPath, 'utf-8');
    expect(afterContent).toBe(original);
  });
});

describe('terminal_font_size handler — editor filter', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'terminal-font-size-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Test 9: editor filter matches only one of two targets
  it('editor filter "vscode" writes only the VS Code target', async () => {
    const vsCodeDir = join(tmpDir, 'vscode');
    const cursorDir = join(tmpDir, 'cursor');
    mkdirSync(vsCodeDir, { recursive: true });
    mkdirSync(cursorDir, { recursive: true });

    const vsCodeSettings = join(vsCodeDir, 'settings.json');
    const cursorSettings = join(cursorDir, 'settings.json');
    writeFileSync(vsCodeSettings, '{}', 'utf-8');
    writeFileSync(cursorSettings, '{}', 'utf-8');

    const targets: EditorTarget[] = [
      { name: 'VS Code', path: vsCodeSettings },
      { name: 'Cursor', path: cursorSettings },
    ];

    const handler = createTerminalFontSizeHandler({
      discoverFn: () => targets,
    });

    const result = await handler({ action: 'set', size: 16, editor: 'vscode' }, fakeSignal);
    expect(result.isError).toBeUndefined();

    // VS Code file updated
    const vsCodeWritten = JSON.parse(readFileSync(vsCodeSettings, 'utf-8')) as Record<string, unknown>;
    expect(vsCodeWritten['terminal.integrated.fontSize']).toBe(16);

    // Cursor file untouched (still '{}')
    const cursorWritten = JSON.parse(readFileSync(cursorSettings, 'utf-8')) as Record<string, unknown>;
    expect(cursorWritten['terminal.integrated.fontSize']).toBeUndefined();
  });

  // Test 10: unknown editor → isError naming supported editors
  it('unknown editor name returns isError naming supported editors', async () => {
    const handler = createTerminalFontSizeHandler({
      discoverFn: () => [],
    });
    const result = await handler({ action: 'get', editor: 'sublime' }, fakeSignal);
    expect(result.isError).toBe(true);
    // Should mention at least one known editor by name
    expect(result.content).toMatch(/cursor|vs code/i);
  });
});

describe('terminal_font_size handler — write errors', () => {
  let tmpDir: string;
  let settingsPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'terminal-font-size-'));
    settingsPath = join(tmpDir, 'settings.json');
    writeFileSync(settingsPath, '{}', 'utf-8');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Test 11: writeFn throws EACCES → isError, loop does not throw
  it('EACCES from writeFn returns isError without throwing', async () => {
    const eaccesError = Object.assign(new Error('EACCES: permission denied'), {
      code: 'EACCES',
    });

    const handler = createTerminalFontSizeHandler({
      discoverFn: () => [{ name: 'Test Editor', path: settingsPath }],
      writeFn: async () => {
        throw eaccesError;
      },
    });

    // Must not throw — must return isError
    let result: Awaited<ReturnType<typeof handler>>;
    await expect(async () => {
      result = await handler({ action: 'set', size: 14 }, fakeSignal);
    }).not.toThrow();

    result = await handler({ action: 'set', size: 14 }, fakeSignal);
    expect(result.isError).toBe(true);
  });
});

describe('terminal_font_size handler — get action with malformed file', () => {
  let tmpDir: string;
  let settingsPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'terminal-font-size-'));
    settingsPath = join(tmpDir, 'settings.json');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Test 12: get with JSONC file → per-target message, no global isError
  it('get with JSONC file returns per-target error message without global isError', async () => {
    writeFileSync(settingsPath, '// comment\n{"key":"val"}', 'utf-8');

    const handler = createTerminalFontSizeHandler({
      discoverFn: () => [{ name: 'Test Editor', path: settingsPath }],
    });

    const result = await handler({ action: 'get' }, fakeSignal);

    expect(result.isError).toBeUndefined();
    expect(result.content).toMatch(/could not read settings — file may contain comments or be malformed/i);
  });
});
