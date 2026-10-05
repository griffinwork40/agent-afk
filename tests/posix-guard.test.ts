/**
 * The POSIX-assumption guard, enforced inside `pnpm test` so ubuntu CI and
 * auto-release (`pnpm lint && pnpm test`) catch Windows regressions on every PR,
 * not only on the Windows leg. Rules: `scripts/lib/posix-guard-rules.ts`.
 *
 * Every fixture below is a STRING, so the violating shapes it spells are never
 * seen by the AST scan of this file itself.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { scanSource, type RuleId } from '../scripts/lib/posix-guard-rules.js';
import {
  BASELINE_REL,
  compareToBaseline,
  countsByFile,
  loadPosixBaseline,
  rulesFor,
  scanFile,
  scanTree,
  serializePosixBaseline,
} from '../scripts/lib/posix-guard.js';
import { formatGrowth, formatShrinkHint } from '../scripts/lib/posix-guard-report.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Rule ids that fire on a snippet under the given rules. */
function hits(src: string, rules: readonly RuleId[] = ['R1', 'R2', 'R3', 'R4'], file = 'x.ts'): RuleId[] {
  return scanSource(file, src, rules).map((f) => f.rule);
}

describe('posix-guard — the whole tree does not exceed the committed baseline', () => {
  it('has no (file, rule) count above .posix-guard-baseline.json', () => {
    const baseline = loadPosixBaseline(path.join(repoRoot, BASELINE_REL));
    expect(baseline.fileExisted).toBe(true);
    const cmp = compareToBaseline(scanTree(repoRoot), baseline);
    const hint = formatShrinkHint(cmp);
    if (hint) console.log(hint);
    // On failure the message names every offending site and the exact fix.
    expect(cmp.growth, cmp.growth.length > 0 ? `\n${formatGrowth(cmp)}` : '').toEqual([]);
  });
});

describe('R1 — hardcoded POSIX shell binary (product code)', () => {
  it.each([
    ["execFile('/bin/sh', ['-c', cmd]);"],
    ["await execFile('/bin/bash', ['-c', cmd]);"],
    ["cp.spawn('sh', ['-c', cmd]);"],
    ["spawnSync('bash', ['-lc', cmd]);"],
    ["execSync('/usr/bin/env bash -c x');"],
    ["spawn(cmd, { shell: '/bin/sh' });"],
  ])('flags %s', (src) => {
    expect(hits(src, ['R1'])).toEqual(['R1']);
  });

  it.each([
    ["execFile('git', ['status']);"],
    ["spawn(r.shell, [...r.args, cmd]);"],
    ["spawn(cmd, { shell: true });"],
    ["spawn('./scripts/sh', []);"],
    ["const s = '/bin/sh'; log(s);"],
    ["// execFile('/bin/sh', ['-c', cmd])"],
    ["const doc = \"execFile('/bin/sh')\";"],
  ])('ignores %s', (src) => {
    expect(hits(src, ['R1'])).toEqual([]);
  });
});

describe("R2 — mkdtemp on a '/'-rooted literal", () => {
  it.each([
    ["await fs.mkdtemp('/tmp/afk-x-');"],
    ["mkdtempSync('/tmp/afk-x-');"],
    ['mkdtempSync(`/tmp/afk-${id}-`);'],
    ["mkdtempSync(path.join('/tmp', 'afk-x-'));"],
  ])('flags %s', (src) => {
    expect(hits(src, ['R2'])).toEqual(['R2']);
  });

  it.each([
    ["mkdtempSync(path.join(os.tmpdir(), 'afk-x-'));"],
    ['mkdtempSync(prefix);'],
    ["mkdtempSync('afk-relative-');"],
  ])('ignores %s', (src) => {
    expect(hits(src, ['R2'])).toEqual([]);
  });
});

describe("R3 — host path.resolve/normalize on a '/'-rooted literal (the #2588 shape)", () => {
  it('flags the exact #2588 source shape from bash-scan-exempt.ts', () => {
    const src = [
      "import path from 'path';",
      "const DEVICE_SINKS = new Set(['/dev/null'].map((p) => path.resolve(p)));",
      "const normalized = path.resolve('/dev/null');",
    ].join('\n');
    expect(hits(src, ['R3'])).toEqual(['R3']);
  });

  it.each([
    ["import * as path from 'node:path'; path.normalize('/tmp/x');"],
    ["import { resolve } from 'path'; resolve('/etc/hosts');"],
    ["import { resolve as r } from 'node:path'; r('/etc');"],
    ["const nodePath = require('path'); nodePath.resolve('/var/tmp');"],
    ["import path from 'path'; path.resolve(root, '/abs');"],
    ["import path from 'path'; path.resolve(`/tmp/${x}`);"],
  ])('flags %s', (src) => {
    expect(hits(src, ['R3'])).toEqual(['R3']);
  });

  it.each([
    ["import path from 'path'; path.posix.resolve('/dev/null');"],
    ["import path from 'path'; path.win32.normalize('/x');"],
    ["import path from 'path'; path.resolve(absPath);"],
    ["import path from 'path'; path.resolve('relative/x');"],
    ["import path from 'path'; path.join('/tmp', x);"],
    ["promise.resolve('/x'); new URL('/x', base);"],
    ["import { resolve } from './my-resolver.js'; resolve('/x');"],
  ])('ignores %s', (src) => {
    expect(hits(src, ['R3'])).toEqual([]);
  });
});

