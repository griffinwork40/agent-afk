/**
 * Settles the red team's "Unproven" list (R2 report) against the REAL tool
 * handlers with containment off (`allowAll`, as in an ACP bypassPermissions
 * session): each input below is auto-allowed by the gate, so the handler must
 * not return content from outside the session cwd.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requiresAsk } from './acp.permission.policy.js';
import { createReadFileHandler } from '../../agent/tools/handlers/read-file.js';
import { createGrepHandler } from '../../agent/tools/handlers/grep.js';
import { createGlobHandler } from '../../agent/tools/handlers/glob.js';

let tmp = '';
let cwd = '';
let secret = '';
const SECRET = 'OUTSIDE_SECRET_42';

beforeAll(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'acp-unproven-')));
  cwd = path.join(tmp, 'app');
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, 'inside.txt'), 'inside\n');
  secret = path.join(tmp, 'secret.txt');
  fs.writeFileSync(secret, `${SECRET}\n`);
  fs.writeFileSync(path.join(tmp, 'x'), `${SECRET}\n`);
});
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const ctx = () => ({ resolveBase: cwd, allowAll: true }) as never;
const run = async (h: ReturnType<typeof createReadFileHandler>, input: Record<string, unknown>) =>
  String((await h(input, new AbortController().signal, ctx())).content);

describe('unproven 1: file:// values', () => {
  it('read_file does not decode a file URL; an auto-allowed file:// value reads nothing outside', async () => {
    for (const value of [`file://${secret}`, pathToFileURL(secret).href]) {
      const input = { file_path: value };
      expect(requiresAsk('read_file', input, cwd), value).toBe(false);
      {
        expect(await run(createReadFileHandler(cwd), input), value).not.toContain(SECRET);
      }
    }
  });
});

describe('unproven 2: grep include with .. or an absolute pattern', () => {
  it('include only filters files under the search root; it never widens it', async () => {
    for (const include of ['../**', '../*', '../secret.txt', `${tmp}/*`, `${secret}`, '**/../../*']) {
      // A character class keeps the echoed pattern from matching the secret text itself.
      const input = { pattern: 'OUTSIDE_SECRET_4[2]', include };
      expect(requiresAsk('grep', input, cwd), include).toBe(false);
      expect(await run(createGrepHandler(cwd), { pattern: 'insid[e]', include: '*.txt' })).toContain('inside');
      expect(await run(createGrepHandler(cwd), input), include).not.toContain(SECRET);
    }
  });
});

describe('unproven 3: glob brace expansion', () => {
  it('brace arms that expand to .. never list a file outside the base', async () => {
    // Non-vacuous: the same handler and context do list inside files.
    expect(await run(createGlobHandler(cwd), { pattern: '*' })).toContain('inside.txt');
    // `{..,.}/x` names .. literally and is asked; the others are auto-allowed and must stay harmless.
    expect(requiresAsk('glob', { pattern: '{..,.}/x' }, cwd)).toBe(true);
    for (const pattern of ['.{.,}/x', '.{.,}/secret.txt', '{.,.}./x', '.{.,}/*']) {
      const out = await run(createGlobHandler(cwd), { pattern });
      expect(requiresAsk('glob', { pattern }, cwd), pattern).toBe(false);
      {
        expect(out, pattern).not.toContain(secret);
        expect(out, pattern).not.toMatch(/(^|[\\/\s])x(\s|$)/);
      }
    }
  });
});

describe('unproven 4: re-anchoring the working directory', () => {
  it('no ACP source module re-anchors the session cwd (setCwd, setResolveBase, chdir)', () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const sources = fs.readdirSync(dir).filter((f) => f.startsWith('acp') && f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(sources.length).toBeGreaterThan(5);
    for (const f of sources) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      expect(text, f).not.toMatch(/\.setCwd\(|setResolveBase\(|process\.chdir\(/);
    }
  });
});
