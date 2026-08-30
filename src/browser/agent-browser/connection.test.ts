/**
 * Unit tests for src/browser/agent-browser/connection.ts
 *
 * Tests the connection file parsing and PID liveness check in isolation.
 * Health probing and full availability checks are tested via routing.test.ts
 * with mocked dependencies.
 */

import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readConnectionFile, isPidAlive } from './connection.js';

// ---------------------------------------------------------------------------
// Temp dir for test connection files
// ---------------------------------------------------------------------------

const testDir = join(tmpdir(), `agent-browser-connection-test-${process.pid}`);

function setup(): void {
  mkdirSync(testDir, { recursive: true });
}

function teardown(): void {
  try { rmSync(testDir, { recursive: true }); } catch { /* best-effort */ }
}

function writeTempFile(content: string): string {
  const path = join(testDir, 'connection.json');
  writeFileSync(path, content, 'utf8');
  return path;
}

// ---------------------------------------------------------------------------
// readConnectionFile
// ---------------------------------------------------------------------------

describe('readConnectionFile', () => {
  it('returns null when file does not exist', () => {
    const result = readConnectionFile('/nonexistent/path/connection.json');
    expect(result).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    setup();
    try {
      const path = writeTempFile('not json');
      expect(readConnectionFile(path)).toBeNull();
    } finally {
      teardown();
    }
  });

  it('returns null for array JSON', () => {
    setup();
    try {
      const path = writeTempFile('[]');
      expect(readConnectionFile(path)).toBeNull();
    } finally {
      teardown();
    }
  });

  it('returns null when required fields are missing', () => {
    setup();
    try {
      const path = writeTempFile(JSON.stringify({ url: 'http://localhost' }));
      expect(readConnectionFile(path)).toBeNull();
    } finally {
      teardown();
    }
  });

  it('parses a valid connection file', () => {
    setup();
    try {
      const data = {
        url: 'http://127.0.0.1:8833',
        token: 'test-token-abc',
        pid: 99999,
        version: '0.3.0',
      };
      const path = writeTempFile(JSON.stringify(data));
      const result = readConnectionFile(path);
      expect(result).not.toBeNull();
      expect(result!.url).toBe('http://127.0.0.1:8833');
      expect(result!.token).toBe('test-token-abc');
      expect(result!.pid).toBe(99999);
      expect(result!.version).toBe('0.3.0');
    } finally {
      teardown();
    }
  });

  it('defaults version to "unknown" when absent', () => {
    setup();
    try {
      const data = {
        url: 'http://127.0.0.1:8833',
        token: 'test-token',
        pid: 99999,
      };
      const path = writeTempFile(JSON.stringify(data));
      const result = readConnectionFile(path);
      expect(result!.version).toBe('unknown');
    } finally {
      teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// isPidAlive
// ---------------------------------------------------------------------------

describe('isPidAlive', () => {
  it('returns true for the current process PID', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('returns false for a definitely-dead PID', () => {
    // PID 2147483647 is the max PID on most systems and is very unlikely alive.
    expect(isPidAlive(2147483647)).toBe(false);
  });
});