describe('R4 — tests gated on platform', () => {
  it.each([
    ["it.skipIf(process.platform === 'win32')('t', () => {});"],
    ["const isWin32 = process.platform === 'win32';\ndescribe.skipIf(isWin32)('d', () => {});"],
    ["const onWindows = os.platform() === 'win32';\nit.skipIf(onWindows)('t', () => {});"],
    ["it.runIf(process.platform === 'win32')('t', () => {});"],
    ["describe.skipIf(process.platform !== 'darwin')('d', () => {});"],
    ["test.each([1])('t', () => {}); it.concurrent.skipIf(IS_WINDOWS)('t', () => {});"],
    ["const itPosix = process.platform === 'win32' ? it.skip : it;"],
    ["it('t', () => { if (process.platform === 'win32') return; expect(1).toBe(1); });"],
    ["it('t', () => { if (isWin32) { return; } });"],
  ])('counts %s', (src) => {
    expect(hits(src, ['R4'])).toEqual(['R4']);
  });

  it.each([
    ["it.skipIf(!IPV6_AVAILABLE)('t', () => {});"],
    ["describe.skipIf(!SHOULD_RUN)('live', () => {});"],
    ["const describeMaybe = haveAuth ? describe : describe.skip;"],
    ["const sep = process.platform === 'win32' ? '\\\\' : '/';"],
    ["if (process.platform === 'win32') { expect(x).toBe('C:\\\\a'); } else { expect(x).toBe('/a'); }"],
    ["if (process.platform === 'win32') return win32Value; // product helper"],
  ])('ignores %s', (src) => {
    expect(hits(src, ['R4'])).toEqual([]);
  });
});

describe('rule scoping by path', () => {
  it('applies R1/R2/R3 to product code and R2/R4 to test code', () => {
    expect(rulesFor('src/agent/daemon/shell-task.ts')).toEqual(['R1', 'R2', 'R3']);
    expect(rulesFor('scripts/lib/x.mjs')).toEqual(['R1', 'R2', 'R3']);
    expect(rulesFor('src/agent/x.test.ts')).toEqual(['R2', 'R4']);
    expect(rulesFor('src/agent/__test-utils__/h.ts')).toEqual(['R2', 'R4']);
    expect(rulesFor('tests/anything.ts')).toEqual(['R2', 'R4']);
  });

  it('skips fixtures, declarations, build output, and non-source files', () => {
    expect(rulesFor('src/cli/__fixtures__/a.ts')).toEqual([]);
    expect(rulesFor('src/types/g.d.ts')).toEqual([]);
    expect(rulesFor('dist/cli.mjs')).toEqual([]);
    expect(rulesFor('src/README.md')).toEqual([]);
    expect(rulesFor('website/app.ts')).toEqual([]);
  });

  it('does not apply product rules to tests (POSIX fixtures there are legitimate)', () => {
    expect(scanFile('src/a.test.ts', "import path from 'path'; path.resolve('/extra/read');")).toEqual([]);
  });
});

describe('ratchet — growth fails, shrink passes (synthetic tree)', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-posix-guard-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function write(rel: string, text: string): void {
    fs.writeFileSync(path.join(root, rel), text, 'utf8');
  }

  const SKIP = "it.skipIf(process.platform === 'win32')('t', () => {});\n";

  it('fails on a new violation and names the fix', () => {
    write('src/task.ts', "execFile('/bin/sh', ['-c', cmd]);\n");
    const cmp = compareToBaseline(scanTree(root), { entries: {} });
    expect(cmp.growth).toHaveLength(1);
    expect(cmp.growth[0]).toMatchObject({ file: 'src/task.ts', rule: 'R1', baseline: 0, actual: 1 });
    const msg = formatGrowth(cmp);
    expect(msg).toContain('src/task.ts:1');
    expect(msg).toContain('resolveShell()');
  });

  it('passes at the baseline and fails when a grandfathered file grows', () => {
    write('src/a.test.ts', SKIP);
    const baseline = { entries: countsByFile(scanTree(root)) };
    expect(compareToBaseline(scanTree(root), baseline).growth).toEqual([]);
    write('src/a.test.ts', SKIP + SKIP);
    const cmp = compareToBaseline(scanTree(root), baseline);
    expect(cmp.growth.map((g) => [g.rule, g.baseline, g.actual])).toEqual([['R4', 1, 2]]);
    expect(formatGrowth(cmp)).toContain('Never skip');
  });

  it('passes (with only a hint) when another lane removes violations or deletes the file', () => {
    write('src/a.test.ts', SKIP + SKIP);
    write('src/b.test.ts', "await fs.mkdtemp('/tmp/afk-x-');\n");
    const baseline = { entries: countsByFile(scanTree(root)) };
    write('src/a.test.ts', SKIP);
    fs.rmSync(path.join(root, 'src/b.test.ts'));
    const cmp = compareToBaseline(scanTree(root), baseline);
    expect(cmp.growth).toEqual([]);
    expect(cmp.shrunk).toHaveLength(2);
    expect(formatShrinkHint(cmp)).toContain('pnpm audit:posix:update');
  });

  it('serializes one sorted line per file and round-trips', () => {
    const file = path.join(root, BASELINE_REL);
    const entries = { 'src/z.ts': { R1: 1 }, 'src/a.test.ts': { R2: 1, R4: 3 } };
    fs.writeFileSync(file, serializePosixBaseline({ entries }), 'utf8');
    const text = fs.readFileSync(file, 'utf8');
    expect(text.indexOf('src/a.test.ts')).toBeLessThan(text.indexOf('src/z.ts'));
    expect(text).toContain('"src/a.test.ts": { "R2": 1, "R4": 3 }');
    expect(loadPosixBaseline(file).entries).toEqual(entries);
  });
});
