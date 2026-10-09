/**
 * Unit tests for src/utils/json-file.ts
 *
 * Covers:
 *   - writeJsonFile / writeJsonFileAsync: round-trip, mode, indent
 *   - readJsonFile: success, ENOENT w/ onMissing, ENOENT throws, bad JSON throws
 *   - readJsonFileAsync: same semantics async
 *   - readJsonFileLoose: success, ENOENT returns onMissing, bad JSON returns onMissing
 *   - readJsonFileLooseAsync: same semantics async
 *
 * @module utils/json-file.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  writeJsonFile,
  writeJsonFileAsync,
  readJsonFile,
  readJsonFileAsync,
  readJsonFileLoose,
  readJsonFileLooseAsync,
} from './json-file.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'afk-json-file-test-'));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('json-file utilities', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // ── writeJsonFile (sync) ──────────────────────────────────────────────────

  describe('writeJsonFile', () => {
    it('writes valid JSON and reads it back', () => {
      const p = join(dir, 'out.json');
      writeJsonFile(p, { hello: 'world', n: 42 });
      const result = readJsonFile<{ hello: string; n: number }>(p);
      expect(result).toEqual({ hello: 'world', n: 42 });
    });

    it('uses 2-space indent by default', () => {
      const p = join(dir, 'indented.json');
      writeJsonFile(p, { a: 1 });
      const { readFileSync } = require('node:fs') as typeof import('node:fs');
      const raw = readFileSync(p, 'utf-8');
      expect(raw).toContain('\n  ');
    });

    it('respects a custom indent option', () => {
      const p = join(dir, 'compact.json');
      writeJsonFile(p, { a: 1 }, { indent: 0 });
      const { readFileSync } = require('node:fs') as typeof import('node:fs');
      const raw = readFileSync(p, 'utf-8').trim();
      expect(raw).toBe('{"a":1}');
    });

    it('applies custom mode to the written file', () => {
      const p = join(dir, 'mode.json');
      writeJsonFile(p, {}, { mode: 0o644 });
      const mode = statSync(p).mode & 0o777;
      // On some platforms the umask may restrict 0o644 to 0o600; accept either.
      expect([0o600, 0o644]).toContain(mode);
    });
  });

  // ── writeJsonFileAsync (async) ────────────────────────────────────────────

  describe('writeJsonFileAsync', () => {
    it('writes valid JSON and reads it back', async () => {
      const p = join(dir, 'async-out.json');
      await writeJsonFileAsync(p, { key: 'value' });
      const result = readJsonFile<{ key: string }>(p);
      expect(result).toEqual({ key: 'value' });
    });

    it('respects mode option', async () => {
      const p = join(dir, 'async-mode.json');
      await writeJsonFileAsync(p, { x: 1 }, { mode: 0o644 });
      const mode = statSync(p).mode & 0o777;
      expect([0o600, 0o644]).toContain(mode);
    });
  });

  // ── readJsonFile (sync, strict) ───────────────────────────────────────────

  describe('readJsonFile', () => {
    it('parses and returns valid JSON', () => {
      const p = join(dir, 'data.json');
      writeFileSync(p, JSON.stringify({ x: 99 }));
      expect(readJsonFile<{ x: number }>(p)).toEqual({ x: 99 });
    });

    it('returns onMissing when file does not exist and onMissing is provided', () => {
      const p = join(dir, 'nonexistent.json');
      const result = readJsonFile<string[]>(p, { onMissing: [] });
      expect(result).toEqual([]);
    });

    it('throws when file does not exist and onMissing is not provided', () => {
      const p = join(dir, 'nonexistent.json');
      expect(() => readJsonFile(p)).toThrow();
    });

    it('throws on a bad JSON parse error (not swallowed)', () => {
      const p = join(dir, 'bad.json');
      writeFileSync(p, 'NOT_VALID_JSON');
      expect(() => readJsonFile(p)).toThrow(SyntaxError);
    });

    it('throws on bad JSON even when onMissing is provided', () => {
      const p = join(dir, 'bad2.json');
      writeFileSync(p, '{bad}');
      // onMissing only applies to ENOENT, not parse errors
      expect(() => readJsonFile(p, { onMissing: null })).toThrow(SyntaxError);
    });
  });

  // ── readJsonFileAsync (async, strict) ────────────────────────────────────

  describe('readJsonFileAsync', () => {
    it('parses and returns valid JSON', async () => {
      const p = join(dir, 'async-data.json');
      writeFileSync(p, JSON.stringify({ y: 'hello' }));
      expect(await readJsonFileAsync<{ y: string }>(p)).toEqual({ y: 'hello' });
    });

    it('returns onMissing when file does not exist', async () => {
      const p = join(dir, 'async-nonexistent.json');
      const result = await readJsonFileAsync<number>(p, { onMissing: 0 });
      expect(result).toBe(0);
    });

    it('throws when file does not exist and onMissing is absent', async () => {
      const p = join(dir, 'async-nonexistent2.json');
      await expect(readJsonFileAsync(p)).rejects.toThrow();
    });

    it('throws on bad JSON (not swallowed)', async () => {
      const p = join(dir, 'async-bad.json');
      writeFileSync(p, 'NOTJSON');
      await expect(readJsonFileAsync(p)).rejects.toThrow(SyntaxError);
    });
  });

  // ── readJsonFileLoose (sync, tolerant) ───────────────────────────────────

  describe('readJsonFileLoose', () => {
    it('returns parsed value for valid JSON', () => {
      const p = join(dir, 'loose.json');
      writeFileSync(p, JSON.stringify({ loose: true }));
      expect(readJsonFileLoose<{ loose: boolean }>(p)).toEqual({ loose: true });
    });

    it('returns onMissing when file does not exist', () => {
      const p = join(dir, 'loose-missing.json');
      expect(readJsonFileLoose(p, { onMissing: 'default' })).toBe('default');
    });

    it('returns undefined when file does not exist and onMissing is absent', () => {
      const p = join(dir, 'loose-missing2.json');
      expect(readJsonFileLoose(p)).toBeUndefined();
    });

    it('returns onMissing for bad JSON (tolerant path)', () => {
      const p = join(dir, 'loose-bad.json');
      writeFileSync(p, 'this is not json');
      expect(readJsonFileLoose(p, { onMissing: null })).toBeNull();
    });

    it('returns undefined for bad JSON when onMissing is absent', () => {
      const p = join(dir, 'loose-bad2.json');
      writeFileSync(p, '{bad json}');
      expect(readJsonFileLoose(p)).toBeUndefined();
    });
  });

  // ── readJsonFileLooseAsync (async, tolerant) ──────────────────────────────

  describe('readJsonFileLooseAsync', () => {
    it('returns parsed value for valid JSON', async () => {
      const p = join(dir, 'async-loose.json');
      writeFileSync(p, JSON.stringify([1, 2, 3]));
      expect(await readJsonFileLooseAsync<number[]>(p)).toEqual([1, 2, 3]);
    });

    it('returns onMissing when file does not exist', async () => {
      const p = join(dir, 'async-loose-missing.json');
      expect(await readJsonFileLooseAsync(p, { onMissing: 42 })).toBe(42);
    });

    it('returns undefined when file does not exist and onMissing is absent', async () => {
      const p = join(dir, 'async-loose-missing2.json');
      expect(await readJsonFileLooseAsync(p)).toBeUndefined();
    });

    it('returns onMissing for bad JSON', async () => {
      const p = join(dir, 'async-loose-bad.json');
      writeFileSync(p, 'bad');
      expect(await readJsonFileLooseAsync(p, { onMissing: 'fallback' })).toBe('fallback');
    });
  });
});
