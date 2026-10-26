import { describe, expect, it } from 'vitest';
import { fuzzyScore, paletteFilter } from './fuzzy';

it('ranks exact > prefix > word substring > substring > subsequence > none', () => {
  const s = (t: string) => fuzzyScore(t, 'job');
  expect(s('job')).toBe(1);
  expect(s('Job queue research')).toBeGreaterThan(s('A job queue'));
  expect(s('A job queue')).toBeGreaterThan(s('blowjobs'));
  expect(s('blowjobs')).toBeGreaterThan(fuzzyScore('j-o-b', 'job'));
  expect(fuzzyScore('j-o-b', 'job')).toBeGreaterThan(0);
  expect(fuzzyScore('memory', 'job')).toBe(0);
  expect(fuzzyScore('Job queue research', 'jqr')).toBeGreaterThan(0);
});

it('filters by keywords only, never by the opaque value', () => {
  expect(paletteFilter('session:abc123', 'abc', ['Job queue research'])).toBe(0);
  expect(paletteFilter('session:abc123', 'queue', ['Job queue research', 'haiku'])).toBeGreaterThan(0);
  expect(paletteFilter('x', 'hai', ['Job', 'haiku'])).toBeGreaterThan(0.9);
});

describe('paletteFilter ranks command names above description-only matches', () => {
  it('"model" puts /model above a command that only mentions model in its summary', () => {
    const model = paletteFilter('', 'model', ['/model', 'Switch the model']);
    const other = paletteFilter('', 'model', ['/get-started', 'Pick a model provider and get going']);
    expect(model).toBeGreaterThan(other);
  });
  it('"mod" and "cost" prefer the command whose name starts with them', () => {
    expect(paletteFilter('', 'mod', ['/model', 'Switch model'])).toBeGreaterThan(paletteFilter('', 'mod', ['/trajectory-check', 'module drift audit']));
    expect(paletteFilter('', 'cost', ['/cost', 'Show cost'])).toBeGreaterThan(paletteFilter('', 'cost', ['/recon-dispatch', 'cost of discovery']));
  });
});
