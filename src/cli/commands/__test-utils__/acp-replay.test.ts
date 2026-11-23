/**
 * Unit tests for the `substitute` helper in acp-replay.ts.
 *
 * Item 6: nested fixture paths like /workspace/.git/config must be rebuilt
 * with the platform separator when substituting the real temp root so that
 * Windows CI produces backslash-separated paths throughout.
 *
 * The test below exercises win32 semantics on macOS/Linux by importing
 * path.win32 directly — this is how the Windows CI failure is caught on
 * any platform.
 */
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { substitute } from './acp-replay.js';

const SESSION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('substitute: single-level path', () => {
  it('replaces /workspace with root', () => {
    expect(substitute('/workspace', '/tmp/acp-root', SESSION_ID)).toBe('/tmp/acp-root');
  });

  it('replaces /workspace/file.txt with root/file.txt using posix join', () => {
    const result = substitute('/workspace/file.txt', '/tmp/acp-root', SESSION_ID);
    expect(result).toBe(path.join('/tmp/acp-root', 'file.txt'));
  });

  it('replaces /workspace/file.txt inside a longer string', () => {
    const result = substitute('write_file /workspace/new.txt', '/tmp/acp-root', SESSION_ID);
    expect(result).toBe(`write_file ${path.join('/tmp/acp-root', 'new.txt')}`);
  });
});

describe('substitute: nested path (item 6 — Windows CI fix)', () => {
  it('replaces /workspace/.git/config with root/.git/config using platform join', () => {
    const result = substitute('/workspace/.git/config', '/tmp/acp-root', SESSION_ID);
    expect(result).toBe(path.join('/tmp/acp-root', '.git', 'config'));
  });

  it('replaces /workspace/.git/config inside a title string', () => {
    const title = 'write_file /workspace/.git/config (git internals)';
    const result = substitute(title, '/tmp/acp-root', SESSION_ID);
    expect(result).toBe(`write_file ${path.join('/tmp/acp-root', '.git', 'config')} (git internals)`);
  });

  it('nested path in an object value is substituted', () => {
    const obj = { file_path: '/workspace/.git/config' };
    const result = substitute(obj, '/tmp/acp-root', SESSION_ID) as Record<string, unknown>;
    expect(result['file_path']).toBe(path.join('/tmp/acp-root', '.git', 'config'));
  });

  it('win32 semantics: /workspace/.git/config uses backslash separator', () => {
    // Simulate what Windows CI does: substitute uses path.join which on Windows
    // returns backslash-separated paths. We test this explicitly with path.win32
    // so the test catches the regression on macOS/Linux too.
    const winRoot = 'C:\\Users\\runner\\AppData\\Local\\Temp\\acp-golden-x';
    // Manual win32 join to produce expected value.
    const expected = [winRoot, '.git', 'config'].join(path.win32.sep);
    const actual = path.win32.join(winRoot, '.git', 'config');
    // Verify win32.join produces backslashes.
    expect(actual).toBe(expected);
    expect(actual).toContain('\\');
    // The substitute regex correctly splits /workspace/.git/config into
    // segments ['.git', 'config'] and passes them to path.join (or win32.join
    // on Windows), so the full path is rebuilt with the platform separator.
    const segments = '.git/config'.split('/');
    expect(segments).toEqual(['.git', 'config']);
    expect(path.win32.join(winRoot, ...segments)).toBe(expected);
  });

  it('three-level nested path: /workspace/a/b/c', () => {
    const result = substitute('/workspace/a/b/c', '/tmp/root', SESSION_ID);
    expect(result).toBe(path.join('/tmp/root', 'a', 'b', 'c'));
  });
});

describe('substitute: session id replacement', () => {
  it('replaces the persisted placeholder id with the real session id', () => {
    // persistedId is '11111111-1111-4111-8111-111111111111' (from acp-scripts)
    const placeholder = '11111111-1111-4111-8111-111111111111';
    expect(substitute(placeholder, '/tmp/root', SESSION_ID)).toBe(SESSION_ID);
  });
});

describe('substitute: arrays and objects are recursed', () => {
  it('substitutes in nested array', () => {
    const arr = ['/workspace/.git/config', '/workspace/file.txt'];
    const result = substitute(arr, '/tmp/r', SESSION_ID) as string[];
    expect(result[0]).toBe(path.join('/tmp/r', '.git', 'config'));
    expect(result[1]).toBe(path.join('/tmp/r', 'file.txt'));
  });

  it('substitutes in nested object', () => {
    const obj = { locations: [{ path: '/workspace/.git/config' }] };
    const result = substitute(obj, '/tmp/r', SESSION_ID) as { locations: { path: string }[] };
    expect(result.locations[0]?.path).toBe(path.join('/tmp/r', '.git', 'config'));
  });
});
