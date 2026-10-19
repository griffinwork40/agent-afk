/** Contract: exercise the real CLI in isolated git repositories, never this worktree. */
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GENERATED_PATHS, parseBaseline, unionBaselines, unionPosix, unionTypecheck,
} from '../scripts/lib/regen-generated-union.js';
import { serializeBaseline, updateBaseline } from '../scripts/lib/size-ratchet.js';
import { computeNewBaseline } from '../scripts/check-test-typecheck.js';

const script = fileURLToPath(new URL('../scripts/regen-generated.ts', import.meta.url));
const baselineName = '.filesize-baseline.json';
const baseline = (loc: number, reason = 'approved', permanent = false) => ({
  limit: 350, entries: { 'src/shared.ts': { loc, reason, ...(permanent ? { permanent } : {}) } },
});

describe('baseline union', () => {
  it('parses valid JSON and tolerates only missing stages', () => {
    expect(parseBaseline(serializeBaseline(baseline(360)))).toEqual(baseline(360));
    expect(parseBaseline('')).toBeNull();
    expect(parseBaseline('  ')).toBeNull();
    expect(() => parseBaseline('not json')).toThrow();
    expect(() => parseBaseline('{"entries": {}}')).toThrow();
  });

  it('takes max loc, a non-empty reason, and permanent from either side', () => {
    const merged = unionBaselines(baseline(360, '   '), baseline(380, 'their reason', true));
    expect(merged).toEqual(baseline(380, 'their reason', true));
    expect(unionBaselines(baseline(380, 'ours', true), baseline(360, 'theirs')))
      .toEqual(baseline(380, 'ours', true));
  });

  it('keeps disjoint keys and tolerates either missing side', () => {
    const ours = baseline(360);
    const theirs = { limit: 350, entries: { 'src/other.ts': { loc: 390, reason: 'other' } } };
    expect(unionBaselines(ours, theirs).entries).toEqual({ ...ours.entries, ...theirs.entries });
    expect(unionBaselines(null, theirs)).toEqual(theirs);
    expect(unionBaselines(ours, null)).toEqual(ours);
    expect(unionBaselines(null, null).entries).toEqual({});
    expect(unionBaselines(null, { limit: 200, entries: {} }).limit).toBe(200);
  });

  it('unions POSIX counts per file and rule, not by total', () => {
    expect(unionPosix(
      { entries: { 'a.ts': { R1: 2, R2: 1 } } },
      { entries: { 'a.ts': { R1: 1, R3: 3 }, 'b.ts': { R4: 4 } } },
    )).toEqual({ entries: { 'a.ts': { R1: 2, R2: 1, R3: 3 }, 'b.ts': { R4: 4 } } });
    expect(unionPosix(null, null)).toEqual({ entries: {} });
  });

  it('unions the typecheck error count and preserves an available reason', () => {
    expect(unionTypecheck({ errors: 5 }, { errors: 9, reason: 'approved' }))
      .toEqual({ errors: 9, reason: 'approved' });
    expect(unionTypecheck(null, { errors: 8 })).toEqual({ errors: 8 });
  });

  it('unionTypecheck: takes reason from the max-count side', () => {
    // ours has lower count — theirs holds the max and its reason should win
    expect(unionTypecheck({ errors: 5, reason: 'A' }, { errors: 9, reason: 'B' }))
      .toEqual({ errors: 9, reason: 'B' });
    // ours holds the max
    expect(unionTypecheck({ errors: 9, reason: 'A' }, { errors: 5, reason: 'B' }))
      .toEqual({ errors: 9, reason: 'A' });
    // equal counts: ours reason wins (ours >= theirs branch)
    expect(unionTypecheck({ errors: 9, reason: 'A' }, { errors: 9, reason: 'B' }))
      .toEqual({ errors: 9, reason: 'A' });
    // max side has whitespace-only reason: falls back to other side
    expect(unionTypecheck({ errors: 5, reason: '  ' }, { errors: 9, reason: 'B' }))
      .toEqual({ errors: 9, reason: 'B' });
  });

  it('computeNewBaseline: allowGrowth+reason only stamps when count grew', () => {
    const prev = { errors: 9, reason: 'approved', fileExisted: true };
    // count unchanged with allowGrowth+reason → carries previous reason, not the new one
    expect(computeNewBaseline(prev, 9, true, 'other')).toEqual({ errors: 9, reason: 'approved' });
    // count grew → new reason stamped
    expect(computeNewBaseline(prev, 10, true, 'other')).toEqual({ errors: 10, reason: 'other' });
    // count shrank → reason dropped
    expect(computeNewBaseline(prev, 8, false, '')).toEqual({ errors: 8 });
    // whitespace-only previous reason is not carried
    expect(computeNewBaseline({ errors: 9, reason: '   ', fileExisted: true }, 9, false, ''))
      .toEqual({ errors: 9 });
  });

  it('includes all derivable ratchets but not the human-reviewed SDK lock', () => {
    expect([...GENERATED_PATHS]).toEqual(expect.arrayContaining([
      baselineName, '.funcsize-baseline.json', '.posix-guard-baseline.json',
      '.test-typecheck-baseline.json', 'docs/env-registry.json', 'docs/env-registry.md',
      'website/content/docs/reference/environment-variables.mdx',
    ]));
    expect(GENERATED_PATHS.has('.sdk-dependency.lock.json')).toBe(false);
  });
});

