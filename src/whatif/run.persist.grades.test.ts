/**
 * Unit tests for persistGrades (#2477).
 *
 * Verifies that grades.jsonl is written with the correct pairing keys so the
 * paired sign-flip and ICC analysis can be computed from saved artifacts.
 */

import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { persistGrades, type GradeEntry } from './run.persist.grades.js';
import type { EpisodeTrace } from './types.js';
import type { JudgeResults } from './run.verify.scoring.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function trace(
  episodeId: string,
  env: 'baseline' | 'candidate',
  sample: number,
  error?: string,
): EpisodeTrace {
  return {
    episodeId, env, sample, text: '', tools: [],
    costUsd: 0, inputTokens: 0, outputTokens: 0, durationMs: 1,
    ...(error ? { error } : {}),
  };
}

async function readGrades(dir: string): Promise<GradeEntry[]> {
  const raw = await fsp.readFile(path.join(dir, 'grades.jsonl'), 'utf8');
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as GradeEntry);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('persistGrades', () => {
  let tmp: string;
  beforeEach(async () => { tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'whatif-grades-test-')); });
  afterEach(async () => { await fsp.rm(tmp, { recursive: true, force: true }); });

  it('writes one row per (trace, prediction) pair with all pairing keys', async () => {
    const traces: EpisodeTrace[] = [
      trace('s1', 'baseline', 0),
      trace('s1', 'candidate', 0),
    ];
    const judgeResults: JudgeResults = new Map([
      ['s1:baseline:0', { p1: 0.02, p2: 0.95 }],
      ['s1:candidate:0', { p1: 0.98, p2: 0.03 }],
    ]);

    await persistGrades(tmp, judgeResults, traces, ['p1', 'p2']);
    const entries = await readGrades(tmp);

    // 2 traces × 2 predictions = 4 rows
    expect(entries).toHaveLength(4);

    const s1b_p1 = entries.find((e) => e.episodeId === 's1' && e.env === 'baseline' && e.predictionId === 'p1');
    expect(s1b_p1).toMatchObject({ episodeId: 's1', env: 'baseline', sample: 0, predictionId: 'p1', pYes: 0.02 });

    const s1c_p1 = entries.find((e) => e.episodeId === 's1' && e.env === 'candidate' && e.predictionId === 'p1');
    expect(s1c_p1).toMatchObject({ episodeId: 's1', env: 'candidate', sample: 0, predictionId: 'p1', pYes: 0.98 });
  });

  it('contains every pairing key field required for sign-flip analysis', async () => {
    const traces: EpisodeTrace[] = [trace('s1', 'baseline', 1)];
    const judgeResults: JudgeResults = new Map([['s1:baseline:1', { p1: 0.7 }]]);
    await persistGrades(tmp, judgeResults, traces, ['p1']);
    const [entry] = await readGrades(tmp);
    expect(entry).toHaveProperty('episodeId');
    expect(entry).toHaveProperty('env');
    expect(entry).toHaveProperty('sample');
    expect(entry).toHaveProperty('predictionId');
    expect(entry).toHaveProperty('pYes');
  });

  it('the same episodeId appears in both arms: enables probe-level pairing', async () => {
    const traces: EpisodeTrace[] = [
      trace('s1', 'baseline', 0),
      trace('s1', 'candidate', 0),
      trace('s2', 'baseline', 0),
      trace('s2', 'candidate', 0),
    ];
    const judgeResults: JudgeResults = new Map([
      ['s1:baseline:0', { p1: 0.1 }],
      ['s1:candidate:0', { p1: 0.9 }],
      ['s2:baseline:0', { p1: 0.2 }],
      ['s2:candidate:0', { p1: 0.8 }],
    ]);
    await persistGrades(tmp, judgeResults, traces, ['p1']);
    const entries = await readGrades(tmp);
    // For each episodeId, both baseline and candidate should appear
    for (const epId of ['s1', 's2']) {
      const arms = entries.filter((e) => e.episodeId === epId).map((e) => e.env);
      expect(arms).toContain('baseline');
      expect(arms).toContain('candidate');
    }
  });

  it('skips failed traces (error field set)', async () => {
    const traces: EpisodeTrace[] = [
      trace('s1', 'baseline', 0, 'boom'),
      trace('s1', 'candidate', 0),
    ];
    const judgeResults: JudgeResults = new Map([
      ['s1:candidate:0', { p1: 0.9 }],
    ]);
    await persistGrades(tmp, judgeResults, traces, ['p1']);
    const entries = await readGrades(tmp);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.env).toBe('candidate');
  });

  it('skips traces with no judge result (judge failure)', async () => {
    const traces: EpisodeTrace[] = [
      trace('s1', 'baseline', 0),
      trace('s1', 'candidate', 0),
    ];
    // Only baseline graded (candidate judge failed)
    const judgeResults: JudgeResults = new Map([
      ['s1:baseline:0', { p1: 0.1 }],
    ]);
    await persistGrades(tmp, judgeResults, traces, ['p1']);
    const entries = await readGrades(tmp);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.env).toBe('baseline');
  });

  it('writes an empty file (no newline) when there are no grades', async () => {
    await persistGrades(tmp, new Map(), [], ['p1']);
    const content = await fsp.readFile(path.join(tmp, 'grades.jsonl'), 'utf8');
    expect(content).toBe('');
  });

  it('preserves multi-sample pairing keys', async () => {
    const traces: EpisodeTrace[] = [
      trace('s1', 'baseline', 0),
      trace('s1', 'baseline', 1),
      trace('s1', 'candidate', 0),
      trace('s1', 'candidate', 1),
    ];
    const judgeResults: JudgeResults = new Map([
      ['s1:baseline:0', { p1: 0.1 }],
      ['s1:baseline:1', { p1: 0.2 }],
      ['s1:candidate:0', { p1: 0.8 }],
      ['s1:candidate:1', { p1: 0.9 }],
    ]);
    await persistGrades(tmp, judgeResults, traces, ['p1']);
    const entries = await readGrades(tmp);
    expect(entries).toHaveLength(4);
    const samples = new Set(entries.map((e) => e.sample));
    expect(samples).toEqual(new Set([0, 1]));
  });
});
