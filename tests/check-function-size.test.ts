import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { functionKey, measureFile, parseFunctionKey } from '../scripts/lib/function-extents.js';
import {
  collectViolations,
  loadBaseline,
  serializeBaseline,
  updateBaseline,
  type Baseline,
  type RatchetConfig,
} from '../scripts/lib/size-ratchet.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-funcsize-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function fixture(name: string, source: string): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, source, 'utf8');
  return p;
}

function byName(file: string, name: string): number | undefined {
  return measureFile(file).find((f) => f.name === name)?.loc;
}

describe('measureFile — what counts as a function', () => {
  it('measures a plain declaration from its keyword to its closing brace', () => {
    const f = fixture('a.ts', ['function alpha() {', '  const x = 1;', '  return x;', '}', ''].join('\n'));
    expect(byName(f, 'alpha')).toBe(4);
  });

  it('excludes the JSDoc block above a declaration', () => {
    // Contract decision 2: function scope has no extraction valve for its own
    // doc comment, so counting JSDoc would only create pressure to delete docs.
    const f = fixture(
      'b.ts',
      ['/**', ' * Six', ' * lines', ' * of', ' * docs', ' */', 'function beta() {', '  return 1;', '}', ''].join('\n'),
    );
    expect(byName(f, 'beta')).toBe(3);
  });

  it('attributes a nested callback to its enclosing function, not separately', () => {
    const f = fixture(
      'c.ts',
      [
        'function outer() {',
        '  const inner = () => {',
        '    return 1;',
        '  };',
        '  return inner;',
        '}',
        '',
      ].join('\n'),
    );
    const names = measureFile(f).map((e) => e.name);
    expect(names).toEqual(['outer']);
    expect(byName(f, 'outer')).toBe(6);
  });

  it('measures class members individually — a class is not a function', () => {
    const f = fixture(
      'd.ts',
      [
        'class Widget {',
        '  constructor() {',
        '    this.n = 0;',
        '  }',
        '  render() {',
        '    return 1;',
        '  }',
        '  get size() {',
        '    return 2;',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    const names = measureFile(f).map((e) => e.name);
    expect(names).toEqual(['Widget.constructor', 'Widget.render', 'Widget.get size']);
  });

  it('names an arrow function after the const that binds it', () => {
    const f = fixture('e.ts', ['export const gamma = () => {', '  return 1;', '};', ''].join('\n'));
    expect(byName(f, 'gamma')).toBe(3);
  });

  it('preserves a computed member key such as [Symbol.asyncIterator]', () => {
    const f = fixture(
      'f.ts',
      ['class S {', '  async *[Symbol.asyncIterator]() {', '    yield 1;', '  }', '}', ''].join('\n'),
    );
    expect(measureFile(f).map((e) => e.name)).toEqual(['S.[Symbol.asyncIterator]']);
  });

  it('skips bodiless overload signatures and counts only the implementation', () => {
    const f = fixture(
      'g.ts',
      [
        'function pick(a: string): string;',
        'function pick(a: number): number;',
        'function pick(a: unknown): unknown {',
        '  return a;',
        '}',
        '',
      ].join('\n'),
    );
    const found = measureFile(f);
    expect(found).toHaveLength(1);
    expect(found[0]?.loc).toBe(3);
  });

  it('never embeds a line number in a name, so keys survive edits above them', () => {
    const base = ['function delta() {', '  return 1;', '}', ''].join('\n');
    const before = measureFile(fixture('h1.ts', base)).map((e) => e.name);
    const after = measureFile(fixture('h2.ts', `// a new line above\n${base}`)).map((e) => e.name);
    expect(after).toEqual(before);
  });

  it('returns an empty array rather than throwing on an unreadable path', () => {
    expect(measureFile(path.join(tmpDir, 'does-not-exist.ts'))).toEqual([]);
  });
});

describe('function keys', () => {
  it('round-trips a path and a qualified name', () => {
    const key = functionKey('src/a/b.ts', 'Cls.method');
    expect(key).toBe('src/a/b.ts::Cls.method');
    expect(parseFunctionKey(key)).toEqual({ file: 'src/a/b.ts', name: 'Cls.method' });
  });

  it('rejects a malformed key instead of guessing', () => {
    expect(parseFunctionKey('no-separator')).toBeNull();
    expect(parseFunctionKey('::leading')).toBeNull();
  });
});

describe('size ratchet — the five failure modes', () => {
  const cfg = (): RatchetConfig => ({
    limit: 200,
    baselinePath: path.join(tmpDir, '.funcsize-baseline.json'),
    baselineRel: '.funcsize-baseline.json',
    unit: 'line',
    entryPlural: 'functions',
    legacyReason: 'legacy',
  });

  const baselineOf = (entries: Baseline['entries']): Baseline => ({ limit: 200, entries });

  it('NEW — a non-baselined key over the ceiling fails', () => {
    const v = collectViolations({
      sizes: new Map([['f.ts::big', 260]]),
      baseline: baselineOf({}),
      cfg: cfg(),
    });
    expect(v.map((x) => x.kind)).toEqual(['NEW']);
  });

  it('passes a non-baselined key that is within the ceiling', () => {
    const v = collectViolations({ sizes: new Map([['f.ts::ok', 199]]), baseline: baselineOf({}), cfg: cfg() });
    expect(v).toEqual([]);
  });

  it('GREW — a baselined key larger than its record fails', () => {
    const v = collectViolations({
      sizes: new Map([['f.ts::big', 261]]),
      baseline: baselineOf({ 'f.ts::big': { loc: 260, reason: 'legacy' } }),
      cfg: cfg(),
    });
    expect(v.map((x) => x.kind)).toEqual(['GREW']);
  });

  it('allows a baselined key to shrink while staying over the ceiling', () => {
    const v = collectViolations({
      sizes: new Map([['f.ts::big', 230]]),
      baseline: baselineOf({ 'f.ts::big': { loc: 260, reason: 'legacy' } }),
      cfg: cfg(),
    });
    expect(v).toEqual([]);
  });

  it('RETIRED — a baselined key that now fits must leave the baseline', () => {
    const v = collectViolations({
      sizes: new Map([['f.ts::big', 150]]),
      baseline: baselineOf({ 'f.ts::big': { loc: 260, reason: 'legacy' } }),
      cfg: cfg(),
    });
    expect(v.map((x) => x.kind)).toEqual(['RETIRED']);
  });

  it('STALE — a baselined key that no longer exists must leave the baseline', () => {
    const v = collectViolations({
      sizes: new Map(),
      baseline: baselineOf({ 'gone.ts::big': { loc: 260, reason: 'legacy' } }),
      cfg: cfg(),
    });
    expect(v.map((x) => x.kind)).toEqual(['STALE']);
  });

  it('TOUCHED — modifying a baselined function without fixing it fails', () => {
    const v = collectViolations({
      sizes: new Map([['f.ts::big', 260]]),
      baseline: baselineOf({ 'f.ts::big': { loc: 260, reason: 'legacy' } }),
      cfg: cfg(),
      touchedKeys: new Set(['f.ts::big']),
      touchedVs: 'origin/main',
    });
    expect(v.map((x) => x.kind)).toEqual(['TOUCHED']);
    expect(v[0]?.detail).toContain('origin/main');
  });

  it('does not report TOUCHED when the touch-set is not supplied', () => {
    const v = collectViolations({
      sizes: new Map([['f.ts::big', 260]]),
      baseline: baselineOf({ 'f.ts::big': { loc: 260, reason: 'legacy' } }),
      cfg: cfg(),
    });
    expect(v).toEqual([]);
  });

  it('permanent entries are exempt from RETIRED but NOT from GREW', () => {
    const entries = { 'f.ts::atomic': { loc: 260, reason: 'atomic transaction', permanent: true } };
    const retired = collectViolations({ sizes: new Map([['f.ts::atomic', 100]]), baseline: baselineOf(entries), cfg: cfg() });
    expect(retired).toEqual([]);

    const grew = collectViolations({ sizes: new Map([['f.ts::atomic', 261]]), baseline: baselineOf(entries), cfg: cfg() });
    expect(grew.map((x) => x.kind)).toEqual(['GREW']);
  });
});

describe('baseline serialization', () => {
  it('sorts keys and emits exactly one line per entry (the merge-conflict contract)', () => {
    const out = serializeBaseline({
      limit: 200,
      entries: {
        'z.ts::last': { loc: 300, reason: 'z' },
        'a.ts::first': { loc: 250, reason: 'a' },
      },
    });
    const entryLines = out.split('\n').filter((l) => l.includes('::'));
    expect(entryLines).toHaveLength(2);
    expect(entryLines[0]).toContain('a.ts::first');
    expect(entryLines[1]).toContain('z.ts::last');
  });

  it('preserves reason and permanent across a mechanical refresh', () => {
    const config = {
      limit: 200,
      baselinePath: path.join(tmpDir, '.funcsize-baseline.json'),
      baselineRel: '.funcsize-baseline.json',
      unit: 'line',
      entryPlural: 'functions',
      legacyReason: 'legacy',
    } satisfies RatchetConfig;

    fs.writeFileSync(
      config.baselinePath,
      serializeBaseline({
        limit: 200,
        entries: { 'f.ts::keep': { loc: 300, reason: 'hand-written rationale', permanent: true } },
      }),
      'utf8',
    );

    const result = updateBaseline(config, new Map([['f.ts::keep', 290]]));
    expect(result.kept).toBe(1);

    const reloaded = loadBaseline(config);
    expect(reloaded.entries['f.ts::keep']).toEqual({
      loc: 290,
      reason: 'hand-written rationale',
      permanent: true,
    });
  });

  it('drops an entry that came under the ceiling and reports it', () => {
    const config = {
      limit: 200,
      baselinePath: path.join(tmpDir, '.funcsize-baseline.json'),
      baselineRel: '.funcsize-baseline.json',
      unit: 'line',
      entryPlural: 'functions',
      legacyReason: 'legacy',
    } satisfies RatchetConfig;

    fs.writeFileSync(
      config.baselinePath,
      serializeBaseline({ limit: 200, entries: { 'f.ts::shrunk': { loc: 300, reason: 'legacy' } } }),
      'utf8',
    );

    const result = updateBaseline(config, new Map([['f.ts::shrunk', 50]]));
    expect(result.kept).toBe(0);
    expect(result.dropped).toEqual(['f.ts::shrunk']);
  });
});
