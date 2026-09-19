/**
 * Unit tests for the demand-load sidecar module.
 *
 * These cover `demandLoadSidecar` in isolation — creating real temp files so
 * the fs.readFileSync path is exercised without a full SessionManager stack.
 * Each test uses a fresh tmpdir so there are no cross-test file interactions.
 *
 * @module telegram/session-manager.demand-load.test
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { demandLoadSidecar } from './session-manager.demand-load.js';
import type { SessionData } from './session-manager.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid SessionData matching what the sidecar format persists. */
function makeData(overrides: Partial<SessionData> = {}): SessionData {
  return {
    chatId: 42,
    model: 'claude-sonnet-4-5',
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'afk-demand-load-test-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// demandLoadSidecar
// ---------------------------------------------------------------------------

describe('demandLoadSidecar', () => {
  test('returns undefined when no sidecar file exists (ENOENT)', () => {
    const sessionData = new Map<string, SessionData>();
    const result = demandLoadSidecar(dataDir, sessionData, { chatId: 1 });

    expect(result).toBeUndefined();
    expect(sessionData.size).toBe(0);
  });

  test('returns and populates sessionData when a valid sidecar file exists', () => {
    const data = makeData({ chatId: 99, model: 'opus', cwd: '/tmp/myproject' });
    // General route → filename is "<chatId>.json"
    writeFileSync(join(dataDir, '99.json'), JSON.stringify(data));

    const sessionData = new Map<string, SessionData>();
    const result = demandLoadSidecar(dataDir, sessionData, { chatId: 99 });

    expect(result).toBeDefined();
    expect(result?.model).toBe('opus');
    expect(result?.cwd).toBe('/tmp/myproject');
    // The map is now populated so subsequent reads find the data.
    expect(sessionData.get('99')).toBe(result);
  });

  test('topic route uses "<chatId>:<threadId>.json" filename', () => {
    const data = makeData({ chatId: 10, threadId: 7 });
    writeFileSync(join(dataDir, '10:7.json'), JSON.stringify(data));

    const sessionData = new Map<string, SessionData>();
    const result = demandLoadSidecar(dataDir, sessionData, { chatId: 10, threadId: 7 });

    expect(result).toBeDefined();
    expect(result?.chatId).toBe(10);
    expect(result?.threadId).toBe(7);
    expect(sessionData.has('10:7')).toBe(true);
  });

  test('returns the existing in-memory entry without touching disk when key is already populated', () => {
    // Populate a different value on disk to prove the function never reads it.
    writeFileSync(join(dataDir, '5.json'), JSON.stringify(makeData({ chatId: 5, model: 'opus' })));

    const existingData = makeData({ chatId: 5, model: 'sonnet' });
    const sessionData = new Map([['5', existingData]]);

    const result = demandLoadSidecar(dataDir, sessionData, { chatId: 5 });

    // Must return the in-memory entry, not the disk value.
    expect(result).toBe(existingData);
    expect(result?.model).toBe('sonnet');
  });

  test('returns undefined and does not throw when sidecar content is invalid JSON', () => {
    writeFileSync(join(dataDir, '77.json'), 'NOT_JSON{{{');

    const sessionData = new Map<string, SessionData>();
    let result: SessionData | undefined;
    expect(() => {
      result = demandLoadSidecar(dataDir, sessionData, { chatId: 77 });
    }).not.toThrow();

    expect(result).toBeUndefined();
    expect(sessionData.size).toBe(0);
  });

  test('does not overwrite an existing in-memory entry with disk data', () => {
    // Disk has a different model from what is live in memory.
    writeFileSync(join(dataDir, '3.json'), JSON.stringify(makeData({ chatId: 3, model: 'haiku' })));

    const liveData = makeData({ chatId: 3, model: 'gpt-4o' });
    const sessionData = new Map([['3', liveData]]);

    demandLoadSidecar(dataDir, sessionData, { chatId: 3 });

    // In-memory value must be unchanged.
    expect(sessionData.get('3')).toBe(liveData);
    expect(sessionData.get('3')?.model).toBe('gpt-4o');
  });

  test('populates sessionId from sidecar when present', () => {
    const data = makeData({ chatId: 20, sessionId: 'sess-abc-123' });
    writeFileSync(join(dataDir, '20.json'), JSON.stringify(data));

    const sessionData = new Map<string, SessionData>();
    const result = demandLoadSidecar(dataDir, sessionData, { chatId: 20 });

    expect(result?.sessionId).toBe('sess-abc-123');
  });

  test('handles a dataDir that does not exist (graceful ENOENT)', () => {
    const missingDir = join(tmpdir(), 'afk-demand-load-no-such-dir-xyz');
    const sessionData = new Map<string, SessionData>();

    let result: SessionData | undefined;
    expect(() => {
      result = demandLoadSidecar(missingDir, sessionData, { chatId: 1 });
    }).not.toThrow();

    expect(result).toBeUndefined();
  });
});