describe('regen-generated CLI', () => {
  let root: string;
  function git(...args: string[]): string {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  }
  function write(file: string, text: string): void {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  function commit(message: string): void { git('add', '.'); git('commit', '-qm', message); }
  function run(...args: string[]) {
    return spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), script, ...args], {
      cwd: root, encoding: 'utf8', timeout: 15000,
    });
  }
  function conflict(file: string, ours: string, theirs: string): void {
    git('checkout', '-qb', 'theirs'); write(file, theirs); commit('theirs');
    git('checkout', '-q', 'main'); write(file, ours); commit('ours');
    expect(spawnSync('git', ['merge', 'theirs'], { cwd: root, encoding: 'utf8' }).status).toBe(1);
  }
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-regen-'));
    git('init', '-qb', 'main');
    git('config', 'user.name', 'test'); git('config', 'user.email', 'test@example.com');
    git('config', 'commit.gpgsign', 'false'); git('config', 'core.hooksPath', '.no-hooks');
    write(baselineName, serializeBaseline(baseline(360)));
    write('.gitattributes', `${baselineName} -merge\n`);
    write('src/code.ts', 'export const value = 0;\n');
    // Fixture generators intentionally substitute ONLY downstream work. The CLI,
    // git refusal, stage reads, union, argument forwarding and staging are real.
    for (const name of ['check-file-size', 'check-function-size', 'render-env-registry', 'check-posix-guard', 'check-test-typecheck']) {
      write(`scripts/${name}.ts`, `import { appendFileSync } from 'node:fs';\nappendFileSync('calls.log', JSON.stringify(process.argv.slice(2)) + '\\n');\n`);
    }
    commit('initial');
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('runs against cwd, unions real conflicting index stages, and stages the result', () => {
    conflict(baselineName, serializeBaseline(baseline(370, 'ours')), serializeBaseline(baseline(380, 'theirs', true)));
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Merged ratchets:');
    expect(JSON.parse(git('show', `:${baselineName}`))).toEqual(baseline(380, 'ours', true));
    expect(git('diff', '--name-only', '--diff-filter=U')).toBe('');
    expect(git('diff', '--cached', '--name-only')).toContain(baselineName);
    expect(fs.readFileSync(path.join(root, 'calls.log'), 'utf8').trim().split('\n')).toHaveLength(5);
  });

  it('handles a modify/delete baseline conflict with a missing stage', () => {
    git('checkout', '-qb', 'theirs');
    git('rm', baselineName); commit('delete baseline');
    git('checkout', '-q', 'main');
    write(baselineName, serializeBaseline(baseline(380))); commit('modify baseline');
    expect(spawnSync('git', ['merge', 'theirs'], { cwd: root, encoding: 'utf8' }).status).toBe(1);
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(git('show', `:${baselineName}`))).toEqual(baseline(380));
    expect(git('diff', '--name-only', '--diff-filter=U')).toBe('');
  });

  it.each([
    ['.posix-guard-baseline.json', { entries: {} },
      { entries: { 'src/a.ts': { R1: 2 } } }, { entries: { 'src/a.ts': { R2: 3 } } },
      { entries: { 'src/a.ts': { R1: 2, R2: 3 } } }],
    ['.test-typecheck-baseline.json', { errors: 0 }, { errors: 5, reason: 'approved' }, { errors: 9, reason: 'merged' }, { errors: 9, reason: 'merged' }],
  ])('resolves additional derivable ratchet %s', (file, base, ours, theirs, expected) => {
    write(file, JSON.stringify(base)); commit('base ratchet');
    conflict(file, JSON.stringify(ours), JSON.stringify(theirs));
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(git('show', `:${file}`))).toEqual(expected);
    expect(git('diff', '--name-only', '--diff-filter=U')).toBe('');
  });

  it('refuses non-generated unmerged paths before any regeneration', () => {
    conflict('src/code.ts', 'export const value = 1;\n', 'export const value = 2;\n');
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Resolve code conflicts first');
    expect(result.stderr).toContain('src/code.ts');
    expect(fs.existsSync(path.join(root, 'calls.log'))).toBe(false);
  });

  it('refuses markers even after a code conflict has been staged', () => {
    write('src/code.ts', '<<<<<<< ours\nfoo\n=======\nbar\n>>>>>>> theirs\n');
    git('add', 'src/code.ts');
    expect(run().status).toBe(1);
    expect(fs.existsSync(path.join(root, 'calls.log'))).toBe(false);
  });

  it('refuses markers present only in the staged version (working tree already fixed)', () => {
    // Stage a file with markers, then overwrite the working tree with clean content.
    write('src/code.ts', '<<<<<<< ours\nfoo\n=======\nbar\n>>>>>>> theirs\n');
    git('add', 'src/code.ts');
    write('src/code.ts', 'export const value = 1;\n'); // working tree is clean, index is not
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Resolve code conflicts first');
    expect(result.stderr).toContain('src/code.ts');
    expect(fs.existsSync(path.join(root, 'calls.log'))).toBe(false);
  });

  it('resolves a conflicted .funcsize-baseline.json by unioning both sides', () => {
    const funcName = '.funcsize-baseline.json';
    write(funcName, serializeBaseline(baseline(200))); commit('base funcsize');
    conflict(funcName, serializeBaseline(baseline(210, 'ours')), serializeBaseline(baseline(220, 'theirs', true)));
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(git('show', `:${funcName}`))).toEqual(baseline(220, 'ours', true));
    expect(git('diff', '--name-only', '--diff-filter=U')).toBe('');
    expect(git('diff', '--cached', '--name-only')).toContain(funcName);
  });

  it('parsePosixStage: rejects non-object entry value and non-finite count', () => {
    const posixName = '.posix-guard-baseline.json';
    write('.gitattributes', `${baselineName} -merge\n${posixName} -merge\n`);
    write(posixName, JSON.stringify({ entries: {} })); commit('base posix');

    // Case 1: entry value is a number (non-object) — must be rejected.
    conflict(posixName,
      JSON.stringify({ entries: { 'file.ts': { R1: 1 } } }),
      JSON.stringify({ entries: { 'file.ts': 42 } }),
    );
    const result1 = run();
    expect(result1.status).toBe(1);
    expect(result1.stderr).toContain('Invalid POSIX baseline');
    expect(fs.existsSync(path.join(root, 'calls.log'))).toBe(false);

    // Reset for case 2: entry value has a non-finite count (null is not finite).
    git('merge', '--abort');
    git('checkout', '-q', 'main');
    git('branch', '-D', 'theirs');
    write(posixName, JSON.stringify({ entries: {} }));
    git('add', posixName); git('commit', '-qm', 'reset posix');
    conflict(posixName,
      JSON.stringify({ entries: { 'file.ts': { R1: 1 } } }),
      JSON.stringify({ entries: { 'file.ts': { R1: null } } }),
    );
    const result2 = run();
    expect(result2.status).toBe(1);
    expect(result2.stderr).toContain('Invalid POSIX baseline: non-finite count');
    expect(fs.existsSync(path.join(root, 'calls.log'))).toBe(false);
  });

  it('throws on invalid JSON (non-numeric errors) in a conflicted typecheck stage', () => {
    const tcName = '.test-typecheck-baseline.json';
    // Use .gitattributes -merge so git leaves both sides verbatim (no auto-merge marker).
    write('.gitattributes', `${baselineName} -merge\n${tcName} -merge\n`);
    write(tcName, JSON.stringify({ errors: 0 })); commit('base typecheck');
    // "ours" has a valid baseline; "theirs" has a non-numeric errors field.
    conflict(tcName, JSON.stringify({ errors: 5 }), JSON.stringify({ errors: 'not-a-number' }));
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid typecheck baseline');
    expect(fs.existsSync(path.join(root, 'calls.log'))).toBe(false);
  });

  it('does not mistake inline fixture strings or divider comments for markers', () => {
    write('src/code.ts', '// ======= divider\nconst marker = "<<<<<<<";\n');
    expect(run().status).toBe(0);
  });

  it('forwards growth approval to every ratchet, preserving a reason containing spaces', () => {
    const reason = 'approved growth with spaces';
    expect(run('--allow-growth', '--reason', reason).status).toBe(0);
    const calls = fs.readFileSync(path.join(root, 'calls.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(calls).toEqual([
      ['--update-baseline', '--allow-growth', '--reason', reason],
      ['--update-baseline', '--allow-growth', '--reason', reason], [],
      ['--update-baseline', '--allow-growth', '--reason', reason],
      ['--update', '--allow-growth', '--reason', reason],
    ]);
  });

  it('fails on growth refusal and does not stage generated edits', () => {
    write('scripts/check-file-size.ts', 'process.exit(1);\n');
    write(baselineName, serializeBaseline(baseline(370)));
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('audit:filesize:update failed');
    expect(git('diff', '--cached', '--name-only')).toBe('');
  });

  it('outside conflicts regenerates and stages changed outputs only, including new files', () => {
    write('scripts/render-env-registry.ts', `import { mkdirSync, writeFileSync } from 'node:fs';\nmkdirSync('docs', {recursive: true}); writeFileSync('docs/env-registry.md', 'rendered');\n`);
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(git('diff', '--cached', '--name-only')).toBe('docs/env-registry.md');
    expect(result.stdout).toContain('0 conflict(s)');
  });

  it('replaces stale staged outputs even when regeneration restores HEAD contents', () => {
    write(baselineName, serializeBaseline(baseline(390)));
    git('add', baselineName);
    write('scripts/check-file-size.ts', `import { writeFileSync } from 'node:fs';\nwriteFileSync('${baselineName}', ${JSON.stringify(serializeBaseline(baseline(360)))});\n`);
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(git('diff', '--cached', '--name-only')).toBe('');
    expect(JSON.parse(git('show', `:${baselineName}`))).toEqual(baseline(360));
  });

  it('rejects incomplete growth flags without invoking generators', () => {
    expect(run('--allow-growth').status).toBe(1);
    expect(run('--reason', 'why').status).toBe(1);
    expect(fs.existsSync(path.join(root, 'calls.log'))).toBe(false);
  });

  it('works with updateBaseline: accepts growth above one side but refuses growth above both', () => {
    const merged = unionBaselines(baseline(360), baseline(380, 'theirs', true));
    write(baselineName, serializeBaseline(merged));
    const cfg = {
      limit: 350, baselinePath: path.join(root, baselineName), baselineRel: baselineName,
      unit: 'line', entryPlural: 'files', legacyReason: 'legacy',
    };
    expect(updateBaseline(cfg, new Map([['src/shared.ts', 370]])).blocked).toEqual([]);
    const tightened = JSON.parse(fs.readFileSync(cfg.baselinePath, 'utf8'));
    expect(tightened).toEqual(baseline(370, 'approved', true));
    write(baselineName, serializeBaseline(merged));
    expect(updateBaseline(cfg, new Map([['src/shared.ts', 381]])).blocked).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(cfg.baselinePath, 'utf8'))).toEqual(merged);
  });
});
