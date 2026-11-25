import { describe, expect, it } from 'vitest';
import { classifyRmRisk } from './risk-classifier.rm-predicate.js';

// Contract: classifyRmRisk() is the secondary predicate applied after the
// 'rm ' BASH_HIGH token fires. It returns 'high' for structurally dangerous
// rm invocations and 'medium' for plain temp/scratch/cache-file cleanup that
// is safe to auto-allow in daemon mode.
//
// Invariant: the function never returns 'safe'.

describe('classifyRmRisk -- HIGH cases (structural danger)', () => {
  it('docker rm subcommand keeps HIGH (rm is not the leading command)', () => {
    expect(classifyRmRisk('docker rm -f app')).toBe('high');
  });

  it('podman rm subcommand keeps HIGH', () => {
    expect(classifyRmRisk('podman rm container1')).toBe('high');
  });

  it('recursive flag -r keeps HIGH', () => {
    expect(classifyRmRisk('rm -r dist/')).toBe('high');
  });

  it('recursive flag -R keeps HIGH', () => {
    expect(classifyRmRisk('rm -R dist/')).toBe('high');
  });

  it('recursive flag --recursive keeps HIGH', () => {
    expect(classifyRmRisk('rm --recursive dist/')).toBe('high');
  });

  it('combined -rf keeps HIGH', () => {
    expect(classifyRmRisk('rm -rf dist/')).toBe('high');
  });

  it('combined -fr keeps HIGH', () => {
    expect(classifyRmRisk('rm -fr dist/')).toBe('high');
  });

  it('combined -rI keeps HIGH (capital R check)', () => {
    expect(classifyRmRisk('rm -Rf dist/')).toBe('high');
  });

  it('absolute non-tmp path keeps HIGH', () => {
    expect(classifyRmRisk('rm /etc/hosts')).toBe('high');
  });

  it('absolute home-dir path keeps HIGH', () => {
    expect(classifyRmRisk('rm /Users/foo/file.txt')).toBe('high');
  });

  it('absolute /var path (not /var/tmp) keeps HIGH', () => {
    expect(classifyRmRisk('rm /var/log/app.log')).toBe('high');
  });

  it('glob in non-ephemeral relative path keeps HIGH', () => {
    expect(classifyRmRisk('rm dist/*.js')).toBe('high');
  });

  it('glob in non-ephemeral absolute path keeps HIGH', () => {
    expect(classifyRmRisk('rm /build/*.js')).toBe('high');
  });

  it('no arguments (bare rm -f) keeps HIGH', () => {
    expect(classifyRmRisk('rm -f')).toBe('high');
  });

  it('no arguments at all keeps HIGH', () => {
    expect(classifyRmRisk('rm')).toBe('high');
  });

  it('separator-evasion shape with no parseable args keeps HIGH', () => {
    // rm followed only by a shell meta char -- no args extractable
    expect(classifyRmRisk('rm; echo done')).toBe('high');
  });

  it('mixed: ephemeral + non-ephemeral absolute path keeps HIGH', () => {
    expect(classifyRmRisk('rm .scratch/x.tmp /etc/shadow')).toBe('high');
  });

  it('glob outside ephemeral keeps HIGH even with -f flag', () => {
    expect(classifyRmRisk('rm -f src/*.ts')).toBe('high');
  });
});

describe('classifyRmRisk -- MEDIUM cases (sampled false positives from #5292 audit)', () => {
  it('FP 1: cleanup of processed pipeline input artifacts', () => {
    // rm -f .forecast-queue/_raw/r1113e/towns_*/...txt
    expect(classifyRmRisk('rm -f .forecast-queue/_raw/r1113e/towns_raw.txt')).toBe('medium');
  });

  it('FP 2: scratch-file cleanup after report validation', () => {
    expect(classifyRmRisk('rm .scratch/post-123.txt')).toBe('medium');
  });

  it('FP 2b: multiple scratch files', () => {
    expect(classifyRmRisk('rm .scratch/post-1.txt .scratch/reply-2.txt')).toBe('medium');
  });

  it('FP 3: clearing temp dir before email fetch', () => {
    expect(classifyRmRisk('rm -f /tmp/stale.json')).toBe('medium');
  });

  it('FP 4: post-pipeline temp cleanup after atomic mv', () => {
    expect(classifyRmRisk('rm -f .brief-out.tmp .brief-err.tmp')).toBe('medium');
  });

  it('FP 5: stale cache clear before fresh data collection', () => {
    expect(classifyRmRisk('rm -f .prs-open.json /tmp/gh.err')).toBe('medium');
  });

  it('plain named file (no glob, no absolute non-tmp)', () => {
    expect(classifyRmRisk('rm file.txt')).toBe('medium');
  });

  it('rm -f on a named temp file', () => {
    expect(classifyRmRisk('rm -f tmpfile.tmp')).toBe('medium');
  });

  it('/tmp absolute path is MEDIUM (ephemeral)', () => {
    expect(classifyRmRisk('rm /tmp/work.json')).toBe('medium');
  });

  it('/var/tmp absolute path is MEDIUM (ephemeral)', () => {
    expect(classifyRmRisk('rm /var/tmp/scratch.txt')).toBe('medium');
  });

  it('cache dir relative path is MEDIUM', () => {
    expect(classifyRmRisk('rm .cache/stale.json')).toBe('medium');
  });

  it('_raw dir relative path is MEDIUM', () => {
    expect(classifyRmRisk('rm data/_raw/input.csv')).toBe('medium');
  });

  it('._raw extension is MEDIUM', () => {
    expect(classifyRmRisk('rm data/input._raw')).toBe('medium');
  });

  it('rm with -i flag and named file is MEDIUM (-i is non-recursive)', () => {
    expect(classifyRmRisk('rm -i file.txt')).toBe('medium');
  });

  it('rm with -v flag and named file is MEDIUM', () => {
    expect(classifyRmRisk('rm -v file.txt')).toBe('medium');
  });
});

describe('classifyRmRisk -- glob in ephemeral namespace (MEDIUM)', () => {
  it('glob in /tmp is MEDIUM (ephemeral prefix)', () => {
    expect(classifyRmRisk('rm -f /tmp/*.json')).toBe('medium');
  });

  it('glob in /var/tmp is MEDIUM', () => {
    expect(classifyRmRisk('rm /var/tmp/work-*.txt')).toBe('medium');
  });

  it('glob in .scratch/ is MEDIUM', () => {
    expect(classifyRmRisk('rm .scratch/post-*.txt')).toBe('medium');
  });

  it('glob in _raw dir is MEDIUM', () => {
    expect(classifyRmRisk('rm pipeline/_raw/*.csv')).toBe('medium');
  });

  it('glob in cache dir is MEDIUM', () => {
    expect(classifyRmRisk('rm .cache/*.json')).toBe('medium');
  });

  it('glob *.tmp is MEDIUM (ephemeral extension)', () => {
    expect(classifyRmRisk('rm work*.tmp')).toBe('medium');
  });
});
