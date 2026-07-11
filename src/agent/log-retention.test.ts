/**
 * Tests for capJsonlBySize — best-effort size-cap for append-only JSONL logs.
 *
 * Disk tests use a fresh temp dir so they never touch real state files.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  capJsonlBySize,
  SESSION_GRANTS_MAX_BYTES,
  SESSION_GRANTS_KEEP_TAIL_LINES,
} from './log-retention.js';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'afk-log-retention-'));
  file = join(dir, 'grants.jsonl');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Build `n` newline-terminated JSONL records `{"i":<idx>}`. */
function makeLines(n: number): string {
  const rows: string[] = [];
  for (let i = 0; i < n; i++) rows.push(JSON.stringify({ i }));
  return rows.join('\n') + '\n';
}

function nonEmptyLines(raw: string): string[] {
  return raw.split('\n').filter((l) => l.length > 0);
}

describe('capJsonlBySize', () => {
  it('is a no-op when the file is under maxBytes', async () => {
    const content = makeLines(10);
    await writeFile(file, content);
    const res = await capJsonlBySize(file, { maxBytes: 1_000_000, keepTailLines: 5 });
    expect(res).toEqual({ trimmed: false, removedLines: 0 });
    expect(await readFile(file, 'utf8')).toBe(content);
  });

  it('is a no-op (never throws) when the file does not exist', async () => {
    const res = await capJsonlBySize(join(dir, 'missing.jsonl'), {
      maxBytes: 10,
      keepTailLines: 5,
    });
    expect(res).toEqual({ trimmed: false, removedLines: 0 });
  });

  it('trims to exactly keepTailLines newest lines when over maxBytes', async () => {
    await writeFile(file, makeLines(1000));
    const res = await capJsonlBySize(file, { maxBytes: 100, keepTailLines: 100 });
    expect(res.trimmed).toBe(true);
    expect(res.removedLines).toBe(900);

    const out = await readFile(file, 'utf8');
    const lines = nonEmptyLines(out);
    expect(lines.length).toBe(100);
    // Newest kept: first retained record is i=900, last is i=999.
    expect(JSON.parse(lines[0]!).i).toBe(900);
    expect(JSON.parse(lines[lines.length - 1]!).i).toBe(999);
    // Exactly one trailing newline (no doubled or missing terminator).
    expect(out.endsWith('\n')).toBe(true);
    expect(out.endsWith('\n\n')).toBe(false);
  });

  it('drops the OLDEST lines, preserving the recent audit tail', async () => {
    await writeFile(file, makeLines(50));
    await capJsonlBySize(file, { maxBytes: 1, keepTailLines: 10 });
    const ids = nonEmptyLines(await readFile(file, 'utf8')).map((l) => JSON.parse(l).i);
    expect(ids).toEqual([40, 41, 42, 43, 44, 45, 46, 47, 48, 49]);
  });

  it('tolerates malformed / non-JSON lines (slices by line, never parses)', async () => {
    const content = 'not json\n{"a":1}\ngarbage}{\n{"ok":true}\n';
    await writeFile(file, content);
    const res = await capJsonlBySize(file, { maxBytes: 1, keepTailLines: 2 });
    expect(res.trimmed).toBe(true);
    expect(nonEmptyLines(await readFile(file, 'utf8'))).toEqual(['garbage}{', '{"ok":true}']);
  });

  it('leaves the file untouched when over bytes but at/under the line budget', async () => {
    const huge = 'x'.repeat(200);
    const content = `{"a":"${huge}"}\n{"b":"${huge}"}\n`;
    await writeFile(file, content);
    const res = await capJsonlBySize(file, { maxBytes: 10, keepTailLines: 5 });
    expect(res).toEqual({ trimmed: false, removedLines: 0 });
    expect(await readFile(file, 'utf8')).toBe(content);
  });

  it('handles a file with no trailing newline', async () => {
    await writeFile(file, 'a\nb\nc\nd\ne'); // 5 lines, no trailing newline
    const res = await capJsonlBySize(file, { maxBytes: 1, keepTailLines: 2 });
    expect(res.trimmed).toBe(true);
    expect(res.removedLines).toBe(3);
    expect(await readFile(file, 'utf8')).toBe('d\ne\n');
  });

  it('does not leave a temp file behind after a successful trim', async () => {
    await writeFile(file, makeLines(100));
    await capJsonlBySize(file, { maxBytes: 1, keepTailLines: 10 });
    expect(await readdir(dir)).toEqual(['grants.jsonl']);
  });

  it('exposes the session-grants default constants', () => {
    expect(SESSION_GRANTS_MAX_BYTES).toBe(5 * 1024 * 1024);
    expect(SESSION_GRANTS_KEEP_TAIL_LINES).toBe(5_000);
  });
});
